//! WebSocket fanout.
//!
//! Contract (CLAUDE.md Rule 16):
//! - Fire-and-forget. No per-client queues, no replay, no gap-fill.
//! - On connect, the server sends one full leaderboard snapshot.
//! - Subsequent messages are periodic full snapshots (Phase 2 simplification —
//!   delta-only broadcasts land in a later phase once the payload becomes a concern).
//!
//! The raw event firehose is never exposed. `watch_event` messages are a
//! minimal sampled subset (repo + actor + broadcast-at) throttled to ≤5/sec
//! at the ingest site.
//!
//! Wire format is **gzipped JSON sent as a binary frame**. The JSON body is
//! identical to the pre-compression shape; only the transport changes. The
//! browser decompresses via `DecompressionStream("gzip")`. Compression is the
//! biggest single egress lever for starquake (leaderboard snapshots are ~85%
//! redundant JSON keys and compress to ~15–25% of their uncompressed size).

use crate::state::{encode_frame, AppState};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

const TOP_N: usize = 100;
const BROADCAST_INTERVAL_SECS: u64 = 1;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| ws_connection(socket, state))
}

async fn ws_connection(socket: WebSocket, state: Arc<AppState>) {
    let subscribers_before = state.tx.receiver_count();
    tracing::info!(subscribers = subscribers_before + 1, "ws client connected");

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    // initial snapshot
    let snap = state.snapshot(TOP_N).await;
    let initial = encode_frame(&snap);
    if let Err(e) = send_binary(&mut sender, &initial).await {
        tracing::debug!(error = %e, "failed to send initial snapshot, closing");
        return;
    }

    loop {
        tokio::select! {
            incoming = receiver.next() => {
                match incoming {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(_))) => {
                        // axum replies to Ping automatically
                    }
                    Some(Err(_)) => break,
                    _ => {}
                }
            }
            broadcast_result = rx.recv() => {
                match broadcast_result {
                    Ok(frame) => {
                        if send_binary(&mut sender, &frame).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "ws client lagged, sending fresh snapshot");
                        let fresh = state.snapshot(TOP_N).await;
                        let fresh_frame = encode_frame(&fresh);
                        if send_binary(&mut sender, &fresh_frame).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    tracing::info!("ws client disconnected");
}

async fn send_binary<S>(sender: &mut S, frame: &[u8]) -> Result<(), axum::Error>
where
    S: SinkExt<Message, Error = axum::Error> + Unpin,
{
    // `Bytes` owns its buffer, so we copy once per subscriber send — the
    // upstream frame is shared via `Arc<Vec<u8>>`, but WebSocket sink queues
    // must own their payload.
    sender.send(Message::binary(frame.to_vec())).await
}

/// Periodic broadcast loop — emits a fresh full leaderboard snapshot every second.
/// Runs as a separate task alongside ingest and the HTTP/WS listener.
pub async fn broadcast_loop(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(BROADCAST_INTERVAL_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let snap = state.snapshot(TOP_N).await;
        // Encode once; the Arc is cloned per subscriber.
        let _ = state.tx.send(encode_frame(&snap));
    }
}


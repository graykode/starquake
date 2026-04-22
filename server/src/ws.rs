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

use crate::state::{AppState, ServerMessage};
use axum::{
    extract::{
        ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade},
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
    if let Err(e) = send_json(&mut sender, &snap).await {
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
                    Ok(msg) => {
                        if send_json(&mut sender, &msg).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "ws client lagged, sending fresh snapshot");
                        let fresh = state.snapshot(TOP_N).await;
                        if send_json(&mut sender, &fresh).await.is_err() {
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

async fn send_json<S>(sender: &mut S, msg: &ServerMessage) -> Result<(), axum::Error>
where
    S: SinkExt<Message, Error = axum::Error> + Unpin,
{
    let json = serde_json::to_string(msg).map_err(axum::Error::new)?;
    sender.send(Message::Text(Utf8Bytes::from(json))).await
}

/// Periodic broadcast loop — emits a fresh full leaderboard snapshot every second.
/// Runs as a separate task alongside ingest and the HTTP/WS listener.
pub async fn broadcast_loop(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(BROADCAST_INTERVAL_SECS));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let snap = state.snapshot(TOP_N).await;
        // broadcast errors only when there are zero receivers — ignore.
        let _ = state.tx.send(snap);
    }
}

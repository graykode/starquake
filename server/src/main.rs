mod config;
mod enrich;
mod geocode;
mod ingest;
mod locate;
mod state;
mod ws;

use anyhow::Result;
use axum::{routing::get, Router};
use state::AppState;
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};

#[tokio::main]
async fn main() -> Result<()> {
    // Search upward from cwd for .env (handles both `cargo run` from server/ and from repo root).
    dotenvy::from_path("../.env").ok();
    dotenvy::dotenv().ok();

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::registry()
        .with(fmt::layer().with_target(true).with_level(true).compact())
        .with(filter)
        .init();

    let cfg = config::Config::from_env()?;
    let state = Arc::new(AppState::new());
    let geocoder = Arc::new(geocode::Geocoder::build());

    tracing::info!(
        port = cfg.port,
        token_suffix = &cfg.github_token[cfg.github_token.len().saturating_sub(4)..],
        "starquake server starting"
    );

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state.clone())
        .layer(CorsLayer::permissive());

    // Bind 0.0.0.0 in production so Railway's ingress can reach us; localhost works fine
    // for dev too. PORT is honored (Railway injects it, dev falls back to config default).
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    tracing::info!(addr = %listener.local_addr()?, "http listening");

    let (locate_tx, locate_rx) = locate::channel();

    let ingest_state = state.clone();
    let enrich_state = state.clone();
    let locate_state = state.clone();
    let broadcast_state = state.clone();
    let token_ingest = cfg.github_token.clone();
    let token_enrich = cfg.github_token.clone();
    let token_locate = cfg.github_token.clone();

    tokio::select! {
        res = ingest::run(token_ingest, ingest_state, locate_tx) => {
            if let Err(e) = res { tracing::error!(error = %e, "ingest exited"); }
        }
        res = enrich::run(token_enrich, enrich_state) => {
            if let Err(e) = res { tracing::error!(error = %e, "enrich exited"); }
        }
        res = locate::run(token_locate, locate_state, geocoder.clone(), locate_rx) => {
            if let Err(e) = res { tracing::error!(error = %e, "locate exited"); }
        }
        _ = ws::broadcast_loop(broadcast_state) => {
            tracing::warn!("broadcast_loop exited unexpectedly");
        }
        res = axum::serve(listener, app) => {
            if let Err(e) = res { tracing::error!(error = %e, "http server exited"); }
        }
        _ = tokio::signal::ctrl_c() => {
            tracing::info!("received Ctrl-C, shutting down");
        }
    }

    Ok(())
}

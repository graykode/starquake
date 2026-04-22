mod config;
mod db;
mod enrich;
mod geocode;
mod ingest;
mod locate;
mod state;
mod ws;

use anyhow::Result;
use axum::{http::HeaderValue, routing::get, Router};
use state::AppState;
use std::sync::Arc;
use tower_http::cors::{AllowOrigin, CorsLayer};
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

    let db_pool = match &cfg.database_url {
        Some(url) => match db::connect(url).await {
            Ok(pool) => Some(pool),
            Err(e) => {
                // Fail hard: if DATABASE_URL is set we expect persistence. Local
                // dev without Postgres should simply unset the var.
                tracing::error!(error = %e, "DATABASE_URL set but connection failed");
                return Err(e);
            }
        },
        None => {
            tracing::warn!("DATABASE_URL unset — running fully in-memory (counter + caches reset on restart)");
            None
        }
    };

    let state = Arc::new(AppState::new(db_pool.clone()));
    state.hydrate().await?;
    let geocoder = Arc::new(geocode::Geocoder::build());

    tracing::info!(
        port = cfg.port,
        token_suffix = &cfg.github_token[cfg.github_token.len().saturating_sub(4)..],
        persistence = db_pool.is_some(),
        "starquake server starting"
    );

    let cors = match &cfg.allowed_origins {
        Some(origins) => {
            let parsed: Vec<HeaderValue> = origins
                .iter()
                .filter_map(|o| match HeaderValue::from_str(o) {
                    Ok(v) => Some(v),
                    Err(e) => {
                        tracing::warn!(origin = %o, error = %e, "skipping invalid CORS origin");
                        None
                    }
                })
                .collect();
            tracing::info!(allowed_origins = ?origins, "CORS: restricted");
            CorsLayer::new().allow_origin(AllowOrigin::list(parsed))
        }
        None => {
            tracing::warn!("CORS: permissive (no CORS_ALLOWED_ORIGINS set) — fine for dev only");
            CorsLayer::permissive()
        }
    };

    let app = Router::new()
        .route("/ws", get(ws::ws_handler))
        .route("/health", get(|| async { "ok" }))
        .with_state(state.clone())
        .layer(cors);

    // Bind 0.0.0.0 in production so Railway's ingress can reach us; localhost works fine
    // for dev too. PORT is honored (Railway injects it, dev falls back to config default).
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cfg.port)).await?;
    tracing::info!(addr = %listener.local_addr()?, "http listening");

    let (locate_tx, locate_rx) = locate::channel();

    let ingest_state = state.clone();
    let enrich_state = state.clone();
    let locate_state = state.clone();
    let broadcast_state = state.clone();
    let snapshot_state = state.clone();
    let roll_state = state.clone();
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
        _ = counter_snapshot_loop(snapshot_state) => {
            tracing::warn!("counter_snapshot_loop exited unexpectedly");
        }
        _ = daily_top_roll_loop(roll_state) => {
            tracing::warn!("daily_top_roll_loop exited unexpectedly");
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

/// Periodically snapshots the in-memory counter to Postgres so a restart
/// doesn't wipe today's accumulated stars. No-op when `DATABASE_URL` is unset.
/// The 60s cadence is a budget/RTO trade: at 100k repos the UNNEST upsert is
/// cheap, and losing ≤60s of counts on a crash is within the Events API's own
/// lag envelope.
async fn counter_snapshot_loop(state: Arc<AppState>) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Skip the immediate first tick — hydration just ran, nothing to snapshot yet.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        if let Err(e) = state.snapshot_counter().await {
            tracing::warn!(error = %e, "counter snapshot failed");
        }
    }
}

/// Hourly daily-top roll. At every tick picks the most recent *finished* UTC
/// date (accounting for the 1-hour grace window: before UTC 01:00 we treat
/// yesterday as still in-progress) and archives its top-100 to `daily_top`.
/// `roll_daily_top` is idempotent (`ON CONFLICT DO NOTHING`), so re-running on
/// startup or after a missed window is safe and self-healing.
async fn daily_top_roll_loop(state: Arc<AppState>) {
    use chrono::{Duration as ChronoDuration, NaiveTime};

    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(3600));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        ticker.tick().await;
        let now = chrono::Utc::now();
        // Before UTC 01:00, yesterday is still accepting late events — the
        // grace window defers the snapshot to the *previous* yesterday.
        let grace = NaiveTime::from_hms_opt(1, 0, 0).expect("valid time");
        let target = if now.time() < grace {
            now.date_naive() - ChronoDuration::days(2)
        } else {
            now.date_naive() - ChronoDuration::days(1)
        };
        match state.roll_daily_top(target).await {
            Ok(n) if n > 0 => tracing::info!(utc_date = %target, rows = n, "daily_top rolled"),
            Ok(_) => tracing::debug!(utc_date = %target, "daily_top roll no-op (already archived)"),
            Err(e) => tracing::warn!(error = %e, utc_date = %target, "daily_top roll failed"),
        }
    }
}

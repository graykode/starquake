//! Optional Postgres persistence.
//!
//! If `DATABASE_URL` is set, the server connects, runs migrations, and uses the
//! pool to (a) hydrate the in-memory counter / user_location / repo_metadata
//! caches on startup, and (b) snapshot the live counter every ~60 seconds so
//! restarts don't wipe today's progress.
//!
//! If `DATABASE_URL` is absent, the server runs fully ephemeral (pre-Phase-7.6
//! behavior) — useful for local dev without a Postgres.

use anyhow::{Context, Result};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

pub async fn connect(database_url: &str) -> Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(10))
        .connect(database_url)
        .await
        .context("connect to DATABASE_URL")?;

    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .context("run migrations")?;

    tracing::info!("postgres connected, migrations applied");
    Ok(pool)
}

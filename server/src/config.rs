use anyhow::{Context, Result};

pub struct Config {
    pub port: u16,
    pub github_token: String,
    /// Comma-separated list of allowed CORS origins. `None` or empty falls back
    /// to permissive (accept any) — fine for dev, a mistake in prod. Example:
    /// `CORS_ALLOWED_ORIGINS=https://graykode.github.io`
    pub allowed_origins: Option<Vec<String>>,
    /// Postgres URL (Railway injects it). If unset, the server runs fully
    /// in-memory — acceptable for local dev, not for production persistence.
    pub database_url: Option<String>,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let github_token = std::env::var("GITHUB_TOKEN")
            .context("GITHUB_TOKEN is required — see .env.example at the repo root")?;
        if github_token.trim().is_empty() {
            anyhow::bail!("GITHUB_TOKEN is empty");
        }

        let port = std::env::var("PORT")
            .unwrap_or_else(|_| "8080".to_string())
            .parse::<u16>()
            .context("PORT must be a valid u16")?;

        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS").ok().and_then(|s| {
            let list: Vec<String> = s
                .split(',')
                .map(|o| o.trim().to_string())
                .filter(|o| !o.is_empty())
                .collect();
            if list.is_empty() { None } else { Some(list) }
        });

        let database_url = std::env::var("DATABASE_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Ok(Self { port, github_token, allowed_origins, database_url })
    }
}

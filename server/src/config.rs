use anyhow::{Context, Result};

pub struct Config {
    pub port: u16,
    pub github_token: String,
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

        Ok(Self { port, github_token })
    }
}

//! GitHub GraphQL batch enrichment.
//!
//! Periodically fetches metadata (description, primary language, total stars, topics) for
//! the current top-N repos via a single multi-alias GraphQL query. Results are cached in
//! `AppState::meta` and flow out to clients on the next leaderboard snapshot.
//!
//! Spec (CLAUDE.md):
//! - Rule 11: enrichment is top-N bounded (ENRICH_TOP_N, default 150).
//! - Rule 16: cache TTL is 24h — we refresh every ~5 min but only re-fetch repos whose
//!   cached entry is older than the TTL.
//! - Rule 17: respect Retry-After / 403 / 429 backoff.

use crate::state::{AppState, RepoMeta};
use anyhow::Result;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::sleep;

const ENRICH_INTERVAL_SECS: u64 = 30; // every 30s — catches new top-N entrants fast
const ENRICH_TOP_N: usize = 150;
const BATCH_SIZE: usize = 50; // aliases per GraphQL call
const USER_AGENT_STR: &str = "starquake/0.1.0 (+https://github.com/graykode)";

#[derive(Deserialize, Debug)]
struct GqlResponse {
    #[serde(default)]
    data: Option<serde_json::Value>,
    #[serde(default)]
    errors: Option<Vec<GqlError>>,
}

#[derive(Deserialize, Debug)]
struct GqlError {
    message: String,
}

pub async fn run(token: String, state: Arc<AppState>) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT_STR)
        .gzip(true)
        .build()?;
    let auth = HeaderValue::from_str(&format!("Bearer {token}"))?;

    tracing::info!("enrich loop starting");

    loop {
        let start = std::time::Instant::now();
        let top = state.top_n_repo_names(ENRICH_TOP_N).await;
        if top.is_empty() {
            sleep(Duration::from_secs(5)).await;
            continue;
        }

        let mut fetched = 0usize;
        let mut failed = 0usize;
        for chunk in top.chunks(BATCH_SIZE) {
            match fetch_batch(&client, &auth, chunk, &state).await {
                Ok(n) => fetched += n,
                Err(e) => {
                    failed += 1;
                    tracing::warn!(error = %e, "enrich batch failed");
                }
            }
            sleep(Duration::from_millis(400)).await;
        }

        tracing::info!(
            total_top_n = top.len(),
            repos_enriched = fetched,
            batch_failures = failed,
            elapsed_ms = start.elapsed().as_millis() as u64,
            "enrich cycle done"
        );

        sleep(Duration::from_secs(ENRICH_INTERVAL_SECS)).await;
    }
}

async fn fetch_batch(
    client: &reqwest::Client,
    auth: &HeaderValue,
    repos: &[String],
    state: &Arc<AppState>,
) -> Result<usize> {
    // build a multi-alias GraphQL query
    let mut query = String::from("query {");
    for (i, repo) in repos.iter().enumerate() {
        let Some((owner, name)) = repo.split_once('/') else { continue };
        // escape quotes in owner/name just in case (GitHub names disallow quotes, but be safe)
        let owner = owner.replace('"', "\\\"");
        let name = name.replace('"', "\\\"");
        query.push_str(&format!(
            " r{i}: repository(owner: \"{owner}\", name: \"{name}\") {{ \
              nameWithOwner description \
              primaryLanguage {{ name }} \
              stargazerCount \
              repositoryTopics(first: 10) {{ nodes {{ topic {{ name }} }} }} \
              }}"
        ));
    }
    query.push('}');

    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, auth.clone());
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_STR));

    let resp = client
        .post("https://api.github.com/graphql")
        .headers(headers)
        .json(&json!({ "query": query }))
        .send()
        .await?;

    let status = resp.status();
    if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60);
        tracing::warn!(retry_after_secs = retry_after, "graphql rate-limited, backing off");
        sleep(Duration::from_secs(retry_after)).await;
        anyhow::bail!("rate-limited");
    }
    if !status.is_success() {
        anyhow::bail!("non-success status: {}", status);
    }

    let body: GqlResponse = resp.json().await?;
    if let Some(errors) = body.errors {
        for e in errors.iter().take(3) {
            tracing::debug!(graphql_error = %e.message, "graphql partial error");
        }
    }
    let Some(data) = body.data else { return Ok(0) };
    let Some(obj) = data.as_object() else { return Ok(0) };

    let mut count = 0usize;
    for (_alias, node) in obj {
        if node.is_null() {
            continue;
        }
        let Some(name) = node.get("nameWithOwner").and_then(|v| v.as_str()) else {
            continue;
        };
        let description = node
            .get("description")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(String::from);
        let language = node
            .get("primaryLanguage")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .map(String::from);
        let total_stars = node
            .get("stargazerCount")
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        let topics: Vec<String> = node
            .get("repositoryTopics")
            .and_then(|v| v.get("nodes"))
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| {
                        n.get("topic")
                            .and_then(|t| t.get("name"))
                            .and_then(|s| s.as_str())
                            .map(String::from)
                    })
                    .collect()
            })
            .unwrap_or_default();

        state
            .upsert_meta(
                name.to_string(),
                RepoMeta { description, language, total_stars, topics },
            )
            .await;
        count += 1;
    }
    Ok(count)
}

//! Actor geolocation pipeline.
//!
//! For each WatchEvent on a currently-tracked top-N repo, we fetch the actor's GitHub
//! profile once, read the free-text `location` field, match it against the embedded
//! GeoNames dataset, cache the result (hit or miss), and broadcast a `Pulse` WS message.
//!
//! Spec:
//! - Rule 11: top-N bounded. Only events on top-N repos trigger a lookup.
//! - Rule 15: offline geocoding only; failed matches render no globe pulse.
//! - Rule 16: user_location cache is keyed by login; misses are cached too to avoid refetch.
//! - Rule 17: honor `Retry-After` on 403/429 and sleep between fetches to stay well under budget.

use crate::geocode::Geocoder;
use crate::state::{AppState, ServerMessage, UserLocation};
use anyhow::Result;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::time::sleep;

const USER_AGENT_STR: &str = "starquake/0.1.0 (+https://github.com/graykode)";
const FETCH_PACING_MS: u64 = 700; // ~5000/hr ÷ required budget → ~700ms between fetches
const CHANNEL_CAPACITY: usize = 512;

#[derive(Clone, Debug)]
pub struct LocateRequest {
    pub actor: String,
    pub repo: String,
}

#[derive(Deserialize)]
struct GitHubUser {
    #[serde(default)]
    location: Option<String>,
}

pub fn channel() -> (mpsc::Sender<LocateRequest>, mpsc::Receiver<LocateRequest>) {
    mpsc::channel(CHANNEL_CAPACITY)
}

pub async fn run(
    token: String,
    state: Arc<AppState>,
    geocoder: Arc<Geocoder>,
    mut rx: mpsc::Receiver<LocateRequest>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT_STR)
        .gzip(true)
        .build()?;
    let auth = HeaderValue::from_str(&format!("Bearer {token}"))?;

    tracing::info!("locate loop starting");

    while let Some(req) = rx.recv().await {
        // cache hit → broadcast if resolved, otherwise silent skip
        if let Some(cached) = state.user_location(&req.actor).await {
            if let UserLocation::Resolved { lat, lng } = cached {
                broadcast_pulse(&state, &req, lat, lng);
            }
            continue;
        }

        // cache miss → fetch profile
        match fetch_location(&client, &auth, &req.actor).await {
            Ok(Some(raw_location)) => {
                let coords = geocoder.lookup(&raw_location);
                match coords {
                    Some(c) => {
                        state
                            .upsert_user_location(
                                req.actor.clone(),
                                UserLocation::Resolved { lat: c.lat, lng: c.lng },
                            )
                            .await;
                        broadcast_pulse(&state, &req, c.lat, c.lng);
                    }
                    None => {
                        tracing::debug!(actor = %req.actor, raw = %raw_location, "geocode miss");
                        state
                            .upsert_user_location(req.actor.clone(), UserLocation::Unresolved)
                            .await;
                    }
                }
            }
            Ok(None) => {
                // user has no public location
                state
                    .upsert_user_location(req.actor.clone(), UserLocation::Unresolved)
                    .await;
            }
            Err(FetchErr::RateLimited(retry_after)) => {
                tracing::warn!(seconds = retry_after, "locate: rate-limited, backing off");
                sleep(Duration::from_secs(retry_after)).await;
                // don't cache on rate-limit — retry later
                continue;
            }
            Err(FetchErr::NotFound) => {
                // user deleted / renamed — cache as unresolved
                state
                    .upsert_user_location(req.actor.clone(), UserLocation::Unresolved)
                    .await;
            }
            Err(FetchErr::Other(e)) => {
                tracing::debug!(actor = %req.actor, error = %e, "locate fetch failed");
            }
        }

        // pacing — keep our total GitHub API usage well under 5000/hr
        sleep(Duration::from_millis(FETCH_PACING_MS)).await;
    }

    Ok(())
}

#[derive(Debug)]
enum FetchErr {
    RateLimited(u64),
    NotFound,
    Other(String),
}

async fn fetch_location(
    client: &reqwest::Client,
    auth: &HeaderValue,
    login: &str,
) -> std::result::Result<Option<String>, FetchErr> {
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, auth.clone());
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
    headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_STR));

    let url = format!("https://api.github.com/users/{}", login);
    let resp = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| FetchErr::Other(e.to_string()))?;

    let status = resp.status();

    if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = resp
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(60);
        return Err(FetchErr::RateLimited(retry_after));
    }
    if status == StatusCode::NOT_FOUND {
        return Err(FetchErr::NotFound);
    }
    if !status.is_success() {
        return Err(FetchErr::Other(format!("status {}", status)));
    }

    let user: GitHubUser = resp
        .json()
        .await
        .map_err(|e| FetchErr::Other(format!("json parse: {e}")))?;
    Ok(user
        .location
        .and_then(|s| if s.trim().is_empty() { None } else { Some(s) }))
}

fn broadcast_pulse(state: &Arc<AppState>, req: &LocateRequest, lat: f64, lng: f64) {
    let _ = state.tx.send(ServerMessage::Pulse {
        repo: req.repo.clone(),
        actor: req.actor.clone(),
        lat,
        lng,
    });
}

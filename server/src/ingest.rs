//! GitHub `/events` polling ingest.
//!
//! See CLAUDE.md Architecture.Ingest for the authoritative spec:
//! - Poll `/events?per_page=100` pages 1..=3 per tick (up to 300 events).
//! - 5-second base cadence, overridden upward by `X-Poll-Interval`.
//! - `ETag` per page → 304 short-circuit.
//! - Dedup by event ID across ticks (bounded ring buffer).
//! - Drop events with `created_at` older than 10 minutes.
//! - Emit each surviving `WatchEvent` as a structured tracing log line.

use crate::locate::LocateRequest;
use crate::state::{AppState, ServerMessage};
use anyhow::{Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, ETAG, IF_NONE_MATCH, USER_AGENT};
use reqwest::StatusCode;
use serde::Deserialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::time::sleep;

const BASE_POLL_SECS: u64 = 5;
const MAX_EVENT_AGE_MIN: i64 = 10;
const DEDUP_CAPACITY: usize = 10_000;
const PAGES_PER_TICK: u8 = 3;
const USER_AGENT_STR: &str = "starquake/0.1.0 (+https://github.com/graykode)";

#[derive(Deserialize, Debug)]
struct Event {
    id: String,
    #[serde(rename = "type")]
    event_type: String,
    created_at: DateTime<Utc>,
    repo: EventRepo,
    actor: EventActor,
}

#[derive(Deserialize, Debug)]
struct EventRepo {
    name: String,
}

#[derive(Deserialize, Debug)]
struct EventActor {
    login: String,
}

struct Dedup {
    seen: HashSet<String>,
    order: VecDeque<String>,
    capacity: usize,
}

impl Dedup {
    fn new(capacity: usize) -> Self {
        Self {
            seen: HashSet::with_capacity(capacity),
            order: VecDeque::with_capacity(capacity),
            capacity,
        }
    }

    /// Returns true if the id was newly inserted (not a duplicate).
    fn insert(&mut self, id: &str) -> bool {
        if self.seen.contains(id) {
            return false;
        }
        while self.seen.len() >= self.capacity {
            if let Some(old) = self.order.pop_front() {
                self.seen.remove(&old);
            } else {
                break;
            }
        }
        self.order.push_back(id.to_string());
        self.seen.insert(id.to_string());
        true
    }
}

pub async fn run(
    token: String,
    state: Arc<AppState>,
    locate_tx: mpsc::Sender<LocateRequest>,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT_STR)
        .gzip(true)
        .build()
        .context("build reqwest client")?;

    let auth = HeaderValue::from_str(&format!("Bearer {token}"))
        .context("GITHUB_TOKEN contains characters invalid for an HTTP header")?;

    let mut etags: HashMap<u8, String> = HashMap::new();
    let mut dedup = Dedup::new(DEDUP_CAPACITY);
    let poll_interval_secs = BASE_POLL_SECS;
    // watch_event WS broadcast is throttled to ≤5/sec per CLAUDE.md — the raw
    // firehose must not be exposed. 200ms minimum gap enforces the cap.
    let mut last_watch_broadcast = Instant::now() - Duration::from_secs(1);
    // Log a rate-limit summary at info every ~60s (720 ticks/hr → roughly
    // every 12 ticks), and always at warn when remaining dips below 500.
    // Rule 17 wants headroom surfaced, not buried in debug.
    let mut rate_log_countdown: u32 = 0;

    tracing::info!(interval_secs = poll_interval_secs, "ingest loop starting");

    loop {
        let tick_start = Instant::now();
        let mut page_stats: Vec<(u8, &'static str, usize)> = Vec::new();
        let mut watch_count = 0u32;
        let mut seen_this_tick = 0u32;

        for page in 1u8..=PAGES_PER_TICK {
            let mut headers = HeaderMap::new();
            headers.insert(AUTHORIZATION, auth.clone());
            headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
            headers.insert(USER_AGENT, HeaderValue::from_static(USER_AGENT_STR));
            if let Some(etag) = etags.get(&page) {
                if let Ok(v) = HeaderValue::from_str(etag) {
                    headers.insert(IF_NONE_MATCH, v);
                }
            }

            let url = format!("https://api.github.com/events?per_page=100&page={page}");
            let resp = match client.get(&url).headers(headers).send().await {
                Ok(r) => r,
                Err(e) => {
                    tracing::warn!(page = page, error = %e, "request error, skipping page");
                    page_stats.push((page, "net-err", 0));
                    break;
                }
            };

            // Rule 17: headroom is load-bearing — info every ~60s, warn when tight.
            if page == 1 {
                if let (Some(rem), Some(limit)) = (
                    header_u32(&resp, "x-ratelimit-remaining"),
                    header_u32(&resp, "x-ratelimit-limit"),
                ) {
                    if rem < 500 {
                        tracing::warn!(
                            remaining = rem,
                            limit = limit,
                            "rate_limit low headroom"
                        );
                    } else if rate_log_countdown == 0 {
                        tracing::info!(remaining = rem, limit = limit, "rate_limit");
                        rate_log_countdown = 12;
                    } else {
                        rate_log_countdown -= 1;
                    }
                }
                // X-Poll-Interval stays debug — advisory, logged for visibility only. Our
                // real constraint is the 5000 req/hr budget (see rate_limit above).
                if let Some(pi) = header_u64(&resp, "x-poll-interval") {
                    tracing::debug!(advisory_secs = pi, "x-poll-interval (advisory, ignored)");
                }
            }

            let status = resp.status();

            if status == StatusCode::NOT_MODIFIED {
                page_stats.push((page, "304", 0));
                continue;
            }

            if status == StatusCode::FORBIDDEN || status == StatusCode::TOO_MANY_REQUESTS {
                let retry_after = header_u64(&resp, "retry-after").unwrap_or(60);
                tracing::warn!(
                    page = page,
                    status = status.as_u16(),
                    retry_after_secs = retry_after,
                    "rate-limited, backing off"
                );
                page_stats.push((page, "rate-limit", 0));
                sleep(Duration::from_secs(retry_after)).await;
                break;
            }

            if !status.is_success() {
                tracing::warn!(page = page, status = status.as_u16(), "non-success, skipping page");
                page_stats.push((page, "non-2xx", 0));
                break;
            }

            if let Some(etag) = resp.headers().get(ETAG).and_then(|v| v.to_str().ok()) {
                etags.insert(page, etag.to_string());
            }

            let bytes = match resp.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!(page = page, error = %e, "body read error");
                    page_stats.push((page, "body-err", 0));
                    break;
                }
            };

            let events: Vec<Event> = match serde_json::from_slice(&bytes) {
                Ok(v) => v,
                Err(e) => {
                    tracing::warn!(page = page, error = %e, "parse error");
                    page_stats.push((page, "parse-err", 0));
                    break;
                }
            };

            let count = events.len();
            page_stats.push((page, "200", count));

            let now = Utc::now();
            let min_age = now - ChronoDuration::minutes(MAX_EVENT_AGE_MIN);

            for ev in events {
                seen_this_tick += 1;
                if !dedup.insert(&ev.id) {
                    continue;
                }
                if ev.created_at < min_age {
                    tracing::debug!(
                        id = %ev.id,
                        age_min = (now - ev.created_at).num_minutes(),
                        "stale event dropped"
                    );
                    continue;
                }
                if ev.event_type != "WatchEvent" {
                    continue;
                }

                watch_count += 1;
                state.record_watch(&ev.repo.name).await;
                tracing::debug!(
                    target: "starquake_server::watch",
                    event_id = %ev.id,
                    repo = %ev.repo.name,
                    actor = %ev.actor.login,
                    created_at = %ev.created_at.to_rfc3339(),
                    "watch_event"
                );
                if last_watch_broadcast.elapsed() >= Duration::from_millis(200) {
                    last_watch_broadcast = Instant::now();
                    let _ = state.tx.send(ServerMessage::WatchEvent {
                        repo: ev.repo.name.clone(),
                        actor: ev.actor.login.clone(),
                        at: Utc::now().to_rfc3339(),
                    });
                }
                // try_send: if the locate queue is full we drop — locate is a best-effort
                // side-channel; it must not backpressure the main ingest loop.
                let _ = locate_tx.try_send(LocateRequest {
                    actor: ev.actor.login.clone(),
                    repo: ev.repo.name.clone(),
                });
            }
        }

        let elapsed = tick_start.elapsed();
        tracing::info!(
            elapsed_ms = elapsed.as_millis() as u64,
            seen = seen_this_tick,
            watch = watch_count,
            "tick"
        );
        tracing::debug!(pages = ?page_stats, "tick pages");

        let sleep_for = Duration::from_secs(poll_interval_secs).saturating_sub(elapsed);
        if !sleep_for.is_zero() {
            sleep(sleep_for).await;
        }
    }
}

fn header_u32(resp: &reqwest::Response, name: &str) -> Option<u32> {
    resp.headers().get(name)?.to_str().ok()?.parse().ok()
}

fn header_u64(resp: &reqwest::Response, name: &str) -> Option<u64> {
    resp.headers().get(name)?.to_str().ok()?.parse().ok()
}

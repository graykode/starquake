//! Shared application state.
//!
//! For Phase 2, the counter is a simple in-memory `HashMap<repo, count>` keyed by the
//! current UTC date. Rolling at UTC 00:00 is implemented by noticing the date change
//! inside `record_watch` and clearing the map. Phase 3 will layer Postgres persistence
//! (`daily_top` snapshots) on top of this.
//!
//! Phase 4 adds `RepoMeta` cache populated by the `enrich` task (GraphQL batch).
//!
//! All events are counted — the leaderboard's top-100 is a read-time projection over
//! the full counter (CLAUDE.md Rule 10).

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;
use tokio::sync::{broadcast, RwLock};

const BROADCAST_CHANNEL_CAPACITY: usize = 64;

#[derive(Clone, Debug, Default, Serialize)]
pub struct RepoMeta {
    pub description: Option<String>,
    pub language: Option<String>,
    pub total_stars: Option<u32>,
    pub topics: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    pub rank: u32,
    pub repo: String,
    pub stars: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_stars: Option<u32>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub topics: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMessage {
    Leaderboard {
        utc_date: String,
        generated_at: String,
        total_repos_today: u32,
        total_stars_today: u32,
        entries: Vec<Entry>,
    },
    Pulse {
        repo: String,
        actor: String,
        lat: f64,
        lng: f64,
    },
}

/// Cached user-location result. `None` means we already looked the user up and
/// couldn't geocode (empty profile, unknown free-text, etc.) — we remember the
/// miss so we don't re-fetch.
#[derive(Clone, Copy, Debug)]
pub enum UserLocation {
    Resolved { lat: f64, lng: f64 },
    Unresolved,
}

pub struct AppState {
    counter: RwLock<HashMap<String, u32>>,
    current_utc_date: RwLock<String>,
    meta: RwLock<HashMap<String, RepoMeta>>,
    user_location: RwLock<HashMap<String, UserLocation>>,
    pub tx: broadcast::Sender<ServerMessage>,
}

impl AppState {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CHANNEL_CAPACITY);
        Self {
            counter: RwLock::new(HashMap::new()),
            current_utc_date: RwLock::new(Utc::now().date_naive().to_string()),
            meta: RwLock::new(HashMap::new()),
            user_location: RwLock::new(HashMap::new()),
            tx,
        }
    }

    pub async fn user_location(&self, login: &str) -> Option<UserLocation> {
        self.user_location.read().await.get(login).copied()
    }

    pub async fn upsert_user_location(&self, login: String, loc: UserLocation) {
        self.user_location.write().await.insert(login, loc);
    }

    pub async fn record_watch(&self, repo: &str) {
        let today = Utc::now().date_naive().to_string();
        {
            let mut date = self.current_utc_date.write().await;
            if *date != today {
                *date = today.clone();
                self.counter.write().await.clear();
                tracing::info!(new_utc_date = %today, "UTC date rolled, counter cleared");
            }
        }
        let mut counter = self.counter.write().await;
        *counter.entry(repo.to_string()).or_insert(0) += 1;
    }

    pub async fn top_n_repo_names(&self, n: usize) -> Vec<String> {
        let counter = self.counter.read().await;
        let mut items: Vec<(String, u32)> =
            counter.iter().map(|(k, v)| (k.clone(), *v)).collect();
        items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        items.truncate(n);
        items.into_iter().map(|(repo, _)| repo).collect()
    }

    pub async fn upsert_meta(&self, repo: String, meta: RepoMeta) {
        self.meta.write().await.insert(repo, meta);
    }

    pub async fn snapshot(&self, top_n: usize) -> ServerMessage {
        let counter = self.counter.read().await;
        let date = self.current_utc_date.read().await;
        let meta = self.meta.read().await;

        let mut items: Vec<(String, u32)> =
            counter.iter().map(|(k, v)| (k.clone(), *v)).collect();
        items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        items.truncate(top_n);

        let entries: Vec<Entry> = items
            .into_iter()
            .enumerate()
            .map(|(i, (repo, stars))| {
                let m = meta.get(&repo).cloned().unwrap_or_default();
                Entry {
                    rank: (i as u32) + 1,
                    repo,
                    stars,
                    description: m.description,
                    language: m.language,
                    total_stars: m.total_stars,
                    topics: m.topics,
                }
            })
            .collect();

        let total_repos = counter.len() as u32;
        let total_stars: u32 = counter.values().sum();

        ServerMessage::Leaderboard {
            utc_date: date.clone(),
            generated_at: Utc::now().to_rfc3339(),
            total_repos_today: total_repos,
            total_stars_today: total_stars,
            entries,
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

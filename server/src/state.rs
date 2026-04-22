//! Shared application state.
//!
//! The counter is an in-memory `HashMap<repo, count>` keyed by the current UTC
//! date. Rolling at UTC 00:00 is implemented by noticing the date change inside
//! `record_watch` and clearing the map.
//!
//! **Phase 7.6 — Postgres restart safety (not raw event persistence):** when
//! `DATABASE_URL` is set, AppState holds a `PgPool` and exposes three
//! persistence surfaces:
//!   - `hydrate()` on startup loads today's `live_counter`, all
//!     `user_location`, and all fresh `repo_metadata` rows so a redeploy
//!     resumes mid-day without losing accumulated stars or re-geocoding users.
//!   - `upsert_meta` / `upsert_user_location` write through so enrichment and
//!     geocoding results survive restarts immediately.
//!   - `snapshot_counter()` is called by a 60s background task and bulk-upserts
//!     today's counter into `live_counter` via UNNEST (single round trip).
//!
//! Raw `WatchEvent`s are still ephemeral (Rule 13) — only aggregates persist.
//! Without `DATABASE_URL`, AppState runs fully in-memory (local dev path).
//!
//! All events are counted — the leaderboard's top-100 is a read-time projection
//! over the full counter (CLAUDE.md Rule 10).

use anyhow::{Context, Result};
use chrono::{Duration as ChronoDuration, NaiveDate, Utc};
use serde::Serialize;
use sqlx::PgPool;
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

/// CLAUDE.md "fresh gem emphasis" — rendered in the UI as opacity + pulse
/// size. `Fresh` = the gem bucket (no row in `daily_top` within 30 days).
/// `Streak` = genuinely trending (≥3 consecutive UTC days including today).
/// `Returning` = appeared within 30 days but not on a current streak; dimmed.
/// Absent tier (no DB configured) renders as full brightness.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    Fresh,
    Streak,
    Returning,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier: Option<Tier>,
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
    db: Option<PgPool>,
    pub tx: broadcast::Sender<ServerMessage>,
}

impl AppState {
    pub fn new(db: Option<PgPool>) -> Self {
        let (tx, _) = broadcast::channel(BROADCAST_CHANNEL_CAPACITY);
        Self {
            counter: RwLock::new(HashMap::new()),
            current_utc_date: RwLock::new(Utc::now().date_naive().to_string()),
            meta: RwLock::new(HashMap::new()),
            user_location: RwLock::new(HashMap::new()),
            db,
            tx,
        }
    }

    /// Load today's counter + all cached geocoding + all fresh repo metadata
    /// from Postgres so a restart resumes mid-day cleanly. Safe to call with a
    /// fresh DB (all three queries return zero rows).
    pub async fn hydrate(&self) -> Result<()> {
        let Some(pool) = &self.db else { return Ok(()) };

        let today: NaiveDate = Utc::now().date_naive();

        let counter_rows: Vec<(String, i32)> =
            sqlx::query_as("SELECT repo, stars FROM live_counter WHERE utc_date = $1")
                .bind(today)
                .fetch_all(pool)
                .await
                .context("hydrate live_counter")?;
        let counter_len = counter_rows.len();
        {
            let mut counter = self.counter.write().await;
            for (repo, stars) in counter_rows {
                counter.insert(repo, stars.max(0) as u32);
            }
        }

        let loc_rows: Vec<(String, Option<f64>, Option<f64>)> =
            sqlx::query_as("SELECT login, lat, lng FROM user_location")
                .fetch_all(pool)
                .await
                .context("hydrate user_location")?;
        let loc_len = loc_rows.len();
        {
            let mut locs = self.user_location.write().await;
            for (login, lat, lng) in loc_rows {
                let loc = match (lat, lng) {
                    (Some(lat), Some(lng)) => UserLocation::Resolved { lat, lng },
                    _ => UserLocation::Unresolved,
                };
                locs.insert(login, loc);
            }
        }

        // Only hydrate metadata fetched within the 24h TTL — stale rows will
        // refetch naturally through the enrich loop.
        type MetaRow = (
            String,
            Option<String>,
            Option<String>,
            Option<i32>,
            sqlx::types::Json<Vec<String>>,
        );
        let meta_rows: Vec<MetaRow> = sqlx::query_as(
            "SELECT full_name, description, language, total_stars, topics \
             FROM repo_metadata \
             WHERE fetched_at > NOW() - INTERVAL '24 hours'",
        )
        .fetch_all(pool)
        .await
        .context("hydrate repo_metadata")?;
        let meta_len = meta_rows.len();
        {
            let mut meta = self.meta.write().await;
            for (repo, description, language, total_stars, topics) in meta_rows {
                meta.insert(
                    repo,
                    RepoMeta {
                        description,
                        language,
                        total_stars: total_stars.map(|n| n.max(0) as u32),
                        topics: topics.0,
                    },
                );
            }
        }

        tracing::info!(
            utc_date = %today,
            counter = counter_len,
            user_location = loc_len,
            repo_metadata = meta_len,
            "hydrated from postgres"
        );
        Ok(())
    }

    /// Bulk-upsert the current counter into `live_counter` for today. Called
    /// from a 60s background task. Uses `UNNEST` so the whole table round-trips
    /// in one query regardless of key count.
    pub async fn snapshot_counter(&self) -> Result<()> {
        let Some(pool) = &self.db else { return Ok(()) };

        let today: NaiveDate = Utc::now().date_naive();
        let (repos, stars): (Vec<String>, Vec<i32>) = {
            let counter = self.counter.read().await;
            let mut pairs: Vec<(String, i32)> = counter
                .iter()
                .map(|(repo, count)| (repo.clone(), *count as i32))
                .collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            let mut repos = Vec::with_capacity(pairs.len());
            let mut stars = Vec::with_capacity(pairs.len());
            for (repo, count) in pairs {
                repos.push(repo);
                stars.push(count);
            }
            (repos, stars)
        };

        if repos.is_empty() {
            return Ok(());
        }

        sqlx::query(
            "INSERT INTO live_counter (utc_date, repo, stars) \
             SELECT $1::date, repo, stars \
             FROM UNNEST($2::text[], $3::int[]) AS t(repo, stars) \
             ON CONFLICT (utc_date, repo) DO UPDATE SET stars = EXCLUDED.stars",
        )
        .bind(today)
        .bind(&repos)
        .bind(&stars)
        .execute(pool)
        .await
        .context("snapshot live_counter")?;

        tracing::debug!(utc_date = %today, rows = repos.len(), "counter snapshot written");
        Ok(())
    }

    pub async fn user_location(&self, login: &str) -> Option<UserLocation> {
        self.user_location.read().await.get(login).copied()
    }

    pub async fn upsert_user_location(&self, login: String, loc: UserLocation) {
        self.user_location.write().await.insert(login.clone(), loc);
        if let Some(pool) = &self.db {
            let (lat, lng) = match loc {
                UserLocation::Resolved { lat, lng } => (Some(lat), Some(lng)),
                UserLocation::Unresolved => (None, None),
            };
            if let Err(e) = sqlx::query(
                "INSERT INTO user_location (login, lat, lng, resolved_at) \
                 VALUES ($1, $2, $3, NOW()) \
                 ON CONFLICT (login) DO UPDATE \
                 SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, resolved_at = NOW()",
            )
            .bind(&login)
            .bind(lat)
            .bind(lng)
            .execute(pool)
            .await
            {
                tracing::warn!(error = %e, login = %login, "user_location write-through failed");
            }
        }
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
        self.meta.write().await.insert(repo.clone(), meta.clone());
        if let Some(pool) = &self.db {
            let topics = sqlx::types::Json(meta.topics);
            if let Err(e) = sqlx::query(
                "INSERT INTO repo_metadata (full_name, description, language, total_stars, topics, fetched_at) \
                 VALUES ($1, $2, $3, $4, $5, NOW()) \
                 ON CONFLICT (full_name) DO UPDATE \
                 SET description = EXCLUDED.description, language = EXCLUDED.language, \
                     total_stars = EXCLUDED.total_stars, topics = EXCLUDED.topics, \
                     fetched_at = NOW()",
            )
            .bind(&repo)
            .bind(&meta.description)
            .bind(&meta.language)
            .bind(meta.total_stars.map(|n| n as i32))
            .bind(&topics)
            .execute(pool)
            .await
            {
                tracing::warn!(error = %e, repo = %repo, "repo_metadata write-through failed");
            }
        }
    }

    pub async fn snapshot(&self, top_n: usize) -> ServerMessage {
        let counter = self.counter.read().await;
        let date = self.current_utc_date.read().await;
        let meta = self.meta.read().await;

        let mut items: Vec<(String, u32)> =
            counter.iter().map(|(k, v)| (k.clone(), *v)).collect();
        items.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        items.truncate(top_n);

        let repos: Vec<String> = items.iter().map(|(r, _)| r.clone()).collect();
        let tier_map = self.compute_tiers(&repos).await;

        let entries: Vec<Entry> = items
            .into_iter()
            .enumerate()
            .map(|(i, (repo, stars))| {
                let m = meta.get(&repo).cloned().unwrap_or_default();
                let tier = tier_map.get(&repo).copied();
                Entry {
                    rank: (i as u32) + 1,
                    tier,
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

    /// Pull last-30-day `daily_top` rows for the given repos and classify each
    /// as `Fresh` / `Streak` / `Returning` per CLAUDE.md. Returns empty when
    /// there's no DB or when the query fails (non-fatal — UI just renders at
    /// full brightness). One indexed query covers the whole top-N.
    async fn compute_tiers(&self, repos: &[String]) -> HashMap<String, Tier> {
        let Some(pool) = &self.db else { return HashMap::new() };
        if repos.is_empty() {
            return HashMap::new();
        }
        let today: NaiveDate = Utc::now().date_naive();
        let cutoff = today - ChronoDuration::days(30);

        let rows: Result<Vec<(String, NaiveDate)>, _> = sqlx::query_as(
            "SELECT repo, utc_date FROM daily_top \
             WHERE repo = ANY($1) AND utc_date >= $2 AND utc_date < $3",
        )
        .bind(repos)
        .bind(cutoff)
        .bind(today)
        .fetch_all(pool)
        .await;

        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "tier lookup failed; falling back to untiered");
                return HashMap::new();
            }
        };

        let yesterday = today - ChronoDuration::days(1);
        let day_before = today - ChronoDuration::days(2);
        let mut by_repo: HashMap<String, Vec<NaiveDate>> = HashMap::new();
        for (repo, date) in rows {
            by_repo.entry(repo).or_default().push(date);
        }

        let mut out = HashMap::with_capacity(repos.len());
        for repo in repos {
            let tier = match by_repo.get(repo) {
                None => Tier::Fresh,
                Some(dates) => {
                    let on_streak =
                        dates.contains(&yesterday) && dates.contains(&day_before);
                    if on_streak { Tier::Streak } else { Tier::Returning }
                }
            };
            out.insert(repo.clone(), tier);
        }
        out
    }

    /// Return the top-100 leaderboard for a finished UTC date from
    /// `daily_top`, joined with the (current) `repo_metadata` for description /
    /// language / total_stars. Topics come from the row itself — they were
    /// frozen at roll time so the history view doesn't drift if a repo later
    /// retags. Returns empty when the date has no snapshot (pre-launch, data
    /// loss, or just a date that never had activity).
    pub async fn history_entries(&self, date: NaiveDate) -> Result<Vec<Entry>> {
        let Some(pool) = &self.db else { return Ok(Vec::new()) };
        type HistoryRow = (
            String,
            i32,
            sqlx::types::Json<Vec<String>>,
            Option<String>,
            Option<String>,
            Option<i32>,
        );
        let rows: Vec<HistoryRow> = sqlx::query_as(
            "SELECT dt.repo, dt.stars, dt.topics, \
                    rm.description, rm.language, rm.total_stars \
             FROM daily_top dt \
             LEFT JOIN repo_metadata rm ON rm.full_name = dt.repo \
             WHERE dt.utc_date = $1 \
             ORDER BY dt.stars DESC, dt.repo ASC \
             LIMIT 100",
        )
        .bind(date)
        .fetch_all(pool)
        .await
        .context("history lookup")?;

        Ok(rows
            .into_iter()
            .enumerate()
            .map(|(i, (repo, stars, topics, description, language, total_stars))| Entry {
                rank: (i as u32) + 1,
                repo,
                stars: stars.max(0) as u32,
                description,
                language,
                total_stars: total_stars.map(|n| n.max(0) as u32),
                topics: topics.0,
                tier: None,
            })
            .collect())
    }

    /// Archive `target_date`'s top-100 from `live_counter` into `daily_top`,
    /// joined with `repo_metadata` for topics. Idempotent via `ON CONFLICT`:
    /// safe to run on every tick of the hourly roll loop, and safe to run on
    /// catchup after a missed window. No-op when DB is absent.
    pub async fn roll_daily_top(&self, target_date: NaiveDate) -> Result<u64> {
        let Some(pool) = &self.db else { return Ok(0) };

        let res = sqlx::query(
            "INSERT INTO daily_top (utc_date, repo, stars, topics) \
             SELECT lc.utc_date, lc.repo, lc.stars, \
                    COALESCE(rm.topics, '[]'::jsonb) \
             FROM live_counter lc \
             LEFT JOIN repo_metadata rm ON rm.full_name = lc.repo \
             WHERE lc.utc_date = $1 \
             ORDER BY lc.stars DESC, lc.repo ASC \
             LIMIT 100 \
             ON CONFLICT (utc_date, repo) DO NOTHING",
        )
        .bind(target_date)
        .execute(pool)
        .await
        .context("roll daily_top")?;

        Ok(res.rows_affected())
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new(None)
    }
}

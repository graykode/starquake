-- Live counter — snapshotted every ~60s so restarts don't reset today's stars.
CREATE TABLE IF NOT EXISTS live_counter (
    utc_date DATE   NOT NULL,
    repo     TEXT   NOT NULL,
    stars    INTEGER NOT NULL,
    PRIMARY KEY (utc_date, repo)
);
CREATE INDEX IF NOT EXISTS idx_live_counter_date ON live_counter (utc_date);

-- End-of-day top-100 snapshot (written at UTC 01:00 with 1h grace).
CREATE TABLE IF NOT EXISTS daily_top (
    utc_date     DATE   NOT NULL,
    repo         TEXT   NOT NULL,
    stars        INTEGER NOT NULL,
    topics       JSONB  NOT NULL DEFAULT '[]'::jsonb,
    snapshot_json JSONB,
    PRIMARY KEY (utc_date, repo)
);

-- Permanent per-GitHub-user geocoding cache.
CREATE TABLE IF NOT EXISTS user_location (
    login        TEXT PRIMARY KEY,
    lat          DOUBLE PRECISION,
    lng          DOUBLE PRECISION,
    resolved_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repo metadata cache (24h TTL enforced in code).
CREATE TABLE IF NOT EXISTS repo_metadata (
    full_name    TEXT PRIMARY KEY,
    description  TEXT,
    language     TEXT,
    total_stars  INTEGER,
    topics       JSONB NOT NULL DEFAULT '[]'::jsonb,
    fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

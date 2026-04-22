# CLAUDE.md

## Purpose

starquake is a near-real-time GitHub stargazing dashboard. Each star action becomes a tremor on a globe; each trending repo becomes an epicenter on today's leaderboard.

- **Live globe**: Left panel. A three.js globe renders a pulse at the stargazer's approximate location (city- or country-level) for every incoming `WatchEvent`. The stream is near-real-time — GitHub's public events feed lags 30 seconds to a few minutes behind actual stars.
- **Daily leaderboard**: Right panel. Every observed `WatchEvent` is counted. Stars accumulate from UTC 00:00; the top 100 repos by today's star count are rendered as a live stacked chart — tick-driven, like a crypto chart.
- **Repo details on hover**: Hovering any repo (on the leaderboard or a globe pulse) reveals description, primary language, author, topics, and total star count. Metadata is fetched via GitHub GraphQL and cached locally for 24 hours.
- **Top 100 is a read-time projection**: The in-memory counter tracks every repo with at least one observed star today (typically ~100k unique repos/day). The leaderboard is `top 100 by today's stars`, recomputed on every read — lifetime rank is ignored, so long-standing popular repos that pick up a slow drip of stars are suppressed by design. Today's top-100 topics are aggregated into a sidebar tag cloud.
- **Fresh gem emphasis**: The product's job is to surface new OSS gems, not replay every past viral repo. Each top-100 entry is tagged into one of three tiers and rendered accordingly: **fresh** (no row in `daily_top` within the last 30 days — full brightness, primary emphasis; this is the gem bucket), **streak** (on an active run of ≥3 consecutive UTC days in top-100 including today — full brightness, normal emphasis; these are genuinely trending, e.g. a real release cycle), and **returning** (appeared in `daily_top` within the last 30 days but not on a current streak — dimmed to ~50% opacity, smaller globe pulse). Rows older than 30 days do not count, so a long-dormant repo returning to the leaderboard reads as a gem again.
- **History view (snapshot)**: Any past UTC day can be viewed as its end-of-day top-100 leaderboard. Layout matches live mode. Per-event globe replay for past days is an explicit non-goal — history is a static leaderboard, not a playback.
- **Live feel (crypto-chart ergonomics)**: The right panel is designed to look alive second-by-second, like a trading terminal. Concretely: (a) the chart's latest tick extends every WebSocket `leaderboard_delta` batch (~1/sec) with a dashed vertical "now" ruler and a pulsing dot on each series' latest point; (b) the `#` row list reorders with FLIP animation (~150ms) whenever ranks change, with a brief highlight flash on the row that moved; (c) `TODAY` star-count cells count up via tween (~200ms) rather than snapping; (d) the globe fires a ripple at the stargazer's coordinates for each `pulse` message (~500ms fade); (e) the header shows a live wall clock in the user's local time plus UTC (e.g., `now 18:17 KST · 09:17 UTC`), ticking every second. All data underneath stays UTC; only the wall clock renders local time.

## Dev Setup

Prerequisites: Rust 1.75+ (stable), Node.js 20+, pnpm 9.15+, a GitHub personal access token with no scopes (public data only).

```bash
pnpm install
pnpm dev
```

`pnpm dev` runs `cargo run -p starquake-server` (ingest + counter + WebSocket on `:8080`) and the Next.js UI on `:3000` concurrently. Postgres runs in-process via the `pg-embed` crate (data under `~/.starquake/pgdata`) — no Docker required. To point at an external Postgres, set `DATABASE_URL` before any script.

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start Rust server + Next.js UI in dev mode |
| `pnpm build` | Build release binary (`cargo build --release`) + UI bundle |
| `pnpm typecheck` | TypeScript type checking (UI only) |
| `pnpm check` | Biome lint/format (UI) + `cargo fmt --check` + `cargo clippy -- -D warnings` (server) |
| `pnpm test` | Vitest (UI) + `cargo test --workspace` (server) |
| `pnpm db:migrate` | Apply SQL migrations under `server/migrations/` via `sqlx migrate run` |

## Environment Variables

| Variable | Default |
|----------|---------|
| `GITHUB_TOKEN` | *(required)* — PAT with no scopes; lifts the Events API rate limit to 5000 req/hr |
| `DATABASE_URL` | `postgresql://starquake:starquake@localhost:5432/starquake` |
| `PORT` | `8080` |
| `RUST_LOG` | `info` |
| `ENRICH_TOP_N` | `150` — number of current top repos proactively enriched with metadata + actor geolocation (buffer above the visible 100 for churn) |
| `BIGQUERY_PROJECT` | *(optional)* — set only for one-time historical backfill; never used at runtime |

## Architecture

Single Rust binary handles ingest, counting, enrichment, and WebSocket fanout. **GitHub is the only external network dependency at runtime.** No Redis, no managed queue, no third-party geocoder, no third-party metadata provider, no runtime BigQuery.

- **Ingest**: one tokio task polls `GET /events?per_page=100` with full pagination (pages 1–3, up to 300 events per tick — GitHub's upper bound for this endpoint) at a **fixed 5-second cadence**. `X-Poll-Interval` (GitHub's default advisory is 60s) is **logged for visibility but not obeyed** — the real constraint is our 5000 req/hr budget, which at 3 req/tick × 720 tick/hr = 2160 req/hr leaves ample headroom. The poller only slows via `Retry-After` on `403` / `429` (Rule 17). `ETag` is respected per page so unchanged pages short-circuit with `304 Not Modified` (most page-2/page-3 requests). Events are deduped by event ID across ticks; events with `created_at` older than 10 minutes are dropped (rare: occasional very old events surface in the feed). Only `type == "WatchEvent"` is retained. Every retained event increments the counter — no sampling, no admission filter. **Cost model**: 3 req/tick × 720 ticks/hr = 2160 req/hr (typical, most 2nd/3rd pages hit 304 cache), well under the 3600 req/hr polling ceiling. The remaining ~2840 req/hr funds enrichment.
- **Counter**: in-process, in-memory, keyed by `utc_date → (repo → star_count)` behind a `DashMap` or `RwLock<HashMap>`. Unbounded across repos (practically ~100k entries/day, ~10MB). The leaderboard is a read-time `top N by count` projection over the full counter. On process restart, today's counts rebuild from the next poll cycle onward — this loss is acceptable.
- **Tier projection**: When the top-100 is computed, each repo is tagged `fresh | streak | returning` by consulting `daily_top`. A single query pulls all rows for the top-100 repos in the last 30 UTC days (indexed on `(repo, utc_date)`); in the server, `fresh` = no rows, `streak` = rows present for each of the previous 2 consecutive UTC days (so with today, ≥3 in a row), `returning` = otherwise. The tag rides on `leaderboard_delta` WebSocket messages and drives the UI's opacity + globe-pulse-size rendering. The lookup cost is bounded (~100 repos × one indexed query per broadcast tick, batched).
- **Enrichment (bounded to top-N)**: a second tokio task watches the current top `ENRICH_TOP_N` repos and fills two caches.
  - **Repo metadata**: GitHub GraphQL batch query (up to 100 repos per call). Fields: description, primary language, author, topics, total stars. Cached for 24h in `repo_metadata`.
  - **Actor location**: `GET /users/{login}` to read the free-text `location` field, then matched against the embedded GeoNames dataset. Cached permanently in `user_location` — a GitHub user's location rarely changes, and if it does, the stale value is still acceptable for a dot on a globe. Only enriched for actors whose event lands on a top-N repo; long-tail users show up as leaderboard counts without a globe pulse.
- **Offline geocoding**: `cities15000.txt` (~4MB, ~25k cities ≥15k population) and `countryInfo.txt` (~10KB, ~250 countries) from GeoNames are embedded in the Rust binary via `include_str!`. Matching is case-insensitive substring + a small alias table (`SF` → `San Francisco`, `NYC` → `New York`, `KR` → `South Korea`, etc.). Failed matches render no globe pulse but still count on the leaderboard.
- **WebSocket**: clients connect to `/ws` (axum + tokio-tungstenite). The server broadcasts three message types — `leaderboard_delta` (top-100 diffs, batched ~1/sec), `pulse` (per-event globe tremors at top-N repos only), and `watch_event` (a minimal live-activity feed for the UI's event-log strip — `repo`, `actor`, and a server-side broadcast `at`; `event_id`, `created_at`, and any other raw-event fields are intentionally never sent). `watch_event` is throttled to ≤5/sec so it represents a sampled live pulse, not the raw event firehose — the raw firehose stays unexposed.
- **Persistence (Postgres via `sqlx`)** — four tables. `DATABASE_URL` is optional; when unset the server runs fully in-memory (local dev).
  - `live_counter (utc_date, repo, stars)` — today's in-memory counter, snapshotted every 60s. Hydrated on boot for today's UTC date so a redeploy resumes accumulating stars instead of resetting to zero.
  - `user_location (login, lat, lng, resolved_at)` — permanent geocoding cache (NULL lat/lng means "resolved to unknown"; we remember the miss).
  - `repo_metadata (full_name, description, language, topics, total_stars, fetched_at)` — 24h TTL enrichment cache.
  - `daily_top (utc_date, repo, stars, topics, snapshot_json)` — one row per top-100 repo per finished UTC day.
- **UTC roll with 1-hour grace**: at UTC 01:00 the previous day's top-100 is snapshotted to `daily_top` and the previous day's counter is discarded. The 1-hour grace window absorbs the Events API's natural lag for events whose `created_at` falls in the last minutes of yesterday.
- **History view**: the UI calls `/history?date=YYYY-MM-DD`. For today the server returns the live counter projection; for finished days it returns `daily_top`. If a past date has no snapshot (pre-launch, data loss), a one-time batch backfills `daily_top` from GH Archive on BigQuery with mandatory `_TABLE_SUFFIX` partition filters and `maximum_bytes_billed`. BigQuery is never on the request path.
- **Frontend**: Next.js App Router. `three-globe` on WebGL for the globe, TradingView Lightweight Charts for the leaderboard, Tailwind for layout. A single long-lived WebSocket feeds both panels; hover details are fetched via REST and served from the `repo_metadata` cache only — the frontend never calls GitHub directly.
- **Log rotation**: `events.jsonl` rotates daily at UTC 01:00 (same boundary as the snapshot roll). The prior day is gzipped in place, 7 days are retained, older files are pruned. Prevents disk-fill on Railway.

## Budget

**Hard cap: $5/mo. Target: $1/mo marginal.** Cost decisions are load-bearing on architecture — revisit this section before adding any managed service.

All hosting runs on the user's existing Railway Hobby subscription ($5/mo flat, includes $5 usage credit). Marginal cost for starquake is what it consumes beyond that credit.

| Component | Service | Monthly cost |
|---|---|---|
| Ingest + WebSocket + aggregator (single Rust binary) | Railway (shared with existing Hobby plan) | $0 marginal |
| Postgres (geo cache + metadata cache + daily snapshots) | Railway Postgres (shared) | $0 marginal |
| Sliding-window aggregation | In-process Rust (no Redis) | $0 |
| Frontend | Railway (Next.js, shared) | $0 marginal |
| Geocoding | Offline GeoNames (bundled in binary) | $0 |
| BigQuery (one-time backfill only) | GCP 1TB/mo free query allowance | $0 |
| Domain (`.com`) | ~$12/yr | ~$1 |
| **Total (marginal)** | | **~$1/mo** |

Rules that protect the budget:

- No managed Redis, no managed queue, no second always-on service. In-process only. Vertical scale before distribution.
- No raw event persistence. Counter is in-memory; raw events are ephemeral.
- All GitHub API calls run behind a shared in-process rate limiter (5000 req/hr ceiling). Polling uses ~3600/hr; the remaining ~1400/hr funds enrichment.
- BigQuery is never on the request path. Offline backfills only, with `maximum_bytes_billed` and `--dry_run` preview mandatory.
- Railway usage alerts configured at $3 / $5 / $10 over the Hobby credit.

Observed baseline (for sanity-checking regressions):

- **Global WatchEvent rate**: ~1.6/sec off-peak (UTC 10:00–12:00), ~3–5/sec peak (UTC 15:00–22:00). Daily volume: ~138k off-peak baseline, ~300k on a peak day.
- **Expected ingest cost** at 5s cadence with 3-page pagination: ~2160 req/hr (most 2nd/3rd pages short-circuit on ETag).
- **Expected enrichment cost**: ~720 req/hr at steady state (top-150 repo GraphQL batched 100-at-a-time every ~10min + permanent `user_location` cache warmup).
- **Total GitHub API spend**: ~2900 req/hr typical, ~3600 req/hr peak — comfortably under the 5000 req/hr ceiling.

Tripwires that would break the budget:

- Going viral → Railway usage exceeds the $5 Hobby credit under WebSocket load → usage-based overage. Acceptable, but only if traffic is real.
- GitHub rate-limit exhaustion during churn storms (top-N turning over rapidly) — mitigated by caching `user_location` permanently and `repo_metadata` for 24h, and by bounding enrichment to top-N.
- A BigQuery backfill run without partition filters can cost $100+ for a single query. Partition filters and `maximum_bytes_billed` are mandatory in any backfill script.

## Debugging

The Rust server writes structured event logs (via `tracing` + `tracing-subscriber` with JSON formatter) to `~/.starquake/logs/events.jsonl`. Tail the live stream:

```bash
tail -f ~/.starquake/logs/events.jsonl | jq 'select(.type=="watch_event")'
```

Verify the aggregator is producing broadcasts:

```bash
tail -f ~/.starquake/logs/events.jsonl | jq 'select(.type=="ws_broadcast")'
```

Inspect enrichment activity and GitHub rate-limit headroom:

```bash
tail -f ~/.starquake/logs/events.jsonl | jq 'select(.type | startswith("enrich_") or .type == "rate_limit")'
```

## Rules

1. **English only** — all code, comments, strings, docs, commits.
2. **File refs** — repo-root relative (`server/src/ingest/poller.rs:42`), never absolute.
3. **Commits** — `<type>: <description>`. Types: `feat`, `fix`, `refactor`, `docs`, `chore`.
4. **Secrets** — never commit. Use env vars. `.env` is gitignored. Tokens are server-side only; never embedded in the UI bundle and never returned in any API response.
5. **Scope is read-only and public.** No authentication, no user accounts, no follow/save/notify features. **Writing back to GitHub (starring, forking, commenting) is an explicit forever non-goal** — never implement, design for, or expose write operations to the GitHub API.
6. **Stars only.** Non-star events (PRs, commits, issues, releases) are out of scope. The product name is `starquake`, not `gitquake`. Adding a new event type requires explicit user approval.
7. **UTC is the only timezone for data.** All chart axes, day boundaries, resets, `daily_top` rows, and history navigation use UTC. Per-client local-time chart axes or day boundaries are an explicit forever non-goal — "honest UTC" is the product's identity. Day boundaries snapshot at UTC 01:00 (1-hour grace absorbs Events API lag). **Sole exception**: a display-only wall clock in the header may render the user's local time alongside the UTC time (e.g., `now 18:17 KST · 09:17 UTC`). This clock is cosmetic, computed client-side from `Intl.DateTimeFormat`, and never drives any data decision, query, or layout reset.
8. **Single external dependency at runtime.** GitHub API is the only network dependency in the serving path. No Mapbox, no Google Maps, no Nominatim, no third-party metadata services, no scraping, no webhook brokers. All geocoding data is embedded in the binary; all history is served from local Postgres. Adding any runtime external dependency requires explicit user approval.
9. **Events API is best-effort, not ground truth.** GitHub's `/events` feed lags 30 seconds to several minutes behind actual stars and caps the global stream at 300 events. The leaderboard reflects *observed* public `WatchEvent`s. This caveat must be surfaced in the UI (a small footnote is sufficient).
10. **All events are counted; the top 100 is a projection.** The in-memory counter admits every observed `WatchEvent` without filtering — the current top-100 cannot be known without counting everything. Never prune "unlikely to reach top-100" repos; the churn is exactly the point.
11. **Enrichment is top-N bounded, never universal.** Repo metadata and actor location are fetched only for events whose repo is currently in the top `ENRICH_TOP_N` (default 150 — a buffer above the visible 100 for churn). Long-tail repos render as leaderboard counts with skeleton hover and no globe pulse. This is the only way to fit all GitHub API calls inside 5000 req/hr.
12. **Budget is hard-capped at $5/mo.** Target marginal $1/mo over existing Railway Hobby. No managed Redis, no managed queue, no second always-on service. See "Budget" above.
13. **No raw event persistence; aggregates only.** Raw `WatchEvent`s are ephemeral — never logged to disk, never written to Postgres, never replayed. The live counter is snapshotted to `live_counter (utc_date, repo, stars)` every 60s so a redeploy or crash doesn't wipe today's accumulated stars; on boot the counter hydrates from today's rows. Worst-case loss on an unclean crash is ≤60s of counts, within the Events API's own lag envelope. `DATABASE_URL` is optional — unset means fully in-memory (local dev path), acceptable loss applies.
14. **Finished days live in Postgres, not BigQuery.** The history view reads `daily_top` only. BigQuery/GH Archive is used solely for one-time offline backfills of `daily_top` for pre-launch dates; it is never called from the request path. All BigQuery queries set `maximum_bytes_billed` and run `--dry_run` first.
15. **Geocoding is offline and best-effort.** GeoNames `cities15000.txt` + `countryInfo.txt` are embedded in the Rust binary. Accuracy is country-level at worst, city-level for common locations. Free-text locations that fail all matching are counted on the leaderboard but drop out of the globe view. No online geocoding service may be added.
16. **WebSocket is fire-and-forget.** `pulse` messages are not buffered, not retried, not replayed. On reconnect, the client receives one full `leaderboard_snapshot`, then `leaderboard_delta`s — nothing else. No per-client queues, no resume tokens, no gap-fill. This preserves the "raw event firehose is never exposed" invariant under any reconnect pattern; future contributors must not add event replay.
17. **GitHub rate-limit responses are load-bearing, and `GITHUB_TOKEN` is a single token.** The server must honor `Retry-After` on any `403` or secondary-rate-limit response, back off exponentially on consecutive failures, and surface the current limit headroom via the `rate_limit` log event. Token rotation and multi-token pools are forbidden — they bypass Rule 11's shared limiter and invalidate the 5000 req/hr accounting model.
18. **Desktop-first. Globe is desktop-only.** Below 1024px viewport width, the globe panel is hidden and the leaderboard fills the full width; the three.js canvas is not mounted on mobile. A separate mobile UX beyond this fold is a forever non-goal — the dashboard is designed for ≥1024px, and both the globe's GPU cost and the leaderboard's density assume desktop.

## Conventions

- **Rust 1.75+ stable** for the server. Single-binary monolith — ingest, counter, enrichment, and WebSocket fanout share one async runtime.
- **tokio** for the async runtime. **axum** for HTTP + WebSocket. **reqwest** for GitHub REST/GraphQL. **sqlx** with compile-time checked queries for Postgres. **serde / serde_json** for wire types. **tracing** + **tracing-subscriber** (JSON formatter) for structured logs. No Redis client, no message queue client.
- **TypeScript** strict mode for the UI. `type` imports. No `any`.
- **Next.js** (App Router) + **three.js** (via `three-globe`) + **TradingView Lightweight Charts** for the leaderboard + **Tailwind**.
- **Biome** for UI lint/format (not ESLint/Prettier). **rustfmt + clippy (deny warnings)** for server. Run `pnpm check` before commit.
- **SQL migrations** are plain `.sql` files under `server/migrations/`, applied by `sqlx migrate`. No ORM migration tool.
- **Zod** at the WebSocket boundary (UI side) and Rust `serde` structs (server side) define the wire contract. Shared message-type names are duplicated intentionally — no codegen across the language boundary for MVP.

## Meta

**Never modify `CLAUDE.md` without explicit user approval.** This file is the spec; code follows.

## Verification

Run before claiming done:

```bash
pnpm typecheck && pnpm check && pnpm test && pnpm build
```

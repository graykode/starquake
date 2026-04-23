"use client";
import dynamic from "next/dynamic";
import { useMemo, useState } from "react";
import { BarRace } from "@/components/BarRace";
import { EventLog } from "@/components/EventLog";
import { HoverCard } from "@/components/HoverCard";
import { LeaderboardList } from "@/components/LeaderboardList";
import { TopBar } from "@/components/TopBar";
import { TopicCloud } from "@/components/TopicCloud";
import { useHistory } from "@/hooks/useHistory";
import { useLeaderboard } from "@/hooks/useLeaderboard";
import type { Entry, LivePulse, Tier } from "@/lib/types";

const Globe = dynamic(() => import("@/components/Globe").then((m) => m.Globe), { ssr: false });

function utcTodayISO(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

const ALL_TIERS: Tier[] = ["fresh", "streak", "returning"];
const TIER_META: Record<Tier, { label: string; tip: string; dot: string; active: string; inactive: string }> = {
  fresh: {
    label: "fresh",
    tip: "No top-100 appearance in the last 30 UTC days — a potential new gem.",
    dot: "bg-accent",
    active: "border-accent/40 text-accent bg-accent/10",
    inactive: "border-line text-muted hover:text-fg/80",
  },
  streak: {
    label: "streak",
    tip: "On a run — top-100 for 3+ consecutive UTC days including today.",
    dot: "bg-sky-400",
    active: "border-sky-400/30 text-sky-300 bg-sky-400/10",
    inactive: "border-line text-muted hover:text-fg/80",
  },
  returning: {
    label: "returning",
    tip: "Back again — appeared in daily_top in the last 30 days, not on a current streak.",
    dot: "bg-white/40",
    active: "border-white/20 text-fg/80 bg-white/5",
    inactive: "border-line text-muted hover:text-fg/80",
  },
};

export default function Page() {
  // null = live (today, via WebSocket). Non-null = static (past UTC date, via /history).
  const [viewingDate, setViewingDate] = useState<string | null>(null);
  const today = useMemo(utcTodayISO, []);

  const live = useLeaderboard(viewingDate === null);
  const history = useHistory(viewingDate);

  const [hoverRepo, setHoverRepo] = useState<string | null>(null);
  const [hoverXY, setHoverXY] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  // Tier filter — live mode only. Defaults to fresh + streak (the gem /
  // trending buckets); returning is off by default so the first impression
  // foregrounds CLAUDE.md's fresh-gem emphasis. Hides filtered rows in the
  // `#` list; BarRace keeps them but dims them so the top-6 stack still
  // reflects the full projection.
  const [activeTiers, setActiveTiers] = useState<Set<Tier>>(
    () => new Set<Tier>(["fresh", "streak"]),
  );
  const toggleTier = (t: Tier) =>
    setActiveTiers((prev) => {
      const next = new Set(prev);
      if (next.has(t)) {
        if (next.size === 1) return prev; // never let user hide everything
        next.delete(t);
      } else {
        next.add(t);
      }
      return next;
    });

  const inHistory = viewingDate !== null;
  const entries: Entry[] = inHistory
    ? history.board?.entries ?? []
    : live.board?.entries ?? [];
  const displayDate = inHistory ? viewingDate : live.board?.utc_date ?? null;
  const hoverEntry = hoverRepo ? entries.find((e) => e.repo === hoverRepo) ?? null : null;

  // Attach tier to each pulse so the globe can shrink "returning" rings per
  // CLAUDE.md "fresh gem emphasis". Pulses for repos outside the top-100
  // carry no tier and render at the default (full) size.
  const tierByRepo = useMemo(() => {
    const m = new Map<string, Tier>();
    for (const e of entries) if (e.tier) m.set(e.repo, e.tier);
    return m;
  }, [entries]);
  const globePulses: LivePulse[] = useMemo(() => {
    if (inHistory) return [];
    return live.pulses.map((p) => ({ ...p, tier: tierByRepo.get(p.repo) }));
  }, [inHistory, live.pulses, tierByRepo]);

  const canGoNext = inHistory && viewingDate! < today;

  return (
    <div className="h-screen flex flex-col bg-bg">
      <TopBar
        connected={inHistory ? false : live.connected}
        utcDate={displayDate}
        totalRepos={inHistory ? entries.length : live.board?.total_repos_today ?? 0}
        totalStars={
          inHistory
            ? entries.reduce((a, e) => a + e.stars, 0)
            : live.board?.total_stars_today ?? 0
        }
      />

      <main className="flex-1 min-h-0 flex">
        <section className="hidden lg:flex lg:flex-col w-[28.57%] shrink-0 border-r border-line min-h-0">
          <Globe pulses={globePulses} />
          <EventLog events={inHistory ? [] : live.events} paused={inHistory} />
        </section>

        <section className="flex-1 min-w-0 min-h-0 flex flex-col bg-panel">
          <div className="px-5 pt-4 pb-2 border-b border-line">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                {inHistory ? `History · ${viewingDate}` : "Today's race"}
              </div>
              <div className="font-mono text-[10.5px] text-muted">
                {inHistory
                  ? history.loading
                    ? "loading…"
                    : history.error
                      ? "failed to load"
                      : entries.length === 0
                        ? "no snapshot for this date"
                        : `end-of-day top ${entries.length}`
                  : "top 8 live · top 100 listed below"}
              </div>

              <div className="flex-1" />

              <div className="flex items-center gap-1 font-mono text-[10.5px]">
                <button
                  type="button"
                  className="px-2 py-1 rounded border border-line text-muted hover:text-fg hover:border-white/20 transition-colors"
                  onClick={() =>
                    setViewingDate((d) => shiftDate(d ?? today, -1))
                  }
                  aria-label="previous day"
                >
                  ← prev
                </button>
                <button
                  type="button"
                  disabled={!canGoNext}
                  className="px-2 py-1 rounded border border-line text-muted hover:text-fg hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-muted disabled:hover:border-line transition-colors"
                  onClick={() => {
                    if (!canGoNext) return;
                    const next = shiftDate(viewingDate!, 1);
                    setViewingDate(next === today ? null : next);
                  }}
                  aria-label="next day"
                >
                  next →
                </button>
                <button
                  type="button"
                  disabled={!inHistory}
                  className={`px-2 py-1 rounded border transition-colors ${
                    inHistory
                      ? "border-line text-muted hover:text-fg hover:border-white/20"
                      : "border-accent/30 text-accent bg-accent/10"
                  }`}
                  onClick={() => setViewingDate(null)}
                >
                  today
                </button>
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-3 flex-wrap">
              <div className="text-[11px] text-muted">
                {inHistory
                  ? "Static end-of-day snapshot · no live pulses · UTC date boundary."
                  : "Observed public WatchEvents · ~30s–5min behind actual · counter resets at 00:00."}
              </div>
              {!inHistory && (
                <>
                  <div className="flex-1" />
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted/70">
                      tier
                    </span>
                    {ALL_TIERS.map((t) => {
                      const meta = TIER_META[t];
                      const on = activeTiers.has(t);
                      return (
                        <button
                          key={t}
                          type="button"
                          onClick={() => toggleTier(t)}
                          className={`group/chip relative inline-flex items-center gap-1 rounded border px-1.5 py-px font-mono text-[9.5px] uppercase tracking-wider transition-colors ${
                            on ? meta.active : meta.inactive
                          }`}
                          aria-pressed={on}
                        >
                          <span
                            className={`inline-block w-1.5 h-1.5 rounded-full ${meta.dot} ${on ? "" : "opacity-40"}`}
                          />
                          <span className={on ? "" : "opacity-70"}>{meta.label}</span>
                          <span
                            role="tooltip"
                            className="pointer-events-none absolute right-0 top-full mt-1 z-30 w-56 rounded border border-line bg-bg/95 px-2 py-1.5 text-[10.5px] normal-case tracking-normal font-normal text-fg/90 shadow-lg opacity-0 -translate-y-0.5 transition-all duration-150 group-hover/chip:opacity-100 group-hover/chip:translate-y-0"
                          >
                            {meta.tip}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Bar race stays mounted in history mode so the layout matches live
              (CLAUDE.md) — the spring/flash animations are no-ops without
              incoming ticks, which reads as a frozen end-of-day snapshot. The
              `key` resets internal flash state so crossing live↔history
              doesn't spuriously flash every row. */}
          <BarRace
            key={inHistory ? `h-${viewingDate}` : "live"}
            entries={entries}
            hoverRepo={hoverRepo}
            onHover={(r) => setHoverRepo(r)}
            activeTiers={inHistory ? undefined : activeTiers}
          />
          <div className="border-b border-line" />

          <LeaderboardList
            key={inHistory ? `lh-${viewingDate}` : "llive"}
            entries={entries}
            hoverRepo={hoverRepo}
            onHover={(repo, x, y) => {
              setHoverRepo(repo);
              if (repo) setHoverXY({ x, y });
            }}
            activeTiers={inHistory ? undefined : activeTiers}
          />

          <TopicCloud entries={entries} />
        </section>
      </main>

      <HoverCard entry={hoverEntry} x={hoverXY.x} y={hoverXY.y} />
    </div>
  );
}

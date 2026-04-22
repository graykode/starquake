"use client";
import dynamic from "next/dynamic";
import { useState } from "react";
import { BarRace } from "@/components/BarRace";
import { HoverCard } from "@/components/HoverCard";
import { LeaderboardList } from "@/components/LeaderboardList";
import { TopBar } from "@/components/TopBar";
import { TopicCloud } from "@/components/TopicCloud";
import { useLeaderboard } from "@/hooks/useLeaderboard";

const Globe = dynamic(() => import("@/components/Globe").then((m) => m.Globe), { ssr: false });

export default function Page() {
  const { board, connected, series, pulses } = useLeaderboard();
  const [hoverRepo, setHoverRepo] = useState<string | null>(null);
  const [hoverXY, setHoverXY] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

  const entries = board?.entries ?? [];
  const hoverEntry = hoverRepo ? entries.find((e) => e.repo === hoverRepo) ?? null : null;

  return (
    <div className="h-screen flex flex-col bg-bg">
      <TopBar
        connected={connected}
        utcDate={board?.utc_date ?? null}
        totalRepos={board?.total_repos_today ?? 0}
        totalStars={board?.total_stars_today ?? 0}
      />

      <main className="flex-1 min-h-0 flex">
        <Globe pulses={pulses} />

        <section className="flex-1 min-w-0 flex flex-col bg-panel">
          <div className="px-5 pt-4 pb-2 border-b border-line">
            <div className="flex items-baseline gap-3">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted">
                Today&rsquo;s race
              </div>
              <div className="font-mono text-[10.5px] text-muted">
                top 8 live · top 100 listed below
              </div>
            </div>
            <div className="mt-1.5 text-[11px] text-muted">
              Observed public WatchEvents · ~30s–5min behind actual · counter resets at 00:00.
            </div>
          </div>

          <BarRace entries={entries} hoverRepo={hoverRepo} onHover={(r) => setHoverRepo(r)} />
          <div className="border-b border-line" />

          <LeaderboardList
            entries={entries}
            hoverRepo={hoverRepo}
            onHover={(repo, x, y) => {
              setHoverRepo(repo);
              if (repo) setHoverXY({ x, y });
            }}
          />

          <TopicCloud entries={entries} />
        </section>
      </main>

      <HoverCard entry={hoverEntry} x={hoverXY.x} y={hoverXY.y} />
    </div>
  );
}

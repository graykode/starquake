"use client";
import { useMemo } from "react";
import type { Entry } from "@/lib/types";

const STOP = new Set([
  "app", "apps", "api", "test", "demo", "docs", "doc", "src", "lib", "core", "base",
  "new", "old", "main", "master", "hub", "com", "www", "the", "and", "for", "with",
  "from", "into", "this", "that", "you", "your", "dev", "pro", "plus", "beta",
  "plugin", "plugins", "extension", "tool", "tools", "util", "utils", "helper",
  "template", "starter", "boilerplate", "example", "examples", "sample", "samples",
  "v1", "v2", "v3",
]);
const NUMERIC = /^\d+$/;

type Chip = { token: string; count: number };

function aggregateRealTopics(entries: Entry[]): { chips: Chip[]; coverage: number } {
  const counts = new Map<string, number>();
  let enrichedCount = 0;
  for (const e of entries) {
    if (e.topics && e.topics.length > 0) {
      enrichedCount++;
      for (const t of e.topics) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const chips = [...counts.entries()]
    .filter(([, n]) => n >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 28)
    .map(([token, count]) => ({ token, count }));
  return { chips, coverage: entries.length > 0 ? enrichedCount / entries.length : 0 };
}

function deriveFromNames(entries: Entry[]): Chip[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const name = e.repo.split("/")[1] ?? "";
    const tokens = name
      .toLowerCase()
      .split(/[-_.\s]+/)
      .filter((t) => t.length >= 3 && t.length <= 20 && !STOP.has(t) && !NUMERIC.test(t));
    const seen = new Set<string>();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 28)
    .map(([token, count]) => ({ token, count }));
}

type Props = { entries: Entry[] };

export function TopicCloud({ entries }: Props) {
  const { chips, source } = useMemo(() => {
    const real = aggregateRealTopics(entries);
    // use real topics if at least 30% of entries are enriched
    if (real.coverage >= 0.3 && real.chips.length > 0) {
      return { chips: real.chips, source: "github" as const };
    }
    return { chips: deriveFromNames(entries), source: "names" as const };
  }, [entries]);

  const maxCount = chips[0]?.count ?? 1;

  return (
    <div className="border-t border-line px-5 py-3">
      <div className="flex items-center justify-between mb-2">
        <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
          Today&rsquo;s topics
        </div>
        <div className="font-mono text-[10.5px] text-muted">
          {source === "github"
            ? "aggregated from top 100 (github topics)"
            : "derived from repo names · enriching…"}
        </div>
      </div>
      {chips.length === 0 ? (
        <div className="font-mono text-[11px] text-muted">
          tokens appear as repos accumulate…
        </div>
      ) : (
        <div className="flex flex-wrap gap-x-3 gap-y-1.5">
          {chips.map(({ token, count }) => {
            const w = count / maxCount;
            const size = 10.5 + w * 5.5;
            const color = w > 0.65 ? "#ededed" : w > 0.35 ? "#c8c8cc" : "#8a8a94";
            const bg = w > 0.65 ? "rgba(251,191,36,0.06)" : "transparent";
            const border = w > 0.65 ? "rgba(251,191,36,0.25)" : "rgba(30,30,36,0.8)";
            return (
              <span
                key={token}
                className="font-mono inline-flex items-baseline gap-1 cursor-pointer transition-colors"
                style={{
                  fontSize: size,
                  color,
                  background: bg,
                  border: `1px solid ${border}`,
                  padding: "2px 8px",
                  borderRadius: 999,
                }}
              >
                #{token}
                <sup className="text-muted text-[9px]">{count}</sup>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

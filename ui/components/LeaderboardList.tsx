"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Entry, Tier } from "@/lib/types";

const LINE_PALETTE = [
  "#fbbf24",
  "#60a5fa", "#f472b6", "#a78bfa", "#34d399",
  "#f87171", "#22d3ee", "#fb923c", "#c084fc", "#4ade80",
];

const LANG_COLORS: Record<string, string> = {
  Go: "#00ADD8",
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Ruby: "#701516",
  C: "#555555",
  "C++": "#f34b7d",
  Shell: "#89e051",
  Java: "#b07219",
  Kotlin: "#A97BFF",
  Swift: "#F05138",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  "Jupyter Notebook": "#DA5B0B",
};

const FLASH_MS = 650;

// CLAUDE.md fresh-gem emphasis: fresh = primary, streak = normal, returning = dimmed.
// Every tier now carries a badge (returning kept visually subtle) so the row's
// tier is always legible — mirrors the filter chips.
function tierBadge(tier: Tier | undefined) {
  if (tier === "fresh") {
    return {
      label: "fresh",
      tip: "No top-100 appearance in the last 30 UTC days — a potential new gem.",
      className:
        "text-[9px] uppercase tracking-wider font-medium px-1.5 py-px rounded border border-accent/40 text-accent bg-accent/10",
    };
  }
  if (tier === "streak") {
    return {
      label: "streak",
      tip: "On a run — top-100 for 3+ consecutive UTC days including today.",
      className:
        "text-[9px] uppercase tracking-wider font-medium px-1.5 py-px rounded border border-sky-400/30 text-sky-300 bg-sky-400/10",
    };
  }
  if (tier === "returning") {
    return {
      label: "returning",
      tip: "Back again — appeared in daily_top in the last 30 days, not on a current streak.",
      className:
        "text-[9px] uppercase tracking-wider font-medium px-1.5 py-px rounded border border-white/15 text-fg/70 bg-white/5",
    };
  }
  return null;
}

type Props = {
  entries: Entry[];
  hoverRepo: string | null;
  onHover: (repo: string | null, x: number, y: number) => void;
  activeTiers?: Set<Tier>;
};

export function LeaderboardList({ entries, hoverRepo, onHover, activeTiers }: Props) {
  // Filter by tier when a filter is active. Entries without a tier (history
  // mode) are always visible — the filter chips are only shown live anyway.
  const visible = activeTiers
    ? entries.filter((e) => !e.tier || activeTiers.has(e.tier))
    : entries;
  // Track stars-on-last-snapshot per repo so we can flash rows that just gained stars.
  const prevStarsRef = useRef<Map<string, number>>(new Map());
  const [flashRepos, setFlashRepos] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const prev = prevStarsRef.current;
    const newlyUp: string[] = [];
    for (const e of entries) {
      const p = prev.get(e.repo);
      if (p != null && e.stars > p) newlyUp.push(e.repo);
    }
    // refresh the remembered snapshot
    const nextPrev = new Map<string, number>();
    for (const e of entries) nextPrev.set(e.repo, e.stars);
    prevStarsRef.current = nextPrev;

    if (newlyUp.length === 0) return;
    const token = Date.now();
    setFlashRepos((prevFlash) => {
      const next = new Map(prevFlash);
      for (const repo of newlyUp) next.set(repo, token);
      return next;
    });
    const t = setTimeout(() => {
      setFlashRepos((prevFlash) => {
        const next = new Map(prevFlash);
        for (const repo of newlyUp) {
          if (next.get(repo) === token) next.delete(repo);
        }
        return next;
      });
    }, FLASH_MS);
    return () => clearTimeout(t);
  }, [entries]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="px-5 py-2.5 border-b border-line flex items-center gap-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-muted">
        <span className="w-8">#</span>
        <span className="flex-1">repository</span>
        <span className="w-16 text-right">lang</span>
        <span className="w-20 text-right">today</span>
      </div>
      <div className="overflow-y-auto flex-1">
        <AnimatePresence initial={false}>
          {visible.map((e) => {
            const hot = hoverRepo === e.repo;
            const color = e.rank <= 10 ? LINE_PALETTE[e.rank - 1] : "#2a2a32";
            const [owner, ...nameRest] = e.repo.split("/");
            const name = nameRest.join("/");
            const langColor = e.language ? LANG_COLORS[e.language] ?? "#999" : null;
            const flash = flashRepos.has(e.repo);
            const dimmed = e.tier === "returning";
            const badge = tierBadge(e.tier);

            return (
              <motion.div
                key={e.repo}
                layout
                transition={{ layout: { type: "spring", stiffness: 480, damping: 38 } }}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: dimmed ? 0.5 : 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                onMouseEnter={(ev) => onHover(e.repo, ev.clientX, ev.clientY)}
                onMouseMove={(ev) => onHover(e.repo, ev.clientX, ev.clientY)}
                onMouseLeave={() => onHover(null, 0, 0)}
                onClick={() =>
                  window.open(`https://github.com/${e.repo}`, "_blank", "noopener,noreferrer")
                }
                role="link"
                tabIndex={0}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    window.open(`https://github.com/${e.repo}`, "_blank", "noopener,noreferrer");
                  }
                }}
                className={`px-5 py-2 border-b border-line/60 flex items-start gap-4 text-[12.5px] cursor-pointer relative ${
                  hot ? "bg-white/[0.03]" : "hover:bg-white/[0.02]"
                }`}
              >
                {/* flash overlay — brief amber wash when stars go up */}
                {flash && (
                  <motion.span
                    className="absolute inset-0 pointer-events-none"
                    initial={{ opacity: 0.32 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: FLASH_MS / 1000, ease: "easeOut" }}
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(251,191,36,0.22) 0%, rgba(251,191,36,0.06) 55%, transparent 100%)",
                    }}
                  />
                )}
                <span className="w-8 pt-0.5 font-mono tabular-nums text-muted text-[11px]">
                  {String(e.rank).padStart(2, "0")}
                </span>
                <span
                  className="inline-block w-1 h-8 rounded-sm shrink-0 mt-0.5"
                  style={{ background: color }}
                />
                <div className="flex-1 min-w-0 flex flex-col">
                  <div className="font-mono truncate text-fg flex items-center gap-2">
                    <span className="truncate">
                      <span className="text-muted">{owner}/</span>
                      <span>{name}</span>
                    </span>
                    {badge && (
                      <span
                        className={`${badge.className} shrink-0 cursor-help`}
                        title={badge.tip}
                      >
                        {badge.label}
                      </span>
                    )}
                  </div>
                  {e.description && (
                    <div className="text-[11px] text-muted/80 truncate mt-0.5 leading-snug">
                      {e.description}
                    </div>
                  )}
                </div>
                <span className="w-16 pt-0.5 text-right font-mono text-[10.5px] text-dim whitespace-nowrap">
                  {e.language && langColor ? (
                    <span className="inline-flex items-center gap-1 justify-end">
                      <span
                        className="inline-block w-1.5 h-1.5 rounded-full"
                        style={{ background: langColor }}
                      />
                      {e.language}
                    </span>
                  ) : (
                    <span className="text-muted/40">—</span>
                  )}
                </span>
                <span className="w-20 pt-0.5 text-right font-mono tabular-nums">
                  <motion.span
                    key={e.stars}
                    initial={flash ? { scale: 1.18, color: "#fef3c7" } : false}
                    animate={{ scale: 1, color: e.rank === 1 ? "#fbbf24" : "#ededed" }}
                    transition={{ duration: 0.25 }}
                    className="inline-block"
                  >
                    +{e.stars.toLocaleString()}
                  </motion.span>
                </span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

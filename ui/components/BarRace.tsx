"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Entry } from "@/lib/types";

const LINE_PALETTE = [
  "#fbbf24",
  "#60a5fa", "#f472b6", "#a78bfa", "#34d399",
  "#f87171", "#22d3ee", "#fb923c", "#c084fc", "#4ade80",
];

const TOP_N = 6;
const FLASH_MS = 700;
const MIN_BAR_PCT = 14; // minimum bar width so tiny entries remain visible

type Props = {
  entries: Entry[];
  hoverRepo: string | null;
  onHover: (repo: string | null) => void;
};

export function BarRace({ entries, hoverRepo, onHover }: Props) {
  const top = entries.slice(0, TOP_N);
  const leaderStars = top[0]?.stars ?? 1;

  const prevRef = useRef<Map<string, number>>(new Map());
  const [flash, setFlash] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    const prev = prevRef.current;
    const up: string[] = [];
    for (const e of top) {
      const p = prev.get(e.repo);
      if (p != null && e.stars > p) up.push(e.repo);
    }
    const nextPrev = new Map<string, number>();
    for (const e of top) nextPrev.set(e.repo, e.stars);
    prevRef.current = nextPrev;

    if (up.length === 0) return;
    const token = Date.now();
    setFlash((f) => {
      const next = new Map(f);
      for (const r of up) next.set(r, token);
      return next;
    });
    const t = setTimeout(() => {
      setFlash((f) => {
        const next = new Map(f);
        for (const r of up) if (next.get(r) === token) next.delete(r);
        return next;
      });
    }, FLASH_MS);
    return () => clearTimeout(t);
  }, [top]);

  // Empty state is intentionally minimal — the section header above carries
  // the contextual message (loading / no snapshot / waiting) so BarRace just
  // reserves a little vertical space without a repeated label.
  if (top.length === 0) {
    return <div className="h-3" />;
  }

  return (
    <div className="px-5 py-3 flex flex-col gap-1.5 relative">
      <AnimatePresence initial={false}>
        {top.map((e) => {
          const color = LINE_PALETTE[e.rank - 1] ?? "#4a4a52";
          const pct = Math.max(MIN_BAR_PCT, (e.stars / leaderStars) * 100);
          const name = e.repo.split("/")[1] ?? e.repo;
          const hi = hoverRepo ? hoverRepo === e.repo : e.rank === 1;
          const dim = hoverRepo != null && hoverRepo !== e.repo;
          const isFlashing = flash.has(e.repo);

          return (
            <motion.div
              key={e.repo}
              layout
              transition={{
                layout: { type: "spring", stiffness: 500, damping: 34 },
              }}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: dim ? 0.45 : 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              onMouseEnter={() => onHover(e.repo)}
              onMouseLeave={() => onHover(null)}
              onClick={() =>
                window.open(`https://github.com/${e.repo}`, "_blank", "noopener,noreferrer")
              }
              className="relative flex items-center gap-3 h-[26px] cursor-pointer select-none group"
            >
              <span
                className="w-5 font-mono tabular-nums text-[10.5px] text-muted text-right shrink-0"
                style={{ color: hi ? color : undefined }}
              >
                {e.rank}
              </span>

              {/* bar track */}
              <div className="relative flex-1 h-[22px] rounded-sm overflow-hidden bg-white/[0.015]">
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-sm"
                  initial={false}
                  animate={{ width: `${pct}%` }}
                  transition={{ type: "spring", stiffness: 180, damping: 26 }}
                  style={{
                    background: `linear-gradient(90deg, ${color}40 0%, ${color}22 70%, ${color}00 100%)`,
                    boxShadow: hi ? `0 0 14px ${color}55, inset 0 0 6px ${color}66` : "none",
                    borderLeft: `2px solid ${color}`,
                  }}
                />
                {isFlashing && (
                  <motion.div
                    className="absolute inset-0 pointer-events-none"
                    initial={{ opacity: 0.55 }}
                    animate={{ opacity: 0 }}
                    transition={{ duration: FLASH_MS / 1000, ease: "easeOut" }}
                    style={{
                      background:
                        "linear-gradient(90deg, rgba(251,191,36,0.38) 0%, rgba(251,191,36,0.08) 60%, transparent 100%)",
                    }}
                  />
                )}
                {/* text layered over bar */}
                <div className="relative h-full flex items-center px-2.5 gap-2 font-mono">
                  <span
                    className={`text-[12px] truncate ${hi ? "text-fg" : "text-dim"}`}
                    style={{ maxWidth: "70%" }}
                  >
                    {name}
                  </span>
                  {e.language && (
                    <span className="text-[10px] text-muted truncate hidden xl:inline">
                      · {e.language}
                    </span>
                  )}
                </div>
              </div>

              {/* live counter */}
              <motion.span
                key={e.stars}
                initial={isFlashing ? { scale: 1.22, color: "#fef3c7" } : false}
                animate={{ scale: 1, color: hi ? color : "#ededed" }}
                transition={{ duration: 0.3 }}
                className="w-14 text-right font-mono text-[13px] font-medium tabular-nums shrink-0"
              >
                +{e.stars.toLocaleString()}
              </motion.span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

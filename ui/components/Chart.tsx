"use client";
import { useMemo } from "react";
import type { Entry, TimeSeriesPoint } from "@/lib/types";

const LINE_PALETTE = [
  "#fbbf24", // #1 = accent amber
  "#60a5fa", "#f472b6", "#a78bfa", "#34d399",
  "#f87171", "#22d3ee", "#fb923c", "#c084fc", "#4ade80",
];

const WIDTH = 740;
const HEIGHT = 190;
const PAD_L = 44;
const PAD_R = 118;
const PAD_T = 12;
const PAD_B = 22;
const MIN_LABEL_SPACING = 10;
const PLOT_TOP_N = 10;

type Props = {
  topEntries: Entry[];
  series: Map<string, TimeSeriesPoint[]>;
  hoverRepo: string | null;
  onHover: (repo: string | null) => void;
};

export function Chart({ topEntries, series, hoverRepo, onHover }: Props) {
  const plot = useMemo(() => {
    const top = topEntries.slice(0, PLOT_TOP_N);
    const windowStart = Date.now() - 12 * 60 * 1000;
    return top
      .map((entry, i) => {
        const raw = series.get(entry.repo) ?? [];
        const windowed = raw.filter((p) => p.t >= windowStart);
        return {
          entry,
          color: LINE_PALETTE[i] ?? "#4a4a52",
          points: windowed.length > 0 ? windowed : [{ t: Date.now(), stars: entry.stars }],
        };
      })
      .filter((d) => d.points.length > 0);
  }, [topEntries, series]);

  const timeRange = useMemo(() => {
    let minT = Infinity;
    let maxT = -Infinity;
    for (const d of plot) {
      for (const p of d.points) {
        if (p.t < minT) minT = p.t;
        if (p.t > maxT) maxT = p.t;
      }
    }
    if (!isFinite(minT)) {
      const now = Date.now();
      minT = now - 60_000;
      maxT = now;
    }
    if (maxT - minT < 30_000) maxT = minT + 30_000;
    return { minT, maxT };
  }, [plot]);

  const maxY = useMemo(() => {
    let m = 0;
    for (const d of plot) {
      for (const p of d.points) if (p.stars > m) m = p.stars;
    }
    return Math.max(1, m);
  }, [plot]);

  if (plot.length === 0) {
    return (
      <div className="px-5 py-6 text-[12px] text-muted font-mono">
        waiting for first snapshot to accumulate time-series…
      </div>
    );
  }

  const innerW = WIDTH - PAD_L - PAD_R;
  const innerH = HEIGHT - PAD_T - PAD_B;
  const xOf = (t: number) =>
    PAD_L + ((t - timeRange.minT) / (timeRange.maxT - timeRange.minT)) * innerW;
  const yOf = (s: number) => PAD_T + innerH - (s / maxY) * innerH;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * maxY));

  // anti-collision for end labels
  const endY = plot.map((d) => yOf(d.points[d.points.length - 1].stars));
  const order = plot.map((_, i) => i).sort((a, b) => endY[a] - endY[b]);
  const labelY = new Array(plot.length);
  let prev = -Infinity;
  for (const i of order) {
    labelY[i] = Math.max(endY[i], prev + MIN_LABEL_SPACING);
    prev = labelY[i];
  }

  // build area path for #1 (fill under leader line)
  const leader = plot[0];
  let leaderArea = "";
  if (leader) {
    const pts = leader.points;
    const segs: string[] = [`M ${xOf(pts[0].t)} ${yOf(pts[0].stars)}`];
    for (let k = 1; k < pts.length; k++) {
      segs.push(`L ${xOf(pts[k].t)} ${yOf(pts[k - 1].stars)}`);
      segs.push(`L ${xOf(pts[k].t)} ${yOf(pts[k].stars)}`);
    }
    segs.push(`L ${xOf(pts[pts.length - 1].t)} ${PAD_T + innerH}`);
    segs.push(`L ${xOf(pts[0].t)} ${PAD_T + innerH}`);
    segs.push("Z");
    leaderArea = segs.join(" ");
  }

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      style={{ width: "100%", height: "auto", display: "block" }}
      aria-label="Cumulative stars chart"
    >
      <defs>
        <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="leaderArea" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="endFlag" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="#fbbf24" stopOpacity="0" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.9" />
        </linearGradient>
      </defs>

      {/* grid */}
      <g stroke="rgba(255,255,255,0.035)" strokeWidth="1">
        {yTicks.map((v, i) => (
          <line key={`y${i}`} x1={PAD_L} y1={yOf(v)} x2={PAD_L + innerW} y2={yOf(v)} />
        ))}
      </g>

      {/* y-axis tick values only (no "stars" label — was overlapping the leader) */}
      <g fontFamily="ui-monospace, monospace" fontSize="7.5" fill="#6e6e78">
        {yTicks.map((v, i) => (
          <text key={`yl${i}`} x={PAD_L - 6} y={yOf(v) + 3} textAnchor="end">
            {v}
          </text>
        ))}
        <text x={PAD_L} y={PAD_T + innerH + 12} textAnchor="start">
          {formatTime(timeRange.minT)}
        </text>
        <text x={PAD_L + innerW} y={PAD_T + innerH + 12} textAnchor="end">
          now
        </text>
      </g>

      {/* leader area fill */}
      {leader && <path d={leaderArea} fill="url(#leaderArea)" opacity="0.75" />}

      {/* lines with neon glow */}
      {plot.map((d, i) => {
        const pts = d.points;
        let path = `M ${xOf(pts[0].t)} ${yOf(pts[0].stars)}`;
        for (let k = 1; k < pts.length; k++) {
          path += ` L ${xOf(pts[k].t)} ${yOf(pts[k - 1].stars)} L ${xOf(pts[k].t)} ${yOf(pts[k].stars)}`;
        }
        const isHi = hoverRepo ? hoverRepo === d.entry.repo : d.entry.rank === 1;
        const dim = hoverRepo != null && hoverRepo !== d.entry.repo;
        const lineEnd = endY[i];
        const lab = labelY[i];
        const raw = d.entry.repo.split("/")[1] ?? d.entry.repo;
        const shortName = raw.length > 14 ? `${raw.slice(0, 13)}…` : raw;
        const endX = xOf(pts[pts.length - 1].t);

        return (
          <g
            key={d.entry.repo}
            onMouseEnter={() => onHover(d.entry.repo)}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: "pointer" }}
          >
            <path
              d={path}
              fill="none"
              stroke={d.color}
              strokeWidth={isHi ? 2.2 : 1.2}
              opacity={dim ? 0.2 : isHi ? 1 : 0.78}
              filter={isHi ? "url(#neonGlow)" : undefined}
            />
            {/* end dot — pulsing for #1 */}
            <circle cx={endX} cy={lineEnd} r={isHi ? 3.2 : 2} fill={d.color} opacity={dim ? 0.3 : 1}>
              {isHi && (
                <animate
                  attributeName="r"
                  values={`${isHi ? 3.2 : 2};${isHi ? 4.6 : 3};${isHi ? 3.2 : 2}`}
                  dur="1.4s"
                  repeatCount="indefinite"
                />
              )}
            </circle>
            {isHi && (
              <circle cx={endX} cy={lineEnd} r="4" fill="none" stroke={d.color} strokeWidth="0.8" opacity="0.4">
                <animate attributeName="r" values="4;10;4" dur="1.8s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.45;0;0.45" dur="1.8s" repeatCount="indefinite" />
              </circle>
            )}
            {Math.abs(lab - lineEnd) > 2 && (
              <line
                x1={endX + 3}
                y1={lineEnd}
                x2={endX + 7}
                y2={lab}
                stroke={d.color}
                strokeWidth="0.6"
                opacity={dim ? 0.2 : 0.5}
              />
            )}
            <text
              x={endX + 9}
              y={lab + 3}
              fontFamily="ui-monospace, monospace"
              fontSize="7.5"
              fill={isHi ? "#ededed" : "#a1a1aa"}
              opacity={dim ? 0.35 : 1}
            >
              {d.entry.rank}. {shortName}
            </text>
          </g>
        );
      })}

      {/* price-flag annotation for #1 */}
      {leader && (() => {
        const lastPt = leader.points[leader.points.length - 1];
        const y = yOf(lastPt.stars);
        const x = xOf(lastPt.t);
        const flagW = 46;
        return (
          <g>
            <rect
              x={x - flagW}
              y={y - 8}
              width={flagW}
              height={16}
              rx={2}
              fill="url(#endFlag)"
            />
            <text
              x={x - 4}
              y={y + 3.5}
              textAnchor="end"
              fontFamily="ui-monospace, monospace"
              fontSize="9"
              fontWeight="600"
              fill="#0a0a10"
            >
              +{lastPt.stars}
            </text>
          </g>
        );
      })()}
    </svg>
  );
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

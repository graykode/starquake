"use client";
import type { Entry } from "@/lib/types";

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

function abbrev(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

type Props = {
  entry: Entry | null;
  x: number;
  y: number;
};

export function HoverCard({ entry, x, y }: Props) {
  if (!entry) return null;
  const author = entry.repo.split("/")[0] ?? "";
  const name = entry.repo.split("/").slice(1).join("/");
  const langColor = entry.language ? LANG_COLORS[entry.language] ?? "#999" : undefined;
  const hasMeta =
    entry.description != null || entry.language != null || entry.total_stars != null;

  return (
    <div
      className="pointer-events-none fixed z-50 w-[360px] rounded-lg border border-line2 bg-card p-3"
      style={{
        left: x + 16,
        top: y + 16,
        boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
      }}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <div className="font-mono text-[12.5px] text-fg truncate flex-1 min-w-0">
          <span className="text-muted">{author}/</span>
          <span className="font-medium">{name}</span>
        </div>
        <div className="font-mono text-[10.5px] text-accent whitespace-nowrap font-medium">
          +{entry.stars.toLocaleString()} today
        </div>
      </div>

      {entry.description && (
        <div className="text-[12px] text-dim leading-relaxed mt-1.5 mb-2">
          {entry.description}
        </div>
      )}

      <div className="flex items-center gap-3 font-mono text-[10.5px] text-muted">
        {entry.language && langColor && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: langColor }}
            />
            {entry.language}
          </span>
        )}
        {entry.total_stars != null && <span>★ {abbrev(entry.total_stars)} total</span>}
        <span className="ml-auto">#{entry.rank}</span>
      </div>

      {entry.topics && entry.topics.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {entry.topics.slice(0, 6).map((t) => (
            <span
              key={t}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded border border-line bg-white/[0.03] text-dim"
            >
              #{t}
            </span>
          ))}
        </div>
      )}

      {!hasMeta && (
        <div className="font-mono text-[10px] text-muted/70 mt-1">
          enriching metadata…
        </div>
      )}
    </div>
  );
}

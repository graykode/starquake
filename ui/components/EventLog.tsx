"use client";
import type { LiveEvent } from "@/lib/types";

type Props = {
  events: LiveEvent[];
  paused: boolean;
};

function fmtLocalTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function localTzAbbr(): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(
      new Date(),
    );
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export function EventLog({ events, paused }: Props) {
  const tz = localTzAbbr();
  return (
    <div className="relative border-t border-line bg-panel/40 min-h-0 flex flex-col h-[32%]">
      <div className="flex items-center gap-3 px-4 py-1.5 border-b border-line/60">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">live events</div>
        <div className="font-mono text-[10px] text-muted/70">
          {paused ? "paused — history mode" : `sampled ≤5/sec${tz ? ` · ${tz}` : ""}`}
        </div>
        <div className="flex-1" />
        {!paused && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="font-mono text-[10px] text-muted">rec</span>
          </div>
        )}
      </div>
      <div className="flex-1 overflow-hidden px-4 py-1.5">
        {events.length === 0 ? (
          <div className="font-mono text-[11px] text-muted/60">{paused ? "—" : "watching…"}</div>
        ) : (
          <ol className="font-mono text-[11px] leading-[1.55] space-y-[1px]">
            {events.map((ev) => (
              <li
                key={`${ev.at}-${ev.repo}-${ev.actor}`}
                className="flex items-center gap-2 whitespace-nowrap animate-[eventRow_220ms_ease-out]"
              >
                <span className="text-muted/70 shrink-0">{fmtLocalTime(ev.at)}</span>
                <span className="text-accent/90 shrink-0">↑</span>
                <a
                  href={`https://github.com/${ev.repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-fg/90 truncate max-w-[45%] hover:text-accent hover:underline"
                  title={ev.repo}
                >
                  {ev.repo}
                </a>
                <span className="text-muted/60 shrink-0">←</span>
                <a
                  href={`https://github.com/${ev.actor}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted truncate hover:text-accent hover:underline"
                  title={ev.actor}
                >
                  {ev.actor}
                </a>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

"use client";
import { useEffect, useState } from "react";

type Props = {
  connected: boolean;
  utcDate: string | null;
  totalRepos: number;
  totalStars: number;
};

type Clock = { local: string; utc: string; tz: string };

export function TopBar({ connected, utcDate, totalRepos, totalStars }: Props) {
  const [clock, setClock] = useState<Clock>({ local: "", utc: "", tz: "" });

  useEffect(() => {
    const pad = (n: number) => n.toString().padStart(2, "0");
    const fmt = () => {
      const d = new Date();
      const local = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const utc = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      const tz =
        Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
          .formatToParts(d)
          .find((p) => p.type === "timeZoneName")?.value ?? "";
      setClock({ local, utc, tz });
    };
    fmt();
    const id = setInterval(fmt, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-14 shrink-0 border-b border-line flex items-center px-5 gap-5">
      <div className="flex items-center gap-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"
            stroke="#fbbf24"
            strokeWidth="1.6"
            strokeLinejoin="round"
            fill="rgba(251,191,36,0.15)"
          />
        </svg>
        <span className="font-mono text-[13px] tracking-tight font-medium">starquake</span>
      </div>

      <div className="h-5 w-px bg-line" />

      <div
        className={`font-mono text-[10.5px] uppercase tracking-[0.12em] px-2 py-1 rounded border ${
          connected
            ? "text-accent bg-accent/10 border-accent/20"
            : "text-muted bg-white/5 border-line"
        }`}
      >
        {connected ? (
          <span className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            live
          </span>
        ) : (
          <span>offline · reconnecting…</span>
        )}
      </div>

      {utcDate && (
        <div className="font-mono text-[11.5px] text-dim hidden md:inline">
          {utcDate} UTC · {totalRepos.toLocaleString()} repos · {totalStars.toLocaleString()} stars today
        </div>
      )}

      <div className="flex-1" />

      <div className="font-mono tabular-nums text-[13px] flex items-center gap-2">
        <span className="text-fg">{clock.local}</span>
        {clock.tz && <span className="text-muted text-[10.5px] uppercase tracking-wider">{clock.tz}</span>}
        <span className="text-line">·</span>
        <span className="text-dim">{clock.utc}</span>
        <span className="text-muted text-[10.5px] uppercase tracking-wider">UTC</span>
      </div>
    </header>
  );
}

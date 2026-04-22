"use client";
import { useEffect, useState } from "react";

type Props = {
  connected: boolean;
  utcDate: string | null;
  totalRepos: number;
  totalStars: number;
};

type Clock = { local: string; utc: string; tz: string };

const REPO = "graykode/starquake";

export function TopBar({ connected, utcDate, totalRepos, totalStars }: Props) {
  const [clock, setClock] = useState<Clock>({ local: "", utc: "", tz: "" });
  const [repoStars, setRepoStars] = useState<number | null>(null);

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

  // Unauthenticated GitHub REST gives 60 req/hr per IP — one call per page
  // load fits comfortably. We render "—" on miss so a rate-limit or offline
  // hit stays silent rather than breaking the header.
  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { stargazers_count?: number } | null) => {
        if (!cancelled && typeof d?.stargazers_count === "number") {
          setRepoStars(d.stargazers_count);
        }
      })
      .catch(() => {
        /* offline or rate-limited — keep null */
      });
    return () => {
      cancelled = true;
    };
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

      <div className="h-5 w-px bg-line" />

      <a
        href={`https://github.com/${REPO}`}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex items-center gap-1.5 font-mono text-[11.5px] text-muted hover:text-fg transition-colors"
        title="star starquake on github"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
        <span className="tabular-nums">
          {repoStars != null ? repoStars.toLocaleString() : "—"}
        </span>
        <span className="hidden lg:inline text-dim group-hover:text-fg">· send a pulse</span>
      </a>
    </header>
  );
}

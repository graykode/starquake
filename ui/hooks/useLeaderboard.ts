"use client";
import { useEffect, useRef, useState } from "react";
import type { Leaderboard, LivePulse, Pulse, ServerMessage, TimeSeriesPoint } from "@/lib/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
const TRACK_TOP_N = 20;
const SERIES_CAP = 720; // ~12 minutes at 1 snapshot/sec
const PULSE_CAP = 40; // most recent N pulses on the globe

export type LeaderboardState = {
  board: Leaderboard | null;
  connected: boolean;
  series: Map<string, TimeSeriesPoint[]>;
  pulses: LivePulse[];
};

export function useLeaderboard(): LeaderboardState {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [connected, setConnected] = useState(false);
  const [series, setSeries] = useState<Map<string, TimeSeriesPoint[]>>(new Map());
  const [pulses, setPulses] = useState<LivePulse[]>([]);
  const seriesRef = useRef(series);
  seriesRef.current = series;

  useEffect(() => {
    let cancelled = false;
    let ws: WebSocket | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let lastUtcDate: string | null = null;

    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data) as ServerMessage;

          if (msg.type === "pulse") {
            const p = msg as Pulse;
            setPulses((prev) => [
              ...prev.slice(-(PULSE_CAP - 1)),
              { lat: p.lat, lng: p.lng, repo: p.repo, actor: p.actor, at: Date.now() },
            ]);
            return;
          }

          if (msg.type !== "leaderboard") return;
          setBoard(msg);

          const now = Date.now();
          const tracked = msg.entries.slice(0, TRACK_TOP_N);
          const dateChanged = lastUtcDate !== null && lastUtcDate !== msg.utc_date;
          lastUtcDate = msg.utc_date;

          setSeries((prev) => {
            const next = dateChanged ? new Map<string, TimeSeriesPoint[]>() : new Map(prev);
            for (const entry of tracked) {
              const existing = next.get(entry.repo) ?? [];
              const lastStars = existing[existing.length - 1]?.stars ?? 0;
              const base = entry.stars < lastStars ? [] : existing;
              const trimmed = base.length >= SERIES_CAP ? base.slice(-(SERIES_CAP - 1)) : base;
              next.set(entry.repo, [...trimmed, { t: now, stars: entry.stars }]);
            }
            return next;
          });
        } catch (err) {
          console.error("ws parse error", err);
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (!cancelled) reconnect = setTimeout(connect, 2000);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnect) clearTimeout(reconnect);
      ws?.close();
    };
  }, []);

  return { board, connected, series, pulses };
}

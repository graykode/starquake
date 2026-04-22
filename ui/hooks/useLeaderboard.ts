"use client";
import { useEffect, useRef, useState } from "react";
import type {
  Leaderboard,
  LiveEvent,
  LivePulse,
  Pulse,
  ServerMessage,
  TimeSeriesPoint,
  WatchEvent,
} from "@/lib/types";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws";
const TRACK_TOP_N = 20;
const SERIES_CAP = 720; // ~12 minutes at 1 snapshot/sec
const PULSE_CAP = 40; // most recent N pulses on the globe
const EVENT_CAP = 30; // rolling event-log buffer size

export type LeaderboardState = {
  board: Leaderboard | null;
  connected: boolean;
  series: Map<string, TimeSeriesPoint[]>;
  pulses: LivePulse[];
  events: LiveEvent[];
};

export function useLeaderboard(enabled: boolean = true): LeaderboardState {
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [connected, setConnected] = useState(false);
  const [series, setSeries] = useState<Map<string, TimeSeriesPoint[]>>(new Map());
  const [pulses, setPulses] = useState<LivePulse[]>([]);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const seriesRef = useRef(series);
  seriesRef.current = series;

  useEffect(() => {
    if (!enabled) {
      // Clear live state and keep the socket closed while in history mode so
      // the past-date view doesn't get a stale "today" board underneath.
      setBoard(null);
      setConnected(false);
      setPulses([]);
      setEvents([]);
      return;
    }

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

          if (msg.type === "watch_event") {
            const w = msg as WatchEvent;
            const parsed = Date.parse(w.at);
            setEvents((prev) => [
              { repo: w.repo, actor: w.actor, at: Number.isFinite(parsed) ? parsed : Date.now() },
              ...prev.slice(0, EVENT_CAP - 1),
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
  }, [enabled]);

  return { board, connected, series, pulses, events };
}

export type Tier = "fresh" | "streak" | "returning";

export type Entry = {
  rank: number;
  repo: string;
  stars: number;
  description?: string | null;
  language?: string | null;
  total_stars?: number | null;
  topics?: string[];
  tier?: Tier;
};

export type Leaderboard = {
  type: "leaderboard";
  utc_date: string;
  generated_at: string;
  total_repos_today: number;
  total_stars_today: number;
  entries: Entry[];
};

export type Pulse = {
  type: "pulse";
  repo: string;
  actor: string;
  lat: number;
  lng: number;
};

export type WatchEvent = {
  type: "watch_event";
  repo: string;
  actor: string;
  at: string;
};

export type ServerMessage = Leaderboard | Pulse | WatchEvent;

export type LiveEvent = { repo: string; actor: string; at: number };

// /history?date=YYYY-MM-DD response. Past dates come from `daily_top`; today
// comes from the live counter — same shape either way so the UI can render
// with one code path.
export type HistoryResponse = {
  utc_date: string;
  entries: Entry[];
};

export type TimeSeriesPoint = { t: number; stars: number };

// UI-side pulse with arrival timestamp — used to rotate them out of the globe.
// `tier` is attached client-side from the current leaderboard (the server's
// pulse message doesn't carry it); absent when the repo isn't in today's top-N.
export type LivePulse = {
  lat: number;
  lng: number;
  repo: string;
  actor: string;
  at: number;
  tier?: Tier;
};

"use client";
import { useEffect, useState } from "react";
import { apiOrigin } from "@/lib/api";
import type { HistoryResponse } from "@/lib/types";

export type HistoryState = {
  board: HistoryResponse | null;
  loading: boolean;
  error: string | null;
};

/// Fetches a static historical leaderboard. `date === null` disables the hook
/// entirely — used when the page is in live mode so we don't make pointless
/// round trips. YYYY-MM-DD format; the server validates.
export function useHistory(date: string | null): HistoryState {
  const [state, setState] = useState<HistoryState>({ board: null, loading: false, error: null });

  useEffect(() => {
    if (!date) {
      setState({ board: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(`${apiOrigin()}/history?date=${encodeURIComponent(date)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`history ${r.status}`);
        return r.json() as Promise<HistoryResponse>;
      })
      .then((data) => {
        if (!cancelled) setState({ board: data, loading: false, error: null });
      })
      .catch((e) => {
        if (!cancelled)
          setState({ board: null, loading: false, error: String(e?.message ?? e) });
      });
    return () => {
      cancelled = true;
    };
  }, [date]);

  return state;
}

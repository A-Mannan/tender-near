import { useCallback, useEffect, useRef, useState } from "react";
import { getJson } from "../lib/api";
import type {
  Facets,
  Health,
  JobsResponse,
  MedianStats,
  SpreadStats,
  TapeResponse,
  WinRateResponse,
} from "../lib/types";

export interface MarketState {
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  lastUpdated: number | null;
  tape: TapeResponse | null;
  median: MedianStats | null;
  spread: SpreadStats | null;
  winRate: WinRateResponse | null;
  jobs: JobsResponse | null;
  facets: Facets | null;
  health: Health | null;
}

const initialState: MarketState = {
  loading: true,
  refreshing: false,
  error: null,
  lastUpdated: null,
  tape: null,
  median: null,
  spread: null,
  winRate: null,
  jobs: null,
  facets: null,
  health: null,
};

const POLL_MS = 8_000;

export function useMarketData() {
  const [state, setState] = useState<MarketState>(initialState);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async (background = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState((current) => ({
      ...current,
      loading: current.lastUpdated === null,
      refreshing: current.lastUpdated !== null,
    }));

    try {
      const [tape, median, spread, winRate, jobs, facets, health] = await Promise.all([
        getJson<TapeResponse>("/tape?limit=200&escrow=near"),
        getJson<MedianStats>("/tape/median?group_by=category"),
        getJson<SpreadStats>("/tape/spread"),
        getJson<WinRateResponse>("/tape/win-rate?limit=12"),
        getJson<JobsResponse>("/jobs?limit=40"),
        getJson<Facets>("/facets"),
        getJson<Health>("/health"),
      ]);
      if (!mounted.current) return;
      setState({
        loading: false,
        refreshing: false,
        error: null,
        lastUpdated: Date.now(),
        tape,
        median,
        spread,
        winRate,
        jobs,
        facets,
        health,
      });
    } catch (error) {
      if (!mounted.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: message,
      }));
    } finally {
      inFlight.current = false;
      if (background) {
        // no-op marker: background polls keep the last good snapshot visible
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(true);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return { state, refresh: () => load(true) };
}

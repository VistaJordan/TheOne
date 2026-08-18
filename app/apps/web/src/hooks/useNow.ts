import { useEffect, useState } from 'react';

/**
 * A ticking "now" for the S5 live countdowns.
 *
 * Every clock on screen shares ONE timer per cadence: a board with forty chips
 * costs a single interval, not forty, and every chip flips its minute on the
 * same frame. Default cadence is 15s — the chips render minute granularity
 * ("1h 12m"), so a faster tick only burns renders and a slower one would leave
 * a minute boundary visibly stale.
 */
const tickers = new Map<number, { id: number; listeners: Set<(now: number) => void> }>();

function subscribe(intervalMs: number, listener: (now: number) => void): () => void {
  let ticker = tickers.get(intervalMs);
  if (!ticker) {
    const listeners = new Set<(now: number) => void>();
    const id = window.setInterval(() => {
      const now = Date.now();
      for (const fn of listeners) fn(now);
    }, intervalMs);
    ticker = { id, listeners };
    tickers.set(intervalMs, ticker);
  }
  ticker.listeners.add(listener);
  return () => {
    const current = tickers.get(intervalMs);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      window.clearInterval(current.id);
      tickers.delete(intervalMs);
    }
  };
}

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribe(intervalMs, setNow), [intervalMs]);
  return now;
}

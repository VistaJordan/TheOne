// S5 — the obligation/notification query family.
//
// There is no cron in the prototype: the engine re-evaluates lazily on the READ
// endpoints (debounced server-side) and after relevant writes. So the web's job
// is (a) to read on a slow interval and (b) to invalidate the moment it writes
// anything that could silence a clock. Both halves live here.

import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ObligationSummary } from '../api/client';
import { getNotifications, getObligations, getPulse } from '../api/client';

/** Every S5 query key, in one place. */
export const OBLIGATION_KEY = ['obligations'] as const;
export const PULSE_KEY = ['pulse'] as const;
export const NOTIFICATIONS_KEY = ['notifications'] as const;

/** The Pulse refreshes itself once a minute — a watchdog that only barks when
    you reload is not a watchdog. Fast enough to feel live, slow enough that a
    demo laptop is not re-evaluating the engine every few seconds. */
export const PULSE_REFRESH_MS = 60_000;

/** Open obligations across every work order. Decoration for the board, so a
    failure degrades to "no chips" rather than an error state on the table. */
export function useOpenObligations() {
  return useQuery({
    queryKey: [...OBLIGATION_KEY, 'open'],
    queryFn: () => getObligations({ state: 'open', limit: 400 }),
    staleTime: 30_000,
    refetchInterval: PULSE_REFRESH_MS,
    retry: 0,
  });
}

export interface ObligationIndex {
  /** Worst open obligation per work order, keyed by BOTH id and wo_number. */
  worstByWo: Map<string, ObligationSummary>;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Fallback source for the board's Clock column: when the list rows do not carry
 * `worst_obligation`, join the open-obligation list onto them client-side. The
 * column is then correct whichever half of the contract shipped first.
 */
export function useObligationIndex(): ObligationIndex {
  const query = useOpenObligations();
  const worstByWo = useMemo(() => {
    const map = new Map<string, ObligationSummary>();
    const items = query.data ?? [];
    for (const ob of items) {
      for (const key of [ob.wo_id, ob.wo_number]) {
        if (!key) continue;
        const current = map.get(key);
        if (!current || rank(ob) > rank(current)) map.set(key, ob);
      }
    }
    return map;
  }, [query.data]);
  return { worstByWo, isLoading: query.isLoading, isError: query.isError };
}

/** Tier-first ordering, deadline second — the index only needs a winner. */
function rank(ob: ObligationSummary): number {
  const due = ob.due_at ? Date.parse(ob.due_at) : NaN;
  return Number(ob.tier ?? 0) * 1e15 - (Number.isNaN(due) ? 0 : due);
}

/** The open obligations for ONE work order (the detail page's rail card). */
export function useWoObligations(woKey: string | undefined) {
  return useQuery({
    queryKey: [...OBLIGATION_KEY, 'wo', woKey ?? ''],
    queryFn: () => getObligations({ wo: woKey as string, state: 'open' }),
    enabled: Boolean(woKey),
    staleTime: 30_000,
    refetchInterval: PULSE_REFRESH_MS,
    retry: 0,
  });
}

/** The three Pulse columns. */
export function usePulse() {
  return useQuery({
    queryKey: PULSE_KEY,
    queryFn: getPulse,
    staleTime: 30_000,
    refetchInterval: PULSE_REFRESH_MS,
    retry: 0,
  });
}

/** The bell. */
export function useNotifications() {
  return useQuery({
    queryKey: NOTIFICATIONS_KEY,
    queryFn: getNotifications,
    staleTime: 30_000,
    refetchInterval: PULSE_REFRESH_MS,
    retry: 0,
  });
}

/**
 * Call after ANY write that can silence, start or escalate a clock — a status
 * change, a comment, a quote transition, a payment request, a snooze. The
 * evaluator has already re-run server-side by the time the response lands; this
 * is what makes the screen agree with it.
 */
export function useInvalidateObligations(): () => void {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: OBLIGATION_KEY });
    void qc.invalidateQueries({ queryKey: PULSE_KEY });
    void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  };
}

// Live updates on an open work order (Elise, 2026-11-02).
//
// The API runs as Vercel functions, which cannot hold a socket open to each
// browser, so the page asks instead: every LIVE_POLL_MS it reads the newest
// change it may see (GET /activity/latest). Every write on a work order logs
// an activity_log row under it, so when that id moves somebody changed
// something: every query of this work order that is on screen reloads through
// its own route — permissions, scope and field redaction decide what comes
// back, exactly as on a refresh.
//
// React Query stops the interval while the tab is in the background and
// refetches on focus, so a hidden tab costs nothing and catches up when it is
// looked at. What a person is typing is never overwritten: inline editors and
// the quote builder keep their own draft while it is unsaved.

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type Query } from '@tanstack/react-query';
import type { ActivityActor } from '@theone/shared';
import { getLatestChange } from '../api/client';

export const LIVE_POLL_MS = 4000;
const NOTE_MS = 6000;

const LATEST_KEY = 'wo-latest-change';

/** Does this cached query belong to the work order (named by id or number
    anywhere in its key)? The poll itself is left out. */
function belongsTo(q: Query, ids: string[]): boolean {
  const key = q.queryKey;
  if (key[0] === LATEST_KEY) return false;
  return key.some((part) => typeof part === 'string' && ids.includes(part));
}

export interface LiveChangeNote {
  actor: ActivityActor | null;
  at: number;
}

/**
 * Polls the work order's newest change and reloads its queries when it moves.
 * Returns who made the last change someone ELSE made (null once it has been
 * shown for a few seconds), for the "Updated by …" note.
 */
export function useWoLiveUpdates(
  woId: string | undefined,
  woNumber: string,
  meIds: (string | undefined)[],
): LiveChangeNote | null {
  const qc = useQueryClient();
  const latest = useQuery({
    queryKey: [LATEST_KEY, woId ?? ''],
    queryFn: () => getLatestChange(woId!),
    enabled: Boolean(woId),
    refetchInterval: LIVE_POLL_MS,
    retry: 0,
  });

  const seen = useRef<{ wo: string; id: number | null } | null>(null);
  const [note, setNote] = useState<LiveChangeNote | null>(null);
  const meKey = meIds.filter(Boolean).join('|');

  const id = latest.data?.id ?? null;
  useEffect(() => {
    if (!woId || !latest.data) return;
    // The first answer for this work order is the baseline, not a change.
    if (!seen.current || seen.current.wo !== woId) {
      seen.current = { wo: woId, id };
      return;
    }
    if (seen.current.id === id) return;
    seen.current = { wo: woId, id };
    // This person's own change: the save already re-read the screen
    // (queryClient's mutation cache), so only the baseline moves.
    const actor = latest.data.actor;
    if (actor && meKey.split('|').includes(actor.id)) return;
    const ids = [woId, woNumber].filter(Boolean);
    void qc.invalidateQueries({ predicate: (q) => belongsTo(q, ids) });
    // The lists that show this row (Work Orders, Approvals, Incoming) reload
    // the next time they are opened.
    void qc.invalidateQueries({ queryKey: ['work-orders'], refetchType: 'none' });
    setNote({ actor, at: Date.now() });
  }, [id, woId, woNumber, latest.data, qc, meKey]);

  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(t);
  }, [note]);

  return note;
}

// Live sync between accounts (migration 0126, Elise 2026-11-05: "I want all
// changes to be synced between all accounts, so when we view the work order
// from multiple accounts we all see the updates directly").
//
// Every write request rings a doorbell on the API (plugins/liveChange.ts),
// tagged with the browser tab that made it (TAB_ID, sent on every request).
// Every signed-in screen asks every APP_POLL_MS whether the bell rang since it
// last looked from ANOTHER tab — another account, the same person's other
// tab, a webhook — or the system wrote something (Ecotrak sync, PM raise,
// rules). When so, every query on screen re-reads through its own route
// (permissions, scope and redaction decide what comes back, as on a refresh);
// the rest are marked stale and re-read when next shown. This tab's own saves
// already re-read it (queryClient's mutation cache), so they do not ring here.
//
// It does not depend on the write logging an audit row. React Query stops the
// interval while the tab is hidden and refetches on focus. What somebody is
// typing is kept: editors hold their own draft, the same as when a save
// re-reads the screen. useWoLiveUpdates still draws the "Updated by …" note.

import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAppLatestChange } from '../api/client';

export const APP_POLL_MS = 3000;

const APP_LATEST_KEY = 'app-latest-change';

export function useAppLiveUpdates(enabled: boolean): void {
  const qc = useQueryClient();
  // The cursor the last answer gave; null until the first one (the baseline).
  const cursor = useRef<string | null>(null);

  useQuery({
    queryKey: [APP_LATEST_KEY],
    queryFn: async () => {
      const after = cursor.current;
      const res = await getAppLatestChange(after);
      cursor.current = res.cursor;
      if (after !== null && res.others) {
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== APP_LATEST_KEY });
      }
      return res;
    },
    enabled,
    refetchInterval: APP_POLL_MS,
    retry: 0,
  });
}

import { MutationCache, QueryClient } from '@tanstack/react-query';

/* 2026-10-28 (Elise: "we have to refresh after each change") · one change
   on a work order touches more than the card that made it: a field save moves
   the record rail, the quote's NTE, the CICO default method; a payment moves
   the approvals and the money card. Each mutation used to invalidate only its
   own keys, so the rest of the page waited for a reload. Now every successful
   mutation also re-reads whatever is on screen (active queries refetch, the
   rest are marked stale and refetch when they are next shown). React Query's
   structural sharing hands back the same objects when nothing changed, so a
   form seeded from a query is not reset by an unrelated refetch.

   A mutation that fires on its own while somebody types (the quote and AI
   draft autosaves), or that changes no record (a preference, a notice read),
   passes `meta: QUIET_MUTATION` and keeps its own narrow invalidation.

   Coming back to the browser tab re-reads the screen too, so a change made by
   somebody else (or in another tab) shows without a reload. */

export const QUIET_MUTATION = { quiet: true } as const;

/** Mutations finishing together (a bulk action, a save then a status move)
    re-read the screen once. */
const SETTLE_MS = 120;
let pending: ReturnType<typeof setTimeout> | null = null;

export const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: true },
  },
  mutationCache: new MutationCache({
    onSuccess: (_data, _vars, _ctx, mutation) => {
      if (mutation.meta?.quiet) return;
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = null;
        void queryClient.invalidateQueries();
      }, SETTLE_MS);
    },
  }),
});

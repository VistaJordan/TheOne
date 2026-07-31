// "Viewing as" — the pre-auth role switcher (S4.1).
//
// Until auth lands (S5) `principal.role` IS the permission, and every gate the
// UI renders (quote edit/approve, payment requests) is resolved SERVER-SIDE
// against X-Actor-Id. So switching the actor has to (a) repin the header for
// every subsequent request and (b) throw away every cached answer, because each
// one embedded the previous actor's permissions.

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PrincipalListItem } from '@theone/shared';
import { getPrincipals } from '../api/client';
import { DEFAULT_ACTOR_NAME, readActorId, roleLabel, writeActorId } from '../lib/actor';

export interface ActorState {
  /** Every human principal, name-ordered. Empty until the query resolves. */
  principals: PrincipalListItem[];
  /** Who the API will attribute requests to; null only before the list loads. */
  acting: PrincipalListItem | null;
  select: (id: string) => void;
}

/**
 * Owns the acting principal. Call ONCE per shell and hand the state to both
 * consumers (the topbar select and the sidebar identity chip) so they can never
 * disagree.
 */
export function useActor(): ActorState {
  const queryClient = useQueryClient();
  const [actorId, setActorId] = useState<string | null>(() => readActorId());

  const { data } = useQuery({
    queryKey: ['principals'],
    queryFn: getPrincipals,
    staleTime: 5 * 60 * 1000,
  });
  const principals = data?.items ?? [];

  /** No pin → the API's own default (Jordan Brown, admin); show the same. */
  const fallback =
    principals.find((p) => p.name === DEFAULT_ACTOR_NAME) ??
    principals.find((p) => p.role === 'admin') ??
    principals[0] ??
    null;
  const matched = actorId ? (principals.find((p) => p.id === actorId) ?? null) : null;

  // A persisted id the CURRENT database does not know (pgdata re-seeded → all
  // new uuids) resolves SILENTLY to the default admin server-side, which would
  // leave this switcher confidently lying about who is acting. Detect it here
  // and fall back to the default explicitly.
  useEffect(() => {
    if (principals.length === 0) return;
    if (actorId && !matched) {
      writeActorId(null);
      setActorId(null);
      void queryClient.invalidateQueries();
    }
  }, [principals.length, actorId, matched, queryClient]);

  const select = (id: string) => {
    if (id === actorId) return;
    writeActorId(id);
    setActorId(id);
    // Every cached payload carries the OLD actor's permissions — drop them all.
    void queryClient.invalidateQueries();
  };

  return { principals, acting: matched ?? fallback, select };
}

/** Compact topbar control, styled with the other black-topbar controls. */
export function ActorSwitcher({ actor }: { actor: ActorState }) {
  const { principals, acting, select } = actor;
  const loading = principals.length === 0;

  return (
    <label className="topbar-actor">
      <span className="topbar-actor-label">Viewing as</span>
      <select
        className="topbar-actor-select"
        aria-label="Viewing as (acting principal)"
        title="Every request is attributed to this principal (X-Actor-Id)"
        value={acting?.id ?? ''}
        disabled={loading}
        onChange={(e) => select(e.target.value)}
      >
        {loading && <option value="">Loading…</option>}
        {principals.map((p) => (
          <option key={p.id} value={p.id}>
            {`${p.name} · ${roleLabel(p.role)}`}
          </option>
        ))}
      </select>
    </label>
  );
}

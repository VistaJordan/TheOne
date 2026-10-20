/* "Viewing as" — S5: real impersonation, super admins only.

   Before auth this was an unguarded dropdown that set an X-Actor-Id header, so
   anyone could act as anyone. It survives because testing the role gates
   (Senior OM builds a quote, ATL approves it) otherwise needs four Microsoft
   accounts — but it is now a server-side, audited, super-admin-only capability.

   Three invariants:
     · the SESSION still belongs to the real human; only the effective role
       changes, never who is signed in.
     · starting and stopping are written to activity_log as their own events.
     · viewing as someone acts as them (0088, replacing W4-2's read-only
       rule): their rights, their scope, their name on what they create — and
       every audit row is signed by the real person with `viewing_as_id`
       naming whom they were viewing as (migration 0088's trigger), so the
       activity log never names the wrong author. */

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getPrincipals } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from './Icon';
import { VIEWING_AS_HINT, roleLabel } from '../lib/actor';

export function ActorSwitcher() {
  const { user, actingAs, isImpersonating, impersonate, stopImpersonating } = useAuth();
  const [busy, setBusy] = useState(false);

  // Non-super-admins never see the control at all: unlike a role-gated action,
  // there is nothing here for them to discover or request.
  if (!user?.is_super_admin) return null;

  return (
    <ImpersonationPicker
      selfId={user.id}
      actingId={actingAs?.id ?? user.id}
      isImpersonating={isImpersonating}
      busy={busy}
      onPick={async (id) => {
        setBusy(true);
        try {
          if (id === user.id) await stopImpersonating();
          else await impersonate(id);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}

function ImpersonationPicker({
  selfId,
  actingId,
  isImpersonating,
  busy,
  onPick,
}: {
  selfId: string;
  actingId: string;
  isImpersonating: boolean;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const principals = useQuery({
    queryKey: ['principals'],
    queryFn: getPrincipals,
    staleTime: 5 * 60 * 1000,
  });

  const items = principals.data?.items ?? [];

  return (
    <label className={`topbar-actor${isImpersonating ? ' is-impersonating' : ''}`}>
      <span className="topbar-actor-label">
        {isImpersonating && <Icon name="swap" size={12} />}
        Viewing as
      </span>
      {isImpersonating && (
        <span className="chip chip-sm" title={VIEWING_AS_HINT}>
          Changes logged as you
        </span>
      )}
      <select
        className="topbar-actor-select"
        aria-label="View as another user (super admin)"
        title={isImpersonating ? VIEWING_AS_HINT : 'Impersonation is recorded in the activity log'}
        value={actingId}
        disabled={busy || principals.isLoading}
        onChange={(e) => onPick(e.target.value)}
      >
        <option value={selfId}>Myself</option>
        {items
          .filter((p) => p.id !== selfId)
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {roleLabel(p.role)}
            </option>
          ))}
      </select>
    </label>
  );
}

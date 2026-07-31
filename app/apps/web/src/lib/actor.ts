// The ACTING PRINCIPAL ("Viewing as") — S4.1.
//
// There is no auth until S5: the API resolves the actor from an optional
// `X-Actor-Id` header and falls back to the seeded Jordan Brown (admin). The
// topbar switcher picks that principal and this module is the one place the
// choice is stored, so the api client and the shell never disagree about who
// is acting.

/** localStorage key holding the acting principal's uuid. */
export const ACTOR_STORAGE_KEY = 'theone.actor';

/** The principal the API falls back to when no header is sent (§5). */
export const DEFAULT_ACTOR_NAME = 'Jordan Brown';

/** The persisted actor id, or null when none is pinned (→ the API default). */
export function readActorId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(ACTOR_STORAGE_KEY);
  } catch {
    return null; // private-mode localStorage — fall back to the API default
  }
}

/** Persist the acting principal; `null` clears the pin. */
export function writeActorId(id: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (id === null) window.localStorage.removeItem(ACTOR_STORAGE_KEY);
    else window.localStorage.setItem(ACTOR_STORAGE_KEY, id);
  } catch {
    /* storage unavailable — the choice still applies for this session */
  }
}

/** `principal.role` is free text in v0; these are the codes the seed writes. */
const ROLE_LABELS: Record<string, string> = {
  om: 'OM',
  senior_om: 'Senior OM',
  atl: 'ATL',
  tl: 'TL',
  am: 'AM',
  admin: 'Admin',
  service: 'Service',
};

/** Display form of a role code; anything unseeded renders verbatim. */
export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role;
}

/** Avatar initials from a display name ("Matt Hammond" → "MH", "Elise" → "E"). */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

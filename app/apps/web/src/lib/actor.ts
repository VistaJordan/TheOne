// Display helpers for a principal.
//
// S5 REMOVED the storage half of this module. It used to persist a chosen
// principal id in localStorage and the api client sent it as `X-Actor-Id` —
// i.e. the browser named its own identity. Identity now lives in an httpOnly
// session cookie and is read from `useAuth()`; what remains here is purely
// presentational and has no bearing on permissions.

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

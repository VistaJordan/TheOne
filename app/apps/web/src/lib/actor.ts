// Display helpers for a principal.
//
// S5 REMOVED the storage half of this module. It used to persist a chosen
// principal id in localStorage and the api client sent it as `X-Actor-Id` —
// i.e. the browser named its own identity. Identity now lives in an httpOnly
// session cookie and is read from `useAuth()`; what remains here is purely
// presentational and has no bearing on permissions.

import type { CSSProperties } from 'react';

/** `principal.role` is free text in v0; these are the codes the seed writes. */
const ROLE_LABELS: Record<string, string> = {
  om: 'OM',
  senior_om: 'Senior OM',
  atl: 'ATL',
  tl: 'TL',
  am: 'AM',
  admin: 'Admin',
  ap: 'AP',
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

/** What the API answers to a write while viewing as (403 IMPERSONATION_READ_ONLY). */
export const READ_ONLY_HINT = 'Viewing as someone is read-only. Switch back to Myself to make changes.';

/** What `downloadLinkProps` puts on the `<a>`: exactly the href (and the title
    and `download` asked for) while live; the inert set while viewing as. */
export type DownloadLinkProps = {
  href?: string;
  title?: string;
  download?: true;
  'aria-disabled'?: true;
  role?: 'link';
  tabIndex?: 0;
  style?: CSSProperties;
  onClick?: (e: { preventDefault(): void }) => void;
};

/** How an inert download link looks, whichever button skin it wears (.tool-btn,
    .btn, .rec-pdf-item — none of which has an [aria-disabled] rule that fits):
    dimmed like `.tool-btn:disabled`, the not-allowed cursor, and pointer events
    kept ON, because messages.css turns them off for every `a.btn[aria-disabled]`
    (a rule written for the Quo tel:/sms: buttons) and that would also stop the
    hover that shows the hint. Opacity and cursor are not colours: no token is
    bypassed. */
const INERT_DOWNLOAD_STYLE: CSSProperties = { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'auto' };

/** The attributes of a download link while viewing as someone (W4-2). The API
    refuses the GETs that log a row under the acting principal — the CSV
    exports and Save as PDF — with a 403, and a plain `<a href download>` would
    make the browser save that JSON error body as the file. So while `readOnly`
    the link has no href and no `download`, is marked aria-disabled as a `link`
    (the state is not valid ARIA on an href-less `<a>` otherwise), keeps a tab
    stop so a keyboard or screen-reader user still reaches the reason, swallows
    the click, carries the hint as its title and wears the inert style above;
    otherwise the attributes are exactly the href, title and `download` given.
    Spread onto the `<a>`; an attribute written after the spread (a menu's
    `role="menuitem"`, its own onClick) wins over the helper's. */
export function downloadLinkProps(
  readOnly: boolean,
  href: string,
  opts: { title?: string; download?: boolean } = {},
): DownloadLinkProps {
  if (!readOnly) {
    const live: DownloadLinkProps = { href };
    if (opts.title !== undefined) live.title = opts.title;
    if (opts.download) live.download = true;
    return live;
  }
  return {
    title: READ_ONLY_HINT,
    'aria-disabled': true,
    role: 'link',
    tabIndex: 0,
    style: INERT_DOWNLOAD_STYLE,
    onClick: (e) => e.preventDefault(),
  };
}

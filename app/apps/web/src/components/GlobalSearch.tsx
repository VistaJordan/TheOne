/* S5 — the topbar's one search field, centred in the bar and pointed at the
   whole product rather than at whatever list happens to be on screen.

   It is a command palette, not a filter: typing looks in four places at once —
   the app's own destinations (Dashboard, Quotes, every Admin section), work
   orders (server-side, the same ILIKE the list page uses), quotes, and — for a
   super admin — people. Picking a result NAVIGATES. The Work Orders list keeps
   its own filter box in its toolbar, because narrowing a table in place is a
   different job from finding a thing anywhere. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listAdminUsers, listQuotes, listWorkOrders } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { useDebounced } from '../hooks/useDebounced';
import { ADMIN_SECTIONS } from '../lib/adminSections';
import { Icon } from './Icon';
import type { IconName } from './Icon';

type Group = 'Pages' | 'Work orders' | 'Quotes' | 'People';

interface Hit {
  key: string;
  group: Group;
  icon: IconName;
  label: string;
  /** Right-hand context line — client, status, role. */
  meta?: string;
  to: string;
}

interface Destination {
  label: string;
  icon: IconName;
  to: string;
  /** Words that should find this page but do not appear in its label. */
  keywords: string;
  /** Super-admin-only destinations stay out of everyone else's results. */
  admin?: boolean;
}

/** Every place the app can actually take you. Mirrors the sidebar (AppShell's
    NAV) plus the Admin sections, so "dashboard", "trash" or "custom fields"
    are all typeable. Inert nav items are deliberately absent — offering a
    destination that goes nowhere is worse than not offering it. */
const DESTINATIONS: Destination[] = [
  {
    label: 'Dashboard',
    icon: 'grid',
    to: '/dashboard',
    keywords: 'home kpis overview pipeline summary',
  },
  { label: 'Work Orders', icon: 'clipboard', to: '/', keywords: 'wo tasks jobs list' },
  { label: 'Quotes', icon: 'file', to: '/quotes', keywords: 'estimates bids proposals' },
  ...ADMIN_SECTIONS.map((sec) => ({
    label: `Admin · ${sec.label}`,
    icon: sec.icon,
    to: sec.to,
    keywords: `admin ${sec.label} settings console studio`,
    admin: true,
  })),
];

const MAX_PER_GROUP = 5;
const GROUP_ORDER: Group[] = ['Pages', 'Work orders', 'Quotes', 'People'];

/** The hint has to name the key the reader actually has under their hand. */
const SHORTCUT_HINT =
  typeof navigator !== 'undefined' && /mac|iphone|ipad/i.test(navigator.userAgent) ? '⌘K' : 'Ctrl K';

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => !!f && f.toLowerCase().includes(q));
}

export function GlobalSearch() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = !!user?.is_super_admin;

  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const term = q.trim();
  // The pages list is local, so it answers on the first keystroke; only the
  // three network-backed groups wait for the typing to settle.
  const debounced = useDebounced(term, 200).toLowerCase();
  const remote = debounced.length >= 2;

  const woQuery = useQuery({
    queryKey: ['search', 'work-orders', debounced],
    queryFn: () => listWorkOrders({ search: debounced, limit: MAX_PER_GROUP }),
    enabled: open && remote,
  });
  // Quotes and people are small, bounded lists with no search parameter of
  // their own — fetch once, keep them warm, and match in the browser.
  const quotesQuery = useQuery({
    queryKey: ['quotes'],
    queryFn: listQuotes,
    enabled: open && remote,
    retry: 0,
    staleTime: 60_000,
  });
  const usersQuery = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: listAdminUsers,
    enabled: open && remote && isAdmin,
    retry: 0,
    staleTime: 60_000,
  });

  const hits = useMemo<Hit[]>(() => {
    const needle = term.toLowerCase();
    if (!needle) return [];

    const pages: Hit[] = DESTINATIONS.filter(
      (d) => (isAdmin || !d.admin) && matches(needle, d.label, d.keywords),
    )
      .slice(0, MAX_PER_GROUP)
      .map((d) => ({
        key: `page:${d.to}`,
        group: 'Pages' as const,
        icon: d.icon,
        label: d.label,
        to: d.to,
      }));

    const workOrders: Hit[] = (woQuery.data?.items ?? []).slice(0, MAX_PER_GROUP).map((w) => ({
      key: `wo:${w.id}`,
      group: 'Work orders' as const,
      icon: 'clipboard' as const,
      label: `${w.wo_number} · ${w.ext_name ?? w.title}`,
      meta: [w.client, w.status?.name].filter(Boolean).join(' · ') || undefined,
      to: `/work-orders/${encodeURIComponent(w.wo_number)}`,
    }));

    const quotes: Hit[] = (quotesQuery.data?.items ?? [])
      .filter((qt) => matches(needle, qt.wo_number, qt.title, qt.client, qt.status))
      .slice(0, MAX_PER_GROUP)
      .map((qt) => ({
        key: `quote:${qt.id}`,
        group: 'Quotes' as const,
        icon: 'file' as const,
        label: `Quote · ${qt.wo_number}${qt.title ? ` — ${qt.title}` : ''}`,
        meta: [qt.client, qt.status].filter(Boolean).join(' · ') || undefined,
        to: `/work-orders/${encodeURIComponent(qt.wo_number)}/quote`,
      }));

    const people: Hit[] = (usersQuery.data?.items ?? [])
      .filter((u) => matches(needle, u.name, u.email, u.role_label))
      .slice(0, MAX_PER_GROUP)
      .map((u) => ({
        key: `user:${u.id}`,
        group: 'People' as const,
        icon: 'user' as const,
        label: u.name,
        meta: [u.role_label, u.email].filter(Boolean).join(' · ') || undefined,
        to: '/admin/users',
      }));

    return [...pages, ...workOrders, ...quotes, ...people];
  }, [term, isAdmin, woQuery.data, quotesQuery.data, usersQuery.data]);

  // A changed result set invalidates whatever row was highlighted.
  useEffect(() => setActive(0), [hits.length, term]);

  // Cmd/Ctrl+K from anywhere. The listener sits on the document because the
  // point of the field is that you never have to reach for it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const go = (hit: Hit) => {
    setOpen(false);
    setQ('');
    inputRef.current?.blur();
    navigate(hit.to);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!hits.length) return;
      e.preventDefault();
      setOpen(true);
      setActive((i) =>
        e.key === 'ArrowDown' ? (i + 1) % hits.length : (i - 1 + hits.length) % hits.length,
      );
      return;
    }
    if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    }
  };

  const loading = remote && (woQuery.isFetching || quotesQuery.isFetching || usersQuery.isFetching);
  const showPanel = open && term.length > 0;
  // Rows are rendered grouped but numbered flat, so ↑/↓ walks the whole list.
  let rendered = -1;

  return (
    <div className="topbar-search" ref={rootRef}>
      <div className="topbar-search-field">
        <span className="topbar-search-icon" aria-hidden="true">
          <Icon name="search" size={14} />
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls="global-search-results"
          aria-autocomplete="list"
          autoComplete="off"
          placeholder="Search work orders, quotes, pages…"
          aria-label="Search everything"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {q ? (
          <button
            type="button"
            className="topbar-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setQ('');
              inputRef.current?.focus();
            }}
          >
            <Icon name="x" size={12} />
          </button>
        ) : (
          <kbd className="topbar-search-kbd" aria-hidden="true">{SHORTCUT_HINT}</kbd>
        )}
      </div>

      {showPanel && (
        <div
          className="gs-panel"
          id="global-search-results"
          role="listbox"
          aria-label="Search results"
        >
          {hits.length === 0 ? (
            <p className="gs-empty">{loading ? 'Searching…' : `Nothing matches “${term}”`}</p>
          ) : (
            GROUP_ORDER.map((group) => {
              const rows = hits.filter((h) => h.group === group);
              if (!rows.length) return null;
              return (
                <div className="gs-group" key={group}>
                  <p className="gs-group-head">{group}</p>
                  {rows.map((hit) => {
                    rendered += 1;
                    const i = rendered;
                    return (
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === active}
                        key={hit.key}
                        className={`gs-hit${i === active ? ' is-active' : ''}`}
                        onMouseEnter={() => setActive(i)}
                        onClick={() => go(hit)}
                      >
                        <span className="gs-hit-icon" aria-hidden="true">
                          <Icon name={hit.icon} size={14} />
                        </span>
                        <span className="gs-hit-label">{hit.label}</span>
                        {hit.meta && <span className="gs-hit-meta">{hit.meta}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })
          )}
          {hits.length > 0 && loading && <p className="gs-foot">Still searching…</p>}
        </div>
      )}
    </div>
  );
}

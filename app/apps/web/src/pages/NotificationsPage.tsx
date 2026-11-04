/* /notifications — everything that happened to the person signed in (Elise,
   2026-11-04). It replaces the bell in the top bar: the sidebar item carries
   the unread count, and this page is where notices are read and kept tidy.

   One inbox over two sources (the API merges them, routes/notices.ts): the
   person's own notices (a work order assigned to them, a mention, a review to
   decide, …) and, for whoever holds the Pulse, its escalation pings.

   Left: every TYPE the person has, grouped (Work orders · Approvals &
   requests · Vendors · Pulse escalations · Other), each with its unread and
   total count — pick a group or one type to track just that. Top: All ·
   Unread · Read, a search, and Mark all read / Mark all unread, which act on
   the type picked (everything when none is). Rows can be ticked to mark
   several at once; each row has its own read / unread toggle, and opening one
   marks it read. The filter lives in the URL, so a view can be bookmarked. */

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  NOTICE_GROUPS,
  kindsInGroup,
  noticeDayBand,
  noticeType,
  type NoticeDayBand,
  type NoticeGroupId,
  type NoticeInboxItem,
  type NoticeReadFilter,
  type NoticeTypeCount,
} from '@theone/shared';
import { getNoticeInbox, markNotices } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { errText } from '../components/ui/Sheet';
import { useNow } from '../hooks/useNow';
import { TIER_LABEL, tierClass, tierOf } from '../lib/obligations';

/** Every inbox query and the sidebar badge sit under this key. */
export const NOTICE_INBOX_KEY = ['notices'] as const;
export const NOTICE_COUNT_KEY = ['notices', 'count'] as const;

const SHOWS: { id: NoticeReadFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'read', label: 'Read' },
];

const BANDS: NoticeDayBand[] = ['Today', 'Yesterday', 'Earlier this week', 'Earlier'];

const rowKey = (n: Pick<NoticeInboxItem, 'source' | 'id'>) => `${n.source}:${n.id}`;

export function NotificationsPage() {
  const qc = useQueryClient();
  const now = useNow(30_000);
  const [sp, setSp] = useSearchParams();
  const show = (SHOWS.find((s) => s.id === sp.get('show'))?.id ?? 'all') as NoticeReadFilter;
  const type = sp.get('type');
  const group = (NOTICE_GROUPS.find((g) => g.id === sp.get('group'))?.id ?? null) as NoticeGroupId | null;
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const setFilter = (next: { show?: NoticeReadFilter; type?: string | null; group?: NoticeGroupId | null }) => {
    const p = new URLSearchParams(sp);
    const put = (k: string, v: string | null | undefined) => (v ? p.set(k, v) : p.delete(k));
    if ('show' in next) put('show', next.show === 'all' ? null : next.show);
    if ('type' in next || 'group' in next) {
      put('type', next.type ?? null);
      put('group', next.group ?? null);
    }
    setSp(p, { replace: true });
    setSelected(new Set());
  };

  // The types the person has come back with every page; the first page's are
  // the ones the rail draws (they do not depend on the filter).
  const [knownTypes, setKnownTypes] = useState<NoticeTypeCount[] | null>(null);
  const kinds = useMemo(() => {
    if (type) return [type];
    if (group) return kindsInGroup(group, (knownTypes ?? []).map((t) => t.kind));
    return null;
  }, [type, group, knownTypes]);
  // A group the person has no type of yet matches nothing — not everything.
  const emptyGroup = group !== null && !type && kinds !== null && kinds.length === 0 && knownTypes !== null;

  const q = useInfiniteQuery({
    queryKey: [...NOTICE_INBOX_KEY, 'inbox', show, kinds, search.trim()],
    queryFn: async ({ pageParam }) => {
      const res = await getNoticeInbox({ show, kinds, q: search, before: pageParam });
      setKnownTypes(res.types);
      return res;
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before,
    enabled: !emptyGroup,
    refetchInterval: 60_000,
    retry: 0,
  });

  const first = q.data?.pages[0];
  const types = first?.types ?? knownTypes ?? [];
  // A group opened from a link waits for the first answer to learn its types.
  const waitingTypes = group !== null && !type && knownTypes === null;
  const items = emptyGroup || waitingTypes ? [] : (q.data?.pages.flatMap((p) => p.items) ?? []);
  const unread = first?.unread ?? 0;
  const total = first?.total ?? 0;

  // Counts for the read-state switch, inside the type picked.
  const scoped = kinds ? types.filter((t) => kinds.includes(t.kind)) : types;
  const scopeTotal = scoped.reduce((n, t) => n + t.total, 0);
  const scopeUnread = scoped.reduce((n, t) => n + t.unread, 0);
  const showCount: Record<NoticeReadFilter, number> = { all: scopeTotal, unread: scopeUnread, read: scopeTotal - scopeUnread };

  const refresh = () => qc.invalidateQueries({ queryKey: NOTICE_INBOX_KEY });
  const mark = useMutation({
    mutationFn: markNotices,
    onSuccess: () => {
      setError(null);
      setSelected(new Set());
    },
    onError: (e) => setError(errText(e, 'Could not update the notifications.')),
    onSettled: refresh,
  });

  const scopeLabel = type ? noticeType(type).label : group ? NOTICE_GROUPS.find((g) => g.id === group)!.label : null;
  const markAll = (read: boolean) => mark.mutate({ read, kinds });
  const selectedItems = items.filter((n) => selected.has(rowKey(n)));
  const toggle = (n: NoticeInboxItem) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(rowKey(n))) next.delete(rowKey(n));
      else next.add(rowKey(n));
      return next;
    });
  const allShownSelected = items.length > 0 && items.every((n) => selected.has(rowKey(n)));

  const bands = useMemo(() => {
    const at = new Date(now);
    const by = new Map<NoticeDayBand, NoticeInboxItem[]>();
    for (const n of items) {
      const b = noticeDayBand(n.created_at, at);
      by.set(b, [...(by.get(b) ?? []), n]);
    }
    return BANDS.filter((b) => by.has(b)).map((b) => ({ band: b, rows: by.get(b)! }));
  }, [items, now]);

  return (
    <AppShell active="Notifications">
      <div className="canvas-inner ntf">
        <div className="vend-head">
          <div className="page-head" style={{ margin: 0 }}>
            <h1 className="page-title">Notifications</h1>
            <p className="ntf-sub">
              {first ? (unread > 0 ? `${unread.toLocaleString('en-US')} unread of ${total.toLocaleString('en-US')}` : total > 0 ? 'All caught up' : 'Nothing yet') : ' '}
            </p>
          </div>
          <div className="ntf-head-actions">
            <button
              type="button"
              className="btn btn-sm"
              disabled={scopeUnread === 0 || mark.isPending}
              onClick={() => markAll(true)}
              title={scopeLabel ? `Every ${scopeLabel} notification` : 'Every notification'}
            >
              <Icon name="check-check" size={12} /> Mark all read
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={scopeTotal - scopeUnread === 0 || mark.isPending}
              onClick={() => markAll(false)}
              title={scopeLabel ? `Every ${scopeLabel} notification` : 'Every notification'}
            >
              <Icon name="circle" size={12} /> Mark all unread
            </button>
          </div>
        </div>

        <div className="ntf-layout">
          <TypeRail types={types} type={type} group={group} total={total} unread={unread} onPick={(t, g) => setFilter({ type: t, group: g })} />

          <section className="ntf-main">
            <div className="ntf-toolbar">
              <div className="seg" role="tablist" aria-label="Read state">
                {SHOWS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={show === s.id}
                    className={`seg-btn${show === s.id ? ' is-on' : ''}`}
                    onClick={() => setFilter({ show: s.id })}
                  >
                    {s.label}
                    <span className="mt-count">{showCount[s.id].toLocaleString('en-US')}</span>
                  </button>
                ))}
              </div>
              <input
                className="fld ntf-search"
                type="search"
                placeholder="Search notifications"
                aria-label="Search notifications"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setSelected(new Set());
                }}
              />
              {scopeLabel && (
                <button type="button" className="chip ntf-scope" onClick={() => setFilter({ type: null, group: null })} title="Show every type">
                  {scopeLabel} <Icon name="x" size={12} />
                </button>
              )}
            </div>

            <div className={`ntf-bulk${selected.size > 0 ? ' is-on' : ''}`}>
              <label className="ntf-check">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  disabled={items.length === 0}
                  onChange={() => setSelected(allShownSelected ? new Set() : new Set(items.map(rowKey)))}
                  aria-label="Select every notification shown"
                />
              </label>
              {selected.size > 0 ? (
                <>
                  <span className="ntf-bulk-n">{selected.size} selected</span>
                  <button type="button" className="btn btn-sm" disabled={mark.isPending || selectedItems.every((n) => n.read)} onClick={() => mark.mutate({ read: true, items: selectedItems.map(({ source, id }) => ({ source, id })) })}>
                    Mark read
                  </button>
                  <button type="button" className="btn btn-sm" disabled={mark.isPending || selectedItems.every((n) => !n.read)} onClick={() => mark.mutate({ read: false, items: selectedItems.map(({ source, id }) => ({ source, id })) })}>
                    Mark unread
                  </button>
                  <button type="button" className="pulse-linkbtn" onClick={() => setSelected(new Set())}>Clear</button>
                </>
              ) : (
                <span className="ntf-bulk-hint">
                  {first ? `${(emptyGroup ? 0 : first.matching).toLocaleString('en-US')} ${first.matching === 1 ? 'notification' : 'notifications'}` : ''}
                </span>
              )}
            </div>

            {error && <div className="ntf-error" role="alert">{error}</div>}

            {q.isError ? (
              <section className="card"><div className="empty-flat">{errText(q.error, 'Could not load your notifications.')}</div></section>
            ) : (q.isLoading && !emptyGroup) || waitingTypes ? (
              <section className="card"><div className="empty-flat">Loading…</div></section>
            ) : items.length === 0 ? (
              <section className="card">
                <div className="empty-flat">
                  {search.trim() ? 'No notification matches the search.' : show === 'unread' ? 'Nothing unread here — all caught up.' : show === 'read' ? 'Nothing read here yet.' : 'No notifications here yet.'}
                </div>
              </section>
            ) : (
              <>
                {bands.map(({ band, rows }) => (
                  <section key={band} className="card ntf-band">
                    <div className="ntf-band-head overline">{band}</div>
                    <ul className="ntf-list">
                      {rows.map((n) => (
                        <NoticeRow
                          key={rowKey(n)}
                          n={n}
                          now={now}
                          selected={selected.has(rowKey(n))}
                          onSelect={() => toggle(n)}
                          onRead={(read) => mark.mutate({ read, items: [{ source: n.source, id: n.id }] })}
                          busy={mark.isPending}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
                {q.hasNextPage && (
                  <div className="ntf-more">
                    <button type="button" className="btn btn-sm" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                      {q.isFetchingNextPage ? 'Loading…' : 'Show older'}
                    </button>
                  </div>
                )}
              </>
            )}
            <p className="ntf-foot">Read notifications are cleared after 60 days; unread ones stay until they are read.</p>
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function TypeRail({ types, type, group, total, unread, onPick }: {
  types: NoticeTypeCount[];
  type: string | null;
  group: NoticeGroupId | null;
  total: number;
  unread: number;
  onPick: (type: string | null, group: NoticeGroupId | null) => void;
}) {
  const groups = NOTICE_GROUPS.map((g) => {
    const rows = types
      .filter((t) => noticeType(t.kind).group === g.id)
      .map((t) => ({ ...t, label: noticeType(t.kind).label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { ...g, rows, total: rows.reduce((n, r) => n + r.total, 0), unread: rows.reduce((n, r) => n + r.unread, 0) };
  }).filter((g) => g.rows.length > 0);

  return (
    <nav className="card ntf-rail" aria-label="Notification types">
      <button type="button" className={`ntf-rail-item is-top${!type && !group ? ' is-on' : ''}`} onClick={() => onPick(null, null)}>
        <Icon name="bell" size={14} />
        <span className="ntf-rail-label">All notifications</span>
        <Counts unread={unread} total={total} />
      </button>
      {groups.length === 0 && <p className="ntf-rail-empty">Types show here as notifications arrive.</p>}
      {groups.map((g) => (
        <div key={g.id} className={`ntf-rail-group ntf-g-${g.id}`}>
          <button type="button" className={`ntf-rail-item is-group${group === g.id && !type ? ' is-on' : ''}`} onClick={() => onPick(null, g.id)}>
            <span className="ntf-swatch" aria-hidden="true" />
            <span className="ntf-rail-label">{g.label}</span>
            <Counts unread={g.unread} total={g.total} />
          </button>
          {g.rows.map((t) => (
            <button key={t.kind} type="button" className={`ntf-rail-item is-type${type === t.kind ? ' is-on' : ''}`} onClick={() => onPick(t.kind, null)}>
              <span className="ntf-rail-label">{t.label}</span>
              <Counts unread={t.unread} total={t.total} />
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}

function Counts({ unread, total }: { unread: number; total: number }) {
  return (
    <span className="ntf-counts">
      {unread > 0 && <span className="ntf-unread-n" title={`${unread} unread`}>{unread > 99 ? '99+' : unread}</span>}
      <span className="ntf-total-n" title={`${total} in all`}>{total.toLocaleString('en-US')}</span>
    </span>
  );
}

function NoticeRow({ n, now, selected, onSelect, onRead, busy }: {
  n: NoticeInboxItem;
  now: number;
  selected: boolean;
  onSelect: () => void;
  onRead: (read: boolean) => void;
  busy: boolean;
}) {
  const t = noticeType(n.kind);
  const tier = n.source === 'pulse' ? tierOf(n) : null;
  const link = n.link && n.link.startsWith('/') ? n.link : null;
  const body = (
    <>
      <span className="ntf-row-top">
        <span className={`ntf-type ntf-g-${t.group}`}>{t.label}</span>
        {n.wo_number && <span className="ntf-wo">{n.wo_number}</span>}
        {tier !== null && <span className={`pulse-row-tier ${tierClass(tier)}`}>{TIER_LABEL[tier]}</span>}
        <time className="ntf-when" dateTime={n.created_at} title={new Date(n.created_at).toLocaleString('en-US')}>
          {timeAgo(n.created_at, now)}
        </time>
      </span>
      <span className="ntf-title">{n.title}</span>
      {n.body && <span className="ntf-body">{n.body}</span>}
      {n.actor && n.actor.kind === 'human' && <span className="ntf-actor">From {n.actor.name}</span>}
    </>
  );
  return (
    <li className={`ntf-row${n.read ? '' : ' is-unread'}${selected ? ' is-selected' : ''}`}>
      <label className="ntf-check">
        <input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select: ${n.title}`} />
      </label>
      <span className="ntf-dot" aria-hidden="true" />
      {/* A real link, so a middle-click or Ctrl-click opens it in a new tab;
          opening a notification marks it read. */}
      {link ? (
        <Link to={link} className="ntf-main-cell" onClick={() => !n.read && onRead(true)} onAuxClick={(e) => e.button === 1 && !n.read && onRead(true)}>
          {body}
        </Link>
      ) : (
        <div className="ntf-main-cell">{body}</div>
      )}
      <button
        type="button"
        className="ntf-toggle"
        disabled={busy}
        onClick={() => onRead(!n.read)}
        title={n.read ? 'Mark as unread' : 'Mark as read'}
        aria-label={n.read ? 'Mark as unread' : 'Mark as read'}
      >
        <Icon name={n.read ? 'circle' : 'check'} size={14} />
      </button>
    </li>
  );
}

/** "just now" / "4m ago" / "3h ago" / "2d ago", then the date. */
function timeAgo(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  const mins = Math.max(0, Math.floor((now - at) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}

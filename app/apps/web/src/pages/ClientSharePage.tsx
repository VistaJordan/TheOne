/* Client Updates (0055) — what the CLIENT opens: /share/client-updates/:token.
 *
 * No sign-in and no app chrome: the token in the address is the whole
 * credential, and the API sends only what the tracker marks "Client sees it"
 * (columns, charts, headline numbers). Every row arrives at once (capped), so
 * the charts, the search and the sorting all work in the browser: a click on
 * a bar narrows the rows, and the other charts recount what is left.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  SUMMARY_TILES,
  formatClientValue,
  type ClientUpdateChartResult,
  type ClientUpdatePublicView,
} from '@theone/shared';
import { ApiRequestError, getPublicClientUpdate, publicClientUpdateCsvUrl } from '../api/client';
import { CuChartGrid, CuTiles, NOT_SET } from '../components/cu/CuInsights';
import { LOGO } from '../lib/brand';

const WHEN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

type Row = ClientUpdatePublicView['rows'][number];

/** Chart buckets recounted over the rows left after every OTHER pick. */
function recount(
  view: ClientUpdatePublicView,
  rowsFor: (except: string) => Row[],
): ClientUpdateChartResult[] {
  return view.charts.map((c) => {
    const rows = rowsFor(c.field);
    const counts = new Map<string | null, number>();
    for (const r of rows) {
      const v = r.facets[c.field] ?? null;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const order = c.buckets.map((b) => b.value);
    const buckets = [...counts.entries()]
      .map(([value, n]) => ({ value, n }))
      .sort((a, b) => {
        const ia = order.indexOf(a.value);
        const ib = order.indexOf(b.value);
        if (c.field === 'age_band' && ia >= 0 && ib >= 0) return ia - ib;
        return b.n - a.n || String(a.value ?? '').localeCompare(String(b.value ?? ''));
      });
    const top = buckets.slice(0, 12);
    const other = buckets.slice(12).reduce((n, b) => n + b.n, 0);
    return { ...c, total: rows.length, buckets: top, other };
  });
}

export function ClientSharePage() {
  const { token = '' } = useParams();
  const q = useQuery({
    queryKey: ['public-client-update', token],
    queryFn: () => getPublicClientUpdate(token),
    retry: 0,
    refetchInterval: 5 * 60 * 1000,
  });
  const view = q.data;

  useEffect(() => {
    const prev = document.title;
    document.title = view ? `${view.client ? `${view.client} · ` : ''}${view.name} — Seamless FM` : 'Work order update — Seamless FM';
    return () => {
      document.title = prev;
    };
  }, [view]);

  if (q.isLoading) {
    return (
      <Shell>
        <p className="cu-pub-state">Loading…</p>
      </Shell>
    );
  }
  if (q.isError || !view) {
    const gone = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <Shell>
        <div className="cu-pub-state">
          <b>{gone ? 'This link is not available.' : 'This page could not be loaded.'}</b>
          <span>
            {gone
              ? 'It may have been turned off or replaced. Ask your Seamless FM contact for a new one.'
              : 'Please try again in a moment.'}
          </span>
        </div>
      </Shell>
    );
  }
  return (
    <Shell>
      <PublicTracker view={view} token={token} />
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="cu-pub">
      <header className="cu-pub-bar">
        <img className="cu-pub-logo" src={LOGO} alt="" />
        <span className="cu-pub-brand">Seamless FM · Work order update</span>
      </header>
      <main className="cu-pub-main">{children}</main>
      <footer className="cu-pub-foot">Read-only view shared by Seamless FM. Questions: reply to our email or contact your account manager.</footer>
    </div>
  );
}

function PublicTracker({ view, token }: { view: ClientUpdatePublicView; token: string }) {
  const [picked, setPicked] = useState<Record<string, string | null>>({});
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ i: number; dir: 1 | -1 } | null>(null);

  const formatted = useMemo(
    () => view.rows.map((r) => r.cells.map((c, i) => formatClientValue(c, view.columns[i].type, view.columns[i].key))),
    [view],
  );

  const needle = search.trim().toLowerCase();
  const matches = (idx: number, except?: string) => {
    const r = view.rows[idx];
    for (const [f, v] of Object.entries(picked)) {
      if (f === except) continue;
      if ((r.facets[f] ?? null) !== v) return false;
    }
    if (needle && !formatted[idx].some((c) => c.toLowerCase().includes(needle))) return false;
    return true;
  };
  const indices = view.rows.map((_, i) => i).filter((i) => matches(i));
  const charts = useMemo(
    () => recount(view, (except) => view.rows.filter((_, i) => matches(i, except))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, picked, needle],
  );

  if (sort) {
    const { i, dir } = sort;
    const numeric = ['money', 'number'].includes(view.columns[i].type);
    indices.sort((a, b) => {
      const x = view.rows[a].cells[i];
      const y = view.rows[b].cells[i];
      if (x === null || x === '') return 1;
      if (y === null || y === '') return -1;
      if (numeric) return (Number(x) - Number(y)) * dir;
      return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
    });
  }

  const groupIndex = view.group_by ? view.columns.findIndex((c) => c.key === view.group_by) : -1;
  const pick = (field: string, value: string | null) =>
    setPicked((p) => {
      const n = { ...p };
      if (field in n && n[field] === value) delete n[field];
      else n[field] = value;
      return n;
    });

  const body: ReactNode[] = [];
  let last: string | undefined;
  for (const idx of indices) {
    if (groupIndex >= 0 && !sort) {
      const g = formatted[idx][groupIndex] || NOT_SET;
      if (g !== last) {
        last = g;
        const count = indices.filter((j) => (formatted[j][groupIndex] || NOT_SET) === g).length;
        body.push(
          <tr key={`g:${g}`} className="cu-group">
            <td colSpan={view.columns.length}>
              <b>{g}</b>
              <span className="cu-group-count">{count}</span>
            </td>
          </tr>,
        );
      }
    }
    body.push(
      <tr key={idx}>
        {formatted[idx].map((c, i) => (
          <td key={i} className={['money', 'number'].includes(view.columns[i].type) ? 'num' : undefined}>
            <span className="cu-cell">{c}</span>
          </td>
        ))}
      </tr>,
    );
  }

  const labelOf = (field: string) => view.charts.find((c) => c.field === field)?.label ?? field;
  const tiles = SUMMARY_TILES.filter((t) => !t.money || view.columns.some((c) => c.key === 'nte'));

  return (
    <>
      <div className="cu-pub-head">
        <div>
          <h1 className="cu-pub-title">{view.client ? `${view.client} · ${view.name}` : view.name}</h1>
          <p className="cu-meta">
            <span>Live as of {WHEN.format(new Date(view.generated_at))} CT</span>
            <span>{view.rows.length} work orders</span>
          </p>
        </div>
        <a className="btn" href={publicClientUpdateCsvUrl(token)}>
          Download spreadsheet
        </a>
      </div>
      {view.intro && <p className="cu-pub-intro">{view.intro}</p>}

      {view.summary && <CuTiles summary={view.summary} tiles={tiles} />}

      <CuChartGrid charts={charts} picked={picked} onPick={pick} />

      <div className="toolbar cu-toolbar">
        <label className="cu-search">
          <input
            type="search"
            placeholder="Search work orders…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search work orders"
          />
        </label>
        {Object.entries(picked).map(([f, v]) => (
          <button key={f} type="button" className="chip chip-accent cu-chip" onClick={() => pick(f, v)}>
            {labelOf(f)}: {v ?? NOT_SET} ×
          </button>
        ))}
        {(Object.keys(picked).length > 0 || needle) && (
          <button type="button" className="linkbtn" onClick={() => { setPicked({}); setSearch(''); }}>
            Show everything
          </button>
        )}
        <span className="hint toolbar-right">
          Showing {indices.length} of {view.rows.length}
        </span>
      </div>

      <div className="table-wrap cu-table-wrap">
        <table className="ct cu-table">
          <thead>
            <tr>
              {view.columns.map((c, i) => (
                <th
                  key={c.key}
                  className={['money', 'number'].includes(c.type) ? 'num' : undefined}
                  aria-sort={sort?.i === i ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
                >
                  <button
                    type="button"
                    className="cu-th"
                    onClick={() => setSort(sort?.i === i ? (sort.dir === 1 ? { i, dir: -1 } : null) : { i, dir: 1 })}
                  >
                    {c.label}
                    {sort?.i === i ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {indices.length === 0 ? (
              <tr className="ct-empty">
                <td colSpan={view.columns.length}>No work orders match.</td>
              </tr>
            ) : (
              body
            )}
          </tbody>
        </table>
      </div>
      {view.truncated && (
        <p className="hint">This page shows the first {view.rows.length} work orders. Download the spreadsheet or ask us for the rest.</p>
      )}
    </>
  );
}

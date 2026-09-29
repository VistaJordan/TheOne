/* Client Updates (0055) — one live tracker per client, instead of a spreadsheet.
 *
 * A tracker is a saved question over the work orders (client + filter +
 * columns + charts). This page answers it live: headline tiles, charts you
 * click to narrow the list, and the list itself, sectioned like the old sheet
 * (by status, by default), with the client-note column typed straight into
 * the row and saved on the work order. Sharing — email from the company
 * address, a schedule, a read-only link — is the Share dialog.
 *
 * Our team's view follows the viewer's own work-order access (rule 8.5); what
 * the client gets is the whole tracker, shared columns only. "Client view"
 * shows those columns and charts here, so nobody has to guess.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  SUMMARY_TILES,
  bucketRule,
  describeSchedule,
  shareLinkLive,
  sharedColumns,
  trackerFilters,
  type ClientUpdate,
  type ClientUpdateChart,
  type ClientUpdateColumn,
  type ClientUpdateInput,
  type ClientUpdateInsights,
  type MailStatus,
  type SummaryTileDef,
  type WoFilterSet,
  type WoSort,
} from '@theone/shared';
import {
  clientUpdateCsvUrl,
  createClientUpdate,
  deleteClientUpdate,
  getClientUpdateInsights,
  getWoFields,
  listClientUpdates,
  listWorkOrders,
  patchWorkOrderFields,
  updateClientUpdate,
  type WoFieldDescriptor,
} from '../api/client';
import type { WoFieldType, WoFilterOp } from '@theone/shared';
import type { WorkOrderListItem } from '@theone/shared';
import { useAuth } from '../auth/AuthProvider';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { StatusPill } from '../components/StatusPill';
import { ListPagination } from '../components/ListPagination';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FilterMenu } from '../components/wo/list/FilterMenu';
import { ToolButton } from '../components/wo/list/Popover';
import { CuChartGrid, CuTiles, NOT_SET } from '../components/cu/CuInsights';
import { TrackerDialog, describeError } from '../components/cu/TrackerDialog';
import { ShareDialog, whenCT } from '../components/cu/ShareDialog';
import { useCanEditField } from '../components/wo/fieldEdit';
import { EMPTY_FILTERS, filterUrl, formatCell, rawCell, sendableFilters } from '../lib/woView';

const PERM = 'client_updates';
const SHARE_PERM = 'client_updates/share';

export function ClientUpdatesPage() {
  const { can } = useAuth();
  const canView = can(PERM, 'view');
  const canCreate = can(PERM, 'create');
  const canEdit = can(PERM, 'edit');
  const canDelete = can(PERM, 'delete');
  const canShare = can(SHARE_PERM, 'edit');
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<'new' | 'edit' | 'share' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({ queryKey: ['client-updates'], queryFn: listClientUpdates, retry: 0, enabled: canView });
  const catalogue = useQuery({ queryKey: ['wo-fields'], queryFn: getWoFields, staleTime: 5 * 60 * 1000, enabled: canView });
  const trackers = list.data?.items ?? [];
  const selectedId = params.get('t');
  const tracker = trackers.find((t) => t.id === selectedId) ?? trackers[0] ?? null;
  const fields = catalogue.data?.fields ?? [];
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const labelOf = (key: string) => byKey.get(key)?.label ?? key.replace(/^fields\./, '');

  const select = (id: string) => setParams({ t: id }, { replace: true });

  const create = useMutation({
    mutationFn: (input: ClientUpdateInput) => createClientUpdate(input),
    onSuccess: ({ item }) => {
      qc.invalidateQueries({ queryKey: ['client-updates'] });
      setDialog(null);
      setError(null);
      select(item.id);
    },
    onError: (e) => setError(describeError(e, 'The tracker did not save')),
  });
  const update = useMutation({
    mutationFn: (input: ClientUpdateInput) => updateClientUpdate(tracker!.id, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-updates'] });
      setDialog(null);
      setError(null);
    },
    onError: (e) => setError(describeError(e, 'The tracker did not save')),
  });
  const remove = useMutation({
    mutationFn: () => deleteClientUpdate(tracker!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['client-updates'] });
      setDialog(null);
      setParams({}, { replace: true });
    },
    onError: (e) => setError(describeError(e, 'The tracker was not deleted')),
  });

  if (!canView) {
    return (
      <AppShell active="Client Updates">
        <div className="wo-state">
          <Icon name="lock" size={22} />
          <b>Client updates are not part of your role.</b>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell active="Client Updates">
      <div className="page-head">
        <h1 className="page-title">Client Updates</h1>
        <p className="page-sub">
          A live tracker for each client, read straight from the work orders. Click a chart to narrow the list, then share
          it by link or email it from {list.data?.mail.from ?? 'contact@seamlessfm.com'}.
        </p>
      </div>

      {list.isError && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} /> {describeError(list.error, 'The trackers could not be loaded')}
        </p>
      )}

      {trackers.length > 0 && (
        <div className="cu-strip">
          <div className="seg cu-trackers" role="tablist" aria-label="Trackers">
            {trackers.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tracker?.id === t.id}
                className={`seg-btn${tracker?.id === t.id ? ' is-on' : ''}`}
                onClick={() => select(t.id)}
                title={t.description ?? undefined}
              >
                {t.client ? <b>{t.client}</b> : null}
                {t.client ? <span className="cu-tab-sep">·</span> : null}
                {t.name}
                {t.schedule?.enabled && <Icon name="clock" size={12} />}
                {t.share.enabled && <Icon name="globe" size={12} />}
              </button>
            ))}
          </div>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => { setError(null); setDialog('new'); }}>
              <Icon name="plus" size={14} /> New tracker
            </button>
          )}
        </div>
      )}

      {list.isLoading && <p className="hint">Loading trackers…</p>}

      {!list.isLoading && trackers.length === 0 && !list.isError && (
        <div className="card cu-empty">
          <Icon name="send" size={22} />
          <b>No client trackers yet</b>
          <span>
            A tracker replaces a client’s tracking sheet: their work orders with the columns you pick, charts you can click,
            and a way to send it to them. It starts with the usual columns (WO #, Dispatcher, WO Mgr, Trade, Asset, Store,
            Location, Rec On, Comp On, Status, NTE, Client Notes).
          </span>
          {canCreate && (
            <button type="button" className="btn btn-primary" onClick={() => setDialog('new')}>
              <Icon name="plus" size={14} /> Create the first tracker
            </button>
          )}
        </div>
      )}

      {tracker && (
        <TrackerView
          key={tracker.id}
          tracker={tracker}
          fields={fields}
          opsByType={catalogue.data?.ops_by_type}
          mail={list.data?.mail}
          labelOf={labelOf}
          canEdit={canEdit}
          canShare={canShare}
          onSettings={() => { setError(null); setDialog('edit'); }}
          onShare={() => setDialog('share')}
          onSaveFilters={(filters) => update.mutate({ name: tracker.name, filters })}
          savingFilters={update.isPending}
        />
      )}

      {dialog === 'new' && (
        <TrackerDialog tracker={null} busy={create.isPending} error={error} onSave={(i) => create.mutate(i)} onClose={() => setDialog(null)} />
      )}
      {dialog === 'edit' && tracker && (
        <TrackerDialog
          tracker={tracker}
          busy={update.isPending}
          error={error}
          onSave={(i) => update.mutate(i)}
          onDelete={canDelete ? () => setDialog('delete') : undefined}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'share' && tracker && (
        <ShareDialog tracker={tracker} mail={list.data?.mail} labelOf={labelOf} onClose={() => setDialog(null)} />
      )}
      {dialog === 'delete' && tracker && (
        <ConfirmDialog
          title="Delete this tracker?"
          message={`“${tracker.client ? `${tracker.client} · ` : ''}${tracker.name}” goes away with its schedule and its client link. The work orders are not touched.`}
          icon="trash"
          confirmLabel="Delete tracker"
          danger
          busy={remove.isPending}
          busyLabel="Deleting…"
          onConfirm={() => remove.mutate()}
          onCancel={() => setDialog('edit')}
        />
      )}
    </AppShell>
  );
}

// ── One tracker ──────────────────────────────────────────────────────────────

const PAGE = 100;

function TrackerView({
  tracker,
  fields,
  opsByType,
  mail,
  labelOf,
  canEdit,
  canShare,
  onSettings,
  onShare,
  onSaveFilters,
  savingFilters,
}: {
  tracker: ClientUpdate;
  fields: WoFieldDescriptor[];
  opsByType: Record<WoFieldType, WoFilterOp[]> | undefined;
  mail: MailStatus | undefined;
  labelOf: (key: string) => string;
  canEdit: boolean;
  canShare: boolean;
  onSettings: () => void;
  onShare: () => void;
  onSaveFilters: (f: WoFilterSet) => void;
  savingFilters: boolean;
}) {
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const savedFiltersJson = JSON.stringify(tracker.filters);
  const [draft, setDraft] = useState<WoFilterSet>(tracker.filters);
  useEffect(() => setDraft(JSON.parse(savedFiltersJson) as WoFilterSet), [savedFiltersJson]);

  const [drill, setDrill] = useState<Record<string, string | null>>({});
  const [tile, setTile] = useState<SummaryTileDef['key'] | null>(null);
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [clientView, setClientView] = useState(false);
  const [sortOverride, setSortOverride] = useState<WoSort | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchText.trim()), 300);
    return () => clearTimeout(t);
  }, [searchText]);
  useEffect(() => setOffset(0), [drill, tile, search, draft]);

  const draftSendable = sendableFilters(draft) ?? EMPTY_FILTERS;
  const filtersDirty = JSON.stringify(draftSendable) !== JSON.stringify(sendableFilters(tracker.filters) ?? EMPTY_FILTERS);
  const base = { client: tracker.client, filters: draftSendable };
  const tileRules = tile ? SUMMARY_TILES.find((t) => t.key === tile)?.rules ?? [] : [];
  const drillRules = Object.entries(drill).map(([f, v]) => bucketRule(f, v));
  const effective = trackerFilters(base, [...drillRules, ...tileRules]);

  const columns: ClientUpdateColumn[] = clientView ? sharedColumns(tracker.columns) : tracker.columns;
  const charts: ClientUpdateChart[] = clientView ? tracker.charts.filter((c) => c.shared) : tracker.charts;
  const teamOnlyCharts = useMemo(() => new Set(tracker.charts.filter((c) => !c.shared).map((c) => c.field)), [tracker.charts]);
  const sort = sortOverride ?? tracker.sort;
  const groupBy = tracker.group_by && (!clientView || columns.some((c) => c.key === tracker.group_by)) ? tracker.group_by : null;

  // Each drilled chart is counted WITHOUT its own pick, so it keeps showing
  // every bar (the picked one lit) and another bar can be chosen.
  const insights = useQuery({
    queryKey: ['cu-insights', tracker.id, effective, charts, drill, tile],
    placeholderData: keepPreviousData,
    retry: 0,
    queryFn: async (): Promise<ClientUpdateInsights> => {
      const plain = charts.filter((c) => !(c.field in drill));
      const drilled = charts.filter((c) => c.field in drill);
      const [main, ...own] = await Promise.all([
        getClientUpdateInsights(effective, plain),
        ...drilled.map((c) =>
          getClientUpdateInsights(
            trackerFilters(base, [
              ...Object.entries(drill).filter(([f]) => f !== c.field).map(([f, v]) => bucketRule(f, v)),
              ...tileRules,
            ]),
            [c],
          ),
        ),
      ]);
      const byField = new Map([...main.charts, ...own.flatMap((o) => o.charts)].map((c) => [c.field, c]));
      return { summary: main.summary, charts: charts.map((c) => byField.get(c.field)).filter((c) => c !== undefined) };
    },
  });

  const listQ = useQuery({
    queryKey: ['cu-list', tracker.id, effective, columns.map((c) => c.key), sort, groupBy, search, offset, limit],
    placeholderData: keepPreviousData,
    retry: 0,
    queryFn: () =>
      listWorkOrders({
        filters: effective,
        columns: columns.map((c) => c.key),
        sort,
        group_by: groupBy,
        search: search || undefined,
        limit,
        offset,
      }),
  });

  const pickBucket = (field: string, value: string | null) =>
    setDrill((d) => {
      const next = { ...d };
      if (field in next && next[field] === value) delete next[field];
      else next[field] = value;
      return next;
    });

  const chips = [
    ...Object.entries(drill).map(([f, v]) => ({
      key: `d:${f}`,
      text: `${labelOf(f)}: ${v ?? NOT_SET}`,
      clear: () => setDrill((d) => { const n = { ...d }; delete n[f]; return n; }),
    })),
    ...(tile ? [{ key: 't', text: SUMMARY_TILES.find((t) => t.key === tile)?.label ?? tile, clear: () => setTile(null) }] : []),
  ];

  const linkLive = shareLinkLive(tracker.share, new Date());
  const total = listQ.data?.total;

  return (
    <>
      <div className="cu-head">
        <div className="cu-head-text">
          <h2 className="cu-title">{tracker.client ? `${tracker.client} · ${tracker.name}` : tracker.name}</h2>
          <p className="cu-meta">
            <span>
              <Icon name="clock" size={12} /> {describeSchedule(tracker.schedule)}
            </span>
            <span>
              <Icon name="send" size={12} /> {tracker.last_sent_at ? `Last sent ${whenCT(tracker.last_sent_at)}` : 'Not sent yet'}
            </span>
            <span className={linkLive ? 'cu-on' : undefined}>
              <Icon name="globe" size={12} /> {linkLive ? 'Client link on' : 'Client link off'}
            </span>
            {mail && !mail.configured && (
              <span className="cu-warn">
                <Icon name="alert-circle" size={12} /> Email not set up
              </span>
            )}
          </p>
          {tracker.description && <p className="hint">{tracker.description}</p>}
        </div>
        <div className="cu-head-actions">
          {canEdit && (
            <button type="button" className="btn btn-ghost" onClick={onSettings}>
              <Icon name="sliders" size={14} /> Settings
            </button>
          )}
          {canShare && (
            <a className="btn btn-ghost" href={clientUpdateCsvUrl(tracker.id)} title="The client's columns, as a spreadsheet">
              <Icon name="download" size={14} /> CSV
            </a>
          )}
          {canShare && (
            <button type="button" className="btn btn-primary" onClick={onShare}>
              <Icon name="send" size={14} /> Share
            </button>
          )}
        </div>
      </div>

      <div className="toolbar cu-toolbar">
        {opsByType && <FilterMenu fields={fields} opsByType={opsByType} value={draft} onChange={setDraft} />}
        {filtersDirty && canEdit && (
          <>
            <ToolButton onClick={() => onSaveFilters(draftSendable)} disabled={savingFilters}>
              <Icon name="check" size={14} /> {savingFilters ? 'Saving…' : 'Save filter to tracker'}
            </ToolButton>
            <ToolButton onClick={() => setDraft(tracker.filters)}>Undo</ToolButton>
          </>
        )}
        <label className="cu-search">
          <Icon name="search" size={14} />
          <input
            type="search"
            placeholder="Find a WO #, store, city…"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Search this tracker"
          />
        </label>
        <div className="toolbar-right">
          <div className="seg" role="group" aria-label="View as">
            <button type="button" className={`seg-btn${clientView ? '' : ' is-on'}`} aria-pressed={!clientView} onClick={() => setClientView(false)}>
              Team view
            </button>
            <button type="button" className={`seg-btn${clientView ? ' is-on' : ''}`} aria-pressed={clientView} onClick={() => setClientView(true)}>
              Client view
            </button>
          </div>
          <Link className="tool-btn" to={filterUrl(effective)} title="Open these work orders in the Work Orders list">
            <Icon name="ext" size={12} /> Work Orders
          </Link>
        </div>
      </div>

      {clientView && (
        <p className="cu-banner is-info" role="status">
          <Icon name="info" size={14} /> Client view: only the columns and charts marked “Client sees it”. The email and
          the link carry the whole tracker; this page still follows your own access.
        </p>
      )}

      <CuTiles
        summary={insights.data?.summary}
        tiles={SUMMARY_TILES}
        active={tile}
        onPick={setTile}
        loading={insights.isFetching}
      />

      {insights.isError && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} /> {describeError(insights.error, 'The charts could not be counted')}
        </p>
      )}

      <CuChartGrid
        charts={insights.data?.charts ?? []}
        picked={drill}
        onPick={pickBucket}
        teamOnly={clientView ? undefined : teamOnlyCharts}
        loading={insights.isFetching}
      />

      {chips.length > 0 && (
        <div className="cu-chips-row" role="group" aria-label="Narrowed by">
          <span className="hint">Narrowed to</span>
          {chips.map((c) => (
            <button key={c.key} type="button" className="chip chip-accent cu-chip" onClick={c.clear} aria-label={`Remove ${c.text}`}>
              {c.text} <Icon name="x" size={12} />
            </button>
          ))}
          <button type="button" className="linkbtn" onClick={() => { setDrill({}); setTile(null); }}>
            Clear all
          </button>
        </div>
      )}

      <CuTable
        items={listQ.data?.items ?? []}
        groups={listQ.data?.groups}
        columns={columns}
        byKey={byKey}
        labelOf={labelOf}
        groupBy={groupBy}
        noteField={tracker.note_field}
        sort={sort}
        onSort={(field) =>
          setSortOverride(sort?.field === field ? { field, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' })
        }
        loading={listQ.isLoading}
        error={listQ.isError ? describeError(listQ.error, 'The work orders could not be loaded') : null}
        showPrivacy={!clientView}
      />
      {total !== undefined && total > 0 && (
        <ListPagination
          total={total}
          offset={offset}
          limit={limit}
          noun="work orders"
          onOffsetChange={setOffset}
          onLimitChange={(n) => { setLimit(n); setOffset(0); }}
        />
      )}
    </>
  );
}

// ── The list ─────────────────────────────────────────────────────────────────

function CuTable({
  items,
  groups,
  columns,
  byKey,
  labelOf,
  groupBy,
  noteField,
  sort,
  onSort,
  loading,
  error,
  showPrivacy,
}: {
  items: WorkOrderListItem[];
  groups: { key: string | null; count: number }[] | undefined;
  columns: ClientUpdateColumn[];
  byKey: Map<string, WoFieldDescriptor>;
  labelOf: (key: string) => string;
  groupBy: string | null;
  noteField: string | null;
  sort: WoSort | null;
  onSort: (field: string) => void;
  loading: boolean;
  error: string | null;
  showPrivacy: boolean;
}) {
  const groupCount = new Map((groups ?? []).map((g) => [g.key, g.count]));
  const rows: ReactNode[] = [];
  let lastGroup: string | null | undefined;
  for (const item of items) {
    if (groupBy) {
      const raw = rawCell(item, groupBy);
      const g = raw === null || raw === '' ? null : String(raw);
      if (g !== lastGroup) {
        lastGroup = g;
        rows.push(
          <tr key={`g:${g ?? ''}:${item.id}`} className="cu-group">
            <td colSpan={columns.length}>
              {groupBy === 'status' && g ? (
                <StatusPill status={{ name: g, color: item.status.color }} />
              ) : (
                <b>{g ? formatCell(g, byKey.get(groupBy)) : NOT_SET}</b>
              )}
              <span className="cu-group-count">{groupCount.get(g) ?? ''}</span>
            </td>
          </tr>,
        );
      }
    }
    rows.push(
      <tr key={item.id}>
        {columns.map((c) => (
          <Cell key={c.key} item={item} col={c} field={byKey.get(c.key)} noteField={noteField} />
        ))}
      </tr>,
    );
  }

  return (
    <div className="table-wrap cu-table-wrap">
      <table className="ct cu-table">
        <thead>
          <tr>
            {columns.map((c) => {
              const f = byKey.get(c.key);
              const sorted = sort?.field === c.key;
              const label = c.label ?? labelOf(c.key);
              return (
                <th key={c.key} className={f?.numeric || f?.type === 'money' ? 'num' : undefined} aria-sort={sorted ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                  {f?.sortable ? (
                    <button type="button" className="cu-th" onClick={() => onSort(c.key)}>
                      {label}
                      {sorted && <Icon name={sort!.dir === 'asc' ? 'chev-u' : 'chev-d'} size={12} />}
                    </button>
                  ) : (
                    <span className="cu-th">{label}</span>
                  )}
                  {showPrivacy && !c.shared && (
                    <span className="cu-lock" title="Team only: the client does not see this column">
                      <Icon name="lock" size={12} />
                    </span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {error && (
            <tr className="ct-empty">
              <td colSpan={columns.length}>{error}</td>
            </tr>
          )}
          {!error && loading && (
            <tr className="ct-empty">
              <td colSpan={columns.length}>Loading…</td>
            </tr>
          )}
          {!error && !loading && items.length === 0 && (
            <tr className="ct-empty">
              <td colSpan={columns.length}>No work orders match.</td>
            </tr>
          )}
          {rows}
        </tbody>
      </table>
    </div>
  );
}

function Cell({
  item,
  col,
  field,
  noteField,
}: {
  item: WorkOrderListItem;
  col: ClientUpdateColumn;
  field: WoFieldDescriptor | undefined;
  noteField: string | null;
}) {
  if (col.key === noteField) return <NoteCell item={item} field={noteField} />;
  if (col.key === 'status') {
    return (
      <td className="col-status">
        <StatusPill status={item.status} />
      </td>
    );
  }
  if (col.key === 'wo_number' || col.key === 'ext_name') {
    const v = rawCell(item, col.key);
    return (
      <td className="col-wo">
        <Link className="wo-num-link" to={`/work-orders/${encodeURIComponent(item.wo_number)}`}>
          {v ? String(v) : item.wo_number}
        </Link>
      </td>
    );
  }
  const text = formatCell(rawCell(item, col.key), field);
  const numeric = field?.numeric || field?.type === 'money';
  return (
    <td className={numeric ? 'num' : undefined} title={text.length > 60 ? text : undefined}>
      <span className="cu-cell">{text}</span>
    </td>
  );
}

/** The client-note column: typed in the row, saved on the work order. */
function NoteCell({ item, field }: { item: WorkOrderListItem; field: string }) {
  const qc = useQueryClient();
  const canEdit = useCanEditField(field);
  const current = (item.custom?.[field] ?? '') as string;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (value: string) => patchWorkOrderFields(item.wo_number, { [field]: value.trim() || null }),
    onSuccess: () => {
      setEditing(false);
      setErr(null);
      qc.invalidateQueries({ queryKey: ['cu-list'] });
    },
    onError: (e) => setErr(describeError(e, 'Not saved')),
  });

  if (!editing) {
    return (
      <td className="cu-note">
        {canEdit ? (
          <button
            type="button"
            className={`cu-note-btn${current ? '' : ' is-empty'}`}
            onClick={() => { setText(current); setEditing(true); }}
            title="Edit the note the client reads"
          >
            {current || 'Add a note'}
            <Icon name="pencil" size={12} />
          </button>
        ) : (
          <span className="cu-cell">{current}</span>
        )}
      </td>
    );
  }
  return (
    <td className="cu-note is-editing">
      <textarea
        className="fld"
        autoFocus
        rows={3}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.mutate(text);
        }}
        aria-label={`Client note for ${item.wo_number}`}
      />
      <div className="cu-note-actions">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => save.mutate(text)} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)} disabled={save.isPending}>
          Cancel
        </button>
        {err && <span className="cu-err">{err}</span>}
      </div>
    </td>
  );
}

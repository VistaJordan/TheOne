import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import type { SavedView } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { WorkOrdersTable } from '../components/WorkOrdersTable';
import { OKnobScrollbar } from '../components/OKnobScrollbar';
import { Icon } from '../components/Icon';
import {
  createSavedView,
  deleteSavedView,
  getUserPref,
  getWoFields,
  listMatchingWorkOrderIds,
  listSavedViews,
  listWorkOrders,
  setUserPref,
  updateSavedView,
  workOrdersExportUrl,
} from '../api/client';
import { ViewBar } from '../components/wo/list/ViewBar';
import { FilterMenu } from '../components/wo/list/FilterMenu';
import { ColumnsMenu } from '../components/wo/list/ColumnsMenu';
import { GroupMenu } from '../components/wo/list/GroupMenu';
import { QuickFilter } from '../components/wo/list/QuickFilter';
import { BulkBar } from '../components/wo/list/BulkBar';
import { ImportDialog } from '../components/wo/list/ImportDialog';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { ToolButton } from '../components/wo/list/Popover';
import { useStatusGroups } from '../lib/statusGroups';
import {
  DEFAULT_VIEW,
  loadStoredView,
  parseFilterParam,
  sameView,
  saveStoredView,
  sendableFilters,
  statusGroupsOf,
  viewOf,
  withStatusGroups,
  type StatusTab,
  type ViewState,
} from '../lib/woView';

// The status tabs come from the live phase-group list (status_group_def) —
// see the `filters` memo in the component; only the All tab is fixed.

/** The chips beside the status tabs: the fields the team narrows by all day.
    `key` is a catalogue key — a promoted column or `fields.<custom key>`. */
const QUICK_FILTERS: { key: string; label: string }[] = [
  // Status leads: unlike the group tabs beside it, this narrows to EXACT
  // statuses ("invoiced", "quote sent"), and it writes the same one rule the
  // Filter menu would.
  { key: 'status', label: 'Status' },
  { key: 'fields.Assignee', label: 'Assignee' },
  { key: 'fields.22. FM', label: 'FM' },
  { key: 'billing_entity', label: 'Comp' },
  { key: 'fields.AM', label: 'AM' },
];

// Pagination is the footer bar (ListPagination); PAGE_SIZES[0] = 25 is the
// default page. Grouping groups the PAGE it loaded — "act on everything that
// matches" is still a separate, explicit request (`/work-orders/ids`).

/** The pinned view (user_pref, so it follows the account across machines):
    its tab leads the strip and the page opens on it. */
const PIN_PREF_KEY = 'wo.views.pinned';

export function WorkOrdersPage() {
  const qc = useQueryClient();

  // A `/?filter=<json>` link (a dashboard Needs Attention card) opens the list
  // on those working filters, beating the restored session and the pinned
  // view — the person clicked the card to see exactly those rows. Read once on
  // mount; the param is stripped from the address bar just below.
  const [searchParams, setSearchParams] = useSearchParams();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only snapshot
  const linkedFilters = useMemo(() => parseFilterParam(searchParams.get('filter')), []);

  // The arrangement on screen, and which saved view it came from. Restored from
  // the last session so a reload does not throw away the columns you set up.
  const stored = useMemo(loadStoredView, []);
  const [view, setView] = useState<ViewState>(
    linkedFilters ? { ...DEFAULT_VIEW, filters: linkedFilters } : (stored?.state ?? DEFAULT_VIEW),
  );
  const [activeViewId, setActiveViewId] = useState<string | null>(
    linkedFilters ? null : (stored?.viewId ?? null),
  );

  // S5 — the "Sort by breach" toggle: worst obligation first, server-ordered
  // across the WHOLE filtered set (not just the loaded page).
  const [byBreach, setByBreach] = useState(false);

  useEffect(() => {
    if (linkedFilters) setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);
  // A saved view opens read-only; the pencil turns this on. Never persisted:
  // a reload lands back in "just looking".
  const [editing, setEditing] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // The view whose deletion is awaiting confirmation, if any.
  const [pendingDelete, setPendingDelete] = useState<SavedView | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);

  useEffect(() => {
    saveStoredView({ viewId: activeViewId, state: view });
  }, [activeViewId, view]);

  const fieldsQuery = useQuery({
    queryKey: ['wo-fields'],
    queryFn: getWoFields,
    // The catalogue changes only when an administrator adds a field, and every
    // menu on the page reads it.
    staleTime: 5 * 60 * 1000,
  });
  const fields = fieldsQuery.data?.fields ?? [];
  const fieldByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const opsByType = fieldsQuery.data?.ops_by_type ?? {
    text: [],
    select: [],
    number: [],
    money: [],
    datetime: [],
    date: [],
    boolean: [],
  };

  const viewsQuery = useQuery({ queryKey: ['saved-views'], queryFn: listSavedViews });
  const views = viewsQuery.data?.items ?? [];
  const activeView = views.find((v) => v.id === activeViewId) ?? null;

  // A saved view that has been deleted elsewhere should not leave the tab strip
  // pointing at nothing.
  useEffect(() => {
    if (activeViewId && viewsQuery.isSuccess && !activeView) setActiveViewId(null);
  }, [activeViewId, activeView, viewsQuery.isSuccess]);

  const dirty = activeView ? !sameView(view, viewOf(activeView)) : !sameView(view, DEFAULT_VIEW);

  // ── The query ──────────────────────────────────────────────────────────────
  // `criteria` is what the list, the id sweep and the CSV export all send, so
  // the three can never disagree about which rows the user is looking at.
  // The status tabs and the quick-filter chips are not separate criteria:
  // they read and write rules inside `view.filters`, so they travel with the
  // view. (Text search is the topbar's job — it searches the whole product.)
  const criteria = useMemo(
    () => ({
      filters: sendableFilters(view.filters),
      sort: view.sort ?? undefined,
      group_by: view.group_by ?? undefined,
      columns: view.columns,
      breach: byBreach || undefined,
    }),
    [view, byBreach],
  );

  // ── The status tabs ────────────────────────────────────────────────────────
  // `groups` is what the working rules say; `lockedGroups` is what the SAVED
  // view says. While just looking, a view's own groups are its identity: the
  // tabs can add to them (Done view + Closed tab = done or closed) but not
  // take them away. In edit mode nothing is locked — that is what edit is for.
  const groups = statusGroupsOf(view.filters);
  const { groups: groupDefs } = useStatusGroups();
  const filters = useMemo<{ key: StatusTab; label: string }[]>(
    () => [{ key: 'all', label: 'All' }, ...groupDefs.map((g) => ({ key: g.code, label: g.label }))],
    [groupDefs],
  );
  const groupOrder = useMemo(() => groupDefs.map((g) => g.code), [groupDefs]);
  const lockedGroups = useMemo<ReadonlySet<StatusGroup>>(
    () =>
      activeView && !editing
        ? (statusGroupsOf(viewOf(activeView).filters) ?? new Set())
        : new Set(),
    [activeView, editing],
  );
  const onStatusTab = (key: StatusTab) => {
    if (key === 'all') {
      setView({ ...view, filters: withStatusGroups(view.filters, [], groupOrder) });
      return;
    }
    if (lockedGroups.has(key)) return;
    const next = new Set(groups ?? lockedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setView({ ...view, filters: withStatusGroups(view.filters, next, groupOrder) });
  };

  // ── Pagination ─────────────────────────────────────────────────────────────
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);

  const woQuery = useQuery({
    queryKey: ['work-orders', criteria, pageSize, offset],
    queryFn: () => listWorkOrders({ ...criteria, limit: pageSize, offset }),
    // A page flip redraws in place instead of flashing the loading row.
    placeholderData: (prev) => prev,
  });

  // S5 — the Clock column rides on the rows themselves (`worst_obligation`,
  // decorated by the API); `breach` in `criteria` is the server-side ordering.
  const items = woQuery.data?.items ?? [];

  const total = woQuery.data?.total;

  // Changing what the list SHOWS must not silently change what a bulk edit will
  // act on — so a new result set drops the selection rather than keeping ids
  // the user can no longer see. New criteria also land back on page 1: keeping
  // an offset into a result set that no longer exists strands the user on an
  // empty page.
  useEffect(() => {
    setSelected(new Set());
    setAllMatchingSelected(false);
    setOffset(0);
  }, [criteria]);

  const selectAllMatching = useMutation({
    mutationFn: () => listMatchingWorkOrderIds(criteria),
    onSuccess: (res) => {
      setSelected(new Set(res.ids));
      setAllMatchingSelected(true);
    },
  });

  // ── Saved views ────────────────────────────────────────────────────────────
  const onSelectView = useCallback((v: SavedView | null) => {
    setViewError(null);
    setActiveViewId(v?.id ?? null);
    setView(v ? viewOf(v) : DEFAULT_VIEW);
    setEditing(false);
  }, []);

  // ── Pinned view ────────────────────────────────────────────────────────────
  // The local value wins the moment the pin is toggled; the server pref is the
  // cross-machine copy (the All-fields order pattern).
  const pinPref = useQuery({
    queryKey: ['user-pref', PIN_PREF_KEY],
    queryFn: () => getUserPref<{ id: string }>(PIN_PREF_KEY),
    staleTime: 5 * 60 * 1000,
  });
  const [localPin, setLocalPin] = useState<string | null | undefined>(undefined);
  const pinnedId = localPin !== undefined ? localPin : (pinPref.data?.value?.id ?? null);

  const togglePin = (v: SavedView) => {
    const next = pinnedId === v.id ? null : v.id;
    setLocalPin(next);
    void setUserPref(PIN_PREF_KEY, next ? { id: next } : null).catch(() => {
      /* a failed pref write only costs cross-machine sync — never block the UI */
    });
  };

  // Opening the page lands on the pinned view — applied ONCE, when the pref
  // and the view list have both arrived. Landing already on it (session
  // restore) keeps any working tweaks, and pinning something mid-session
  // never yanks the current tab away. A filter link already chose what to
  // show, so it counts as applied.
  const pinApplied = useRef(Boolean(linkedFilters));
  useEffect(() => {
    if (pinApplied.current || !pinPref.isSuccess || !viewsQuery.isSuccess) return;
    pinApplied.current = true;
    const id = pinPref.data?.value?.id;
    const pinned = id ? views.find((x) => x.id === id) : undefined;
    if (pinned && activeViewId !== pinned.id) onSelectView(pinned);
  }, [pinPref.isSuccess, pinPref.data, viewsQuery.isSuccess, views, activeViewId, onSelectView]);

  const saveNew = useMutation({
    mutationFn: (input: { name: string; shared: boolean }) =>
      createSavedView({
        name: input.name,
        columns: view.columns,
        filters: view.filters,
        group_by: view.group_by,
        sort: view.sort,
        is_shared: input.shared,
      }),
    onSuccess: ({ view: created }) => {
      setViewError(null);
      // Put the new view in the list before selecting it; otherwise the
      // "unknown id" guard below sees a stale list and bounces back to All.
      qc.setQueryData<{ items: SavedView[] }>(['saved-views'], (old) =>
        old ? { ...old, items: [...old.items, created] } : old,
      );
      setActiveViewId(created.id);
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['saved-views'] });
    },
    onError: (e: Error) => setViewError(e.message || 'Could not save that view'),
  });

  const saveExisting = useMutation({
    mutationFn: () =>
      updateSavedView(activeViewId as string, {
        columns: view.columns,
        filters: view.filters,
        group_by: view.group_by,
        sort: view.sort,
      }),
    onSuccess: () => {
      setViewError(null);
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['saved-views'] });
    },
    onError: (e: Error) => setViewError(e.message || 'Could not save that view'),
  });

  const removeView = useMutation({
    mutationFn: (v: SavedView) => deleteSavedView(v.id),
    onSuccess: () => {
      setViewError(null);
      setActiveViewId(null);
      setView(DEFAULT_VIEW);
      setEditing(false);
      qc.invalidateQueries({ queryKey: ['saved-views'] });
    },
    onError: (e: Error) => setViewError(e.message || 'Could not delete that view'),
  });

  const viewBusy = saveNew.isPending || saveExisting.isPending || removeView.isPending;

  // The scrolling card. Its vertical rail renders at the page edge — where the
  // canvas rail used to sit before the chrome was pinned — not inside the card.
  const cardRef = useRef<HTMLDivElement>(null);

  return (
    <AppShell total={total}>
      {/* The frame fills the canvas cell exactly and hands scrolling to the
          table card (.wo-list in wo-list.css), so the view strip, the toolbar
          and the column headers stay pinned while the rows move. */}
      <div className="wo-list">
        {/* The match count lives on the active view tab (the sidebar badge has
            the unfiltered total; the bulk bar restates the selection). */}
        <ViewBar
          views={views}
          activeId={activeViewId}
          dirty={dirty}
          editing={editing}
          onEdit={() => setEditing(true)}
          onCancelEdit={() => {
            if (activeView) setView(viewOf(activeView));
            setEditing(false);
          }}
          state={view}
          count={total}
          onSelect={onSelectView}
          onSaveNew={(name, shared) => saveNew.mutate({ name, shared })}
          onSaveExisting={() => saveExisting.mutate()}
          onDelete={setPendingDelete}
          onResetToSaved={() => setView(activeView ? viewOf(activeView) : DEFAULT_VIEW)}
          busy={viewBusy}
          error={viewError}
          pinnedId={pinnedId}
          onTogglePin={togglePin}
          actions={
            <>
              {/* The comp's accent CTA leads the cluster. There is no create
                  API or form yet, so like Vendors in the nav it renders inert
                  until that sprint lands. */}
              <button
                type="button"
                className="tool-btn is-primary"
                disabled
                title="Creating work orders in-app is coming — Import a CSV meanwhile"
              >
                <Icon name="plus" size={14} />
                Add work order
              </button>
              <ToolButton onClick={() => setShowImport(true)} title="Import work orders from a CSV">
                <Icon name="upload" size={14} />
                Import
              </ToolButton>
              {/* A real link, so the browser handles the download and the file
                  gets its name from Content-Disposition. */}
              <a
                className="tool-btn"
                href={workOrdersExportUrl(criteria)}
                title="Export the filtered rows, in the columns shown"
              >
                <Icon name="download" size={14} />
                Export
              </a>
            </>
          }
        />

        <div className="toolbar">
          <div className="seg" role="group" aria-label="Status groups">
            {filters.map((f) => {
              const on = f.key === 'all' ? groups?.size === 0 : (groups?.has(f.key) ?? false);
              const locked = f.key !== 'all' && lockedGroups.has(f.key);
              // "All" cannot be honoured without changing a view that is
              // filtered by status, so it is greyed out rather than lying.
              const disabled = f.key === 'all' && lockedGroups.size > 0;
              const title = locked
                ? `Part of the “${activeView?.name}” view — change it under Filter`
                : disabled
                  ? `“${activeView?.name}” is filtered by status — change that under Filter`
                  : undefined;
              return (
                <button
                  type="button"
                  key={f.key}
                  aria-pressed={on}
                  disabled={disabled}
                  title={title}
                  className={`seg-btn${on ? ' is-on' : ''}${locked ? ' is-locked' : ''}`}
                  onClick={() => onStatusTab(f.key)}
                >
                  {f.label}
                  {locked && <Icon name="lock" size={12} />}
                </button>
              );
            })}
          </div>

          <div className="quick-filters" role="group" aria-label="Quick filters">
            {QUICK_FILTERS.map((qf) => (
              <QuickFilter
                key={qf.key}
                field={fieldByKey.get(qf.key)}
                label={qf.label}
                value={view.filters}
                onChange={(filters) => setView({ ...view, filters })}
              />
            ))}
          </div>

          {/* The bulk bar sits right here, beside the status tabs, because that
              is where the eye already is when a selection is made. */}
          {selected.size > 0 ? (
            <BulkBar
              ids={[...selected]}
              matchTotal={total ?? 0}
              allMatchingSelected={allMatchingSelected}
              selectingAll={selectAllMatching.isPending}
              onSelectAllMatching={() => selectAllMatching.mutate()}
              onClear={() => {
                setSelected(new Set());
                setAllMatchingSelected(false);
              }}
              fields={fields}
            />
          ) : (
            <>
              <FilterMenu
                fields={fields}
                opsByType={opsByType}
                value={view.filters}
                onChange={(filters) => setView({ ...view, filters })}
              />
              <GroupMenu
                fields={fields}
                value={view.group_by}
                onChange={(group_by) => setView({ ...view, group_by })}
              />

              <div className="toolbar-right">
                {/* S5 — order by the worst obligation on each work order. */}
                <ToolButton
                  active={byBreach}
                  pressed={byBreach}
                  title="Order by the worst obligation on each work order"
                  onClick={() => setByBreach((v) => !v)}
                >
                  <Icon name="alert" size={12} />
                  Sort by breach
                </ToolButton>
                <ColumnsMenu
                  fields={fields}
                  columns={view.columns}
                  onChange={(columns) => setView({ ...view, columns })}
                />
              </div>
            </>
          )}
        </div>

        <WorkOrdersTable
          items={items}
          columns={view.columns}
          fields={fields}
          loading={woQuery.isLoading || fieldsQuery.isLoading}
          error={
            woQuery.isError
              ? 'Failed to load work orders. Is the API running on :5174?'
              : fieldsQuery.isError
                ? 'Failed to load the field list.'
                : null
          }
          selected={selected}
          onSelectedChange={(next) => {
            setSelected(next);
            setAllMatchingSelected(false);
          }}
          sort={view.sort}
          onSortChange={(sort) => setView({ ...view, sort })}
          groupBy={view.group_by}
          groupCounts={woQuery.data?.groups}
          wrapRef={cardRef}
        />
        <ListPagination
          total={total}
          offset={offset}
          limit={pageSize}
          noun="work orders"
          onOffsetChange={setOffset}
          onLimitChange={(n) => {
            setPageSize(n);
            setOffset(0);
          }}
        />
        {/* The card's vertical O-knob, parked on the page's right edge (the
            spot the canvas rail held before the chrome was pinned). */}
        <OKnobScrollbar scrollRef={cardRef} />
      </div>

      {showImport && <ImportDialog fields={fields} onClose={() => setShowImport(false)} />}

      {pendingDelete && (
        <ConfirmDialog
          title="Delete this view?"
          message={
            <>
              <b>{pendingDelete.name}</b> will be removed
              {pendingDelete.is_shared ? ' for everyone it is shared with' : ''}. The work orders
              themselves are not affected.
            </>
          }
          note="This cannot be undone."
          confirmLabel="Delete view"
          busyLabel="Deleting…"
          danger
          busy={removeView.isPending}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() =>
            removeView.mutate(pendingDelete, { onSettled: () => setPendingDelete(null) })
          }
        />
      )}
    </AppShell>
  );
}

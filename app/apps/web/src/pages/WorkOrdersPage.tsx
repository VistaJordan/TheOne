import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  getWoFields,
  listMatchingWorkOrderIds,
  listSavedViews,
  listWorkOrders,
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
import { ToolButton } from '../components/wo/list/Popover';
import {
  DEFAULT_VIEW,
  loadStoredView,
  sameView,
  saveStoredView,
  sendableFilters,
  statusGroupsOf,
  viewOf,
  withStatusGroups,
  type StatusTab,
  type ViewState,
} from '../lib/woView';

const FILTERS: { key: StatusTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'active', label: 'Active' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
];

/** The chips beside the status tabs: the fields the team narrows by all day.
    `key` is a catalogue key — a promoted column or `fields.<custom key>`. */
const QUICK_FILTERS: { key: string; label: string }[] = [
  { key: 'fields.Assignee', label: 'Assignee' },
  { key: 'fields.22. FM', label: 'FM' },
  { key: 'billing_entity', label: 'Comp' },
  { key: 'fields.AM', label: 'AM' },
];

/** One page holds this many rows. Grouping renders every bucket at once, so it
    is well above a screenful — but not unbounded; "act on everything that
    matches" is a separate, explicit request (`/work-orders/ids`). */
const PAGE_SIZE = 200;

export function WorkOrdersPage() {
  const qc = useQueryClient();

  // The arrangement on screen, and which saved view it came from. Restored from
  // the last session so a reload does not throw away the columns you set up.
  const stored = useMemo(loadStoredView, []);
  const [view, setView] = useState<ViewState>(stored?.state ?? DEFAULT_VIEW);
  const [activeViewId, setActiveViewId] = useState<string | null>(stored?.viewId ?? null);
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
    }),
    [view],
  );

  // ── The status tabs ────────────────────────────────────────────────────────
  // `groups` is what the working rules say; `lockedGroups` is what the SAVED
  // view says. While just looking, a view's own groups are its identity: the
  // tabs can add to them (Done view + Closed tab = done or closed) but not
  // take them away. In edit mode nothing is locked — that is what edit is for.
  const groups = statusGroupsOf(view.filters);
  const lockedGroups = useMemo<ReadonlySet<StatusGroup>>(
    () =>
      activeView && !editing
        ? (statusGroupsOf(viewOf(activeView).filters) ?? new Set())
        : new Set(),
    [activeView, editing],
  );
  const onStatusTab = (key: StatusTab) => {
    if (key === 'all') {
      setView({ ...view, filters: withStatusGroups(view.filters, []) });
      return;
    }
    if (lockedGroups.has(key)) return;
    const next = new Set(groups ?? lockedGroups);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setView({ ...view, filters: withStatusGroups(view.filters, next) });
  };

  const woQuery = useQuery({
    queryKey: ['work-orders', criteria, PAGE_SIZE],
    queryFn: () => listWorkOrders({ ...criteria, limit: PAGE_SIZE }),
  });

  const items = woQuery.data?.items ?? [];
  const total = woQuery.data?.total;

  // Changing what the list SHOWS must not silently change what a bulk edit will
  // act on — so a new result set drops the selection rather than keeping ids
  // the user can no longer see.
  useEffect(() => {
    setSelected(new Set());
    setAllMatchingSelected(false);
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
          actions={
            <>
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
            {FILTERS.map((f) => {
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
        {/* The card's vertical O-knob, parked on the page's right edge (the
            spot the canvas rail held before the chrome was pinned). */}
        <OKnobScrollbar scrollRef={cardRef} />

        {total != null && items.length < total && (
          <p className="table-more">
            Showing {items.length.toLocaleString()} of {total.toLocaleString()}. Narrow the filters
            to see the rest, or export the full set.
          </p>
        )}
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

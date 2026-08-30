import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import type { SavedView } from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { WorkOrdersTable } from '../components/WorkOrdersTable';
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
import { useDebounced } from '../hooks/useDebounced';
import { ViewBar } from '../components/wo/list/ViewBar';
import { FilterMenu } from '../components/wo/list/FilterMenu';
import { ColumnsMenu } from '../components/wo/list/ColumnsMenu';
import { GroupMenu } from '../components/wo/list/GroupMenu';
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

/** One page holds this many rows. Grouping renders every bucket at once, so it
    is well above a screenful — but not unbounded; "act on everything that
    matches" is a separate, explicit request (`/work-orders/ids`). */
const PAGE_SIZE = 200;

export function WorkOrdersPage() {
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);

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
  // The status tabs are not a separate criterion: they read and write a
  // `status_group` rule inside `view.filters`, so they travel with the view.
  const criteria = useMemo(
    () => ({
      search: debouncedSearch || undefined,
      filters: sendableFilters(view.filters),
      sort: view.sort ?? undefined,
      group_by: view.group_by ?? undefined,
      columns: view.columns,
    }),
    [debouncedSearch, view],
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

  return (
    <AppShell total={total}>
      {/* The match count lives on the active view tab (the sidebar badge has the
          unfiltered total; the bulk bar restates the selection). */}
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

        {/* The bulk bar sits right here, beside the status tabs, because that is
            where the eye already is when a selection is made. */}
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

            {/* The topbar field searches the whole product and NAVIGATES, so
                the list keeps a filter of its own: this one narrows the table
                in place, inside whatever status group is selected. */}
            <label className="filter-field">
              <span className="filter-field-icon" aria-hidden="true">
                <Icon name="search" size={14} />
              </span>
              <input
                type="search"
                placeholder="Filter these work orders…"
                aria-label="Filter work orders"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>

            <div className="toolbar-right">
              <ColumnsMenu
                fields={fields}
                columns={view.columns}
                onChange={(columns) => setView({ ...view, columns })}
              />
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
      />

      {total != null && items.length < total && (
        <p className="table-more">
          Showing {items.length.toLocaleString()} of {total.toLocaleString()}. Narrow the filters to
          see the rest, or export the full set.
        </p>
      )}

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

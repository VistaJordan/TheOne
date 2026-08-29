import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { StatusGroup } from '@theone/shared';
import type { SavedView } from '../api/client';
import { AppShell } from '../components/AppShell';
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
  viewOf,
  type ViewState,
} from '../lib/woView';

type Filter = 'all' | StatusGroup;

const FILTERS: { key: Filter; label: string }[] = [
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

  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);

  // The arrangement on screen, and which saved view it came from. Restored from
  // the last session so a reload does not throw away the columns you set up.
  const stored = useMemo(loadStoredView, []);
  const [view, setView] = useState<ViewState>(stored?.state ?? DEFAULT_VIEW);
  const [activeViewId, setActiveViewId] = useState<string | null>(stored?.viewId ?? null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatchingSelected, setAllMatchingSelected] = useState(false);
  const [showImport, setShowImport] = useState(false);
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
  const criteria = useMemo(
    () => ({
      status_group: filter === 'all' ? undefined : filter,
      search: debouncedSearch || undefined,
      filters: sendableFilters(view.filters),
      sort: view.sort ?? undefined,
      group_by: view.group_by ?? undefined,
      columns: view.columns,
    }),
    [filter, debouncedSearch, view],
  );

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
      setActiveViewId(created.id);
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
      qc.invalidateQueries({ queryKey: ['saved-views'] });
    },
    onError: (e: Error) => setViewError(e.message || 'Could not delete that view'),
  });

  const viewBusy = saveNew.isPending || saveExisting.isPending || removeView.isPending;

  return (
    <AppShell total={total}>
      <div className="page-head">
        <p className="page-sub">
          {total != null ? `${total.toLocaleString()} work order${total === 1 ? '' : 's'}` : 'Loading…'}
          {selected.size > 0 && ` · ${selected.size} selected`}
        </p>
      </div>

      <ViewBar
        views={views}
        activeId={activeViewId}
        dirty={dirty}
        state={view}
        onSelect={onSelectView}
        onSaveNew={(name, shared) => saveNew.mutate({ name, shared })}
        onSaveExisting={() => saveExisting.mutate()}
        onDelete={(v) => {
          if (window.confirm(`Delete the view “${v.name}”? This cannot be undone.`)) {
            removeView.mutate(v);
          }
        }}
        onResetToSaved={() => activeView && setView(viewOf(activeView))}
        busy={viewBusy}
        error={viewError}
      />

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by status group">
          {FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
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
    </AppShell>
  );
}

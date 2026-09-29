/* Client Updates (0055) — create or change a tracker.
 *
 * One dialog, four blocks: who it is for (name, client, filter), how the list
 * reads (sections, order, the client-note column), the COLUMNS — each with the
 * header the client reads and a "client sees it" switch — and the charts.
 * Sharing (email, schedule, link) lives in its own dialog: changing who hears
 * from us is a different permission from changing what the tracker shows.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_CLIENT_UPDATE_CHARTS,
  DEFAULT_CLIENT_UPDATE_COLUMNS,
  DEFAULT_NOTE_FIELD,
  MAX_TRACKER_CHARTS,
  MAX_TRACKER_COLUMNS,
  type ClientUpdate,
  type ClientUpdateChart,
  type ClientUpdateColumn,
  type ClientUpdateInput,
  type WoFilterSet,
  type WoSort,
} from '@theone/shared';
import { ApiRequestError, getWoFields, type WoFieldDescriptor } from '../../api/client';
import { Icon } from '../Icon';
import { FieldPicker } from '../wo/list/FieldPicker';
import { FilterMenu } from '../wo/list/FilterMenu';
import { EMPTY_FILTERS, sendableFilters } from '../../lib/woView';

interface Props {
  /** null = a new tracker. */
  tracker: ClientUpdate | null;
  busy: boolean;
  error: string | null;
  onSave: (input: ClientUpdateInput) => void;
  onDelete?: () => void;
  onClose: () => void;
}

export function TrackerDialog({ tracker, busy, error, onSave, onDelete, onClose }: Props) {
  const catalogue = useQuery({ queryKey: ['wo-fields'], queryFn: getWoFields, staleTime: 5 * 60 * 1000 });
  const fields = catalogue.data?.fields ?? [];
  const opsByType = catalogue.data?.ops_by_type;
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const [name, setName] = useState(tracker?.name ?? '');
  const [client, setClient] = useState(tracker?.client ?? '');
  const [description, setDescription] = useState(tracker?.description ?? '');
  const [filters, setFilters] = useState<WoFilterSet>(tracker?.filters ?? EMPTY_FILTERS);
  const [groupBy, setGroupBy] = useState<string>(tracker ? tracker.group_by ?? '' : 'status');
  const [sort, setSort] = useState<WoSort | null>(tracker?.sort ?? { field: 'date_received', dir: 'asc' });
  const [noteField, setNoteField] = useState<string>(tracker ? tracker.note_field ?? '' : DEFAULT_NOTE_FIELD);
  const [columns, setColumns] = useState<ClientUpdateColumn[]>(tracker?.columns ?? DEFAULT_CLIENT_UPDATE_COLUMNS);
  const [charts, setCharts] = useState<ClientUpdateChart[]>(tracker?.charts ?? DEFAULT_CLIENT_UPDATE_CHARTS);
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const clientOptions = byKey.get('client')?.options ?? [];
  const labelOf = (key: string) => byKey.get(key)?.label ?? key.replace(/^fields\./, '');
  const noteChoices = fields.filter(
    (f) => f.key.startsWith('fields.') && f.type === 'text' && !['formula', 'attachment', 'url'].includes(f.subtype ?? ''),
  );
  const groupChoices = fields.filter((f) => f.type === 'select' || f.key === 'status' || f.key === 'location');
  const sortChoices = fields.filter((f) => f.sortable);

  const moveCol = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= columns.length) return;
    const next = columns.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setColumns(next);
  };
  const patchCol = (i: number, patch: Partial<ClientUpdateColumn>) =>
    setColumns(columns.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const addCol = (f: WoFieldDescriptor) => {
    if (columns.some((c) => c.key === f.key) || columns.length >= MAX_TRACKER_COLUMNS) return;
    setColumns([...columns, { key: f.key, label: null, shared: false }]);
  };
  const patchChart = (i: number, patch: Partial<ClientUpdateChart>) =>
    setCharts(charts.map((c, n) => (n === i ? { ...c, ...patch } : c)));
  const moveChart = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= charts.length) return;
    const next = charts.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setCharts(next);
  };

  const submit = () => {
    setLocalError(null);
    const n = name.trim() || (client.trim() ? 'Tracking' : '');
    if (!n) return setLocalError('Give the tracker a name');
    if (columns.length === 0) return setLocalError('Pick at least one column');
    onSave({
      name: n,
      client: client.trim() || null,
      description: description.trim() || null,
      filters: sendableFilters(filters) ?? EMPTY_FILTERS,
      columns,
      charts,
      group_by: groupBy || null,
      sort,
      note_field: noteField || null,
    });
  };

  const sharedCount = columns.filter((c) => c.shared).length;

  return (
    <div className="modal-scrim" onClick={() => !busy && onClose()}>
      <div
        className="modal modal-wide cu-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cu-tracker-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="cu-tracker-title">{tracker ? 'Tracker settings' : 'New client tracker'}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body cu-dialog-body">
          <section className="cu-block">
            <h3 className="cu-block-title">Who it is for</h3>
            <div className="cu-grid">
              <label className="field">
                <span className="lbl">Client</span>
                <input
                  className="fld"
                  list="cu-client-options"
                  value={client}
                  placeholder="Every client (use the filter)"
                  onChange={(e) => setClient(e.target.value)}
                />
                <datalist id="cu-client-options">
                  {clientOptions.map((o) => (
                    <option key={o.value} value={o.value} />
                  ))}
                </datalist>
              </label>
              <label className="field">
                <span className="lbl">Tracker name</span>
                <input
                  className="fld"
                  value={name}
                  placeholder={client ? 'Tracking' : 'e.g. SUN Holdings open work'}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={200}
                />
              </label>
              <label className="field cu-wide">
                <span className="lbl">Note for our team</span>
                <input
                  className="fld"
                  value={description}
                  placeholder="What this tracker is for (the client never sees this)"
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={2000}
                />
              </label>
            </div>
            <div className="cu-filter-row">
              {opsByType ? (
                <FilterMenu fields={fields} opsByType={opsByType} value={filters} onChange={setFilters} />
              ) : (
                <span className="hint">Loading fields…</span>
              )}
              <span className="hint">
                {filters.rules.length === 0
                  ? client
                    ? `Every work order for ${client}. Add a filter to narrow it (a brand, a region, open only…).`
                    : 'No filter yet: pick a client above or add a filter.'
                  : `${filters.rules.length} filter rule${filters.rules.length === 1 ? '' : 's'} on top of the client.`}
              </span>
            </div>
          </section>

          <section className="cu-block">
            <h3 className="cu-block-title">How the list reads</h3>
            <div className="cu-grid cu-grid-3">
              <label className="field">
                <span className="lbl">Sections</span>
                <select className="fld" value={groupBy} onChange={(e) => setGroupBy(e.target.value)}>
                  <option value="">One list</option>
                  {groupChoices.map((f) => (
                    <option key={f.key} value={f.key}>
                      By {f.label.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="lbl">Order</span>
                <div className="cu-inline">
                  <select
                    className="fld"
                    value={sort?.field ?? ''}
                    onChange={(e) => setSort(e.target.value ? { field: e.target.value, dir: sort?.dir ?? 'asc' } : null)}
                  >
                    <option value="">Newest first</option>
                    {sortChoices.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                  {sort && (
                    <select
                      className="fld cu-dir"
                      value={sort.dir}
                      aria-label="Direction"
                      onChange={(e) => setSort({ ...sort, dir: e.target.value as 'asc' | 'desc' })}
                    >
                      <option value="asc">Ascending</option>
                      <option value="desc">Descending</option>
                    </select>
                  )}
                </div>
              </label>
              <label className="field">
                <span className="lbl">Client note column</span>
                <select className="fld" value={noteField} onChange={(e) => setNoteField(e.target.value)}>
                  <option value="">None</option>
                  {noteChoices.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <span className="hint">Typed straight into the row; it is saved on the work order.</span>
              </label>
            </div>
          </section>

          <section className="cu-block">
            <div className="cu-block-head">
              <h3 className="cu-block-title">
                Columns <span className="cu-count">{sharedCount} of {columns.length} shared with the client</span>
              </h3>
              <div className="cu-block-tools">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setColumns(DEFAULT_CLIENT_UPDATE_COLUMNS)}
                  title="WO # · Dispatcher · WO Mgr · Trade · Asset · Store · Location · Rec On · Comp On · Status · NTE · Client Notes"
                >
                  <Icon name="refresh" size={12} /> Standard tracker columns
                </button>
                <FieldPicker
                  fields={fields.filter((f) => !columns.some((c) => c.key === f.key))}
                  label="Add column"
                  icon="plus"
                  onPick={addCol}
                />
              </div>
            </div>
            <ol className="cu-cols">
              {columns.map((c, i) => (
                <li key={c.key} className={`cu-col${c.shared ? '' : ' is-private'}`}>
                  <div className="cu-move">
                    <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => moveCol(i, -1)}>
                      <Icon name="chev-u" size={12} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Move down"
                      disabled={i === columns.length - 1}
                      onClick={() => moveCol(i, 1)}
                    >
                      <Icon name="chev-d" size={12} />
                    </button>
                  </div>
                  <div className="cu-col-name">
                    <input
                      className="fld"
                      value={c.label ?? ''}
                      placeholder={labelOf(c.key)}
                      aria-label={`Header for ${labelOf(c.key)}`}
                      maxLength={80}
                      onChange={(e) => patchCol(i, { label: e.target.value || null })}
                    />
                    <small>{byKey.has(c.key) ? labelOf(c.key) : `${labelOf(c.key)} (not available)`}</small>
                  </div>
                  <label className="sw cu-share-sw">
                    <input type="checkbox" checked={c.shared} onChange={(e) => patchCol(i, { shared: e.target.checked })} />
                    <span className="sw-track" />
                    {c.shared ? 'Client sees it' : 'Team only'}
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove ${labelOf(c.key)}`}
                    onClick={() => setColumns(columns.filter((_, n) => n !== i))}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className="cu-block">
            <div className="cu-block-head">
              <h3 className="cu-block-title">
                Charts <span className="cu-count">{charts.length} of {MAX_TRACKER_CHARTS}</span>
              </h3>
              <div className="cu-block-tools">
                {charts.length < MAX_TRACKER_CHARTS && (
                  <FieldPicker
                    fields={fields.filter(
                      (f) => !charts.some((c) => c.field === f.key) && f.type !== 'number' && f.type !== 'money',
                    )}
                    label="Add chart"
                    icon="plus"
                    onPick={(f) => setCharts([...charts, { field: f.key, kind: 'bar', shared: false }])}
                  />
                )}
              </div>
            </div>
            {charts.length === 0 ? (
              <p className="hint">No charts: the page shows the numbers and the list only.</p>
            ) : (
              <ol className="cu-cols">
                {charts.map((c, i) => (
                  <li key={c.field} className={`cu-col${c.shared ? '' : ' is-private'}`}>
                    <div className="cu-move">
                      <button type="button" className="icon-btn" aria-label="Move up" disabled={i === 0} onClick={() => moveChart(i, -1)}>
                        <Icon name="chev-u" size={12} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="Move down"
                        disabled={i === charts.length - 1}
                        onClick={() => moveChart(i, 1)}
                      >
                        <Icon name="chev-d" size={12} />
                      </button>
                    </div>
                    <div className="cu-col-name">
                      <span className="cu-chart-name">Work orders by {labelOf(c.field).toLowerCase()}</span>
                    </div>
                    <select
                      className="fld cu-kind"
                      value={c.kind}
                      aria-label="Chart type"
                      onChange={(e) => patchChart(i, { kind: e.target.value as ClientUpdateChart['kind'] })}
                    >
                      <option value="bar">Bars</option>
                      <option value="donut">Donut</option>
                    </select>
                    <label className="sw cu-share-sw">
                      <input type="checkbox" checked={c.shared} onChange={(e) => patchChart(i, { shared: e.target.checked })} />
                      <span className="sw-track" />
                      {c.shared ? 'Client sees it' : 'Team only'}
                    </label>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove the ${labelOf(c.field)} chart`}
                      onClick={() => setCharts(charts.filter((_, n) => n !== i))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {(localError || error) && <p className="modal-error">{localError ?? error}</p>}
        </div>

        <div className="modal-foot">
          {onDelete ? (
            <button type="button" className="btn btn-ghost btn-danger" onClick={onDelete} disabled={busy}>
              <Icon name="trash" size={14} /> Delete tracker
            </button>
          ) : (
            <span className="card-meta">Every value is read live from the work orders.</span>
          )}
          <div className="cu-foot-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className={`btn btn-primary${busy ? ' is-busy' : ''}`} onClick={submit} disabled={busy}>
              {busy ? 'Saving…' : tracker ? 'Save changes' : 'Create tracker'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function describeError(e: unknown, fallback: string): string {
  return e instanceof ApiRequestError ? e.message : fallback;
}

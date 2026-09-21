/* One dashboard, drawn (0042).
 *
 * The board asks the API for every card's answer in a single call, so a
 * dashboard of twelve cards is one round trip rather than twelve, and every
 * card on the page is measured at the same instant — two cards that disagree
 * because they were counted seconds apart is a bug people never forgive.
 *
 * Editing is the owner's (or a super admin's). Everyone else reads the same
 * numbers, scoped to their own work orders.
 *
 * 0049 · two more things on the board: a FILTER BAR (client, entity, trade,
 * store, dispatcher) that ANDs into every work-order card like the period
 * does, and the wider card library — a card may ask its question of the
 * invoices, payment requests or vendor bills, be a gauge against a target,
 * re-read itself on a timer, or be plain furniture (text, a picture, a
 * button).
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PERIOD,
  LIVE_DEFAULT_SECONDS,
  PAGE_FILTER_FIELDS,
  PERIOD_LABELS,
  PERIOD_PRESETS,
  SOURCE_FIELDS,
  SOURCE_STATUSES,
  TIME_BUCKETS,
  TIME_BUCKET_LABELS,
  WIDGET_KINDS,
  WIDGET_KIND_LABELS,
  WIDGET_METRICS,
  WIDGET_METRIC_LABELS,
  WIDGET_SOURCES,
  WIDGET_SOURCE_LABELS,
  WIDGET_WIDTHS,
  pageFiltersToSet,
  periodSteps,
  resolvePeriod,
  widgetAsksQuestion,
  widgetIsFigure,
  type Dashboard,
  type DashboardWidget,
  type WidgetConfig,
  type DashboardPeriod,
  type PageFilter,
  type TimeBucket,
  type WidgetKind,
  type WidgetSource,
  type WidgetWidth,
  type WoFilterSet,
} from '@theone/shared';
import {
  ApiRequestError,
  addDashboardWidget,
  deleteDashboardWidget,
  getDashboardData,
  updateDashboard,
  updateDashboardWidget,
} from '../../api/client';
import { Icon } from '../Icon';
import { ConfirmDialog } from '../ConfirmDialog';
import { useWoCatalogue } from '../wo/fieldEdit';
import { WidgetCard } from './WidgetCard';

/** The scope choices the card editor offers. Richer filtering is the saved
    views' job; these three cover what a card is usually about. */
const SCOPES: { id: string; label: string; filters?: WoFilterSet }[] = [
  { id: 'open', label: 'Open work only', filters: { match: 'all', rules: [{ field: 'status_group', op: 'in', value: ['open', 'active'] }] } },
  { id: 'all', label: 'Every work order' },
  { id: 'done', label: 'Finished work only', filters: { match: 'all', rules: [{ field: 'status_group', op: 'in', value: ['done', 'closed'] }] } },
];

function scopeOf(config: WidgetConfig): string {
  const rule = config.filters?.rules?.[0];
  if (!rule || rule.field !== 'status_group') return 'all';
  const v = Array.isArray(rule.value) ? rule.value.map(String) : [];
  if (v.includes('done')) return 'done';
  if (v.includes('open')) return 'open';
  return 'all';
}

export function DashboardBoard({ dashboard }: { dashboard: Dashboard }) {
  const qc = useQueryClient();
  // 0044 · one period for the whole board. A dashboard whose cards each
  // covered a different stretch of time could not be read as a whole.
  const [period, setPeriod] = useState<DashboardPeriod>(DEFAULT_PERIOD);
  const window = useMemo(() => resolvePeriod(period), [period]);
  // 0049 · one filter bar for the whole board, for the same reason.
  const [pageFilters, setPageFilters] = useState<PageFilter[]>([]);
  const filterSet = useMemo(() => pageFiltersToSet(pageFilters), [pageFilters]);
  const [editing, setEditing] = useState<DashboardWidget | 'new' | null>(null);
  const [removing, setRemoving] = useState<DashboardWidget | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A live card asks the board to re-read on its own cadence; the fastest one
  // on the board sets the pace for all of them (one call, one instant).
  const liveEvery = useMemo(() => {
    const secs = dashboard.widgets
      .filter((w) => w.kind === 'live')
      .map((w) => w.config.refresh_seconds ?? LIVE_DEFAULT_SECONDS);
    return secs.length > 0 ? Math.max(5, Math.min(...secs)) * 1000 : false;
  }, [dashboard.widgets]);

  const dataQuery = useQuery({
    queryKey: ['dashboard-data', dashboard.id, window.from, window.to, filterSet],
    queryFn: () => getDashboardData(dashboard.id, { from: window.from, to: window.to }, filterSet),
    staleTime: liveEvery ? 0 : 30_000,
    refetchInterval: liveEvery,
  });

  const byWidget = useMemo(
    () => new Map((dataQuery.data?.results ?? []).map((r) => [r.widget_id, r])),
    [dataQuery.data],
  );

  // A gauge with no target of its own reads against the largest plain
  // figure on the board — "open work inside SLA" against "open work orders".
  const boardMax = useMemo(() => {
    let max = 0;
    for (const w of dashboard.widgets) {
      if (w.kind !== 'number') continue;
      const r = byWidget.get(w.id);
      if (r && !r.error) max = Math.max(max, r.total);
    }
    return max;
  }, [dashboard.widgets, byWidget]);

  const done = () => {
    setError(null);
    setEditing(null);
    setRemoving(null);
    void qc.invalidateQueries({ queryKey: ['dashboards'] });
    void qc.invalidateQueries({ queryKey: ['dashboard-data', dashboard.id] });
  };
  const fail = (err: unknown) =>
    setError(err instanceof ApiRequestError ? err.message : 'That change did not save');

  const remove = useMutation({ mutationFn: deleteDashboardWidget, onSuccess: done, onError: fail });
  const share = useMutation({
    mutationFn: (shared_all: boolean) => updateDashboard(dashboard.id, { shared_all }),
    onSuccess: done,
    onError: fail,
  });

  return (
    <>
      {dashboard.description && <p className="dash-desc">{dashboard.description}</p>}

      <div className="dash-period">
        <div className="seg" role="group" aria-label="Period">
          {PERIOD_PRESETS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={`seg-btn${period.preset === preset ? ' is-on' : ''}`}
              aria-pressed={period.preset === preset}
              onClick={() => setPeriod({ preset, offset: 0 })}
            >
              {PERIOD_LABELS[preset]}
            </button>
          ))}
        </div>
        {periodSteps(period.preset) && (
          <span className="dash-stepper">
            <button
              type="button"
              className="icon-btn"
              aria-label="Earlier"
              onClick={() => setPeriod((p) => ({ ...p, offset: p.offset - 1 }))}
            >
              <Icon name="chev-l" size={14} />
            </button>
            <strong>{window.label}</strong>
            <button
              type="button"
              className="icon-btn"
              aria-label="Later"
              disabled={period.offset >= 0}
              onClick={() => setPeriod((p) => ({ ...p, offset: Math.min(0, p.offset + 1) }))}
            >
              <Icon name="chev-r" size={14} />
            </button>
          </span>
        )}
        {!periodSteps(period.preset) && <span className="card-meta">{window.label}</span>}
      </div>

      <PageFilterBar filters={pageFilters} onChange={setPageFilters} />

      <div className="dash-bar">
        <span className="card-meta">
          {dashboard.shared_all
            ? 'Everyone can see this dashboard'
            : dashboard.shared_roles.length > 0
              ? `Shared with ${dashboard.shared_roles.join(', ')}`
              : 'Only you can see this dashboard'}
          {dashboard.owner && ` · built by ${dashboard.owner.display_name}`}
          {' · '}
          Each card counts the work orders you can see
          {window.from ? ', received in this period' : ''}
          {filterSet ? ', narrowed by the filter bar' : ''}.
          {liveEvery ? ` Re-reads every ${liveEvery / 1000}s.` : ''}
        </span>
        {dashboard.can_edit && (
          <span className="dash-bar-tools">
            <button
              type="button"
              className="btn-sm is-ghost"
              onClick={() => share.mutate(!dashboard.shared_all)}
              disabled={share.isPending}
            >
              {dashboard.shared_all ? 'Make it private' : 'Share with everyone'}
            </button>
            <button type="button" className="btn-sm is-primary" onClick={() => setEditing('new')}>
              <Icon name="plus" size={14} /> Add card
            </button>
          </span>
        )}
      </div>

      {error && (
        <div className="callout" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {dashboard.widgets.length === 0 ? (
        <p className="hint">
          This dashboard has no cards yet.
          {dashboard.can_edit ? ' Add one to get started.' : ''}
        </p>
      ) : (
        <div className="dash-grid">
          {dashboard.widgets.map((w) => (
            <WidgetCard
              key={w.id}
              widget={w}
              result={byWidget.get(w.id)}
              loading={dataQuery.isLoading}
              boardMax={boardMax}
              onEdit={dashboard.can_edit ? () => setEditing(w) : undefined}
              onRemove={dashboard.can_edit ? () => setRemoving(w) : undefined}
            />
          ))}
        </div>
      )}

      {editing && (
        <WidgetDialog
          dashboardId={dashboard.id}
          widget={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={done}
        />
      )}

      {removing && (
        <ConfirmDialog
          title={`Remove "${removing.label}"?`}
          message="The card goes from this dashboard."
          note="The work orders it counted are untouched."
          noteTone="info"
          confirmLabel="Remove card"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={() => remove.mutate(removing.id)}
          busy={remove.isPending}
        />
      )}
    </>
  );
}

/** 0049 · the filter bar. Each field is a select when the catalogue knows
    its values, a text box otherwise; an empty value means "not filtering". */
function PageFilterBar({
  filters,
  onChange,
}: {
  filters: PageFilter[];
  onChange: (next: PageFilter[]) => void;
}) {
  const catalogue = useWoCatalogue();
  const valueOf = (key: string) => filters.find((f) => f.field === key)?.value ?? '';
  const set = (key: string, value: string) => {
    const rest = filters.filter((f) => f.field !== key);
    onChange(value.trim() === '' ? rest : [...rest, { field: key, value }]);
  };
  const active = filters.filter((f) => f.value.trim() !== '').length;

  return (
    <div className="dash-filters" role="group" aria-label="Narrow every card">
      <Icon name="filter" size={14} />
      {PAGE_FILTER_FIELDS.map((f) => {
        const options = catalogue.get(f.key)?.options ?? [];
        const id = `pf-${f.key.replace(/[^a-z0-9]/gi, '-')}`;
        return (
          <label key={f.key} className="dash-filter">
            <span>{f.label}</span>
            {options.length > 0 ? (
              <select id={id} className="fld" value={valueOf(f.key)} onChange={(e) => set(f.key, e.target.value)}>
                <option value="">Any</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
                ))}
              </select>
            ) : (
              <input
                id={id}
                className="fld"
                placeholder="Any"
                value={valueOf(f.key)}
                onChange={(e) => set(f.key, e.target.value)}
              />
            )}
          </label>
        );
      })}
      {active > 0 && (
        <button type="button" className="linkbtn" onClick={() => onChange([])}>
          Clear
        </button>
      )}
    </div>
  );
}

/** Build or edit one card. Every choice is a plain control: what to measure,
    how to cut it, and how to draw it. */
function WidgetDialog({
  dashboardId,
  widget,
  onClose,
  onSaved,
}: {
  dashboardId: string;
  widget: DashboardWidget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const catalogue = useWoCatalogue();
  const fields = useMemo(() => [...catalogue.values()], [catalogue]);
  // Only a number can be totalled or averaged; offering a text field here
  // would produce a card that can only ever say $0.
  const numericFields = useMemo(
    () => fields.filter((f) => f.type === 'money' || f.type === 'number'),
    [fields],
  );
  const groupFields = useMemo(
    () => fields.filter((f) => f.type !== 'number' && f.type !== 'money'),
    [fields],
  );
  // Only a date can be a timeline.
  const dateFields = useMemo(
    () => fields.filter((f) => f.type === 'date' || f.type === 'datetime'),
    [fields],
  );

  const [label, setLabel] = useState(widget?.label ?? '');
  const [kind, setKind] = useState<WidgetKind>(widget?.kind ?? 'number');
  const [source, setSource] = useState<WidgetSource>(widget?.config.source ?? 'work_orders');
  const [metric, setMetric] = useState(widget?.config.metric ?? 'count');
  const [valueField, setValueField] = useState(widget?.config.value_field ?? '');
  const [groupField, setGroupField] = useState(widget?.config.group_field ?? '');
  const [timeField, setTimeField] = useState(widget?.config.time_field ?? 'date_received');
  const [bucket, setBucket] = useState<TimeBucket>(widget?.config.bucket ?? 'month');
  const [scope, setScope] = useState(scopeOf(widget?.config ?? { metric: 'count' }));
  const [statuses, setStatuses] = useState<string[]>(widget?.config.source_status ?? []);
  const [overdue, setOverdue] = useState(Boolean(widget?.config.source_overdue));
  const [target, setTarget] = useState(widget?.config.target ? String(widget.config.target) : '');
  const [refresh, setRefresh] = useState(String(widget?.config.refresh_seconds ?? LIVE_DEFAULT_SECONDS));
  const [text, setText] = useState(widget?.config.text ?? '');
  const [url, setUrl] = useState(widget?.config.url ?? '');
  const [buttonLabel, setButtonLabel] = useState(widget?.config.button_label ?? '');
  const [width, setWidth] = useState<WidgetWidth>(widget?.width ?? 'half');
  const [error, setError] = useState<string | null>(null);

  const asks = widgetAsksQuestion(kind);
  const figure = widgetIsFigure(kind);
  const otherSource = source !== 'work_orders';
  const sourceFields = otherSource ? SOURCE_FIELDS[source] : [];

  const config: WidgetConfig = asks
    ? {
        metric,
        ...(metric === 'count' ? {} : { value_field: valueField }),
        ...(kind === 'line' ? { time_field: timeField, bucket } : {}),
        ...(figure || kind === 'line' ? {} : { group_field: groupField }),
        ...(otherSource
          ? {
              source,
              ...(statuses.length > 0 ? { source_status: statuses } : {}),
              ...(overdue ? { source_overdue: true } : {}),
            }
          : SCOPES.find((s) => s.id === scope)?.filters
            ? { filters: SCOPES.find((s) => s.id === scope)!.filters }
            : {}),
        ...(kind === 'gauge' && Number(target) > 0 ? { target: Number(target) } : {}),
        ...(kind === 'live' ? { refresh_seconds: Math.max(5, Number(refresh) || LIVE_DEFAULT_SECONDS) } : {}),
      }
    : {
        metric: 'count',
        ...(kind === 'narrative' ? { text } : {}),
        ...(kind === 'image' || kind === 'link' ? { url } : {}),
        ...(kind === 'link' ? { button_label: buttonLabel } : {}),
      };

  const missing =
    label.trim() === ''
      ? 'a name'
      : kind === 'narrative' && text.trim() === ''
        ? 'some text'
        : (kind === 'image' || kind === 'link') && url.trim() === ''
          ? 'a URL'
          : asks && metric !== 'count' && !valueField
            ? 'a field to total'
            : asks && kind === 'line' && !timeField
              ? 'a date to run along'
              : asks && !figure && kind !== 'line' && !groupField
                ? 'a field to group by'
                : null;

  const save = useMutation({
    mutationFn: () =>
      widget
        ? updateDashboardWidget(widget.id, { kind, label: label.trim(), config, width })
        : addDashboardWidget(dashboardId, { kind, label: label.trim(), config, width }),
    onSuccess: onSaved,
    onError: (err: unknown) =>
      setError(err instanceof ApiRequestError ? err.message : 'The card did not save'),
  });

  // Switching source clears field picks that belong to the other vocabulary.
  const pickSource = (next: WidgetSource) => {
    setSource(next);
    setValueField('');
    setGroupField('');
    setTimeField(next === 'work_orders' ? 'date_received' : 'created_at');
    setStatuses([]);
    setOverdue(false);
  };

  const fieldOptions = (type: 'number' | 'text' | 'date') =>
    otherSource
      ? sourceFields.filter((f) => f.type === type).map((f) => ({ key: f.key, label: f.label }))
      : (type === 'number' ? numericFields : type === 'date' ? dateFields : groupFields).map((f) => ({
          key: f.key,
          label: f.label,
        }));

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={widget ? 'Edit card' : 'Add card'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>{widget ? 'Edit card' : 'Add card'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="intake-grid">
            <div className="field intake-wide">
              <label className="lbl" htmlFor="w-label">What is this card called?</label>
              <input id="w-label" className="fld" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>

            <div className="field">
              <label className="lbl" htmlFor="w-kind">How should it look?</label>
              <select id="w-kind" className="fld" value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
                {WIDGET_KINDS.map((k) => (
                  <option key={k} value={k}>{WIDGET_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>

            {asks && (
              <div className="field">
                <label className="lbl" htmlFor="w-source">Asked of</label>
                <select id="w-source" className="fld" value={source} onChange={(e) => pickSource(e.target.value as WidgetSource)}>
                  {WIDGET_SOURCES.map((s) => (
                    <option key={s} value={s}>{WIDGET_SOURCE_LABELS[s]}</option>
                  ))}
                </select>
              </div>
            )}

            {asks && (
              <div className="field">
                <label className="lbl" htmlFor="w-metric">What does it measure?</label>
                <select
                  id="w-metric"
                  className="fld"
                  value={metric}
                  onChange={(e) => setMetric(e.target.value as typeof metric)}
                >
                  {WIDGET_METRICS.map((m) => (
                    <option key={m} value={m}>
                      {m === 'count' ? `How many ${WIDGET_SOURCE_LABELS[source].toLowerCase()}` : WIDGET_METRIC_LABELS[m]}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {asks && metric !== 'count' && (
              <div className="field">
                <label className="lbl" htmlFor="w-value">Which number?</label>
                <select id="w-value" className="fld" value={valueField} onChange={(e) => setValueField(e.target.value)}>
                  <option value="">Pick a field</option>
                  {fieldOptions('number').map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
            )}

            {asks && kind === 'line' && (
              <>
                <div className="field">
                  <label className="lbl" htmlFor="w-time">Along which date?</label>
                  <select id="w-time" className="fld" value={timeField} onChange={(e) => setTimeField(e.target.value)}>
                    <option value="">Pick a date field</option>
                    {fieldOptions('date').map((f) => (
                      <option key={f.key} value={f.key}>{f.label}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label className="lbl" htmlFor="w-bucket">Grouped</label>
                  <select
                    id="w-bucket"
                    className="fld"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value as TimeBucket)}
                  >
                    {TIME_BUCKETS.map((b) => (
                      <option key={b} value={b}>{TIME_BUCKET_LABELS[b]}</option>
                    ))}
                  </select>
                </div>
              </>
            )}

            {asks && !figure && kind !== 'line' && (
              <div className="field">
                <label className="lbl" htmlFor="w-group">Cut it by</label>
                <select id="w-group" className="fld" value={groupField} onChange={(e) => setGroupField(e.target.value)}>
                  <option value="">Pick a field</option>
                  {fieldOptions('text').map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
            )}

            {asks && !otherSource && (
              <div className="field">
                <label className="lbl" htmlFor="w-scope">Which work orders?</label>
                <select id="w-scope" className="fld" value={scope} onChange={(e) => setScope(e.target.value)}>
                  {SCOPES.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
            )}

            {asks && otherSource && (
              <div className="field intake-wide">
                <span className="lbl">Only these statuses (none = all)</span>
                <div className="dash-status-picks">
                  {SOURCE_STATUSES[source].map((s) => (
                    <label key={s} className="ck">
                      <input
                        type="checkbox"
                        checked={statuses.includes(s)}
                        onChange={(e) =>
                          setStatuses(e.target.checked ? [...statuses, s] : statuses.filter((x) => x !== s))
                        }
                      />
                      <span>{s.replace(/_/g, ' ')}</span>
                    </label>
                  ))}
                  {source !== 'payments' && (
                    <label className="ck">
                      <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} />
                      <span>past due only</span>
                    </label>
                  )}
                </div>
              </div>
            )}

            {kind === 'gauge' && (
              <div className="field">
                <label className="lbl" htmlFor="w-target">Read against (target)</label>
                <input
                  id="w-target"
                  className="fld"
                  inputMode="decimal"
                  placeholder="Largest figure on the board"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </div>
            )}

            {kind === 'live' && (
              <div className="field">
                <label className="lbl" htmlFor="w-refresh">Re-read every (seconds)</label>
                <input
                  id="w-refresh"
                  className="fld"
                  inputMode="numeric"
                  value={refresh}
                  onChange={(e) => setRefresh(e.target.value)}
                />
              </div>
            )}

            {kind === 'narrative' && (
              <div className="field intake-wide">
                <label className="lbl" htmlFor="w-text">The text</label>
                <textarea id="w-text" className="fld" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
              </div>
            )}

            {(kind === 'image' || kind === 'link') && (
              <div className="field intake-wide">
                <label className="lbl" htmlFor="w-url">{kind === 'image' ? 'Picture URL' : 'Where the button goes'}</label>
                <input
                  id="w-url"
                  className="fld"
                  placeholder={kind === 'image' ? 'https://…/floor-plan.png' : '/?filter=… or https://…'}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
            )}

            {kind === 'link' && (
              <div className="field">
                <label className="lbl" htmlFor="w-btn">Button reads</label>
                <input id="w-btn" className="fld" placeholder="Open the list" value={buttonLabel} onChange={(e) => setButtonLabel(e.target.value)} />
              </div>
            )}

            <div className="field">
              <label className="lbl" htmlFor="w-width">How wide?</label>
              <select id="w-width" className="fld" value={width} onChange={(e) => setWidth(e.target.value as WidgetWidth)}>
                {WIDGET_WIDTHS.map((w) => (
                  <option key={w} value={w}>{w === 'quarter' ? 'A quarter' : w === 'half' ? 'Half' : 'Full width'}</option>
                ))}
              </select>
            </div>
          </div>

          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <span className="card-meta">{missing ? `Still needs ${missing}` : 'Ready'}</span>
          <button type="button" className="btn-sm is-ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn-sm is-primary"
            disabled={Boolean(missing) || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : widget ? 'Save card' : 'Add card'}
          </button>
        </div>
      </div>
    </div>
  );
}

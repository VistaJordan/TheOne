/* One dashboard, drawn (0042).
 *
 * The board asks the API for every card's answer in a single call, so a
 * dashboard of twelve cards is one round trip rather than twelve, and every
 * card on the page is measured at the same instant — two cards that disagree
 * because they were counted seconds apart is a bug people never forgive.
 *
 * Editing is the owner's (or a super admin's). Everyone else reads the same
 * numbers, scoped to their own work orders.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PERIOD,
  PERIOD_LABELS,
  PERIOD_PRESETS,
  TIME_BUCKETS,
  TIME_BUCKET_LABELS,
  periodSteps,
  resolvePeriod,
  WIDGET_KINDS,
  WIDGET_KIND_LABELS,
  WIDGET_METRICS,
  WIDGET_METRIC_LABELS,
  WIDGET_WIDTHS,
  type Dashboard,
  type DashboardWidget,
  type WidgetConfig,
  type DashboardPeriod,
  type PeriodPreset,
  type TimeBucket,
  type WidgetKind,
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
  const [editing, setEditing] = useState<DashboardWidget | 'new' | null>(null);
  const [removing, setRemoving] = useState<DashboardWidget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dataQuery = useQuery({
    queryKey: ['dashboard-data', dashboard.id, window.from, window.to],
    queryFn: () => getDashboardData(dashboard.id, { from: window.from, to: window.to }),
    staleTime: 30_000,
  });

  const byWidget = useMemo(
    () => new Map((dataQuery.data?.results ?? []).map((r) => [r.widget_id, r])),
    [dataQuery.data],
  );

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
          {window.from ? ', received in this period.' : '.'}
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
  const [metric, setMetric] = useState(widget?.config.metric ?? 'count');
  const [valueField, setValueField] = useState(widget?.config.value_field ?? '');
  const [groupField, setGroupField] = useState(widget?.config.group_field ?? '');
  const [timeField, setTimeField] = useState(widget?.config.time_field ?? 'date_received');
  const [bucket, setBucket] = useState<TimeBucket>(widget?.config.bucket ?? 'month');
  const [scope, setScope] = useState(scopeOf(widget?.config ?? { metric: 'count' }));
  const [width, setWidth] = useState<WidgetWidth>(widget?.width ?? 'half');
  const [error, setError] = useState<string | null>(null);

  const config: WidgetConfig = {
    metric,
    ...(metric === 'count' ? {} : { value_field: valueField }),
    ...(kind === 'line' ? { time_field: timeField, bucket } : {}),
    ...(kind === 'number' || kind === 'line' ? {} : { group_field: groupField }),
    ...(SCOPES.find((s) => s.id === scope)?.filters ? { filters: SCOPES.find((s) => s.id === scope)!.filters } : {}),
  };

  const missing =
    label.trim() === ''
      ? 'a name'
      : metric !== 'count' && !valueField
        ? 'a field to total'
        : kind === 'line' && !timeField
          ? 'a date to run along'
          : kind !== 'number' && kind !== 'line' && !groupField
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
              <label className="lbl" htmlFor="w-metric">What does it measure?</label>
              <select
                id="w-metric"
                className="fld"
                value={metric}
                onChange={(e) => setMetric(e.target.value as typeof metric)}
              >
                {WIDGET_METRICS.map((m) => (
                  <option key={m} value={m}>{WIDGET_METRIC_LABELS[m]}</option>
                ))}
              </select>
            </div>

            {metric !== 'count' && (
              <div className="field">
                <label className="lbl" htmlFor="w-value">Which number?</label>
                <select id="w-value" className="fld" value={valueField} onChange={(e) => setValueField(e.target.value)}>
                  <option value="">Pick a field</option>
                  {numericFields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label className="lbl" htmlFor="w-kind">How should it look?</label>
              <select id="w-kind" className="fld" value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>
                {WIDGET_KINDS.map((k) => (
                  <option key={k} value={k}>{WIDGET_KIND_LABELS[k]}</option>
                ))}
              </select>
            </div>

            {kind === 'line' && (
              <>
                <div className="field">
                  <label className="lbl" htmlFor="w-time">Along which date?</label>
                  <select id="w-time" className="fld" value={timeField} onChange={(e) => setTimeField(e.target.value)}>
                    <option value="">Pick a date field</option>
                    {dateFields.map((f) => (
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

            {kind !== 'number' && kind !== 'line' && (
              <div className="field">
                <label className="lbl" htmlFor="w-group">Cut it by</label>
                <select id="w-group" className="fld" value={groupField} onChange={(e) => setGroupField(e.target.value)}>
                  <option value="">Pick a field</option>
                  {groupFields.map((f) => (
                    <option key={f.key} value={f.key}>{f.label}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label className="lbl" htmlFor="w-scope">Which work orders?</label>
              <select id="w-scope" className="fld" value={scope} onChange={(e) => setScope(e.target.value)}>
                {SCOPES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </div>

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

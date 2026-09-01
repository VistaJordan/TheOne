import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { MetricEvent, WoFieldDescriptor, WoFilterRule, WoFilterSet } from '../../api/client';
import {
  getMetricBreakdown,
  getMetricDuration,
  getUserPref,
  getWoFields,
  listWorkOrders,
  setUserPref,
} from '../../api/client';
import { filterUrl, opLabel } from '../../lib/woView';
import {
  DASH_CARDS_PREF,
  defaultLabel,
  fieldLabeler,
  formatDuration,
  newCardId,
  normalizeCards,
  type DashCard,
  type DashCardKind,
} from '../../lib/dashCards';
import { Icon } from '../Icon';
import { FieldPicker } from '../wo/list/FieldPicker';

/**
 * The Main Dashboard's build-your-own cards.
 *
 * Three card kinds, all answered by the server from data it already keeps:
 * a COUNT of the rows matching a filter (same engine as the list), a BREAKDOWN
 * of the set by any catalogue field, and a DURATION between two field-change
 * events (the audit trail's timestamps, aggregated). Cards live in user_pref —
 * the same dashboard on every machine the account signs into.
 */
export function DashCards() {
  const qc = useQueryClient();
  const fieldsQuery = useQuery({ queryKey: ['wo-fields'], queryFn: getWoFields });
  const prefQuery = useQuery({
    queryKey: ['prefs', DASH_CARDS_PREF],
    queryFn: () => getUserPref<unknown>(DASH_CARDS_PREF),
  });
  const cards = useMemo(() => normalizeCards(prefQuery.data?.value), [prefQuery.data]);
  const labelOf = useMemo(() => fieldLabeler(fieldsQuery.data?.fields), [fieldsQuery.data]);

  // Optimistic: the pref cache is the source of truth the grid renders from,
  // so a save paints immediately and the server catches up.
  const save = useMutation({
    mutationFn: (next: DashCard[]) => setUserPref(DASH_CARDS_PREF, next),
    onMutate: (next) => {
      qc.setQueryData(['prefs', DASH_CARDS_PREF], { key: DASH_CARDS_PREF, value: next });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['prefs', DASH_CARDS_PREF] }),
  });

  const [editing, setEditing] = useState<DashCard | 'new' | null>(null);

  const upsert = (card: DashCard) => {
    const exists = cards.some((c) => c.id === card.id);
    save.mutate(exists ? cards.map((c) => (c.id === card.id ? card : c)) : [...cards, card]);
    setEditing(null);
  };
  const remove = (id: string) => save.mutate(cards.filter((c) => c.id !== id));

  if (prefQuery.isLoading) return null;

  return (
    <>
      <div className="dash-grid">
        {cards.map((card) => (
          <CardShell key={card.id} card={card} onEdit={() => setEditing(card)} onRemove={() => remove(card.id)}>
            {card.kind === 'count' && <CountCard card={card} />}
            {card.kind === 'breakdown' && <BreakdownCard card={card} />}
            {card.kind === 'duration' && <DurationCard card={card} />}
          </CardShell>
        ))}
        <button type="button" className="dash-add" onClick={() => setEditing('new')}>
          <Icon name="plus" size={14} />
          <span>Add card</span>
          {cards.length === 0 && (
            <span className="dash-add-hint">
              Count, break down, or time any field — including custom ones
            </span>
          )}
        </button>
      </div>
      {editing !== null && (
        <CardEditor
          fields={fieldsQuery.data?.fields ?? []}
          labelOf={labelOf}
          initial={editing === 'new' ? null : editing}
          onSave={upsert}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}

/** Card chrome: the content plus hover tools (edit / remove). The tools sit
    OUTSIDE the content's link so a count card stays one big click target. */
function CardShell({
  card,
  onEdit,
  onRemove,
  children,
}: {
  card: DashCard;
  onEdit: () => void;
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`dash-cell is-${card.kind}`}>
      {children}
      <div className="dash-tools">
        <button type="button" aria-label={`Edit "${card.label}"`} onClick={onEdit}>
          <Icon name="pencil" size={12} />
        </button>
        <button type="button" aria-label={`Remove "${card.label}"`} onClick={onRemove}>
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Count ────────────────────────────────────────────────────────────────────

function CountCard({ card }: { card: DashCard }) {
  const filters = card.filters ?? { match: 'all', rules: [] };
  const q = useQuery({
    queryKey: ['dash-count', card.id, filters],
    queryFn: () => listWorkOrders({ filters, limit: 1 }),
  });
  const count = q.isError ? null : q.data?.total;
  const hot = typeof count === 'number' && count > 0;
  return (
    <Link className={`kpi attn dash-card${hot ? ' hot' : ''}`} to={filterUrl(filters)}>
      <div className="kl">{card.label}</div>
      <div className="kv">{q.isLoading ? '—' : count === null ? '?' : String(count ?? 0)}</div>
      {!q.isLoading && (
        <div className="km">
          {count === null ? 'Could not count these rows' : 'Work orders · open the list'}
        </div>
      )}
    </Link>
  );
}

// ── Breakdown ────────────────────────────────────────────────────────────────

const BREAKDOWN_ROWS = 6;

/** The filter a bucket row links to — the same rows the bucket counted. A
    boolean field cannot take `eq`, so its buckets link via is_true/is_false. */
function bucketRule(field: WoFieldDescriptor | undefined, key: string, value: string | null): WoFilterRule {
  if (value === null) return { field: key, op: 'is_not_set' };
  if (field?.type === 'boolean') {
    return { field: key, op: value === 'true' ? 'is_true' : 'is_false' };
  }
  return { field: key, op: 'eq', value };
}

function BreakdownCard({ card }: { card: DashCard }) {
  const field = card.field ?? '';
  const fieldsQuery = useQuery({ queryKey: ['wo-fields'], queryFn: getWoFields });
  const descriptor = fieldsQuery.data?.fields.find((f) => f.key === field);
  const q = useQuery({
    queryKey: ['dash-breakdown', card.id, field],
    queryFn: () => getMetricBreakdown(field, undefined, BREAKDOWN_ROWS),
  });
  const items = q.data?.items ?? [];
  const max = items.reduce((m, b) => Math.max(m, b.count), 0);
  return (
    <div className="kpi dash-card dash-bd">
      <div className="kl">{card.label}</div>
      {q.isLoading && <div className="km">Loading…</div>}
      {q.isError && <div className="km">Could not load — is the field still in the catalogue?</div>}
      {!q.isLoading && !q.isError && items.length === 0 && <div className="km">No work orders</div>}
      <div className="bd-rows">
        {items.map((b) => {
          const rules: WoFilterRule[] = [bucketRule(descriptor, field, b.value)];
          return (
            <Link className="bd-row" key={b.value ?? '∅'} to={filterUrl({ match: 'all', rules })}>
              <span className="bd-name ellipsis">{b.value ?? 'Not set'}</span>
              <span className="bd-bar" aria-hidden="true">
                <span style={{ width: max > 0 ? `${(b.count / max) * 100}%` : 0 }} />
              </span>
              <span className="bd-n">{b.count}</span>
            </Link>
          );
        })}
        {(q.data?.other ?? 0) > 0 && (
          <div className="bd-row is-other">
            <span className="bd-name">Other values</span>
            <span className="bd-bar" aria-hidden="true" />
            <span className="bd-n">{q.data?.other}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Duration ─────────────────────────────────────────────────────────────────

function DurationCard({ card }: { card: DashCard }) {
  const from = card.from as MetricEvent;
  const to = card.to as MetricEvent;
  const q = useQuery({
    queryKey: ['dash-duration', card.id, from, to],
    queryFn: () => getMetricDuration(from, to),
  });
  const d = q.data;
  return (
    <div className="kpi dash-card">
      <div className="kl">
        <Icon name="clock" size={12} /> {card.label}
      </div>
      <div className="kv">{q.isLoading ? '—' : d && d.count > 0 ? formatDuration(d.avg_seconds) : '—'}</div>
      <div className="km">
        {q.isLoading
          ? ' '
          : q.isError
            ? 'Could not measure — check the two events'
            : d && d.count > 0
              ? `avg of ${d.count} · median ${formatDuration(d.median_seconds)}`
              : 'Nothing measured yet — spans record as fields change'}
      </div>
    </div>
  );
}

// ── The editor dialog ────────────────────────────────────────────────────────

const KIND_LABEL: Record<DashCardKind, string> = {
  count: 'Count',
  breakdown: 'Breakdown',
  duration: 'Duration',
};
const KIND_HINT: Record<DashCardKind, string> = {
  count: 'How many work orders match a condition',
  breakdown: 'The whole set, bucketed by one field',
  duration: 'Average time between two field changes — e.g. Checked-in → Checked-out',
};

type CountOp = 'eq' | 'is_set' | 'is_not_set' | 'is_true' | 'is_false';

function countOpsFor(field: WoFieldDescriptor | null): CountOp[] {
  if (field?.type === 'boolean') return ['is_true', 'is_false', 'is_set', 'is_not_set'];
  return ['eq', 'is_set', 'is_not_set'];
}

function CardEditor({
  fields,
  labelOf,
  initial,
  onSave,
  onCancel,
}: {
  fields: WoFieldDescriptor[];
  labelOf: (key: string) => string;
  initial: DashCard | null;
  onSave: (card: DashCard) => void;
  onCancel: () => void;
}) {
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const initialRule = initial?.filters?.rules[0];

  const [kind, setKind] = useState<DashCardKind>(initial?.kind ?? 'count');
  const [countField, setCountField] = useState<WoFieldDescriptor | null>(
    initialRule ? (byKey.get(initialRule.field) ?? null) : null,
  );
  const [countOp, setCountOp] = useState<CountOp>((initialRule?.op as CountOp) ?? 'eq');
  const [countValue, setCountValue] = useState(String(initialRule?.value ?? ''));
  const [bdField, setBdField] = useState<WoFieldDescriptor | null>(
    initial?.field ? (byKey.get(initial.field) ?? null) : null,
  );
  const [fromField, setFromField] = useState<WoFieldDescriptor | null>(
    initial?.from ? (byKey.get(initial.from.field) ?? null) : null,
  );
  const [fromValue, setFromValue] = useState(initial?.from?.value ?? '');
  const [toField, setToField] = useState<WoFieldDescriptor | null>(
    initial?.to ? (byKey.get(initial.to.field) ?? null) : null,
  );
  const [toValue, setToValue] = useState(initial?.to?.value ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [labelTouched, setLabelTouched] = useState(initial !== null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const valueless = countOp !== 'eq';
  const draft = (): Omit<DashCard, 'id' | 'label'> | null => {
    if (kind === 'count') {
      if (!countField) return null;
      if (!valueless && countValue.trim() === '') return null;
      const rule: WoFilterRule = valueless
        ? { field: countField.key, op: countOp }
        : { field: countField.key, op: 'eq', value: countValue.trim() };
      const filters: WoFilterSet = { match: 'all', rules: [rule] };
      return { kind, filters };
    }
    if (kind === 'breakdown') {
      return bdField ? { kind, field: bdField.key } : null;
    }
    if (!fromField || !toField) return null;
    return {
      kind,
      from: { field: fromField.key, value: fromValue.trim() === '' ? null : fromValue.trim() },
      to: { field: toField.key, value: toValue.trim() === '' ? null : toValue.trim() },
    };
  };
  const d = draft();
  const autoLabel = d ? defaultLabel(d, labelOf) : '';
  const finalLabel = (labelTouched && label.trim() !== '' ? label : autoLabel).trim();

  const submit = () => {
    if (!d || finalLabel === '') return;
    onSave({ id: initial?.id ?? newCardId(), label: finalLabel, ...d });
  };

  return (
    <div className="modal-scrim" onClick={onCancel} role="presentation">
      <div
        className="modal is-narrow dash-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dash-ed-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="dash-ed-title">{initial ? 'Edit card' : 'Add a card'}</h2>
        </div>
        <div className="modal-body">
          <div className="seg" role="group" aria-label="Card type">
            {(Object.keys(KIND_LABEL) as DashCardKind[]).map((k) => (
              <button
                key={k}
                type="button"
                className={`seg-btn${kind === k ? ' is-on' : ''}`}
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <p className="dash-ed-hint">{KIND_HINT[kind]}</p>

          {kind === 'count' && (
            <div className="dash-ed-rows">
              <div className="dash-ed-row">
                <FieldPicker
                  fields={fields}
                  variant="select"
                  label={countField?.label ?? 'Choose a field…'}
                  onPick={(f) => {
                    setCountField(f);
                    setCountOp(f.type === 'boolean' ? 'is_true' : 'eq');
                    setCountValue('');
                  }}
                />
                <select
                  className="dash-ed-op"
                  aria-label="Condition"
                  value={countOp}
                  onChange={(e) => setCountOp(e.target.value as CountOp)}
                >
                  {countOpsFor(countField).map((op) => (
                    <option key={op} value={op}>
                      {op === 'eq' ? 'is' : opLabel(op, countField?.type ?? 'text')}
                    </option>
                  ))}
                </select>
                {!valueless && (
                  <ValueInput field={countField} value={countValue} onChange={setCountValue} />
                )}
              </div>
            </div>
          )}

          {kind === 'breakdown' && (
            <div className="dash-ed-rows">
              <div className="dash-ed-row">
                <FieldPicker
                  fields={fields}
                  variant="select"
                  label={bdField?.label ?? 'Choose a field…'}
                  onPick={setBdField}
                />
              </div>
            </div>
          )}

          {kind === 'duration' && (
            <div className="dash-ed-rows">
              <EventRow
                legend="From"
                fields={fields}
                field={fromField}
                value={fromValue}
                onField={(f) => {
                  setFromField(f);
                  setFromValue('');
                }}
                onValue={setFromValue}
              />
              <EventRow
                legend="To"
                fields={fields}
                field={toField}
                value={toValue}
                onField={(f) => {
                  setToField(f);
                  setToValue('');
                }}
                onValue={setToValue}
              />
              <p className="dash-ed-note">
                Measured per work order, first “from” to the next “to”, using the change
                timestamps the audit trail records. Leave a value empty to mean “any change”.
              </p>
            </div>
          )}

          <label className="dash-ed-label">
            <span>Card label</span>
            <input
              type="text"
              value={labelTouched ? label : autoLabel}
              placeholder={autoLabel || 'Name this card'}
              maxLength={80}
              onChange={(e) => {
                setLabelTouched(true);
                setLabel(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn-sm" onClick={submit} disabled={!d || finalLabel === ''}>
            {initial ? 'Save card' : 'Add card'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One leg of a duration: "when <field> becomes <value>" (empty = any change). */
function EventRow({
  legend,
  fields,
  field,
  value,
  onField,
  onValue,
}: {
  legend: string;
  fields: WoFieldDescriptor[];
  field: WoFieldDescriptor | null;
  value: string;
  onField: (f: WoFieldDescriptor) => void;
  onValue: (v: string) => void;
}) {
  return (
    <div className="dash-ed-row">
      <span className="dash-ed-leg">{legend}</span>
      <FieldPicker
        fields={fields}
        variant="select"
        label={field?.label ?? 'Choose a field…'}
        onPick={onField}
      />
      <span className="dash-ed-word">becomes</span>
      <ValueInput field={field} value={value} onChange={onValue} placeholder="any change" />
    </div>
  );
}

/** The value control for a field: its declared/observed vocabulary as a select
    when it has one, a plain input otherwise. */
function ValueInput({
  field,
  value,
  onChange,
  placeholder,
}: {
  field: WoFieldDescriptor | null;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const options = field?.options;
  // Uncontrolled flicker guard: when the saved value is not in the vocabulary
  // any more, keep it selectable so an edit does not silently change the card.
  const extra = value !== '' && options && !options.some((o) => o.value === value);
  const ref = useRef<HTMLInputElement>(null);
  if (options && options.length > 0) {
    return (
      <select
        className="dash-ed-value"
        aria-label="Value"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{placeholder ?? 'Choose a value…'}</option>
        {extra && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      ref={ref}
      className="dash-ed-value"
      type="text"
      aria-label="Value"
      value={value}
      placeholder={placeholder ?? 'Value'}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

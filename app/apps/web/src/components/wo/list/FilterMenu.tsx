import { useMemo, useState } from 'react';
import type { WoFieldDescriptor, WoFieldType, WoFilterOp, WoFilterRule, WoFilterSet } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover, ToolButton } from './Popover';
import { defaultOp, isComplete, isMulti, isValueless, opLabel } from '../../../lib/woView';
import { FieldPicker } from './FieldPicker';

interface FilterMenuProps {
  fields: WoFieldDescriptor[];
  opsByType: Record<WoFieldType, WoFilterOp[]>;
  value: WoFilterSet;
  onChange: (next: WoFilterSet) => void;
}

/**
 * The filter builder: a stack of `field · test · value` rows joined by all/any.
 *
 * Every field in the catalogue is filterable, including the ~100 custom ones,
 * and the tests offered are whatever the field's TYPE supports — so a money
 * field offers "is at least" and a checkbox offers "is checked", instead of one
 * lowest-common-denominator "contains" for everything.
 *
 * A half-written rule (field and test chosen, value still blank) stays in the
 * list but is not sent: the table keeps showing results while you type rather
 * than blanking on every keystroke.
 */
export function FilterMenu({ fields, opsByType, value, onChange }: FilterMenuProps) {
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const applied = value.rules.filter(isComplete).length;
  const pending = value.rules.length - applied;

  const setRule = (i: number, next: WoFilterRule) => {
    const rules = value.rules.slice();
    rules[i] = next;
    onChange({ ...value, rules });
  };

  const removeRule = (i: number) => {
    onChange({ ...value, rules: value.rules.filter((_, n) => n !== i) });
  };

  const addRule = (field: WoFieldDescriptor) => {
    const ops = opsByType[field.type] ?? ['contains'];
    onChange({
      ...value,
      rules: [...value.rules, { field: field.key, op: defaultOp(field.type, ops), value: null }],
    });
  };

  return (
    <Popover
      align="left"
      panelClassName="pop-filters"
      trigger={({ open, toggle }) => (
        <ToolButton active={applied > 0} pressed={open} onClick={toggle}>
          <Icon name="filter" size={14} />
          Filter
          {applied > 0 && <span className="tool-count">{applied}</span>}
        </ToolButton>
      )}
    >
      {() => (
        <>
          <div className="pop-head">
            <span className="pop-title">Filters</span>
            {value.rules.length > 1 && (
              <div className="match-toggle" role="group" aria-label="Combine rules with">
                {(['all', 'any'] as const).map((m) => (
                  <button
                    type="button"
                    key={m}
                    className={`match-btn${value.match === m ? ' is-on' : ''}`}
                    onClick={() => onChange({ ...value, match: m })}
                  >
                    {m === 'all' ? 'Match all' : 'Match any'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {value.rules.length === 0 && (
            <p className="pop-empty">
              No filters yet. Add one to narrow the list by any field on a work order.
            </p>
          )}

          <div className="rule-list">
            {value.rules.map((rule, i) => (
              <RuleRow
                key={i}
                index={i}
                rule={rule}
                field={byKey.get(rule.field)}
                fields={fields}
                opsByType={opsByType}
                joiner={i === 0 ? 'Where' : value.match === 'all' ? 'and' : 'or'}
                onChange={(next) => setRule(i, next)}
                onRemove={() => removeRule(i)}
              />
            ))}
          </div>

          <div className="pop-foot">
            <FieldPicker
              fields={fields}
              label="Add filter"
              icon="plus"
              onPick={(f) => addRule(f)}
            />
            {value.rules.length > 0 && (
              <button
                type="button"
                className="link-btn"
                onClick={() => onChange({ match: value.match, rules: [] })}
              >
                Clear all
              </button>
            )}
            {pending > 0 && (
              <span className="pop-note">
                {pending} rule{pending === 1 ? '' : 's'} still need a value
              </span>
            )}
          </div>
        </>
      )}
    </Popover>
  );
}

interface RuleRowProps {
  index: number;
  rule: WoFilterRule;
  field: WoFieldDescriptor | undefined;
  fields: WoFieldDescriptor[];
  opsByType: Record<WoFieldType, WoFilterOp[]>;
  joiner: string;
  onChange: (next: WoFilterRule) => void;
  onRemove: () => void;
}

function RuleRow({ rule, field, fields, opsByType, joiner, onChange, onRemove }: RuleRowProps) {
  // A saved view can name a field an administrator has since removed. Rather
  // than crash or silently drop the rule, it renders as an unknown field the
  // user can see and delete.
  const type: WoFieldType = field?.type ?? 'text';
  const ops = opsByType[type] ?? [];

  const changeField = (next: WoFieldDescriptor) => {
    const nextOps = opsByType[next.type] ?? [];
    // Carry the operator over when the new field still supports it — changing
    // "Client is X" to "Trade is X" should not reset the test.
    const op = nextOps.includes(rule.op) ? rule.op : defaultOp(next.type, nextOps);
    const keepValue = next.type === type && !isValueless(op);
    onChange({ field: next.key, op, value: keepValue ? (rule.value ?? null) : null });
  };

  const changeOp = (op: WoFilterOp) => {
    // Moving between shapes (scalar → pair → list) invalidates the old value.
    const shapeChanged =
      isMulti(op) !== isMulti(rule.op) ||
      (op === 'between') !== (rule.op === 'between') ||
      isValueless(op);
    onChange({ ...rule, op, value: shapeChanged ? null : (rule.value ?? null) });
  };

  return (
    <div className="rule">
      <span className="rule-join">{joiner}</span>

      <FieldPicker
        fields={fields}
        label={field?.label ?? `${rule.field} (removed)`}
        variant="select"
        onPick={changeField}
      />

      <select
        className="rule-op"
        value={rule.op}
        onChange={(e) => changeOp(e.target.value as WoFilterOp)}
        aria-label="Test"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {opLabel(op, type)}
          </option>
        ))}
      </select>

      <RuleValue rule={rule} field={field} onChange={onChange} />

      <button type="button" className="rule-x" onClick={onRemove} aria-label="Remove this filter">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function RuleValue({
  rule,
  field,
  onChange,
}: {
  rule: WoFilterRule;
  field: WoFieldDescriptor | undefined;
  onChange: (next: WoFilterRule) => void;
}) {
  if (isValueless(rule.op)) return <span className="rule-value-none" aria-hidden="true" />;

  const type = field?.type ?? 'text';
  const inputType = type === 'date' ? 'date' : type === 'number' || type === 'money' ? 'number' : 'text';

  if (rule.op === 'between') {
    const pair = Array.isArray(rule.value) ? rule.value : ['', ''];
    const set = (i: number, v: string) => {
      const next = [String(pair[0] ?? ''), String(pair[1] ?? '')];
      next[i] = v;
      onChange({ ...rule, value: next });
    };
    return (
      <span className="rule-pair">
        <input
          type={inputType}
          className="rule-value"
          value={String(pair[0] ?? '')}
          onChange={(e) => set(0, e.target.value)}
          aria-label="From"
        />
        <span className="rule-and">and</span>
        <input
          type={inputType}
          className="rule-value"
          value={String(pair[1] ?? '')}
          onChange={(e) => set(1, e.target.value)}
          aria-label="To"
        />
      </span>
    );
  }

  if (isMulti(rule.op)) {
    const selected = Array.isArray(rule.value) ? rule.value.map(String) : [];
    if (field?.options?.length) {
      return (
        <MultiSelect
          options={field.options.map((o) => o.value)}
          selected={selected}
          onChange={(vals) => onChange({ ...rule, value: vals })}
        />
      );
    }
    return (
      <input
        type="text"
        className="rule-value is-wide"
        placeholder="value, value, value"
        value={selected.join(', ')}
        onChange={(e) =>
          onChange({
            ...rule,
            value: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })
        }
        aria-label="Values"
      />
    );
  }

  // A field whose vocabulary is known becomes a picker rather than free text —
  // it is the difference between choosing a client and spelling one.
  if (field?.options?.length && (rule.op === 'eq' || rule.op === 'neq')) {
    return (
      <select
        className="rule-value"
        value={String(rule.value ?? '')}
        onChange={(e) => onChange({ ...rule, value: e.target.value })}
        aria-label="Value"
      >
        <option value="">Choose…</option>
        {field.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type={inputType}
      className="rule-value"
      value={String(rule.value ?? '')}
      onChange={(e) => onChange({ ...rule, value: e.target.value })}
      placeholder="value"
      aria-label="Value"
    />
  );
}

/** "is any of" over a known vocabulary — a checklist, not a comma-separated
    string the user has to spell correctly. */
function MultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const shown = options.filter((o) => o.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);

  return (
    <Popover
      className="rule-multi"
      panelClassName="pop-options"
      trigger={({ open, toggle: t }) => (
        <button type="button" className={`rule-value as-button${open ? ' is-open' : ''}`} onClick={t}>
          {selected.length === 0 ? 'Choose…' : `${selected.length} selected`}
          <Icon name="chev-d" size={12} />
        </button>
      )}
    >
      {() => (
        <>
          {options.length > 8 && (
            <input
              className="pop-search"
              type="search"
              placeholder="Search…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          <div className="opt-list">
            {shown.map((o) => (
              <label key={o} className="opt">
                <input type="checkbox" checked={selected.includes(o)} onChange={() => toggle(o)} />
                <span>{o}</span>
              </label>
            ))}
            {shown.length === 0 && <p className="pop-empty">No matches.</p>}
          </div>
        </>
      )}
    </Popover>
  );
}

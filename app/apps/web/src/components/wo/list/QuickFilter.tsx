import { useMemo, useState } from 'react';
import type { WoFieldDescriptor, WoFilterOp, WoFilterRule, WoFilterSet } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover, ToolButton } from './Popover';

// ── The rule a chip stands for ───────────────────────────────────────────────
// A quick filter is not a second filter system. Like the status tabs, it is a
// shortcut for ONE rule in `view.filters` — `AM is any of [Peter Hope]` — so
// the Filter menu shows the same constraint, a saved view carries it, and
// "Reset" undoes it along with everything else.

function isRuleOn(key: string) {
  return (r: WoFilterRule) => r.field === key;
}

/**
 * The values the working rules pin `key` to, when they say so in a way the
 * chip can show (a single `eq` or `in` rule). Empty means "not narrowed";
 * `null` means the Filter menu holds something on this field the chip cannot
 * express (e.g. "is not", or two rules), so the chip stays quiet.
 */
export function quickValuesOf(filters: WoFilterSet, key: string): string[] | null {
  const rules = filters.rules.filter(isRuleOn(key));
  if (rules.length === 0) return [];
  if (rules.length > 1) return null;
  const [r] = rules;
  if (r.op === 'eq') return r.value == null || r.value === '' ? [] : [String(r.value)];
  if (r.op === 'in' && Array.isArray(r.value)) return r.value.map(String);
  return null;
}

/** The rules with `key` pinned to exactly `values` (none = no constraint).
    Other rules are untouched; the chip's rule keeps its place in the list. */
export function withQuickValues(filters: WoFilterSet, key: string, values: string[]): WoFilterSet {
  const at = filters.rules.findIndex(isRuleOn(key));
  const others = filters.rules.filter((r) => !isRuleOn(key)(r));
  if (values.length === 0) return { match: filters.match, rules: others };
  const rule: WoFilterRule =
    values.length === 1
      ? { field: key, op: 'eq' as WoFilterOp, value: values[0] }
      : { field: key, op: 'in' as WoFilterOp, value: values };
  const rules = others.slice();
  rules.splice(at === -1 ? rules.length : at, 0, rule);
  return { match: filters.match, rules };
}

interface QuickFilterProps {
  /** The field the chip narrows on; undefined when the catalogue lacks it. */
  field: WoFieldDescriptor | undefined;
  /** The short name on the chip — "AM", not "Account manager". */
  label: string;
  value: WoFilterSet;
  onChange: (next: WoFilterSet) => void;
}

/**
 * One chip per field the team narrows by all day — Assignee, FM, Comp, AM.
 *
 * The full filter builder can express the same thing, but "show me Peter's
 * work orders" should be two clicks, not a field picker, an operator and a
 * value. The chip reads the field's vocabulary (its options) and offers it as
 * a checklist; picking one name writes `is`, picking several writes `is any of`.
 */
export function QuickFilter({ field, label, value, onChange }: QuickFilterProps) {
  const [q, setQ] = useState('');
  const key = field?.key ?? '';
  const selected = useMemo(() => (field ? quickValuesOf(value, key) : []), [field, key, value]);
  const options = field?.options ?? [];
  const byValue = useMemo(() => new Map(options.map((o) => [o.value, o.label])), [options]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
    return list.slice(0, 200);
  }, [options, q]);

  const toggle = (v: string) => {
    if (!selected) return;
    const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
    onChange(withQuickValues(value, key, next));
  };

  const count = selected?.length ?? 0;
  const summary =
    count === 1 ? (byValue.get(selected![0]) ?? selected![0]) : count > 1 ? String(count) : null;

  return (
    <Popover
      panelClassName="pop-options"
      trigger={({ open, toggle: t }) => (
        <ToolButton
          active={count > 0}
          pressed={open}
          onClick={t}
          disabled={!field}
          title={
            field
              ? `Narrow by ${field.label.toLowerCase()}`
              : `“${label}” is not a field on these work orders yet`
          }
        >
          {label}
          {summary && <span className="qf-value">{summary}</span>}
          <Icon name="chev-d" size={12} />
        </ToolButton>
      )}
    >
      {() => (
        <>
          {options.length > 8 && (
            <input
              className="pop-search"
              type="search"
              placeholder={`Search ${label.toLowerCase()}…`}
              value={q}
              autoFocus
              onChange={(e) => setQ(e.target.value)}
            />
          )}

          {selected === null && (
            <p className="pop-empty">
              The Filter menu already narrows by {field?.label.toLowerCase()} in a way this
              chip cannot show. Change it there.
            </p>
          )}

          {selected !== null && options.length === 0 && (
            <p className="pop-empty">No {field?.label.toLowerCase()} on any work order yet.</p>
          )}

          {selected !== null && options.length > 0 && (
            <div className="opt-list">
              {shown.map((o) => (
                <label key={o.value} className="opt">
                  <input
                    type="checkbox"
                    checked={selected.includes(o.value)}
                    onChange={() => toggle(o.value)}
                  />
                  <span className="ellipsis">{o.label}</span>
                </label>
              ))}
              {shown.length === 0 && <p className="pop-empty">No matches.</p>}
            </div>
          )}

          {count > 0 && (
            <div className="pop-foot">
              <button
                type="button"
                className="link-btn"
                onClick={() => onChange(withQuickValues(value, key, []))}
              >
                <Icon name="x" size={12} />
                Clear
              </button>
            </div>
          )}
        </>
      )}
    </Popover>
  );
}

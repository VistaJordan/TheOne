import { useMemo, useState } from 'react';
import type { WoFieldDescriptor } from '../../../api/client';
import { Icon } from '../../Icon';
import { Popover, ToolButton } from './Popover';
import { DEFAULT_VIEW } from '../../../lib/woView';

interface ColumnsMenuProps {
  fields: WoFieldDescriptor[];
  columns: string[];
  onChange: (next: string[]) => void;
}

/**
 * Add, remove and reorder the table's columns.
 *
 * Two lists rather than one checklist: the chosen columns need an ORDER, and
 * order is a property the checked items have and the unchecked ones do not.
 * Showing them in one list would mean either an arbitrary position for every
 * unchecked field or a list that reshuffles itself as you tick boxes.
 */
export function ColumnsMenu({ fields, columns, onChange }: ColumnsMenuProps) {
  const [q, setQ] = useState('');
  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);

  const available = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return fields.filter(
      (f) =>
        !columns.includes(f.key) &&
        (needle === '' ||
          f.label.toLowerCase().includes(needle) ||
          f.key.toLowerCase().includes(needle)),
    );
  }, [fields, columns, q]);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= columns.length) return;
    const next = columns.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };

  return (
    <Popover
      align="right"
      panelClassName="pop-columns"
      trigger={({ open, toggle }) => (
        <ToolButton pressed={open} onClick={toggle} title="Choose which columns to show">
          <Icon name="columns" size={14} />
          Columns
          <span className="tool-count">{columns.length}</span>
        </ToolButton>
      )}
    >
      {() => (
        <>
          <div className="pop-head">
            <span className="pop-title">Shown</span>
            <button
              type="button"
              className="link-btn"
              onClick={() => onChange([...DEFAULT_VIEW.columns])}
            >
              Reset
            </button>
          </div>

          <div className="col-list">
            {columns.map((key, i) => {
              const f = byKey.get(key);
              return (
                <div className="col-row" key={key}>
                  <span className="col-grip" aria-hidden="true">
                    <Icon name="grip" size={12} />
                  </span>
                  <span className="col-name ellipsis">{f?.label ?? `${key} (removed)`}</span>
                  <button
                    type="button"
                    className="col-move"
                    onClick={() => move(i, i - 1)}
                    disabled={i === 0}
                    aria-label={`Move ${f?.label ?? key} up`}
                  >
                    <Icon name="chev-u" size={12} />
                  </button>
                  <button
                    type="button"
                    className="col-move"
                    onClick={() => move(i, i + 1)}
                    disabled={i === columns.length - 1}
                    aria-label={`Move ${f?.label ?? key} down`}
                  >
                    <Icon name="chev-d" size={12} />
                  </button>
                  <button
                    type="button"
                    className="col-move is-remove"
                    // The table needs at least one column to be a table.
                    disabled={columns.length === 1}
                    onClick={() => onChange(columns.filter((c) => c !== key))}
                    aria-label={`Remove ${f?.label ?? key}`}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          <div className="pop-head as-divider">
            <span className="pop-title">Add a column</span>
          </div>
          <input
            className="pop-search"
            type="search"
            placeholder="Search fields…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="field-list is-short">
            {available.length === 0 && <p className="pop-empty">Every field is already shown.</p>}
            {available.slice(0, 200).map((f) => (
              <button
                type="button"
                key={f.key}
                className="field-item"
                onClick={() => onChange([...columns, f.key])}
              >
                <span className="ellipsis">{f.label}</span>
                <span className="field-type">{f.group}</span>
                <Icon name="plus" size={12} />
              </button>
            ))}
          </div>
        </>
      )}
    </Popover>
  );
}

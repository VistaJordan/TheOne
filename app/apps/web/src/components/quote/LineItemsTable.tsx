/* The quote builder's line-item table (comp: .lt). One per section — INCURRED
   and every option render the same table with a different caption.

   Amount is COMPUTED and read-only (qty × rate, ×1.5 when OT). A line that does
   not yet compute renders "—", takes the .has-err row wash, and is EXCLUDED from
   the subtotal rather than counted as zero — the footer says which lines. */

import type { DraftLine } from '../../lib/quoteDraft';
import { DAY_VALUES, LINE_TYPES, blankLine, moveItem, removeAt, replaceAt } from '../../lib/quoteDraft';
import { lineAmount, lineErrors, lineFieldId, usd } from '../../lib/quoteTotals';
import { useReorder } from '../../hooks/useReorder';
import { Icon } from '../Icon';

interface LineItemsTableProps {
  /** Screen-reader caption + the aria-label stem for every control ("Option A"). */
  label: string;
  lines: DraftLine[];
  editable: boolean;
  /** Errors only paint once the operator has tried to submit, or on blur. */
  showErrors: boolean;
  onChange: (lines: DraftLine[]) => void;
}

export function LineItemsTable({ label, lines, editable, showErrors, onChange }: LineItemsTableProps) {
  const reorder = useReorder((from, to) => onChange(moveItem(lines, from, to)));

  const set = (index: number, patch: Partial<DraftLine>) =>
    onChange(replaceAt(lines, index, { ...lines[index], ...patch }));

  return (
    <div className="lt-wrap">
      <table className="lt">
        <caption className="sr">{label} line items</caption>
        <thead>
          <tr>
            <th style={{ width: 30 }}><span className="sr">Reorder</span></th>
            <th className="c-type">Type</th>
            <th>
              Description <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
            </th>
            <th className="c-qty ta-r">
              Qty <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
            </th>
            <th className="c-rate ta-r">
              Rate <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
            </th>
            <th className="c-day">
              Day
              <button
                type="button"
                className="qmk"
                title="Day / per-diem multiplier — semantics still open (requirements §4.1)"
                aria-label="About the Day column: day / per-diem multiplier — semantics still open (requirements §4.1)"
              >
                ?
              </button>
            </th>
            <th className="c-ot">
              Overtime
              <button
                type="button"
                className="qmk"
                title="Overtime — bills at 1.5× the line rate (requirements §4.1)"
                aria-label="About the Overtime column: overtime bills at 1.5 times the line rate (requirements §4.1)"
              >
                ?
              </button>
            </th>
            <th className="c-amt ta-r">Amount</th>
            <th style={{ width: 34 }}><span className="sr">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && (
            <tr>
              <td colSpan={9}>
                <span className="hint">
                  No line items yet.{editable ? ' Add the first one below.' : ''}
                </span>
              </td>
            </tr>
          )}
          {lines.map((line, i) => {
            const errs = showErrors ? lineErrors(line) : {};
            const amount = lineAmount(line);
            const n = i + 1;
            const describedBy = (key: 'description' | 'qty' | 'rate') =>
              errs[key] ? `${lineFieldId(line.key, key)}-err` : undefined;

            return (
              <tr
                key={line.key}
                className={Object.keys(errs).length > 0 ? 'has-err' : undefined}
                {...(editable ? reorder.rowProps(i) : {})}
              >
                <td className="cell-tight">
                  {editable && (
                    <button
                      type="button"
                      className="drag"
                      aria-label={`Reorder ${label} line ${n} — use arrow up and arrow down`}
                      title="Drag, or use the arrow keys, to reorder"
                      {...reorder.gripProps(i)}
                    >
                      <Icon name="grip" size={14} />
                    </button>
                  )}
                </td>
                <td>
                  <select
                    className="fld"
                    aria-label={`${label} line ${n} type`}
                    value={line.line_type}
                    disabled={!editable}
                    onChange={(e) =>
                      set(i, { line_type: e.target.value as DraftLine['line_type'] })
                    }
                  >
                    {LINE_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className={`fld${errs.description ? ' is-err' : ''}`}
                    id={lineFieldId(line.key, 'description')}
                    aria-label={`${label} line ${n} description`}
                    aria-invalid={errs.description ? true : undefined}
                    aria-describedby={describedBy('description')}
                    value={line.description}
                    disabled={!editable}
                    onChange={(e) => set(i, { description: e.target.value })}
                  />
                  {errs.description && (
                    <span className="err" id={`${lineFieldId(line.key, 'description')}-err`}>
                      <Icon name="alert" size={12} />
                      {errs.description}
                    </span>
                  )}
                </td>
                <td>
                  <input
                    className={`fld qty-in${errs.qty ? ' is-err' : ''}`}
                    id={lineFieldId(line.key, 'qty')}
                    inputMode="decimal"
                    aria-label={`${label} line ${n} quantity`}
                    aria-invalid={errs.qty ? true : undefined}
                    aria-describedby={describedBy('qty')}
                    value={line.qty}
                    disabled={!editable}
                    onChange={(e) => set(i, { qty: e.target.value })}
                  />
                  {errs.qty && (
                    <span className="err" id={`${lineFieldId(line.key, 'qty')}-err`}>
                      <Icon name="alert" size={12} />
                      {errs.qty}
                    </span>
                  )}
                </td>
                <td>
                  <span className="money-in">
                    <span className="cur" aria-hidden="true">$</span>
                    <input
                      className={`fld${errs.rate ? ' is-err' : ''}`}
                      id={lineFieldId(line.key, 'rate')}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`${label} line ${n} rate`}
                      aria-invalid={errs.rate ? true : undefined}
                      aria-describedby={describedBy('rate')}
                      value={line.rate}
                      disabled={!editable}
                      onChange={(e) => set(i, { rate: e.target.value })}
                    />
                  </span>
                  {errs.rate && (
                    <span className="err" id={`${lineFieldId(line.key, 'rate')}-err`}>
                      <Icon name="alert" size={12} />
                      {errs.rate}
                    </span>
                  )}
                </td>
                <td>
                  <select
                    className="fld"
                    aria-label={`${label} line ${n} day`}
                    value={line.day_value}
                    disabled={!editable}
                    onChange={(e) => set(i, { day_value: e.target.value })}
                  >
                    <option value="">—</option>
                    {DAY_VALUES.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </td>
                <td>
                  {/* The checkbox carries a visible "OT" label, not a bare box:
                      an unlabelled toggle in a money column is unreadable. */}
                  <label className="ck">
                    <input
                      type="checkbox"
                      aria-label={`${label} line ${n} overtime — bills at 1.5× the rate`}
                      checked={line.ot}
                      disabled={!editable}
                      onChange={(e) => set(i, { ot: e.target.checked })}
                    />
                    <span>OT</span>
                  </label>
                </td>
                <td className="ta-r">
                  <span className={`ro num${amount == null ? ' is-empty' : ''}`}>
                    {amount == null ? '—' : usd(amount)}
                  </span>
                </td>
                <td className="cell-tight">
                  {editable && (
                    <button
                      type="button"
                      className="rowdel"
                      aria-label={`Remove ${label} line ${n}`}
                      onClick={() => onChange(removeAt(lines, i))}
                    >
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The "Add line" affordance — the comp puts it in the section footer, beside
    the read-only-amount note and the subtotal chip. */
export function AddLineButton({ lines, onChange }: { lines: DraftLine[]; onChange: (l: DraftLine[]) => void }) {
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...lines, blankLine()])}>
      <Icon name="plus" size={12} />
      Add line
    </button>
  );
}

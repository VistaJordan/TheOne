/* The quote builder's line-item table (comp: .lt). One per section — INCURRED
   and every option render the same table with a different caption.

   Amount is COMPUTED and read-only (qty × rate, × (1 + markup), × the OT
   multiplier when OT). A line that does not yet compute renders "—", takes
   the .has-err row wash, and is EXCLUDED from the subtotal rather than
   counted as zero — the footer says which lines.

   0048 · three more columns: UOM (free text with the usual units offered),
   Tax % and Markup %. Both percentages default to blank = 0, so a quote that
   never used them prices exactly as before. The OT multiplier comes from the
   quote's contract when one covers the work order (0046), else ×1.5. */

import type { DraftLine } from '../../lib/quoteDraft';
import { DAY_VALUES, LINE_TYPES, blankLine, moveItem, removeAt, replaceAt } from '../../lib/quoteDraft';
import { OT_MULTIPLIER, lineAmount, lineErrors, lineFieldId, lineTax, usd } from '../../lib/quoteTotals';
import { useReorder } from '../../hooks/useReorder';
import { Icon } from '../Icon';

/** The units offered in the UOM box; anything else may be typed. Mirrors
    QUOTE_UOMS in @theone/shared (a value list, so kept here — the web imports
    only types from the shared package). */
const UOMS = ['hr', 'ea', 'trip', 'day', 'lot', 'ft', 'sq ft'];

interface LineItemsTableProps {
  /** Screen-reader caption + the aria-label stem for every control ("Option A"). */
  label: string;
  lines: DraftLine[];
  editable: boolean;
  /** Errors only paint once the operator has tried to submit, or on blur. */
  showErrors: boolean;
  onChange: (lines: DraftLine[]) => void;
  /** 0046 · the multiplier an OT line bills at; the house ×1.5 by default. */
  otMultiplier?: number;
}

export function LineItemsTable({
  label,
  lines,
  editable,
  showErrors,
  onChange,
  otMultiplier = OT_MULTIPLIER,
}: LineItemsTableProps) {
  const reorder = useReorder((from, to) => onChange(moveItem(lines, from, to)));
  const listId = `uom-list-${label.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
  const otText = `${Number.isInteger(otMultiplier * 100) ? otMultiplier : otMultiplier.toFixed(3)}×`;

  const set = (index: number, patch: Partial<DraftLine>) =>
    onChange(replaceAt(lines, index, { ...lines[index], ...patch }));

  return (
    <div className="lt-wrap">
      <datalist id={listId}>
        {UOMS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
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
            <th className="c-uom">UOM</th>
            <th className="c-rate ta-r">
              Unit price <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
            </th>
            <th className="c-pct ta-r">
              Markup %
              <button
                type="button"
                className="qmk"
                title="Added to the unit price before the amount is computed — parts bought and resold"
                aria-label="About the Markup column: added to the unit price before the amount is computed"
              >
                ?
              </button>
            </th>
            <th className="c-pct ta-r">
              Tax %
              <button
                type="button"
                className="qmk"
                title="This line's own tax rate; the quote's Sales Tax box is separate and manual"
                aria-label="About the Tax column: this line's own tax rate, separate from the manual Sales Tax"
              >
                ?
              </button>
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
                title={`Overtime — bills at ${otText} the line rate${otMultiplier === OT_MULTIPLIER ? ' (house default)' : ' (from the contract)'}`}
                aria-label={`About the Overtime column: overtime bills at ${otText} the line rate`}
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
              <td colSpan={12}>
                <span className="hint">
                  No line items yet.{editable ? ' Add the first one below.' : ''}
                </span>
              </td>
            </tr>
          )}
          {lines.map((line, i) => {
            const errs = showErrors ? lineErrors(line) : {};
            const amount = lineAmount(line, otMultiplier);
            const tax = lineTax(line, otMultiplier);
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
                  <input
                    className="fld uom-in"
                    list={listId}
                    aria-label={`${label} line ${n} unit of measure`}
                    placeholder="ea"
                    value={line.uom}
                    disabled={!editable}
                    onChange={(e) => set(i, { uom: e.target.value })}
                  />
                </td>
                <td>
                  <span className="money-in">
                    <span className="cur" aria-hidden="true">$</span>
                    <input
                      className={`fld${errs.rate ? ' is-err' : ''}`}
                      id={lineFieldId(line.key, 'rate')}
                      inputMode="decimal"
                      placeholder="0.00"
                      aria-label={`${label} line ${n} unit price`}
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
                  <input
                    className={`fld pct-in${errs.markup_pct ? ' is-err' : ''}`}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`${label} line ${n} markup percent`}
                    aria-invalid={errs.markup_pct ? true : undefined}
                    value={line.markup_pct}
                    disabled={!editable}
                    onChange={(e) => set(i, { markup_pct: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className={`fld pct-in${errs.tax_pct ? ' is-err' : ''}`}
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`${label} line ${n} tax percent`}
                    aria-invalid={errs.tax_pct ? true : undefined}
                    value={line.tax_pct}
                    disabled={!editable}
                    onChange={(e) => set(i, { tax_pct: e.target.value })}
                  />
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
                      aria-label={`${label} line ${n} overtime — bills at ${otText} the rate`}
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
                  {tax != null && tax > 0 && (
                    <span className="lt-tax">+ {usd(tax)} tax</span>
                  )}
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

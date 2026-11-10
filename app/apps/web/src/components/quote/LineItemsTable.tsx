/* The quote builder's line-item table (comp: .lt). One per section — INCURRED
   and every option render the same table with a different caption.

   Amount is COMPUTED and read-only (qty × rate, × the OT multiplier when
   OT — a Labor line only, the tick is not drawn on any other type). A line that does not yet compute renders "—", takes
   the .has-err row wash, and is EXCLUDED from the subtotal rather than
   counted as zero — the footer says which lines.

   0048 added UOM and Tax %. The per-line Markup column was removed on
   2026-10-22 (Elise): a stored markup is folded into the unit price when the
   quote loads (quoteDraft). The same day the UOM column went altogether (a
   saved unit still rides on the line and is saved back unchanged), and the
   Day column is hidden: every line opens on Day 1 and the column is drawn
   only when a line already sits on a later day or the section's "Multi-day
   job" link was pressed. Since 2026-11-05 (Elise) only a Labor line picks a
   day — trips, parts and the rest are not repeated per day. The OT multiplier comes from the quote's contract
   when one covers the work order (0046), else ×1.5.

   Picking the Labor type on a line whose description is still blank fills it
   with "Labor tech N"; since 2026-11-06 (Elise) N counts per DAY — the same
   tech goes back each day — and every "Labor tech N" is kept in order within
   its day (renumberLaborLines). */

import { useEffect, useRef } from 'react';
import { lineTakesOt } from '@theone/shared';
import type { DraftLine } from '../../lib/quoteDraft';
import { LINE_TYPES, blankLine, cardRateFor, fillCardRates, dayChoices, isAutoLaborDescription, moveItem, nextLaborDescription, removeAt, renumberLaborLines, replaceAt } from '../../lib/quoteDraft';
import { OT_MULTIPLIER, lineAmount, lineErrors, lineFieldId, lineTax, usd } from '../../lib/quoteTotals';
import { useReorder } from '../../hooks/useReorder';
import type { LaborRate } from '../../api/client';
import { Icon } from '../Icon';

/** True when a line sits past Day 1 — the Day column must then be drawn. */
export function linesSpanDays(lines: readonly DraftLine[]): boolean {
  return lines.some((l) => Number(l.day_value || '1') > 1);
}

interface LineItemsTableProps {
  /** Screen-reader caption + the aria-label stem for every control ("Option A"). */
  label: string;
  lines: DraftLine[];
  editable: boolean;
  /** Errors only paint once the operator has tried to submit. */
  showErrors: boolean;
  onChange: (lines: DraftLine[]) => void;
  /** 0046 · the multiplier an OT line bills at; the house ×1.5 by default. */
  otMultiplier?: number;
  /** Draw the Day column (a multi-day job). Forced on when a line is past Day 1. */
  showDay?: boolean;
  /** 2026-11-04 · draw the Tax % column (only an SFM quote carries tax). */
  showTax?: boolean;
  /** 2026-11-10 · the work order's rate card (Prices first, then the Yoda
      labor rate). A Labor or Trip line whose rate is blank takes its figure. */
  rate?: LaborRate | null;
}

export function LineItemsTable({
  label,
  lines,
  editable,
  showErrors,
  onChange: emit,
  otMultiplier = OT_MULTIPLIER,
  showDay = false,
  showTax = true,
  rate = null,
}: LineItemsTableProps) {
  // Every edit re-counts the "Labor tech N" names per day (2026-11-06).
  const onChange = (next: DraftLine[]) => emit(renumberLaborLines(next));
  // …and lines already on the form (an older quote, a restored copy) are put
  // right as soon as they are drawn, not on the next edit.
  useEffect(() => {
    if (!editable) return;
    const fixed = renumberLaborLines(lines);
    if (fixed !== lines) emit(fixed);
  }, [lines, editable, emit]);
  // 2026-11-10 (Elise) · labor and trip rates follow Prices: once, when the
  // quote opens with the rate card known, a Labor / Trip line still at no
  // rate (blank or $0 — a quote opened before its card existed) takes the
  // card's figure. Never again after that, so a rate typed as 0 stays 0.
  const filledOnce = useRef(false);
  useEffect(() => {
    if (filledOnce.current || !editable || !rate) return;
    filledOnce.current = true;
    const fixed = fillCardRates(lines, rate);
    if (fixed !== lines) emit(fixed);
  }, [lines, editable, emit, rate]);
  /** The card's rate for a line whose type or description was just set,
      when its rate is still blank; else its own rate. */
  const rateAfter = (line: DraftLine, next: Pick<DraftLine, 'line_type' | 'description'>): string => {
    if (line.rate.trim() !== '' && Number(line.rate) !== 0) return line.rate;
    const v = cardRateFor(next, rate);
    return v == null ? line.rate : v.toFixed(2);
  };
  const reorder = useReorder((from, to) => onChange(moveItem(lines, from, to)));
  const otText = `${Number.isInteger(otMultiplier * 100) ? otMultiplier : otMultiplier.toFixed(3)}×`;
  const dayColumn = showDay || linesSpanDays(lines);
  const columns = 8 + (dayColumn ? 1 : 0) + (showTax ? 1 : 0);

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
              Unit price <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
            </th>
            {showTax && (
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
            )}
            {dayColumn && (
              <th className="c-day">
                Day
                <button
                  type="button"
                  className="qmk"
                  title="Multi-day jobs: lines are grouped “Day N” on the client summary and the invoice"
                  aria-label="About the Day column: on multi-day jobs lines are grouped Day N on the client summary and the invoice"
                >
                  ?
                </button>
              </th>
            )}
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
              <td colSpan={columns}>
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
                    className={`fld${errs.type ? ' is-err' : ''}`}
                    id={lineFieldId(line.key, 'type')}
                    aria-label={`${label} line ${n} type`}
                    aria-invalid={errs.type ? true : undefined}
                    value={line.line_type}
                    disabled={!editable}
                    onChange={(e) => {
                      const line_type = e.target.value as DraftLine['line_type'];
                      // Labor fills a blank description with "Labor tech N".
                      const description =
                        line_type === 'labor' && line.description.trim() === ''
                          ? nextLaborDescription(lines, i)
                          : line.description;
                      // Only labor repeats per day: any other type sits on Day 1.
                      const day_value = line_type === 'labor' ? line.day_value : '1';
                      // 2026-11-09 · overtime is for labor only.
                      const ot = lineTakesOt(line_type) ? line.ot : false;
                      set(i, { line_type, description, day_value, ot, rate: rateAfter(line, { line_type, description }) });
                    }}
                  >
                    {/* 2026-10-27 · a new line opens with no type picked. */}
                    {line.line_type === '' && <option value="">Type…</option>}
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
                    onBlur={() => {
                      const r = rateAfter(line, line);
                      if (r !== line.rate) set(i, { rate: r });
                    }}
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
                {showTax && (
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
                )}
                {dayColumn && (
                  <td>
                    {/* 2026-11-05 · only a labor line picks its day; a line of
                        another type saved past Day 1 still shows it so it can be
                        put back. */}
                    {(line.line_type === 'labor' || Number(line.day_value || '1') > 1) && (
                    <select
                      className="fld"
                      aria-label={`${label} line ${n} day`}
                      value={line.day_value || '1'}
                      disabled={!editable}
                      onChange={(e) => {
                        const day_value = e.target.value;
                        // A labor line still named "Labor tech N" is renumbered
                        // for its new day: each day starts at Labor tech 1.
                        const description =
                          line.line_type === 'labor' && isAutoLaborDescription(line.description)
                            ? nextLaborDescription(lines, i, day_value)
                            : line.description;
                        set(i, { day_value, description });
                      }}
                    >
                      {dayChoices(lines, i).map((d) => (
                        <option key={d} value={d}>Day {d}</option>
                      ))}
                    </select>
                    )}
                  </td>
                )}
                <td>
                  {/* The checkbox carries a visible "OT" label, not a bare box:
                      an unlabelled toggle in a money column is unreadable. */}
                  {/* 2026-11-09 (Elise) · only a Labor line takes overtime. */}
                  {lineTakesOt(line.line_type) && (
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
                  )}
                </td>
                <td className="ta-r">
                  <span className={`ro num${amount == null ? ' is-empty' : ''}`}>
                    {amount == null ? '—' : usd(amount)}
                  </span>
                  {showTax && tax != null && tax > 0 && (
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
    the read-only-amount note and the subtotal chip. When the WO's labor rate
    is known (Yoda LaborRate per Comp × FM × Trade) the Yoda presets sit beside
    it: Tech hour, Helper hour, Trip, After-hours, Holiday. `onToggleDay` draws
    the "Multi-day job" toggle that reveals the hidden Day column; since
    2026-11-10 (Elise) pressing it again turns the job back into one day —
    every line returns to Day 1 and the column hides. */
export function AddLineButton({
  lines,
  onChange,
  rate,
  dayOn = false,
  onToggleDay,
}: {
  lines: DraftLine[];
  onChange: (l: DraftLine[]) => void;
  rate?: LaborRate | null;
  /** The Day column is drawn (pressed, or a line already past Day 1). */
  dayOn?: boolean;
  onToggleDay?: (on: boolean) => void;
}) {
  const multiDay = dayOn || linesSpanDays(lines);
  const toggleDay = () => {
    if (!onToggleDay) return;
    if (multiDay) {
      if (linesSpanDays(lines)) onChange(lines.map((l) => (Number(l.day_value || '1') > 1 ? { ...l, day_value: '1' } : l)));
      onToggleDay(false);
    } else {
      onToggleDay(true);
    }
  };
  const preset = (label: string, value: number | null, line_type: DraftLine['line_type'], description: string) =>
    value == null ? null : (
      <button
        key={label}
        type="button"
        className="chip chip-sm"
        title={`Add a ${label.toLowerCase()} line at ${usd(value)}`}
        onClick={() =>
          onChange([...lines, { ...blankLine(), line_type, description, rate: value.toFixed(2) }])
        }
      >
        <Icon name="plus" size={12} />
        {label} {usd(value)}
      </button>
    );

  return (
    <span className="lt-add">
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...lines, blankLine()])}>
        <Icon name="plus" size={12} />
        Add line
      </button>
      {rate && (
        <span className="lt-presets" aria-label="Rate presets from the labor rate card">
          {preset('Tech hr', rate.tech_rate, 'labor', 'Tech — labor')}
          {preset('Helper hr', rate.helper_rate, 'labor', 'Helper — labor')}
          {preset('Trip', rate.trip_rate, 'service', 'Trip charge')}
          {preset('After-hours', rate.afterhours_rate, 'labor', 'Tech — after-hours labor')}
          {preset('Holiday', rate.holiday_rate, 'labor', 'Tech — holiday labor')}
        </span>
      )}
      {onToggleDay && (
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-pressed={multiDay}
          title={
            multiDay
              ? 'Back to a one-day job — every line returns to Day 1 and the Day column hides'
              : 'Show the Day column — labor lines are grouped Day N on the client summary and the invoice'
          }
          onClick={toggleDay}
        >
          <Icon name={multiDay ? 'x' : 'layers'} size={12} />
          {multiDay ? 'One-day job' : 'Multi-day job'}
        </button>
      )}
    </span>
  );
}

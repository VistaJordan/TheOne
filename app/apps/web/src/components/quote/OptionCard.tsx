/* One PROPOSED option (comp: .opt-card) — its letter tag, name, include-in-
   summary switch, scope list and line-item table.

   The A / B / C letter is DERIVED from position and never stored, so deleting
   Option A promotes B to A with no data migration (0003 header).

   Since 2026-10-22 (Elise): a quote with ONE option has no choice to name, so
   the lone option draws no letter and no name box and reads "Proposed"
   (`sole`); both appear on every option once "Add another option" was
   pressed. The option's "required is to…" is the same numbered scope list
   the Incurred section uses (ScopeList on `scope_lines`). Since 2026-10-27
   it has its own "Tech reported that…" line too (the section's narrative,
   optional here, required on Incurred), above the list.

   Yoda parity: an option that belongs to a decided round renders LOCKED (its
   history is the client's record), carries an "Approved" or "Declined" badge,
   and — while the quote is Sent — offers the "Client chose this option" action
   to whoever may record the client decision. */

import { useEffect, useRef, type ReactNode } from 'react';
import { optionDisplayLabel } from '@theone/shared';
import type { DraftLine, DraftSection } from '../../lib/quoteDraft';
import { optionTag } from '../../lib/quoteDraft';
import { excludedNote, sumLines, usd } from '../../lib/quoteTotals';
import type { LaborRate } from '../../api/client';
import { AddLineButton, LineItemsTable } from './LineItemsTable';
import { ScopeList } from './ScopeList';
import { Icon } from '../Icon';

interface OptionCardProps {
  section: DraftSection;
  /** 0-based position among the OPTION sections of ITS round — drives the letter. */
  index: number;
  /** True when this is the only option of its round: no letter, no name. */
  sole?: boolean;
  editable: boolean;
  showErrors: boolean;
  /** The option's client price under the active total rule (null while invalid). */
  grandTotal?: number | null;
  rate?: LaborRate | null;
  /** Rendered in the card header when the client decision is open (Sent). */
  decisionActions?: ReactNode;
  onChange: (next: DraftSection) => void;
  onRemove: () => void;
  /** 0046 · the multiplier an OT line bills at; the house ×1.5 by default. */
  otMultiplier?: number;
  /** The "Multi-day job" link revealed the Day column for this option. */
  showDay?: boolean;
  onShowDay?: () => void;
}

export function OptionCard({
  section,
  index,
  sole = false,
  editable,
  showErrors,
  grandTotal,
  rate,
  decisionActions,
  onChange,
  onRemove,
  otMultiplier,
  showDay,
  onShowDay,
}: OptionCardProps) {
  const label = optionDisplayLabel(`Option ${optionTag(index)}`, sole ? 1 : 2);
  const totals = sumLines(section.lines, otMultiplier);
  const note = excludedNote(totals.excluded);
  const nameId = `opt-${section.key}-name`;
  const canEdit = editable && !section.locked;
  const nameErr = !sole && canEdit && showErrors && section.name.trim() === '';
  const declined = section.rejection_note !== null && !section.approved;

  const setLines = (lines: DraftLine[]) => onChange({ ...section, lines });

  // "Tech reported that…" is one line that grows with its text, as on Incurred.
  const reportRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = reportRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [section.narrative]);

  return (
    <div className={`opt-card${section.approved ? ' is-approved' : ''}${declined ? ' is-declined' : ''}${section.locked ? ' is-locked' : ''}`}>
      <div className="opt-head">
        {!sole && <span className="opt-tag" aria-hidden="true">{optionTag(index)}</span>}
        {sole ? (
          <span className="lbl" style={{ flex: 1, minWidth: 160, alignSelf: 'center' }}>
            {label}
            {section.round > 1 && <span className="chip chip-sm chip-outline" style={{ marginLeft: 6 }}>Round {section.round}</span>}
          </span>
        ) : (
          <div className="field" style={{ flex: 1, minWidth: 240 }}>
            <label className="lbl" htmlFor={nameId}>
              Option name <span className="req" aria-hidden="true">*</span>
              <span className="sr">required</span>
              {section.round > 1 && <span className="chip chip-sm chip-outline" style={{ marginLeft: 6 }}>Round {section.round}</span>}
            </label>
            <input
              className={`fld${nameErr ? ' is-err' : ''}`}
              id={nameId}
              value={section.name}
              disabled={!canEdit}
              aria-invalid={nameErr ? true : undefined}
              aria-describedby={nameErr ? `${nameId}-err` : undefined}
              onChange={(e) => onChange({ ...section, name: e.target.value })}
            />
            {nameErr && (
              <span className="err" id={`${nameId}-err`}>
                <Icon name="alert" size={12} />
                {label} needs a name
              </span>
            )}
          </div>
        )}

        {section.approved ? (
          <span className="chip chip-accent" style={{ alignSelf: 'flex-end', marginBottom: 6 }}>
            <Icon name="check-circle" size={12} />
            Client approved
          </span>
        ) : declined ? (
          <span className="chip chip-danger" style={{ alignSelf: 'flex-end', marginBottom: 6 }}>
            <Icon name="x" size={12} />
            Declined
          </span>
        ) : (
          <label className="sw" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
            <input
              type="checkbox"
              checked={section.include_in_summary}
              disabled={!canEdit}
              onChange={(e) => onChange({ ...section, include_in_summary: e.target.checked })}
            />
            <span className="sw-track" aria-hidden="true" />
            <span>Include in summary</span>
            <span className="sw-state">{section.include_in_summary ? 'On' : 'Off'}</span>
          </label>
        )}

        {decisionActions}

        {canEdit && (
          <button
            type="button"
            className="btn btn-icon btn-sm"
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
            style={{ alignSelf: 'flex-end', marginBottom: 4 }}
            onClick={onRemove}
          >
            <Icon name="trash" size={14} />
          </button>
        )}
        {section.locked && !canEdit && (
          <span className="ro-chip" style={{ alignSelf: 'flex-end', marginBottom: 6 }} title="Decided rounds are read-only">
            <Icon name="lock" size={12} />
            Locked
          </span>
        )}
      </div>

      {declined && section.rejection_note && (
        <div className="callout callout-lock" style={{ margin: '0 14px 10px' }}>
          <Icon name="info" size={14} />
          <span><b>Client said:</b> {section.rejection_note}</span>
        </div>
      )}

      <div className="opt-body">
        {(canEdit || section.narrative.trim() !== '') && (
          <div className="field">
            <label className="lbl" htmlFor={`opt-${section.key}-report`}>Tech reported that…</label>
            <textarea
              className="fld fld-grow"
              id={`opt-${section.key}-report`}
              rows={1}
              ref={reportRef}
              value={section.narrative}
              disabled={!canEdit}
              onChange={(e) => onChange({ ...section, narrative: e.target.value })}
            />
          </div>
        )}

        <ScopeList
          sectionKey={section.key}
          lines={section.scope_lines}
          editable={canEdit}
          showError={showErrors && canEdit}
          onChange={(scope_lines) => onChange({ ...section, scope_lines })}
        />

        <LineItemsTable
          label={label}
          lines={section.lines}
          editable={canEdit}
          showErrors={showErrors && canEdit}
          otMultiplier={otMultiplier}
          showDay={showDay}
          onChange={setLines}
        />
      </div>

      <div className="opt-foot">
        {canEdit && <AddLineButton lines={section.lines} onChange={setLines} rate={rate} onShowDay={onShowDay} />}
        {note && (
          <span className="lt-note">
            <Icon name="alert" size={12} />
            {note}
          </span>
        )}
        <span className="subtotal-chip" style={{ marginLeft: 'auto' }}>
          {label} lines <b className="num">{usd(totals.total)}</b>
        </span>
        {grandTotal != null && (
          <span className="subtotal-chip is-grand" title="Incurred + this option, plus sales tax">
            Client price <b className="num">{usd(grandTotal)}</b>
          </span>
        )}
      </div>
    </div>
  );
}

/* One PROPOSED option (comp: .opt-card) — its letter tag, name, include-in-
   summary switch, narrative and line-item table.

   The A / B / C letter is DERIVED from position and never stored, so deleting
   Option A promotes B to A with no data migration (0003 header).

   Yoda parity: an option that belongs to a decided round renders LOCKED (its
   history is the client's record), carries an "Approved" or "Declined" badge,
   and — while the quote is Sent — offers the "Client chose this option" action
   to whoever may record the client decision. */

import type { ReactNode } from 'react';
import type { DraftLine, DraftSection } from '../../lib/quoteDraft';
import { optionTag } from '../../lib/quoteDraft';
import { excludedNote, sumLines, usd } from '../../lib/quoteTotals';
import type { LaborRate } from '../../api/client';
import { AddLineButton, LineItemsTable } from './LineItemsTable';
import { Icon } from '../Icon';

interface OptionCardProps {
  section: DraftSection;
  /** 0-based position among the OPTION sections of ITS round — drives the letter. */
  index: number;
  editable: boolean;
  showErrors: boolean;
  /** The option's client price under the active total rule (null while invalid). */
  grandTotal?: number | null;
  rate?: LaborRate | null;
  /** Rendered in the card header when the client decision is open (Sent). */
  decisionActions?: ReactNode;
  onChange: (next: DraftSection) => void;
  onRemove: () => void;
}

export function OptionCard({
  section,
  index,
  editable,
  showErrors,
  grandTotal,
  rate,
  decisionActions,
  onChange,
  onRemove,
}: OptionCardProps) {
  const label = `Option ${optionTag(index)}`;
  const totals = sumLines(section.lines);
  const note = excludedNote(totals.excluded);
  const nameId = `opt-${section.key}-name`;
  const narrId = `opt-${section.key}-narr`;
  const canEdit = editable && !section.locked;
  const nameErr = canEdit && showErrors && section.name.trim() === '';
  const narrErr = canEdit && showErrors && section.narrative.trim() === '';
  const declined = section.rejection_note !== null && !section.approved;

  const setLines = (lines: DraftLine[]) => onChange({ ...section, lines });

  return (
    <div className={`opt-card${section.approved ? ' is-approved' : ''}${declined ? ' is-declined' : ''}${section.locked ? ' is-locked' : ''}`}>
      <div className="opt-head">
        <span className="opt-tag" aria-hidden="true">{optionTag(index)}</span>
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
        <div className="field">
          <label className="lbl" htmlFor={narrId}>
            Option narrative — required is to… <span className="req" aria-hidden="true">*</span>
            <span className="sr">required</span>
          </label>
          <textarea
            className={`fld${narrErr ? ' is-err' : ''}`}
            id={narrId}
            rows={6}
            value={section.narrative}
            disabled={!canEdit}
            aria-invalid={narrErr ? true : undefined}
            aria-describedby={narrErr ? `${narrId}-err` : undefined}
            onChange={(e) => onChange({ ...section, narrative: e.target.value })}
          />
          {narrErr && (
            <span className="err" id={`${narrId}-err`}>
              <Icon name="alert" size={12} />
              {label} needs a narrative
            </span>
          )}
        </div>

        <LineItemsTable
          label={label}
          lines={section.lines}
          editable={canEdit}
          showErrors={showErrors && canEdit}
          onChange={setLines}
        />
      </div>

      <div className="opt-foot">
        {canEdit && <AddLineButton lines={section.lines} onChange={setLines} rate={rate} />}
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

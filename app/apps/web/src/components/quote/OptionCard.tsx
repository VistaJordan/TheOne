/* One PROPOSED option (comp: .opt-card) — its letter tag, name, include-in-
   summary switch, narrative and line-item table.

   The A / B / C letter is DERIVED from position and never stored, so deleting
   Option A promotes B to A with no data migration (0003 header). */

import type { DraftLine, DraftSection } from '../../lib/quoteDraft';
import { optionTag } from '../../lib/quoteDraft';
import { excludedNote, sumLines, usd } from '../../lib/quoteTotals';
import { AddLineButton, LineItemsTable } from './LineItemsTable';
import { Icon } from '../Icon';

interface OptionCardProps {
  section: DraftSection;
  /** 0-based position among the OPTION sections — drives the derived letter. */
  index: number;
  editable: boolean;
  showErrors: boolean;
  onChange: (next: DraftSection) => void;
  onRemove: () => void;
}

export function OptionCard({ section, index, editable, showErrors, onChange, onRemove }: OptionCardProps) {
  const label = `Option ${optionTag(index)}`;
  const totals = sumLines(section.lines);
  const note = excludedNote(totals.excluded);
  const nameId = `opt-${section.key}-name`;
  const narrId = `opt-${section.key}-narr`;
  const nameErr = showErrors && section.name.trim() === '';
  const narrErr = showErrors && section.narrative.trim() === '';

  const setLines = (lines: DraftLine[]) => onChange({ ...section, lines });

  return (
    <div className="opt-card">
      <div className="opt-head">
        <span className="opt-tag" aria-hidden="true">{optionTag(index)}</span>
        <div className="field" style={{ flex: 1, minWidth: 240 }}>
          <label className="lbl" htmlFor={nameId}>
            Option name <span className="req" aria-hidden="true">*</span>
            <span className="sr">required</span>
          </label>
          <input
            className={`fld${nameErr ? ' is-err' : ''}`}
            id={nameId}
            value={section.name}
            disabled={!editable}
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

        <label className="sw" style={{ alignSelf: 'flex-end', paddingBottom: 6 }}>
          <input
            type="checkbox"
            checked={section.include_in_summary}
            disabled={!editable}
            onChange={(e) => onChange({ ...section, include_in_summary: e.target.checked })}
          />
          <span className="sw-track" aria-hidden="true" />
          <span>Include in summary</span>
          <span className="sw-state">{section.include_in_summary ? 'On' : 'Off'}</span>
        </label>

        {editable && (
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
      </div>

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
            disabled={!editable}
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
          editable={editable}
          showErrors={showErrors}
          onChange={setLines}
        />
      </div>

      <div className="opt-foot">
        {editable && <AddLineButton lines={section.lines} onChange={setLines} />}
        {note && (
          <span className="lt-note">
            <Icon name="alert" size={12} />
            {note}
          </span>
        )}
        <span className="subtotal-chip" style={{ marginLeft: 'auto' }}>
          {label} total <b className="num">{usd(totals.total)}</b>
        </span>
      </div>
    </div>
  );
}

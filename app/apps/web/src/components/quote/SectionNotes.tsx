/* A quote section's own specs and note to the customer (migration 0146,
   Elise 2026-11-16). Every section carries them — the Incurred card and each
   option of every round. Specs are internal (never printed or sent); the
   note prints under its section in the summary and on the printed quote.
   A read-only section draws only what was written. */

import type { DraftSection } from '../../lib/quoteDraft';
import { Icon } from '../Icon';

interface SectionNotesProps {
  section: DraftSection;
  editable: boolean;
  onChange: (next: DraftSection) => void;
}

export function SectionNotes({ section, editable, onChange }: SectionNotesProps) {
  const showSpecs = editable || section.specs.trim() !== '';
  const showNote = editable || section.note_to_customer.trim() !== '';
  if (!showSpecs && !showNote) return null;
  const specsId = `sec-${section.key}-specs`;
  const noteId = `sec-${section.key}-note`;
  return (
    <div className="sec-notes">
      {showSpecs && (
        <div className="field">
          <label className="lbl" htmlFor={specsId}>
            Equipment &amp; part specs <span className="opt">internal · optional</span>
          </label>
          <textarea
            className="fld"
            id={specsId}
            rows={2}
            value={section.specs}
            disabled={!editable}
            onChange={(e) => onChange({ ...section, specs: e.target.value })}
          />
          <span className="hint">Not sent to the client — kept for the tech and for warranty claims.</span>
        </div>
      )}
      {showNote && (
        <div className="field">
          <label className="lbl" htmlFor={noteId}>
            Note to customer <span className="opt">optional</span>
            <span className="chip chip-sm chip-accent" style={{ marginLeft: 6 }}>
              <Icon name="globe" size={12} />
              Client-visible
            </span>
          </label>
          <textarea
            className="fld"
            id={noteId}
            rows={2}
            value={section.note_to_customer}
            disabled={!editable}
            onChange={(e) => onChange({ ...section, note_to_customer: e.target.value })}
          />
          <span className="hint">Prints under this section in the text your client sees.</span>
        </div>
      )}
    </div>
  );
}

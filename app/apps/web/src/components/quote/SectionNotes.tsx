/* A quote section's own specs and note to the customer (migration 0146,
   Elise 2026-11-16). Every section carries them — the Incurred card and each
   option of every round. Both print under their section in the summary and
   on the printed quote (specs since UAT #25, 2026-11-16 — they were internal).
   A read-only section draws only what was written.

   2026-11-19 (Elise, UAT follow-up) · both are client-visible and say so;
   they are small and sit to the right of the line items (`.lt-notes-row`),
   one line each, growing as more is written. */

import { useLayoutEffect, useRef } from 'react';
import type { DraftSection } from '../../lib/quoteDraft';
import { Icon } from '../Icon';

interface SectionNotesProps {
  section: DraftSection;
  editable: boolean;
  onChange: (next: DraftSection) => void;
}

/** One line tall, taller as the text needs. */
function GrowBox({ id, value, disabled, onChange }: { id: string; value: string; disabled: boolean; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="fld fld-grow sec-note-box"
      id={id}
      rows={1}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const ClientTag = () => (
  <span className="sec-note-tag" title="Printed for the client under this section">
    <Icon name="globe" size={12} />
    Client-visible
  </span>
);

export function SectionNotes({ section, editable, onChange }: SectionNotesProps) {
  const showSpecs = editable || section.specs.trim() !== '';
  const showNote = editable || section.note_to_customer.trim() !== '';
  if (!showSpecs && !showNote) return null;
  const specsId = `sec-${section.key}-specs`;
  const noteId = `sec-${section.key}-note`;
  return (
    <div className="sec-notes">
      {showSpecs && (
        <div className="sec-note">
          <label className="sec-note-lbl" htmlFor={specsId}>
            Equipment &amp; part specs
            <ClientTag />
          </label>
          <GrowBox id={specsId} value={section.specs} disabled={!editable} onChange={(specs) => onChange({ ...section, specs })} />
        </div>
      )}
      {showNote && (
        <div className="sec-note">
          <label className="sec-note-lbl" htmlFor={noteId}>
            Note to customer
            <ClientTag />
          </label>
          <GrowBox
            id={noteId}
            value={section.note_to_customer}
            disabled={!editable}
            onChange={(note_to_customer) => onChange({ ...section, note_to_customer })}
          />
        </div>
      )}
    </div>
  );
}

/* The "Required is to…" scope list (comp: .scope). A numbered, drag-reorderable
   list of one-line strings — the ordered steps that become the numbered block in
   the client summary, which is why order is editable at all. */

import type { KeyboardEvent } from 'react';
import { moveItem, removeAt, replaceAt } from '../../lib/quoteDraft';
import { scopeFieldId } from '../../lib/quoteTotals';
import { useReorder } from '../../hooks/useReorder';
import { Icon } from '../Icon';

interface ScopeListProps {
  sectionKey: string;
  lines: string[];
  editable: boolean;
  onChange: (lines: string[]) => void;
}

export function ScopeList({ sectionKey, lines, editable, onChange }: ScopeListProps) {
  const reorder = useReorder((from, to) => onChange(moveItem(lines, from, to)));
  const labelId = `scope-lbl-${sectionKey}`;

  // Enter at the end of a line opens the next one — the list is written top to
  // bottom in one pass, and reaching for "Add scope line" every time breaks it.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const next = [...lines];
    next.splice(index + 1, 0, '');
    onChange(next);
    window.requestAnimationFrame(() => {
      document.getElementById(scopeFieldId(sectionKey, index + 1))?.focus();
    });
  };

  return (
    <div className="field">
      <span className="lbl" id={labelId}>
        Required is to… <span className="req" aria-hidden="true">*</span>
        <span className="sr">required</span> <span className="opt">scope of work</span>
      </span>
      <ol className="scope" aria-labelledby={labelId}>
        {lines.map((line, i) => (
          <li className="scope-row" key={`${sectionKey}-scope-${i}`} {...(editable ? reorder.rowProps(i) : {})}>
            {editable && (
              <button
                type="button"
                className="drag"
                aria-label={`Reorder scope line ${i + 1} — use arrow up and arrow down`}
                title="Drag, or use the arrow keys, to reorder"
                {...reorder.gripProps(i)}
              >
                <Icon name="grip" size={14} />
              </button>
            )}
            <span className="scope-n num">{i + 1}</span>
            <input
              className="fld"
              id={scopeFieldId(sectionKey, i)}
              aria-label={`Scope line ${i + 1}`}
              value={line}
              disabled={!editable}
              onChange={(e) => onChange(replaceAt(lines, i, e.target.value))}
              onKeyDown={(e) => onKeyDown(e, i)}
            />
            {editable && (
              <button
                type="button"
                className="rowdel"
                aria-label={`Remove scope line ${i + 1}`}
                onClick={() => onChange(lines.length === 1 ? [''] : removeAt(lines, i))}
              >
                <Icon name="trash" size={14} />
              </button>
            )}
          </li>
        ))}
      </ol>
      {editable && (
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onChange([...lines, ''])}>
            <Icon name="plus" size={12} />
            Add scope line
          </button>
        </div>
      )}
    </div>
  );
}

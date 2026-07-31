/* The client-facing summary block (comp: right rail #4).

   Two states, and the difference matters commercially: by default the text is
   AUTO — regenerated server-side from the narratives, the included lines and the
   totals on every read. "Edit text" PINS a hand-written version and stops that
   sync, which is why the pinned state says so out loud and offers a way back. */

import { useEffect, useState } from 'react';
import { usd } from '../../lib/quoteTotals';
import { Icon } from '../Icon';

interface SummaryCardProps {
  /** The API's generated text. */
  auto: string;
  /** Non-null once someone used "Edit text". */
  pinned: string | null;
  grandTotal: number;
  editable: boolean;
  onPinnedChange: (next: string | null) => void;
}

export function SummaryCard({ auto, pinned, grandTotal, editable, onPinnedChange }: SummaryCardProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(pinned ?? auto);

  // While the operator is typing, the local buffer wins; otherwise follow the
  // server (the auto text is rewritten on every autosave round-trip).
  useEffect(() => {
    if (!editing) setText(pinned ?? auto);
  }, [editing, pinned, auto]);

  const startEditing = () => {
    setText(pinned ?? auto);
    setEditing(true);
  };

  const commit = () => {
    setEditing(false);
    onPinnedChange(text);
  };

  const unpin = () => {
    setEditing(false);
    onPinnedChange(null);
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Summary</h2>
        {editable && !editing && (
          <button type="button" className="btn btn-sm" onClick={startEditing}>
            <Icon name="pencil" size={12} />
            Edit text
          </button>
        )}
        {editable && editing && (
          <button type="button" className="btn btn-sm btn-primary" onClick={commit}>
            <Icon name="check" size={12} />
            Save text
          </button>
        )}
        {editable && pinned !== null && !editing && (
          <button
            type="button"
            className="btn btn-sm btn-icon"
            aria-label="Discard the pinned text and resume auto-generating this summary"
            title="Resume auto-generating this summary"
            onClick={unpin}
          >
            <Icon name="refresh" size={14} />
          </button>
        )}
      </div>

      <div className="sum-body">
        {editing ? (
          <textarea
            className="fld sum-text"
            aria-label="Client summary text"
            rows={22}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        ) : (
          <div
            className={`sum-text${(pinned ?? auto).trim() === '' ? ' is-none' : ''}`}
            role="document"
            aria-label={pinned === null ? 'Auto-generated client summary' : 'Pinned client summary'}
          >
            {(pinned ?? auto).trim() === ''
              ? 'The summary is generated from the narratives and line items — it fills in as you build the quote.'
              : (pinned ?? auto)}
          </div>
        )}

        <div className="sum-foot">
          <span className="k">Grand total to client</span>
          <span className="v">{usd(grandTotal)}</span>
        </div>

        <p className="sum-cap">
          <Icon name="globe" size={12} />
          <span>
            This text syncs to the client&rsquo;s CMMS.{' '}
            {pinned === null ? (
              <>
                Regenerated from the narratives and line items on approval — <b>Edit text</b> pins a
                manual version and stops the auto-sync.
              </>
            ) : (
              <>
                <b>Pinned</b> — this is a manual version and no longer tracks the narratives or line
                items. Use the refresh control to resume auto-generating it.
              </>
            )}
          </span>
        </p>
      </div>
    </section>
  );
}

import { useEffect, useRef, type ComponentProps, type ReactNode } from 'react';
import { Icon } from './Icon';

type IconName = ComponentProps<typeof Icon>['name'];

interface ConfirmDialogProps {
  title: string;
  /** What is about to happen — one or two short sentences. */
  message: ReactNode;
  /** The consequence, set apart in a tinted strip: what cannot be undone, or
      how to get it back. Its tone follows `danger` unless overridden. */
  note?: ReactNode;
  noteTone?: 'danger' | 'info';
  /** The icon in the tinted chip beside the title. Defaults to a trash can
      for destructive dialogs and an info mark otherwise. */
  icon?: IconName;
  /** The verb on the confirming button, e.g. "Delete view". Never "OK". */
  confirmLabel: string;
  /** Styles the dialog as destructive. */
  danger?: boolean;
  /** While the action runs: both buttons disable and the label shows it. */
  busy?: boolean;
  busyLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The in-app replacement for `window.confirm`. Same shell as the other
 * dialogs, so it looks like part of the product rather than the browser.
 *
 * Cancel takes focus on open: Enter on a freshly opened destructive dialog
 * should never delete anything. Escape and the scrim cancel too.
 */
export function ConfirmDialog({
  title,
  message,
  note,
  noteTone,
  icon,
  confirmLabel,
  danger,
  busy,
  busyLabel,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const tone = danger ? 'danger' : 'info';
  const noteKind = noteTone ?? tone;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-scrim" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className={`modal is-narrow confirm is-${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name={icon ?? (danger ? 'trash' : 'info')} size={18} />
          </span>
          <h2 id="confirm-title">{title}</h2>
        </div>
        <div className="modal-body">
          <p className="confirm-message" id="confirm-message">
            {message}
          </p>
          {note && (
            <p className={`confirm-note is-${noteKind}`}>
              <Icon name={noteKind === 'danger' ? 'alert-circle' : 'info'} size={14} />
              <span>{note}</span>
            </p>
          )}
        </div>
        <div className="modal-foot">
          <button
            type="button"
            className="btn-sm is-ghost"
            ref={cancelRef}
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn-sm${danger ? ' is-danger' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

interface PopoverProps {
  /** The button that opens it. Receives the open state so it can look pressed. */
  trigger: (api: { open: boolean; toggle: () => void }) => ReactNode;
  children: (api: { close: () => void }) => ReactNode;
  /** Anchor to the right edge — for triggers near the viewport edge. */
  align?: 'left' | 'right';
  className?: string;
  /** Extra class on the panel, for the wider ones (filters, columns). */
  panelClassName?: string;
}

/**
 * The dismiss behaviour every toolbar menu on this page needs: click outside to
 * close, Escape to close, and focus returned to the trigger afterwards.
 *
 * StatusChangeMenu grew its own copy of this back in S1. It is left alone —
 * it is load-bearing on the detail page — but everything added here shares one
 * implementation so the four new menus cannot drift apart in how they dismiss.
 */
export function Popover({ trigger, children, align = 'left', className, panelClassName }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      // Escape should leave the keyboard where it started, not at the top of
      // the document.
      rootRef.current?.querySelector<HTMLElement>('button')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={['pop-root', className].filter(Boolean).join(' ')} ref={rootRef}>
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={['pop-panel', align === 'right' ? 'is-right' : '', panelClassName]
            .filter(Boolean)
            .join(' ')}
        >
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </div>
  );
}

/** The toolbar button shape shared by every menu trigger on the list. */
export function ToolButton({
  active,
  pressed,
  onClick,
  children,
  title,
  disabled,
}: {
  /** The control is carrying a setting (filters applied, grouped, …). */
  active?: boolean;
  pressed?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`tool-btn${active ? ' is-active' : ''}${pressed ? ' is-open' : ''}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      aria-expanded={pressed}
    >
      {children}
    </button>
  );
}

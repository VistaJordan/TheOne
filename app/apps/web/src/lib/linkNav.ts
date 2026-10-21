// Opening things in a new tab from places that are not a plain <a>.
//
// A real link (<Link>, <a href>) already opens in a new tab on a middle-click
// or Ctrl / Cmd-click, so prefer one. Where a link cannot sit — a whole table
// row, a chart bar, a search hit chosen from a list — spread `linkTo(to)` on
// the element instead: a plain click navigates inside the app as before, and
// a middle-click or Ctrl / Cmd-click opens the page in a new tab.

import { useCallback } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';

/** A mouse or keyboard event: Ctrl / Cmd on either, the middle button on a mouse. */
export type Clickish = { button?: number; ctrlKey?: boolean; metaKey?: boolean };

/** Does this click ask for a new tab: the middle button, or Ctrl / Cmd held? */
export function wantsNewTab(e: Clickish | null | undefined): boolean {
  if (!e) return false;
  return e.button === 1 || Boolean(e.ctrlKey) || Boolean(e.metaKey);
}

export function openInNewTab(to: string): void {
  window.open(to, '_blank', 'noopener');
}

export interface LinkHandlers {
  onClick: (e: ReactMouseEvent) => void;
  onAuxClick: (e: ReactMouseEvent) => void;
  onMouseDown: (e: ReactMouseEvent) => void;
}

/** `go(to, event?)` navigates, or opens a new tab when the event asks for
 *  one; `linkTo(to)` is the three handlers to spread on a clickable element. */
export function useLinkNav(): { go: (to: string, e?: Clickish | null) => void; linkTo: (to: string) => LinkHandlers } {
  const navigate = useNavigate();
  const go = useCallback(
    (to: string, e?: Clickish | null) => {
      if (wantsNewTab(e)) openInNewTab(to);
      else navigate(to);
    },
    [navigate],
  );
  const linkTo = useCallback(
    (to: string): LinkHandlers => ({
      onClick: (e) => {
        e.preventDefault();
        go(to, e.nativeEvent);
      },
      // A middle-click fires auxclick, not click.
      onAuxClick: (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        openInNewTab(to);
      },
      // Keeps the browser's middle-button autoscroll from starting.
      onMouseDown: (e) => {
        if (e.button === 1) e.preventDefault();
      },
    }),
    [go],
  );
  return { go, linkTo };
}

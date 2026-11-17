/* No browser suggestions in OBI's boxes (Elise, 2026-11-17).
 *
 * The browser remembers what was typed in a box and offers it back the next
 * time ("test", "AMC" under Store). That is not our data and it misleads, so
 * every input and textarea that does not ask for something specific gets
 * autocomplete="off" — on the page now and on every one that appears later
 * (dialogs, drafts, the inline editors on a work order).
 *
 * A box that sets its own autocomplete (the sign-in's username and password,
 * a phone box's "tel-national") keeps it. Our own suggestion lists (the
 * <datalist> sub-categories, Google's addresses, pickers) are untouched: they
 * are drawn by the app, not by the browser's memory. */

const SKIP_TYPES = new Set(['checkbox', 'radio', 'file', 'hidden', 'submit', 'button', 'reset', 'range', 'color', 'image']);

function quiet(el: Element): void {
  if (el instanceof HTMLTextAreaElement) {
    if (!el.hasAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
    return;
  }
  if (el instanceof HTMLInputElement) {
    if (SKIP_TYPES.has(el.type) || el.hasAttribute('autocomplete')) return;
    el.setAttribute('autocomplete', 'off');
  }
}

function quietTree(root: ParentNode): void {
  root.querySelectorAll('input, textarea').forEach(quiet);
}

export function initNoAutofill(): void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  quietTree(document);
  new MutationObserver((records) => {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        quiet(n);
        quietTree(n);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  // Belt and braces: a box React re-created between observer ticks is caught
  // the moment it is focused, before the browser draws its list.
  document.addEventListener('focusin', (e) => { if (e.target instanceof Element) quiet(e.target); }, true);
}

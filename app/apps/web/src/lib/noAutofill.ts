/* No browser suggestions in OBI's boxes (Elise, 2026-11-17).
 *
 * The browser remembers what was typed in a box and offers it back the next
 * time ("test", "AMC" under Store). That is not our data and it misleads, so
 * every input and textarea that does not ask for something specific gets
 * autocomplete="off" — on the page now and on every one that appears later
 * (dialogs, drafts, the inline editors on a work order).
 *
 * 2026-11-19 (Elise): every box, including one that asked for something
 * specific (a phone box's "tel-national" offered remembered numbers). Only
 * the sign-in's username and password keep theirs, so a password manager
 * still works there. Our own suggestion lists (the
 * <datalist> sub-categories, Google's addresses, pickers) are untouched: they
 * are drawn by the app, not by the browser's memory. */

const SKIP_TYPES = new Set(['checkbox', 'radio', 'file', 'hidden', 'submit', 'button', 'reset', 'range', 'color', 'image']);

/** The only values a box keeps: signing in. */
const KEEP = new Set(['username', 'current-password', 'new-password']);

function quiet(el: Element): void {
  if (!(el instanceof HTMLTextAreaElement) && !(el instanceof HTMLInputElement)) return;
  if (el instanceof HTMLInputElement && SKIP_TYPES.has(el.type)) return;
  const own = (el.getAttribute('autocomplete') ?? '').trim().toLowerCase();
  if (KEEP.has(own) || own === 'off') return;
  el.setAttribute('autocomplete', 'off');
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

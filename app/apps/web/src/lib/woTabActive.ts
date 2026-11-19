/* Work-order tabs stay mounted once opened (Elise, 2026-11-19: "when we
 * switch between sections, our progress should not be lost"). A tab that is
 * not the open one is hidden, not unmounted, so a half-typed message, a
 * payment request or a penalty draft is still there when the person comes
 * back. Anything inside a tab that listens to the whole window (the Drive
 * drop zone) or draws outside its tab (the Quote tab's autosave chip beside
 * the tab strip) asks this whether its tab is the one showing. Outside the
 * work-order page it answers true. */

import { createContext, useContext } from 'react';

export const WoTabActiveContext = createContext(true);

export function useWoTabActive(): boolean {
  return useContext(WoTabActiveContext);
}

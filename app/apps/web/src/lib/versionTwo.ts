/**
 * Sections parked for Version 2 (Elise, 2026-10-27).
 *
 * A parked section keeps its sidebar item, drawn dimmed with a "V2" tag, and
 * its page answers with a "coming in Version 2" screen instead of the page
 * itself. Nothing is deleted: the pages, their routes, the API behind them
 * and every permission stay exactly as they are, so taking a name OUT of this
 * list reopens the section with no other change.
 *
 * Only the section's own page is parked. The top-bar bell still shows its
 * notices, and the API still answers for anyone who asks it directly.
 */
export const VERSION_TWO_SECTIONS: Readonly<Record<string, string>> = {
  Dashboard: 'Dashboards and their cards: counts, charts, trends and the shared boards.',
  Pulse: 'The Pulse: the clocks on what each work order is owed, and who should chase it.',
};

export function isVersionTwo(nav: string): boolean {
  return Object.prototype.hasOwnProperty.call(VERSION_TWO_SECTIONS, nav);
}

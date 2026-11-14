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

/** Parked sections already open to super admins (Elise, 2026-11-14: the
    Dashboard, with its AI usage tab, is theirs in this version; everyone else
    keeps the Version 2 screen until it is finished). Read from the person
    whose view it is — viewing as a dispatcher shows what they see. */
export const VERSION_TWO_OPEN_TO_SUPER_ADMINS: readonly string[] = ['Dashboard'];

/** Is this section parked for this person? Leave `superAdmin` out to ask
    about everyone. */
export function isVersionTwo(nav: string, superAdmin = false): boolean {
  if (!Object.prototype.hasOwnProperty.call(VERSION_TWO_SECTIONS, nav)) return false;
  return !(superAdmin && VERSION_TWO_OPEN_TO_SUPER_ADMINS.includes(nav));
}

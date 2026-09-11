// The order of the Approvals inbox (the manager's unified to-do list).
//
// Rule 7.2.2: what waits sorts OLDEST first; what is decided, newest first.
// Rule 7.3.3: an escalated work order's rows are pinned to the top of the
// waiting lanes whatever their age — oldest first within the pinned group,
// then everything else oldest first. The Done lane is history and is not
// re-ordered by the flag.
//
// Pure, so tests/escalations.test.ts can pin the order down without React.

export interface InboxOrderable {
  /** Rules 7.3.x: the work order behind the row is flagged Escalated. */
  escalated: boolean;
  /** ISO timestamp of when the row started waiting. */
  raised_at: string;
}

/** The inbox lanes (ApprovalsPage's `Lane`): 'done' is the only one that
    sorts newest first and ignores the flag. */
export type InboxLane = 'mine' | 'open' | 'done' | 'requests';

export function compareInboxRows(lane: InboxLane, a: InboxOrderable, b: InboxOrderable): number {
  if (lane !== 'done' && a.escalated !== b.escalated) return a.escalated ? -1 : 1;
  const dir = lane === 'done' ? -1 : 1;
  return dir * a.raised_at.localeCompare(b.raised_at);
}

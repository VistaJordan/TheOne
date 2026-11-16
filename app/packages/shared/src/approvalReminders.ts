// Reminders to managers (Elise, 2026-11-16, UAT #48). A dispatcher or the OP
// Admin waiting on a manager's yes — a status change, an NTE or money hold, a
// quote, a payment request, an NTE increase, a purchase request — presses
// **Send reminder** in the work order's header and picks the approval; the
// managers who may decide it get a notice. Pure: who may send, what each
// pending approval is called, the cool-down. The database half is the API's
// `services/approvalReminders.ts`.

import { DISPATCHER_ROLE_CODES } from './access';

/** Who may send a reminder: the dispatcher tiers (OM Under Probation, OM,
    Senior OM) and the OP Admin. A super admin always may. */
export const APPROVAL_REMINDER_ROLES: readonly string[] = [...DISPATCHER_ROLE_CODES, 'oa'];

export function mayRemindApprovals(role: string | null | undefined, isSuperAdmin: boolean): boolean {
  return isSuperAdmin || (role != null && APPROVAL_REMINDER_ROLES.includes(role));
}

/** The notice kind; always shown, whether or not the manager is on the job
    (a reminder goes to whoever decides it). */
export const APPROVAL_REMINDER_NOTICE_KIND = 'approval_reminder';

/** One reminder per approval per this many minutes, whoever sends it. */
export const APPROVAL_REMINDER_COOLDOWN_MINUTES = 60;

export const APPROVAL_REMINDER_NOTE_MAX = 500;

/** The audit action of a sent reminder (entity task, field `reminder:<id>`). */
export const APPROVAL_REMINDER_ACTION = 'approval_reminder_sent';

export type PendingApprovalKind = 'task' | 'quote' | 'payment' | 'nte_request' | 'purchase';

export interface PendingApproval {
  kind: PendingApprovalKind;
  id: string;
  /** What is waiting, as the menu prints it. */
  label: string;
  /** Who asked, when known. */
  requested_by: string | null;
  waiting_since: string;
  /** The last reminder sent for it (ISO), else null. */
  reminded_at: string | null;
  /** When the next reminder may go (ISO), null = now. */
  next_reminder_at: string | null;
}

export interface PendingApprovalsResponse {
  items: PendingApproval[];
  /** The viewer may send reminders. */
  can_remind: boolean;
}

export interface ApprovalReminderResult {
  sent_to: number;
  item: PendingApproval;
}

/** The notice title. */
export function approvalReminderTitle(sender: string, label: string, woNumber: string): string {
  return `${sender} reminds you: ${label} on ${woNumber} is waiting for your decision`;
}

/** When the next reminder for an approval may go, given the last one. */
export function nextReminderAt(lastIso: string | null, now: Date = new Date()): string | null {
  if (!lastIso) return null;
  const next = new Date(new Date(lastIso).getTime() + APPROVAL_REMINDER_COOLDOWN_MINUTES * 60_000);
  return next.getTime() > now.getTime() ? next.toISOString() : null;
}

export function reminderTooSoonSentence(nextIso: string): string {
  const mins = Math.max(1, Math.ceil((new Date(nextIso).getTime() - Date.now()) / 60_000));
  return `A reminder for this was sent less than ${APPROVAL_REMINDER_COOLDOWN_MINUTES} minutes ago — try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}

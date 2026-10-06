// 0075 · The business rules register: every numbered BRD rule the system
// applies, where it is enforced, and whether it is built, partial or deferred.
// The numbers are the BRD's (product/The-One-BRD-*.docx and the rule
// paragraphs of CLAUDE.md).

import type { DocRule } from './types';

export const BUSINESS_RULES: DocRule[] = [
  // ── 1. Audit, photos, finances ──
  { id: '1.2.1', title: 'Every button is logged', statement: 'Every write, including admin changes, saved views, exports and quote revisions, lands in the one activity_log table with before/after snapshots and who did it.', enforced: 'services/woAudit.ts, services/adminAudit.ts; Admin › Audit log and the work order\'s Audit trail tab read it.', state: 'built' },
  { id: '1.2.2', title: 'The audit log is append-only', statement: 'No row of the audit log can be edited or deleted; a correction is a new row.', enforced: 'Database trigger (migration 0029) raises on UPDATE or DELETE.', state: 'built' },
  { id: '1.3.1', title: 'Uploads wait for approval', statement: 'Every photo or file uploaded on a work order is quarantined until a reviewer approves it; only reviewers and the uploader can see a pending or declined file.', enforced: 'services/attachments.ts (review_status); Photos card › Waiting for approval.', state: 'built' },
  { id: '1.3.2', title: 'Approval per file', statement: 'A reviewer approves or declines one file at a time and may reverse the decision.', enforced: 'POST …/attachments/:id/review.', state: 'built' },
  { id: '1.3.3', title: 'A file is classified when approved', statement: 'Approving needs a kind (before, after, sign-off, other) and may rename the file.', enforced: 'Photos card "What is it?" select.', state: 'built' },
  { id: '1.3.4', title: 'Reviewer permission', statement: 'Only roles with work_orders/attachments approve review files.', enforced: 'Permission tree; 0061 grants admin, TL, ATL, AM, OA, Senior OM, OM.', state: 'built' },
  { id: '1.5.2', title: 'NTE override', statement: 'When Cost goes above the client NTE an NTE override task is raised for a manager, and the quote and the payment cannot progress until it is decided.', enforced: 'Seeded automation (Cost changed to more than NTE → approval task nte_override); assertNoOpenNteOverride on quote approve/send and payment approve/send to Yoda (409).', state: 'built' },

  // ── 2. Work orders, statuses, clocks, flags, client systems ──
  { id: '2.2.2', title: 'Check-in moves On Site', statement: 'A technician check-in moves the work order to On Site (Assessment) for an assessment visit or On Site (Job) for a job or return trip.', enforced: 'moveOnSite in services/visits.ts, via changeStatus with source visit.', state: 'built' },
  { id: '2.3.1', title: 'Quote clock', statement: 'A quote is due 48 hours after the assessment check-out, counted in business time.', enforced: 'Computed field Quote Due Date, lib/businessDays.ts.', state: 'built' },
  { id: '2.3.2', title: 'Weekends and holidays do not count', statement: 'Saturdays, Sundays and the holiday table are skipped as whole days, in America/Chicago.', enforced: 'lib/businessDays.ts; Admin › Settings › Holidays.', state: 'built' },
  { id: '2.3.3', title: 'The clock is visible', statement: 'The due date is shown on the list, the Dates card and the CICO summary, red while the quote is still owed.', enforced: 'lib/quoteDue.ts in the web app.', state: 'built' },
  { id: '2.4.1', title: 'Dispatchers request status changes', statement: 'Roles in request mode cannot move a status directly; they raise a request a manager decides.', enforced: 'work_orders/status create vs edit; POST /work-orders/:id/status-request.', state: 'built' },
  { id: '2.4.2', title: 'One request per work order', statement: 'A second pick re-targets the open request instead of raising another.', enforced: 'requestStatusChange (200 re-targeted).', state: 'built' },
  { id: '2.4.3', title: 'The requester sees the decision', statement: 'The decision shows on the work order header and in My requests until acknowledged (Continue, Understood, Request again, Withdraw).', enforced: 'Approvals › My requests; POST …/acknowledge, …/withdraw.', state: 'built' },
  { id: '2.4.4', title: 'A request pauses nothing', statement: 'No timer stops while a request is open; the quote clock keys off visits.', enforced: 'No code needed, by design.', state: 'built' },
  { id: '2.5.1', title: 'Emergency flag', statement: 'An Emergency checkbox colours the work order red everywhere; client priority will set it once the portal connectors are live.', enforced: 'Field Emergency; EmergencyBadge; paused automation priority → urgent.', state: 'built' },
  { id: '2.6.1', title: 'Client Portal Type', statement: 'Every work order records which client CMMS it came from (Ecotrak, Corrigo, ServiceChannel).', enforced: 'Field Client Portal Type (Integrations section); the Ecotrak ingest stamps it.', state: 'built' },
  { id: '2.6.3', title: 'Ecotrak allowed transitions', statement: 'Every status change is checked against what Ecotrak would let a service provider set from the work order\'s current Ecotrak status.', enforced: 'checkEcotrakTransition in changeStatus; warn mode by default, block mode by ECOTRAK_TRANSITION_MODE.', state: 'built', note: 'Nothing is pushed to Ecotrak until go-live; the verdict is recorded on the audit row.' },
  { id: '2.6.4', title: 'Requests follow the same Ecotrak check', statement: 'A status request Ecotrak would refuse is refused at request time and again at approval, in block mode.', enforced: 'assertEcotrakAllowsMove in services/approvals.ts.', state: 'built' },
  { id: '2.7', title: 'Which Ecotrak status each of ours pushes', statement: 'The mapping from internal statuses to Ecotrak statuses (On Site = En route then Arrived) is a shared table.', enforced: 'ECOTRAK_PUSH_BY_STATUS_NAME in packages/shared/src/ecotrak.ts.', state: 'partial', note: 'Recorded, not sent: the outbound push waits for go-live.' },

  // ── 4. Daily to-do ──
  { id: '4.1', title: 'Due Today view', statement: 'A built-in tab lists what is due on a day: escalations, scheduled visits, quotes owed and parts arriving.', enforced: 'lib/dueToday.ts; filter groups compiled by the API.', state: 'built' },
  { id: '4.3', title: 'Daily to-do by day', statement: 'The same lists for Today, Tomorrow or any date.', enforced: 'Due Today day picker.', state: 'built' },

  // ── 5. Access ──
  { id: '5.1.1', title: 'Sign-in policy', statement: 'A byblosvista.com account enrols itself as OM Under Probation on first sign-in; every other address is invite-only.', enforced: 'Entra callback in auth/entra.ts; Admin › Users creates the invitation.', state: 'built' },

  // ── 6. Money ──
  { id: '6.2.3', title: 'Approval tiers by amount', statement: 'Bands of money per decision kind (payment, vendor bill, invoice) name the roles that may approve inside them.', enforced: 'services/approvalTiers.ts, 403 APPROVAL_TIER; Admin › Settings › Approval tiers.', state: 'built' },
  { id: '6.4', title: 'The Financial tab', statement: 'Contracts have a party (client or vendor), may bill automatically on completion, invoices snapshot title, site and vendor, and quotes can be approved or declined from the card and the list.', enforced: 'services/billingProposals.ts, services/invoices.ts, QuoteDecision.', state: 'built' },

  // ── 7. Queues ──
  { id: '7.1.1', title: 'Pending acceptance', statement: 'A work order created without an assignee waits for a manager to accept and assign it, or reject it.', enforced: 'wo_acceptance tasks; Incoming Work Orders page.', state: 'built' },
  { id: '7.1.2', title: 'Who accepts', statement: 'Team Lead, Assistant TL, Account Manager and Admin decide acceptances.', enforced: 'approvals/intake approve (0036).', state: 'built' },
  { id: '7.1.3', title: 'Accept names the dispatcher', statement: 'Accepting requires an assignee; the system suggests nobody yet.', enforced: 'decide() requires assignee; Who\'s available? panel assists.', state: 'partial', note: 'The auto-assign suggester is not built; availability is shown instead.' },
  { id: '7.1.4', title: 'Accepted means in the dispatcher\'s list', statement: 'The assignment written on accept is what the scope rule keys on, so the work order appears in that dispatcher\'s book.', enforced: 'updateWorkOrderFields on accept; woScopeSql.', state: 'built' },
  { id: '7.2.2', title: 'Oldest first', statement: 'Open rows in the Approvals inbox sort oldest first.', enforced: 'ApprovalsPage ordering (lib/inboxOrder.ts).', state: 'built' },
  { id: '7.2.3', title: 'Per-row decisions', statement: 'Every decision is taken on one row; there is no bulk approve.', enforced: 'ApprovalsPage.', state: 'built' },
  { id: '7.3.1', title: 'Escalated flag', statement: 'An Escalated checkbox, set by managers, colours the work order amber everywhere.', enforced: 'Field Escalated; EscalatedBadge; dispatcher tiers view-only.', state: 'built' },
  { id: '7.3.2', title: 'Escalation by email', statement: 'An email tool can flag a work order escalated through a signed webhook.', enforced: 'POST /api/webhooks/email-escalation with ESCALATION_WEBHOOK_SECRET.', state: 'partial', note: 'The secret is not yet set on the live site; the email tool is not wired.' },
  { id: '7.3.3', title: 'Escalation tracker', statement: 'Escalated rows pin above the rest of the Approvals inbox and fill a built-in Escalation Tracker tab on Work Orders.', enforced: 'lib/inboxOrder.ts; builtin:escalations.', state: 'built' },

  // ── 8. Records, locks, scope ──
  { id: '8.1.1', title: 'Nothing is deleted', statement: 'Deleting a work order moves it to Trash; a draft is discarded, not removed.', enforced: 'deleted_at / discarded_at; Admin › Trash restores.', state: 'built' },
  { id: '8.1.3', title: 'Dispatchers cannot move locked statuses', statement: 'OM, OM Under Probation and Senior OM are request-only on every status.', enforced: 'Migration 0031 sets the status mode per role.', state: 'built', note: 'Assumed to cover all statuses; no subset was named.' },
  { id: '8.5', title: 'Which work orders a person sees', statement: 'A role sees everything, or only the work orders assigned to them, widened by billing entities, by the clients listed on the person, and by a site restriction.', enforced: 'resolveWoScope + woScopeSql on every list, queue, count and per-work-order route (403 outside).', state: 'built' },
  { id: '8.5.4', title: 'Reassignment lock', statement: 'Dispatcher tiers cannot change the Assignee; managers can.', enforced: 'work_orders/fields/people/fields.Assignee view-only for OM tiers (0039).', state: 'built' },

  // ── 11. Gates ──
  { id: '11.1.1', title: 'Ready to Assign', statement: 'A work order cannot be assigned until Received on, Due date, SLA, Address, City, State, Zip code, Store, Trade, WO description, FM, Comp and Client NTE are filled.', enforced: 'assertReadyToAssign (409 INTAKE_GATE) on Accept and on Assignee writes while an acceptance is open.', state: 'built' },
  { id: '11.1.2', title: 'The list of missing fields is shown', statement: 'The Incoming row says which fields are still missing and links to the work order.', enforced: 'intake_missing on every approvals row.', state: 'built' },
  { id: '11.2.1', title: 'Quote Ready needs a quote', statement: 'The status cannot be entered until the quote has a line item or a scope line.', enforced: 'assertStatusGate (409 STATUS_GATE, gate quote) in changeStatus, bulk, requests and approvals.', state: 'built' },
  { id: '11.2.2', title: 'Parts statuses need Parts Required', statement: 'Waiting for Parts and Please Order Parts need the Parts Required field written.', enforced: 'assertStatusGate (gate parts).', state: 'built' },
  { id: '11.3.1', title: 'Done needs a completed visit', statement: 'Done / Incurred needs a visit that checked in and out.', enforced: 'assertStatusGate (gate done, check visit).', state: 'built' },
  { id: '11.3.2', title: 'Done needs the final cost', statement: 'Done / Incurred needs Cost; Cost is the sum of accepted payment requests and is written by the system.', enforced: 'Done gate check cost; syncCostFromPayments.', state: 'built' },
  { id: '11.3.3', title: 'Done needs a quote', statement: 'Done / Incurred needs a quote with data.', enforced: 'Done gate check quote.', state: 'built' },
  { id: '11.3.4', title: 'Done needs proof', statement: 'An approved after photo, or for Bill For Incurred an approved before photo and sign-off.', enforced: 'Done gate checks after_photo / bfi_proof.', state: 'built' },
  { id: '11.3.5', title: 'Technician rating on Done', statement: 'The dispatcher rates the technician when the job is done.', enforced: 'Not built.', state: 'deferred', note: 'There is no rating field on the vendor record yet.' },

  // ── 14. Intake ──
  { id: '14.1', title: 'WO Intake drafts', statement: 'The Operations Admin drafts work orders by hand on the Drafts tab of Incoming Work Orders.', enforced: 'wo_intake_draft; /incoming/drafts.', state: 'built' },
  { id: '14.3.3', title: 'Submit & assign is the handoff', statement: 'A submitted draft creates the work order already assigned and skips the acceptance queue.', enforced: 'submitIntakeDraft.', state: 'built' },
];

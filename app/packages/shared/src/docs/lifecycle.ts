// 0075 · The work-order lifecycle as a picture: every seeded status, the
// usual moves between them, the gates on the way in, and the processes that
// run beside the status line (acceptance, visits, the quote clock, approvals,
// payments, invoicing). Status names are the PHASE_BY_STATUS_NAME keys —
// tests/docs.test.ts fails when a status exists that this model forgets.
//
// The code imposes no order on statuses: any status may be picked unless a
// gate or the Ecotrak block refuses it. The edges here are the path the
// business follows, not a constraint the system enforces.

import type { LifecycleModel } from './types';

export const LIFECYCLE: LifecycleModel = {
  legend: {
    main: 'The usual path: a person moves the work order (Change status, or Request status change for a dispatcher). The system enforces no order — only the gates and the Ecotrak block can refuse a pick.',
    system: 'Moved by the system: a technician check-in (from whatever status the work order was in), an approved request, an automation, a planned-maintenance run.',
    branch: 'A branch the job may take: parts needed, advice needed, approved on site.',
    exception: 'An exception or off-ramp: return trip, rejection, cancellation.',
  },

  stages: [
    {
      key: 'intake',
      title: 'Birth and acceptance',
      phases: ['Intake'],
      summary:
        'A work order arrives from a client system (Ecotrak today), a CSV import, a planned-maintenance schedule, an OP Admin draft or the Add work order form. One created by the Ecotrak sync or the import without an assignee waits on Incoming Work Orders until a manager accepts it and names a dispatcher; the Ready to Assign gate holds it back until the 13 intake fields are filled. Drafts, schedules and the form hand over already assigned.',
      who: ['Team Lead', 'Assistant TL', 'Account Manager', 'Operations Admin'],
    },
    {
      key: 'assessment',
      title: 'Hire and assess',
      phases: ['Assessment'],
      summary:
        'The dispatcher finds a technician (suggested vendors, the technician map, their own book), logs an Assessment visit and the check-in moves the work order On Site. Checking out starts the 48 business-hour quote clock.',
      who: ['OM (dispatcher)', 'Senior OM', 'Ops Coordinator'],
    },
    {
      key: 'quote',
      title: 'Quote',
      phases: ['Quote'],
      summary:
        'The quote is built (by hand, or drafted by AI from a Quo call), priced from the client contract, submitted for approval and approved by a manager. Quote Ready cannot be entered with an empty quote.',
      who: ['Senior OM', 'Team Lead', 'Assistant TL', 'Account Manager'],
    },
    {
      key: 'approval',
      title: 'Client decision',
      phases: ['Approval'],
      summary:
        'The approved quote goes to the client (their CMMS once the outbound adapter is live; today the sent status is recorded, nothing is pushed). The work order waits for the client, or for advice, until it is Approved or cancelled.',
      who: ['Operations Admin', 'Team Lead', 'Account Manager'],
    },
    {
      key: 'fulfil',
      title: 'Parts, schedule and the job',
      phases: ['Parts', 'Scheduled', 'In Progress'],
      summary:
        'Parts are ordered when needed (Parts Required must be written first), the job visit is scheduled and the check-in moves the work order On Site (Job). Planned maintenance enters here directly as PM Sched. Return trips loop back.',
      who: ['OM (dispatcher)', 'Accounts Payable', 'Technician'],
    },
    {
      key: 'close',
      title: 'Soft close and audit',
      phases: ['Done'],
      summary:
        'Done / Incurred needs a visit checked in and out, the final Cost (the sum of accepted payment requests), a quote with data and an approved after photo (or, for Bill For Incurred, a before photo and a sign-off). Entering the Done group may propose an invoice and a vendor bill when an auto-invoice contract covers the job. AR audits the record and marks it Ready to Invoice.',
      who: ['OM (dispatcher)', 'Accounts Payable', 'Accounts Receivable'],
    },
    {
      key: 'invoice',
      title: 'Invoice and collection',
      phases: ['Invoiced'],
      summary:
        'The invoice is raised from the approved quote, numbered per entity and year, sent and marked paid. Moving to Invoiced or Invoiced Not Paid stamps Total Invoiced from the quote; Profit follows.',
      who: ['Accounts Receivable', 'Admin'],
    },
    {
      key: 'offramp',
      title: 'Off-ramp',
      phases: [],
      summary:
        'Cancelled / Postponed is reached by rejecting an incoming work order, by the Cancel work order button (a reason is required) or by a client rejection. Reopen undoes a cancellation.',
      who: ['Team Lead', 'Assistant TL', 'Account Manager', 'Admin'],
    },
  ],

  nodes: [
    {
      status: 'Open',
      meaning: 'Accepted into the system; nobody is on site yet.',
      enteredBy: 'Created by the Ecotrak ingest, a CSV import, Submit & assign on a draft, or Add work order. Every creation path starts here by name.',
      who: 'The system on creation; a manager on Accept and assign.',
      onEnter: [
        'An Ecotrak or imported work order with no assignee gets a wo_acceptance task and appears on Incoming Work Orders (rule 7.1); the form and the drafts never raise one.',
        'The sign-off sheet is generated the moment an Assignee is written (when Comp names a layout and file storage is on).',
        'A SharePoint folder is created when that switch is on; the dispatch cascade starts when Admin set it to start by itself.',
        'Ecotrak would push: ACCEPTED (not sent until go-live).',
      ],
    },
    {
      status: 'Emergency',
      meaning: 'An emergency intake; the red Emergency flag is the field that drives the colour everywhere, and the Pulse\'s Ack emergency clock watches this status with high priority.',
      enteredBy: 'A person, or the paused "priority changed to urgent" automation once the client portal sets priority.',
      who: 'Managers.',
    },
    {
      status: 'Assessment Sched',
      meaning: 'A technician has been found and an assessment visit is planned.',
      enteredBy: 'Change status after hiring a technician and logging a planned visit.',
      who: 'Dispatcher (direct or by request, per role).',
    },
    {
      status: 'On Site (Assessment)',
      meaning: 'The technician is checked in on the assessment visit.',
      enteredBy: 'Automatically when an Assessment visit is checked in on the CICO tab (rule 2.2.2), whatever the status before.',
      who: 'The system, from the visit log.',
      onEnter: ['Ecotrak would push: ENROUTE then ARRIVED.', 'Checking out stamps Quote Due Date = check-out + 48 business hours (Chicago, weekends and holidays skipped).'],
    },
    {
      status: 'Return Trip Needed',
      meaning: 'The technician must come back; the visit was checked out as "return trip needed".',
      enteredBy: 'Change status, usually after a check-out marked return trip.',
      who: 'Dispatcher.',
      onEnter: ['Ecotrak would push: RETURN_VISIT_REQUIRED.'],
    },
    {
      status: 'Waiting for Quote',
      meaning: 'Assessment done; the quote is owed. The Due Today view lists it under Quote on its due day and keeps it there while overdue; the Pulse\'s Quote owed clock runs here.',
      enteredBy: 'Change status after the assessment check-out.',
      who: 'Dispatcher.',
      onEnter: ['Ecotrak would push: SUBMITTING_PROPOSAL.'],
    },
    {
      status: 'Quote Ready',
      meaning: 'A quote with content exists and is ready for the manager\'s approval.',
      enteredBy: 'Change status; refused while the quote has no line item or scope line (rule 11.2.1).',
      who: 'Senior OM or a manager.',
      gate: 'quote',
    },
    {
      status: 'Waiting for Advice',
      meaning: 'A question is out to the client before the quote can be decided.',
      enteredBy: 'Change status.',
      who: 'Manager or Operations Admin.',
    },
    {
      status: 'Waiting for Approval',
      meaning: 'The quote is with the client in their CMMS; the Pulse\'s Chase client clock runs here.',
      enteredBy: 'Change status after Approve & Send to CMMS on the quote.',
      who: 'Operations Admin or a manager.',
      onEnter: ['Ecotrak would push: PROPOSAL_SUBMITTED.', 'The approval follow-up obligation counts client-visible messages and client updates as chases.'],
    },
    {
      status: 'Approved',
      meaning: 'The client approved the quote; the Pulse\'s ETA owed clock runs here.',
      enteredBy: 'Change status when the client approves (inbound PROPOSAL_APPROVED from Ecotrak, or by hand).',
      who: 'Operations Admin or a manager.',
    },
    {
      status: 'Please Order Parts',
      meaning: 'Parts are needed and must be ordered (Accounts Payable orders them).',
      enteredBy: 'Change status; refused until the Parts Required field is written (rule 11.2.2).',
      who: 'Dispatcher.',
      gate: 'parts',
    },
    {
      status: 'Waiting for Parts',
      meaning: 'Parts are ordered; Parts Arrival Date says when. Due Today lists the arrival under Parts arriving.',
      enteredBy: 'Change status; refused until Parts Required is written (rule 11.2.2).',
      who: 'Dispatcher or Accounts Payable.',
      gate: 'parts',
      onEnter: ['Ecotrak would push: PENDING_PARTS.'],
    },
    {
      status: 'Job Sched',
      meaning: 'The job visit is scheduled (Scheduled Date). Due Today lists it under Scheduled on that day.',
      enteredBy: 'Change status after planning the Job visit.',
      who: 'Dispatcher.',
    },
    {
      status: 'PM Sched',
      meaning: 'A planned-maintenance occurrence raised by its schedule, already assigned.',
      enteredBy: 'The planned-maintenance run (daily cron, Raise now, or on opening the list).',
      who: 'The system, signed by the Planned maintenance service principal.',
    },
    {
      status: 'On Site (Job)',
      meaning: 'The technician is checked in on the job (or a return trip).',
      enteredBy: 'Automatically when a Job or Return trip visit is checked in (rule 2.2.2), whatever the status before.',
      who: 'The system, from the visit log.',
      onEnter: ['Ecotrak would push: ENROUTE then ARRIVED.'],
    },
    {
      status: 'Done / Incurred',
      meaning: 'The work is complete and the technician cost is known.',
      enteredBy: 'Change status; refused until a visit is checked in and out, Cost is set, the quote has data and an after photo is approved — or a before photo and a sign-off for Bill For Incurred (rules 11.3.1 to 11.3.4).',
      who: 'Dispatcher or a manager.',
      gate: 'done',
      onEnter: [
        'Ecotrak would push: SOFT_COMPLETED.',
        'Entering the Done group from outside it proposes an invoice (from a client contract with "Bill automatically on completion", when no invoice exists) and a vendor bill (from a time-and-materials vendor contract, when none exists) — rule 6.4.',
        'Days since Done starts counting for the AR audit.',
      ],
    },
    {
      status: 'Ready to Invoice',
      meaning: 'The AR audit is clean: Admin and Quote checks ticked, nothing flagged. (Also in the Done group, so a direct move here proposes billing the same way.)',
      enteredBy: 'Change status after the Receivables › Audit checks.',
      who: 'Accounts Receivable.',
    },
    {
      status: 'Invoiced Not Paid',
      meaning: 'The invoice has been sent; collection is running (Active group).',
      enteredBy: 'Change status when the invoice is sent.',
      who: 'Accounts Receivable.',
      onEnter: ['Total Invoiced is stamped from the quote total; Profit = Total Invoiced minus Cost.'],
    },
    {
      status: 'Invoiced',
      meaning: 'Paid and closed; the archive list.',
      enteredBy: 'Change status when the client pays (Mark paid on the invoice).',
      who: 'Accounts Receivable.',
      onEnter: ['Total Invoiced is stamped from the quote total.'],
    },
    {
      status: 'Cancelled / Postponed',
      meaning: 'Not going ahead, or parked. Off the pipeline; no phase.',
      enteredBy: 'Reject on Incoming Work Orders (reason required), Cancel work order on the record (reason required), or a client rejection.',
      who: 'Managers.',
      onEnter: ['Ecotrak would push: CANCELLED.', 'An open acceptance on the work order is cancelled (an open status request stays until it is withdrawn or decided).'],
    },
  ],

  edges: [
    { from: 'Open', to: 'Emergency', label: 'Emergency flag', kind: 'branch' },
    { from: 'Open', to: 'Assessment Sched', label: 'tech hired, visit planned', kind: 'main' },
    { from: 'Emergency', to: 'Assessment Sched', label: 'same path, red', kind: 'main' },
    { from: 'Open', to: 'Job Sched', label: 'approved up front', kind: 'branch' },
    { from: 'Assessment Sched', to: 'On Site (Assessment)', label: 'check-in', kind: 'system' },
    { from: 'On Site (Assessment)', to: 'Waiting for Quote', label: 'check-out · clock starts', kind: 'main' },
    { from: 'On Site (Assessment)', to: 'Return Trip Needed', label: 'return trip', kind: 'exception' },
    { from: 'Return Trip Needed', to: 'On Site (Job)', label: 'return-trip check-in', kind: 'system' },
    { from: 'Waiting for Quote', to: 'Quote Ready', label: 'quote has data', kind: 'main' },
    { from: 'Quote Ready', to: 'Waiting for Approval', label: 'approved & sent', kind: 'main' },
    { from: 'Quote Ready', to: 'Waiting for Advice', label: 'question to client', kind: 'branch' },
    { from: 'Waiting for Advice', to: 'Waiting for Approval', label: 'answered', kind: 'branch' },
    { from: 'Waiting for Approval', to: 'Approved', label: 'client approves', kind: 'main' },
    { from: 'Waiting for Approval', to: 'Cancelled / Postponed', label: 'client rejects', kind: 'exception' },
    { from: 'Approved', to: 'Job Sched', label: 'no parts', kind: 'main' },
    { from: 'Approved', to: 'Please Order Parts', label: 'parts needed', kind: 'branch' },
    { from: 'Please Order Parts', to: 'Waiting for Parts', label: 'ordered', kind: 'branch' },
    { from: 'Waiting for Parts', to: 'Job Sched', label: 'parts arrived', kind: 'branch' },
    { from: 'Job Sched', to: 'On Site (Job)', label: 'check-in', kind: 'system' },
    { from: 'PM Sched', to: 'On Site (Job)', label: 'check-in', kind: 'system' },
    { from: 'On Site (Job)', to: 'Return Trip Needed', label: 'not finished', kind: 'exception' },
    { from: 'On Site (Job)', to: 'Done / Incurred', label: 'check-out · cost · after photo', kind: 'main' },
    { from: 'Done / Incurred', to: 'Ready to Invoice', label: 'AR audit clean', kind: 'main' },
    { from: 'Ready to Invoice', to: 'Invoiced Not Paid', label: 'invoice sent', kind: 'main' },
    { from: 'Invoiced Not Paid', to: 'Invoiced', label: 'paid', kind: 'main' },
    { from: 'Open', to: 'Cancelled / Postponed', label: 'rejected on Incoming', kind: 'exception' },
  ],

  side: [
    {
      key: 'acceptance',
      title: 'Acceptance and the Ready to Assign gate',
      statuses: ['Open'],
      brd: ['7.1.1', '7.1.4', '11.1.1', '11.1.2'],
      summary: 'A work order the Ecotrak sync or the CSV import created without an assignee waits on Incoming Work Orders until a manager accepts it and names a dispatcher, or rejects it.',
      steps: [
        'The acceptance task is raised after the creating transaction commits; a row that already has an Assignee is skipped; the Add work order form, the drafts and planned maintenance never raise one.',
        'Accept and assign is locked while any of the 13 intake fields is empty (Fill before assigning: …); the assignee must be an active person on file.',
        'Accept writes the Assignee as the manager\'s own edit, so it is audited, mirrored and scoped like any edit; Reject needs a reason and moves the work order to Cancelled / Postponed.',
        'Filling the Assignee by hand, or cancelling, closes the task by itself; every decision posts an internal comment.',
        'The Who\'s available? panel beside the picker shows each dispatcher\'s active load per status.',
      ],
    },
    {
      key: 'drafts',
      title: 'Drafts (WO Intake)',
      statuses: ['Open'],
      brd: ['14.1', '14.3.3'],
      summary: 'The OP Admin types a work order into a draft and submits it already assigned; no acceptance task is raised because the assignment is the handoff.',
      steps: ['Submit & assign refuses until every required field and an active assignee are in, and refuses a WO # that already exists (Trash included).', 'Discard keeps the draft row; a submitted or discarded draft can no longer be edited.'],
    },
    {
      key: 'hire',
      title: 'Finding the technician',
      statuses: ['Open', 'Assessment Sched', 'Job Sched'],
      summary: 'Suggested vendors (preferred rules first, then an automatic fill by trade, coverage and history), the technician map around the site, the dispatcher\'s own book, and the optional dispatch cascade that offers the job to preferred vendors in turn.',
      steps: [
        'Hire for <WO#> records the technician on the People tab (Take off releases them); a blacklisted vendor is never suggested, cannot accept an offer and cannot be the responsible vendor (hiring from the map warns).',
        'Call via Quo records the intent and opens the Quo desktop app; the transcript comes back by webhook.',
        'A hired technician, or one picked on a visit, joins the dispatcher\'s own technician list ("theirs" on the map).',
        'Compliance (W-9, MSA, approved COI) warns on hire; it never blocks.',
      ],
    },
    {
      key: 'visits',
      title: 'Visits (CICO) and the sign-off sheet',
      statuses: ['On Site (Assessment)', 'On Site (Job)', 'Return Trip Needed'],
      brd: ['2.2.2', '2.3.1', '2.3.2', '2.3.3'],
      summary: 'Every visit is a row: type, technician, method, check-in and check-out stamps to the second. The seven legacy CICO fields mirror the latest visit.',
      steps: [
        'A check-in moves the work order On Site (Assessment) for an Assessment visit, On Site (Job) for a Job or Return trip, without asking the status permission; gates and the Ecotrak check still run, and a refusal never undoes the check-in.',
        'An Assessment check-out sets Quote Due Date; a Job check-out never does. Deleting the assessment visit clears it.',
        'The check-in method is pre-filled from the FM (Admin › Custom fields › Check-in method by FM).',
        'A one-page sign-off sheet in the billing entity\'s branding is generated when the work order is assigned; Send to tech texts its link through Quo (or the Quo desktop app); the signed copy texted back is filed as a pending Sign-off attachment and sets Sign-Off Link.',
        'Geofence: the visit\'s location can be recorded on the CICO row and is compared with the site\'s pin and radius.',
      ],
    },
    {
      key: 'quoteclock',
      title: 'The quote clock and Due Today',
      statuses: ['Waiting for Quote', 'Quote Ready'],
      brd: ['2.3.1', '4.1', '4.3'],
      summary: 'Quote Due Date = assessment check-out + 48 wall-clock hours skipping Saturdays, Sundays and the holiday table, in America/Chicago. Due Today shows what is due on a chosen day.',
      steps: [
        'Due Today segments: All · Escalations (due on or before the day, not scheduled or on site) · Scheduled · Quote (owed that day, and overdue while still before Quote Ready when the day is today) · Parts arriving, each for Today, Tomorrow or any date.',
        'The date turns red in the list, the Dates card and the CICO summary only while the quote is still owed.',
      ],
    },
    {
      key: 'quote',
      title: 'Building and approving the quote',
      statuses: ['Waiting for Quote', 'Quote Ready', 'Waiting for Approval'],
      brd: ['11.2.1', '1.5.2'],
      summary: 'One quote per work order, numbered Q-<entity>-<year>-<n>, priced from the client contract in force, submitted, approved and sent.',
      steps: [
        'Create quote, fill Tech reported that…, lines, scope and options; it autosaves; Submit for approval; a manager clicks Approve & Send to CMMS or Reject with note (back to draft, from pending or approved).',
        'Grand Total counts the options marked Include in summary plus their line tax; the incurred lines are context.',
        'An AI draft from a Quo call transcript lands in the same builder; prices come only from the transcript, the vendor cost plus contract markup, or the contract rates, never invented.',
        'Approving and sending are locked while an NTE override task is open on the work order (409); rejecting never is.',
        'Print / PDF prints the quote with the default document template\'s letterhead and terms.',
      ],
    },
    {
      key: 'requests',
      title: 'Status change requests and the Approvals inbox',
      statuses: ['Assessment Sched', 'Waiting for Quote', 'Job Sched', 'Done / Incurred'],
      brd: ['2.4.1', '2.4.2', '2.4.3', '2.4.4', '7.2.2', '7.2.3', '8.1.3'],
      summary: 'Roles in request mode (OM tiers) ask for a status move (any status; these are examples); a manager approves or rejects it in Approvals; the requester acknowledges the decision.',
      steps: [
        'Request status change raises one open request per work order (a new pick re-targets it); a move a gate would refuse is refused up front.',
        'Approve re-runs the gate and the Ecotrak check, then moves the work order with via: approval_task on the audit row; Reject needs a reason.',
        'The requester sees the decision on the header banner (Continue after an approval; Request again or Understood after a rejection) and in My requests (Withdraw while open, Continue / Understood after).',
        'The inbox also carries NTE overrides, manager reviews, quotes pending approval and payment requests; open rows are oldest first and every decision is per row.',
      ],
    },
    {
      key: 'money',
      title: 'Technician payments and the Cost rule',
      statuses: ['On Site (Job)', 'Done / Incurred'],
      brd: ['1.5.2', '6.2.3', '11.3.2'],
      summary: 'A payment request per vendor payment: requested → approved → sent to Yoda → paid, or rejected. Cost = the sum of accepted requests.',
      steps: [
        'Request payment on the work order (vendor record or a typed name and phone, purpose, amount, method); Approve or Reject in Payments › Needs approval; Send to Yoda and Mark paid in To process.',
        'Approval tiers by amount decide which roles may say yes inside each band; the button is locked with the reason first.',
        'When accepted requests take Cost past the NTE, an nte_override task lands in Approvals and holds Approve and Send to Yoda; the task cancels itself once Cost is back under the NTE.',
        'Once the system has written Cost, it cannot be typed over; before that, a typed Cost stands.',
        'Vendor bills (the vendor\'s own invoice) run received → approved → paid, or disputed, beside the requests and never feed Cost.',
      ],
    },
    {
      key: 'photos',
      title: 'Photos, approval and proof before Done',
      statuses: ['On Site (Assessment)', 'On Site (Job)', 'Done / Incurred'],
      brd: ['1.3.1', '1.3.2', '1.3.3', '1.3.4', '11.3.4'],
      summary: 'Every upload is quarantined until a reviewer approves it with a kind (before, after, sign-off, other); Done needs an approved after photo, or for Bill For Incurred a before photo and a sign-off.',
      steps: ['Pending files are visible only to reviewers and the uploader.', 'Approved files are copied to the work order\'s SharePoint folder when that switch is on.'],
    },
    {
      key: 'invoice',
      title: 'Invoicing, the Total Invoiced rule and billing proposals',
      statuses: ['Done / Incurred', 'Ready to Invoice', 'Invoiced Not Paid', 'Invoiced'],
      brd: ['6.4'],
      summary: 'One invoice per work order, drafted from the approved quote, numbered <entity>-<year>-<n>, draft → sent → paid or void.',
      steps: [
        'Receivables › Audit (a prototype today) ticks the record clean; Raise invoice drafts it; Send needs invoicing approve and passes the amount tier; Mark paid closes it.',
        'A contract with Bill automatically on completion proposes the invoice (and a time-and-materials vendor contract the vendor bill) when the work order enters the Done group; Confirm files it, Dismiss drops it.',
        'Moving to Invoiced or Invoiced Not Paid stamps Total Invoiced from the quote total.',
      ],
    },
    {
      key: 'client',
      title: 'Keeping the client informed',
      statuses: ['Waiting for Approval', 'Job Sched', 'Done / Incurred'],
      summary: 'Client-visible messages on the work order queue for the client\'s CMMS; Client Updates trackers share a live view by link, email or schedule.',
      steps: ['A client-visible message cannot be edited once sent.', 'Each real send counts as a chase for the approval follow-up obligation.'],
    },
    {
      key: 'escalation',
      title: 'Emergency and Escalated flags',
      statuses: ['Open', 'Waiting for Approval', 'Job Sched'],
      brd: ['2.5.1', '7.3.1', '7.3.2', '7.3.3'],
      summary: 'Two checkbox fields colour the work order everywhere: Emergency (red) and Escalated (amber). Escalated rows pin to the top of the Approvals inbox and fill the Escalation Tracker tab.',
      steps: ['Mark as Escalated is a manager\'s button (dispatcher tiers are view-only on the field).', 'An email tool can set Escalated through the escalation webhook; it never clears it.'],
    },
  ],
};

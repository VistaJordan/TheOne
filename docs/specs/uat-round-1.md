# UAT round 1 — spec and ticket list

Source: first UAT round on https://the-one-sandy.vercel.app/ (58 items: 26 HIGH,
32 MEDIUM, 6 LOW), grilled with Jordan on 2026-10-15. This file is the ticket
list: every item has a **Status** line. To resume, read this file and start at
the first item that is not `done` or `skipped`.

Status values: `open` · `in progress` · `done (<commit>)` · `skipped (<why>)`.

## Decisions that apply everywhere

- **D1 — House rule for money and integrity.**
  (a) Integrity faults are a hard refusal (409 `CONFLICT`, a `details.code`):
  duplicates, negatives, a second payment / invoice, paying before approval, a
  vendor not on file. (b) Business-judgment overages raise an `approval_task`
  and hold the money step it guards until approved, the way `nte_override`
  holds Approve and Pay today (`assertNoOpen…` pattern): over the NTE, over
  the approved quote, negative margin, a bill over what is still owed, a
  purchase over its limit. (c) Everything else is a warning.
- **D2 — Maker ≠ checker.** Whoever requested, submitted, created or uploaded a
  thing cannot approve it (payments, vendor bills, quotes, status requests,
  purchase requests, invoice send). Exception: a **super admin** may decide
  their own, and the decision is logged with `self_approved: true` and shown
  as a flag in Admin › Audit. Error: 403 `SELF_APPROVAL`.
- **D3 — Dispatchers.** Ops Coordinator (`ops_coord`) and OM Under Probation
  (`om_probation`) = dispatchers under probation; OM (`om`) = dispatcher;
  Senior OM (`senior_om`) = senior dispatcher. "Is a dispatcher" is one shared
  helper over those four role codes, used by the assignee picker, intake
  submit, Accept and create.
- **D4 — Role matrix lives in a migration** (seed kept in step), not in clicks
  on one database.
- **D5 — Never write to Ecotrak.** `ecotrak_outbound` stays locked off. "Sent to
  the client" after an approved status request means the status changes at
  once; there is no push.
- **D6 — Viewing as = that person's rights everywhere, still read-only.** The
  Admin console, exports and every gate resolve from the viewed person while
  viewing as them; saves stay refused (2026-10-14 rule). UAT write tests use a
  real test account per role (auto-enrolled byblosvista.com addresses, role
  set by a super admin).
- **D7 — Yoda rules remain the source of truth** for quote and payment logic;
  #9 is a display fix (the summary must add up on screen), not a formula change.

## Migration numbers reserved

Wave A `0083`, Wave B `0084`, Wave C `0085`, Wave D `0086`. A wave may use more
than one file only by taking the next free number after the reserved ones.

## Wave A — money integrity

- **#4 Anyone can pay.** Requester cannot approve or pay their own request (D2);
  Pay only from `approved` (retire Pay-from-requested); pay needs
  `payments/process:edit` (AP / admin). Status: done (Wave A commit, migration 0083)
- **#5 Payment exceeds NTE.** Approve and Pay check, *before* the write, whether
  Cost + this amount > NTE with no approved NTE increase → raise / reuse the
  `nte_override` task and refuse 409 (D1b). Status: done (Wave A commit, migration 0083)
- **#7 Paying more than the quote.** Same check against the approved quote's
  total and against negative margin → approval task `over_quote` (D1b), holds
  Approve / Pay. Status: done (Wave A commit, migration 0083)
- **#8 Self-approval on quotes and status requests.** D2 in `approveQuote`,
  quote send, and `decide` for status requests (requester ≠ decider).
  Status: done (Wave A commit, migration 0083) — D2 also covers every approval task in `decide`
- **#10 Total Invoiced.** Comes only from the invoice record: set when the
  invoice is sent (its total), read-only by hand always (field editor + bulk
  edit refuse it like `COMPUTED_KEYS`); the stamp-from-quote on Invoiced is
  removed. Status: done (Wave A commit, migration 0083)
- **#20 Paying twice (vendor bills).** No negative bill (total > 0), bill number
  unique per vendor (409), a bill over what is still owed (approved quote cost
  side / payments already paid) raises an approval task (D1b). Status: done (Wave A commit, migration 0083)
- **#21 Purchasing controls.** Requester cannot approve their own PR (D2); one
  PO per PR (refuse a second while one is not cancelled); PO amount limit
  without a request (setting, default $5,000) and over-limit needs approval;
  vendor must be a vendor record (`vendor_id` required). Status: done (Wave A commit, migration 0083) — over-limit approval is a PO-level "Approve over limit" (a PO may have no work order, and `approval_task.task_id` is NOT NULL), not an approval_task
- **#23 Quote edited after submission.** Editing a `pending_approval` quote
  sends it back to `draft` (logged); a quote whose total exceeds the NTE
  cannot be sent without an approved NTE increase (409). Status: done (Wave A commit, migration 0083)
- **#24 Payment purpose codes.** Purpose required, one of J (Job), M
  (Materials), A (Assessment); the server numbers repeats per work order J,
  J1, J2…; existing rows untouched. Status: done (Wave A commit, migration 0083)
- **#25 Duplicate payments.** Every status move on payments (and quote
  transition, approvals `decide`) is a conditional `UPDATE … WHERE status =
  <read status> RETURNING`; no row → 409. Cost is added once. Status: done (Wave A commit, migration 0083) — invoice and vendor-bill moves are conditional too
- **#26 Duplicate invoices.** Partial UNIQUE index on `invoice(task_id)` where
  status <> 'void'; create inside one transaction with the check; a repeat
  returns the existing invoice. Status: done (Wave A commit, migration 0083)
- **M1 Server crashes on big numbers.** Bound numeric inputs in the API (money
  ≤ 9,999,999.99, percents ≤ 999.99) and map Postgres 22003 / 22P02 to 400
  `VALIDATION`. Status: done (Wave A commit, migration 0083)
- **M7 Invoice "Mark paid".** Stores the payment reference and date; needs
  `invoicing:edit`. Status: done (Wave A commit, migration 0083)
- **#2 Done gate skipped (money half).** Raising an invoice needs the work
  order in the done group or later. (Status half is in Wave C.) Status: partial: money half done (Wave A commit); status half is Wave C

## Wave B — access and scope

- **#12 Only super admins can invoice.** Migration grants invoicing in full to
  `ar` (+ admin), view to the rest per matrix; fix 0045's skipped grant.
  Status: done (Wave B commit, migration 0084) — invoicing view is also OFF for every role below the money roles (M13)
- **#13 Records by link ignore scope.** Payment, invoice, vendor bill, quote
  print, invoice print and every per-record route tied to a work order
  resolves the work order through `resolveTaskId(id, actor)` (403 outside
  scope). Status: done (Wave B commit) — services/recordScope.ts; also approval tasks, visits, credit notes and POST /invoices, /vendor-bills
- **#14 Roles vs BRD.** One matrix migration: ops_coord = om_probation's grants
  + no technician list, no Clients, no rates, own work orders only; vr_officer
  and oa get request-mode status and the scope their job needs; Michael K is
  not a super admin (DB fix on the UAT database, listed in the recap if it is
  data only). Status: done (Wave B commit, migration 0084) — vr_officer and oa see every work order (scope view true); Michael K is not a super admin locally, check the UAT database (recap)
- **#17 Client Updates sharing.** `field_def.client_safe` flag (off for
  Finances / AP / AR sections and Cost / Profit / Margin, on elsewhere,
  editable in Admin › Custom fields); a shared tracker sends only columns that
  are client-safe AND visible to the sender, rows = sender's scope ∩ the
  tracker's client. Status: done (Wave B commit, migration 0084) — "sender" = the tracker's owner (created_by); shared charts on unsafe fields refused too
- **#18 Raising your own rights.** Nobody (super admins included) changes their
  own role or overrides; a non-super-admin cannot grant a permission they do
  not hold; only super admins and the admin role edit roles; new empty `hr`
  role with `admin/users` + `admin/roles` edit. Status: done (Wave B commit, migration 0084) — open question: as specified, hr can only invite into roles within its own grants and cannot edit role definitions
- **M12 / D6 Viewing as.** Admin console and the audit export resolve from the
  viewed person while viewing as them (still read-only). Status: done (Wave B commit) — the assistant's "What this person may do" follows too
- **M13 / M20 Finance visibility.** TL and above see money; below TL Cost,
  Profit and money totals hidden, Margin % shown; Exec guest = om_probation's
  grants. Status: done (Wave B commit, migration 0084) — Margin % = new computed column margin_pct; NTE stays visible
- **M28 Hidden fields leak.** Field visibility applied to the audit log rows
  and dashboard cards (a card on a field the viewer cannot see answers "not
  available"). Status: done (Wave B commit) — Admin › Audit withholds the values, the work-order feed drops the row
- **M29 Site restriction flips to all.** A per-person `site_restricted` flag
  stored on the principal; an empty list with the flag on = no sites.
  Status: done (Wave B commit, migration 0084)

## Wave C — workflow

- **#2 Done gate skipped (status half).** Ready to Invoice / Invoiced /
  Invoiced Not Paid can only be entered from a status in the done group or
  later (or with the Done gate satisfied). Status: done (Wave C commit, migration 0085) — both halves: the Done gate's checks, waived when the work order is already in Done / Incurred or later
- **#15 OM side doors.** For request-mode users: Cancel, Pause, Complete
  service, and edits to Cost, NTE, SLA dates and AR fields are refused; they
  may log visits, but their check-in raises a status-change request to On
  Site instead of moving it. Status: done (Wave C commit, migration 0085) — new permission path work_orders/lifecycle (off for every request-mode role incl. vr_officer and oa); NTE / SLA / AR fields view-only for the dispatchers and vr_officer, not oa (intake types them)
- **#16 Dispatcher status changes.** Request mode for all dispatchers (D3);
  approval moves the status at once (D5). Status: done (Wave C commit, migration 0085)
- **M3 Gates only on entry.** While a work order sits in a gated status, the
  field its gate depends on cannot be cleared (409 `STATUS_GATE`).
  Status: done (Wave C commit, migration 0085) — Parts Required, Cost (done or later), the quote (Quote Ready or done or later)
- **M5 Status follows quote events.** Send moves the WO to the sent-quote
  status, client approval / decline to their statuses (by name, skipped when
  absent), through `changeStatus` with source `quote`. Status: done (Wave C commit, migration 0085) — Send → Waiting for Approval, client approval → Approved, client decline → Waiting for Quote (re-quote), forward only
- **M6 Client approval evidence.** Recording client approval needs a note or an
  attachment. Status: done (Wave C commit, migration 0085)
- **M4 Client message too early.** The client-visible quote message is posted
  on send, not on submit. Status: done (Wave C commit, migration 0085) — no submit path posted it; the chained Approve & Send CTA became Approve, Send to client is its own click, and the message reads "sent to the client for approval"
- **M8 Visit times vs status.** Visit status derives from the stamps; a typed
  time is never overwritten. Status: done (Wave C commit, migration 0085)
- **M9 Misleading UI.** Progress bar reflects the real status; Cancel hidden
  once billed or paid. Status: done (Wave C commit, migration 0085) — un-visited phases draw as skipped; Cancel refused (409 CANCEL_BILLED) and hidden once an invoice is sent / paid or a payment is paid
- **M18 Check-in logic duplicated.** Code is the single source; the two
  automations exist only on the UAT database (none in migrations / seed) →
  disable them there (recap). Status: done (Wave C commit) — code side: nothing in migrations, seed or code creates one; disabling the two on the UAT database stays on the ops checklist
- **M31 Reopen.** Reopen needs a reason and moves the status back to the one
  before the cancel. Status: done (Wave C commit, migration 0085)

## Wave D — data quality and UI

- **#11 One client list.** Migration creates a client record for every client
  name on a work order; the Ecotrak sync creates the record for a new name;
  Client on work orders, PM and intake picks a client record only (server
  refuses free text). Status: done (Wave D commit, migration 0086) — import refuses unknown clients (IMPORT_UNKNOWN_CLIENT) rather than creating them
- **#22 Intake without a client.** Client required; assignee must be a
  dispatcher (D3). Status: done (Wave D commit, migration 0086)
- **M22 Assignee picker.** Active dispatchers only (D3). Status: done (Wave D commit, migration 0086)
- **M2 Invalid field values.** Server-side type / option / state / date-order
  validation on field writes; WO # format check. Status: done (Wave D commit, migration 0086)
- **M10 PM Raise now duplicates.** One work order per occurrence; Raise now
  refuses while the next occurrence is already raised. Status: done (Wave D commit, migration 0086)
- **M11 Dashboard miscount.** "No visit logged" counts active work orders only.
  Status: done (Wave D commit, migration 0086) — "future-scheduled" read as the three Sched statuses (the filter language has no OR on a date)
- **M14 Photo approval.** Approve / Decline only inside the full-size viewer
  (arrow keys between waiting photos); approved photos show on the AR side.
  Status: done (Wave D commit, migration 0086) — AR side = the work order's Client invoice card (not the Receivables › Invoicing rows)
- **M15 Integrations show On.** Show the real connection state (on + configured
  vs on but not set up). Status: done (Wave D commit, migration 0086)
- **M16 Enrolment copy.** Settings says what the code does (byblosvista.com
  self-enrols as OM Under Probation). Status: done (Wave D commit, migration 0086)
- **M17 Trash / Restore.** Fix the copy; Restore needs `work_orders` delete (or
  admin/trash edit). Status: done (Wave D commit, migration 0086)
- **M21 Header titles per role.** Fewer header chips, each limited by the
  viewer's rights. Status: done (Wave D commit, migration 0086) — Cost, Comp, Ecotrak and SharePoint chips gated; nothing else removed
- **M23 Receivables prototype.** Hide the Audit tab (and the stray "ELISE"
  column) until it is finished. Status: done (Wave D commit, migration 0086)
- **M25 "NTE increases" overloaded.** Split into "NTE override (cost over NTE)"
  and "NTE increase requests". Status: done (Wave D commit, migration 0086)
- **M26 Generate sheet hidden.** Show to anyone with `work_orders/fields/cico`
  edit. Status: done (Wave D commit, migration 0086)
- **M27 Markup on the printed quote.** Hidden on the client document.
  Status: done (Wave D commit, migration 0086)
- **M30 Contract edit re-prices.** Invoice prefill and completion proposals use
  the rates snapshotted when the quote / work order was priced; new rates
  apply forward only. Status: done (Wave D commit, migration 0086) — rate versions (contract_rate_version) + the card in force on the received day
- **M32 Overlapping rate cards.** Refuse an overlapping card for the same
  party / client / entity / site / trade window. Status: done (Wave D commit, migration 0086)
- **#9 Quote summary adds up.** The on-screen summary shows every term the
  total is made of (incurred, option, tax %, line tax) so the sum is visible.
  Status: done (Wave D commit, migration 0086)
- **L1** Summary wording "Tech reported that Tech found…". Status: done (Wave D commit, migration 0086)
- **L2** Audit times in America/New_York, labelled ET. Status: done (Wave D commit, migration 0086)
- **L3** History fields (Previous Assignees) read-only for everyone.
  Status: done (Wave D commit, migration 0086)
- **L4** Lock message names the current super admins from the API, not a
  hard-coded list. Status: done (Wave D commit, migration 0086)
- **L5** BRD / SOP registry served from the API behind `admin/docs`, not bundled.
  Status: done (Wave D commit, migration 0086)
- **L6** One label set: Approve · Send to client · Record client decision.
  Status: done (Wave D commit, migration 0086)
- **Margin (extra)** The list's Margin % uses the work-order record's formula
  (revenue = invoices sent, else the quote). Status: done (Wave D commit, migration 0086) — the column's
  sort still uses the SQL approximation

## Ops checklist (not code)

- **#3 File storage.** Turn File storage on in Admin › Integrations on the UAT
  deployment (token is set). Status: open
- **M18** Disable the two check-in automations on the UAT database.
- **Michael K** Clear `is_super_admin` on the UAT database if set there.
- Create one UAT test account per role (D6).

## Skipped (needs input from outside this session)

- **#1 Status order** — needs the BRD 2.7 internal transition table.
  Status: skipped (no table)
- **#6 / M24 Ecotrak NTE sync and write path** — D5. Status: skipped (Ecotrak
  stays read-only)
- **#19 Vendor compliance** — needs Steve's AP rules. Status: skipped
- **M19 Approval tier boundaries** — needs the approvals table. Status: skipped

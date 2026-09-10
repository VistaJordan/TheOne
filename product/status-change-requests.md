# Status change requests (rules 2.4.1 – 2.4.4) — implementation plan

Written 2026-09-09, revised the same day with Elise's decisions. **Built the
same day** (migration 0025) — see CLAUDE.md "Status change requests" for the
as-built summary. Differences from the plan below: the button labels are
Continue / Understood / Request again (not "Got it"); the requester's lane is
called My requests; the bulk bar hides its status move for request-mode
users; no worktree was needed in the end (the quote due-date commit landed
first).

## Decisions taken (Elise, 2026-09-09)

- **Dispatcher** = OM, OM Under Probation, Senior OM. They *request* status
  changes; they never move a status themselves.
- **Approvers** = TL, ATL, Account Manager, Admin. Requests land in their
  Approvals inbox under a new section **Status changes**.
- **Roles screen and per-user Adjust** both get the choice "change status
  directly / must request / not allowed", so one person can be allowed to
  change directly while the rest of their role requests.
- **Roles screen and per-user Adjust** also choose which Approvals sections a
  person sees (and may decide).
- The status button reads **Request status change** for people in request mode.
- Accept moves the status. Reject requires a note and the dispatcher is told.
- Dispatchers see their approved and rejected requests and must **acknowledge**
  a decision to clear it, so the page is empty when nothing is waiting.

## Where dispatchers see decisions — recommendation

**The same `/approvals` page, shaped by what the person may do.** Not a
section beside Due Today, not a separate notifications tab.

- Approvers see what they must decide (today's inbox, plus Status changes).
- Dispatchers see **My requests**: open (waiting on a manager) and decided
  (approved or rejected, until acknowledged). Their page reads empty once
  everything is acknowledged.
- A person who can both request and approve (an admin, say) sees both.
- The sidebar **Approvals** item carries a count badge, like Work Orders does:
  for approvers the open items they can decide; for dispatchers the decisions
  not yet acknowledged. That badge *is* the notification for v1, together with
  the internal comment the decision already posts on the work order.

Why not the alternatives:

- *Beside Due Today* — that is a work-order list keyed on dates. A rejection is
  not a date, the work order itself does not need a revisit, and the list has
  nowhere to hold the manager's reason.
- *A notifications tab / the bell* — a general notification system does not
  exist yet (the bell is an inert placeholder) and would duplicate these rows.
  It can be built later on top of the same approval task rows.

**Acknowledge semantics (decided).** Both approved and rejected requests wait
in My requests until the dispatcher acts on them, so an empty page means
nothing left to look at:

- Approved row — "Approved by <manager> · moved to <To>" with one button,
  **Continue**: the way is clear, the row clears.
- Rejected row — the manager's reason, with **Request again** (opens the
  status picker; the new request acknowledges this one) and **Understood**
  (clears the row without a new request).

The work-order header mirrors the same state as a chip beside the status pill:
"→ Quote Ready · pending approval", "→ Quote Ready · approved" or "Rejected:
<reason>", with the same Continue / Request again / Understood actions, until
acknowledged.

## Rules, restated

| Rule  | Spec | Here |
|-------|------|------|
| 2.4.1 | Dispatcher cannot change status; the attempt becomes a request | Approval task type `status_change`. Dispatcher = a permission mode (below), seeded for the three roles. |
| 2.4.2 | Request shows in the manager's to-do view | New **Status changes** section of `/approvals`, gated per role / per user. |
| 2.4.3 | Accept → status moves, dispatcher notified. Reject → reason required, dispatcher notified | Approve calls `changeStatus`; reject reuses the note-required reject dialog. Dispatcher is told by the My requests lane + badge + the internal comment. |
| 2.4.4 | Pending request pauses no SLA timer | No-op. Nothing pauses timers; the quote clock (0024) keys off visit check-outs, not status. One code comment. |

## Model

**Status_Change_Request = an `approval_task` row.** No new table.

- `type = 'status_change'`; `ApprovalTaskType` gains the literal.
- `title` = `Status change requested: <From> → <To>`.
- `detail` = `{ from_status_id, from_status_name, to_status_id, to_status_name }`.
- `created_by` = the requester. `decision_note` = the rejection reason.
- New columns (0025): `acknowledged_at timestamptz`, `acknowledged_by uuid`.
- One OPEN task per (work order, type). A second request while one is open
  replaces the target (the existing refresh path) and is logged.
- `assigned_role = null`: any approver's lane (no manager hierarchy exists).
- Reconcile: if the work order reaches `to_status_id` by any other route, the
  open request is cancelled (hook already runs after every write).

### Permission: status change mode

`work_orders/status` gets `create` beside `edit`:

| Mode in the UI      | Stored grant              | Meaning |
|---------------------|---------------------------|---------|
| Change directly     | `{edit: true,  create: true}`  | today's behaviour |
| Must request        | `{edit: false, create: true}`  | rule 2.4.1 |
| Not allowed         | `{edit: false, create: false}` | no status button |
| (inherit)           | unset                     | falls back to role / to `work_orders` |

`PermissionMatrix` renders this one node as a three-way choice instead of two
checkboxes (a `mode` node kind in `buildPermissionTree`; inherited state stays
faded as elsewhere). The same component serves Roles and the per-user Adjust,
so the per-person exception comes for free.

Defaults set by 0025 (and mirrored in seed.ts):

| Role code | mode |
|-----------|------|
| om, om_probation, senior_om | Must request |
| tl, atl, am, admin | Change directly |
| ops_coord, vr_officer | unchanged (inherit `work_orders` edit → Change directly). Elise undecided on Ops Coordinator; it is a one-click switch later. |
| exec_guest, service | Not allowed (already no edit) |

### Permission: Approvals sections

`approvals` gets children, each inheriting from the parent:

| Path                 | Section label    | actions |
|----------------------|------------------|---------|
| `approvals/nte`      | NTE increases    | view, approve |
| `approvals/status`   | Status changes   | view, approve |
| `approvals/reviews`  | Manager reviews  | view, approve |
| `approvals/quotes`   | Quotes           | view (deciding stays `quotes:approve`) |
| `approvals/payments` | Payments         | view (deciding stays the payments grant) |

`approvals:view` still opens the page; a person's own requests are always
visible to them under My requests regardless of section grants. Defaults from
0025: `approve` true for tl / atl / am / admin on nte, status, reviews; every
other role inherits view only. Roles and Adjust both show these rows through
the existing tree.

## Server

1. `packages/shared/src/index.ts` — `ApprovalTaskType` += `'status_change'`
   and its `APPROVAL_TASK_TYPES` entry (~line 886). `ApprovalTask` +=
   `acknowledged_at`, `acknowledged_by`. `WorkOrderDetail` +=
   `status_change: { approval_task_id, status, to_status, decision_note } | null`
   (the latest unacknowledged or open request).
2. `packages/shared/src/permissions.ts` — `work_orders/status` actions
   `['edit','create']` with `kind: 'mode'` + labels; `approvals` children as
   above; `APPROVAL_SECTION_KEYS` for the page. (~line 388 and ~line 427.)
3. `packages/db/migrations/0025_status_change_requests.sql` — the two
   `approval_task` columns; role defaults for `work_orders/status` and the
   `approvals/*` children (`permissions || jsonb_build_object(...)`, only where
   the path is not already set). Number may shift at merge: the phase-0 side
   numbers up to 0028.
4. `packages/db/src/seed.ts` — the same role defaults (keep in step).
5. `apps/api/src/services/approvals.ts`
   - `describe()` branch for `status_change`; refuses an unknown or no-op target.
   - `TYPE_LABEL.status_change = 'Status change'`.
   - `decide()` approve on `status_change`: after the approval transaction
     commits, `changeStatus(task_id, to_status_id, actor.id, { by: { approval_task_id } })`
     so the `status_changed` row says `via: 'approval_task'`. Target status gone
     → 409 and the task stays open. Work order moved since the request → still
     apply (spec says update to the requested status); the row shows the drift.
   - Reject: nothing to revert; note required as today.
   - Section gate: approve / reject / claim require `approvals/<section>:approve`
     for the task's type instead of the bare `approvals:approve`.
   - `listApprovalTasks` also returns the caller's own tasks (any status, not
     yet acknowledged) even when they lack the section's view grant.
   - New `acknowledgeApprovalTask(id, actor)` — requester or an approver;
     sets the two columns, logs `approval_task_acknowledged`.
   - New `withdrawApprovalTask(id, actor)` — requester or approver; open →
     cancelled, logs `approval_task_cancelled`.
   - `reconcileApprovalTasks`: cancel an open `status_change` whose target the
     work order now sits in.
   - Refresh-while-open logs `approval_task_updated` (today it logs nothing).
6. `apps/api/src/routes/workOrders.ts`
   - `PATCH /work-orders/:id/status` keeps requiring `work_orders/status:edit`.
   - New `POST /work-orders/:id/status-request { status_id }` requiring
     `work_orders/status:create`; 201 created / 200 refreshed.
   - Bulk edit with `status_id` stays `edit`-only in v1 (request-mode users get
     403 there; the bulk editor hides the status field for them).
   - Automations run as the service principal; exempt by construction.
7. `apps/api/src/routes/approvals.ts` — `POST /approval-tasks/:id/acknowledge`,
   `POST /approval-tasks/:id/withdraw`; `GET /approvals/counts` for the badge
   (`to_decide`, `to_acknowledge`).
8. `apps/api/src/services/workOrders.ts` — `getWorkOrderDetail` joins the
   latest open-or-unacknowledged `status_change` task.
9. `apps/api/src/services/permissions.ts` — no change expected; `permAllows`
   already resolves child paths.

## Web

1. `api/client.ts` — `requestStatus`, `acknowledgeApprovalTask`,
   `withdrawApprovalTask`, `getApprovalCounts`.
2. `components/StatusChangeMenu.tsx` (header + table) — reads the viewer's
   grants. `edit` → PATCH as today. Only `create` → the trigger reads
   **Request status change**, picking a status POSTs the request, toast "Sent
   for approval", invalidate `work-orders`, `wo-feed`, `wo-activity`,
   `approvals`, `approval-counts`. Neither → no button.
3. `components/wo/WoHeader.tsx` — the state chip (pending / approved /
   rejected with reason) with Withdraw, Continue, Request again, Understood as applicable.
4. `pages/ApprovalsPage.tsx`
   - New `Section` `'status'` labelled **Status changes**, after NTE increases.
     Row = WO, From → To, requested by, age. Approve / Reject per row; reject
     reuses the reason dialog. Open rows oldest first (7.2.2).
   - Sections offered = the ones the viewer may view (`approvals/<key>:view`);
     decision buttons drawn only with the section's `approve`.
   - New lane **My requests** (shown when the viewer has any own tasks or is in
     request mode): open, approved, rejected; Continue / Request again / Understood / Withdraw
     per row. Default lane for a viewer who can decide nothing.
5. `components/AppShell.tsx` — Approvals badge from `/approvals/counts`,
   refetched on the same invalidations.
6. `components/admin/PermissionMatrix.tsx` — the `mode` node kind (three-way
   choice) for `work_orders/status`; everything else unchanged. Roles and
   Adjust pick up the new `approvals/*` rows automatically.

## Audit (rule 1.2.1)

`approval_task_created` (type `status_change`, from/to in `after`),
`approval_task_updated` (target replaced), `approval_task_approved` +
`status_changed` (`via: 'approval_task'`) + `comment_added`,
`approval_task_rejected` (note) + `comment_added`, `approval_task_cancelled`
(withdraw / reconcile), `approval_task_acknowledged`. Role and override edits
are already logged by adminAudit.

## Files touched vs the quote due-date session

| File | 2.4 | Quote session | Risk |
|------|-----|---------------|------|
| shared/index.ts | ~886 task types, WorkOrderDetail | ~1136 quote clock | different regions |
| shared/permissions.ts | ~388, ~427 | FIELD_SECTIONS dates, ADMIN settings | different regions |
| db/seed.ts | role defaults | CURATED_FIELDS | different regions |
| migrations | 0025 | 0024 | numbering only |
| services/workOrders.ts | detail join | maybe list SQL (Due Today) | watch at rebase |
| approvals service/routes/page, StatusChangeMenu, WoHeader, PermissionMatrix, AppShell badge | yes | no | none |
| services/visits.ts, businessDays, Admin Settings | no | yes | none |

## Sequencing

1. Worktree off the current Primary-Updates head (own pgdata; one API on :5174).
2. Server first: shared → 0025 → approvals service → routes; curl the whole
   flow with dev-login as an OM and as a TL.
3. Web: permission mode control → status menu + header chip → Approvals
   sections, My requests lane, badge. Screenshot both themes.
4. Rebase once the quote session commits; renumber 0025 if 0024 moved.
5. Push, apply 0025 on Neon, Vercel routine.

## Verify

- `npm -w @theone/web run build`.
- As OM: status button reads Request status change; `PATCH /status` → 403;
  `POST /status-request` → 201; second → 200 refreshed; detail carries
  `status_change`; My requests shows it open; badge = 0 for the OM, 1 for a TL.
- As TL: Status changes section lists it; reject without note → 400; reject
  with note → status untouched, comment posted; approve → status moved,
  `status_changed` row has `via`, comment posted.
- As OM again: row shows approved / rejected with reason; Continue / Understood clears it,
  badge drops to 0; Request again on a rejection opens the picker and
  acknowledges the old row.
- A TL moving the WO straight to the requested status cancels the open request.
- Roles: set OM Under Probation to Change directly → that role changes
  directly; Adjust one OM to Change directly → only that person does.
- Roles: remove `approvals/status` view from AM → their inbox loses the
  section; own requests still visible under My requests.
- Quote Due Date on the same WO is unchanged throughout (2.4.4).

## Deferred

- Ops Coordinator stays as today (changes directly). It is a switch in
  Admin › Roles; Elise flips it to Must request later if wanted.

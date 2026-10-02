# The One — guide for Claude Code

Work-order, quote and vendor-payment platform for Seamless FM (Byblos Vista).
React + Vite front end, Fastify API, embedded Postgres (PGlite). Read this
before touching code; it is the map, the run book and the list of rules that
are easy to break without noticing.

## Layout

```
app/                      npm workspace root — run npm commands here (or use the root shim)
  packages/shared/        @theone/shared — types + shared vocab (status groups, capability names)
  packages/db/            @theone/db — PGlite client, migrations/, seed.ts
  apps/api/               @theone/api — Fastify on :5174 (src/routes, src/services, src/auth, src/plugins)
  apps/web/               @theone/web — React on :5173 (src/pages, src/components, src/styles, src/theme)
product/                  product docs: feature-roadmap.md is the sprint plan; the others are domain specs
docs/ (inside app/)       SPRINT1-SPEC.md — original schema/API contract
package.json (root)       scripts-only shim that forwards to app/ so `npm run dev` works from the repo root
```

## Run

```
npm run setup     # migrate + seed the local PGlite DB (app/packages/db/pgdata, gitignored)
npm run dev       # API :5174 + web :5173 via concurrently
```

Open http://localhost:5173. Both commands work from the repo root or `app/`.

Rules that bite:
- **PGlite is single-writer.** Stop the API before `setup`/`db:seed`; a second
  process opening `pgdata` reads a stale view (symptom: empty user list).
- **`db:seed` TRUNCATEs and re-inserts.** Re-seeding wipes local edits.
- Vite binds `127.0.0.1` (see `vite.config.ts` comment); the API is v4-only too.
- `EADDRINUSE` on :5174 means an old `tsx src/index.ts` is still alive — find it
  with `netstat -ano | findstr 5174` and stop that PID.

## Auth (the part most likely to confuse a reviewer)

Two mutually exclusive modes, chosen by env (`app/.env`, template in `.env.example`):

| Mode   | Trigger                                               | What sign-in does |
|--------|-------------------------------------------------------|-------------------|
| entra  | `ENTRA_TENANT_ID` + `ENTRA_CLIENT_ID` + `ENTRA_CLIENT_SECRET` set | Real Microsoft OIDC round trip (`apps/api/src/auth/entra.ts`) |
| bypass | `AUTH_DEV_BYPASS=true` (refuses to boot if `NODE_ENV=production`) | The same "Sign in with Microsoft" button signs in as `DEV_DEFAULT_EMAIL` (`eliseam@byblosvista.com`, set in `apps/web/src/pages/SignInPage.tsx`) with no password; a footnote can reveal the full account picker |

- Sessions are **server-side rows** (`session` table) sent as an httpOnly
  cookie — not JWTs — so sign-out and "disable user" revoke immediately.
- `plugins/authGuard.ts` 401s every `/api/*` route except the allowlist at its top.
- Sign-in policy (rule 5.1.1): the callback looks the principal up by verified
  email. Nobody on file and the address is on `AUTH_ALLOWED_DOMAINS` (default
  `byblosvista.com`) → the row is created on the spot as `AUTH_AUTO_ENROL_ROLE`
  (default `om_probation`, OM Under Probation), logged `user_auto_enrolled`, and
  a super admin promotes them from Admin › Users. Any other address is
  **invite-only**: creating the row in Admin › Users *is* the invitation.
- **Super admins** (`principal.is_super_admin`) gate the whole admin console.
  The four are Elise, Jordan Brown, Jeff S, Jack — created by migration 0004
  *and* by `seed.ts` (see "keep in step" below).
- Roles live in the `role` table. Since migration 0015 what a role grants is a
  **permission tree** in `role.permissions` (jsonb, path → `{view, create,
  edit, delete, approve}`; e.g. `work_orders/fields/finances/fields.34. Cost`).
  An unset action inherits from the parent path. `principal.permission_overrides`
  holds one person's exceptions on top of their role (super admins only can set
  them, from the Adjust button in Admin › Users). The resolver is
  `packages/shared/src/permissions.ts` (`permAllows`) and runs identically on
  the API and in the browser; `apps/api/src/services/permissions.ts` adds the
  403s and the field redaction of work-order payloads. The five legacy
  `can_*` columns are kept in step by `services/roles.ts` but no longer gate
  anything. `principal.role` holds the role *code*.

## Data: migrations and seed must stay in step

The audit log is one table, `activity_log`, and every write goes there: work-order
edits (`services/woAudit.ts`), sign-ins, and since migration 0023 the admin
changes too — custom-field definitions, statuses and phase groups, roles, users,
automation rules (`services/adminAudit.ts`, whole before/after snapshots with a
`name`). Rule 1.2.1 ("every button") also covers saved views (`view_created|
updated|deleted`, entity `saved_view`), CSV downloads (`work_orders_exported`,
`audit_log_exported`, entity `export`, entity_id = the actor) and quote
revisions (`quote_updated` carries whole-quote snapshots from `snapshotQuote`
in `services/quotes.ts`; an autosave that changed nothing logs nothing).
Deliberately not logged: per-user prefs (column widths, collapsed cards) and
pure UI clicks (tabs, folds, filters) — they change no record. Since migration
0029 the table is **append-only at the database**:
a `BEFORE UPDATE OR DELETE` trigger raises (rule 1.2.2), so a correction is a
new row, never an edit; TRUNCATE still works for the local seed. `entity_id`
is **text** since 0023 (phase groups are keyed by code):
join it as `t.id::text = a.entity_id`, and never feed one `$n` parameter to both
a uuid column and `entity_id` in the same statement — PGlite refuses to type it.

**Approval tasks** (migration 0026, `services/approvals.ts`, `/approvals` in
the sidebar) are the generic "a manager has to say yes or no" queue. The rules
engine raises them (automation action kind `approval_task`) and business rule
1.5.2 ships as a seeded automation: when `34. Cost` changes to more than the
`nte` core field, an `nte_override` task lands in the inbox. Two engine
additions carry it: a trigger may compare against another field
(`trigger.to_field`) and an action may be `{kind:'approval_task', field:
'approval_task', value:<type>, assign_role}`. One open task per (work order,
type); `reconcileApprovalTasks` (called from `dispatchAutomations`) cancels an
NTE task once the cost is back under the NTE. Decisions post an internal
comment on the work order. Permission path `approvals` (view / approve).
The second half of 1.5.2 ("financial progression is blocked") is
`assertNoOpenNteOverride` in the same service: quote approve / send and
payment approve / send-to-Yoda call it first and get a **409 `CONFLICT`**
while an `nte_override` task is open; rejecting is never blocked. The
`Quote` payload and each `/api/payments` row carry `nte_override_open` so the
builder and the Payments tab draw the verb locked before the click. The
`/approvals` page is a sectioned inbox — All · NTE increases · (Manager
reviews) · Quotes (`pending_approval`) · Payments (`requested`) — built
client-side from `/approvals`, `/quotes` and `/payments`; open rows sort
oldest first (rule 7.2.2) and every decision is per row (7.2.3).

**Status change requests** (migration 0025, rules 2.4.1–2.4.4) ride the same
table: a request is an `approval_task` of type `status_change` with the
from/to in `detail` and the rejection reason in `decision_note`; 0025 adds
`acknowledged_by/_at`. "Dispatcher" is a permission, not a role name:
`work_orders/status` has `edit` (change directly) and `create` (must
request); the Roles screen and per-user Adjust draw the pair as ONE
three-way choice (`choices` on the PermNode, `STATUS_MODE_CHOICES`). 0025
sets OM / OM Under Probation / Senior OM to request, TL / ATL / AM / Admin
to direct. The inbox sections are permission paths `approvals/nte|status|
reviews|quotes|payments` (view / approve; unset inherits from `approvals`);
the API trims `/approvals` to the viewer's sections **plus their own
requests**, and every decision requires the task's section `approve`.
`POST /work-orders/:id/status-request` raises one (201 new / 200 re-targeted);
approving calls `changeStatus` after the decision commits with source
`{kind:'approval_task'}`, so the `status_changed` row reads `via:
'approval_task'`; `reconcileApprovalTasks` cancels an open request once the
work order sits in the requested status by any other route. The requester
sees the decision on the work-order header chip and in the **My requests**
lane of `/approvals` until they acknowledge it (Continue after an approval,
Understood or Request again after a rejection — `POST …/acknowledge`,
`…/withdraw`); `GET /approvals/counts` feeds the sidebar badge. Rule 2.4.4
needs no code: nothing pauses a timer and the quote clock keys off visits.
The status button reads "Request status change" for request-mode users and
the bulk bar hides its status move for them.

**Pending acceptance / Incoming Work Orders** (migration 0036, rules
7.1.1–7.1.4) is the third kind riding the same table: an `approval_task` of
type `wo_acceptance`, section `intake` (permission path `approvals/intake`,
view / approve; 0036 grants it to TL / ATL / AM / Admin). It has its **own
sidebar page, Incoming Work Orders** (`/incoming`): the same `ApprovalsPage`
in `mode="intake"`, which shows only intake rows, while `/approvals` never
shows them (intake is a different job from approving). Since the drafts of
section 14 joined it, that page has **two tabs — To accept** (this queue,
`approvals/intake` view) **and Drafts** (`/incoming/drafts`, `intake`
view) — drawn by `components/IncomingTabs.tsx` only for someone who holds
both grants; with one grant the page simply is that queue, and `/incoming`
sends a drafts-only person on to the Drafts tab (`IncomingRoute` in
`App.tsx`). The sidebar item shows for either grant (`NAV_PERM` takes a
list) and its badge adds the open drafts to `to_accept`. `GET
/approvals/counts` carries `to_accept`; `to_decide` no longer
counts acceptances. Nothing new on the
work order: "pending" = the open task + an empty `Assignee` (the status stays
Open). `raiseAcceptanceTasks(ids, actorId, source)` in `services/approvals.ts`
is what the creators call **after their transaction commits** — the Ecotrak
ingest (signed by the `Ecotrak sync` service principal, `services/
serviceActors.ts`) and the CSV import (after its automations ran, so an
auto-assign on create needs no acceptance); a row that already has an
assignee is skipped. Accept = `POST /approval-tasks/:id/approve` with
`assignee` (a human principal's display name, required, checked against
`principal`); the decision commits, then the name is written through
`updateWorkOrderFields` so it is audited as the manager's edit and the 0032
scope puts the work order in that dispatcher's list (7.1.4). Reject needs the
reason and, after the commit, calls `changeStatus` to `Cancelled / Postponed`
(`ACCEPTANCE_REJECT_STATUS_NAME`, looked up by name — 409 if the status is
gone) with source `{kind:'approval_task'}`. `reconcileApprovalTasks` cancels
an open acceptance once somebody fills `Assignee` by hand or moves the work
order to Cancelled / Postponed. The detail payload carries `acceptance`
(`AcceptanceState`, with `missing`) and the header draws an "Awaiting
acceptance · from Ecotrak · N intake fields to fill" chip linking to
`/incoming`; the Incoming row reads Accept (opens the assignee picker,
dispatcher tiers first) / Reject. Rule-raised tasks are still only the two the builder offers
(`APPROVAL_TASK_TYPES`); a rule cannot raise an acceptance. Deferred: the
auto-assign suggester (7.1.3's note), and no work order is created by hand
in the app today, so `source: 'manual'` is reserved.

**Ready to Assign gate** (migration 0037, rules 11.1.1 / 11.1.2). A work
order cannot be assigned until Received on, Due date, SLA, Address, City,
State, Zip code, Store, Trade, WO description, FM, Comp and Client NTE are
filled (WO# is the row key; a $0.00 NTE counts as filled; Received on / WO
description / Client NTE also accept their promoted `task` columns, which is
what the Ecotrak ingest writes). Vocabulary in `packages/shared/src/
intakeGate.ts` (`INTAKE_REQUIRED_FIELDS`, `intakeMissing`,
`describeIntakeGate`); `apps/api/src/services/intakeGate.ts` reads the row
and `assertReadyToAssign` throws a **409 `CONFLICT`** (`details.code =
INTAKE_GATE`, `details.missing`). It runs on Accept in `decide` (before the
decision commits, so a refused accept stays open), and on a direct or bulk
write of `Assignee` **while a `wo_acceptance` task is open**
(`awaitingAcceptance`), checked against the bag as the save leaves it —
filling Address and Assignee in one save is fine. Work orders nobody is
waiting to accept are never gated. Every `/approvals` row carries
`intake_missing` (labels; `[]` on non-acceptance rows) so the Incoming page
locks Accept with the list and the row says "Fill before assigning: …" with
a link to the work order. 0037 defines `SLA Due Date` as a datetime
(Dates section) — the header and Pulse already read that key, but no
field_def declared it, so nobody could type it; seed.ts carries the same
row. Self-checks: `tests/intake-gate.test.ts`.

**Which work orders a person sees** (migration 0032, rule 8.5, the
roadmap's "my book / my entity") is two more paths in the same permission
tree, so Roles and per-user Adjust draw it with no UI of its own:
`work_orders/scope` view = everything (unset inherits `work_orders` view) or
**false = only work orders assigned to them**, plus every billing entity
granted as `work_orders/scope/entity/<Comp>`. The Roles screen shows it as
the "Which work orders" row (Everything / Only theirs, `WO_SCOPE_CHOICES`)
with one tickable child per Comp value (`/admin/permission-fields` returns
`entities`). 0032 puts OM / OM Under Probation / Senior OM on "Only theirs".
The resolver is `resolveWoScope` in `packages/shared/src/permissions.ts`;
`apps/api/src/services/woScope.ts` turns it into one SQL predicate
(`woScopeSql`: bag `Assignee`, a comma-joined list of display names, matched
against the acting principal's name, `Assignee Name TXT` as the backstop, OR
`t.billing_entity IN (...)`). It is appended by `buildListWhere` (list, ids,
export, group counts), the approvals inbox and badge (own requests always
stay), the quotes and payments queues, KPIs and metrics; `resolveTaskId(id,
actor)` in `services/activity.ts` is what every per-work-order route resolves
through and throws a **403** for a row outside the scope, and bulk edit /
delete refuse a selection that is not wholly inside it. The list header shows
a "Yours only" / "Yours + SFM" chip for a scoped person. Super admins are
never scoped. Not scoped on purpose: the admin console counts and Trash
(admin only), the automations engine (system), and the distinct-value
dropdowns (they list vocabulary, not rows).

**Visits** (migration 0021, `services/visits.ts`, `components/wo/CicoCard.tsx`)
replaced the three check-in/out fields with a log: one `wo_visit` row per
visit (type, tech name + phone, method, own check-in / check-out stamps to
the second; moving `status` stamps the time). The seven legacy bag keys —
`Visit Type`, `18. Check-in/out Status`, `Checked-in At`, `Checked-out At`,
`Tech Name`, `Tech Phone Number`, `CICO Method` (`VISIT_OWNED_KEYS` in shared)
— **mirror the latest visit** and are refused by the field editor and bulk
edit, so columns / filters / automations on them keep working. Mirror writes
are logged `via: 'visit'`; visit writes are logged as `visit_created|updated|
deleted` with snapshots under field `visit:<id>`. `fm_cico_method` (FM → IVR /
App / Phone / …, Admin › Custom fields) pre-fills a new visit's method from the
WO's `22. FM`. The same `CicoCard` renders in the CICO tab and as the CICO
section of All-fields. Gate: `work_orders/fields/cico` view / edit.

**Quote clock and the Due Today view** (migration 0030, rules 2.3.1–2.3.3,
4.1 and 4.3). `Quote Due Date` is a **computed** bag field: the latest *Assessment*
visit's check-out + 48 wall-clock hours, skipping Saturdays, Sundays and the
`holiday` table as whole days, in America/Chicago (`apps/api/src/lib/
businessDays.ts`, pure, self-checks via `tsx`). `syncMirrors` in
`services/visits.ts` re-derives it on every visit write (a Job or Return-trip
check-out never sets it; deleting the assessment visit clears it), logged
`via: 'visit'` like the mirrored keys; the field editor and bulk edit refuse
it (`COMPUTED_KEYS` in shared, same guard as `VISIT_OWNED_KEYS`). `Scheduled
Date` and `Parts Arrival Date` are ordinary hand-typed datetimes; all three
live in the Dates section. The Work Orders page has a **built-in "Due Today"
tab** (`lib/dueToday.ts`, id `builtin:due-today`, never saved or pinned):
under it the status-group segment becomes All · Escalations · Scheduled ·
Quote · Parts arriving, each a filter on a **target day** — rule 4.3's daily
to-do engine, grouped by day: a second segment offers Today (`businessDay()`,
the default, rolls over at midnight) · Tomorrow · any date. Escalations is
Due Date *on or before* the day AND status not Job Sched / On Site (Job)
(`ESCALATION_EXEMPT_STATUSES`); Quote is Quote Due Date *on* the day AND
status still before Quote Ready (`isQuoteOwed`, phases Intake / Assessment /
Quote), widened to *on or earlier* when the day is today so a missed quote
does not vanish the next day; Scheduled and Parts arriving are equality on
the day (Parts Arrival Date is 4.3's "Parts ETA"). The
sections are OR groups in the filter compiler's join mode and the quick-filter
chips are ANDed into every group; the Filter menu is hidden there. The list
cell, the Dates card and the CICO summary turn the date red only while the
quote is still owed (`lib/quoteDue.ts`). Holidays: Admin › Settings card,
`/api/admin/holidays` (grant `admin/settings` edit), seeded with US federal
observed dates for 2026–27 by the migration; the table is **not** truncated
by the seed (configuration, no FKs — the 0012 reasoning). Rule 8.5 scoping
applies to the view like any list (the scope predicate rides in
`buildListWhere`). Deferred: the Pulse's `quote_owed` clock still starts at
Waiting for Quote and should be rewired to this field.

**Emergency flag** (migration 0034, rule 2.5.1). One checkbox custom field,
`Emergency` (`FIELD.emergency`, Overview section, so its permission path is
`work_orders/fields/overview/fields.Emergency`), ticked by hand for now. Every
row payload projects it so the red needs no bag fetch: `emergency` on the
work-order list item, `wo_emergency` on approvals / quotes / payments rows.
The web draws it in one place, `components/EmergencyBadge.tsx`, plus an
`is-emergency` class on list / inbox / queue rows and the header card (red
rail, `.emg` styles in `app.css`); the Flags card lists it first. Later the
client portals decide it: the Ecotrak ingest already maps priority L1 to core
`priority = 'urgent'`, and 0034 seeds a **paused** automation "priority
changed to urgent → Emergency = true" as the hook (the ingest does not
dispatch automations yet). It fires only when the priority changes, so an
admin unticking the box sticks until the client changes their priority again.
The `automation` table is not truncated by the seed, so the rule lives in the
migration only; the field is in `CURATED_FIELDS` too — keep in step.

**Escalation Tracker** (migration 0038, rules 7.3.1–7.3.3; 8.1.3 needs no
code — 0031 already makes OM / OM Under Probation / Senior OM request-only on
the status). The Emergency pattern again, in amber: one checkbox custom
field `Escalated` (`FIELD.escalated`, Overview section, permission path
`work_orders/fields/overview/fields.Escalated`; 0038 sets the three
dispatcher tiers to view-only on it, so **Mark as Escalated** in the
work-order header is a manager's button — whoever has the field's edit).
Rows project it as `escalated` / `wo_escalated`; `components/
EscalatedBadge.tsx` + `is-escalated` (`.esc` styles; the red rail wins when
a row is both). 7.3.3: the Approvals inbox is the "unified to-do list"
(Elise's call) and `lib/inboxOrder.ts` pins escalated rows above the rest of
the waiting lanes; the team-wide tracker is a second built-in tab on Work
Orders, `builtin:escalations` (`lib/escalations.ts`, an ordinary filter set
`Escalated is_true`, so status tabs / chips / Filter menu still work; not
saveable or pinnable), reached only from the Work Orders view strip; the
sidebar entry was dropped 2026-09-15 as redundant). Not the same thing as Due Today's *Escalations* list
(rule 4.3, a due-date test). 7.3.2: `POST /api/webhooks/email-escalation`
(`routes/webhooks.ts`, allowlisted in `authGuard`, refused in DEMO_MODE)
takes `{wo_number, reason?, source_email?, subject?, message_id?}` with the
shared secret `ESCALATION_WEBHOOK_SECRET` in `x-webhook-secret` or a Bearer
header (`lib/webhookAuth.ts`, constant-time; unset secret = 403 for every
call). `services/escalations.ts` sets the flag through
`updateWorkOrderFields` as the **Email escalations** service principal, so
the `field_updated` row reads `via: 'webhook'` and automations dispatch,
then logs the raw payload as `escalation_received` on the work order (or
`escalation_unmatched`, entity `webhook`, keyed by the number as sent, and
answers 404). The webhook never clears the flag. The email tool is
standalone today: the payload shape is the contract to align it to.

**Ecotrak allowed transitions** (rules 2.6.3 / 2.7, no migration). Ecotrak
only lets a service provider move a work order to a few statuses from
wherever it sits on THEIR side, and 2.7 says which Ecotrak status each of
our statuses would push ("Nexxess to Ecotrack"; On Site is En route *then*
Arrived). Both tables are pure data in `packages/shared/src/ecotrak.ts`
(`ECOTRAK_ALLOWED_TRANSITIONS`, `ECOTRAK_PUSH_BY_STATUS_NAME`) and
`checkEcotrakTransition(currentEcotrakStatus, targetStatusName)` answers
`not_linked | no_push | unlisted | allowed | blocked | locked`. The current
Ecotrak status is the `Ecotrak Status` bag key, which Jordan's inbound sync
on phase-0-ground writes; **nothing here talks to Ecotrak** (the adapter is
read-only until go-live and this file must not import from or edit it).
`changeStatus` runs the check: `ECOTRAK_TRANSITION_MODE=warn` (default) lets
the move through and stamps `after.ecotrak = {outcome, from, to}` on the
`status_changed` row (the audit trail and Admin › Audit read it); `block`
refuses with a **409 `CONFLICT`** (`details.code = ECOTRAK_TRANSITION`). The
status menu takes `ecotrakStatus` and tags a pick Ecotrak would refuse; the
header shows an "Ecotrak · <status>" chip. Deferred on purpose and answered
`unlisted`, never refused: targets no allowed list names (PROPOSAL_SUBMITTED
comes from the proposal push, CANCELLED is not SP-writable, ACCEPTED is a
one-time act), the "NA" statuses, and SOFT_COMPLETED as a current state.
The 2.7 "Proposed Internal Status Transitions" (our own status order) is a
separate rule, not modelled. Self-checks: `npx tsx
apps/api/src/lib/ecotrakTransitions.selfcheck.ts` from `app/`.

**Quoting & Parts gate** (rules 11.2.1 / 11.2.2, migration 0035). Two
statuses cannot be entered empty-handed: **Quote Ready** needs the work
order's quote to contain data (at least one line item or one non-blank
scope line in any section — an empty draft does not count; Waiting for
Quote needs nothing), and **Waiting for Parts / Please Order Parts** need
the `Parts Required` bag field (0035, long text, Overview section for
permissions, edited on the Parts tab). Vocabulary and "filled" live in
`packages/shared/src/statusGates.ts` (`statusGateFor`, `partsRequiredFilled`,
`quoteSectionsHaveData`, `describeStatusGate`); the database half is
`apps/api/src/services/statusGates.ts` (`assertStatusGate`, one 409
`CONFLICT` with `details.code = STATUS_GATE`, `details.gate = quote|parts`).
It runs in `changeStatus` (so the single move, an approved request and an
automation's status action are all covered — the engine records the refusal
as an errored run), in `bulkUpdate` (the whole selection is refused when any
row would fail, and a Parts Required value in the same patch counts), in
`requestStatusChange` (a request the gate would refuse is refused up front)
and in `decide` before an approval commits (asked again, in case the quote
or the list was emptied since). The status menu tags a pick "Needs quote" /
"Needs parts" from `gateHints` (the detail page hands it the quote query
and the bag) and prints the API's sentence after a refused click. Not
gated on purpose: the CSV import (an upsert that names a status is a data
load, not a person pausing a job) and the seed's own statuses.

**Job is Done gate** (rules 11.3.1–11.3.3, no migration) is the third gate
in the same two files: **Done / Incurred** needs a visit that checked in AND
out (any `wo_visit` row with both stamps — 11.3.1), the final vendor cost
(the `34. Cost` bag key, `FINAL_COST_KEY`, hand-typed in V1 — 11.3.2) and a
quote with data (the 11.2.1 test — 11.3.3). `statusGateFor` answers `done`,
`doneGateMissing` / `doneGateMissingFor` say which of `visit|cost|quote` is
absent, the 409 carries `details.missing`, and the sentence and the menu
tag ("Needs check-out" / "Needs cost" / "Needs quote", "Not ready" for
several) name only what is missing. The header's hints for the tag read the
mirrored keys of the LATEST visit and the Cost field; the API reads every
visit. Deferred with the subsystems they need: the After-photo / BFI check
(11.3.4, no drive) and the tech rating (11.3.5 / 3.3.1, no tech database).

**Check-in moves On Site** (rule 2.2.2, no migration). A visit moving INTO
`checked_in` — created as checked in, or planned → checked in — moves the
work order to **On Site (Assessment)** for an Assessment visit and **On Site
(Job)** for a Job *or a Return trip* (`onSiteStatusNameForVisitType` in
`packages/shared/src/visitStatus.ts`; an unknown visit type moves nothing).
`moveOnSite` in `services/visits.ts` runs after the visit's transaction
through the ordinary `changeStatus` with source `'visit'` (the audit row
reads `via: 'visit'`), does **not** ask the status permission (a request-mode
dispatcher checking a tech in still moves it — a system consequence, not a
pick), and still runs the gates and the Ecotrak check. A refusal never
undoes the check-in: the reply's `status_move` carries the reason and the
CICO card prints it. Correcting a stamp or checking out moves nothing.

**Reassignment lock** (rule 8.5.4, migration 0039) is one permission, not
code: OM / OM Under Probation / Senior OM are view-only on
`work_orders/fields/people/fields.Assignee`, so `assertFieldWrites` refuses
their Assignee writes and the editor draws it read-only; Accept & assign
(0036) and a manager's edit are untouched. Loosen it per role in Admin ›
Roles or per person with Adjust.

**Status requests vs Ecotrak** (rule 2.6.4). `assertEcotrakAllowsMove` in
`services/approvals.ts` runs at request time and again in `decide` BEFORE
the decision commits (so an approval never lands without its move — in
block mode the old order approved the task and then 409'd the move). It
follows `ECOTRAK_TRANSITION_MODE` like a direct move: `block` refuses with
"API Violation: Ecotrack does not allow this status transition." plus the
2.6.3 sentence; `warn` (default) lets it through and stamps the
`status_changed` row. Every inbox row carries `wo_ecotrak_status` and the
Approvals page tags an open status request Ecotrak would refuse.

**WO Intake** (section 14, migration 0040, the **Drafts tab of Incoming Work
Orders**, `/incoming/drafts`; the old `/intake` URLs redirect there) is the
OP Admin's staging area for work orders typed in by hand — the first manual
creation path (until now only the CSV import and the Ecotrak ingest created
rows). A draft is a `wo_intake_draft` row, **not a task**: nothing that
lists work orders knows it exists, so no query changed. Vocabulary in
`packages/shared/src/intakeDrafts.ts` (`INTAKE_FORM_FIELDS` = WO# + the 13
fields of 11.1.1 + optional Client; `intakeDraftMissing` reuses
`intakeMissing`; `intakeDraftReady` adds the assignee), rows and the
submit in `apps/api/src/services/intake.ts`, routes under `/api/intake/
drafts`. **Submit** (`submitIntakeDraft`) refuses with a 409
`INTAKE_SUBMIT` (`details.missing`, `details.assignee_missing`) until every
required field and an active assignee are in, refuses a WO# that already
exists, then INSERTs the task the way the import does (status **Open** by
name, title = first line of the description, promoted columns from the
bag, `applyProfitFormula`), logs `created` with `source: 'intake'`,
dispatches the create rules, and writes the Assignee through
`updateWorkOrderFields` so the assignment is audited, mirrored and scoped
like any other. **No acceptance task is raised** — the OP Admin's
assignment is the handoff (14.3.3); rule 7.1 stays for rows the system or a
client created unassigned. Discard is an UPDATE (`discarded_at`, rule
8.1.1). Audit: `intake_draft_created|updated|submitted|discarded`, entity
`intake_draft`, whole snapshots (Admin › Audit links them to the draft).
Permission path `intake` (view / create / edit; a node in the Roles
tree); 0040 grants it to Operations Admin (`oa`, the BRD's OP Admin) and
Admin. The form draws every field from the work-order catalogue
(`useWoCatalogue`, keyed `fields.<key>`) so types and dropdown options
match the editor; dates go in as ISO, money as a number.

**Add work order** (migration 0041, `services/woCreate.ts`,
`components/wo/list/CreateWorkOrderDialog.tsx`) is the same act without the
draft: the list's accent button, gated on `work_orders:create`, opens a form
and POSTs `/api/work-orders`. **The form is configuration**:
`field_def.create_mode` (`off` | `optional` | `required`) says per field
whether it is offered and whether Create refuses without it, set from the
"Add work order" column in Admin › Custom fields and read back by
`GET /work-orders/new/form` — so putting a field on intake needs no deploy.
0041 switches on the 18 keys of `WO_CREATE_DEFAULT_KEYS`
(`packages/shared/src/woCreate.ts`), all `optional`; the seed re-applies the
same list (keep in step). WO # is not a field_def (`task.wo_number`, NOT NULL
UNIQUE) so it is always shown, always required, and drawn as its own row.
**Duplicates, two kinds:** the WO # is identity — `GET /work-orders/new/check`
(debounced, live) and `createWorkOrder` both refuse a repeat with 409
`WO_NUMBER_TAKEN`, trash included, matching on
`normalizeWoNumber` (case, punctuation and a leading "WO" dropped, mirrored in
SQL so the browser and the API agree); a **near match** — same Store and Trade,
still open, inside `WO_NEAR_DUPLICATE_DAYS` — only warns with links, because a
store really can break twice. There is no override (Elise, 2026-09-20). The
INSERT is the intake submit's, verbatim: status **Open** by name, title = first
line of the description, promoted columns, `applyProfitFormula`, `created`
logged with `source: 'manual'`, then the create rules, then the Assignee
through `updateWorkOrderFields`. Per-field edit grants are checked on the way
in (`assertFieldWrites`), and a key the form does not offer is dropped rather
than written. Creation stays lighter than assignment on purpose: rule 11.1.1
still holds the work order back from a dispatcher until its 13 fields are in,
whatever is required here.

**Dashboards** (migration 0042, `services/dashboards.ts`,
`components/dash/DashboardBoard.tsx`) are records now, not one person's
prefs: `dashboard_folder` → `dashboard` → `dashboard_widget`. **Sharing is
not scope** — `shared_all` / `shared_roles` (role codes) decide who may OPEN
one; what its cards COUNT still goes through `woScopeSql` per viewer (0026),
so two dispatchers open the same board and each sees their own book, and
sharing can never leak a row. Edit is the owner's or a super admin's.
A widget is `{kind: number|bar|donut|table, config:{metric: count|sum|avg,
value_field, group_field, filters, limit}}`; `metricWidget` in
`woMetrics.ts` answers it (`compileNumericExpr` in `woFields.ts` refuses a
non-numeric field rather than totalling zero), the headline number is its
own query (an average of averages is not an average), and one bad card
reports its own error instead of failing the page. `GET /dashboards/:id/data`
answers every card in ONE call so the whole board is measured at one
instant. The three we ship (Dispatch Center, Approvals & bottlenecks, Money)
live in `packages/shared/src/dashboards.ts` and are upserted by
`ensureSystemDashboards()` on first read, keyed by `system_key` — **not** in
the migration and **not** in the seed, which is the pair that kept drifting;
it INSERTs only what is missing, so an edited one stays edited. Every card
uses data that exists today: vendor, site and invoice cards wait for those
modules, because a board with blanks reads as broken. Charts are Recharts,
**lazily loaded** (`WidgetCharts.tsx`, its own 380KB chunk) — the palette and
row shape live in `chartPalette.ts` precisely so `WidgetCard` can draw a
table without pulling the library in; import them from the wrong side and
the split silently stops working. The eight `--chart-N` tokens per theme
(`theme/tokens.css`) were validated, not eyeballed: lightness band, chroma
floor, 3:1 on their own surface, and every adjacent pair separated under
deuteranopia, protanopia and tritanopia. Permission path `dashboard`
(view / **create** = build and share); 0042 grants create to admin / tl /
atl / am. The old per-user cards (`DashCards`, user_pref
`dashboard.cards`) stay exactly as they were, on the Main Dashboard tab.

**Attachments** (migration 0043, `services/attachments.ts`,
`components/wo/PhotosCard.tsx`) turn the three disabled upload buttons on.
Files live in a **private Vercel Blob store**; `attachment.storage_key` is the
blob pathname and **no URL is ever stored or handed out** — every read goes
back through `GET /work-orders/:id/attachments/:attId`, which runs
`resolveTaskId` first, so a photo is exactly as visible as its work order and
a copied link is useless to anyone else. The token is
`BLOB_READ_WRITE_TOKEN`; without it `storageReady()` is false, the list says
so and the buttons explain themselves rather than failing on click. An upload
is base64 JSON (one hop, no multipart) capped at `ATTACHMENT_MAX_BYTES` (4MB)
against an allow-list of types — and the BROWSER shrinks a photo first
(`lib/upload.ts`, 2000px longest edge), because a phone picture is several
times what a serverless request body will take; HEIC cannot be decoded on a
canvas so it goes up as-is or is refused. Images group before/after by
`client_visible` (internal = the assessment, client-visible = sign-off);
anything else lists underneath. Logged `attachment_added|removed` under field
`attachment:<id>`. Permission path `work_orders/attachments` (create /
delete); reading needs only `work_orders` view.

**Photo approval and proof before Done** (migration 0061, rules 1.3.1–1.3.4
and 11.3.4). Every upload lands `attachment.review_status = 'pending'` and is
**quarantined**: `listAttachments` and the bytes route show a pending or
declined file only to a reviewer (`work_orders/attachments` **approve**) and
to the person who uploaded it — to anyone else it answers like a missing
file. `POST /work-orders/:id/attachments/:attId/review {decision, kind?,
file_name?}` approves or declines ONE file (1.3.4); approving needs a `kind`
(`before | after | signoff | other`) and may rename the file (1.3.3), and a
decision can be reversed by deciding again. Logged `attachment_approved|
declined`. The Photos card draws a "Waiting for approval" list on top with
the name, a "What is it?" select and Approve / Decline per row; approved
images group by `kind` (no longer by `client_visible`). 0061 stamps the files
that already existed as approved (internal image = before, client-visible =
after) and grants `approve` to admin / tl / atl / am / oa / senior_om / om —
not the probation tiers. There is no Tech Chat yet, so "uploaded in the Tech
Chat" (1.3.1) is every upload on the work order. Rule 11.3.4 is two more
checks in the Job is Done gate (`after_photo`, `bfi_proof` in
`DoneGateCheck`; `completionProofMissing` in shared `attachments.ts`):
Done / Incurred needs an approved after photo, or — when the new checkbox
field `Bill For Incurred` (`BFI_KEY`, AR section, seed + 0061 in step) is
ticked — an approved before photo AND an approved sign-off instead. Only
files with a blob behind them count. The header feeds the status menu the
approved kinds from the same `['wo-attachments', id]` cache entry, so the
"Needs after photo" tag clears the moment a photo is approved.

**Trend cards and the board's period** (migration 0044, rule-free, the
dashboards' second half). A fifth widget kind, `line`, cuts by WHEN instead of
by a category: `config.time_field` + `bucket` (day/week/month),
`compileDateTruncExpr` in `woFields.ts` (refuses a non-date), newest-first out
of SQL so the limit keeps RECENT points, reversed on the way out so it reads
left to right. It wears one hue — consecutive months are not separate
categories — and has no "everything else" bucket. The **period** is one
control for the whole board (`resolvePeriod` in shared, computed in UTC so
browser and API agree on which month it is): presets All time / month /
quarter / year / last 30, with ‹ › stepping on the three that can step. It
ANDs `date_received` into every card's own filters rather than replacing them,
and defaults to All time so a board means what it meant before anyone touched
it.

**Invoices** (migration 0045, `services/invoices.ts`,
`components/rcv/InvoicingTab.tsx`, `components/wo/InvoiceCard.tsx`) are the
last money record to become real: Receivables › Invoicing kept its stages in
React state and derived "Invoice #" from the work order's id, so a reload
undid the lot. Decisions (Elise, 2026-09-20): **one invoice per work order**
(consolidating a month of jobs becomes a join table when it is wanted, not a
rewrite); the amount **starts from the approved quote** — incurred plus every
option flagged `include_in_summary`, overtime folded into the unit price —
and stays editable until it is sent; the **number is per billing entity and
year** (`SFM-2026-0007`), claimed by an UPDATE on `invoice_sequence` inside
the issuing transaction so two simultaneous Creates cannot collide, and never
reused. Lines are a **snapshot**, not a join: a sent invoice keeps saying what
it said when it was sent. `draft → sent → paid`, or `void` (which keeps the
number and can be reopened); the transition table is enforced in `move()`, not
just hidden in the UI, and only `invoicing:approve` may send. **Money is
computed in integer hundredths** (`lineAmount`, `invoiceTotals` in shared):
`1.5 × 99.99` is 149.985, which must bill as 149.99 — rounding the double
gives 149.98 and short-changes the client a cent. The queue is scoped by
`woScopeSql` like every other read. Logged `invoice_created|updated|
status_changed` under field `invoice:<id>`. Permission path `invoicing` (view
/ create / edit / **approve** = send); 0045 grants the full set to admin + ar
and view/create to am + tl. The Ready lane is still DERIVED from the audit
(clean + Admin + Quote ticked, and not already billed); everything past it is
a record.

**Contracts and labor rates** (migration 0046, `services/contracts.ts`,
`/contracts` in the sidebar, permission path `contracts`) are the client rate
cards: hourly / overtime / double-time / trip charge / markup on parts, for a
client (or all), an entity (or all), some sites and trades (or all), between
two dates. `contractForTask(taskId)` picks the most specific card in force
(`pickContract` + `resolveRates` in `packages/shared/src/contracts.ts`, pure
and tested). Two readers: **the quote builder** snapshots `quote.contract_id`
+ `quote.ot_multiplier` (overtime ÷ standard, else the house ×1.5) when a
quote is created, so an approved quote never re-prices; **the invoice**, when
a work order has no quote and a T&M contract covers it, bills hours on site
(every checked-out `wo_visit`, to the quarter hour) at the standard rate plus
the trip charge per visit (`prefillFromContract`). Logged as admin changes
(`contract_created|updated|deleted`).

**The Financial tab, the rest of BRD §6.4** (migration 0053,
`services/billingProposals.ts`, `components/wo/BillingProposalBlock.tsx`,
`components/quote/QuoteDecision.tsx`). A contract now has a **party**:
`client` (what we bill, matched as before) or `vendor` (what the vendor bills
us, matched by `contract.vendor_name` against the work order's vendor —
`taskVendor`: the latest visit's `Tech Name`, else the newest payment
request's payee; vendors are still names on a work order). `contractScore`
refuses the other party, so a vendor card never prices a client invoice.
**`contract.auto_invoice`** ("Bill automatically on completion") is the
switch: when `changeStatus` lands a work order in the `done` group from
outside it, `proposeBillingOnCompletion` (after the commit, never throws)
writes at most one pending **`billing_proposal`** per kind — `invoice` from
the client card (the approved quote's lines, else hours × rate + trip charge:
`draftInvoice`, the same lines Raise invoice would write) and `vendor_bill`
from the vendor card (hours × rate + trip charge, `contractBillingLines` in
`packages/shared/src/billing.ts`, tested). A proposal is not a document: no
number, no queue totals. **Confirm** (`POST /billing-proposals/:id/confirm`,
needs the kind's `create` grant — `invoicing` or `payments`) files the
invoice / vendor bill with exactly the proposal's lines, through the normal
`createInvoice` / `createVendorBill`; **Dismiss** files nothing and keeps the
note. Drawn on the Finances card (Confirm invoice), the Payables card
(Confirm bill) and as a **Proposed** lane in Receivables › Invoicing. Logged
`billing_proposed|billing_proposal_confirmed|dismissed` under field
`proposal:<id>`. The invoice also snapshots `title`, `site` (Store + address
line), `vendor_name` / `vendor_contact` and `contract_id` when raised
(BRD "invoice contents"); a vendor bill keeps its `contract_id`. Quotes can
be approved / declined from the Finances card and from the Quotes list rows
(`QuoteDecision`: approve then send, like the builder's CTA; decline needs a
note), gated by `quote.permissions.can_approve` / `quotes:approve`.

**Vendor bills** (migration 0047, `services/vendorBills.ts`, Payments ›
Vendor bills lane and the `VendorBillsCard` on the Payables tab) are the AP
half of invoicing: the vendor's own invoice against a work order, `received →
approved → paid`, or `disputed` (internal comment, back to received on
resolve) or `void`. Same integer-cent arithmetic as the client invoice. Gates
reuse Payments: `payments:create` records, `payments:approve` approves,
`payments/process:edit` pays. Logged `vendor_bill_created|updated|
status_changed` under field `vendor_bill:<id>`.

**Approval tiers by amount** (0047, rule 6.2.3, `services/approvalTiers.ts`,
Admin › Settings card, `/api/admin/approval-tiers` under `admin/settings`
edit) are bands of money per decision kind (`payment`, `vendor_bill`,
`invoice`) naming the roles that may say yes inside them; empty roles = anyone
with the base permission; super admins never restricted. Enforced at the
decision — payment approve, vendor-bill approve, invoice send — as a **403**
with `details.code = APPROVAL_TIER`; the queue rows carry `tier: {label,
allowed}` so the button locks with the reason first. 0047 seeds the BRD's
bands (under $500 anyone · $500–3,000 tl/atl/am/admin · over $3,000 tl/admin;
invoices $10,000+ ar/tl/admin) only when the table is empty; the seed never
touches it.

**The quote as a document** (migration 0048): `quote.number`
(`Q-SFM-2026-0001`, per entity per year from `quote_sequence`, issued at
create, existing quotes back-numbered by the migration), `document_type`
(quote / proposal / estimate), `currency`, `bill_to`, `ship_to`; per line
`uom`, `tax_pct`, `markup_pct`. Amount = qty × rate × (1 + markup) × (OT ?
multiplier : 1); a line's tax rides with its option and lands in
`totals.line_tax`, added to the grand total beside the manual sales tax — both
sides of the parity test (web `lib/quoteTotals.ts`, API `computeQuoteTotals`)
take the multiplier as a parameter and default to the old figures. The
printable document is `/work-orders/:wo/quote/print` (`QuotePrintPage`, its
own print stylesheet in `quote.css`, "save as PDF" is the browser's print
dialog — no server renderer). The Quotes list has status lanes and the number.

**Dashboards, the rest of the library** (migration 0049): card kinds `gauge`
(a figure against `config.target`, or the largest plain figure on the board),
`live` (re-reads every `refresh_seconds`, the fastest card sets the board's
`refetchInterval`), `narrative`, `image`, `link` (furniture — never queried,
`widgetAsksQuestion`). A card may name a **source** other than work orders —
`invoices`, `payments`, `vendor_bills` — with `SOURCE_FIELDS` as the only
columns it may total, cut by or run along and `source_status` /
`source_overdue` as its narrowing (`metricSourceWidget` in `woMetrics.ts`,
still joined to `task` for the viewer's scope). The board has a **filter bar**
(client, entity, trade, store, dispatcher — `PAGE_FILTER_FIELDS`) that ANDs
into every work-order card like the period does (`?filters=` on `/data`).
Date filter rules may say `today`, `today+7`, `today-1` (resolved to
`CURRENT_DATE` in `compileRule`), which is what the new **Service levels**
board runs on; the **Accounting** board is built from the money records.
Prebuilt boards are still upserted by `system_key` on first read.

**Which dashboards a role opens** (migration 0050). Visibility left the
dashboard row and joined the permission tree, so Admin › Roles (and per-user
Adjust) decide it: Dashboard › **Which dashboards** has one row per page —
Needs Attention and Main Dashboard (`DASH_BUILTIN_BOARDS`, refs `attention` /
`main`) and every record (ref = `system_key`, else the id;
`/admin/permission-fields` returns `dashboards`) at
`dashboard/boards/<ref>` view. Under each, **"Which work orders it counts"**
(`…/scope`, `DASH_SCOPE_CHOICES`): Same as work orders (unset) / Everything /
Only theirs. That path is read **exactly** (`resolveDashboardScope`, PermNode
`exact`), never inherited from the tick above it; `withDashboardScope` swaps it
in for `work_orders/scope` and `boardViewer` in `services/dashboards.ts` is
what `/dashboards/:id/data`, the preview and `?board=main|attention` on
`/kpis`, `/metrics/*` and the new count-only `/work-orders/count` count with.
It widens or narrows the **counts only**: the list a card opens stays scoped
by "Which work orders", and `/work-orders/count` returns no rows for that
reason. 0050 copies each dashboard's old sharing into grants, sets
`dashboard/boards` to no (a new dashboard stays with its builder) and both
built-in pages to yes; a shipped board inserted later takes its
`shared_roles` as grants in `ensureSystemDashboards`. The Share button writes
the same role grants through `updateRole` (so each is a `role_updated` audit
row); `shared_roles` / `shared_all` are kept in step and decide nothing.

**Planned maintenance** (migration 0051, `services/plannedMaintenance.ts`,
`/planned-maintenance` in the sidebar, permission path `planned_maintenance`:
admin / tl / atl / am full, the OM tiers + ops_coord + oa view). A
`pm_schedule` is one job at one place on a rhythm — client / entity / store /
site / address / trade / description / NTE / assignee (a display name, checked
like intake's), `every` × `unit` (day / week / month / year) from
`starts_on` to `ends_on`, `lead_days` ahead — with a sequence code
`PM-0001`. The date arithmetic is pure in `packages/shared/src/
plannedMaintenance.ts` (`nextDueOn`: whole periods from the anchor, month
ends clamped without drifting; tests in `tests/planned-maintenance.test.ts`).
`raiseDueWorkOrders` raises one work order per due date inside the lead
window (12 at most per schedule per run): a `pm_occurrence` row is claimed
first (UNIQUE schedule_id + due_on, so the page read, the button and the
cron cannot double-raise), then the same task INSERT the intake Submit runs
(WO # `<code>-<due>`, `ext_name` = code, status **PM Sched** falling back to
Open, `Scheduled Date` / `Due Date` = the due date, `task.pm_schedule_id`,
'created' activity with `source: 'planned_maintenance'`, automations, then
the assignee through the field path), signed by the 'Planned maintenance'
service principal. No 7.1 acceptance task: planned work was accepted when it
was scheduled. It runs on every GET of the list, after create/update, on
**Raise now** (next date, lead window or not), and daily from Vercel's cron
(`vercel.json` → GET `/api/webhooks/planned-maintenance-run`, allowlisted in
authGuard, checks `CRON_SECRET` — unset = 403, the other triggers still
work). **Skip** records a skipped occurrence. Deleting a schedule keeps its
work orders (`pm_schedule_id` → NULL). Admin audit entity `pm_schedule`
(`pm_schedule_created|updated|deleted|skipped`). Not built: the work-order
detail does not yet show its schedule; sites / assets stay text until batch 2.

**Messages** (migration 0052, `services/woMessages.ts`, `components/wo/
messages/`). The Messages tab is the work order's own conversation on EVERY
work order: a message is internal (the team) or client-visible, and the
Overview composer moved here (the Updates feed only reads now, with a "Write
a message" button). The store is still the `comment` table: 0052 adds
`source` (`staff` | `client` — a note the client wrote in their CMMS has no
principal, `external_author` / `external_target` / `external_id` say who and
where, unique on the last two so a re-sync never duplicates), `edited_at`,
and the **outbox** `comment_delivery` — one row per (message, client system)
for a client-visible message on a work order whose `Client Portal Type` names
Ecotrak / Corrigo / ServiceChannel (`clientMessageTarget` in
`packages/shared/src/messaging.ts`); `pending` until an adapter sends it,
then `sent` (external id) or `failed` (error). **No adapter is registered**
(`modules/integrations/clientMessages.ts` is the port; Ecotrak stays out
until go-live, Corrigo and ServiceChannel are not built), so every delivery
sits at pending and the bubble says "Queued for X · sends once that
integration is live". Rules: **no edits once sent** (any `sent` row locks it,
409 `MESSAGE_SENT`), only the author edits, never a client-sourced note;
editing can flip visibility (queues / drops the pending row). Routes:
`GET|POST /work-orders/:id/messages`, `PATCH …/messages/:messageId`; the Quo
technician thread moved to `…/messages/quo` and rides in the same GET under
`quo`. Permissions: `work_orders/comments` create (post) / edit (own unsent),
child `work_orders/comments/client` create = "Message the client" in Roles
(unset inherits; 0052 sets it false for om_probation and ops_coord). Audit:
`comment_added` (+ `source`, `delivery`), `message_edited` (before/after body
and visibility), `client_message_sent|failed|received`. The obligations
engine counts only a `staff` client-visible message as a chase. Inbound
(`receiveClientMessage`) is the function an adapter calls; no route yet.
Deferred: email as a delivery target, and the adapters themselves.

**Calls through Quo and the AI quote draft** (migration 0054,
`services/woCalls.ts`, `services/aiQuote.ts`, `lib/aiQuotePrompt.ts`,
`components/wo/calls/`, `pages/AiQuoteReviewPage.tsx`). Quo's API **cannot
start a call**, so the **Call** button in the work-order header records the
intent first — a `wo_call` row (who, E.164 phone, purpose `call` | `quote` =
"Just call" / "Call and draft a quote") — then hands `tel:+1…` to the Quo
desktop app (it must be the Windows tel: handler). Quo's webhooks come back to
`POST /api/webhooks/quo` (public path; signature checked in
`lib/quoSignature.ts` against `QUO_WEBHOOK_SECRET`, legacy
`openphone-signature` and Standard Webhooks both accepted; unset = 403):
`call.completed` matches the newest unmatched row for the dialled number
placed ≤30 min before / 5 min after the call started and stamps
`quo_call_id`; `call.transcript.completed` stores the dialogue by that id (or
by number when it beats the completed event); `call.summary.completed`
stores Quo's summary. **A call nobody placed from a work order is dropped** —
the webhook sees every call on the line. A `dialing` row with nothing from
Quo after 3 h reads `expired` (derived, `displayCallStatus`). A transcript can
be pasted by hand (`parsePastedTranscript`, "Name: text" lines). The call log
is a Calls card at the top of the Messages tab (polls every 15 s while a call
waits on Quo). **The AI draft** (`quote_ai_draft`, one per call):
`POST …/calls/:callId/quote-draft` sends the transcript, the work order and
its client contract rates (`contractForTask`) to Claude (`ANTHROPIC_API_KEY`,
`QUOTE_AI_MODEL` default `claude-opus-5`, structured JSON output, server-side
refusal fallback) and stores the answer as **the quote builder's PUT body**
plus `assumptions` / `missing_info`. Prices are never invented: stated client
price → vendor cost + contract markup → contract hourly / trip rate → rate 0
and a `missing_info` entry. The review page shows the draft in the builder's
own editors beside the transcript, autosaves edits to the draft (`PUT`), and
**Submit quote** runs the ordinary `createQuote` + `updateQuote` — same
number, permissions and `quote_updated` row as typing it — then lands in the
builder. A quote with content is replaced only after a confirm (409
`QUOTE_HAS_CONTENT` → `replace: true`); approved / sent is never touched (409
`QUOTE_LOCKED`). Generation runs inside the request (20–60 s), hence
`functions["api/index.js"].maxDuration = 300` in `vercel.json`. Permissions:
`work_orders/calls` view / create (0054 grants both to every role); drafting
and submitting also need `quotes` edit (create when the WO has no quote).
Audit: `call_placed`, `call_completed`, `call_transcribed` (the 'Quo' service
principal, or the person who pasted), `quote_ai_drafted|redrafted|submitted|
discarded`. Next: past quotes from the ClickUp import as pricing references
(vector search) go into `buildUserMessage`.

**Vendors, technicians and the technician map** (migrations 0056 + 0057,
`services/vendors.ts`, `services/vendorMap.ts`, `services/geo.ts`,
`routes/vendors.ts`, `packages/shared/src/vendors.ts`, `pages/VendorsPage.tsx`,
`pages/VendorDetailPage.tsx`, `pages/admin/AdminVendorsPage.tsx`,
`components/wo/tech/`, `components/map/VendorMap.tsx`). The One's own copy of
what **VR - CRM** and **Tech Locator** do. Those two apps keep running,
untouched, until The One replaces them: **nothing here reads or writes their
code or their database**, and the module starts with no imported data.
One `vendor` table (0001, grown by 0057) holds both kinds: `kind 'vendor'` (a
company the VR team recruited — Tech Locator's "VR Data") and `kind 'tech'` (a
technician a dispatcher has worked with). Columns carry what the list and the
map read; the long tail of the CRM profile lives in `vendor.details` (jsonb),
keyed by `VENDOR_DETAIL_SECTIONS` in shared, so a new profile section needs no
migration. `trades` (0001) is kept as primary + secondary (the Quo thread and
payables read it). Removal is a soft delete (`deleted_at`).
*Geo (0056):* `geo_zip` (GeoNames) and `geo_city` (Census places + towns) are
centre points in our own database — **no outside geocoder**. `geoLookup` takes
a ZIP first, else city + state through `cityKey` (must match
`geo_city.name_key`); `workOrderPlace` reads the work order's `Zip Code`, the
ZIP at the tail of `17. Address`, else city + state. A vendor's home city is
its primary `vendor_location` (lat/lng NULL when it cannot be placed → "Not on
the map"); a technician may have several.
*Rules:* a new vendor whose name or any phone matches one on file is a 409
`VENDOR_DUPLICATE` until `override_duplicate` (then saved flagged); a
technician is a duplicate by phone only. `compliance_status` is **derived**
(`recomputeCompliance`): a current insurance date in the past → EXPIRED; W-9 +
MSA + COI received **and the COI approved** → APPROVED, which is also when a
New / Interested / Ready vendor turns Active (not on upload); only the latest
`vendor_expiry` date per (company, type) counts. Statuses, brand sources and
vendor trades are tables every dropdown reads (`vendor_status`,
`vendor_brand_source`, `vendor_trade`). Dispatchers never remove a technician:
they add a `vendor_note` or **blacklist** (flag + required reason, visible to
all, sorts last; clearing is `vendors/blacklist` edit).
*The map* opens **from a work order only** (People tab › Technicians › Find a
technician; `GET /work-orders/:id/tech-map`), centred on the work order, radius
from `vendor_setting.map_radius_miles` (100). Who is on it is the role's
`vendor_map/*` grants (`resolveVendorMapScope`): VR vendors (`/vr`), all
technicians or only theirs (`/techs`, choices row), statewide, nationwide,
subcontractors, add a technician. "Theirs" = `vendor_dispatcher` links, added
when a person adds a technician, **hires one, or logs a visit with one picked
from the records** (`linkVisitVendor`, called by the visit routes after
`createVisit` / `updateVisit`; `wo_visit.vendor_id`). Nothing filters on vendor
status or paperwork; Hire **warns, never blocks** (`complianceWarning`).
Preferred vendors (`preferred_vendor`: client and/or trade, optional state,
ranked) are marked and sorted first (`preferredRuleScore`, most specific rule
wins). A statewide / nationwide vendor with no placed city is pinned at the
work order, as Tech Locator did. Each open is logged (`vendor_map_log`);
over `map_daily_alert` a day shows in Admin › Vendors & map — alert only.
Postgres cannot type a bound parameter the statement never uses, so the map
query binds the state only for roles that see statewide vendors.
*Hiring:* `wo_technician` (the People tab's Technicians card); Call goes
through the Quo `CallDialog` (`preset`). The visit forms' Technician box is
`TechPicker`: free text as before, with any technician on file underneath
(hired ones first, whoever owns them).
*The map canvas* is MapLibre GL over OpenFreeMap (Positron by day, Dark at
night), lazy-loaded in its own chunk; marker colours are the `--map-*` tokens
read off `:root`; vendors sharing a city centre are fanned out by
`spreadOverlaps`. Vendors › Coverage map is the same canvas over every placed
location — the admin's "where do we recruit next" view, not the work-order map.
*Permissions:* `vendors` (view/create/edit/delete — 0057 overwrites 0021's
placeholder: managers, admin and VR Officer in, everyone else out),
`vendors/scope` (everything / only theirs), `vendors/blacklist`,
`vendor_map` (view = open, create = hire) and its children, `admin/vendors`.
Audit: entity `vendor` (`vendor_created|updated|deleted|note_added|
blacklisted|blacklist_cleared|expiry_added|expiry_removed`), `vendor_setting`,
`preferred_vendor`; `tech_hired|tech_released|tech_added` on the work order.
*Payments dashboard:* a prebuilt `payments` board (shared `PREBUILT_DASHBOARDS`)
over The One's own payment requests; the `payments` card source gained
dispatcher, company, FM, trade, state, purpose, work order and vendor fields.
No Teams payment history is imported.
**Not built yet (VR - CRM parity still to come):** document uploads (COI / W-9
/ MSA) and the COI review loop, the task types, Alerts, Data Quality, the CSV
import wizard, saved lists / advanced filters / bulk edit, the call log on a
vendor, daily targets, notifications, and the data import from the two apps
(`vendor.ext_source` / `ext_id` are the hooks). No emails are sent.

**The vendor relations workflow** (migration 0058, the second half of the VR
CRM's features; nothing here sends an email — that is held on purpose).
Shared rules live in `packages/shared/src/vendorWorkflow.ts`; the API is
`services/vendorTasks.ts` (opening / auto-closing tasks, the missing-field
check), `services/vendorWork.ts` (everything else), `services/vendorImport.ts`
and `routes/vendorWork.ts`. On the Vendors page the views are `?view=` list ·
tasks · alerts · quality · map.
- **List tools**: tick rows (or "Select all N that match", `GET /vendors/ids`)
  → `BulkBar` edits ONE field across them (`POST /vendors/bulk`, which calls
  `updateVendor` per record so each change is logged as if by hand) or removes
  them; Export CSV (`vendors/export`, logged `vendors_exported`); "Look up a
  list" (paste names / phones / emails → on file or not → `ids=` filter);
  saved lists (`vendor_saved_view`, private or everyone, `vendors/lists`).
- **Required fields** (`VENDOR_REQUIRABLE_FIELDS`, overridable per field in
  Admin › Vendors & map, table `vendor_required_field`): creating a VR vendor
  without one is a **409 `VENDOR_MISSING_FIELDS`**; `override_missing: true`
  saves it with `vendor.flagged_missing` and opens a `MISSING_INFO_REVIEW`
  task that closes itself once the fields are filled. Technicians are exempt.
- **Tasks** (`vendor_task`): review types (`DUPLICATE_REVIEW`,
  `MISSING_INFO_REVIEW`, `COMPLIANCE_REVIEW`) have no assignee — they are one
  review queue decided by `vendors/review` approve; `COMPLIANCE_FIX` and
  `MANUAL` belong to a person. Daily targets (`vendor_daily_target`) count the
  nationwide / statewide vendors a rep added today.
- **Documents** (`vendor_document`, W-9 / MSA / COI / other): base64 in JSON
  to the private Vercel Blob, streamed back through the API; with no
  `BLOB_READ_WRITE_TOKEN` uploads are off and the page says so. A COI names
  one company: uploading one opens a `COMPLIANCE_REVIEW`; approve / send back
  writes `vendor_coi_requirement` (six checklist ticks + verdict per company)
  and `rollUpCoiApproval` sets `vendor.coi_approved`; a send-back opens a
  `COMPLIANCE_FIX` for the owner, and "fixed" re-opens the review.
- **Calls and emails** (`vendor_call`, `vendor_email`) are a log on the
  record; a call's outcome may set the vendor's status.
- **Alerts** list every insurance date that counts (latest per insurance and
  company), banded by `expiryBand`. **Data quality** lists duplicates by name
  or phone, records missing required fields, and records not on the map.
- **Import** (`/vendors/import`, `vendors/import` create): CSV parsed in the
  browser, columns matched by `autoMapImportColumns`, `POST
  /vendors/imports/analyze` writes nothing, then rows go up in chunks (API cap
  250) to `/vendors/imports/:id/rows`; duplicates follow the picked strategy
  (skip · skip + report · add flagged · fill in the record on file). An
  unreadable cell is reported and left empty, never guessed.
Built since (0059, next paragraph): notifications, advanced filters, the
board, the column picker and vendor cards on dashboards. Still open: the data
transfer from VR - CRM / Tech Locator (`vendor.ext_source` / `ext_id`).
Tests: `tests/vendor-workflow.test.ts`.

**Vendors list extras and in-app notices** (migration 0059). The vocabulary
is `packages/shared/src/vendorFilters.ts`.
- **Advanced filters**: rules joined by AND or OR travel as JSON in the
  `filter` query parameter (`parseVendorFilter` / `cleanVendorFilter` drop
  anything that is not a known field + operator with a usable value).
  `compileVendorFilter` in `services/vendors.ts` turns them into one
  predicate inside `vendorListWhere`, so the list, the board, export, "select
  all that match" and saved lists (`filter` is a `SAVED_VIEW_KEYS` entry) all
  mean the same rows. Field names come from the `FILTER_SQL` map only; values
  are always bound. A phone rule compares digits.
- **Column picker**: `VENDOR_COLUMNS` is every column the list can draw; the
  person's choice is the per-account pref `vendors.columns` (routes/prefs.ts).
  `VendorRow` carries the extra fields (zip, contact, rate, trip charge, COI
  approved, last contact, last changed) and `SORTS` the extra sort keys.
- **Board** (`?view=board`, `GET /vendors/board`): the list's rows stacked by
  status, each column with its true count and its 40 most recently changed
  cards. Dragging a card or its "Move to…" menu is an ordinary
  `PATCH /vendors/:id {status}`, so it is logged and gated like any edit.
- **Vendors as a dashboard source**: `WIDGET_SOURCES` gained `vendors`
  (`SOURCE_FIELDS.vendors`, model in `woMetrics.ts` with `standalone` — it is
  not hung on a work order, so a card follows the viewer's VENDOR scope
  (`vendorScopeSql`) rather than the work-order one). The prebuilt **Vendors**
  board is upserted like the others.
- **Notices** — NOT the Pulse's `notification` table / `/notifications`
  routes (0004), which are untouched. `app_notice` + `/notices`
  (`services/notices.ts`): one row per person per thing that happened to
  them. `notify()` runs after the act committed, never throws, and skips the
  person who did it. Raised by: a task given to you, a review opened (to
  everyone whose ROLE grants `vendors/review` approve, plus super admins —
  per-person overrides are not read), a decision on a task you raised, a
  vendor handed to you, your vendor blacklisted, and an insurance date on a
  vendor you own coming within 30 days, within 14, and expiring
  (`raiseExpiryNotifications`: lazy, on the bell's read, deduped by
  `dedupe_key`). The top-bar bell (`PulseBell`) shows them as a "For you"
  block above the Pulse rows and adds them to its badge. No email is sent.
Tests: `tests/vendor-filters.test.ts`. Still open for CRM parity: the data
transfer from VR - CRM / Tech Locator, and email (held).

**Portfolio: sites, buildings / floors / spaces, assets** (migration 0060,
Facilio parity batch 2; `packages/shared/src/portfolio.ts`,
`services/portfolio.ts`, `routes/portfolio.ts`). `site` and `asset` have
existed since 0008 but only the Ecotrak sync wrote them and nothing showed
them. Now they are records: `/sites` (list + map, counts strip),
`/sites/:id`, `/assets`, `/assets/:id`, and a "Site record" block under the
Site card of a work order (`components/portfolio/WoPlaceBlock.tsx`).
- **Three sources** (`external_source`): `ecotrak` (the sync), `manual`
  (made here; its own id is the `external_id`), `work_orders` (made from work
  orders that only carry their site as text). The sync file is not imported
  or edited. It rewrites client / name / store number / address on every
  sighting of ITS sites, so `updateSite` refuses those columns
  (`SITE_SYNCED_FIELDS`, 409) on an `ecotrak` site; every 0060 column is ours.
- **No FK to `principal` or `task` from the new columns and tables**
  (`managed_by`, `created_by`, `asset_condition_log.task_id` are plain uuids):
  the seed TRUNCATEs both … CASCADE and sites / assets must survive a re-seed.
- **Site**: type, ownership, managed by, billing entity, contact, hours,
  access notes, geofence (`boundary_radius_ft`), and a pin — placed from the
  ZIP, else the city (`geoLookup`, 0056), or typed by hand (`geo_source =
  'manual'`, which an address change does not move). Delete is soft.
- **Locations** are one table, `site_location`, three kinds nested by
  parent; `canNestUnder` is the rule (building on the site, floor in a
  building, space on a floor / in a building / on the site). Removing one
  cascades to what is inside; assets there stay at the site, unplaced.
- **Asset**: category, manufacturer, serial, tag, install date, warranty
  (`warrantyState`: none / expired / expiring within 60 days / active, on a
  Chicago day), status, parent asset (loops refused), the place it stands
  (must be at its own site), and `asset_condition_log` — every reading, with
  the work order it was taken on; `asset.condition` is the latest.
- **On a work order**: `GET/PUT /work-orders/:id/place` reads and sets
  `task.site_id` / `task.asset_id` (needs `work_orders` edit + `sites` edit;
  logged through `logTaskChanges` as fields "Site" and "Asset"). The Site
  card's address is still the work order's own `17. Address` text.
- **Sites from work orders** (`/sites/from-work-orders`, preview + run): a
  place is client + the first of store number, street, store name, city;
  "Store" counts as a number only when it has a digit and is not the client's
  own name. Idempotent (the place key is the `external_id`).
- **Scope**: every work-order list and count inside a site or an asset goes
  through `woScopeSql`, so a scoped dispatcher sees their own work orders
  there and no others. Sites and assets themselves are not scoped.
- Permissions `sites` and `assets` (view / create / edit / delete): 0060
  gives everyone view; OM tiers, Ops Coordinator and OP Admin create / edit;
  admin, TL, ATL, AM also delete. Audit entities `site`, `asset`.
Built next, in 0062 (below): clients, site access, dashboard sources, asset
requests and the admin screen for the two lists (the tables `site_type`,
`asset_category` feed the suggestions).
Tests: `tests/portfolio.test.ts`.

**Clients, site access, asset requests, Admin › Sites & assets** (migration
0062, the rest of Facilio batch 2; `services/portfolioExtras.ts`, routes in
`routes/portfolio.ts`, shared types at the foot of `shared/portfolio.ts`).
- **Clients are records, not owners.** `client` describes a name (contact,
  billing, account manager, portal). Which client a work order belongs to is
  still `task.client` / `site.client` text, joined by `lower(btrim(name))` —
  no FK was added and the Ecotrak sync is untouched. So: a client in use
  cannot be renamed (only re-capitalised) or removed (mark it inactive), and
  `adoptNewClients` inserts a record for any new name each time the list is
  read. `/clients`, `/clients/:id`; permission `clients`.
- **A person restricted to a list of sites** (`principal_site`; nobody listed
  = no restriction; super admins never). The session loader sets
  `siteRestricted` (auth.ts → `ActingPrincipal`), and `woScopeSql` ANDs
  `t.site_id IN (their sites)` onto whatever the role scope says — so the
  list, the queues, the badge and every per-work-order route follow it, and a
  work order with no site record is outside every list. Sites, assets, client
  counts and the sites / assets dashboard sources go through `siteAccessSql` /
  `assertSiteAccess` in `services/portfolio.ts`. Set from Admin › Sites &
  assets by super admins only (`PUT /admin/portfolio/site-access/:id`, logged
  `user_site_access_changed`). A dashboard board set to "Everything" (0050)
  can still count past it, as it can past the work-order scope.
- **Asset management requests** (`asset_request`: add / replace / retire /
  move). `assets/requests` create = ask, approve = decide. Approving MAKES the
  change through `createAsset` / `updateAsset` as the approver (so it is
  validated and logged like any edit, and the approver needs the asset rights
  too); a replace creates the new asset in the old one's place and marks the
  old one retired. Rejecting needs a reason. Deciders and the requester are
  told through notices (0059). Queue at `/assets?view=requests`; replace /
  retire / move start from the asset's own page.
- **Admin › Sites & assets** (`/admin/portfolio`, grant `admin/portfolio`):
  the `site_type` and `asset_category` lists — add, rename (carries every
  record holding the old value), switch off (no longer suggested) — and the
  site-access card.
- **Dashboards**: `sites` and `assets` are widget sources (models in
  `woMetrics.ts`, `standalone.scope = 'site'`), with a prebuilt "Sites &
  assets" board. Their work-order counts are of all work orders at the site /
  on the asset, narrowed by the viewer's site list, not their work-order scope.

**Client Updates** (migration 0055, `services/clientUpdates.ts`,
`pages/ClientUpdatesPage.tsx`, sidebar "Client Updates"). Replaces the
per-client tracking spreadsheets (e.g. "SUN Holdings Tracking"). A
**tracker** (`client_update`) is a saved question, never a copy of rows: a
client (`task.client`), a filter set (saved-view shape), ordered **columns**
— each `{key, label, shared}`, `shared=false` = team only — charts
`{field, kind: bar|donut, shared}`, sections (`group_by`, default status),
sort, and the **client-note column** (`note_field`, default `fields.20. Last
Update`) typed straight into the row via `PATCH /work-orders/:id/fields`.
The page: headline tiles (`SUMMARY_TILES` in `packages/shared/src/
clientUpdates.ts`, each carrying the rules that drill to what it counted),
clickable charts (each drilled chart is recounted without its own pick, so
every bar stays visible), drill chips, "Client view" (shared columns and
charts only), and the list from the ordinary `/work-orders` endpoint with
`trackerFilters()` — `andFilters()` distributes a drill over an "any of"
filter's OR groups. Our page follows the viewer's rule-8.5 scope; everything
the CLIENT gets (link, email, client CSV) is the whole tracker, shared
columns only, via `buildView` with no viewer. Five **computed columns**
joined the field catalogue for every list (`COMPUTED_WO_COLUMNS`; SQL in
`woFields.ts`, projected into a row's `custom` map only when asked):
`location` (City, ST), `completed_on` (first move into done/closed after the
last move out, Chicago day; NULL for rows imported already closed),
`age_band`, `last_client_message(_at)`, `last_sent_to_client`.
**Sharing** needs `client_updates/share` (edit): a read-only public link
`/share/client-updates/<32-char token>` (`pages/ClientSharePage.tsx`, no
AppShell, no session; `authGuard` allows exactly
`/api/public/client-updates/<token>(/csv)` by pattern; revocable,
regenerable, optional expiry, `share_origin` remembers the site so cron
emails carry the right link), and **email** from `MAIL_FROM` (default
contact@seamlessfm.com) through `services/mailer.ts` — `MAIL_PROVIDER=graph`
(Graph sendMail as that mailbox; the app registration needs the **Mail.Send
application permission** with admin consent; creds `MAIL_GRAPH_*` fall back
to `ENTRA_*`) or `resend` (`RESEND_API_KEY`); unset = not configured, the
UI says so and a send records a failed delivery. The body is
`lib/clientUpdateEmail.ts` (pure, inline styles, tested); CSV attached
optionally. **Schedules** (daily / weekdays / weekly / monthly at HH:MM
America/Chicago, `nextRunAt` DST-correct) are sent by the hourly Vercel cron
`/api/webhooks/client-updates-run` (`CRON_SECRET`), each tracker claimed by
compare-and-set on `next_run_at` so overlapping runs never double-send;
signed by the "Client updates" service principal. Every send is a
`client_update_delivery` row (sent / failed + error) and an admin audit row
(`client_update_sent|test_sent|send_failed`, plus `_created|_updated|
_deleted|_link_*|_exported`, token never logged); a real send also writes
`client_update_sent` on each work order in it, which the approval follow-up
obligation counts as a chase. Grants (0055): admin/tl/atl/am full + share;
om tiers and ops_coord view.

`packages/db/migrations/000N_*.sql` run once each (ledger table). `seed.ts`
truncates and rebuilds the sample data. Because `setup` runs migrate **then**
seed, any *data* a migration inserts (super admins in 0004, roles in 0005) is
wiped by the seed unless the seed re-creates it. Both files carry the same
statements on purpose — **if you change one, change the other** (0003/roles,
0004/super admins). The seed prints `super admins : 4 (…)` so drift is visible.

## Verify

```
npm -w @theone/web run build          # from app/: tsc -b && vite build — the only typecheck that exists
curl -s http://127.0.0.1:5174/api/health                      # {"ok":true,"auth_mode":"bypass"}
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/api/work-orders   # 401 without a session
```

- The **API and shared packages have no tsconfig** — they run under `tsx` and
  are never type-checked. An ad-hoc `tsc` over `apps/api/src` reports ~27
  `TS2344` errors from `db.query<T>`'s `Record<string, unknown>` constraint;
  that pattern predates auth and is in untouched files (`feed.ts`,
  `messages.ts`, `payments.ts`, `principals.ts`). Not a regression.
- Dev-bypass smoke test: `POST /api/auth/dev-login {"principal_id":"<id>"}`
  (ids from `GET /api/auth/dev-candidates`), keep the cookie, then hit
  `/api/auth/me`, `/api/work-orders`, `/api/admin/users` (403 unless super admin).
- No test suite exists yet. Verification so far has been build + curl + headless
  Chromium screenshots of both themes.

## Front-end conventions

- **Two themes** via `data-theme="night"|"day"` on `<html>`; every colour is a
  token in `src/theme/tokens.css`. Never hardcode a colour outside that file
  except brand-mandated ones (Microsoft mark) and the sign-in route bubbles.
- **Icons** are a `<symbol>` sprite in `components/Icon.tsx` used via `<use>`.
  The six sidebar icons are drawn inline in `components/NavIcon.tsx` instead
  because hover animations cannot reach inside a `<use>` clone.
- **The wordmark** (`public/brand/logo-the-one.png`) is rendered through crop
  windows keyed to pixel boxes measured from the PNG (`.topbar-brand` in
  `styles/app.css`, `.signin-logo` in `styles/auth.css`). If the asset changes
  size or layout, re-measure and update those numbers — the comments list them.
  Night mode inverts the mark with `filter: invert(1) hue-rotate(180deg)`.
- Motion is always inside `@media (prefers-reduced-motion: no-preference)` or
  disabled under `reduce`.
- Files are CRLF on disk (`core.autocrlf=true`, no `.gitattributes`); the
  LF→CRLF warnings from git are noise.

## Known gaps / deliberate decisions

- Entra mode has not been exercised against a real tenant yet (no app
  registration existed at build time); the code path is complete and typed.
- Vendors appears in the sidebar but is an inert placeholder (batch 1 of
  `product/facilio-parity.md`). Invoicing is live since 0045 (Receivables ›
  Invoicing); vendor bills since 0047 (Payments › Vendor bills).
- React Router prints v7 future-flag warnings in the console; harmless.
- `public/brand/logo-the-one-2.png` is an unused leftover of the previous
  logo (committed for safekeeping, referenced nowhere) — safe to delete.
- Product roadmap and open decisions: `product/feature-roadmap.md` (§ "Standing
  risks / open decisions").

## Branches

`main` = last reviewed state. Work lands on `Primary-Updates*` branches, one
per review batch; each is frozen once it is up for review and the next batch
starts from it, so PRs fast-forward in order.

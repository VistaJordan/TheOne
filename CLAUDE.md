# The One — guide for Claude Code

Work-order, quote and vendor-payment platform for Seamless FM (Byblos Vista).
React + Vite front end, Fastify API, Postgres 16 through node-postgres (a local
server in development, native or under Docker; Neon in production). Read this
before touching code; it is the map, the run book and the list of rules that
are easy to break without noticing.

## Layout

```
app/                      npm workspace root — run npm commands here (or use the root shim)
  packages/shared/        @theone/shared — types + shared vocab (status groups, capability names)
  packages/db/            @theone/db — node-postgres (pg.Pool) client, migrations/, migrate.ts, seed.ts
  apps/api/               @theone/api — Fastify on :5174 (src/routes, src/services, src/auth, src/plugins)
  apps/worker/            @theone/worker — a second process on the same pool, started by `npm run dev`
  apps/web/               @theone/web — React on :5173 (src/pages, src/components, src/styles, src/theme)
  tests/                  vitest suite (tests/**/*.test.ts); tests/setup.ts makes it hermetic
  docker-compose.yml      Postgres 16 for local development under Docker (service `db`, localhost:5432); optional
product/                  product docs: feature-roadmap.md is the sprint plan; the others are domain specs
docs/ (inside app/)       SPRINT1-SPEC.md — original schema/API contract
package.json (root)       scripts-only shim that forwards to app/ so `npm run dev` works from the repo root
```

## Run

First, a Postgres 16 server on localhost:5432 with user, password and database
`theone`. `app/docker-compose.yml` defines one for Docker users (`docker compose
up -d db` from `app/`); a native install works the same and is what the main
machine runs (it has no Docker: PostgreSQL 16.14 runs natively from the
`@embedded-postgres/windows-x64` binaries under `%LOCALAPPDATA%\theone-pg`,
cluster in `data\`, log in `server.log`). Then:

```
npm run setup             # migrate + seed whatever DATABASE_URL names (unset = postgres://theone:theone@localhost:5432/theone, the client.ts default)
npm run dev               # API :5174 + worker + web :5173 via concurrently
```

Open http://localhost:5173. `npm run setup` and `npm run dev` work from the repo
root or `app/`; `docker compose` needs `app/`, where `docker-compose.yml` is.

Rules that bite:
- **The database is a real Postgres server** (node-postgres `pg.Pool`,
  `packages/db/src/client.ts`), shared by the API, the worker and `setup`, so
  nothing is single-writer any more: a read-then-write must lock its row
  inside `withTransaction` (a `task.fields` write: `FOR NO KEY UPDATE`, the
  reason in `woFieldValues.ts` `updateWorkOrderFields`; see "Guards added
  2026-10-14"). `setup` does not load `app/.env` (the API and the worker do):
  it reads `DATABASE_URL` from the shell, else the `client.ts` default, so a
  server named only in `app/.env` is not the one it migrates and seeds.
- **`db:seed` TRUNCATEs and re-inserts.** Re-seeding wipes local edits. It
  refuses a `DATABASE_URL` host that is not localhost unless
  `ALLOW_SEED=<host>/<database>` is set (`packages/db/src/seedGuard.ts`), so it
  cannot empty Neon by accident. `db:migrate` records a sha256 per file and
  refuses an applied file that changed (`MIGRATE_ALLOW_CHECKSUM_MISMATCH=1`
  accepts the new checksums), and a file to apply that runs its own BEGIN /
  COMMIT or a CONCURRENTLY (no override: fix the file).
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
  **Keep me signed in** (0088) on the sign-in page: ticked, the session lasts
  `REMEMBER_ME_DAYS` (30) as a dated cookie, pushed out once a day while used;
  unticked, a browser-session cookie that also ends after `SESSION_TTL_HOURS`.
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
pure UI clicks (tabs, folds, filters) — they change no record. A sweep of every
write route on 2026-10-20 closed the last gaps (labor rates, purchasing
documents with no work order, dashboards and their cards, vendor tasks /
targets / saved lists / skill and induction edits, the technician on a visit,
ClickUp / Ecotrak / SharePoint buttons, automation enrol, assistant thumbs,
reviews and deletes; pinned by `tests/audit-gaps-*.test.ts`); a new write
needs its row. A role or Adjust row lists its permission changes path by path
(`permMapChanges`, shared `permDiff.ts`) on the screen and in the CSV. Since migration
0029 the table is **append-only at the database**:
a `BEFORE UPDATE OR DELETE` trigger raises (rule 1.2.2), so a correction is a
new row, never an edit; TRUNCATE still works for the local seed. `entity_id`
is **text** since 0023 (phase groups are keyed by code):
join it as `t.id::text = a.entity_id`, and never feed one `$n` parameter to both
a uuid column and `entity_id` in the same statement: Postgres infers one type
per parameter and the statement fails.

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
`assertNoOpenNteOverride` in the same service: quote approve / send / client
approval and payment approve / pay call it first and get a **409 `CONFLICT`**
while an `nte_override` task is open; rejecting is never blocked. The
`Quote` payload and each `/api/payments` row carry `nte_override_open` so the
builder and the Payments tab draw the verb locked before the click. The
`/approvals` page is a sectioned inbox — All · NTE override (cost over NTE) ·
NTE increase requests (0064's manual asks, Wave D M25) · (Money
holds, 0083) · (Manager reviews) · Quotes (`pending_approval`) · Payments
(`requested`) — built
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

**Who asked and who approved** (Elise, 2026-10-30, no migration;
`AFTER_WITH_REQUESTER_SQL` in `apps/api/src/lib/actorName.ts`,
`statusRequesterName` in `apps/web/src/lib/auditFormat.ts`,
`tests/status-request-audit.test.ts`): the `status_changed` row of an
approved request is signed by the approver; `getActivityForTask` and
`listAuditLog` add `requested_by` {id, name} to it from the request's
`created_by` (read time, so older rows show it too), and the work order's
Audit trail, Admin › Audit and its CSV print "requested by A · approved by B".

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
`assignee` (an active DISPATCHER's display name since UAT Wave D, required,
checked by `assertDispatchers`); the decision commits, then the name is written through
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
State, Zip code, Store, Trade, WO description, Client, Comp and Client NTE
are filled (WO# is the row key; a $0.00 NTE counts as filled; Received on /
WO description / Client NTE / Client also accept their promoted `task`
columns, which is what the Ecotrak ingest writes). The Client stands in the
rule's FM place since 2026-10-27 (0103, below). Vocabulary in `packages/shared/src/
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

**City, State and Zip Code follow the address** (Elise, 2026-10-22, no
migration; `packages/shared/src/addressParts.ts` pure,
`apps/api/src/services/addressFill.ts`, `tests/address-parts.test.ts`).
Whenever a save puts a non-blank `17. Address` on a work order,
`parseAddressParts` reads city, state and ZIP off its end (the team's shape is
"7898 Bradley Long Dr, Sherrills Ford, NC 28673, USA"; also a spelled-out
state, ZIP+4, a suite part, "City ST ZIP" with no comma) and `fillFromAddress`
writes them into `City` / `State` / `Zip Code`; a city or state the text
leaves out is completed from `geo_zip` (0056, our own table: parsing, never
an outside geocoder). Called by every writer of the address:
`updateWorkOrderFields` (editor, automations), `bulkUpdate`, both halves of
the CSV import, `createWorkOrder`, intake draft create / update (the form
sends every value, so "set by hand" there means changed from the stored one)
and the PM raise; the Add work order form also fills them as the address is
typed. The Ecotrak sync writes city / state columns but never the address, so
it is untouched. Rules: the parts OVERWRITE what the three fields held; a
part the same save sets explicitly wins; a bare street changes nothing; the
City / State mirror columns follow; updates are logged `via: 'address'`
(creations are part of the `created` row). Going forward only: nothing
back-filled the work orders on file.

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
WO's `22. FM`. Since 0098 a Portal row also names WHICH portal
(`fm_cico_method.portal`, copied to `wo_visit.method_portal` with the method,
kept only while the method is Portal — `portalFor`), and the visit reads
"Portal: Service Channel" (`cicoMethodLabel`; the `CICO Method` mirror
"Portal: Corrigo - <detail>"). Suggestions `CICO_PORTAL_SUGGESTIONS`; no
FM row was filled in by 0098; 0099 moved the twelve FMs filed as IVR /
"Service Channel" to Portal: Service Channel (detail cleared; only rows
still as 0028 wrote them; seed.ts in step). `tests/cico-portal.test.ts`. The same `CicoCard` renders in the CICO tab and as the CICO
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
dispatcher tiers to view-only on it, so **Escalation** (was Mark as Escalated) in the
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
load, not a person pausing a job) and the seed's own statuses. **Quote Ready
widened (Elise, 2026-10-22, no migration):** the quote must also be
SUBMITTED (its status past `draft` — `pending_correction` from a
dispatcher's Submit for correction counts, `quoteSubmitted` in shared) and
the work order must hold at least one APPROVED picture (an `attachment` with
a file in storage, an `image/*` content type and `review_status =
'approved'`, whoever approved it). `quoteGateMissing` (shared) /
`quoteGateMissingFor` (API, batched for bulk) answer `quote` /
`quote_submitted` / `photo` as `details.missing` on the 409; the menu tags
Needs quote / Needs quote submitted / Needs photo (Not ready for several)
from `quoteStatus` + `approvedPhotos` hints the header reads off the quote
query and the `['wo-attachments', id]` cache. Only entry is gated: M3 still
holds the quote's DATA in Quote Ready, not its status or the picture.
`tests/status-gates.test.ts`.

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
`moveOnSite` in `services/visits.ts` runs after the visit's transaction and
decides by WHO checked in (UAT Wave C, #15): a person in request mode
(`isStatusRequestMode`: `work_orders/status` create without edit — the
dispatchers) raises a status-change request to the On Site status through
`requestStatusChange` (the reply's `status_move` reads `requested: true` with
the `approval_task_id`, the CICO card says a request went to a manager, and
the approval moves it); a manager, anyone else allowed to log visits, or the
system moves it directly through the ordinary `changeStatus` with source
`'visit'` (the audit row reads `via: 'visit'`), without asking the status
permission. Both still run the gates and the Ecotrak check. A refusal never
undoes the check-in: the reply's `status_move` carries the reason and the
CICO card prints it. Correcting a stamp or checking out moves nothing; since
M8 typing a check-in time on a planned visit IS a check-in (the status is
read off the stamps, `nextVisitStamps`).

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
fields of 11.1.1 + the Client, required since UAT Wave D (#22, a client
record's name); `intakeDraftMissing` reuses
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
draft: the **Add work order** button on Incoming Work Orders (both tabs,
`components/wo/list/AddWorkOrderButton.tsx`; moved off the list on
2026-10-22, Elise), gated on `work_orders:create`, opens a form
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
whatever is required here. **Save as draft** (2026-10-27, Elise; shown with
`intake` create) files what the form holds as a `wo_intake_draft` instead
(`createIntakeDraft`: WO # may be blank, the Assignee becomes the draft's
assignee, every other bag key rides along — the draft form lists the ones it
does not draw under "Also on this draft" and Submit carries them); the site,
the asset and chosen files are not kept, and the button's title says so. The
Drafts tab's own button reads **New draft** (it read "New work order", beside
Add work order).

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
delete); reading needs only `work_orders` view. Since 2026-10-22 the Photos card
sits on its own **Drive** tab (`work_orders/tabs/drive`, unset inherits
like every tab; links that pointed at photos say `?tab=drive`), Overview
leads the strip and is the landing tab (bare URL; All fields second, reached
by `?tab=fields`).

**Photo approval and proof before Done** (migration 0061, rules 1.3.1–1.3.4
and 11.3.4). Every upload lands `attachment.review_status = 'pending'` and is
**quarantined**: `listAttachments` and the bytes route show a pending or
declined file only to a reviewer (`work_orders/attachments` **approve**) and
to the person who uploaded it — to anyone else it answers like a missing
file. `POST /work-orders/:id/attachments/:attId/review {decision, kind?,
file_name?, viewed}` approves or declines ONE file (1.3.4; `viewed: true`
comes from the full-size viewer, Wave D M14); approving needs a `kind`
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
(one LIVE — not void — invoice since 0083, a partial unique index; a repeat
Create returns it) (consolidating a month of jobs becomes a join table when it is wanted, not a
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
and view/create to am + tl. The Ready lane is DERIVED, not stored (since
2026-10-14, W2-1): a Done work order whose quote is approved, sent or
client-approved and that has no invoice row yet, read from the quotes list;
everything past it is a record.

**Contracts and labor rates** (migration 0046, `services/contracts.ts`,
`/contracts` in the sidebar, permission path `contracts`) are the client rate
cards: hourly / overtime / double-time / trip charge / markup on parts, for a
client (or all), an entity (or all), some sites and trades (or all), between
two dates. `contractForTask(taskId)` picks the most specific card in force
on the day the work order was RECEIVED, at the rates version in force then
(`contract_rate_version`, UAT Wave D M30)
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
(`QuoteDecision`: **Approve** only since UAT Wave C (M4) — sending is the
builder's own **Send to client**; decline needs a note), gated by
`quote.permissions.can_approve` / `quotes:approve`.

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

**@mentions in messages** (migration 0089, `packages/shared/src/mentions.ts`
pure, `services/woMessages.ts`, `components/wo/messages/MentionTextarea.tsx`,
`tests/wo-mentions.test.ts`). Typing @ in the Messages composer (or the edit
box of one's own message) opens the people who can open THIS work order —
`GET /work-orders/:id/mention-candidates` (`work_orders/comments` create):
active humans with `work_orders` view and the Messages tab, the work order
inside each one's OWN `woScopeSql` (one statement, one predicate per person).
The body stays plain text ("@Display Name", it may go to a client CMMS); who
an @Name is travels beside it as `mentions: uuid[]` on POST / PATCH (max
`MENTION_MAX` 20) and lives in `comment_mention` (both keys ON DELETE
CASCADE, so the seed's TRUNCATE needs nothing). An id that is not a
candidate is 400 `MENTION_NOT_ALLOWED`; only ids whose @Name is still in the
body are kept (`mentionsInBody`), so deleting the name drops the mention; a
PATCH without `mentions` keeps the old ones still named. The rows commit with
the message; after the commit `notify()` raises an `app_notice` of kind
`wo_mention` ("<who> mentioned you on <WO #>", link
`/work-orders/<WO #>?tab=messages&msg=<id>`) — an edit tells only the people
it ADDED. `WoMessage.mentions` drives the highlight (`splitMentions`, the
reader's own name in accent) and `WoThread` scrolls to and outlines `?msg=`.
`comment_added` / `message_edited` carry the mentions (id + name).

**Calls through Quo and the AI quote draft** (migration 0054,
`services/woCalls.ts`, `services/aiQuote.ts`, `lib/aiQuotePrompt.ts`,
`components/wo/calls/`, `pages/AiQuoteReviewPage.tsx`). Quo's API **cannot
start a call**, so the **Call** button (since 0095: **Call client** on Messages › Client calls, **Call technician** on Tech Hub › Technician calls) records the
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
`QUOTE_AI_MODEL` default `claude-haiku-4-5` (cheapest, Elise 2026-10-13; the
server-side fallback is sent only to models that take it), structured JSON output, server-side
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
(vector search) go into `buildUserMessage`. **Import transcript** (migration
0077, `components/quote/ImportTranscriptButton.tsx`, on the quote builder and
the Client quote card): a conversation held outside Quo (Teams / Zoom / Meet
.vtt or .srt, a .txt, or pasted) → `POST /work-orders/:id/transcripts`
(`quotes` edit) → a `wo_call` row with **`phone` NULL**, `transcript_source
'imported'`, purpose `quote`, already `transcribed` (a CHECK allows a NULL
phone only for imported rows; the webhook matches by number so never sees
them), parsed by `parseTranscriptFile` in shared, logged `call_transcribed`
with `source: 'imported'` + `file_name`. The browser then opens the AI draft
page on it, which drafts straight away; everything after is the call path.
**From a Quo call** (no migration, 2026-10-22, Elise's ask; the dialog's
second mode under "Where is the conversation?"): a call the person already
had on their Quo line but did not place from the work order. They type the
other party's number; `GET /work-orders/:id/quo-calls?phone=` (`quotes`
edit) finds THEIR Quo lines by the email they signed in with
(`listQuoPhoneNumbers` + `quoLinesForEmail`, the line's `users[].email`;
Quo runs on the same Byblos Vista accounts), lists the calls between each
line and the number over `QUO_CALL_LOOKUP_DAYS` (90, `listQuoCalls`: Quo's
`GET /calls` wants ONE `phoneNumberId` and ONE participant) and answers
`QuoCallsLookup` — newest first, `QUO_CALL_LOOKUP_MAX` 25, each with
`answered` (an unanswered call has no transcript) and `already_on` (the
`wo_call` row holding that `quo_call_id`, same work order or another).
`POST …/quo-calls/:quoCallId/import {phone, contact_name?, contact_role?}`
(`importQuoCall`) checks the call is on one of those lines AND with that
number (`getQuoCall`), fetches `GET /call-transcripts/{id}`
(`getQuoTranscript`; a 404 reads `absent`), refuses 409 `QUO_NO_TRANSCRIPT`
(in-progress says so), `QUO_CALL_USED` (on another work order — `quo_call_id`
is UNIQUE since 0054, so one Quo call is one row), `QUO_CALL_MISMATCH`,
`QUO_API_MISSING` / `QUO_NO_EMAIL`, and INSERTs a `wo_call` row with the
number, purpose `quote`, status `transcribed`, `transcript_source 'quo'`,
Quo's id, user, direction, stamps and duration — a same-work-order row with
no transcript yet is filled in instead, one with a transcript is returned as
is. Logged `call_transcribed` with `source: 'quo'`, `fetched_from_quo:
true`, `quo_call_id`, `call_at`. `quoDialogueToLines` (shared) is the one
dialogue → lines mapping, used by the webhook too. Reading needs only
`QUO_API_KEY` + the Quo switch (`quoReadReady`; `QUO_FROM_NUMBER` is for
sending); each Quo read is bounded (15 s) and never retried. Tests:
`tests/quo-call-lookup.test.ts`.

**Sign-off sheets** (migration 0070, `services/signoff.ts`,
`lib/signoffPdf.ts`, `lib/signoffAssets.ts`, `lib/quoApi.ts`,
`routes/signoff.ts`, `packages/shared/src/signoff.ts`,
`components/wo/SignoffPanel.tsx` at the foot of the CICO card). What the
Make + Paperform automation did for ClickUp: a **one-page blank sheet in the
billing entity's branding** (`21. Comp` → layout `sfm | tpm | af | rf | eds |
bkr | bkr_emcor`, BKR's EMCOR variant carries a Closeout Number line;
`signoffLayoutFor`) with the client's WO number (`ext_name`, else
`wo_number`) and `17. Address` printed, drawn by **pdf-lib** (US Letter,
standard fonts, `safeText` folds non-Latin-1) with the header / footer /
logo images **inlined as base64** in `signoffAssets.ts` (extracted from the
sample PDFs; regenerate, never hand-edit). It is **generated automatically
when the work order is assigned to a dispatcher** — `Assignee` set on any
write path: `dispatchAutomations` (post-commit, every path reports there)
calls `ensureSignoff` on a `created` event with an Assignee or a `changed`
event on `fields.Assignee`; never throws — and by the Generate / New sheet
button; the newest un-superseded `wo_signoff` row is
the sheet, stored in the Blob store, and `stale` flags a number / address
change. **Share with tech** picks a technician (hired vendors' phones + visit
techs, deduplicated by E.164, or another number) and texts the sheet's link:
through **Quo's API** (`POST {QUO_API_BASE}/messages`, bare `Authorization`
key, `QUO_FROM_NUMBER`) when `QUO_API_KEY` is set, else the browser opens
`sms:+1…?body=…` so the Quo desktop app sends it; both record a
`wo_signoff_share`. The link is `GET /api/public/signoff/<32-char token>`
(allowlisted by pattern in `authGuard`; the token lives in clear in
`wo_signoff.token` because it only names a blank sheet; a superseded
sheet's link answers 404). **The signed copy comes back as a text with a
file**: `message.received` on the same Quo webhook → `handleQuoEvent` →
`onInboundMessage` (both payload generations read) matches the sender's
number to the sheets shared with it in the last 45 days; exactly one open
sheet → `fileSignedCopy`: `addSystemAttachment` (kind `signoff`, pending
review per 1.3.1, uploaded by the 'Quo' service principal), `24. Sign-Off
Link` set to the attachment's API URL (`via: 'signoff'`, automations
dispatched), `wo_signoff.signed_at`; several open sheets → the file is held
in `wo_signoff_reply` with its candidates and each candidate's CICO card
shows a strip with **Yes, file it here / Not this one** (`claim` /
`dismiss`). A text with no file, or from a number with no open sheet, is
acknowledged and dropped. Permission: `work_orders/fields/cico` view / edit
(+ `work_orders` edit). Audit on the task: `signoff_generated`,
`signoff_shared`, `signoff_received`, `signoff_reply_held|dismissed`, plus
the ordinary `attachment_added` and `field_updated`. Self-check:
`tests/signoff.test.ts` renders every layout and asserts ONE page. Needs on
Vercel: `BLOB_READ_WRITE_TOKEN` (set), `QUO_API_KEY` + `QUO_FROM_NUMBER`
(not yet), and `message.received` added to the Quo webhook.

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
*The map* opens **from a work order only** (Tech Hub tab › Technicians › Find a
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
optional city inside it since 0069, ranked) are marked and sorted first
(`preferredRuleScore`, most specific rule wins). A statewide / nationwide vendor with no placed city is pinned at the
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
- **A person restricted to a list of sites** (`principal_site`; since 0084 the
  switch is `principal.site_restricted` — on with nobody listed = no sites,
  off = no restriction; super admins never). The session loader sets
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

**"Add work order", the rest of the form** (migration 0063, Facilio parity
batch 3). The form has existed since 0041 (`services/woCreate.ts`,
`components/wo/list/CreateWorkOrderDialog.tsx`; which fields it shows is
`field_def.create_mode`, Admin › Custom fields). 0063 adds:
- **Site and asset** on the form (shown to anyone with `sites` view):
  `POST /work-orders` takes `site_id` / `asset_id`, checks them
  (`resolveCreatePlace`: the site is one the person may see, the asset stands
  at it) and sets `task.site_id` / `task.asset_id`. In the browser a picked
  site fills `WO_SITE_AUTOFILL` (client, store, address, city, state, ZIP) —
  each field only while it is empty or still holds what the last site put
  there, so typing is never overwritten.
- **Four fields**, on the form by default, in the Overview section of the
  record: `Problem Type` (dropdown), `Sub Category` (text), `Supplier Type`
  (External supplier / Internal), `Work Permit Needed` (checkbox). Seed and
  migration carry the same rows — KEEP IN STEP. A trade IS the category;
  `wo_subcategory` (trade → names, Admin › Settings card, grant
  `admin/settings`) feeds the Sub Category suggestions through
  `subcategoriesFor`; the field still takes anything typed.
- **Possible duplicates**: `checkWoNumber` also offers open work on the same
  asset (any age) and at the same site (same trade, 30 days); each hit says
  `why`. Still a warning, never a block.
- **Templates** (`wo_create_template`, `/work-orders/new/templates`): a saved
  set of values (and a site) that pre-fills the form; private unless shared,
  and sharing needs `admin/fields` edit. The WO # and the asset are never
  saved.
Tests: `tests/wo-create-extras.test.ts`.

**The work-order record** (migration 0064, Facilio parity; `shared/woRecord.ts`,
`services/woRecord.ts`, `routes/woRecord.ts`, `components/wo/record/`). One
read, `GET /work-orders/:id/record`, feeds everything new on the page: the
state chips under the header (`RecordBar`; since 2026-10-20 its buttons
moved: Pause / Tag / Complete service / Cancel / Reopen into the header's
**More** menu and Save as PDF beside it, both `RecordActions` passed to
`WoHeader` as its `actions` slot; Assign vendor to Tech Hub (was People › Technicians),
`ResponsibleVendorCard`; Add ETA to CICO, `EtaCard`; Increase NTE was
removed, open `wo_nte_request` rows are still decided), the right rail (`RecordRail`:
Responsibility, Location, Time with a live timer, Cost; drawn only on
Overview and the four new tabs, `RAIL_TABS`) and the tabs Checklist (`tasks`),
Cost breakdown (`costs`), Timelog & metrics (`timelog`) and Related. Since
2026-10-20 the strip in `WorkOrderDetailPage.tsx` groups tabs (`FINANCE_TABS`: Finances is ONE panel again since later on 2026-10-27 — the money and invoice cards, then Payables, then the Cost breakdown, each part behind its own tab permission, ?tab=payables / ?tab=costs scroll to their part; the money part holds the money card (with Profitability exception + Manager notes, an open box, `NoteField`), and the invoice card; the **Penalties** card, `components/wo/ManagerFlags.tsx`, is its own **Penalties** tab after Tech Hub, `work_orders/tabs/penalties` view + `work_orders/fields/penalties` view; since 2026-10-27 the **Quotes** tab beside it IS the quote builder, `QuoteBuilder` from `QuoteBuilderPage.tsx` with `embedded` (no shell, flushes a pending autosave on unmount; the Client quote card is gone), `work_orders/tabs/quotes` view + `quotes` view):
People is one tab again since 0095 (Our team, with Assignment history;
Technicians became the Tech Hub tab, below), and `TAB_GROUPS` is gone. Flags is gone (checkboxes in All fields); Checklist and
Related have no button but a link still opens them; Timelog is no tab, its
two cards (Technician time, Timelog and metrics) sit on CICO under the visits
behind the Timelog permission and ?tab=timelog opens CICO; the header always
opens unfolded. Since 2026-10-21 the Quo **Call** button is on the Messages
tab's Calls card only (`CallsCard` renders `CallButton`), not in the header. The new
state is plain columns on `task`: `vendor_id` (ONE responsible vendor;
assigning a blacklisted one is refused), `paused_*` with a `wo_pause` history
(a pause is a **marker only** — rule 2.4.4 stands, no timer stops), `eta_*`,
`cancelled_*` (cancel needs a reason and moves the work order to a status
named Cancel… when one exists; reopen undoes it), and the Complete Service
set (`completion_note`, `fault_code`, `action_code`, `temporary_fix`,
`service_completed_*` — it records the completion and does **not** move the
status). Tables: `wo_checklist_item`, `wo_tag` (a tag carries a reason),
`wo_nte_request` (the manual "Increase NTE": its own table, **not** an
`approval_task`; deciders hold `approvals/nte` approve, an approval writes the
NTE through `updateWorkOrderFields`, both sides get a notice), `wo_code`
(fault and action codes, Admin › Settings; a code's letters never change).
Every write is gated on `work_orders` edit, logged with `logTaskChanges`, and
resolves through `resolveTaskId(id, actor)` so the scope 403 applies.
**Form layouts** (`wo_form_layout`, Admin › Settings): per client and / or
trade, a layout turns create-form fields off or required; `pickFormLayout`
(client+trade, then client, then trade) and `applyFormLayout` run in the
dialog and again in `createWorkOrder`, and can never hide Client or Trade.
Files chosen on the create form upload after the work order exists
(`prepareFile` + `uploadAttachment`); the section shows only when
`storage_ready` is true. **Geofence**: technicians have no app, so a visit's
location is recorded by hand on the CICO row (`VisitLocation`: this device's
location or typed coordinates, `POST …/visits/:visitId/location`, gate
`work_orders/fields/cico` edit) and `geofenceCheck` compares it with the
site's pin and `boundary_radius_ft`; the result is stored on `wo_visit`.
**Site events** (`site_event`: closure, restricted access, remodel, …, dated,
`siteEventPhase`) are added on the site page, listed at `/sites?view=events`
and shown as a chip on that site's work orders while running. **Space
viewer** (site page) is the place tree with the assets and open work orders
of the picked place — no floor plans. Tests: `tests/wo-record.test.ts`.

**Maintenance modules** (migration 0065, Facilio parity; `shared/maintenance.ts`,
`services/maintenance.ts`, `routes/maintenance.ts`, `/maintenance` in the
sidebar, one tab each). **Services** (`service_item`: unit, price, cost) and
**job plans** (`job_plan` + steps + services) are configuration with no FK to
principal / task / vendor. Applying a plan (`applyPlanToTask`, once per work
order, `wo_job_plan`) adds its steps to the 0064 checklist and its services to
`wo_service`; a planned-maintenance schedule may name one
(`pm_schedule.job_plan_id`, set by `setJobPlan` outside the positional VALUES
list) and it is applied to every work order the schedule raises. **Technician
time** (`wo_time_entry`; no end = a running timer, one per technician) shows
on the Timelog tab and across work orders in the Time tracker. **Work
permits** (`work_permit`, PTW-n): draft → requested → approved → closed, or
rejected; "active" / "expired" are read from the dates (`permitState`), never
stored; once requested only the precaution ticks move. The **Assignment
Manager** has no table: it reads the Assignee field the scope rule keys on and
assigns through `updateWorkOrderFields`, so the audit trail, gates and
automations all see it. Services and time entries do NOT feed `34. Cost`.
Permission paths `maintenance/job_plans|services|time|permits|assignment`
(unset inherits `maintenance`); dispatchers have no Assignment Manager and do
not approve permits. `components/ui/Sheet.tsx` (`Sheet`, `F`, `PageTabs`) is
the dialog / tab kit every module from 0065 on uses; their styles are in
`styles/maintenance.css`. Tests: `tests/maintenance.test.ts`.

**Vendors, the rest** (migration 0066; `shared/vendorExtras.ts`,
`services/vendorExtras.ts`, `services/vendorPortal.ts`,
`routes/vendorExtras.ts`). Three things are soft on purpose. (1) **Invoicing
rules** only WARN: `billExtrasFor` decorates a vendor bill as it is read
(`warnings`, `credit_notes`, `credited`, `net_total`), inside a try/catch in
`vendorBills.hydrate` so a failure never takes the bills down; approving and
paying are untouched. The rules are the `bill_rules` row of `vendor_setting`.
(2) **Credit notes** (`vendor_credit_note`, CN-n) change no stored total; at or
under `credit_approval_over` they are approved as written, above it they wait
for `payments` approve. (3) The **dispatch cascade** is OFF by default
(`dispatch_cascade` in `vendor_setting`: enabled, auto_start, hours). On, it
offers a work order to the PREFERRED vendors of its client / trade / state in
turn (`wo_dispatch_offer`, one live offer per work order); a decline or a
lapsed clock moves it on (`advance` on every read, and the hourly cron);
accepting sets `task.vendor_id`. A client or trade with no preferred vendors
is never touched — unless Admin switched `cascade_auto` on (0069, below), when
the automatic picks follow the hand-picked ones (`dispatchCandidates`). `maybeAutoStartDispatch` is called from `createWorkOrder`
and is a no-op unless both switches are on. Also: skills, inductions
(`inductionState`), consumables (catalogue + `wo_consumable`), and
`/vendors?view=performance` (jobs, SLA met / missed, recalls = the Recall tag,
offers taken, billed, bill checks). **Vendor portal**: a link per vendor with
no account behind it — read the SECURITY block at the top of
`services/vendorPortal.ts` before touching it. The token is 32 url-safe
characters shown once and stored only as a SHA-256; `/api/public/vendor-portal/…`
is on the auth guard's pattern allowlist; every read and write is pinned to the
link's vendor; a job is the fixed `PortalJob` shape (no money, no internal
notes); an onboarding form waits in `vendor_onboarding` until one of us accepts
it and only the keys of `OnboardingPayload` are read. No email is sent: a
person copies the link. `scripts/export-vr-crm.mjs` exports VR - CRM vendors
and Tech Locator technicians to CSV for the existing import wizard, in READ
ONLY sessions (it cannot write to either database). Paths `vendors/portal`,
`vendors/dispatch`. Tests: `tests/vendor-extras.test.ts`.

**Purchasing, tax rates, templates, budgets** (migration 0067;
`shared/purchasing.ts`, `services/purchasing.ts`, `routes/purchasing.ts`,
`/purchasing`). Purchase request (PR-n: draft → submitted → approved →
ordered) → request for quotation (RFQ-n; "sent" is a status somebody sets,
nothing is emailed; vendor quotes are recorded by staff and compared with
`compareQuotes`; Award drafts a purchase order from the winning quote) →
purchase order (PO-n: draft → issued → partly / fully received → closed).
A document tied to a work order follows that work order's scope (`scopeOr`).
**A purchase order never writes `34. Cost`.** Budgets and AFEs count a work
order's Cost plus the purchase orders NOT tied to a work order, so nothing is
counted twice; going over one is a warning on the order, never a block.
`tax_rate` is a list to pick from: nothing on file is recomputed (a purchase
order snapshots the name and percent; the quote builder's `TaxRatePicker`
writes an amount into the hand-typed Sales Tax field). `doc_template` (one
default per kind) adds a letterhead, terms and a footer to the PRINTED quote,
invoice (`/invoices/:id/print`, new) and purchase order; with none, the quote
prints exactly as before. Tax rates and templates are edited in Admin ›
Settings (`admin/settings`). Paths `purchasing/requests|rfqs|orders|budgets`.
Tests: `tests/purchasing.test.ts`.

**Dashboard tabs, groups and five more boards** (no migration). A card's tab
and group are two names inside its `config` (`tab`, `section`);
`dashboardTabs` / `widgetsByGroup` in `shared/dashboards.ts` lay them out. A
dashboard whose cards name no tab has no tab strip, so every board that
existed is unchanged. Shipped through `ensureSystemDashboards` as usual:
Maintenance Supervisor, Vendor Performance, Technician, Store Manager,
Unified Ops. Tests: `tests/dashboard-tabs.test.ts`.

**Cost and Total Invoiced follow the money records** (no migration;
`shared/moneyRules.ts`, `services/moneySync.ts`, `tests/money-rules.test.ts`).
Two rules Elise set on 2026-10-05, encoded on purpose (not editable from
Admin yet): **`34. Cost` moves with the money that went out** (since 0076 —
Jeff's Yoda rules, Elise 2026-10-13: Pay adds the amount to whatever Cost
holds, deleting a paid request subtracts it, `moneySync.addToCost`, inside
the payment's transaction; before 0076 Cost was re-derived as the sum of
"accepted" requests, `syncCostFromPayments`, now unused); and
**`Total Invoiced` = the total of the INVOICE, set when it is sent**
(since 0083, UAT #10: `setInvoicedFromInvoice` inside the send's
transaction, `via: 'invoice'`; before 0083 it was the quote's total stamped on
a move to Invoiced, `syncInvoicedFromQuote`, now unused). This is the
automation BRD rule 11.3.2 promised for the final vendor cost. A system write
is an ordinary `field_updated` row stamped `via: 'payment'` / `via: 'invoice'`, re-derives
Profit, and is dispatched to the automations after the commit — so an
paid request that takes Cost past the NTE raises the `nte_override` task
(1.5.2), which then holds Approve and Pay, and deleting it clears the task.
Edge cases: a typed Cost is the starting point a payment adds to; Cost never
goes below zero. **The lock** (`assertMoneyNotLocked`, called by the field
editor and bulk edit beside the visit-owned guard; a 400 that names the work
orders): Total Invoiced is ALWAYS refused (0083, `SYSTEM_MONEY_KEYS`); a
Cost edit is refused only while the field's LATEST audit row is a system
write with a value. So a work order with no paid payment still takes a typed Cost (or
11.3.2 would keep it out of Done), and figures typed before these rules stay
correctable until the system first writes them. Not covered on purpose:
vendor bills do not feed Cost, CSV import is not guarded, nothing was
back-filled.

**Quotes & payments at Yoda parity** (migration 0076, Jeff Soren's port of
the standalone Yoda tool, D1–D16; Elise 2026-10-13: **his rules are the
source of truth** where they clash with ours). Quotes: option-level client
decision (`client_approved` / `client_declined`, `POST …/quote/client-approve
{section_id, on_site?}` / `client-decline`), rounds (`quote_section.round`,
`…/quote/new-round` after a decision; an earlier round's approved option
prices as incurred, the incurred section locks from round 2), withdraw
(`cancel-submission`, sent → approved), revision snapshots
(`quote_revision_snapshot`), and the **Yoda total rule**: each option is
`(incurred + option) × (1 + sales_tax_pct)` plus the per-line taxes (0048),
Grand Total = the approved option's, else the first included one's;
`total_rule = 'options_only'` keeps the old RULE B. Sales tax is a PERCENT
(`sales_tax_pct`, derived from `labor_rate` + ZIP via `services/salesTax.ts`,
cache → RapidAPI → state fallback); the old `$ sales_tax` column is unread.
fee / discount line types (discount is negative by type), integer `day`.
Our 0046/0048 work rides inside it: per-line markup / tax / UOM, the contract
OT multiplier, quote numbers, document type, bill/ship-to, Print / PDF.
**WO-status gating** (`allowedWoActions` in shared, `services/woPolicy.ts`,
403 `WO_STATUS_BLOCKED`, served as `WorkOrderDetail.actions` and
`Quote.wo_actions`): quoting closes from Done, the client decision still
records at Done, payment requests run until Invoiced / Cancelled, AP
processing is never gated; a status the phase map does not know stays live.
Payments: requested → approved → **paid** (since 0083 Pay only from
approved, never by the requester — "UAT round 1, Wave A" below);
**`sent_to_yoda` is retired** (0076 folded those rows to approved,
the value stays legal in the CHECK). Method codes `zelle|ach|credit|check|
cashapp` (CHECK) with a per-method `payment_address` (ACH masked unless
`payments/process:edit`); purpose J / M / A numbered J, J1, J2… per work
order (0083; the duplicate-purpose 409 is gone); blacklisted vendor 409
(admin override); W9 running total > $599 per vendor + billing entity + year,
non-credit, alternate recipients excluded (`needs_w9`); soft delete with
reason, processed rows → `pending_delete` until `payments/process:delete`
(admin, granted by 0076) confirms or keeps. **Payment requests are NOT
tier-gated any more** (6.2.3 bands still gate vendor bills and invoices).
The payee typeahead is `/api/payment-vendors` (`services/paymentVendors.ts`)
and reads OUR vendor record (0057: `w9_received = 'YES'`, `blacklisted`,
earliest `vendor_expiry`); Jeff's duplicate vendor columns and his
`/vendors` routes were NOT brought (they collided with the Vendors module).
A manual payee creates a `kind = 'tech'` vendor + `vendor_phone` row. Every
ClickUp / Teams push Yoda made is an `outbox` row (nothing drains it yet;
distinct from 0052's `comment_delivery`). Soft-deleted payments are excluded
by every reader (`deleted_at IS NULL`). Smoke script:
`scripts/smoke-quotes-payments.ps1` (needs a running API). The demo AP user
"Dana Reyes" is seeded locally only, never inserted by the migration.

**The assistant** (migration 0068; `shared/assistant.ts`,
`services/assistant.ts`, `lib/assistantPrompt.ts`, `lib/assistantTools.ts`,
`components/assistant/AssistantPanel.tsx`, the sparkle button in the top
bar). Ask anything about the data; Claude answers from look-ups made at that
moment. **It only reads, and it has no access path of its own**: every
look-up is one of the app's existing GET routes, fetched with `app.inject`
and the asker's own session cookie, so the route's permission checks, the
work-order scope (0026), the site restriction (0062) and field redaction
(0015) decide what comes back — viewing-as included. Three tools:
`search_work_orders` (the saved-view filter set, `group_by`, `count_only`),
`get_work_order` (named parts: details, updates, visits, quote, payments…)
and `lookup` (a named resource from the `RESOURCES` table: quotes, payments,
approvals, invoices, vendors, sites, assets…). The model names a resource,
never a path; **to let it read something new, add a row to `RESOURCES` or
`WO_PARTS`** — no exports, nothing that writes. The Admin console's lists
are rows there too (`admin_users`, `admin_roles`, `audit_log`,
`automations` and their run logs, `custom_fields`, `status_setup`, `trash`,
`holidays`, `approval_tiers`); those routes check the SIGNED-IN person's
`admin/<section>` grant themselves, so a non-admin's look-up comes back
"not available" and the assistant says so.
`shapeResult` trims what comes back (`compactForModel`, 60k characters per
look-up, a cut result says so). The prompt is three layers, most stable
first, for the prompt cache: `BRIEFING` (vocabulary and how to answer;
static), the reference block (statuses, the fields THIS person may see,
taught notes), and the date / asker / current page inside the question.
Earlier turns are replayed as text only, so a follow-up re-reads what it
needs. One question = one request (non-streaming, up to 12 model steps,
240 s); a refusal falls back server-side (`fallbacks: 'default'`, and
`echoable` drops the pre-fallback thinking and tool calls as the API asks).
Conversations (`assistant_conversation` / `assistant_message`) belong to
the person signed in, not who they view as. **How it improves**: a thumb on
every answer; `assistant_note` rows ("Taught" tab) that are read before
every answer; the "Marked answers" tab where a reviewer reads the wrong ones
(with the look-ups behind them) and teaches a note from one. Permission
path `assistant`: view = ask (every role), edit = teach and review (Admin).
Env: shares `ANTHROPIC_API_KEY` with the quote draft (unset = the panel says
it is not switched on), `ASSISTANT_AI_MODEL` (default `claude-opus-5-5`),
`ASSISTANT_AI_EFFORT` (medium), `ASSISTANT_DAILY_LIMIT` (100 questions per
person per Chicago day; over it is a 409). Audit: `assistant_asked` (entity
`assistant`, entity_id = the conversation; carries the look-up summaries,
not the question or answer) and `assistant_note_created|updated|deleted`.
Replies are drawn from a fixed subset (paragraphs, "- " lists, bold, code,
links) and a link is only followed when `assistantLinkOk` says it is a path
inside the app. Deferred: actions (it changes nothing), search by meaning
over comments and transcripts (pgvector), a stored test set of questions,
streaming. The live Claude call was exercised against a local stand-in, not
the real API (no key on the build machine). Tests: `tests/assistant.test.ts`.

**The assistant also explains how to use the app, and only the app** (no
migration). `lib/assistantGuide.ts` (+ `assistantGuideWorkOrders.ts`,
`assistantGuideModules.ts`) is a guide to every screen: the steps of each
task with the labels as they are on screen, and the permission the API checks
for it. **It is written by hand from the JSX — when a screen, a button label
or a gate changes, change its entry there**, or the assistant will repeat the
old name to people; it is told to say it is not sure about anything the guide
does not cover. `tests/assistant-guide.test.ts` is the guide's drift guard:
every **bold label** in it must occur verbatim somewhere in
`apps/web/src/**/*.{ts,tsx}` (comments stripped, JSX entities decoded) or sit
in its `ALLOWLIST` / `TEMPLATES` / `FROM_SHARED` with a reason (a stale-entry
test keeps those lists honest); the API sentences it quotes are checked
against `services/users.ts`, `plugins/authGuard.ts`, `services/woBulk.ts` and
`services/woScope.ts`, the screen sentences against their pages, and the
Payments lanes against `PaymentsPage`'s `LANE_LABEL`. Rename one and the test
fails until the guide follows. The guide rides in the cached static block
(`STATIC_INSTRUCTIONS` = briefing + guide, about 10k tokens). Every question
carries "What this person may do": `describeAbilities` resolves the
permission tree (`buildPermissionTree([])`, two levels) for the asker, one row
per line, every row — the `admin/*` ones included since Wave B (D6) — read
from who they act as, as `requireAdmin` reads it. So "how do I add
an automation" gets the steps for someone with `admin/automations` edit and
"you are not allowed to add automations" for anyone else. Anything outside The
One (general knowledge, other software, writing unrelated to a record) is
declined in one sentence; that is a rule in `BRIEFING` ("What you answer"),
not a filter in code. Replies may now carry numbered steps (`<ol>`), and on a
screen 1200px or wider the page makes room for the open panel
(`body.asst-open`) so the button an answer points at is not underneath it.

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
the CLIENT gets (link, email, client CSV) is built by `buildView` as the
tracker's OWNER sees it since Wave B (#17): the owner's scope ∩ the client,
shared columns that are client-safe and visible to the owner. Five **computed columns**
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
contact@seamlessfm.com) through `services/mailer.ts` — **`MAIL_PROVIDER=gmail`**
(the mailbox is on Google Workspace, not Microsoft 365 — Elise 2026-10-13;
`lib/gmail.ts`: a Google service account signs an RS256 JWT with `sub` =
the mailbox and the `gmail.send` scope, which needs Domain-wide delegation
for its client id in the Workspace admin console; key in
`GMAIL_SERVICE_ACCOUNT_JSON` or `GMAIL_SERVICE_ACCOUNT_EMAIL` +
`GMAIL_PRIVATE_KEY`; one base64url MIME message to `users/me/messages/send`;
unset MAIL_PROVIDER picks Gmail when its key is present), or `graph`
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

**Suggested vendors** (migration 0069, `services/vendorSuggest.ts`,
`components/wo/tech/SuggestedVendorsCard.tsx` on the Tech Hub tab): the top few
vendors for a work order by its trade, location and client. Two layers, one
list: the hand-picked `preferred_vendor` rules first (most specific rule, then
rank; a rule may now name a **city** of its state, scored client 8 · trade 4 ·
city 2 · state 1 so the old order holds), then an **automatic fill** of the
places left: vendors that pass the hard filters (filed under the work order's
trade, cover its location — map radius, statewide there, nationwide — and, on
an Emergency work order when asked, take same-day emergencies), sorted by a
fixed order of tie-breakers (`client_history`, `distance`, `compliance`,
`jobs`, `rate`), never a weighted score. The ranking is the pure
`rankSuggestions` in `packages/shared/src/vendorSuggest.ts`
(`tests/vendor-suggest.test.ts`). Everything is one `vendor_setting` row,
`suggest` (`SuggestSettings`: size, auto_fill, order, off, match_trade,
in_coverage, require_compliance, emergency_availability, cascade_auto), edited
in Admin › Vendors & map › Suggested vendors (`PUT /admin/vendors/suggest`,
grant `admin/vendors` edit, audited as `vendor_settings_updated` on entity id
`suggest`). Fixed in code: a blacklisted vendor is never suggested.
`GET /work-orders/:id/suggested-vendors` needs `vendor_map` view and shows
only the kinds of vendor the viewer's `vendor_map/*` grants allow, as the map
does; Hire is the map's own hire. A hand-picked vendor is listed however far
away it is. The map itself still sorts by distance. Not built: a rule per
site, and any rating signal (there is no rating field).

**SharePoint folders** (migration 0071, `shared/sharepoint.ts` pure +
`tests/sharepoint-folders.test.ts`, `apps/api/src/lib/graphDrive.ts` Graph
calls, `services/sharepoint.ts` the queue, `pages/admin/SharePointCard.tsx`,
`components/SharePointFolderChip.tsx`). The team files every work order in
its SharePoint library as `Documents / General / Work Orders - {year} /
{year} - {Comp} / {Client} / WO#{number}, {City}, {ST}`; the app now makes
those folders itself. Three switches in Admin › Settings › SharePoint
folders (`sharepoint_setting` row `config`, `PUT /admin/sharepoint`, grant
`admin/settings` edit, audited `sharepoint_settings_updated`): a folder per
**new client** (under its `billing_entity`; none = `skipped`), a folder per
**new work order** (under the client, whichever path created it), and
**approved files copied** into the work-order folder (never quarantined
ones). Each switch stamps `*_since` when turned on and files only records
created after it — turning one on never backfills. The site URL, library and
the three path templates are editable in the same card; credentials are env
(`SHAREPOINT_TENANT_ID/CLIENT_ID/CLIENT_SECRET`, falling back to
`MAIL_GRAPH_*` then `ENTRA_*`; needs `Sites.Selected` or
`Files.ReadWrite.All` as an application permission). One `sharepoint_folder`
row per (kind, entity_id) with `path`, `web_url`, `status` pending / created /
failed / skipped, `error`, `attempts`; one `sharepoint_file` row per copied
attachment. `fileWorkOrder` / `fileClient` / `fileAttachment` run AFTER the
creating commit (woCreate, intake, plannedMaintenance, woBulk;
portfolioExtras.createClient; attachments.reviewAttachment on approve), are
bounded (20 s per Graph call) and never throw; the hourly client-updates
cron also runs `sweepSharePoint`, which retries failures (6 tries), files
work orders created by paths that do not call us (the Ecotrak sync — that
module is untouched) and re-plans a row that failed for want of a client on
file. The **client must exist under Clients** (matched by name,
case-insensitive; its spelling names the folder) so a typo never forks the
live tree; `WO#` takes `ext_name` for `ECO-` numbers and strips a `WO-`
prefix otherwise; the year is `date_received`'s, else `created_at`'s.
Folders along the way are created when missing; an existing folder is
reused; nothing is ever deleted or renamed in SharePoint. Header chip on
the work order and on the client record (`GET/POST …/sharepoint-folder`,
POST = make it now, whatever the switch says; `work_orders/attachments`
create / `clients` edit). Audit: `sharepoint_folder_created` (entity task
or client), `sharepoint_file_copied`. Not built: deleting or renaming
folders, backfilling old records, per-Comp site overrides.

**Sales: one dashboard, counted over their clients** (migration 0072,
`services/woScope.ts`, `services/users.ts`, the `sales` board in
`shared/dashboards.ts`, `tests/sales-scope.test.ts`). The sales team does
not work the work orders; they want to know how many came in for THEIR
clients. Nothing new in mechanism:
- **Role `sales`** (0072, is_system): `dashboard` view, `dashboard/boards`
  no, `dashboard/boards/sales` yes, `work_orders/scope` Only theirs — and no
  other section, so the sidebar is the Dashboard item alone. Which sections
  and sub-sections a salesperson sees is decided like every other role's:
  Admin › Roles (and per person, Adjust). A role with no `work_orders` lands
  on `/dashboard` from `/` (`HomeRoute` in `App.tsx`), the topbar search and
  the Pulse / Receivables nav items need their sections, and a card's
  drill-through is drawn as plain text when the list behind it is closed
  (`Drill` in `WidgetCard.tsx`).
- **`principal_client`** — the clients assigned to a person. Admin › Users
  has a **Clients** column per row (chips + Assign / Edit, opening a tickable
  list of the client records, anyone with `admin/users` edit, logged
  `user_clients_changed`; `GET|PUT /admin/users/:id/clients`). Not held back
  for super admins the way Adjust is: it is an assignment, not an override. A
  super admin cannot be given a list (they see everything).
- **The scope**: `woScopeSql` gains a third OR under "Only theirs" — the
  work order's `client` text matches one of the person's clients by
  `lower(btrim())`, the 0062 join — so the Sales board, and anywhere else the
  role lets them look, count exactly those. The session carries
  `clients: string[]` (`SessionPrincipal`, `/auth/me`) and the request actor
  `hasClients`; the list header chip reads "Yours + Walmart" like it reads
  "Yours + SFM" for an entity. A dispatcher given clients sees those clients'
  work orders in full, like an entity tick — by design, it is the same widening.
- **The Sales board** (`system_key = sales`, folder Sales, shared with sales
  / admin / am / tl): received, open, emergencies, completed; by client, per
  month, by status, by trade, by city. Every card is a plain work-order
  count over the viewer's scope; the board period is date received like
  every board. Inserted by `ensureSystemDashboards` on the first read; the
  migration grants it to the role ahead of time.

**Save as PDF** (migration 0073, `shared/woPdf.ts`, `lib/woPdf.ts`,
`services/woPdf.ts`, `routes/woPdf.ts`, `PdfMenu` in `components/wo/record/
RecordParts.tsx`, `pages/admin/PdfLayoutsCard.tsx`, `tests/wo-pdf.test.ts`).
The **Save as PDF** button on the record bar (readers too: its own permission
`work_orders/pdf` view, unset = `work_orders` view) offers two documents,
each a plain `<a download>` of `GET /work-orders/:id/pdf?kind=full|request
&download=1` (inline without `download`): **Work order** — the main fields —
and **Request** — what the client sent (client, entity, store, address,
contact, trade, NTE, SLA, description). Which fields each prints, in what
order, its title, whether empty fields are left off and a note under the
fields is **one row per kind in `wo_pdf_layout`**, edited in Admin › Settings
› Work-order PDFs (`admin/settings` edit, logged `wo_pdf_layout_updated`
with before/after snapshots; `GET /admin/pdf-layouts` also returns every
field the list may hold, by section; the defaults the migration seeds are
`WO_PDF_DEFAULTS` in shared — **change both together**). Items are catalogue
keys (`wo_number`, `client`, `nte`, `status`, … from `WO_PDF_CORE_KEYS`, and
`fields.<json key>`). The document is drawn by **pdf-lib** in the billing
entity's branding — the sign-off sheets' header / footer / logo art and brand
colours (`BRANDS` and `embedAsset` are exported from `signoffPdf.ts` for it;
no Comp / unknown Comp = a neutral page), US Letter, a two-column grid that
paginates, long text (`description`, `35. WO Description`, `Parts Required`,
`20. Last Update`, `long_text` subtypes, anything over 90 chars) across the
full width, a running head on page 2+, "Page n of m". Values are formatted
on the server (`formatForPdf`: money, numbers, days kept as days whatever the
zone, datetimes in Chicago, Yes / No, lists joined, objects by name;
`paperLabel` drops the ClickUp numbering and emoji from labels). **The
layout never widens what a person sees**: `workOrderPdf` reads the detail
through `getWorkOrderDetail`, runs `redactWorkOrder` and skips every item
`canViewField` refuses, and `resolveTaskId` applies the scope 403. Each
download is logged on the task as `work_order_pdf_saved` (kind, file name,
field count). Found and fixed on the way: `Buffer.from(base64)` may return a
slice of Node's pool and pdf-lib's JPEG embedder reads `.buffer` from 0
("SOI not found in JPEG" for Repairfected's header under Node 24), so
`assetBytes` copies into a fresh `Uint8Array` — the sign-off renderer now
goes through it too, and the test churns the pool before embedding every
asset.

**"Time between" cards and per-person sharing** (no migration; the "0073"
tags in this code name the batch and have nothing to do with migration 0073,
Save as PDF, which landed the same day; `tests/dashboard-duration.test.ts`).
Management wants to measure any gap the records hold —
accepted → assigned, assigned → technician found, accepted → checked in,
payment requested → approved — from the dashboard builder.
- **A fourth measure**, `metric: 'duration'` (editor: "Time between two
  moments"), with `config.from` / `config.to` as `DurationLeg`s and
  `config.stat` avg (default) or median. A leg is `{kind: 'event', field,
  value?}` — the FIRST moment the audit trail says the field changed (to the
  value, or at all; `eventMatch` in `woMetrics.ts`, so status / Assignee /
  Tech Name / the check-in stamps all work) — or `{kind: 'date', field}`, the
  field's own date value (`compileTimestampExpr` in `woFields.ts`). The "to"
  event is the first one AFTER from_at. Work orders mix both kinds; another
  source (payments, invoices, …) takes two of its date columns, event legs
  are refused. `spanAnswer` reduces the spans: total = the statistic over
  every complete span, `count` = how many records had one (the card prints
  it), cut by any field like a count, or as a line along **when the span
  ended** (`time_field = SPAN_END_FIELD`, the editor hides the date pick).
  Records with no complete span drop out — never counted as zero. The same
  scope / filters / period as every other card apply. The card formats
  seconds with `formatDuration` ("3d 4h").
- **Sharing to people** (Share… on the board, `ShareDialog`): everyone /
  roles write role grants as before (0050); a ticked person gets
  `dashboard/boards/<ref>` view = true as their own override
  (`setUserOverrideView` in `services/users.ts`, logged
  `user_permissions_set`); unticking removes the entry so the role decides
  again. `Dashboard.shared_people`, `PATCH /dashboards/:id {shared_people}`,
  `GET /dashboards/share-options` (roles that open the section + active
  non-super-admin people; needs `dashboard` create). The Users page's
  Adjust shows the same tick under Dashboard › Which dashboards.
- Who may build: `dashboard` create (admin / TL / ATL / AM by default, Roles
  screen decides). Super admins open everything regardless.

**Admin › Integrations** (migration 0074, `shared/integrations.ts`,
`services/integrations.ts`, `routes/adminIntegrations.ts`,
`pages/admin/AdminIntegrationsPage.tsx`, logos in `public/brand/
integrations/`, `tests/integrations.test.ts`). Every connector on one page,
each with the tool's mark, what it does, whether it is set up on the server
and **one switch**: Ecotrak, ServiceChannel, Corrigo (client systems); Quo,
outgoing email, the escalation-mailbox webhook (communications); Claude
(AI); SharePoint, file storage / Vercel Blob (files); Microsoft sign-in
(platform, **locked** — always on). The list is code (`INTEGRATIONS`; a
connector is code), the switch is a row per key in `integration_setting`;
**no row = on**, so a connector added later is on until someone turns it
off. Its own admin section `admin/integrations` (view / edit; 0074 grants
it to the admin role; since Wave B (D6) the routes answer from the person
being viewed while viewing as them, like `routes/admin.ts`).
`integrationOn(key)` is **synchronous** — `storageReady` and `quoApiReady`
are called inside handlers that never awaited for it — answering from an
in-memory copy refreshed in the background every 20 s and at once after a
flip on that instance (other Vercel instances catch up within the window;
the page always reads the table). `requireIntegration(key)` throws the 409
`INTEGRATION_OFF` every gated path raises. **What off stops:** Quo —
`quoApiReady` false, `sendQuoText` and `POST /webhooks/quo` refuse (so Quo's
retries deliver once it is back on); Ecotrak — `ingestEcotrak` refuses
(manual trigger and any poll; the 2.6.3 transition checks still read the
bag); SharePoint — `fileWorkOrder` / `fileAttachment` / the sweep return
early whatever the three Settings switches say; Claude — `assistantStatus.
configured` false, `ask` and `generateDraft` refuse, `ai_configured` false;
outgoing email — `mailStatus().configured` false and `sendEmail` throws
`MailNotConfiguredError('off')`; escalation emails — the webhook answers
409; file storage — `storageReady()` false and `requireStorage` refuses
(files already stored still open). ServiceChannel / Corrigo have no
connector yet (`built: false`): the switch is remembered for the outbox
adapters when they exist. `configured` is computed from config / env / the
settings tables directly (the service imports none of the connectors — they
import it), with a one-line note of what is set or missing. Each flip is
logged `integration_turned_on|off` (entity `integration`, id = key). The
marks are the tools' favicons fetched once at build time (Corrigo's from
corrigopro.com, SharePoint shown as the Microsoft mark); a missing image
falls back to a monogram tile.

**Ecotrak, two switches** (migration 0079, `services/ecotrakAdmin.ts`,
`pages/admin/EcotrakPanel.tsx`). Elise, 2026-10-13: nothing may contact
Ecotrak unless it is switched on in Admin › Integrations, and nothing may
change what clients see there. Key `ecotrak` is now **"Ecotrak → The One"**
(read only) and `ecotrak_outbound` **"The One → Ecotrak"** is listed with
`locked_off` (cannot be turned on; `setIntegration` 409s) — no write method
exists in `ecotrak/client.ts` and a test asserts the only POST is the token.
Both carry `default_on: false`: unset or unreadable = OFF (every other key
keeps the 0074 "no row = on"); 0079 turns `ecotrak` off on existing
databases. Gates, three deep: `integrationOnNow('ecotrak')` reads the table
before every run (fail closed), `requireIntegration`, and the client refuses
even the token while `integrationOn('ecotrak')` is false. Vercel's cron hits
`/api/webhooks/ecotrak-sync` every minute (CRON_SECRET) and returns at
once while off. A run takes a 5-minute lease on `cmms_connection.run_started_at`,
re-reads today + yesterday page by page, skips a payload whose sha256 matches
`cmms_wo_link.last_payload_hash`, MERGES Ecotrak's bag keys over the stored
bag (before 0079 a refresh replaced the whole bag — Assignee, FM, Comp were
wiped), logs a `created` row (source ecotrak) or field / status rows `via:
'ecotrak'` signed "Ecotrak sync", and stores the outcome in
`cmms_connection.last_run` for the panel (Sync now, last look, errors). Ingest
still does not dispatch automations. The old `POST /integrations/ecotrak/sync`
now needs admin/integrations edit (it was any signed-in user).

Acceptance follows Ecotrak (Elise, 2026-10-13, no migration):
`ecotrakAcceptance(status)` in ingest says waiting (PENDING_SP_ACCEPTANCE /
UNASSIGNED / REASSIGN), declined (REJECTED / CANCELLED) or accepted
(anything else). Only a work order created while still waiting raises the
`wo_acceptance` task; when Ecotrak's status changes, the sync calls
`settleAcceptanceFromClient` (approvals.ts) after its commit — approved
"Accepted on Ecotrak" with NO assignee (rule 7.1.3 and the 11.1.1 gate are
skipped on purpose: the acceptance happened on Ecotrak and cannot be refused
here) or cancelled "Rejected or cancelled on Ecotrak". The ClickUp runner's
queue query holds a link with no ClickUp task while the work order's
acceptance is open, and an Ecotrak work order for `ACCEPT_GRACE` (10 min)
after its acceptance was decided or after it arrived already accepted, so the
old Ecotrak → ClickUp integration (fires on the Ecotrak accept, creates the
task with few details, sends no updates) has made its task before the 0081
lookup links to it. Updates to an already-linked task are never held.

**ClickUp sync** (migrations 0078 + 0080 + 0081, `services/clickup.ts`, `lib/clickupApi.ts`,
`lib/clickupValues.ts`, `pages/admin/ClickUpPanel.tsx`, `tests/clickup.test.ts`).
Every work order created after the ClickUp switch was FIRST turned on
(`clickup_config.sync_from`; today's mock data never goes) becomes a task in
the List pasted on the ClickUp panel under its row in Admin › Integrations,
and every change made in The One follows it. **Off skips for good** (0080,
Elise 2026-10-13): turning the switch on stamps `resumed_at` and runs
`clickUpSwitchedOn` — every linked task's `pushed` becomes its current
values with no ClickUp call, the cursor jumps to the newest activity row, and
work orders created while it was off get a `skipped` link (never created,
never marked dirty); `needs_baseline` makes the runner redo it if the call
from the switch failed. **Look before creating** (0081, while the old
Ecotrak → ClickUp integration still runs): before a create, `findExisting`
links the work order to a task created in the last `dedupe_days` (30; 0 =
off, panel checkbox, logged `clickup_dedupe_changed`) whose name or
"Ecotrak ID" field equals its Client WO # (`ext_name`) or Ecotrak ID
(`idKey`: case, spaces, dashes ignored, 4+ chars) and no other link holds;
`matched_existing` marks it and the update pass pushes every mapped value
onto it. The lookup is local: `clickup_recent_task` is topped up once a run
before the first creation (`GET /team/{team_id}/task?date_created_gt=…&
space_ids[]=…`, 100 a page; the first fill reads the whole window) and
pruned past the window; if the top-up fails, creations wait
(`DedupeNotReady`) rather than risk a duplicate. While the check is on, a
new work order is created only once it is `CREATE_WAIT_SECONDS` (60, Elise;
env `CLICKUP_CREATE_WAIT_SECONDS` for tests) old — the minute cron creates
it; updates never wait. Work orders typed in by
hand have no Client WO # / Ecotrak ID, so they are always created. A task
made elsewhere more than a minute after the work order arrived here is not
caught. **One-way** (Elise 2026-10-13:
"The One is the source of truth"): nothing is read back but the List's
vocabulary (fields + options, statuses, workspace members), so an edit made
in ClickUp is overwritten by the next change here. This lifts the July
"ClickUp is read-only" house rule in `clickup-map-handoff.md` for task
writes only. **The queue is the activity log** — no write path is hooked:
the runner links work orders created since `sync_from`, marks dirty every
link with an `activity_log` row past `cursor_log_id` (plus a 10-minute
look-back for late commits; a re-seed that restarts the ids resets the
cursor), then per dirty link creates the task (POST to the List, custom
fields inline; one bad custom value → bare create, then field by field) or
sends only what differs from `clickup_link.pushed` (one PUT for name /
description / status / priority / dates / assignees {add, rem}, one call per
custom field; null = DELETE the field). A value ClickUp refuses or cannot
take (no matching status / option, no ClickUp member by email, field absent
from the List the task was moved to) is remembered under `pushed.__errors`
by its signature and not retried until it changes; network / 5xx / 429 back
off 1-2-5-15-60 min; 401 stops the run; a 404 on the task re-creates it
next run; trashed work orders are left alone. Runs straight after every
non-GET request (`onResponse` hook in `app.ts`, kept alive with Vercel's
`waitUntil` via the request-context symbol) and from the every-minute
cron `/api/webhooks/clickup-sync` (CRON_SECRET; local dev: a 60 s timer in
`index.ts`); a lease on `clickup_config` stops two runs overlapping; a
run stops at 80 calls / 45 s (ClickUp allows 100 a minute). **The switch is
read from `integration_setting` directly**, not `integrationOn()` (its
cache answers "on" before its first refresh and ClickUp ships off; no row =
off here). Field map: our sources are title / wo_number / ext_name /
description / status / priority + every field_def; with no saved row a
source takes the automatic match by name (`matchName` drops case,
punctuation and emoji — our keys are the old ClickUp names; key before
label, then without ClickUp's "32." prefix, which dropdown options get too),
Client WO # (`ext_name`) → task name (in the team's ClickUp the task name IS
the client's WO number; "WO-41017" there is ClickUp's own custom task id,
which the API cannot set), title not sent, Assignee → assignees (people
matched by email, then by full name — their ClickUp emails are the short
form), a 403 stops the run (view-only token), Due Date → a custom "Due Date" or else the
native due date. Statuses go through `CLICKUP_STATUS_ALIASES` (the seed's
STATUS_ALIAS — keep the two in step: "!! approved", "assessment ongoing",
"done/incurred"…). Dates are Chicago wall time (`wallToInstant` in
`businessDays.ts`). In the Vista space every List shares the same 96
custom fields (Space-level), so values follow a task the ClickUp
automations move out of Incoming WOs (`900501628245`). Needs
CLICKUP_API_TOKEN (raw `pk_…` token, sent with no "Bearer");
CLICKUP_API_BASE points it at a stand-in server for testing. Audit:
`integration_turned_on|off`, `clickup_list_set`, `clickup_map_updated`
(entity `integration`, id `clickup`); pushes themselves are not logged
(they change no record) — the panel shows linked / waiting / failing and a
Retry per work order.

**Admin › Documentation** (migration 0075, `packages/shared/src/docs/`,
`services/docsSnapshot.ts`, `routes/adminDocs.ts`, `pages/admin/AdminDocsPage.tsx`,
`components/docs/`, `styles/docs.css`, `tests/docs.test.ts` +
`tests/docs-render.test.ts`). Three living documents on one page, tabs
**BRD · SOP · Lifecycle**, each with Print / Save as PDF (the print
stylesheet at the foot of `docs.css`, `body.docs-printing`), Download
Markdown (`brdMarkdown` / `sopMarkdown` / `lifecycleMarkdown`, pure, in
shared) and Download Word (the rendered HTML wrapped as a `.doc`) or
Download SVG for the chart. **The prose is a registry in code**: `brd.ts` assembles one file per part
under `docs/brd/` (platform, workOrders + woList, money, field, portfolio +
maintenance, communication, insight, admin + automation)
(`BRD_PARTS` → modules → features with what / value / controls (labels as
on screen) / rules / permissions / audit / BRD rule ids / since / deferred;
reviewed against the code by eight area audits on 2026-10-06 — the
registry says so where a screen is a prototype, API-only or unscoped),
`rules.ts` (`BUSINESS_RULES`, the numbered register with where each is
enforced and built / partial / deferred), `sop.ts` (`SOP`: the Tech Locator
SOP format — document control, role purpose, scope, who can use it,
definitions, SOP 1–20 as typed blocks, who-does-what matrix, success
metric), `lifecycle.ts` (`LIFECYCLE`: stages, one node per
`PHASE_BY_STATUS_NAME` status, edges by kind, gated statuses, side
processes). **The live half** is `GET /admin/docs/snapshot` (gate
`admin/docs` view on `actingAs` — the viewed person while viewing as, D6; 0075 grants it to admin / tl / atl /
am): statuses with counts, fields with section / options / create_mode,
roles with their level-one grants + scope + status mode, automations,
integrations (read with a super-admin bearer on purpose — the page is
already gated), approval tiers, holidays, dashboards, counts and the
`_migrations` ledger, which is the documents' revision history. **WHEN A
SCREEN, A BUTTON LABEL OR A RULE CHANGES, CHANGE ITS ENTRY IN THE REGISTRY
and bump `DOCS_REVIEWED_ON`** — `tests/docs.test.ts` fails when a sidebar
item (read from `AppShell.tsx`), an admin section, a work-order tab, an
integration or a status exists that the registry never names, when an
edge joins a status that is not a node, or when a feature cites a rule the
register lacks. The lifecycle chart (`LifecycleChart.tsx`) is one SVG:
columns = `PHASE_ORDER` + Off-ramp, node colours from the live statuses,
lock badge on gated nodes, Ecotrak push from `ECOTRAK_PUSH_BY_STATUS_NAME`,
click a node for its card; stages and side-process cards under it. The
test suite opens no database: `docs-render.test.ts` renders the three
documents to static markup with and without a snapshot instead.

**Guards added 2026-10-14** (the audit batch, AUDIT.md Must-fix 1 to 12; the
operator half, secrets, Neon branches, the repository and `main`, is
FIX-RUNBOOK.md at the repo root). (The batch's "Viewing as is read-only"
rule, IMPERSONATION_READ_ONLY and its allow / deny lists, was replaced on
2026-10-20 by migration 0088: viewing as can write and the audit row names
the real person — see "Viewing as writes" below.) **DEMO_MODE guards**
(`config.ts`, `services/auth.ts`, `routes/auth.ts`, migration 0082): the API
refuses to boot while `DEMO_MODE=true` if any of the 14 credentials in
`DEMO_MODE_SECRET_VARS` is set (`demoModeConflict`, pure; `SALES_TAX_API_KEY`
is the fourteenth). `CRON_SECRET` is left out on purpose: it authenticates
Vercel's cron to us, reaches nothing outside, and is inert in the demo, where
every cron route answers 403 before it reads it. The list is not exhaustive
by construction: `DATABASE_URL` (`user:pass@host`, no credential suffix) is
not boot-checked, and the seed marker is what refuses a demo pointed at a real
database, which was never seeded: `devBypassSignIn` and
`GET /auth/dev-candidates` answer 403 `DEMO_NOT_SEEDED` until the `app_meta`
row `seeded` exists (`assertDemoSeeded`: a missing table counts as not seeded,
any other database error is rethrown); 0082 creates `app_meta`, `seed.ts`
writes the marker as its last step and never truncates the table
(`tests/config-guards.test.ts`; it also fails when the API reads a
`*_SECRET` / `*_KEY` / `*_TOKEN` / `*_JSON` / `*_PASSWORD` name that is in
neither the list nor its allowlist with a reason, and pins the four files that
read `process.env` by computed name — `config.ts`, `ecotrak/client.ts`,
`ecotrakAdmin.ts`, `integrations.ts` — so a new computed read fails until its
author pins the credentials it reaches, as `ECOTRAK_CLIENT_SECRET` is, or
reads them by literal name; its `CRON_SECRET` tripwire reads
`routes/webhooks.ts` by meaning, so only presenting the secret outward,
comparing it by hand or dropping the demo guard trips it). **Seed host guard**
(`packages/db/src/seedGuard.ts`, `tests/seed-guard.test.ts`): before any pool
exists `seed.ts` resolves the host the way pg-connection-string does (a
`?host=` parameter wins, the last one given) and refuses unless it is
localhost / 127.0.0.1 / ::1 or `ALLOW_SEED` spells its `<host>/<database>`
(the host case-insensitively, the database exactly; the name alone is refused
because every Neon branch's database is `neondb`, and the refusal prints the
exact value to set). **Bag
writes lock the row**, and this is THE rule for `task.fields`: a whole-bag
`UPDATE task SET fields` runs inside the same `withTransaction` as a
`SELECT fields FROM task WHERE id = $1 ... FOR NO KEY UPDATE` and merges from
that read, never from a pool read; a transaction that also inserts a child row
(a visit, a sign-off sheet) locks the task row FIRST; bulk edit and the import
lock rows in id order; `assertMoneyNotLocked` takes a `Queryable` so the money
lock is checked on the transaction (`woFieldValues.ts`, `woBulk.ts` per row
and in the import's update branch, `visits.ts` `syncMirrors` and
`createVisit`, both `signoff.ts` writes, `assigneeHistory.ts`, `moneySync.ts`;
`tests/bag-lock.test.ts`). NO KEY, not plain `FOR UPDATE`, in all six: no bag
write changes `id` or `wo_number` (the only unique-indexed columns of `task`),
so it serialises bag writers just as `FOR UPDATE` would but neither blocks the
KEY SHARE a child INSERT (a comment, an attachment, a visit, an approval task,
a payment request) takes through its foreign key nor deadlocks two of them
upgrading it. The reason is written once, in `updateWorkOrderFields`
(`woFieldValues.ts:127-140`), and the other five point at it; the test reads
the unique columns of `task` off the migrations and fails when a new unique
index on `task`, or a bag-writer SET naming `id` / `wo_number`, would break
that premise (that writer then needs plain `FOR UPDATE` back). Other row locks
keep their own strength: purchasing (`rfq`, `purchase_order`) `FOR UPDATE`,
`users.ts` (`principal`) `FOR NO KEY UPDATE`, the Ecotrak ingest
(`ingest.ts:449`) `FOR UPDATE OF t`. **Purchasing and maintenance write in
transactions** (`services/purchasing.ts`, `services/maintenance.ts`,
`tests/purchasing-tx.test.ts`): `awardQuote`, `saveRfq`, `saveVendorQuote`,
`deleteVendorQuote` and `receiveOrder` lock the RFQ or the purchase order
`FOR UPDATE` and re-check its status under the lock (`awardQuote` reads the
vendor's blacklist flag under it too), and the delete-then-insert line
rewrites (requests, orders, job plans) commit as one. Every status move in
`actOnRequest` (submit, approve, reject, cancel, back to draft), `actOnRfq`
(send, close, reopen, cancel) and `actOnOrder` (close, reopen) is ONE
conditional `UPDATE … WHERE id = $1 AND status … RETURNING id` on the status
it moves from (the one it was read in; a purchase-order close from issued,
partly or fully received; the RFQ cancel from anything but awarded), refused
with the pre-check's own 409 when no row comes back; `actOnOrder` issue and
cancel lock the order `FOR UPDATE` and re-check under the lock (cancel also
its grant and the value received) before writing, the request freed in the
same commit; `saveRequest` / `saveOrder` rewrite only a record still in the
status they expect (`saveOrder` moves its request
`AND status IN ('approved','ordered')`); `saveDocTemplate`'s default flip is
one transaction, and a template saved as not the default clears that template
only (it used to clear the kind's default on every edit of another template);
every move logs after its statement (request back to draft, RFQ close /
reopen and purchase-order reopen gained their rows on 2026-10-14);
`vendorWork.ts` holds no delete-then-insert rewrite
(`tests/vendor-workflow.test.ts`). **The Pulse works and is gated**
(`services/obligations.ts`, `routes/obligations.ts`,
`tests/obligations-sql.test.ts`): the four `activity_log` joins cast
`t.id::text` (they had compared text with uuid since 0023, the error was
swallowed and the engine returned nothing), `/pulse`, `/obligations`,
`/notifications` and the snooze need `work_orders` view — **since 2026-10-27
the Pulse has its own Roles row**, `work_orders/pulse` view (`PULSE_PERM_KEY`
in `shared/permissions.ts`, a child of Work orders, so unset follows
`work_orders` view and nobody changed when it appeared): `/pulse`,
`/obligations` without `?wo=`, `/notifications` and its two read routes, the
sidebar item (`NAV_PERM.Pulse`), the route's `RequireCan` and the bell ask
it; one work order's clocks (`/obligations?wo=`) and the snooze stay on
`work_orders` view (`NAV_PERM.Pulse`,
`RequireCan` on the route; the top-bar bell polls `/notifications` only with
that grant, `useNotifications(enabled)`, so a role without it, sales, sees
its app notices alone), the list and the snooze append `woScopeSql` (an
out-of-book snooze is the 403 `outOfScope`), `?wo=` resolves through
`resolveTaskId`, the reconcile INSERT is `ON CONFLICT ... DO NOTHING` on the
0004 partial index, and a swallowed error logs `code`, `message` and
`task_id`. **The CSV import is scoped** (`services/woBulk.ts`,
`importWorkOrders(rows, opts, actor)`, `tests/import-scope.test.ts`): a WO
number outside the actor's rule-8.5 scope refuses the whole file with 403
`IMPORT_SCOPE` (`details.wo_numbers`); a non-blank status cell, or a home-list
cell on a new row, without `work_orders/status` edit refuses with 403
`IMPORT_STATUS_PERMISSION`; dry runs included, super admins never refused; a
number in Trash is skipped ("In trash"), and the update branch diffs against
the locked row and writes a status only when the file named one
(`importRefusal`, pure); the import dialog lists `details.wo_numbers` under
the API's sentence (the first 20, then "…and N more."). **Only a super admin
changes super admins** (`services/users.ts`, `routes/admin.ts`,
`services/dashboards.ts`, `tests/admin-super-admin.test.ts`):
`is_super_admin` in POST or PATCH `/admin/users` needs
`req.auth.user.isSuperAdmin` (the REAL user, never the acting one) or 403
`SUPER_ADMIN_ONLY` (`assertMaySetSuperAdmin`); a super admin's row (role,
name, status), client list (`PUT /admin/users/:id/clients`, clearing
included; a non-empty list on them stays the 400 "A super admin sees every
client already") and per-person dashboard overrides (`setUserOverrideView`,
the Share dialog's write) are changed by super admins only
(`assertMayEditSuperAdmin`). `actorIsSuperAdmin` is a required parameter of
all five writers (`inviteUser`, `updateUser`, `disableUser`,
`setUserClients`, `setUserOverrideView`): the admin routes pass the real
user's flag, the Share dialog the acting identity's, which is never wider.
The ring check runs again where the write happens: on the principal row
locked `FOR NO KEY UPDATE` in `updateUser` and in `setUserClients` (whose
DELETE + INSERT now run under that lock, so two replacements of one person's
list serialise), and in `setUserOverrideView`'s conditional UPDATE (409 "The
account changed while it was being edited — try again" when the row was
promoted in between). The last-super-admin count and the UPDATE run in one
transaction under `pg_advisory_xact_lock(ADVISORY_LOCKS.superAdminRing)`
(7262027), and `user_updated` / `user_disabled` log the row as locked
(before) and the UPDATE's RETURNING (after). The Users page locks the switch
and a super admin's Role / Disable controls with the API's sentence.
**Receivables is
gated and honest** (`App.tsx`, `pages/ReceivablesPage.tsx`,
`lib/receivables.ts`, `tests/receivables-no-fake.test.ts`): `/receivables`
needs `invoicing` view (`RequireCan`), the Audit tab (hidden since UAT Wave D,
M23) carries a prototype
banner, every fact is read from the list payload (Assignee, CICO status, BFI
through `columns=`, the quote through `/quotes`) or drawn as "not tracked
yet" and never counted as a finding, and the three list windows are the
pinned constants `WO_LIST_CAP` (500), `QUOTES_LIST_CAP` (200) and
`INVOICES_LIST_CAP` (500), the page saying when one is hit. **The migration
ledger is checksummed and locked** (`packages/db/src/migrate.ts`,
`migrateLedger.ts`, `tests/migrate-ledger.test.ts`): `_migrations.checksum`
is the sha256 of the file with CRLF folded to LF, each file and its ledger row
commit in one explicit transaction, the run holds
`pg_advisory_lock(ADVISORY_LOCKS.migrate)` (7262026) on a DIRECT connection
(it prefers `DATABASE_URL_UNPOOLED` and refuses a `-pooler` host before
connecting), waits at most 120 s for another run, refuses an applied file
whose checksum changed unless `MIGRATE_ALLOW_CHECKSUM_MISMATCH=1`, backfills
NULL checksums from the files on disk, and writes nothing when refused. Also
refused before anything is written, exit 1, with no override: a file to apply
that, outside comments, strings, quoted identifiers and `$$` bodies, manages
its own transaction (BEGIN / START TRANSACTION / COMMIT / ROLLBACK at a
statement start) or says CONCURRENTLY anywhere (`migrationFileProblems`,
named with its file and line); and a `DATABASE_URL_UNPOOLED` the guard cannot
read as a URL (`u:p@/db`, which pg would open as PGHOST or localhost),
whatever `DATABASE_URL` or `ALLOW_MIGRATE` say. `ALLOW_MIGRATE` is compared
as `ALLOW_SEED` is (`seedConfirmed`: the host case-insensitively, the
database exactly, a target with no host or no database refused outright).
**Advisory locks have one registry** (`packages/shared/src/advisoryLocks.ts`,
`tests/advisory-locks.test.ts`): `ADVISORY_LOCKS` names every key (`migrate`
7262026, `superAdminRing` 7262027); the test pins the values, that they
differ, and that every `pg_advisory*` call site in the tree (today
`services/users.ts` and `packages/db/src/migrate.ts`) reads its key from
there, so a new advisory lock is a key there and a path in the test, never a
literal. **The tests are hermetic**
(`vitest.config.mts` `setupFiles: ['tests/setup.ts']`; `config.ts` skips
`loadEnvFile` under `VITEST`): the suite sets its own auth, origin and
database variables, opens no database, and passes under
`env -i PATH SYSTEMROOT npx vitest run`, which is what CI gets. Error codes
the batch added, all under the house `details.code`: `IMPERSONATION_READ_ONLY`,
`DEMO_NOT_SEEDED`, `SUPER_ADMIN_ONLY`, `IMPORT_SCOPE`,
`IMPORT_STATUS_PERMISSION`. The dependency update (fastify 5.12.7, fast-uri
3.1.8 / 4.2.2, react-router and react-router-dom 6.30.6) changed only
`package-lock.json`.

**UAT round 1, Wave A — money integrity** (migration 0083,
`docs/specs/uat-round-1.md`, `packages/shared/src/moneyGuards.ts`,
`tests/uat-wave-a.test.ts`). House rule D1: an integrity fault is a hard
refusal (409 + `details.code`); a business-judgment overage raises an
`approval_task` that holds the money step until a manager approves it (the
approval stores `detail.covers`, the figure it lets through, so the same
click then goes through — `raiseMoneyHold` / `approvedCover` in
`services/approvals.ts`); the rest warns. **Maker ≠ checker (D2):**
`selfApprovalVerdict` in shared; 403 `SELF_APPROVAL` when the requester
approves or pays their own payment request, the recorder approves their
vendor bill, the submitter (`quote.submitted_by`, else `created_by`)
approves or sends their quote, the raiser of ANY approval task approves it in
`decide` (status requests, money holds), the requester approves their
purchase request, the drafter approves their PO over the limit, the raiser
sends their invoice; a super admin may, and the decision's audit row carries
`self_approved: true`; the web locks each button with "(maker ≠ checker)".
**Payments (#4/#5/#7/#24/#25):** Pay only from `approved` (409
`PAYMENT_NOT_APPROVED`); every status move — and quote `transition`,
approvals `decide`, invoice and vendor-bill `move` — is ONE conditional
`UPDATE … WHERE id = $1 AND status = <read> RETURNING`, the loser gets a 409
(`PAYMENT_MOVED`, `QUOTE_MOVED`, `ALREADY_DECIDED`, `INVOICE_MOVED`,
`VENDOR_BILL_MOVED`), so Cost is added once. Before approve AND pay,
`assertPaymentNotHeld`: Cost + amount past the NTE with no approved override
covering it raises / refreshes the `nte_override` (detail `projected: true`,
`payment_request_id`; 409 `NTE_OVERRIDE_REQUIRED`), past the approved
quote's price or cost side raises `over_quote` (409 `OVER_QUOTE`); a rule
re-raising an NTE override for a cost already covered raises nothing, and
reconcile keeps a projected hold while its payment waits. Each payment row
carries `money_hold` (the lock reason). Purpose is J / M / A, numbered per
work order under the task lock (`nextPurpose`), free-text rows untouched.
**Vendor bills (#20):** total > 0, a vendor's bill number once (409
`VENDOR_BILL_DUPLICATE`, partial unique index), a bill above what is still
owed (approved quote `total_cost` − paid requests − other approved / paid
bills) raises `bill_over_owed` (409 `BILL_OVER_OWED`). The two new task
types live in the inbox section **Money holds** (`approvals/money`, unset
inherits `approvals`). **Purchasing (#21):** a vendor is a record
(409 `VENDOR_REQUIRED`, a typed name is refused on requests and orders), one
live PO per purchase request (409 `PO_EXISTS`, partial unique index, the
request row locked), a PO with no request above the PO limit
(`purchasing_setting` key `po_limit`, default `PO_LIMIT_DEFAULT` $5,000, no
row inserted; Admin › Settings › Purchase order limit, `PUT
/purchasing/settings`, `admin/settings` edit, logged
`purchasing_setting_updated`) needs **Approve over limit**
(`approvePoOverLimit`, `purchase_order.limit_approved_by/_at`, cleared when
the draft is saved again) before Issue (409 `PO_OVER_LIMIT`). **Quotes
(#8/#23):** editing a `pending_approval` quote sends it back to draft
(`quote_returned_to_draft`); a quote above the NTE is not sent (409
`QUOTE_OVER_NTE`); `Quote.permissions` carries `self_approval` and
`over_nte`. **Invoices (#2/#10/#26/M7):** raised only in the done group or
later (`invoiceAllowedForStatus`, 409 `INVOICE_NOT_DONE`), checked again
under the task lock and backed by `invoice_one_live_per_task` — a repeat
returns the live one; Send writes Total Invoiced; Mark paid needs
`{reference, paid_on}` (400 `INVOICE_PAYMENT_DETAILS`, `invoicing` edit).
**Bounds (M1):** `MONEY_MAX` 9,999,999.99 and `PERCENT_MAX` 999.99 on the
route schemas, `MONEY_RE` seven whole digits, money custom fields checked in
`coerceValue`, and the error handler maps Postgres 22003 / 22P02 to 400 with
`details.code = VALIDATION`. The three 0083 unique indexes are created in DO
blocks only when the rows on file already satisfy them (a NOTICE otherwise).

**UAT round 1, Wave B — access and scope** (migration 0084,
`docs/specs/uat-round-1.md`, `packages/shared/src/access.ts`,
`services/recordScope.ts`, `tests/uat-wave-b.test.ts`). **D3:** the
dispatchers are ONE list, `DISPATCHER_ROLE_CODES` / `isDispatcherRole` /
`dispatcherTier` in shared `access.ts` (om_probation = probation — ops_coord
was the same position and 0088 merged it in —, om, senior_om = senior; `assigneeAvailability.ts` no longer keeps
its own copy). **D4 / #12 / #14 / M13 / M20 — the role matrix is 0084**
(a session-only `pg_temp.wb_grant(code, path, grant)` merges a grant into one
path; role is not truncated by the seed, so only the field_def flags have a
seed twin): invoicing full for admin and ar, view for tl / atl / am (0021's
blanket view had made 0045 skip them); every system role but
`MONEY_ROLE_CODES` (admin, tl, atl, am, ar, ap) and service loses view and
edit on Cost, Profit, Total Invoiced and Discount
(`MONEY_HIDDEN_FIELD_KEYS`) and invoicing altogether; the Margin % stays — the
new computed column `margin_pct` (`MARGIN_PCT_SQL` in `woFields.ts`, a header
path nobody narrows), `money.marginPct` on the detail (`redactWorkOrder` now
nulls cost / invoiced / profit one by one) and `margin_pct` in the record's
Cost card (`redactRecordMoney` in `woRecord.ts`). exec_guest and ops_coord
are copies of om_probation (after the M13 pass); ops_coord then loses
vendors, vendor_map, clients and contracts, and is on Only theirs in request
mode (ops_coord no longer exists: 0088 moved its people to om_probation,
whose grants stand); vr_officer and oa are request mode with `work_orders/scope` view true
(they source / intake for every work order and are never its Assignee); new
system role `hr` holds `admin/users` + `admin/roles` view / edit only.
**#13 — a record opened by its own id follows its work order:**
`assertRecordInScope(kind, id, actor)` (`RECORD_TASK_SQL`: payment_request,
invoice, vendor_bill, billing_proposal, vendor_credit_note, approval_task,
wo_visit) runs at the top of every `/payment-requests/:pid…`,
`/invoices/:id…` (the print page reads it), `/vendor-bills/:id…`, billing
proposal confirm / dismiss, credit notes, approval-task approve / reject /
claim (acknowledge / withdraw are the requester's own) and `/visits/:id…`
route; POST `/invoices` and `/vendor-bills` run `assertTaskInScope` on the
body's `task_id`; a trashed work order is still checked. Quotes (and the
quote print page), attachments, calls, AI drafts and purchasing were already
scoped (`resolveTaskId` + `task_id = $2`, `scopeOr`); the test pins all of it.
**#17 — client-safe:** `field_def.client_safe` (0084; off for the Finances,
Payments, Invoicing and AR sections and the money figures,
`clientUnsafeDefaultBagKeys()`, which seed.ts re-applies — keep in step; the
core columns follow `defaultClientSafe`, Margin % off), a **Client-safe**
column in Admin › Custom fields (audited in `field_def_updated`), carried on
the catalogue and `resolveField`. A tracker's link, email and client CSV are
built AS ITS OWNER (`trackerOwner`: `created_by` through
`loadPrincipalById`; a disabled owner shares nothing): rows =
`listWorkOrders(…, owner)` ∩ `trackerFilters` (the client), columns and
charts = ticked shared AND client-safe AND `canViewField` for the owner;
saving a shared non-client-safe column or chart is 400
`CLIENT_UNSAFE_COLUMNS` naming them (the Tracker dialog locks the switch).
**#18 — nobody raises their own rights:** `assertNotSelfEdit` /
`assertNoSelfRightsChange` (403 `SELF_EDIT`, super admins included, on the
pool read and again on the locked row) cover role, status, super-admin flag,
client list and overrides (Adjust and the Share dialog's per-person tick) —
they replace the two old 400s for removing one's own super admin and
disabling oneself; a name change passes. `grantsExceeding` (shared, pure) +
`assertGrantWithinOwn` / `assertRoleGrantWithinOwn` refuse a non-super-admin
handing out, by invite, role change or role edit, an action they do not
hold — including a grant above their own explicit refusal (403
`GRANT_EXCEEDS_OWN`, `details.exceeds`; a role edit is compared with what
the role already granted). Role DEFINITIONS (POST / PATCH / DELETE
`/admin/roles`) also need `mayEditRoleDefinitions`: a super admin or the
Admin role (403 `ROLE_EDIT_RESTRICTED`; the Roles page reads it and says
"Only a super admin or someone in the Admin role can change roles."). The
dashboards Share dialog calls `updateRole` without an editor (it writes only
the sharer's own board). As specified, `hr` can therefore invite people only
into roles within its own grants and cannot edit role definitions — see the
spec's open question. **D6 / M12 — viewing as = their rights everywhere:**
`permissionSubject(req)` (`services/activity.ts`, `actingAs`, which is the
user when not viewing as) is what `requireAdmin`, `requireSuperAdmin`, GET
`/admin/roles`, `/admin/permission-fields`, `routes/adminDocs.ts`,
`routes/adminIntegrations.ts` and `routes/integrations.ts` check; the ids they
return are the viewed person's since 0088 (the audit row is re-signed to
the real user), and the user-writing routes read `isActingSuperAdmin` /
`writer` — the viewed person too, never wider than the super admin signed
in. Starting and stopping a view reads `req.auth.user`
(routes/auth.ts) and the ActorSwitcher keys on `user`, so a super admin can
always stop. The audit export is gated on the viewed person and logged under
the real user with `viewing_as`. The web reads `actingAs` throughout
(AdminUsersPage's ring now too). **M28:** `activityFieldKey` (shared) names
the catalogue field an audit row is about; `redactActivityValues` keeps an
Admin › Audit row (and its CSV line) on a field the reader cannot see but
nulls before / after (`redacted: true`); `/activity` and the detail's
`recent_activity` drop such rows; `widgetFieldsVisible` (dashboards.ts)
answers a card or a preview whose `widgetNamedFields` (value, group, time,
filter and duration-leg fields) include one the VIEWER cannot see with
`{error: 'not available'}`. Free-text audit search over before / after
skips rows on a field the reader cannot see (UAT T6, below).
**M29:** `principal.site_restricted` (0084, backfilled from principal_site)
is what the session reads; on with an empty list = no sites and no work
orders; `setSiteAccess(id, sites, actor, restricted)` writes the flag and the
list under the person's row lock (`FOR NO KEY UPDATE`), PUT takes
`restricted` (omitted = list non-empty), Admin › Sites & assets lists every
flagged person with a **Restrict to sites** switch. New error codes:
`SELF_EDIT`, `GRANT_EXCEEDS_OWN`, `ROLE_EDIT_RESTRICTED`,
`CLIENT_UNSAFE_COLUMNS`.

**UAT round 1, Wave C — workflow** (migration 0085,
`docs/specs/uat-round-1.md`, `packages/shared/src/workflow.ts` + the gate half
in `statusGates.ts`, `tests/uat-wave-c.test.ts`). **#2 — the billing
statuses ask the Done gate:** `statusGateFor(target, current)` answers
`done` for Ready to Invoice, Invoiced Not Paid and Invoiced
(`INVOICING_GATED_STATUS_NAMES`) unless the work order is already done or
later (`DONE_OR_LATER_STATUS_NAMES` = the Done and Invoiced phases, pinned to
`PHASE_BY_STATUS_NAME` by the test) — it passed the gate on the way in, or was
loaded there before the gate existed. `statusGateBlocker` reads the current
status itself when a caller does not pass it, so changeStatus (passes it),
bulkUpdate (asks per row), requestStatusChange and decide are all covered; the
status menu passes `current.name`. The lifecycle marks the three nodes gated.
**M3 — a gated status holds its field:** `gateHoldingField` /
`assertGateHoldsFields` (409 `STATUS_GATE`, `details.held = true`,
`details.field`) refuse emptying Parts Required in the two parts statuses and
the Cost from Done / Incurred on, in `updateWorkOrderFields` (status read
after the `FOR NO KEY UPDATE`) and in `bulkUpdate` (whole selection, against
the status the row will have; again under the row lock); `assertQuoteHeld`
runs on `updateQuote`'s transaction when sections are rewritten and rolls the
rewrite back while the work order is in Quote Ready or done or later
(`statusHoldsQuote`) — the builder's autosave then shows the 409.
**#15 / #16 — no side doors:** 0085 sets `work_orders/status` to request
(edit false, create true) outright for the four dispatchers
(`REQUEST_MODE_DISPATCHER_ROLES`, = D3's list); a new permission path
**`work_orders/lifecycle`** (edit; "Cancel, pause and complete" under Work
orders in Roles; unset follows `work_orders` edit) gates Cancel, Reopen,
Pause, Resume, Complete service and clearing the completion
(`requireLifecycle` in `woRecord.ts`, 403), and 0085 turns it off for every
request-mode system role (`LIFECYCLE_LOCKED_ROLES`: the dispatchers,
vr_officer, oa); the record's `can.lifecycle` hides the buttons. The NTE (the
header `nte` path and `16. Client NTE 🔴`), the SLA dates (Due Date, SLA Due
Date, SLA Requested, SLA Updated) and the AR section are edit false for the
dispatchers and vr_officer (`DISPATCHER_LOCKED_FIELD_PATHS`,
`FIELD_LOCKED_ROLES`; oa keeps them, it types them at intake and on Add work
order; Cost was already hidden by 0084). Check-ins: see "Check-in moves On
Site". An approved status request still moves the status at once and pushes
nothing (D5). **M5 — the status follows the quote:** after Send, the client's
approval and the client's decline commit, `followQuoteEvent` (quotes.ts)
moves the work order through `changeStatus` with source `'quote'` to
`QUOTE_EVENT_STATUS_NAME` — Waiting for Approval, Approved, Waiting for Quote
(Yoda: a decline is re-quoted in a new round) — only from the statuses before
it (`quoteEventStatusName`; a work order further along, or a status that does
not exist, is left alone); a refusal never undoes the quote act and rides on
the reply as `Quote.status_move`, which the builder prints. **M6:**
`clientApproveQuote` needs a note or an `attachment_id` (a file on the work
order, not declined; 400 `CLIENT_APPROVAL_EVIDENCE`), stored in
`quote.client_decision_attachment_id` (0085) and named in the client-visible
comment; the builder's sheet has a "Client’s approval on file" select.
**M4:** the ONE client-visible quote message is Send's ("Quote for $X sent to
the client for approval — …"); submit and approve post nothing for the
client, and the builder's and the list's chained "Approve & Send" became
**Approve** — **Send to client** is its own click. **M8:**
`nextVisitStamps` (shared) is how createVisit / updateVisit build a visit:
typed stamps first, a status move fills only an EMPTY stamp (moving back to
checked in keeps the typed check-in and clears the check-out; planned clears
both), and the status is read off the stamps; `checked_in_by/out_by` follow
the stamp. **M9:** `WorkOrderDetail.phases_visited` (every phase the status
history and the current status name) feeds the PhaseBar: a phase before the
current one that was never visited draws `is-skipped` (dashed, no tick).
Cancel is refused (409 `CANCEL_BILLED`, `cancelBlockedReason`) and not drawn
(`can.cancel_blocked`) once an invoice is sent or paid or a payment request
is paid. **M31:** Cancel stores `task.cancelled_from_status_id` (0085,
backfilled from the cancel's `status_changed` row) and is conditional on
`cancelled_at IS NULL`; Reopen needs a reason (400; logged as a `Reopened`
field row beside `Cancelled`) and, while the work order still sits in a
Cancel… status, moves it back through `changeStatus` (the reply's
`status_move` says where, or why not — shown on the record bar; Cancel's
own move is reported the same way now instead of being swallowed). **Since 2026-10-29 (Elise) Reopen goes to Open** (`REOPEN_STATUS_NAME`), not the status before the cancel, and is offered (`can.reopen`) for any work order in a Cancel… status (`isCancelStatusName`), stamped or not — the status menu, a rejected acceptance or an approved request leave no stamp; a direct `PATCH …/status` out of a Cancel… status is 409 `REOPEN_REQUIRED` and the status menu greys those picks (a status request still goes to a manager); `tests/reopen-to-open.test.ts`. **M18:**
no migration, seed or code creates a check-in automation — `moveOnSite` is
the one source; the two on the UAT database are an ops item (spec's
checklist). New error codes: `CANCEL_BILLED`, `CLIENT_APPROVAL_EVIDENCE`.

**UAT round 1, Wave D — data quality and UI** (migration 0086,
`docs/specs/uat-round-1.md`, `packages/shared/src/dataQuality.ts` (pure),
`apps/api/src/services/dataRules.ts` (the database half),
`tests/uat-wave-d.test.ts`). **#11 — one client list:** 0086 (and `seed.ts`
after it writes its work orders — keep in step) gives every client named on a
work order, a site or a PM schedule a `client` record (`lower(btrim(name))`,
the 0062 join), and the Ecotrak ingest calls `adoptClientsFromRecords` after
its commits (our database only). The Client on a work order is now the name
of an ACTIVE client record, matched case-insensitively and stored in the
record's spelling (`canonicalClient` / `checkFieldValue`, 400
`CLIENT_NOT_ON_FILE`): the field editor, bulk edit (bag key and the core
`client` column), Add work order and a draft's Submit (`validateBagValues` in
`woFieldValues.ts`), PM schedules; the CSV import refuses the whole file
naming the rows and clients (400 `IMPORT_UNKNOWN_CLIENT`, it never creates a
client). The `fields.Client` catalogue options and the Add work order form's
Client dropdown read the client records. **#22 / M22 — dispatchers:** a draft
needs its Client (`INTAKE_DRAFT_EXTRA_REQUIRED`; 11.1.1 itself is unchanged);
a name ADDED to the Assignee seat (`addedAssignees`) by a person is an active
human whose role `isDispatcherRole` (`assertDispatchers`, 400
`ASSIGNEE_NOT_DISPATCHER`) — field editor, bulk edit, Add work order, a
draft's Submit, Accept, the Assignment Manager, a PM schedule's save. A
rule's own write (`auto`) and the PM raise (`opts.system`, the schedule was
checked when saved) are not asked. `/principals/availability`, the
`fields.Assignee` options and the Add work order / draft / Accept pickers list
dispatchers only. **M2 — values fit their field:** `checkFieldValue` on every
written custom value (money not negative, a dropdown one of its options in the
option's spelling, a State a US code upper-cased, no date before 2000) and
`assertDateOrder` (Received on ≤ Due date, asked only when the patch touches
one of them, against the bag as the save leaves it, under the row lock); a new
WO # is 3–40 letters, digits or dashes (`woNumberProblem`, Add work order and
a draft's Submit). 400 with `details.code = VALIDATION` and `details.field`.
Stored values are never re-checked. **M10:** `raiseNext` refuses (409
`PM_ALREADY_RAISED`) while an occurrence on or after today already has its
work order — `next_due_on` is "the date after the last one claimed", which is
why every press used to raise another future date. **M11:** "No visit
logged" counts open / active / pending work outside Invoiced Not Paid
(`NO_VISIT_*`; future work is read off the Scheduled Date since T9, below). **M14:** Approve / Decline live only in
`PhotoReviewViewer` (full size, ← / → step, Esc closes); the review POST
needs `viewed: true` (400 `ATTACHMENT_NOT_VIEWED`); the uploader may approve
their own photo (no D2 on photos); approved photos show on the Client invoice
card (`ApprovedPhotosStrip`). **M15:** `integrationState` — On · set up /
On · not set up / Off. **M16:** Settings › Access reads `config.signIn`
(`enrolmentSentence`). **M17:** Restore from Trash needs `work_orders` delete
or `admin/trash` edit (`mayRestoreFromTrash`, 403
`TRASH_RESTORE_FORBIDDEN`); the empty-state copy no longer says there is no
delete. **M21:** the header draws Cost only with the Cost field's view, the
Comp chip with Comp's, the Ecotrak chip for direct status movers, the
SharePoint chip for attachment creators. **M23:** Receivables opens on
Invoicing; the Audit tab is hidden (`AUDIT_TAB_ENABLED = false`) and the
per-person "Elise" tick column is gone. **M25:** Approvals has "NTE override
(cost over NTE)" (the 1.5.2 task) and "NTE increase requests" (the 0064
`wo_nte_request` asks across work orders, `GET /api/nte-requests`, scoped by
`woScopeSql`, `approvals/nte` view; decided through the work order's own
route). **M26:** Generate sheet needs `work_orders/fields/cico` edit only
and shows disabled with the reason when storage or the Comp layout is
missing. **M27:** the printed quote has no Markup column; its unit price is
the marked-up one. **M30:** `contract_rate_version` (0086, backfilled with
each card's rates at `-infinity`; an edit that changes the rates adds one at
now()); `contractForTask` picks the card in force on the work order's
received day (else its created day, Chicago) and reads the rates version in
force then, so invoice prefill, completion proposals and the AI draft never
re-price old work; `getQuote` reads the quote's snapshotted `contract_id`.
**M32:** `contractsOverlap` — two active cards with the same party / vendor,
client, entity, the same specificity of trades and sites sharing a value, and
overlapping dates — 409 `CONTRACT_OVERLAP` on create and edit. **#9:**
`quoteTotalTerms` lists incurred + the priced option + sales tax at its % +
line tax (RULE B: the included options + line tax) under the rail and on the
Client quote card, so the visible terms add to the Grand Total (formula
unchanged, D7). **L1:** `reportedSentence` drops the "Tech reported that"
prefix when the narrative already says who reported it. **L2:** Admin › Audit
times are America/New_York, labelled ET (`auditTimeET`); the CSV has Time
(ET) before Time (UTC). **L3:** `HISTORY_FIELD_KEYS` (Previous Assignees) is
refused for everyone by the field editor, bulk edit and the create paths, and
drawn read-only. **L4:** the locked admin page names the super admins from
`GET /principals/super-admins`; the docs registry no longer lists them. **L5:**
the BRD / SOP / lifecycle registry is served by `GET /admin/docs/content`
(and `/admin/docs/markdown?doc=`) behind `admin/docs` view; the components
take it as a `content` prop, `AdminDocsPage` is `React.lazy`, and
`packages/shared/package.json` declares `"sideEffects": false` so Rollup
drops the registry modules from the main chunk (the test greps a built
`dist/` when one exists). **L6:** the quote acts read Approve · Send to
client · Record client decision (— approved / — declined). **Margin:** the
list's `margin_pct` is the record's own figure (`recordMarginPct`: invoices
sent, else the quote, over Cost / bills / payment requests), computed for the
page's rows; a Margin % sort uses the same figure since T4 (below). New error codes:
`CLIENT_NOT_ON_FILE`, `IMPORT_UNKNOWN_CLIENT`, `ASSIGNEE_NOT_DISPATCHER`,
`PM_ALREADY_RAISED`, `ATTACHMENT_NOT_VIEWED`, `TRASH_RESTORE_FORBIDDEN`,
`CONTRACT_OVERLAP`.

**UAT follow-ups (T1, T4–T6, T9)** (migration 0087, `docs/specs/uat-round-1.md`
"Follow-up tickets", `tests/uat-followups.test.ts`). **T1 — test sign-in
accounts per role:** env `TEST_ACCOUNTS_ENABLED=true` AND a non-blank
`TEST_ACCOUNTS_PASSWORD` (never in the repo; `testAccountsFromEnv` in
`config.ts`, `config.testAccounts`) switch on `POST /api/auth/test-login
{username, password}` (public in `authGuard`) and `/auth/me`'s
`test_accounts: true`, which draws a small **Test account** form under Sign in
with Microsoft (`TestAccountForm` in `SignInPage.tsx`); either unset = no form
and a 404. Works in entra and bypass alike, independent of DEMO_MODE
(`TEST_ACCOUNTS_PASSWORD` sits in config-guards' `PUBLIC_OR_INTERNAL` with its
reason, not in `DEMO_MODE_SECRET_VARS`). Username = a role code: every `role`
row except `admin` (unless `TEST_ACCOUNTS_INCLUDE_ADMIN=true`) and `service`
(`testAccountRoleAllowed`, shared `testAccounts.ts`). The password is compared
in constant time over a sha256 of each side (`lib/testAccountAuth.ts`). In
DEMO_MODE `assertDemoSeeded` is asked first, as the dev sign-in does. The FIRST
success creates the principal (INSERT … ON CONFLICT DO NOTHING by email
`test+<code>@test.theone.local` — `TEST_ACCOUNT_EMAIL_DOMAIN`, the address IS
the marker, no principal column, no seed row), display name "Test <role
label>", that role, active, `is_super_admin = false`, audited
`test_account_created` (entity principal); after that the row is the admins'
like any other — a later sign-in touches only `last_login_at`, never role or
status, and a disabled one is refused with the same sentence
(`test_sign_in_failed`, reason `disabled`). Then the ordinary `session` row +
httpOnly cookie (`services/testAccounts.ts`), with **0087's
`session.test_password_fp`** = `testPasswordFingerprint` (16 hex of a sha256)
of the password it was issued under: `loadSession` signs a test account's
session out (`testSessionAllowed`) when the feature is off, when the
password has been rotated, or when the session has no fingerprint (the dev
picker no longer lists test accounts for that reason). Guards: `toPrincipal` (services/auth.ts) reads
`isTestAccount` off the email and forces `isSuperAdmin` false whatever the row
says; `testAccountAdminWriteBlocked` in `authGuard` refuses every non-GET
under `/api/admin/users`, `/api/admin/roles` and `/api/admin/portfolio/
site-access` for a signed-in test account (`req.auth.user`) with 403
`TEST_ACCOUNT_READ_ONLY_ADMIN` (`testAccountAdminRefusal()`, the one
builder of that 403), and `applySharing` (dashboards Share dialog:
role grants + per-person overrides) does the same; five failed tries per
minute per IP (`AttemptLimiter`, in memory — per Vercel instance, the comment
says so; the IP is the first x-forwarded-for on Vercel, `config.onVercel`,
else the socket) then 429 `TOO_MANY_REQUESTS` (new `ApiErrorCode`,
`details.code = TEST_LOGIN_RATE_LIMITED`); one refusal sentence for every
wrong part ("Wrong test username or password", 401); every success logged
`test_sign_in` (by the test principal, entity principal) and every failure
`test_sign_in_failed` (by the 'Test sign-in' service principal, entity
`test_sign_in`, keyed by the username as typed, with the reason) — no password
anywhere. `/auth/me` carries `is_test_account`; the top bar draws an amber
**Test account** chip (`.chip-test-account`, `--warn` tokens). The
impersonation rules are untouched (a test account is never a super admin, so
it cannot view as anyone). Caveats, on purpose: test principals are real
principals, so they appear in the assignee pickers (OM and the other
dispatcher tiers are dispatchers) and in notice fan-outs — that is how UAT
exercises scope; their names start "Test ". The attempt limit is per server
instance and per IP (on Vercel each warm instance counts alone), so on a
public deployment the shared password must not be a dictionary word.
**T4:** the record's margin is ONE formula, `recordMarginFrom` (shared
`woRecord.ts`: revenue = invoices sent, else the quote; cost = Cost, else
vendor bills, else payment requests), used by the Cost card (`loadMoney`)
and by `recordMarginPct`, now batched — one read each of tasks, quotes
(`quotes.quoteTotalsFor`, which prices like `getQuote`, contract multiplier
included), payment requests, vendor bills and invoices for all the ids,
gated by the viewer's grants as the record is. A sort on `margin_pct` up to
`MARGIN_SORT_MAX` (500) rows runs on that figure (`marginOrderedIds`: the
SQL ranks the leaders — group, breach — with `dense_rank()`,
`orderByMargin` orders, NULLs last, ties by WO #; the page is read by id)
and the reply says `margin_sort: 'record'`; past it the sort falls back to
`MARGIN_PCT_SQL` and says `margin_sort: 'sql'`, which the Work Orders page
shows as a "Margin % sort approximate" chip. `listMatchingIds` (select all,
bulk) now orders exactly as the list (`listOrderSql` / `marginOrderedIds`;
it used to be created-at), and the export goes through `listWorkOrders`.
Filters, group-by and dashboard cards on Margin % still read
`MARGIN_PCT_SQL`. **T5:** each
payment row's `money_hold` is `paymentLockReason` (shared `moneyGuards.ts`):
an open hold, the NTE projection, and now the over-quote projection against
the approved quote's price and cost side less an approved over-quote
`covers` (`quote_covers` in the row SQL); the queue and the work order's
Payables read the quotes in one batch (`bindableQuoteFiguresFor` →
`loadSectionsFor`, three queries per page; `listQuotes` uses the same batch
now), and so does every single request the API returns — read, created,
edited, approved, paid (`mapOne`). The quote SELECT is `QUOTE_BASE_SQL` +
`quoteSql(where, tail)`; nothing edits the SQL text any more. `QuoteListItem.submitted_by` (the maker, `COALESCE(submitted_by,
created_by)`) lets the Quotes list (`quoteSelfApprovalLock`) and the
Approvals Quotes lane draw Approve locked for the submitter. **T6:**
`buildAuditWhere(f, visibleFields)` (pure) matches the search text against
before / after only on a row with no field, a non-catalogue field, or a field
on the reader's ALLOW-list (`visibleAuditFields` over every `field_def` key
and `REDACTABLE_CORE_KEYS`, `activityValuesVisible`) — a `fields.*` key with
no field_def is never on it; WO #, field name and entity still match. **T9:**
"No visit logged" is `noVisitLoggedFilter()` (shared `dataQuality.ts`): live
groups, not Invoiced Not Paid (`NO_VISIT_EXCLUDED_STATUSES` lost the three
Sched statuses), no Visit Type, and Scheduled Date empty OR on / before
`today` — written distributed, (A ∧ empty) ∨ (A ∧ ≤ today), because the
filter language has no brackets; no new operator. `is_not_set` on a custom
field of any type now also counts `''` as blank (`compileRule`).

**Viewing as writes, Keep me signed in, one probation role** (migration
0088, Jordan 2026-10-20; `tests/viewing-as.test.ts`). **Viewing as can make
changes**: the app acts as the viewed person (their rights, scope and name on
the records they create — a payment request, a quote, a comment carry THEM as
author) and the audit log names the super admin. Mechanism, so none of the
~60 `INSERT INTO activity_log` sites changed: `plugins/authGuard.ts` wraps
every route handler (`onRoute`) in `runWithAuditContext({realActorId,
viewingAsId})` while `req.auth.isImpersonating`; `packages/db/src/client.ts`
sets the transaction-local settings `theone.real_actor_id` /
`theone.viewing_as_id` right after BEGIN in every `withTransaction`, and runs
a pool `query` whose SQL names activity_log (`ACTIVITY_LOG_RE`) inside its
own transaction so it gets them too; the BEFORE INSERT trigger
`activity_log_viewing_as` re-signs a row whose actor is the viewed person to
the real one and sets the new `activity_log.viewing_as_id` (a row the real
person signed only gains `viewing_as_id`; a service principal's row is left
alone; no settings = untouched, so the worker, the seed and every ordinary
request are as before). Work started after the response (the ClickUp
`onResponse` kick) is outside the context. Read side: `lib/actorName.ts`
`ACTOR_NAME_SQL` prints "Name (viewing as Other)" in the audit trail, the
Updates feed, field and visit history and the site / asset / client / vendor
histories; Admin › Audit carries `viewing_as` (drawn under the name) and a
"Viewing as" CSV column. Not re-signed: per-person counters outside
activity_log (`vendor_map_log.principal_id` counts the map open against the
viewed person). The read-only lists, `downloadLinkProps` and
`READ_ONLY_HINT` are gone; the switcher's chip reads **Changes logged as
you** (`VIEWING_AS_HINT`). **Keep me signed in**: `session.remember`,
`auth_transaction.remember` (carries the tick through the Microsoft round
trip; `/auth/login?remember=1`, `remember: true` on dev-login and
test-login); `createSession` / `sessionLifetimeMs` / `setSessionCookie` in
`services/auth.ts`; `loadSession` pushes a remembered session out to a full
`REMEMBER_ME_DAYS` once it is a day short (`rememberDue`) and the guard
re-sends the cookie (`renewedExpiresAt`); the choice is remembered per
browser (`theone.signin.remember` in localStorage). **OM Under Probation =
Ops Coordinator**: 0088 moves every ops_coord principal to om_probation
(whose grants stand — the ex-Ops Coordinators gain its technician list,
map, Clients and contracts view), disables the `test+ops_coord` test
account, retargets open approval tasks, automation `assign_role`s and
approval-tier role lists, drops the code from dashboards' `shared_roles`,
and deletes the role. `DISPATCHER_ROLE_CODES` / `REQUEST_MODE_DISPATCHER_ROLES`
are the three codes; `canClientDecide` (quotes.ts) uses `isDispatcherRole`.

**Payment approval by requester and amount, Quote Ready without a request,
no Markup column** (migration 0090, Elise 2026-10-22; `packages/shared/src/
paymentApproval.ts` pure, `tests/payment-approval.test.ts`). **Who has to
ask:** `paymentApprovalVerdict(requesterRole, amount)` runs once in
`createPaymentRequest` — an OM Under Probation's request always lands
`requested`; an OM / Senior OM's under `PAYMENT_AUTO_APPROVE_UNDER` ($500)
lands `approved` as it is raised (`payment_request.auto_approved`,
`approved_at = now()`, `approved_by` NULL, the `payment_requested` row says
`auto_approved: true` + `approval_reason`); everyone else's waits as before.
Pay is untouched (approved, a second person, the NTE / quote holds asked
again), so auto-approved means cleared for AP, not paid. **Who may say
yes:** `approvePaymentRequest` asks the 6.2.3 amount band again
(`assertTierAllows('payment', …)`, 403 `APPROVAL_TIER`; 0076 had stopped
asking for payments) and 0090 rewrites the payment bands: under $500 anyone
with `payments` approve · $500–3,000 tl / atl / admin · $3,000 and over am /
admin (still editable in Admin › Settings › Approval tiers; vendor-bill and
invoice bands untouched). Every payment row read with a viewer carries
`tier: {label, allowed}` (`MapOpts.viewer`, the bands read once per call by
`withTiers`), so Approve locks with the band on the Payments page, the
Payables card and the Approvals inbox; Reject is never banded. The Approvals
inbox approves a payment **in one click** — the "Approve this payment?"
confirm dialog is gone (the quote one stays). **Quote Ready needs no
approval:** `NO_APPROVAL_STATUS_NAMES` / `statusMoveNeedsNoApproval` in
shared `workflow.ts`; `PATCH /work-orders/:id/status` lets a request-mode
actor (`work_orders/status` create without edit) move DIRECTLY to one of
those (the status name is read by id; anyone else without edit is still
403), the status menu calls `patchStatus` instead of `requestStatusChange`
for them and tags the pick "No approval" (`.status-menu-direct`). The
11.2.1 quote gate and the Ecotrak check still run in `changeStatus`.
**Markup:** the quote builder's per-line Markup % column is gone
(`LineItemsTable`, `DraftLine` has no `markup_pct`); a line saved with a
markup loads with the marked-up unit price (`foldMarkup` in `quoteDraft.ts`,
the M27 figure) and saves back `markup_pct: 0`, so amounts do not move; the
API column, `computeLineAmount` and the AI draft's `markup_pct` are
unchanged (the fold shows the AI's marked-up rate). **Labor:** picking the
Labor type on a line with a blank description fills "Labor tech N"
(`nextLaborDescription`: the section's other labor lines + 1).

**A payment that goes over asks for a reason** (migration 0107, Elise
2026-10-28; `paymentOverage` / `paymentOverageSentence` /
`mayDecideOverQuote` in shared `moneyGuards.ts`, `tests/payment-overage.test.ts`).
Before 0107 a request that took Cost past the NTE or the approved quote was
filed (an OM's under $500 even auto-approved) and the hold appeared only at
the first Approve / Pay. Now `createPaymentRequest` (and `updatePaymentRequest`
on a new amount) asks `overageFor` — Cost + this amount against the NTE less an
approved override's `covers`, and against the approved quote's price / cost
side less an approved over-quote's — and, when over, refuses with **409
`PAYMENT_OVERAGE_REASON`** (`details.over_nte`, `over_quote`, `projected`)
until `overage_reason` (≥ `OVERAGE_REASON_MIN` 5 chars) is sent. The Request
payment form catches it and opens `OverageReasonDialog`; submitting resends
with the reason. With it the request is filed `requested` (never
auto-approved), the reason is stored on `payment_request.overage_reason`
(Payables row, Payments queue) and, after the commit, `raiseOverageHolds`
raises / refreshes the `nte_override` and / or `over_quote` task with
`detail.reason` + `requested_by` — the Approvals inbox prints them on the row
and in the decision dialog (AM and the other `approvals/nte` deciders see the
NTE one). `assertPaymentNotHeld` at Approve / Pay is unchanged and is the
backstop (it copies the row's reason onto a hold it raises). **Over-the-quote
holds are decided by ATL, TL, AM, Admin** (`OVER_QUOTE_DECIDER_ROLES`, a super
admin always) — `requireOverQuoteLevel` refuses approve / reject / claim to
anyone else with 403 `OVER_QUOTE_DECIDER_LEVEL` whatever their Money holds
grant (so never OP Admin), and the inbox draws no decision for them. Rejecting
or deleting a payment now runs `reconcileApprovalTasks`, so its hold is
cancelled ("The payment it was raised for is no longer waiting") instead of
holding every other payment on the work order.

**Dispatchers see payments only inside the work order** (migration 0108, Elise 2026-10-29; `PAYMENTS_PAGE_PERM_KEY` in shared `permissions.ts`, `tests/payments-page.test.ts`). The Payments page has its own path, `payments/page` view ("Payments page" under Payments in Roles; unset follows `payments` view, so no other role changed); `payments` view still opens a work order's Payables. Reads across work orders need the page: `GET /payments` and `GET /payment-requests/:pid` (`requirePaymentsOutsideWo`, which also lets `approvals/payments` view through, since the inbox's Payments lane reads the queue), `GET /vendor-bills` and `GET /vendor-bills/:id`; the sidebar item (`NAV_PERM.Payments`), the `/payments` route and Request payment's **Open Payments** link ask it too. 0108 sets OM, Senior OM and OM Under Probation to `payments` view + create (Elise had switched Payments off for them in Admin › Roles on 2026-10-20/22 as a stopgap), `payments/page` off and `approvals/payments` off. Invoices were already closed to them (0084).

**The Quotes tab stays for the dispatchers** (migration 0111, Elise 2026-10-29; `QUOTES_PAGE_PERM_KEY` in shared `permissions.ts`, `tests/quotes-page.test.ts`). The Quotes page in the sidebar has its own path, `quotes/page` view ("Quotes page" under Quotes in Roles; unset follows `quotes` view); `quotes` view still opens a work order's Quotes tab (the builder). The sidebar item (`NAV_PERM.Quotes`) and the `/quotes` route ask the page; `GET /quotes` still asks `quotes` view (the Approvals lane, Receivables and the search read it). 0111 copies each dispatcher role's old `quotes` view onto `quotes/page` (so their sidebar is as it was), then turns `quotes` view and `work_orders/tabs/quotes` view on for OM, Senior OM and OM Under Probation, and does the same for a dispatcher whose own overrides had Quotes view off.

**Statuses a dispatcher may not even request** (migration 0091, Elise
2026-10-22; `REQUEST_HIDDEN_STATUS_NAMES` / `requestableStatuses` /
`STATUS_REQUEST_HIDDEN_CODE` in `packages/shared/src/workflow.ts`,
`tests/status-request-hidden.test.ts`). The "!!" statuses in ClickUp —
Approved, Waiting for Advice, Waiting for Approval, Ready to Invoice,
Cancelled / Postponed — are a manager's call. `status.request_hidden` (0091)
is the flag per status, drawn as a **Managers only** tick in Admin › Custom
fields › Statuses (`PATCH /admin/workflow/statuses/:id {request_hidden}`,
`admin/fields` edit, in the `status_updated` snapshot); 0091 and `seed.ts`
tick the same five names — keep the three in step. `GET /statuses` carries
`request_hidden`; the status menu in request mode (`work_orders/status`
create without edit) drops them (`requestableStatuses`: the current status
stays, drawn as current) and `requestStatusChange` refuses one with a **409
`STATUS_REQUEST_HIDDEN`** before the gate and the Ecotrak check, so the bulk
bar or a typed call cannot slip one through. Untouched: a manager's direct
move, Send to client (→ Waiting for Approval), the client's approval
(→ Approved) and Cancel on the record bar, which never ask. `moveOnSite`'s
check-in request targets the On Site statuses, which are not hidden; an
admin who hides one gets the 409 printed on the CICO card like any refusal.

**A dispatcher's quote is corrected before it is approved** (migration 0092,
Elise 2026-10-22; `packages/shared/src/quoteSubmit.ts` pure,
`tests/quote-correction.test.ts`). New quote status **`pending_correction`**
between draft and pending approval. `quoteSubmitTarget(role, from)` decides
where Submit goes: a dispatcher's (`isDispatcherRole`) draft → `pending_correction`
and the button reads **Submit for correction**; a manager's draft, or a quote
a manager corrected → `pending_approval` (**Submit for approval**); a
dispatcher cannot submit while the quote waits for correction (403
`QUOTE_CORRECTION_PENDING`). `submitQuote` is the one route for both, stamps
`submitted_by` each time, so the manager who submits for approval is the
maker and D2 asks a second manager to approve; approve is from
`pending_approval` only, reject (back to draft, rev++) also from
`pending_correction`. A quote in `pending_correction` is **edited in place**
(`EDITABLE_STATUSES`; the 0083 #23 return-to-draft stays for
`pending_approval` alone). `Quote.permissions.submit_target` is what the
builder draws the label from (null = locked with the sentence); the pipeline
draws the correction step only while the quote sits in it (`pipelineFor`).
The Quotes page has a **Pending correction** lane; the Approvals › Quotes
lane shows such a row open with **Correct and submit** (a link to the
builder) beside Reject, and the badge counts it. Audit:
`quote_submitted_for_correction`; `quote_submitted` is still the approval
submit, so the `quote_review_owed` clock is unchanged. The AI draft replaces
a quote in this status like a draft.

**One manager approves a quote; the builder's 2026-10-27 trims** (no
migration, Elise 2026-10-27). "1 dispatcher, then 1 manager, then the
client": quotes have NO maker ≠ checker any more. `approveQuote` moves a
quote from draft, pending correction or pending approval
(`QUOTE_APPROVABLE_FROM`; a quote approved from draft takes the approver as
submitter), `assertNotOwnQuote` is gone from approve and send,
`Quote.permissions.self_approval` is always false, and the Quotes list /
Approvals Quotes lane no longer lock on `submitted_by`. In the builder a
person with `quotes` approve sees **Approve** on a draft and on a quote
pending correction (with Reject with note); **Submit for approval** remains
only for a non-dispatcher without the approve grant. The inbox link reads
**Correct and approve**. D2 still holds for payments, vendor bills,
invoices, purchasing and approval tasks. Also: a line added by hand opens
with an EMPTY Type (`DraftLine.line_type` may be `''`; "Type is required"
in `lineErrors`; such a row waits locally like an unnamed one); a proposed
option has its own optional **Tech reported that…** line (its `narrative`,
printed through `reportedSentence` under PROPOSED); the Work Orders and
Vendors **Import** buttons use the new `import` icon (a document with an
arrow going in), `upload` stays for file uploads.

**The client's decline: Challenged or Bill for incurred only** (migration
0109, Elise 2026-10-29; `QuoteDeclineKind` / `quoteDeclineEvent` in shared
`workflow.ts`, `clientDeclineQuote` + `restoreBfiOptions` in
`services/quotes.ts`, `tests/quote-decline-kind.test.ts`). **Record client
decision — declined** asks which. `challenged` is the old decline: work order
→ Waiting for Quote, re-quote in a new round. `bfi` (whole quote only, 400 on
one option) snapshots the quote to `quote_revision_snapshot`, soft-deletes the
round's unapproved options with `quote_section.bfi_removed_at`, so the total
and the invoice prefill are the incurred work. After the commit it ticks
`Bill For Incurred` (before the move, so the Done gate asks for the BFI proof)
and moves the work order to **Done / Incurred** (`client_declined_bfi` event;
a gate refusal rides on `status_move`, the decline stands).
`quote.client_decline_kind` is on `Quote` and `QuoteListItem`; a BFI decline
is in Receivables' Ready lane. **Restore removed options** (`POST
…/quote/restore-options`, `quotes` edit, closed like a new round once the work
order is Done) brings exactly those options back as the next round's draft and
unticks BFI (`quote_bfi_options_restored`).

**Send to client is one click; the client's yes sets the NTE; required
create fields; Received on pre-filled; no Continue** (migration 0102, Elise
2026-10-27). `sendQuote` approves on the way when the quote is still in
draft / pending correction / pending approval (`approveQuote`, its own
`quote_approved` row), then sends; the builder, the Quotes list
(`QuoteDecision`) and Approvals › Quotes draw **Send to client** where they
drew Approve, and the inbox link reads **Correct and send**. The 0083 #23
refusal is gone: a quote above the NTE is sent (`over_nte` stays on the
payload, informational). `clientApproveQuote` then writes the approved
option's grand total into `16. Client NTE 🔴` through
`updateWorkOrderFields` as the recorder (`setNteFromApproval`, after the
commit, never undoes the approval). The client decision may also be recorded
by `QUOTE_CLIENT_DECISION_ROLES` (`oa`) at any time, beside quote approvers
and the dispatchers' Approval-phase rule. **Add work order:** 0102 and
`seed.ts` set `create_mode = 'required'` on `WO_CREATE_REQUIRED_KEYS`
(Comp, Client, FM, Store, Address, City, State, Zip Code, Trade, WO
Description, Date-Time Received, Client NTE — keep the three in step; Admin ›
Custom fields still changes any of them), and the form pre-fills Received on
with the browser's now, editable. **Status requests:** `decide` stamps an
approved `status_change` acknowledged (by its requester) as it approves, so
no Continue; 0102 back-fills the approved ones on file; the header chip draws
nothing for an approval. Rejections still wait for Understood.
**Deciding (same day, no migration):** an open request's header chip offers
**Approve** / **Reject** to a manager (`approvals/status` approve, not their
own ask) and **Withdraw** to the requester; the inbox has no **Claim**
button (the route stays); approving any task is one click with no note,
except a status change INTO a status in `APPROVAL_NOTE_STATUS_NAMES`
(Approved — `statusApprovalNeedsNote` in shared `workflow.ts`), which asks
"How did the client approve?" and the API refuses without
(400 `STATUS_APPROVAL_NOTE_REQUIRED`); Accept asks only the dispatcher.

**What a quote opens with, and the builder's trims** (no migration, Elise
2026-10-22; `packages/shared/src/quoteDefaults.ts` pure,
`tests/quote-defaults.test.ts`). `createQuote` inserts the Incurred section
AND one option (position 1) — one option is already open, the button reads
**Add another option** once one exists — each with the five default
"Required is to…" lines (`defaultScopeLines`: "Full inspection of the
working area", three blanks, "Clean the working area") and a **Trip**
service line (`QUOTE_DEFAULT_TRIP_DESCRIPTION`) at the labor-rate card's
trip rate (`findLaborRate`, same card as `labor_rate`; 0 = blank in the
builder). The builder's `blankOption(round, tripRate)` opens the next option
the same. **Blank scope lines are stored** (the route schema allows `''`,
the web sends them trimmed) so a reload shows the list as it was left;
everything that prints the list — `buildAutoSummary`, the print page —
reads `visibleScopeLines`; the gates (`quoteSectionsHaveData`) already
counted non-blank lines only, so a fresh quote now passes "has data" (a
Trip line is a real charge — accepted). `insertScopeLine` is **Add scope
line**: above the last line, so the closing line stays last. The AI
draft's "quote already holds content" test (`quoteState` in `aiQuote.ts`)
ignores the two default texts and a line named Trip. **A lone option has
no letter and no name** (`optionDisplayLabel(label, count)` → "Proposed";
`sole` on `OptionCard`, `quoteProblems` asks for a name only with two or
more, the summary prints "PROPOSED" / "Grand total" / "GRAND TOTAL" with
no letter, the print page "Proposed work"). The option's narrative box is
gone: its "required is to…" is the same `ScopeList` as Incurred on
`scope_lines` (a narrative on file — older quote, AI draft — shows
read-only). **Tech reported that…** is one line that grows (`fld-grow`,
`reportRef`). **Required fields paint red only after a Submit attempt**
(`focusFirstProblem` sets `showErrors`; the `onBlur` is gone). **No UOM
column** (the value still rides on the line and saves back unchanged) and
**no Day column** unless a section's **Multi-day job** link is pressed or
a line already sits past Day 1 (`linesSpanDays`); every line saves `day =
1` (`QUOTE_DEFAULT_DAY`; the summary groups "Day N" only past day 1, as
before). The Summary card has **no Edit text**: the text is always the
generated one; a quote pinned earlier keeps its refresh control.
**Reset quote** (2026-10-27, Elise; builder header while editable, behind
a confirm): `resetDraft` in `lib/quoteDraft.ts` puts the form back to a new
quote (Incurred + one option, default scope lines, Trip line; specs, note,
pinned summary, Cost TBD cleared), keeping locked sections, sales tax, total
rule and the document fields. Client-side only — the autosave saves it, so it
is an ordinary `quote_updated` row.

**Probation cannot change the Client or the FM** (migration 0093, Elise
2026-10-22; `PROBATION_LOCKED_FIELD_PATHS` / `PROBATION_FIELD_LOCKED_ROLES`
in `packages/shared/src/workflow.ts`, `tests/snooze-requests.test.ts`). A
permission, not code, like the 0039 Assignee lock: 0093 sets `fields.Client`
and `fields.22. FM` (section `client`) to edit false for `om_probation`
only, so `assertFieldWrites` refuses the write and the editor draws them
read-only; OM and Senior OM keep the edit. Its own list because the wave-c
test pins `DISPATCHER_LOCKED_FIELD_PATHS` to 0085's file. Loosen it in
Admin › Roles or per person with Adjust. **Since 0097 (Elise, 2026-10-27)
no dispatcher changes them:** OM and Senior OM get the same two paths
(`CLIENT_FM_LOCKED_ROLES` = the three dispatcher tiers). Raising a work
order is not changing it, so `POST /work-orders` skips the edit check for
`CREATE_FILLABLE_FIELD_KEYS` (Client, FM) when the person can SEE the field
(`fillableOnCreate` + `canViewField`) — before that, probation's Add work
order was refused on a Client. The field editor, bulk edit and the import
still refuse.

**Snooze as a request** (no migration, Elise 2026-10-22; shared
`snoozeMode` / `SNOOZE_PERM_KEY` / `SnoozeRequestDetail` /
`ObligationSnoozeRequest` in `index.ts`, `services/obligations.ts`
`requestSnooze` / `applySnoozeFromRequest` / `snoozeRequestStale`,
`tests/snooze-requests.test.ts`). The fifth kind riding the approval-task
table: a Pulse snooze by someone without **`approvals/snooze` approve**
(a new inbox section, unset inherits `approvals`, so the managers who
decide the inbox snooze directly and the dispatcher tiers, VR Officer and OP
Admin ask) raises a `snooze_request` task on the clock's work order (same
bounds, reason and rule-8.5 scope as a direct snooze; a clock with no work
order is refused — nowhere to raise it; the tier-3 leadership rule is not
asked, the approver is the leadership). `POST /obligations/:id/snooze`
answers `{obligation, requested: true, approval_task_id}` and nothing
moves: the obligation carries `snooze_request` (hours, reason, who, when;
a correlated subselect in `OBLIGATION_SELECT`) and the Pulse card, the
Watching row and the work order's Obligations card read "Snooze requested"
with the button disabled; the dialog's button reads **Request snooze**.
`decide` approves it in the **Snooze requests** lane (`approvals/snooze`
approve; maker ≠ checker as every task), refusing one whose clock has
since been resolved or snoozed directly (409 `SNOOZE_REQUEST_STALE`) and,
after the commit, applying the snooze as the manager's act (`snoozed_by` =
the approver, the requester's reason; the `obligation_snoozed` row carries
`via: 'approval_task'`, the task id and the requester) and re-running the
evaluator. `reconcileApprovalTasks` cancels a stale one with the reason.
One open request per work order (`createApprovalTask`'s one-open-per-type,
a repeat replaces it and becomes the asker's, as a status request does).
The audit rows are the task's own (`approval_task_*`) plus
`obligation_snoozed`.

**Profitability exception, Penalties, Unassigned, reassign from the top,
one-click status approval** (migration 0094, Elise 2026-10-22;
`packages/shared/src/managerFlags.ts` + `unassigned.ts` pure,
`tests/manager-flags.test.ts`). **Finances** gains two custom fields,
`Profitability Exception` (checkbox) and `Profitability Exception Notes`
(long text, drawn as "Manager notes"), as rows on the Finances card
(`MoneyCard`) under Discount. **Penalties** is a new `FIELD_SECTIONS` section
(slug `penalties`, permission path `work_orders/fields/penalties`): `12. Bad
quote` MOVED there from AR (its permission path changed), beside the new
`Penalty`, `Late Quote`, `Missed ETA`, `Recall` (checkboxes) and `Penalty
Description` ("Manager description"); `CLIENT_UNSAFE_SECTION_SLUGS` lists it.
0094 inserts the seven rows (seed.ts carries the same — keep in step) and sets
edit false for `MANAGER_FLAG_LOCKED_ROLES` (the dispatcher tiers, vr_officer,
oa) on the section and the two Finances paths. **Incoming › Unassigned**
(`components/UnassignedSection.tsx`, `approvals/intake` view; since
2026-10-27 a section under the To accept queue on `/incoming` itself, not a
tab — `/incoming/unassigned` redirects there and `IncomingTabs` is back to
To accept · Drafts): the ordinary `/work-orders` list under `unassignedWorkFilter()`
(`fields.Assignee` is_not_set AND status_group in open / active / pending,
oldest received first, `UNASSIGNED_LIST_CAP` 500), scoped like any list, with
**Assign** per row for whoever may edit the Assignee field. **Reassign /
unassign from the header**: the assignee chip in `WoHeader` is a button for
the same people and opens `components/wo/AssignDialog.tsx` (the Accept
flow's dispatcher picker, no note) with **Reassign** and **Unassign**; both
are a plain `fields.Assignee` save through `useWoFieldSave` (null clears),
so the audit row, the mirror columns, `assertDispatchers`, the 11.1.1 gate
and the scope apply as on the People tab. Nothing raises an acceptance task
on unassign: the Unassigned tab is where such a work order shows.
**Approving a status change in the inbox is one click** — the row already
says from and to; the confirm dialog and the note are gone for
`status_change` (like a payment since 0090); Reject still asks the reason.

**Account team per client and Comp; the Add work order form regrouped**
(migration 0096, Elise 2026-10-27; `packages/shared/src/clientTeams.ts` pure,
`services/clientTeams.ts`, `routes/clientTeams.ts`,
`components/portfolio/ClientTeamCard.tsx`, `tests/client-teams.test.ts`).
Who leads a client depends on which of our companies bills it (PH has a team
under BKR, AF, TPM and RF), so `client_team` is one row per (client, Comp):
Team Lead, Assistant Team Lead, salesperson, Account Manager, edited on
**Clients › a client › Account team** (`clients` view / edit; one team per
Comp, 409 on a second; logged on the client as `client_team_added|updated|
removed`). No FK to principal (`updated_by` plain uuid) and the seed truncates
neither `client` nor `client_team`, so the teams survive a re-seed; 0096 also
creates a client record for every client on Elise's sheet and loads the sheet
(TPM / PRS appeared twice, the first row kept). Names are stored as typed
(first names; "House" = no salesperson); `resolvePersonName` turns one into an
active account's display name only when exactly one person answers to it; a
name nobody matches is written on the work order as typed (Elise, 2026-10-27:
the leads show before they have accounts) and flagged on the card, never
guessed into someone else's account. The Clients list draws the teams as
Comp, AM, TL and ATL columns, one line per Comp (`GET /client-teams`; the
old Account manager column, the client record's own field, left the list).
Since 2026-10-27 those cells (Sales included) edit in place for `clients`
edit (`components/portfolio/ClientTeamCells.tsx`: click a name, or **+ Comp**;
the overview also returns `billing_entities`, `people`, `people_by_seat` and
`can_edit` for it) and **Add client** takes the first team, saved by the same
POST right after the client (a refused team keeps the dialog open with
**Open the client**). **The form:** the first section is Client (`21. Comp`,
`Client`, `Client Portal Type`, `22. FM`, drawn in that order); Money is the
NTE alone; People is AM, TL, ATL and the Assignee seat drawn as
**Dispatcher** (always picked by hand, with Who's available?). AM / TL / ATL
fill from `pickClientTeam` (the team for the Comp, or a client's only team,
which also fills an empty Comp) while empty or still holding what the team
put there, and `createWorkOrder` fills the three again when the form left
them empty (`fillFromClientTeam`, after `validateBagValues`). 0096 adds the
`ATL` field (users, People section) and declares `TL`, both on the form —
seed.ts and `WO_CREATE_DEFAULT_KEYS` carry the same, keep in step. Sales is
stored but writes no work-order field (the `Sales Owner` dropdown is
separate). Only the create form fills: intake drafts, the CSV import and the
Ecotrak ingest do not.

**AM / TL / ATL list only their role; check-in method per client and Comp**
(migration 0100, Elise 2026-10-27; `packages/shared/src/clientCico.ts`,
`services/clientCico.ts`, `components/portfolio/ClientCicoCard.tsx`,
`tests/client-cico.test.ts`). **Seats:** `CLIENT_TEAM_SEAT_ROLE` /
`seatRoleForField` / `seatNames` in shared `clientTeams.ts` — the AM picker
offers only role `am`, TL only `tl`, ATL only `atl`: the catalogue options of
`fields.AM|TL|ATL` (`customDistinctOptions`; a name on a work order that is no
active account stays reachable, an account in another role does not), the Add
work order selects, the Account team card's suggestions
(`people_by_seat`) and the client record's Account manager
(`ClientsListResponse.account_managers`). A team name now resolves among that
seat's role only (`clientTeamValues` takes `TeamNames`). UI only: the API
still accepts any name in those fields, because the team sheet's names are
written as typed before the leads have accounts. **Check-in method:**
`client_cico_method` is one row per (client, Comp) — method, portal (Portal
only), detail, email — loaded by 0100 from the operation's "CICO methods"
sheet (79 rows; for a non-Portal method the sheet's portal column is put in
front of the detail, "Service Channel · (516) 500-7776"; EcoTrack → Ecotrak)
and edited on **Clients › a client › Check-in method** (`clients` view /
edit, `/clients/:id/cico`, logged `client_cico_added|updated|removed` on the
client). `methodForTask` in `visits.ts` reads the row for the work order's
Client + Comp first (`cicoForClient`, `pickClientTeam`'s matching: a client
with one row uses it while the Comp is blank), else the FM table as before;
an Email row with no detail shows its mailbox. `WoVisitsResponse` carries
`default_method_from` ("PH · BKR" / "FM Powerhouse") and `client`, which the
CICO composer prints. The seed truncates neither `client` nor the new table.
Where the sheet and 0099 disagree (the Service Channel clients: IVR on the
sheet, Portal in 0099's FM rows) the client row wins.

**Client Portal Type follows the client; 7-Eleven** (migration 0113, Elise
2026-10-30; `portalTypeFromCico` / `portalTypeOption` in shared
`clientCico.ts`, `tests/client-portal-type.test.ts`). The dropdown gains
`7-Eleven` (seed.ts in step). The field fills from the client's check-in row
for the Client + Comp (`pickClientTeam`'s matching): a Portal row's portal,
else the portal in front of an IVR detail ("Service Channel · …"), written
only when it names an option of the dropdown (aliases: 7-11 / 7 Eleven,
EcoTrack, Service Channel) — so adding "Metryx" to the list in Admin › Custom
fields is enough for PH to fill. On Add work order (`client_portal_types` on
the form payload; only while empty or still the fill's own value), on create
(`fillPortalType`, when empty) and when an edit changes the Client or the
Comp (`refillPortalTypeOnEdit`: empty or still the old client's value, never
one the same save set; logged with the team fills, `via: 'client_team'`).
Nothing back-filled; bulk edit, the import and the Ecotrak ingest do not fill.

**Client follows the Comp; the team follows an edit; FM off the form; a
closed form is a draft; Pulse and Dashboard parked for Version 2** (migration
0103, Elise 2026-10-27; `tests/client-comp-team-edit.test.ts`). **FM = the
Client** under ClickUp's spelling ("Powerhouse" for PH), so 0103 sets `22. FM`
`create_mode` off (`WO_CREATE_DEFAULT_KEYS` / `WO_CREATE_REQUIRED_KEYS` /
the identity section no longer list it — seed in step) and
`INTAKE_REQUIRED_FIELDS` asks for `Client` in FM's place (`intakeMissing`
accepts `task.client`; `INTAKE_DRAFT_EXTRA_REQUIRED` is now empty). FM stays
on the record for ClickUp and the check-in fallback; since 2026-10-30 the work
order page no longer draws it (All fields skips `fields.22. FM`, the Site card
lost its "FM company" line; the key keeps its permission path in
`FIELD_SECTIONS`). **Client options carry
`comps`** (`WoFieldOption.comps`, `clientCompsByName` in `woFields.ts`: every
billing entity the client has a `client_team` or `client_cico_method` row
under) and `clientOptionsForComp` narrows the Client picker on Add work order
and in the field editor (`FieldEditContext.comp`, from `woCompForPicker`: the `21. Comp` field,
else `billing_entity`) to the chosen Comp; no Comp,
or a Comp nobody is filed under, offers everyone, the current value always
stays; UI only, the API takes any client on file. **Editing Client or Comp**
in `updateWorkOrderFields` runs `refillTeamOnEdit` → `refillFromClientTeam`
(shared, pure): AM / TL / ATL that are empty or still hold the OLD team's
name take the new team's (a seat the new team leaves blank is cleared, a
hand-picked name and a seat the same save set are kept), an empty Comp is
filled from a one-team client; logged `via: 'client_team'`. Since 2026-10-28 (Elise: "FM and
Client are the same thing") Sales Owner follows too (`salesOwnerFromTeam`,
the dropdown's options), and an FM edit that names an active client record
(`clientForFm`, `lower(btrim())`) sets the Client in the same save, then
refills; an FM spelled the ClickUp way ("Powerhouse") names no record and
moves nothing. Bulk edit does not refill. **Add work order** closed by the ✕ or the scrim files what was
typed as an intake draft (`dismiss`, needs `intake` create; an untouched form
just closes); **Cancel** discards. **Version 2**: `apps/web/src/lib/
versionTwo.ts` `VERSION_TWO_SECTIONS` (Dashboard, Pulse) dims the sidebar item
(`.is-v2`, a V2 tag) and `VersionTwo` in `App.tsx` answers its route with a
"coming in Version 2" screen; pages, API and permissions are untouched —
remove a name from the list to reopen it. The bell still shows Pulse notices,
and the Sales role (Dashboard only) sees just the V2 screen.

**"Assigned to you" in the bell** (Elise, 2026-10-30, no migration;
`services/assignmentNotices.ts`, `WO_ASSIGNED_NOTICE_KIND` /
`assignedNoticeTitle` in shared `dataQuality.ts`,
`tests/assignment-notice.test.ts`). `dispatchAutomations` (every write path
reports there after its commit) calls `notifyAssignment`: each name ADDED to
the Assignee seat (`addedAssignees`; on a `created` event every name) that is
an active human gets an `app_notice` of kind `wo_assigned` — "<who> assigned
you <WO #>" (a rule or a service: "<WO #> was assigned to you"), body = the
title, link `/work-orders/<WO #>`. The assigner is skipped (`notify`'s
actorId, read off the newest audit row that set the seat), and `notify` now
takes a `dedupeKey` (0059's unique index) — keyed by that audit row, so one
assignment is one notice. Never throws.

**No work order goes to a disabled account** (Elise, 2026-10-23, no
migration; `tests/assignee-disabled.test.ts`). The person paths already
refused one through `assertDispatchers` (`status <> 'disabled'`). The paths
that skip the dispatcher check now ask `assertNoDisabledAssignees` /
`disabledAssigneeKeys` (`services/dataRules.ts`; a name is disabled when
every account of that display name is), 400 `ASSIGNEE_DISABLED`: a rule's own
write and the PM raise in `updateWorkOrderFields` (the engine records the
errored run; the PM raise catches it and leaves the work order unassigned,
for Incoming › Unassigned), and the CSV import (whole file refused, rows in
`details.wo_numbers`). Only a name ADDED to the seat is asked, so work orders
already held by someone who is then disabled stay as they are.

**Completion Assignee is AR only** (Elise, 2026-10-30, no migration;
`COMPLETION_ASSIGNEE_*` / `ROLE_LIMITED_PERSON_FIELDS` in shared
`dataQuality.ts`, `tests/completion-assignee-ar.test.ts`). The field's
options (field editor, bulk edit, filters, Add work order) list only active
users with role `ar` (`customDistinctOptions`, like the AM / TL / ATL seats; a
name on a work order that is no account stays reachable). A name ADDED to it
by a person is checked by `assertCompletionAssignees` (`dataRules.ts`, 400
`COMPLETION_ASSIGNEE_NOT_AR`) in the field editor, bulk edit and Add work
order; a rule's own write is asked only that the account is not disabled.
Values already on file are not re-checked; the CSV import is not asked.

**Tech Hub: technicians off the client conversation** (migration 0095,
Elise 2026-10-27; `callSide` / `TECH_HUB_TAB` in `packages/shared/src/
calls.ts`, `components/wo/tech/TechTextsCard.tsx`, `tests/tech-hub.test.ts`).
People › Technicians became the **Tech Hub** tab (id still `technicians`, so
old `?tab=technicians` links open it): Responsible vendor, Suggested vendors,
Technicians (map, Hire), **Technician calls** (`CallsCard side="tech"`: Call
technician, Just call / Call and draft a quote, the AI draft link), the Quo
**Technician texts** with the technician rail (`MessagesRail`, the
`is-messages` grid class moved with it) and Dispatch offers. Messages keeps
the team / client thread and **Client calls** (`side="client"`: Call client,
a typed name and number — the client's IVR is NOT offered, Elise's call for
now — always purpose `call`, no AI draft). One `wo_call` list feeds both;
`callSide` puts a call on Messages only when `contact_role = 'client'` AND
`purpose = 'call'` (a quote call or an imported transcript is Tech Hub's,
where its draft lives). Nothing on the API refuses a client quote call: the
split is the UI's. Tech Hub has its own permission row
`work_orders/tabs/technicians` (`WO_TABS`, Admin › Roles); 0095 copies each
role's and each person's People row onto it where set, so nobody gained or
lost the tab. `GET|POST /work-orders/:id/messages/quo` now need the Tech Hub
tab (they needed Messages); the page reads the thread through
`getWorkOrderQuoMessages` under `['wo-quo', id]` (the TextComposer's
optimistic write targets that shape). `GET /messages` still carries `quo`,
unread by the web. The AI review page's back links go to Tech Hub.

**Prices** (migration 0101, Elise 2026-10-27; `packages/shared/src/prices.ts`
pure, `services/prices.ts`, `routes/prices.ts`, `pages/PricesPage.tsx`,
`styles/prices.css`, `tests/prices.test.ts`). The "Prices & quotes library"
sheet's five Price List tabs as records (its Quote Library / Quote Archive
tabs were not loaded): one `price_card` per (billing entity, client) — the
entity's **Standard** card has no client — with trip, materials markup (the
multiplier, "Up to ×1.3"), a note, its `price_rate` rows (a label as the sheet
wrote it plus the work-order Trade values it prices; tech / helper /
after-hours / holiday, and a trip of its own where the sheet gave one per
trade) and its `price_fee` rows (an amount, or the price as written:
"$350-550"). A client card states only what differs: `resolvePrice` takes a
trade it does not list, and a blank trip / markup, from the Standard card; a
row's own trip wins. One card per entity + client (409 `PRICE_CARD_EXISTS`),
a trade on one row per card, a fee needs an amount or a note
(`priceCardProblems`, 400). Clients are text matched by `lower(btrim())`, no
FK; a card for a name with no client record is kept and drawn **No client
record** (13 of the sheet's: BW, TCG, JDE, BrandPoint, Front Street, DWM,
TFG, Addilan, KBS, Ed Shelman, Pet Supermarket, GRM, MaintainX). Sheet names
were mapped to the records' spelling (Powerhouse = PH, RSM = RSM LEO,
Outback Steakhouse = the record's "Outback Staekhouse", SUN HOLDING / RMH =
two cards). Page: one tab per Comp, Search client, Every trade (a client card
with no row for the picked trade shows the Standard one). Permission path
`prices` (view / create / edit / delete): 0101 gives all four to the admin
role and view to every role that views quotes. 0110 adds view / create / edit
for oa, atl, tl and am (delete stays admin's). Audit `price_card_created|
updated|deleted` (entity `price_card`, whole snapshots). **The quote builder
reads it**: `findLaborRate` (services/rates.ts) asks `priceFor` first and a
figure the list gives wins, so a new quote's Trip line opens at the card's
trip; the Yoda `labor_rate` row fills the rest and still decides "sales tax
required". The assistant can read it (`prices` in `RESOURCES`). No FK to
principal and the seed truncates none of the three tables, so the list
survives a re-seed; no seed twin. The migration's INSERTs were generated from
the workbook (stable uuid5 ids); a re-import is a new migration.

**Sales on Add work order, the two flags at intake, Mark as Emergency**
(migration 0104, Elise 2026-10-27). `Sales Owner` offers Kevin and House
(appended to the dropdown's options when missing; seed.ts's CURATED_FIELDS
carries the same list — keep in step). Add work order shows `Sales Owner` in
People (after ATL) and a **Flags** section with the `Emergency` and
`Escalated` ticks (`WO_CREATE_DEFAULT_KEYS` / `WO_CREATE_SECTIONS`, 0104 sets
the three `optional`). The form fills Sales Owner from the account team's
salesperson when the dropdown offers that name (`salesOwnerFromTeam` in shared
`clientTeams.ts`; browser only — the API's `fillFromClientTeam` still fills
AM / TL / ATL alone). A tick the person may not set (Escalated for the
dispatchers, 0038) is drawn locked, since `assertFieldWrites` would refuse it.
The header has **Emergency** (was Mark as Emergency) beside **Escalation** (`WoHeader`,
the field's edit permission, red `.btn.is-emergency`).

**Sales is a dropdown of the salespeople** (migration 0105, Elise
2026-10-28). The Sales seat of an account team (Clients list cell, the
client's Account team card, Add client) is `SalesSelect`
(`components/portfolio/ClientTeamCells.tsx`), whose names are the `Sales
Owner` field's options (`salespeople` on `ClientTeamsResponse` /
`ClientTeamsOverview`; House always among them). 0105 renames ClickUp's "Ro"
to "Rocio" in place and appends Teresa / Kevin / House when missing (seed.ts
and `SALES_OWNER_DEFAULT_OPTIONS` carry the same — keep in step); work orders
already holding "Ro" keep it. **+ Add someone…** turns the dropdown into a
box; saving a team with a name the list lacks appends it to the Sales Owner
options (`addSalesperson` in `services/clientTeams.ts`, logged
`field_def_updated` with `via: 'client_team'`), so the list grows from there
or from Admin › Custom fields. ClickUp has no "Rocio" option: a pushed Rocio
is a remembered value error until ClickUp's list is renamed too.

**From client on the Drive tab; Zip Code digits only** (migration 0106,
Elise 2026-10-28; `tests/zip-and-client-files.test.ts`). A fifth attachment
kind, `client` ("From client", `ATTACHMENT_KINDS`): what the client shared
with us, picked in the viewer's **What is it?** like the others and drawn as
a fourth Drive column after Before · After · Sign-off (any file type, like a
sign-off). It is not proof of work: the Done gate never reads it. 0106
replaces the 0061 CHECK with a named `attachment_kind_check`; the review
route's zod enum carries the same list — keep the three in step. **Zip
Code** takes 5 digits or ZIP+4: `normalizeZip` (shared `addressParts.ts`) in
`checkFieldValue` refuses anything else (400 `VALIDATION`, nine bare digits
get their dash), and the Add work order, draft, inline-editor and (since
2026-10-30) bulk-edit and site ZIP boxes run `zipInputValue` on every
keystroke so letters never get in; a site's ZIP is checked by `normalizeZip`
in `checkSiteInput` too. Stored values are not re-checked.

**The quote at the top of the builder** (no migration, Elise 2026-10-28). The
quote builder (its page and the work order's Quotes tab) opens with a **Quote**
card drawn from the SAVED quote, so it follows each autosave ("Updating after
the save…" while one is pending). It reads as plain text by default — the
summary the client gets (`summary.pinned ?? summary.auto`, with a copy
button) — and a **Text** / **Client view** switch shows the client's document
instead (`QuoteDocument`, exported from `QuotePrintPage.tsx`, which renders it
under its print bar); the choice is remembered per browser
(`theone.quote.preview`). **PDF** opens the print page in a new tab with
`?pdf=1`, which opens the print dialog once the document has drawn. **Share
with client** is drawn locked ("not decided yet") until Elise picks how quotes
reach clients. The body scrolls inside the card (`.qpreview-body`, max 70vh)
and the card is hidden in print.

## Verify

```
npm run typecheck                     # from app/: tsc over shared, db, api, worker and web (tsc -b); 0 errors
npm test                              # vitest over tests/**/*.test.ts, hermetic (tests/setup.ts), opens no database
npm -w @theone/web run build          # tsc -b && vite build: the bundle Vercel deploys
curl -s http://127.0.0.1:5174/api/health                      # {"ok":true,"auth_mode":"bypass"}
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/api/work-orders   # 401 without a session
```

- Every workspace has a `tsconfig.json`; `npm run typecheck` covers all five
  (`packages/shared`, `packages/db`, `apps/api`, `apps/worker`, `apps/web`) and
  passes with 0 errors. CI (`.github/workflows/ci.yml`, job "typecheck + test")
  runs it and `npm test` on every push; it is green only because
  `tests/setup.ts` sets the environment and `config.ts` skips `app/.env` under
  `VITEST`, so never let a test depend on a developer's `.env`.
- The vitest suite under `app/tests/` (65 files, 1171 tests, 6 skipped, on 2026-10-20) is
  the regression net: pure functions and source-text pins, no database and no
  network, so a SQL change still needs a seeded local Postgres, curl and
  headless Chromium screenshots of both themes before it is believed.
- Dev-bypass smoke test: `POST /api/auth/dev-login {"principal_id":"<id>"}`
  (ids from `GET /api/auth/dev-candidates`), keep the cookie, then hit
  `/api/auth/me`, `/api/work-orders`, `/api/admin/users` (403 unless super admin).

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
- Vendors is live (0056 to 0059, 0066, 0069: records, map, workflow, portal);
  the VR - CRM parity items still open are listed at the end of its paragraphs
  above. Invoicing is live since 0045 (Receivables › Invoicing); vendor bills
  since 0047 (Payments › Vendor bills). Receivables › Audit is a browser-side
  prototype (W2-1); since UAT Wave D (M23) it is hidden and Receivables opens
  on Invoicing.
- React Router prints v7 future-flag warnings in the console; harmless.
- `public/brand/logo-the-one-2.png` is an unused leftover of the previous
  logo (committed for safekeeping, referenced nowhere) — safe to delete.
- Product roadmap and open decisions: `product/feature-roadmap.md` (§ "Standing
  risks / open decisions").

## Branches

`phase-0-ground` is the line of record: every migration from 0004 on, the move
to node-postgres and the 2026-10-14 audit batch live there. `main` diverged
from it at `3226570` and carries 48 commits of its own, with migrations 0004
to 0027 under different file names, so the two histories do not fast-forward
and the filename-keyed `_migrations` ledger reads differently on each.
`origin/Primary-Updates*` are earlier review batches. FIX-RUNBOOK.md at the
repo root (W3-6, W6-9) has the order: read the production ledger, reset `main`
to `phase-0-ground`, then protect `main` (pull request, CI green, one review).

## Agent skills

### Issue tracker

GitHub issues on `VistaJordan/TheOne`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default labels, unchanged: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`, created lazily by `/domain-modeling`. See `docs/agents/domain.md`.

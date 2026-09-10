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

**Quote clock and the Due Today view** (migration 0030, rules 2.3.1–2.3.3 and
4.1). `Quote Due Date` is a **computed** bag field: the latest *Assessment*
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
under it the status-group segment becomes All · Due date · Scheduled · Quote ·
Parts arriving, each a filter on "today" (`businessDay()`); Quote is *today or
earlier* AND status still before Quote Ready (`isQuoteOwed`, phases Intake /
Assessment / Quote), so a missed quote does not vanish the next day. The
sections are OR groups in the filter compiler's join mode and the quick-filter
chips are ANDed into every group; the Filter menu is hidden there. The list
cell, the Dates card and the CICO summary turn the date red only while the
quote is still owed (`lib/quoteDue.ts`). Holidays: Admin › Settings card,
`/api/admin/holidays` (grant `admin/settings` edit), seeded with US federal
observed dates for 2026–27 by the migration; the table is **not** truncated
by the seed (configuration, no FKs — the 0012 reasoning). Deferred: record-level
scoping of the view per user (rule 8.5) and whether the other three sections
include overdue rows; on phase-0-ground the Pulse's `quote_owed` clock still
starts at Waiting for Quote and should be rewired to this field after merge.

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
- Vendors and Invoicing appear in the sidebar but are inert placeholders.
- React Router prints v7 future-flag warnings in the console; harmless.
- `public/brand/logo-the-one-2.png` is an unused leftover of the previous
  logo (committed for safekeeping, referenced nowhere) — safe to delete.
- Product roadmap and open decisions: `product/feature-roadmap.md` (§ "Standing
  risks / open decisions").

## Branches

`main` = last reviewed state. Work lands on `Primary-Updates*` branches, one
per review batch; each is frozen once it is up for review and the next batch
starts from it, so PRs fast-forward in order.

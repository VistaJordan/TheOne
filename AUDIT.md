# Audit: The One

Date: 2026-10-14. Branch audited: `phase-0-ground` at `00c7c53`. All paths are relative to `app/` unless marked as repo root.

## Bottom line

No, The One is not spaghetti. It is a large system, about 126,000 lines across the API, the web app and the shared package, and for the most part it is layered the way it says it is: thin routes over services, one error type and one error handler, one permission resolver used by both the API and the browser, and parameterised SQL everywhere we looked. The trouble is concentrated in four places, and they are specific enough to fix one at a time. First, the work-order write core (status moves, field writes, automations, approvals, quotes, sign-off) calls itself in six hidden import cycles and wires its after-commit steps by hand at each call site, and those call sites have drifted. Second, the data layer still behaves as if it had PGlite's single connection, although production runs on pooled Postgres at Neon, so whole-bag writes can lose each other's changes and several multi-step writes have no transaction. Third, authorization after sign-in is a convention: every handler must remember permission, scope and field redaction separately, and several families forget one of them. Fourth, correctness rests on hand-kept copies of the same rule in migrations, seed, shared, API and web. The weakest part is not the code but the process around it: CI has been red for 8 days, no branch is protected, there is one PR in 146 commits, the GitHub repo is public and tracks raw ClickUp exports, and CLAUDE.md is wrong about the database, the tests and the typecheck. One feature is confirmed broken today: the Pulse / obligations engine. One past exposure is confirmed: a password-less production sign-in existed for at least about three days around 2026-09-01. Neither is a sign of a rotten codebase; both are signs of a fast team without guard rails.

## Overview

### Size

| Part | Size |
|---|---|
| API (`apps/api/src`) | about 50,000 lines, 83 service files, 40 route files |
| Web (`apps/web/src`) | about 59,500 lines, 203 files (169 `.tsx`), 14,437 lines of CSS |
| Shared (`packages/shared/src`) | about 16,600 lines, 1,188 exported names |
| Database | 81 migrations (`0001_init.sql` to `0081_clickup_dedupe.sql`), 158 tables locally, 201 indexes |
| Tests | 46 files, 554 passing, 3 skipped, 0 failing locally in 5.7 s |
| Typecheck | `npm run typecheck` covers shared, db, api, worker and web: 0 errors |

### What works well

These are real strengths, found and checked by the Workers, and worth protecting.

- **Routes are thin.** Only 3 of 40 route files contain SQL, 4 statements in total (`apps/api/src/routes/statuses.ts:19`, `apps/api/src/routes/vendors.ts:414`, `apps/api/src/routes/workOrders.ts:527`). Everything else calls services.
- **One error pipeline.** `ApiError` and its helpers are thrown about 976 times and rendered by one handler (`apps/api/src/errors.ts:20-90`). No route sends a 4xx or 5xx by hand. 500s are generic.
- **Parameterised SQL everywhere.** 109 templates with non-trivial interpolation were traced; every one binds values as `$n` or takes identifiers from an allow-list (`apps/api/src/services/woFields.ts:121-146,464-486,538-640`, `apps/api/src/services/vendors.ts:371-374`, `apps/api/src/services/woMetrics.ts:281-285`).
- **Sign-in is sound.** Sessions are server-side rows sent as an httpOnly, SameSite=Lax cookie with a 12 hour TTL; disabling a user revokes on the next request (`apps/api/src/services/auth.ts:276`); OIDC uses PKCE, a one-shot state and a nonce, with JWKS and issuer pinned (`apps/api/src/auth/entra.ts:27,168-177`); permissions are reloaded on every request.
- **Webhook secrets are compared in constant time** (`apps/api/src/lib/webhookAuth.ts:27-33`), an unset secret answers 403, and the vendor-portal token is stored only as a SHA-256 (`apps/api/src/services/vendorPortal.ts:242-252`).
- **Every `/work-orders/:id/*` route resolves scope.** A scripted check over every registration found no handler that skips `resolveTaskId(id, actor)`.
- **Permissions go through one resolver.** `permAllows` in `packages/shared/src/permissions.ts` runs on both sides; the browser reads it through `canFor` (`apps/web/src/auth/AuthProvider.tsx:62-67`).
- **One data-access point in the web app.** Every fetch goes through `request()` (`apps/web/src/api/client.ts:552`). React Query holds server state; context is used only for auth and theme; there is no global store and no serious prop drilling.
- **Chunk splitting holds.** Recharts and MapLibre load only through `lazy()` (`apps/web/src/components/dash/WidgetCard.tsx:42-44`; the map in 4 places, every other file imports its types only).
- **No secrets in git.** Only `.env.example` is tracked; a pickaxe over history found no keys, tokens or passwords; the built API bundle contains none.
- **The assistant cannot write and has no access path of its own.** It calls existing GET routes with the asker's cookie (`apps/api/src/services/assistant.ts:169-178`).
- **Migrations are clean as SQL.** No gaps or duplicates on this branch, enum additions isolated, destructive steps guarded.
- **Many keep-in-step pairs are in step today**: super admins, the custom fields added by migrations, FM to CICO methods (41 rows, zero differences), WO PDF defaults, status aliases. That is diligence, and it has held.

### Broken today versus debt

**Broken today, confirmed:**
- **The Pulse / obligations engine (W3-2).** Every rule query compares `text = uuid` and fails with `ERR 42883`; the error is swallowed, so the engine has produced nothing since migration 0023 merged on 2026-09-01.
- **CI (W6-4).** Red on 24 consecutive pushes since 2026-10-06 because three test files need a developer's `app/.env`.

**Past exposure, confirmed (W4-11):** see Security findings.

**Wrong today with small or bounded impact:** the super-admin escalation path (W4-1), CSV import bypassing scope and the status permission (W4-4), records opened by their own id skipping scope (W4-3), the Receivables Audit screen showing invented facts (W2-1), dead query invalidations (W2-5), the bulk status path missing two post-commit steps (W1-7), the photo checklist contradicting the Photos card (W2-4), the storage switch not covering vendor documents (W5-7), a one-cent quote-to-invoice gap (W5-3).

**Latent, would bite under the right conditions:** lost updates on the jsonb bag (W3-3), the purchasing award race (W1-8), renumbered migrations against a filename ledger (W3-6), a seed with no host guard plus production credentials in every developer's env pull (W3-14, W4-20), delayed automations that never run on Vercel (W6-12).

Everything else is structural debt: size, duplication, naming, stale docs.

## What it is / does

The One is Seamless FM's work-order, quote and vendor-payment platform. A work order arrives from Ecotrak, a CSV import, the intake drafts, the "Add work order" form or a planned-maintenance schedule. It moves through statuses guarded by business-rule gates; dispatchers are scoped to their own book; quotes, payment requests, invoices and vendor bills hang off it; a rules engine raises approval tasks and side effects; integrations push to ClickUp, file to SharePoint, text through Quo and email through Gmail. The web app is React and Vite, the API is Fastify, the database is Postgres over node-postgres with Neon in production, and it deploys to Vercel with four crons. CLAUDE.md is the only architecture map and runs to 1,864 lines.

## Structure & architecture

### API

The API is a services layer behind thin routes. Fan-in is healthy: the most imported modules are leaf utilities such as `permissions` (49 importers), `activity` (40), `adminAudit` (30) and `woFields` (27) (W1-1). The one naming problem there is `services/activity.ts`, which is really request context: it imports `FastifyRequest` (`apps/api/src/services/activity.ts:35-74`), so an HTTP type leaks into the service layer.

**The tangled core.** The real hubs are `workOrders.changeStatus` and `automations.dispatchAutomations` (W1-2). Six import cycles run between `approvals`, `workOrders`, `quotes`, `woFieldValues`, `automations`, `signoff`, `integrations` and `clickup`, hidden by `await import()` (W1-3: `apps/api/src/services/approvals.ts:665,674`, `apps/api/src/services/automations.ts:619-620,701`, `apps/api/src/services/integrations.ts:264`). Dynamic imports are also used where no cycle exists (`apps/api/src/services/woRecord.ts:849-983`), so a reader cannot tell which ones are load-bearing. Nothing runs incorrectly because of this; it makes the core hard to change safely.

**After-commit steps are wired by hand and have drifted.** A single status move (W1-6) commits, then runs automations, maybe `syncInvoicedFromQuote`, another automation pass, `evaluateForTask` and `proposeBillingOnCompletion`, each in its own connection (`apps/api/src/services/workOrders.ts:640-668`). These hops do not agree on whether they may throw: the obligation and billing hops swallow and log, while `syncInvoicedFromQuote` and `getQuoteTotal` propagate. A database failure there returns a 500 for a status move that already happened. Inside the engine, housekeeping (`reconcileApprovalTasks`, assignee history, sign-off) shares one `try` with the rule loop (`apps/api/src/services/automations.ts:707-729`): if housekeeping throws, every rule for that event is skipped with only a `console.error`, and the depth guard returns before housekeeping runs. Putting housekeeping in the engine is a documented, deliberate choice; the cost is a shared failure domain.

The bulk status move reimplements the write (W1-7): `woBulk.bulkUpdate` runs its own `UPDATE` (`apps/api/src/services/woBulk.ts:232-240`) and then only automations and `syncInvoicedFromQuote` (`:309-315`), so a bulk move skips the Ecotrak transition check and its audit stamp, the obligation re-evaluation, and the billing proposals on Done. Status gates do run in bulk. The task `INSERT` itself is copied five times (W5-1, below).

**Transactions predate the pool (W1-8).** `packages/db/src/client.ts:1-6,84-89` says the PGlite constraint "is gone", yet 23 comments still justify reading before the transaction "because PGlite is single-connection" (`apps/api/src/services/woFieldValues.ts:94`, `apps/api/src/services/workOrders.ts:563`, `apps/api/src/services/quotes.ts:14`, `apps/api/src/services/automations.ts:9`). There are 69 `withTransaction` calls in 28 files, 1,284 bare `query(` calls and two `FOR UPDATE` in the whole API. `purchasing.awardQuote` updates quotes, marks the RFQ awarded and creates a PO with no transaction, and its "already awarded" check races (`apps/api/src/services/purchasing.ts:880-898`); line rewrites delete then insert outside a transaction (`apps/api/src/services/purchasing.ts:588-591,1013-1019`, `apps/api/src/services/maintenance.ts:282-287`). `purchasing`, `maintenance`, `vendorWork` and `obligations` contain no transaction at all. The lost-update half of this problem is W3-3.

**Other API debt.** Audit rows are written as raw `INSERT INTO activity_log` in 29 files at about 52 sites beside the helpers (W1-9). About 71 of 116 catches neither rethrow nor log; most are benign, but `apps/api/src/services/woRecord.ts:564` discards a refused status move on Cancel and `apps/api/src/routes/webhooks.ts:91` swallows the dispatch sweep (W1-10). Fifteen functions exceed 150 lines; the real offenders are `importWorkOrders` (342 lines, `apps/api/src/services/woBulk.ts:531`), `collectDesired`, Ecotrak `upsertOne`, `bulkUpdate` and `approvals.decide`; ten files exceed 1,000 lines (W1-5). `resolveTaskId` is called 39 times in routes and 4 in services, so services trust any task id they are given (W1-4). `modules/` is an abandoned second layout used only by Ecotrak and the client-message port, with its own SharePoint path planner beside `services/sharepoint.ts` (W1-12). Error handling is otherwise consistent (W1-11).

### Web

The web app is organised: one fetch point, one permission check, React Query throughout, and working code splitting for the two heavy libraries (W2-9). The debt sits in a few places.

- **Receivables › Audit shows invented data as if real (W2-1, High).** `lib/receivables.ts` builds every Audit row from an FNV hash of the work-order id: BFI, CICO state, client quote, CO#, SharePoint state and photo counts come from `chance(id, ...)`, the assignee from a hard-coded list, the invoice number from a hash (`apps/web/src/lib/receivables.ts:88,97-140,436-441`; its own header says "derived HERE, seeded by the WO id"). The Invoicing "Ready" lane feeds from it (`apps/web/src/components/rcv/InvoicingTab.tsx:47,59,107`). Only a hover tooltip says it is a prototype, and the route has no `RequireCan` (`apps/web/src/App.tsx:244-245`). No money is created from it, because Raise invoice computes the amount on the server, but people can act on fake audit facts.
- **No query-key convention (W2-5).** About 120 distinct key roots and no factory. `['activity']` is invalidated six times and never read; the real key is `['wo-activity', id]` (`apps/web/src/pages/WorkOrderDetailPage.tsx:114`), so hiring a tech, logging time or raising a PO does not refresh an open audit tab. Roles, admin users, automations and prefs each live under two keys and edits invalidate only one. Quote and payment actions do not invalidate the approvals badge.
- **The web keeps its own copy of shared contracts (W2-3).** `api/client.ts` (3,631 lines, 354 exported functions) redeclares 26 types that shared already exports, and every web consumer reads the client copy. For the 12 the API actually uses, shared matches the wire and the web copy is looser, so a server change the compiler enforces never reaches the web. Eleven shared copies are dead, and `SessionUser` and `AdminUserItem` in shared have drifted from the real wire. No runtime bug was shown; the cost is a lost compile-time guarantee.
- **Rules re-derived in the browser (W2-4).** `apps/web/src/lib/woDerive.ts:267-277` groups photos by `client_visible`, the pre-0061 rule, while the Photos card groups by approved kind, so the Soft-close checklist (`apps/web/src/pages/WorkOrderDetailPage.tsx:366`) can contradict the Photos card on the same page. Also local copies of the escalation-exempt statuses, the KPI status names, profit and the NTE trigger, and two `is_super_admin` checks that should be permissions (`GlobalSearch.tsx:85`, `AuditTrail.tsx:45`).
- **Big files (W2-2).** 42 files over 400 lines hold about half the web code. `pages/admin/AdminSections.tsx` is 3,021 lines with five routed pages and a 470-line automation builder; `ApprovalsPage.tsx` is 1,628; `QuoteBuilderPage.tsx` is 1,277 with one 1,100-line component.
- **No route is lazy (W2-6).** The main chunk is 1,968 kB (548 kB gzip) because `apps/web/src/App.tsx:9-52` imports all 40+ pages statically.
- **Route and nav permissions are declared twice (W2-7).** `NAV_PERM` keyed by label (`apps/web/src/components/AppShell.tsx:127-146`) and `RequireCan` per route (`apps/web/src/App.tsx:94-106`) disagree for `/pulse` and `/receivables`.
- **114 hard-coded colours** outside `theme/tokens.css` in about 30 files, and 8 CSS files with their own theme blocks (W2-8).

### Shared contract and keep-in-step copies

This is where most correctness quietly lives. There are at least 12 named keep-in-step pairs, an 8-way status vocabulary, five task inserts, two money arithmetics, two upload paths and three hand-written prose mirrors of the UI (CLAUDE.md, the docs registry, the assistant guide). Only 3 pairs have any automated drift check, and no test reads a migration file. Where authors were careful the copies are in step; drift happened where a copy's author moved on.

- **The task INSERT exists five times (W5-1)**: `apps/api/src/services/intake.ts:386`, `apps/api/src/services/woCreate.ts:411`, `apps/api/src/services/plannedMaintenance.ts:407`, `apps/api/src/services/woBulk.ts:763`, `apps/api/src/modules/integrations/ecotrak/ingest.ts:400`, plus two in the seed. Intake and create are byte-identical, helpers included. Most differences between the copies are documented design; the one undocumented gap is that only the CSV import sets `home_list_id` (`apps/api/src/services/woBulk.ts:782,794`), so work orders from intake, the form and PM fall out of Home-list filters, the `/lists` counts and the Pulse's personal owner. The real fix is one `insertWorkOrder` with after-commit steps declared per source in one table.
- **The WO-number duplicate check diverged (W5-2).** `woCreate` normalises (`apps/api/src/services/woCreate.ts:187,215`); intake (`apps/api/src/services/intake.ts:353`), PM and the import match the raw string. The shared `WO_NUMBER_NORMALIZED_SQL` has no importers. The database UNIQUE still blocks exact repeats; variant spellings slip through.
- **Two money arithmetics (W5-3).** Invoices, vendor bills and proposals compute in integer cents (`packages/shared/src/invoices.ts:145-165`); quotes and purchasing use float `round2` (`apps/api/src/services/quotes.ts:64`). For 1.5 × 99.99 the quote line reads 149.98 and the invoice built from it bills 149.99: one cent more on half-cent lines. The invoice stays editable until sent.
- **Status names are data, and logic keys off them (W5-5)**, while the vocabulary is copied eight times (W5-6). Admin can rename any status (`apps/api/src/services/statusAdmin.ts:132-155`); gates, On-Site moves, acceptance reject, start status, Total Invoiced, Ecotrak push, ClickUp aliases, phases and cancel all look statuses up by name. Renaming "Done / Incurred" would silently switch off the Job-is-Done gate.
- **The storage switch is bypassed (W5-7, W5-16).** `apps/api/src/services/attachments.ts:41-52` honours Admin › Integrations; vendor documents (`apps/api/src/services/vendorWork.ts:409-418`), sign-off and SharePoint read `BLOB_READ_WRITE_TOKEN` directly, so turning storage off does not stop vendor COI and W-9 uploads. The base64 upload path itself is copied twice.
- **The quote parity test guards little (W5-4, folds W6-7).** `tests/quote-math-parity.test.ts:112,145` still passes the retired dollar `sales_tax`, has no Yoda-rule, per-line tax, markup or OT case, and skips grand total, profit and margin with an obsolete reason. With the skips removed, 9 of 10 pass; only margin precision differs.
- **The assistant guide has drifted (W5-8).** It names a "To process" lane and "Send to Yoda" buttons (`apps/api/src/lib/assistantGuideModules.ts:19,23`); the UI says "To pay" and `sent_to_yoda` was retired in 0076.
- **The docs-registry guard is weak (W5-20).** `tests/docs.test.ts:39-43` checks each sidebar label is a substring of the whole registry, so "Admin" passes trivially, and `DOCS_REVIEWED_ON` was not bumped across 11 later commits.
- **`packages/shared/src/index.ts` is a dumping ground (W5-11)**, about 1,750 lines of its own code in 20 unrelated sections before 33 re-exports. 220 shared exports are never referenced from the apps, 29 nowhere at all.
- Smaller drift: the web status-group fallback (W5-9), three role vocabularies that lack half the real roles (W5-10), migration headers that cite old numbers (W5-12), CLAUDE.md keep-in-step notes (W5-13), field order between migrated and seeded databases (W5-14), byte-identical helpers (W5-15), a duplicated service-principal lookup (W5-17).

### Data layer

- **Production runs Postgres, not PGlite (W3-1).** `packages/db/src/client.ts:1-6,43-59` is a `pg.Pool` on `DATABASE_URL`, and production points at a Neon pooler host. Yet `apps/api/src/services/adminMeta.ts:183` reports `engine: 'PGlite (embedded Postgres 16)'` in a live response, `@electric-sql/pglite` is still a dependency with no import, there is no `statement_timeout`, migrations are run by hand because the Vercel build never runs them, and the worker jobs are "NOT wired yet".
- **The Pulse is broken (W3-2, High, reproduced).** `activity_log.entity_id` has been text since `packages/db/migrations/0023_admin_audit.sql:19-20`. `apps/api/src/services/obligations.ts:321,324,439,535` compare it to a uuid with no cast. The error is caught at `:888-890` and `:910-915` and logged to the console only. Locally all 7 rules are enabled and the `obligation` table has 0 rows. The fix is a `::text` cast; once it lands, W4-7 becomes live and must be fixed in the same change.
- **Lost update on the jsonb bag (W3-3, Medium-High).** `updateWorkOrderFields` reads `task.fields` outside any transaction or lock (`apps/api/src/services/woFieldValues.ts:117-121`), merges in JavaScript and writes the whole bag back (`:155-166`). The same pattern appears in `signoff.ts:293,435`, `visits.ts:407`, `assigneeHistory.ts:59` and `woBulk.ts:219-287`. Two edits to different keys, or a person racing an every-minute cron or a post-commit automation, can drop one, and the audit row still records the dropped write.
- **Migration numbers were rewritten across branches (W3-6, folds W6-10).** `origin/main` carries `0004_auth.sql` to `0027_client_portal_type.sql`; this branch carries the same files as `0009_auth.sql` to `0033_client_portal_type.sql`, renumbered in merge `8c2e018`. `Primary-Updates-quotes-payments` adds a `0028` that collides with this branch's `0028`. The ledger is keyed by filename (`packages/db/src/migrate.ts:19-24,43-52`), so a database migrated from the other line re-applies renamed files. `main` is not an ancestor of this branch (48 behind, 133 ahead), and PR #1 merged into `main` on 2026-10-13, so someone still treats `main` as the line of record.
- **The runner (W3-7)** has no lock and no checksum, and writes the ledger row outside the file's transaction (`packages/db/src/migrate.ts:51-52`).
- **The seed wipes 105 of 158 tables with no guard (W3-14, Medium-High with W4-20).** `packages/db/src/seed.ts:747-759` TRUNCATEs 36 tables with CASCADE into 69 more, and nothing checks the host. Read with W4-20: every developer's `vercel env pull` holds the production Neon URL, so one `export DATABASE_URL=...` followed by `npm run setup` empties production.
- **The bag is keyed by verbatim ClickUp names, emoji included (W3-13, High).** There are 629 quoted occurrences of live field keys across 108 files and 73 raw `fields->>'...'` in API SQL; `'34. Cost'` is declared as a constant five times and written raw in SQL in seven more places. Renaming a field in Admin breaks code silently. Hot fields are also promoted into columns that services must keep in step.
- **Hot predicates have no index (W3-12).** The scope predicate splits `fields->>'Assignee'` per row (`apps/api/src/services/woScope.ts:49-54`); `activity_log` has no `created_at` index though the ClickUp cursor reads it every minute (`apps/api/src/services/clickup.ts:940-944`); 103 foreign keys have no leading index; the jsonb GIN index serves one query. Volumes are small today.
- Lower: money parsed four ways in SQL, affecting only legacy strings (W3-4); CHECK lists redefined across migrations (W3-8); constant strings interpolated inside SQL quotes (W3-11); the append-only trigger can be dropped by the owner role the app connects as (W3-15); 85 MB of dead PGlite data directories in OneDrive (W3-16); reference data inserted by migrations on tables the seed wipes (W3-9). The migration inventory itself is clean (W3-5) and all interpolated SQL is safe (W3-10).

## Dependencies & risks

- **`npm audit --omit=dev` finds 5 vulnerabilities (W6-14).** fastify and fast-uri (high) are fixed by `npm update` inside the current ranges. react-router 6.x (moderate) is an SSR advisory that does not apply to an SPA. maplibre-gl (critical XSS) sits in popup sanitising, which the app never calls (`components/map` has no `setHTML` or `Popup(`), but the fix is a major bump. Majors behind: React 18, Vite 5, zod 3, react-router 6. `@electric-sql/pglite` and a runtime `playwright-core` are unused.
- **Delayed automations never run on Vercel (W6-12).** `sweepPending` (`apps/api/src/services/automations.ts:831`) is called only by the local-dev scheduler and no cron drives it. No delayed rule exists today, so this is latent.
- **The worker is a skeleton (W6-13).** `apps/worker/src/index.ts:15-16` says "Jobs are NOT wired yet"; it counts connections every 30 s. Its header still claims the Ecotrak poll and obligation clocks.
- **The repo lives in OneDrive (W6-15).** The CI workflow already notes OneDrive breaks workspace junctions, and database directories plus `.vercel/.env.production.local` sit in the synced folder.
- **The API bundle targets node20** while CI and Vercel run Node 24 (W6-11).
- **Dev and prod run different background work**: dev has a 60 s ClickUp timer but no Ecotrak sync; prod has crons but no automation sweep.

## Security findings

The front door is solid. Authorization after sign-in is enforced by convention, and a few families get it wrong.

**Confirmed past exposure: password-less production sign-in (W4-11).** On or around 2026-09-01 the production deployment allowed anyone who could reach it to sign in as any user, super admins included, with no password. Commit `51eb1e4` ("public demo on Vercel", DEMO_MODE) introduced it. The production variable pull of that date (`.vercel/.env.production.local`, `VERCEL_ENV=production`) holds `AUTH_DEV_BYPASS` and `DEMO_MODE` and no `ENTRA_*`; `apps/api/src/config.ts:229-239` boots only in bypass in that case, and `apps/api/src/services/auth.ts:414-416` admits the bypass in production when `DEMO_MODE` is on. That server held the Ecotrak client credentials and the same Neon database production uses today. Entra replaced it by about 2026-09-04 (the `ENTRA_*` variables are dated "40d ago"); how long `DEMO_MODE` stayed set after that cannot be recovered.

- **Established:** a password-less production login existed for at least about three days with live Ecotrak credentials loaded.
- **Not established:** whether that database held real client data during the window (the commit calls it a demo, and the live Ecotrak sync came later, migration 0079 on 2026-10-13), and whether anyone used the bypass.
- **Today:** production is Entra-only. `GET /api/health` returns `auth_mode: "entra"`, `/api/auth/dev-candidates` returns 404, and a leftover flag cannot reopen the bypass because `apps/api/src/config.ts:239` prefers Entra whenever it is configured.
- **Still wrong:** "seed data only" is a naming convention, not a check.
- **To close it:** run `SELECT * FROM activity_log WHERE action = 'signed_in' AND after->>'method' = 'dev_bypass'` on production (the bypass logs that way, `apps/api/src/routes/auth.ts:168`); rotate the Ecotrak secret and the database password; make `DEMO_MODE` refuse to boot when a real database or any integration credential is present.

**Production database credentials reach Preview and Development (W4-20, Medium-High).** `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `PGHOST` are scoped to Production, Preview and Development, while `ENTRA_*` are Production-only. A preview build today fails closed (no auth mode, so `apps/api/src/config.ts:229` throws), but adding bypass and `DEMO_MODE` to Preview would recreate September's configuration against real data. The concrete path is Development: `vercel env pull` gives every developer the production URL, `.env.local` already holds it, and W3-14 means one command wipes it.

**Privilege escalation to super admin (W4-1, High).** `POST` and `PATCH /admin/users` are gated by `admin/users` edit alone and accept `is_super_admin` (`apps/api/src/routes/admin.ts:114-128,171-183`); `apps/api/src/services/users.ts:166-211` only stops self-demotion and demoting the last super admin. Locally six people who are not super admins hold the admin role and could promote themselves. The fix is one check: only a super admin may set or clear the flag.

**Scope and permission gaps:**
- **CSV import (W4-4, Medium-High).** `POST /work-orders/import` passes only the actor id (`apps/api/src/routes/workOrders.ts:398-408`, `apps/api/src/services/woBulk.ts:531-535`) and checks neither scope nor `work_orders/status`. The OM tiers hold `work_orders` create while scoped and request-only, so the most numerous scoped roles can upsert out-of-scope work orders and set status directly.
- **Records opened by their own id skip scope (W4-3).** Visits (`apps/api/src/routes/visits.ts:73-108`, where a check-in can move an out-of-scope work order), payment requests, invoices, vendor bills, approval tasks and billing proposals check the permission, not the scope. Ids are UUIDs, so not trivially guessable, but rule 8.5 is broken.
- **Hidden fields leak through aggregates (W4-5).** `/metrics/breakdown?field=fields.34. Cost` has no gate and no field check (`apps/api/src/routes/metrics.ts:49-57`); the dashboard preview sums any field; list `group_by` returns hidden values as keys.
- **Client Updates bypass scope and redaction (W4-6).** `buildView` runs with no viewer (`apps/api/src/services/clientUpdates.ts:581-600`), and tracker columns are checked only for existence.
- **Automation enrolment (W4-8)** runs a rule's writes on any task ids, gated only by the legacy `can.editWoFields` flag that CLAUDE.md says "no longer gates anything" (`apps/api/src/routes/automations.ts:37-46`).
- **Pulse and Obligations (W4-7)** are unscoped and ungated (`apps/api/src/routes/obligations.ts:67-89`). Low today because W3-2 means they return nothing; Medium the moment W3-2 is fixed.
- **Scope keys on a display name (W4-9).** `woScopeSql` matches `fields->>'Assignee'` against the actor's name, which Entra rewrites on every sign-in (`apps/api/src/services/woScope.ts:47-54`); two people with the same name see each other's book.

**Audit integrity: writes while viewing as someone are logged as that person (W4-2, Medium).** `actingPrincipalFromRequest` returns the impersonated id (`apps/api/src/services/activity.ts:35-44,74-89`), contradicting `apps/api/src/services/auth.ts:63` ("Every write is attributed here"). Only `impersonation_started` names the super admin. Only four people can impersonate, so a write can be traced by time window, but the audit log names the wrong author.

**Lower:** sign-in rebinds an account by email when no oid matches, without requiring `entra_oid IS NULL` (W4-10, suspected, depends on tenant claim hygiene); no security headers, no rate limiting, attachments served inline with the client-declared type (W4-12); Quo legacy signatures replayable (W4-13); session ids and two public token kinds stored in clear and logged by Fastify (W4-14); a few admin-ish routes read the acting user instead of the real one (W4-15); impersonation of a disabled user (W4-16). The assistant boundary holds (W4-17). No secrets in git (W4-18). Sessions and OIDC are sound (W4-19).

**The public repo (W6-15, High).** `VistaJordan/TheOne` is public and tracks raw ClickUp exports twice (`clickup-raw/` and `platform-brainstorm/clickup-raw/` at the repo root, 56 files, the largest about 5.3 MB each). Most emails are internal, but client domains (kohls.com, carvana.com, vixxo.com, servicechannel.net), about 50 phone numbers and site addresses are present. This is the team's and clients' contact data, not consumer data, but it should not be public.

## Findings table

Severity is the Skeptic's final value. Tier: Must = this week, Should = next few sprints, Nice = when convenient, Info = a positive or a measurement. Paths are relative to `app/` unless marked repo root.

| ID | Area | Severity | Tier | Summary | Primary file:line |
|---|---|---|---|---|---|
| W4-1 | Security | High | Must | Anyone with admin/users edit can make themselves super admin | apps/api/src/routes/admin.ts:171-183 |
| W6-15 | Process | High | Must | Public repo tracks raw ClickUp exports with client contacts; repo in OneDrive | clickup-raw/ (repo root) |
| W3-2 | Data | High | Must | Pulse / obligations broken since 0023: text = uuid, error swallowed | apps/api/src/services/obligations.ts:321,324,439,535 |
| W1-8 | API | High | Must | Multi-statement writes with no transaction; award race; stale PGlite rationale | apps/api/src/services/purchasing.ts:880-898 |
| W3-6 | Data | High | Must | Migrations renumbered across branches; ledger keyed by filename | packages/db/src/migrate.ts:19-24 |
| W6-4 | Process | High | Must | CI red for 24 pushes; tests need a developer's .env | apps/api/src/config.ts:24,278 |
| W6-9 | Process | High | Must | No protected branch; one PR in 146 commits; very large commits | .github/workflows/ci.yml (repo root) |
| W2-1 | Web | High | Must | Receivables Audit shows hash-invented facts as real; feeds Ready lane | apps/web/src/lib/receivables.ts:97-140 |
| W3-13 | Data | High | Should | Bag keyed by verbatim ClickUp names; 629 literals; Cost constant declared 5 times | packages/db/migrations/0001_init.sql:107 |
| W6-5 | Process | High | Should | Tests touch no database and no route | tests/sales-scope.test.ts:76-84 |
| W6-6 | Process | High | Should | 76 of 83 service files imported by no test | apps/api/src/services/approvals.ts |
| W4-20 | Security | Medium-High | Must | Production Neon URL scoped to Preview and Development | .env.local (Vercel env scopes) |
| W3-14 | Data | Medium-High | Must | Seed truncates 105 tables with no host guard | packages/db/src/seed.ts:747-759 |
| W4-4 | Security | Medium-High | Must | CSV import ignores scope and the status permission | apps/api/src/services/woBulk.ts:531-535 |
| W3-3 | Data | Medium-High | Must | Whole jsonb bag read outside tx and written back: lost updates | apps/api/src/services/woFieldValues.ts:117-121,155-166 |
| W2-4 | Web | Medium-High | Should | Browser re-derives rules; photo checklist contradicts Photos card | apps/web/src/lib/woDerive.ts:267-277 |
| W4-11 | Security | Medium | Must | DEMO_MODE reopens bypass; production ran password-less around Sep 1-4 | apps/api/src/config.ts:212-239 |
| W4-2 | Security | Medium | Must | Writes while viewing-as are logged as the impersonated user | apps/api/src/services/activity.ts:35-44,74-89 |
| W6-14 | Dependencies | Medium | Must | npm audit: 5 vulns; fastify and fast-uri fixed by npm update | package.json |
| W1-2 | API | Medium | Should | changeStatus and dispatchAutomations are the real god functions | apps/api/src/services/workOrders.ts:552 |
| W1-3 | API | Medium | Should | Six import cycles hidden by await import() | apps/api/src/services/approvals.ts:665,674 |
| W1-5 | API | Medium | Should | importWorkOrders, collectDesired, upsertOne, bulkUpdate, decide too long | apps/api/src/services/woBulk.ts:531 |
| W1-6 | API | Medium | Should | Post-commit hops disagree on throwing; housekeeping shares the rules' try | apps/api/src/services/workOrders.ts:640-648 |
| W1-7 | API | Medium | Should | Bulk status move skips Ecotrak check, obligations, billing proposals | apps/api/src/services/woBulk.ts:232-240,309-315 |
| W1-9 | API | Medium | Should | Raw INSERT INTO activity_log in 29 files | apps/api/src/services/approvals.ts |
| W1-10 | API | Medium | Should | Swallowed errors change behaviour silently | apps/api/src/services/woRecord.ts:564 |
| W2-2 | Web | Medium | Should | 42 files over 400 lines; AdminSections is 3,021 lines | apps/web/src/pages/admin/AdminSections.tsx |
| W2-3 | Web | Medium | Should | client.ts redeclares 26 shared types; 11 shared copies dead | apps/web/src/api/client.ts:899,1324 |
| W2-5 | Web | Medium | Should | No query-key convention; invalidations that refresh nothing | apps/web/src/pages/WorkOrderDetailPage.tsx:114 |
| W2-6 | Web | Medium | Should | No lazy routes; main chunk 1,968 kB | apps/web/src/App.tsx:9-52 |
| W2-7 | Web | Medium | Should | Route and nav permissions declared twice and disagree | apps/web/src/components/AppShell.tsx:127-146 |
| W2-8 | Web | Medium | Should | 114 hard-coded colours outside tokens.css | apps/web/src/styles/wo-detail.css:275,532 |
| W3-1 | Data | Medium | Should | Production is Postgres; live API reports PGlite; no statement_timeout; manual migrations | apps/api/src/services/adminMeta.ts:183 |
| W3-7 | Data | Medium | Should | Migration runner: no lock, no checksum, ledger outside tx | packages/db/src/migrate.ts:51-52 |
| W3-9 | Data | Medium | Should | Reference data in migrations on tables the seed wipes | packages/db/src/seed.ts:283-295 |
| W3-12 | Data | Medium | Should | Scope, audit and ClickUp predicates unindexed; 103 unindexed FKs | apps/api/src/services/woScope.ts:49-54 |
| W4-3 | Security | Medium | Should | Visits, payments, invoices, bills, tasks, proposals skip scope by id | apps/api/src/routes/visits.ts:73-108 |
| W4-5 | Security | Medium | Should | Hidden field values leak through metrics, preview, group_by | apps/api/src/routes/metrics.ts:49-57 |
| W4-6 | Security | Medium | Should | Client Updates bypass scope and redaction | apps/api/src/services/clientUpdates.ts:581-600 |
| W4-8 | Security | Medium | Should | Automation enrolment unscoped, gated by a legacy flag | apps/api/src/routes/automations.ts:37-46 |
| W4-9 | Security | Medium | Should | Scope keyed on a mutable, non-unique display name | apps/api/src/services/woScope.ts:47-54 |
| W4-10 | Security | Medium | Should | Sign-in can rebind an account by email (suspected) | apps/api/src/services/auth.ts:149-162 |
| W5-1 | Shared | Medium | Should | Task INSERT copied 5 times; only import sets home_list_id | apps/api/src/services/intake.ts:386 |
| W5-2 | Shared | Medium | Should | WO-number duplicate check normalised in one path only | apps/api/src/services/intake.ts:353 |
| W5-4 | Shared | Medium | Should | Quote parity test stale, skips the totals it should guard | tests/quote-math-parity.test.ts:112,145,186 |
| W5-5 | Shared | Medium | Should | Gates and moves key off editable status names | apps/api/src/services/statusAdmin.ts:132-155 |
| W5-6 | Shared | Medium | Should | Status vocabulary hand-copied 8 times, 3 cross-checked | apps/web/src/lib/phases.ts:25-46 |
| W5-7 | Shared | Medium | Should | Storage switch bypassed by vendor documents and sign-off | apps/api/src/services/vendorWork.ts:409-418 |
| W5-8 | Shared | Medium | Should | Assistant guide names retired Yoda buttons and old lane | apps/api/src/lib/assistantGuideModules.ts:19,23 |
| W5-11 | Shared | Medium | Should | shared index.ts is a 1,750-line dumping ground | packages/shared/src/index.ts |
| W5-16 | Shared | Medium | Should | Base64 upload path copied; blob token read 4 ways | apps/api/src/services/attachments.ts:185-222 |
| W5-20 | Shared | Medium | Should | Docs-registry guard trivially satisfied; review date not bumped | tests/docs.test.ts:39-43 |
| W6-8 | Process | Medium | Should | CI skips vite build, bundle, lint, audit, migrations | .github/workflows/ci.yml (repo root) |
| W6-12 | Dependencies | Medium | Should | Delayed automations never swept on Vercel (latent) | apps/api/src/services/automations.ts:831 |
| W6-13 | Process | Medium | Should | apps/worker is a skeleton that claims jobs it does not run | apps/worker/src/index.ts:15-16 |
| W6-16 | Process | Medium | Should | CLAUDE.md is 1,864 lines and stale on DB, tests, typecheck, branches | CLAUDE.md (repo root) |
| W1-4 | API | Low-Medium | Should | Services trust task ids; orchestration split across routes | apps/api/src/routes/workOrders.ts:673,691,726 |
| W1-12 | API | Low-Medium | Nice | modules/ is an abandoned second layout; two SharePoint planners | apps/api/src/modules/integrations/ecotrak/sharepointPath.ts |
| W4-12 | Security | Low-Medium | Should | No security headers or rate limiting; inline attachments | apps/api/src/routes/workOrders.ts:536-548 |
| W5-3 | Shared | Low-Medium | Should | Float quote vs integer-cent invoice: invoice bills one cent more | apps/api/src/services/quotes.ts:64 |
| W5-10 | Shared | Low-Medium | Should | Three role vocabularies, all missing half the roles | apps/web/src/lib/actor.ts:10-19 |
| W5-15 | Shared | Low-Medium | Should | Byte-identical helpers in intake and create; 13 num copies | apps/api/src/services/woCreate.ts:294-332 |
| W4-7 | Security | Low today, Medium after W3-2 | Must | Pulse and Obligations unscoped and ungated | apps/api/src/routes/obligations.ts:67-89 |
| W1-1 | API | Low | Nice | services/activity.ts is request context carrying a Fastify type | apps/api/src/services/activity.ts:35-74 |
| W1-11 | API | Low | Nice | Error handling consistent; integration code throws plain Error | apps/api/src/errors.ts:20-90 |
| W2-9 | Web | Low | Nice | State patterns fine; domain hooks scattered in component files | apps/web/src/components/wo/record/RecordParts.tsx:65 |
| W3-4 | Data | Low | Nice | Money parsed four ways in SQL; legacy strings only | apps/api/src/services/kpis.ts:58-59 |
| W3-8 | Data | Low | Nice | CHECK lists redefined across migrations | packages/db/migrations/0042 (line 76), 0044 (12), 0049 (22) |
| W3-11 | Data | Low | Nice | Constant strings interpolated inside SQL quotes | apps/api/src/services/workOrders.ts:574 |
| W3-15 | Data | Low | Nice | Append-only trigger droppable by the owner role the app uses | packages/db/migrations/0029_activity_log_immutable.sql:19-35 |
| W3-16 | Data | Low | Nice | 85 MB of dead PGlite data directories in OneDrive | packages/db/pgdata |
| W4-13 | Security | Low | Nice | Quo legacy signatures replayable | apps/api/src/lib/quoSignature.ts:37-43 |
| W4-14 | Security | Low | Nice | Session ids and public tokens in clear, logged by Fastify | apps/api/src/services/auth.ts:240-247 |
| W4-15 | Security | Low | Nice | Some admin-ish routes read the acting user, not the real one | apps/api/src/routes/woRecord.ts:200-206 |
| W4-16 | Security | Low | Nice | Can view as a disabled user | apps/api/src/services/auth.ts:287-295 |
| W4-17 | Security | Low | Nice | Assistant boundary holds; prompt-injection surface small | apps/api/src/lib/assistantTools.ts:279,300-345 |
| W5-9 | Shared | Low | Nice | Web status-group fallback drifted | apps/web/src/lib/statusGroups.ts:8-13 |
| W5-12 | Shared | Low | Nice | Migration headers and CLAUDE.md cite old numbers | packages/db/migrations/0009_auth.sql |
| W5-13 | Shared | Low | Nice | CLAUDE.md keep-in-step notes stale | CLAUDE.md (repo root) |
| W5-14 | Shared | Low | Nice | Field order differs between migrated and seeded databases | packages/db/src/seed.ts:912-926 |
| W5-17 | Shared | Low | Nice | Service-principal lookup copied; Quo actor declared twice | apps/api/src/services/automations.ts:200-213 |
| W6-1 | Process | Low | Nice | Typecheck 0 errors; stricter flags would cost 443 + 168 fixes | tsconfig.base.json |
| W6-2 | Process | Low | Should | tests/ in no tsconfig; parity test has 4 type errors | vitest.config.mts:7 |
| W6-11 | Process | Low | Nice | Bundle targets node20, runtime is Node 24 | scripts/bundle-api.mjs |
| W6-17 | Process | Low | Nice | Dead code: syncCostFromPayments, 37 sent_to_yoda refs, unused deps | apps/api/src/services/moneySync.ts:76 |
| W3-5 | Data | Info | Info | Migration inventory clean: no gaps, guarded destructive steps | packages/db/migrations/ |
| W3-10 | Data | Info | Info | All 109 interpolated SQL templates bind or allow-list | apps/api/src/services/woFields.ts:538-640 |
| W4-18 | Security | Info | Info | No secrets in git or in the API bundle | .gitignore:25 |
| W4-19 | Security | Info | Info | Server-side sessions, PKCE, safe redirects, generic 500s | apps/api/src/services/auth.ts:276 |
| W6-3 | Process | Info | Info | 46 test files, 554 pass, 3 skipped locally | vitest.config.mts:7 |

The three overall-verdict items (W1-13, W3-17, W6-18) are summarised in the Bottom line and the Final verdict rather than listed as rows. Under dead code, one low note: two items were cut, the two notice tables and the write-only outbox (W5-18, documented design) and `syncCostFromPayments` (W5-19, a duplicate kept inside W6-17).

## Disputed / unresolved

Nothing is left disputed. Four items were disputed in the first Skeptic pass and resolved in one revision round:

- **W4-11** was raised as possibly Critical. A live check showed production is Entra-only today; the past exposure was confirmed. Final Medium, Must.
- **W2-3** claimed 13 drifted types. Revised: the API is type-checked, most shared duplicates are dead, and the web copies are looser rather than wrong. Final Medium.
- **W5-1** claimed the five INSERT copies diverged in side effects. Revised: most differences are documented; one undocumented gap remains (`home_list_id`). Final Medium.
- A W1 handoff note claiming the API is not type-checked was wrong and was dropped (`package.json:12` runs `tsc -p apps/api`).

Facts nobody could verify, and how to settle each:
- Whether anyone used the September bypass: the production `activity_log` query in Security findings.
- The production `_migrations` ledger numbering (W3-6): read it before any further migration.
- Whether the lost-update and award races (W3-3, W1-8) have happened in production: there is no audit signal; fix them anyway.
- Which branch Vercel deploys from: the setting is not in the repo.

## Recommendations

### Must-fix: this week, in order of risk

1. **W4-1** Only a super admin may set or clear `is_super_admin` (`apps/api/src/routes/admin.ts:171-183`, `apps/api/src/services/users.ts:166-211`). One check.
2. **W4-11, W4-20, W3-14** Close the production-data path. Run the `dev_bypass` sign-in query on production; rotate the Ecotrak secret and the Neon password; make `DEMO_MODE` refuse to boot when a non-seed database or any integration credential is present; give Preview and Development their own Neon branches; make `seed.ts` refuse unless the host is localhost or `ALLOW_SEED` names the database.
3. **W6-15** Make the GitHub repo private now; then remove `clickup-raw/` and `platform-brainstorm/clickup-raw/` from history and force-push once, with the team warned.
4. **W4-4** Give `importWorkOrders` the acting principal and apply scope and the `work_orders/status` permission per row.
5. **W3-3** Replace whole-bag writes with `fields = fields || $patch::jsonb` (and `fields - key` for clears), or `SELECT ... FOR UPDATE` inside the transaction. Start with `updateWorkOrderFields`, then `woBulk`, `signoff`, `visits`, `assigneeHistory`.
6. **W1-8** Wrap `purchasing.awardQuote` and the delete-then-insert line rewrites in `withTransaction`, with a row lock on the RFQ.
7. **W3-2 with W4-7** Cast `t.id::text` in the four obligation queries, add a test that executes them against Postgres, and in the same change scope `/pulse` and `/obligations` and gate them on a permission.
8. **W4-2** Log the real user as actor with an `on_behalf_of` field, or make view-as read-only.
9. **W3-6** Decide the line of record (this branch), reset `main` to it, and read the production ledger before the next migration. Then fix the ledger (see Process improvements).
10. **W6-4, W6-9** Make the tests hermetic (set the test env in `vitest.config.mts` or make `config` lazy), get CI green, then protect `main` and require CI.
11. **W6-14** Run `npm update` for fastify and fast-uri; schedule the maplibre major.
12. **W2-1** Gate `/receivables` behind `invoicing`, label the Audit lane as a prototype on the page itself, and stop the Ready lane reading invented facts; then rebuild it on `completionProofMissing` and `doneGateMissing`, which shared already exports.

### Should-fix: next few sprints, structure

Ordered so each step makes the next one safer.

1. **A Postgres-backed test tier and a route-matrix security test** (W6-5, W6-6, W4-3, W4-5, W4-6, W4-8). Before refactoring the core, get tests that execute SQL and hit routes through `app.inject`.
2. **Close the scope gaps by mechanism** (W4-3, W4-5, W4-6, W4-8, W4-9, W4-10, W1-4). One `assertTaskInScope(row.task_id, actor)` in every by-id loader; `canViewField` on every field key a request names (filters, sort, group_by, metrics, widgets, tracker columns); scope keyed on principal id, not display name; enrolment on the real permission plus scope; email rebinding only when `entra_oid IS NULL`.
3. **Extract one work-order write pipeline** (W1-2, W1-3, W1-6, W1-7, W5-1, W5-2). One `insertWorkOrder(tx, cols, bag, source)` and one `afterCommit(event)` with the per-source steps declared in one table and a single rule about throwing; route the bulk status move through it; normalise WO numbers in one place. The import cycles disappear as a side effect.
4. **Transaction discipline** (W1-8, W3-1). Delete the 23 PGlite comments, add `statement_timeout`, fix `adminMeta.ts:183`, add transactions to `purchasing`, `maintenance` and `vendorWork`.
5. **Field keys and status codes in shared** (W3-13, W5-5, W5-6, W5-10). One `FIELD_KEYS` in `@theone/shared`; promote Cost, NTE, Assignee and Address to typed columns; give statuses a stable code or refuse renames of statuses the code names; read role labels from the role table.
6. **One money module** (W5-3, W3-4, W5-15). Integer cents in shared, used by quotes, purchasing and invoices, and one SQL helper for parsing.
7. **Web contract and caching** (W2-3, W2-4, W2-5, W2-7). Re-export shared types from `client.ts`; a `queryKeys.ts` factory with per-domain `invalidateX()`; one route table for paths, nav labels and permissions; delete the browser copies of rules shared already owns.
8. **Split the large files** (W2-2, W1-5, W5-11) as each is next touched, starting with `AdminSections.tsx`, `ApprovalsPage.tsx`, `QuoteBuilderPage.tsx`, `importWorkOrders` and `shared/index.ts`.
9. **Lazy routes** (W2-6), with admin, vendors and purchasing first.
10. **Storage and upload in one place** (W5-7, W5-16), honouring the integration switch.
11. **Crons and the worker** (W6-12, W6-13). Add a cron for `sweepPending`; delete `apps/worker` or make it the real job host.
12. **Indexes** (W3-12) on `activity_log.created_at`, `billing_entity` and the foreign keys on hot joins; Assignee to a join table once scope keys on ids.
13. **Centralise audit writes** (W1-9) and give the "never throws" helpers a durable failure record (W1-10).
14. **Security headers** (W4-12): CSP, `frame-ancestors` and `nosniff` in `vercel.json`; `Content-Disposition: attachment` for non-images; rate limiting on public token routes.
15. **Fix the stale tests and guides** (W5-4, W5-8, W5-20, W6-2, W3-9): rewrite the parity fixture for the Yoda rule and remove the skips; test the assistant guide's labels against the JSX; make the docs guard exact and bidirectional; put `tests/` in a tsconfig; move migration reference data into one idempotent step both migrate and seed call.

### Nice-to-have

W1-1 (rename `activity.ts` to request context), W1-11, W1-12 (fold `modules/` into `services/`), W2-8 (colour lint), W2-9, W3-8 (lookup tables instead of CHECK lists), W3-11, W3-15 (a non-owner app role), W3-16 (delete the PGlite directories), W4-13 to W4-16, W5-9, W5-12, W5-14, W5-17, W6-1 (`noUnusedLocals` first), W6-11, W6-17 (delete `syncCostFromPayments`, the `sent_to_yoda` filter value and the unused dependencies).

## Process improvements

The pipeline exists; it is not enforced. These changes are specific and small.

| Change | What to do | Addresses |
|---|---|---|
| CI green is a gate | Fix the env leak, then no merge while red. Add `vite build`, the API bundle, `npm audit --omit=dev` and a bundle-size budget to `ci.yml`. | W6-4, W6-8, W2-6, W6-14 |
| Branch protection on `main` | Require a PR, CI green and one review; no direct pushes. Reset `main` to the line of record first. | W6-9, W3-6 |
| PR size | One feature or one migration per PR, aiming under about 800 changed lines. Today the median commit is +272 lines, the mean +3,332, the largest +106,061. | W6-9 |
| Postgres-backed test tier | A CI job with `services: postgres` that runs every migration from empty, seeds, then runs integration tests through `app.inject`. Cover the obligation queries, the append-only trigger, the gates' database half, the bag write and the import. | W6-5, W6-6, W3-2, W3-3, W3-15 |
| Route-matrix security test | For every registered route, sign in as each role and as a scoped dispatcher, and assert 401, 403, scoped results and redacted fields. This would have caught W4-3 to W4-8. | W4-3, W4-4, W4-5, W4-6, W4-7, W4-8 |
| Drift-test suite for keep-in-step pairs | Tests that parse the migrations and compare them with the seed, shared constants and the web: field_def rows and order, status names and aliases, WO PDF defaults, create-form keys, role vocabulary, migration header number equals filename, assistant-guide labels present in the JSX. Then delete copies wherever possible. | W3-9, W5-4, W5-6, W5-8, W5-9, W5-12, W5-14, W5-20 |
| Docs split | A short `README.md` (run, verify, deploy), an `ARCHITECTURE.md` (layers, write pipeline, auth model, data model) and one doc per module next to its code. Fix the false lines first: PGlite, "no test suite", "only typecheck", "no tsconfig", "PRs fast-forward". CLAUDE.md becomes a pointer plus the rules that bite. | W6-16, W3-1, W5-13 |
| Migration ledger keyed by checksum | Key `_migrations` by a stable id plus sha256; wrap the file and its ledger row in one transaction; take `pg_advisory_lock`; refuse an edited applied file; never renumber. Run migrations as a deploy step, not by hand. | W3-6, W3-7, W3-1 |
| Separate Neon branches | Production, Preview and Development each get their own database, so `vercel env pull` never yields the production URL. | W4-20, W3-14, W4-11 |
| Secret rotation | Rotate the Ecotrak secret and the Neon password now, then on a schedule and whenever someone leaves. | W4-11, W4-20 |
| `.gitattributes` | Set `* text=auto` with one chosen line ending, so line-ending churn (as in today's `package-lock.json`) stops masking real diffs. | W6-15 |
| Move the repo out of OneDrive | Clone to a local path. OneDrive already breaks workspace junctions and syncs production env pulls and database directories. | W6-15, W3-16 |
| Remove raw ClickUp exports from history | `git filter-repo` on both `clickup-raw/` folders, force-push once, everyone re-clones. Keep the repo private meanwhile. | W6-15 |
| Dependency updates | Dependabot or a monthly `npm outdated` pass: patch inside ranges at once, plan majors (maplibre, React 19, Vite, zod 4), remove unused dependencies. | W6-14, W6-17 |
| Lint | Add ESLint with `react-hooks` (13 disable comments exist for a linter that is not installed), plus rules against raw colour literals and inline `queryKey` arrays. | W6-8, W2-5, W2-8 |

## What the Skeptic changed

Every Worker severity was pressure-tested. Of 96 raw items, the first Skeptic pass made 20 severity adjustments, almost all downward: W2-1 Critical to High; W1-3, W1-7, W2-2, W2-3, W2-5, W4-2, W5-1, W5-2, W5-5, W6-12 and W6-14 High to Medium; W3-3 High to Medium-High; W3-14 High to Medium; W5-3 High to Low-Medium; W3-4 Medium to Low; W4-7 Medium to Low until W3-2 is fixed. Four findings were reproduced independently: W3-2, W5-3 (with its direction corrected, the invoice bills one cent more), W6-4 and W6-15. Two items were cut (W5-18 as documented design, W5-19 as a duplicate) and ten duplicate pairs were merged. Four items were disputed and revised in one edit loop, and W1-6 was narrowed to Medium. The second pass upheld all four revisions, added one new item from the W4-11 revision (W4-20, production database credentials in Preview and Development, Medium-High) and raised W3-14 back to Medium-High because of it. W4-11 itself went from Medium to possibly Critical and back to Medium after a live check showed production is Entra-only today, with the past exposure confirmed. Nothing was left disputed.

## Final verdict

The codebase is in better shape than its owner fears, and the process is in worse shape than the codebase. It is not spaghetti: the layers are real, the dangerous primitives (SQL, sessions, webhook secrets, permissions) are handled in one place and handled well, and most of the mess is size and duplication that can be paid down in order. What makes it risky is that correctness rests on people remembering things: three separate authorization checks per handler, after-commit steps per call site, a single-connection assumption on a pooled database, and a dozen copies of the same rule kept in step by hand, with no CI gate, no database tests and no review to catch the day someone forgets. Fix the twelve Must items this week, put the Postgres test tier and the route matrix in place, then refactor the write core under that cover. The system is ready to grow once the process stops depending on memory.

## Method

Six workstreams ran in parallel, one Worker each: API layering, web front end, data layer, security and authorization, shared contract and keep-in-step drift, and engineering process. The Workers read the code; ran the typecheck, the tests, the web build and `npm audit`; ran read-only queries against a local database; read the GitHub and Vercel APIs read-only; and produced 96 raw findings with file and line evidence. A Skeptic then checked every item end to end, reproduced four, cut two, merged ten duplicate pairs, adjusted twenty severities and disputed four. One edit loop (of a possible three) sent the four disputed items back to their Workers, who revised them, including a live check of the production health endpoint and the Vercel variable list; a second Skeptic pass upheld all four and admitted one new item. This document was built only from the surviving items at their final severities: 90 rows in the table plus three summary verdicts, with nothing left disputed.

# The One — MVP Build Plan

**Date:** 2026-08-18 · **Owner:** Jordan Brown · **Target:** R1 Pilot foundation (~5 users)

Sits beside `docs/SPRINT1-SPEC.md` and `product/feature-roadmap.md`.

---

## 1. Scope

### In

| Module | MVP content |
|---|---|
| `platform/` | field engine, statuses, containers, attachments, outbox/events |
| `activity/` | attributed activity log, audit query + export |
| `identity/` | Entra SSO, 9 roles, trust tiers, service accounts + API keys |
| `portfolio/` | SeamlessFM only — client, FM company, billing entity, site |
| `work-orders/` | record, lifecycle, intake, accept/decline, routing, comments, feed |
| `integrations/ecotrak/` | connection, status map, shadow inbound, live intake, outbound |
| `money/` | **link-out button only** — opens the existing third-party tool. Mapping deferred. |

### Out

Obligations engine (**instrumentation still lands — see Phase 3**) · messaging/Quo · vendors · automations · receivables/payables · notifications · analytics beyond existing KPIs · ClickUp sync adapter · Corrigo + ServiceChannel adapters.

---

## 2. Decisions locked

- **Modular monolith + worker process.** Three deployables, one repo, one schema.
- **Backend and frontend stay separate.** Fastify API + Vite SPA; no combined framework.
- **Auth:** Microsoft Entra ID SSO for authentication; roles and trust tiers held **in-platform**, not in Entra groups — promoting someone from probation shouldn't need an IT ticket.
- **ClickUp:** platform-only for Incoming WOs. No sync adapter is built.
- **Deployment:** local Docker Compose only. Hosting choice deferred.
- **Data access:** raw SQL retained. Drizzle deferred to R2 — rewriting all data access on top of the Postgres swap, the restructure, and a new integration multiplies risk without moving the pilot.
- **Status:** one general (canonical) status + internal sub-statuses. `Phase` collapses into canonical rather than adding a third vocabulary.

---

## 3. The status model

```
general status (canonical)   ~12 values · stable · the ONLY thing crossing to any CMMS
        ^ every sub-status maps to exactly one (NOT NULL FK)
sub-status (internal)        the existing 19 · never leaves the building
```

Canonical set — the 9 existing phases plus the 3 terminals `Phase` currently expresses as `null`:

`received` · `assessing` · `quoting` · `awaiting_client` · `scheduled` · `in_progress` · `awaiting_parts` · `completed` · `invoiced` · `declined` · `cancelled` · `on_hold`

Two invariants:

1. **The general status is derived, never set.** Users pick the sub-status; canonical follows the FK. Two independently editable fields produce records where general is `completed` and sub is `quoting`, with no way to say which is true.
2. **Inbound CMMS statuses never write the sub-status.** They land as facts, classified authoritative / advisory / divergent.

### Inbound classification

| Bucket | Examples | Effect |
|---|---|---|
| Authoritative | cancelled, quote approved/rejected, NTE raised, priority escalated | fires a defined internal transition |
| Advisory | "vendor en route", "work started" | activity row only, no status change |
| Divergent | they say Closed, we are mid-quote | raises for human reconciliation |

---

## 4. Prerequisites — start now, these have lead time

| # | Item | Blocks | Owner |
|---|---|---|---|
| P1 | **Entra app registration** — tenant ID, client ID, secret, redirect URI for `http://localhost:5173` | Phase 4 | Jordan / IT |
| P2 | **Ecotrak status list** — UI screenshot, CSV, or authenticated call. Not extractable from the public docs. | Phase 7 map | Jordan |
| P3 | **Billing entities** — all six (SFM/AF/BKR/TPM/RF/EDS) or SFM only? | Phase 5 | Jordan |
| P4 | **Site list** — import a list, or do sites arrive via Ecotrak intake? | Phase 5 | Jordan |
| P5 | **Money tool URL** — does the button need WO context (deep link) or just open the tool? | Phase 6 | Jordan |

---

## 5. Phases

### Phase 0 · Ground — 1–2 days

Everything after this is refactor-heavy and largely agent-driven. There is currently no test suite and no CI.

- Land in-flight S5 work on a branch and commit (24 modified + 17 new source files are uncommitted)
- Vitest + `npm test`; GitHub Actions running typecheck + test on push
- Characterization tests: **quote-math parity** (assert web and API produce identical output), status transitions, route smoke tests
- `.gitignore`: `pgdata.bak/`, `pgtest-onedrive/`
- Move `playwright-core` out of web `dependencies`

**Done when:** CI is green on push, and the parity test passes against both money implementations.

### Phase 1 · Postgres + worker — 3–4 days

> The `docker-compose.yml` comment claims the upgrade is "a connection-string swap." **It is not.** `getDb()` and `db.transaction()` are called directly in about six services, `migrate.ts` uses PGlite's `db.exec()`, and date plus `text[]` parsing assumptions are baked in.

- Replace PGlite with node-postgres `Pool` behind the existing `query()` seam
- Add `withTransaction(fn)`; rewrite direct call sites in `feed.ts`, `messages.ts`, `payments.ts`, `quotes.ts` (×2), `obligations.ts`
- `migrate.ts`: `db.exec()` → multi-statement `client.query()`
- Audit date parsing (`activity.ts`, `feed.ts`) and `text[]` parsing (`messages.ts`) — Phase 0 tests catch regressions
- Remove the now-pointless "resolve the actor before the transaction opens" workarounds
- `apps/worker` entrypoint + pg-boss

**Done when:** one command brings up db + api + worker + web, and api and worker hold connections simultaneously — the thing PGlite structurally blocked.

### Phase 2 · Module restructure — 1–2 days

- Move `routes/` and `services/` into `modules/<name>/`
- `dependency-cruiser` config encoding the agreed graph; CI enforces it

**Done when:** the tree matches, depcruise passes, tests still green.

### Phase 3 · Status spine — 2–3 days

- Migration: `canonical_status` (12 seeded rows), `status.canonical_key` NOT NULL FK, backfilled from `PHASE_BY_STATUS_NAME`
- `shared`: `Phase` → `CanonicalStatus`; web `PhaseBar` renders canonical
- **A single transition chokepoint that writes `activity(from, to, at)` on every status change**

The bolded item is the time-critical one. PRD metrics M2–M5 all say "instrumented from pilot day 1." If a status change only overwrites `task.status_id`, time-in-prior-status is gone permanently and M4 is unanswerable at the R1 gate. Build the log now; the obligations engine can follow later.

**Done when:** every status change routes through one logged function, and canonical is derivable for every WO.

### Phase 4 · Identity — 3–4 days · needs P1

- Entra OIDC authorization-code + PKCE; session cookie
- `principal` ↔ Entra `oid`; JIT provisioning on first login
- 9 roles + trust tiers in-platform; route-level authz middleware
- Service accounts + API keys (the Ecotrak worker authenticates as one)
- **Delete `X-Actor-Id`** — it is unauthenticated impersonation and must not reach any reachable environment

**Done when:** pilot users sign in with their M365 accounts, `X-Actor-Id` is gone, API-key auth works.

### Phase 5 · Portfolio — 2–3 days · needs P3, P4

- Migration: `client`, `fm_company`, `billing_entity`, `site`
- Migrate today's dropdown and custom-field values to entities; seed SeamlessFM
- WO foreign keys to client and site

**Done when:** work orders reference real entities rather than free text.

### Phase 6 · Work orders — 3–4 days · needs P5

- Intake queue; accept/decline with reason
- Routing to OM books
- Comments + feed + `client_visible` enforcement
- Money link-out button, marked as a pending integration

**Done when:** a WO runs intake → accept → route → update → soft close.

### Phase 7 · Ecotrak — 5–7 days · needs P2

- Migration: `cmms_connection`, `cmms_status_map`, `cmms_event_raw`, `cmms_wo_link`
- Port interface in **domain terms** (`fetchOpenWorkOrders`, `pushStatusUpdate`) so a future adapter can be REST, CSV, or email; the Ecotrak adapter implements it
- **Shadow inbound:** poll → land the raw payload verbatim → map → propose. Zero writes to live WOs.
- Run shadow about a week against sandbox, diff against what ops actually did, correct the map
- Promote to live intake
- Inbound status as events (authoritative / advisory / divergent)
- Outbound, TL-gated, `client_visible` only — **last**

Outbound is last because a bad inbound map is internal cleanup, while a bad outbound push is a client-visibility incident — a stop-the-line event per the PRD.

**Done when:** Ecotrak work orders land automatically, and status divergence surfaces for a human instead of silently corrupting state.

---

## 6. Estimate

**About 20–29 working days, or 4–6 one-week sprints**, at the roadmap's assumed one full-time builder plus AI agents.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Entra app registration lead time | Start P1 today; Phases 0–3 do not depend on it |
| Ecotrak status semantics differ from the docs | The shadow week exists to find exactly this; raw payloads are retained so the map can be re-run without re-fetching |
| No ClickUp fallback at cutover | R1 gate is "one week with zero ClickUp fallback" — keep the pilot to Incoming WOs only |
| Obligations deferred | Phase 3 instrumentation is non-negotiable; these metrics cannot be backfilled |
| Money stays third-party | Accepted. The button is a marked pending task, not a hidden gap. |

---

## 8. Decisions from the Ecotrak status workflow — 2026-08-18

Produced by 4 parallel research lenses, an adversarial skeptic pass (17 challenges), and a merge review. 21 statuses mapped, 6 left unsettled pending vendor answers.

### 8.1 Shadow week ships with ZERO authoritative rows

The skeptic's central finding, accepted. Every Ecotrak value lands as a **logged fact** during the shadow week — nothing writes status, nothing pushes outbound. Rationale: the guards those authoritative rows depend on do not exist yet (no transition allowlist on work orders, no `cmms_wo_link`, no reconciliation queue, no outbound event log for echo suppression), so "raise for human reconciliation" currently resolves to an `activity_log` append nobody reads.

This costs nothing — the plan already sequenced shadow-first and outbound-last — and it answers the open semantic questions from real payloads rather than by argument.

Note: `quotes.ts:844` already implements the needed pattern as `assertTransition(from, expected, to)` with an `allowed_from` allowlist. Work orders need the same thing applied, not invented.

### 8.2 Rejected proposal → BFI (bill for incurred)

**Decided by Jordan.** A rejected proposal is neither "job dead" nor "re-quote." It moves to **completed**, and the dispatcher is tagged **BFI — Bill For Incurred**.

This maps cleanly onto the existing quote model with no new arithmetic. `RULE B` (`quotes.ts:89`) already states the incurred subtotal *"is already on the work order and bills with the job."* So:

- `proposal rejected` (authoritative) → forward transition into the done group, flagged BFI
- The invoice draws on the existing `incurred_subtotal`, **not** `grand_total`
- The dispatcher is notified

Guards required: forward-only from Approval-phase statuses; and **warn when `incurred_subtotal` is 0** rather than silently completing a zero-value job — that is either a legitimate no-visit quote or a missed diagnostic capture, and the two must not be indistinguishable.

### 8.3 Canonical gains a 13th value: `approved`

The 12-value set had no way to express "client authorised the work, nothing booked yet" (internal `approved`). Folding it into `scheduled` would tell a connected CMMS a visit exists when none does, and would destroy measurement of the approval-to-schedule gap — BR-OBL-010, a live 2-business-hour clock. Inserted between `awaiting_client` and `scheduled`.

### 8.4 Status vocabulary changes — approved, ships as one migration

**Decided by Jordan.** Every status name is a join key across obligations, KPIs, and clock history, so these land together:

- **Split `!! canceled/postponed`** into `cancelled` and `postponed`. Without it a paused job and a dead job are indistinguishable in our own data, receivables cannot separate recoverable pipeline from write-offs, and the Ecotrak `deferred` mapping is unimplementable (it would need two canonicals from one sub-status, breaking the NOT NULL FK invariant).
- **Add `declined`** — canonical `declined` is currently unreachable from any of the 19, yet BR-WRK-004 (Block level) requires every decline be recorded with decider and reason.
- **Accept a synthesized reason** when a machine cancellation arrives from Ecotrak with none attached.

Deferred: an `accepted` sub-status, until dispatch asks for hire-progress visibility. Explicitly rejected: any RMA sub-status — RMA is a property of a **part line**, not the work order, and belongs in the R1 structured-parts stage (`part_order.fulfillment_path` / `rma_state`). One WO can mix RMA and purchased parts.

### 8.5 Ecotrak check-ins ARE contractually required — Phase 7 grows

**Confirmed by Jordan.** This invalidates the pure projection model: strict internal → canonical → Ecotrak leaves `scheduled` and `in_progress` with no outbound target, so the client would see nothing between "proposal submitted" and "completed" on every job.

Phase 7 gains an **event-driven telemetry channel**, separate from status projection:

- Check-ins are **OA-confirmed or dispatcher-triggered — never automatic guesses.** A wrong "arrived" is a client-visibility incident (BR-ACC-001), a stop-the-line event.
- Open design question: technicians have no login in v1, so the likely trigger path is the **Quo channel** — the tech texts the dispatcher, who confirms, which emits the check-in. This couples Phase 7 to the messaging module, currently out of MVP scope. Needs resolving before Phase 7 starts.

### 8.6 Still blocked on Ecotrak — one email

1. The full string behind `completed pending re…`
2. Whether `rma received` = authorization arrived (wait continues) or part arrived (wait over)
3. Whether the wire value is literally `approfved` or `proposal approved`
4. Who triggers `rfp submitted` — them issuing to us, or our response echoed

Items 1 and 2 have readings that map to opposite ends of the pipeline. Both approval spellings will be mapped to the same target regardless, with an alert when the unexpected one appears.

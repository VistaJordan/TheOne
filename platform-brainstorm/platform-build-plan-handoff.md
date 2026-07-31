# The Platform — Build Plan (Handoff Brief for Claude)

**Date:** 2026-07-29 · **Stakeholder:** Jordan Brown (jordan@seamlessfm.com)
**Companion docs (same folder):** `clickup-map-handoff.md` (ground-truth workspace map — READ FIRST), `platform-architecture-proposal.md` (full architecture rationale), `clickup-feature-inventory.md` (feature tiering), `clickup-raw/` (25 raw ClickUp API dumps), `PLAN.md` (stakeholder-facing plan this brief expands).

You are building **"the Platform"**: a self-hosted replacement for ClickUp that becomes the operational base layer of SeamlessFM's system. This brief is self-contained; the companion docs add depth.

---

## 0. REALIGNMENT — 2026-07-29 (read first; supersedes anything below that conflicts)

This brief was drafted from ClickUp data alone. It has since been realigned against **Jordan's work-order lifecycle walkthrough** — the business truth ClickUp couldn't show. Ground truth precedence: (1) this section, (2) `../product/wo-lifecycle.md` (v3 — the 15-stage lifecycle + roles glossary), (3) the rest of this brief, (4) companion docs.

**Scope decision (2026-07-29): PROTOTYPE FIRST, LOCAL FIRST**
- The One v0 is a **local prototype with minimal functionality**. A builder will rebuild it properly afterward; the prototype's job is to prove the lifecycle end-to-end and win user/leadership buy-in — not to be production software.
- "Scalable from the get-go / easy to upgrade" is honored through the **data model, not infrastructure**: the Phase 0 schema commitments (§4, plus `vendor`, `payable`, `client_visible` from this section) must be correct even in the prototype. **The schema is the contract that survives the rebuild; UI code is disposable.** Keep the stack boring (local Postgres via Docker Compose, TS API, React) so the rebuild is an upgrade, not a rewrite.
- **Hosting (decision #4): deferred.** Run everything locally (Docker Compose: Postgres + API + web). No spend now; the same Compose file is the upgrade path to a VPS later.
- Phases 2–3 below remain the long-term direction but are NOT prototype scope.

**Naming & brand**
- Working product name: **"The One"** (placeholder — will change; don't bake the name into identifiers).
- Design system: **`../UI Essentials/`** — `seamlessfm-brand-kit 1 (1).html` (black surfaces, Seamless blue `#35b8f3` + dark/light variants, navy `#0a1628`, teal `#00a878` accent, Barlow / Barlow Condensed / Inter) plus logo-on-black, logo-on-white, and mascot PNGs. This supersedes the old `Zeus/seamlessfm-brand-kit 1.html` pointer. The screens in `../mockup/` predate this decision and use different tokens — treat them as layout/content references, restyle to the brand kit.

**Lifecycle deltas (each is a change to scope or schema)**
1. **Intake is 5 sources, not 1:** Corrigo, Ecotrak, ServiceChannel, **email**, and **Seamgo** (our own software). Build the intake pipeline **source-agnostic from day one** (a WO record never cares where it came from; adapters normalize per source). Phase 1 still ships **only the Ecotrak adapter** (Jordan-approved). Ecotrak **staging** OAuth2 credentials live in the root `.env` (never commit); API docs: https://api-docs.ecotrak.com/.
2. **Accept/Decline is a real pre-intake stage** (ATL/TL/AM decide before a WO enters the pipeline). Record the decision, decider, and reason — declined WOs are data, not silence. Part of Phase 1 intake.
3. **Technicians are EXTERNAL subcontractors, not platform users.** They are sourced per job (Hire stage). New schema commitment: a **`vendor`** (tech) entity — one pooled company dataset with a per-OM "my book" lens, trade + geography coverage, rates, payment terms, payment history. Phase 1 needs at least a minimal vendor record (who was hired on this WO); the full sourcing map is Phase 2. ⚠️ The "~35 tech lists" in the ClickUp map are believed to actually be **OM (dispatcher) books, not technicians** — CONFIRM with Jordan before writing the import mapping.
4. **Client-facing visibility boundary (schema-critical, Phase 0):** not all internal updates are shared with clients. Every comment, attachment, and status update carries a **`client_visible`** flag (default false). Outbound sync to client CMMS (the "TL Rep" stage) = per-CMMS adapters that push only client-visible updates. Generic outbound webhooks are not a substitute.
5. **Money flows both ways.** The **AP team pays the tech at soft close** → `payable` records tied to vendor + WO (amount, status, terms). Downstream: AR audit → invoice → **collection** (follow-ups until paid). Profit-per-WO = invoiced − cost falls out of receivable + payable, not a formula field alone.
6. **Sibling systems:** **Argus** (AR-audit process) and **Seamgo** (intake source) will ideally be **absorbed** as modules of The One — keep module boundaries clean (intake / dispatch+vendors / quoting / client-sync / AR-audit / invoicing+collections). Zeus plan unchanged (Phase 3).
7. **Roles have trust tiers** (OM: coordinator→standard→senior; AR: probation→standard→senior→HAR). The ACL model must express per-tier capability differences, not just view/comment/edit/full on containers.
8. **Teams PDF side-channel:** intake today also posts WOs as PDFs to Teams where ATL/TL assign dispatchers a second time. Phase 1's exit criterion should include retiring this dual-assignment for the pilot users (or consciously feeding Teams from the Platform, not by hand).

---

## 1. Context you must internalize

- **The business:** SeamlessFM / Byblos Vista / Alpha Fixers — one facilities-maintenance operation, three brands. ~98 ClickUp users today (dispatchers, technicians, account managers, execs, 5 read-only client guests). Work orders (WOs) arrive from client systems (Ecotrak) via webhook, move through a 19-status pipeline across per-person routing lists, and end in an archive of ~17,770 invoiced WOs (~21K tasks total).
- **What ClickUp actually is for them:** a structured WO database (~100 custom fields per task, 13 field types incl. formulas for SLA-aging/profit), a pipeline engine (custom statuses), a routing system (lists per tech/AM; moving tasks between lists = dispatch), and a reporting layer (table views, dashboards, a geographic map view, multi-homed exec rollups). One task = one WO, completely flat: no subtasks, no dependencies, no sprints/gantt/goals/time-tracking in real use.
- **Zeus:** an existing separate app — infinite-canvas macro-planner (React + Vite + TS + React Flow + Yjs + y-indexeddb, plain CSS with SeamlessFM brand tokens). Its stack is locked FOR ZEUS. In Phase 3 it becomes a live view over Platform data. Do not rebuild or disturb it before then.
- **Team reality:** 1–2 devs + AI agents (you) doing most of the building. Optimize for boring, comprehensible, AI-legible code.
- **Hard rule:** the existing ClickUp workspace is **READ-ONLY, forever, from every project**. GET requests only. The one-time migration is a read-only pull. Never POST/PUT/PATCH/DELETE to ClickUp, never create webhooks there.

**Guiding principle: build ClickUp's primitives, not its features.** Custom fields, statuses, views, automations. WOs, audits, and future use cases must be configuration, not code.

## 2. Working decisions (defaults — confirm #4 with Jordan before spending)

1. **Architecture:** server-authoritative. Postgres is the single source of truth. No sync engine in v1; re-evaluate **Zero (Rocicorp)** at the Phase 2 gate. No CRDTs for structured records, ever.
2. **Custom fields:** hybrid storage — `field_def` table + per-task JSONB values + ~15 promoted/generated indexed columns for hot filters. No pure EAV.
3. **Formulas:** definitions stored as ASTs; values computed server-side on write / dependency change and persisted. Now-relative aging ("Days Since X") computed in SQL at read time — never stored.
4. **Hosting:** managed Postgres (Neon/Supabase/RDS) + one small VPS running API + worker via Docker Compose. *(Involves spend — Jordan confirms.)*
5. **Multi-brand:** brand is a field (`billing_entity`, mirroring today's "21. Comp" dropdown), not a workspace/space split.
6. **Zeus boundary:** Phase 3 adds Yjs CRDT islands for canvas/doc collab, reusing Zeus's stack; structured data stays relational.
7. **Auth:** lightweight/self-hosted (e.g. Lucia-style session auth or self-hosted Ory) with **first-class service accounts** — bots/AI agents are principals with scoped API tokens; every write is attributed.
8. **Search:** Postgres FTS (`tsvector`) + `pg_trgm`. No external search service in v1.
9. **Files:** S3-compatible object store (S3 or MinIO) from Phase 1 — WO PDFs arrive at intake.
10. **Email-in:** Phase 2, via an inbound-email provider webhook → comment/task creation.
11. **Notifications:** table + in-app inbox in Phase 1; email digests Phase 2.

## 3. Stack

PostgreSQL 16+ (`ltree`, `pg_trgm`, JSONB+GIN) · TypeScript everywhere · tRPC for the SPA + a thin REST edge for webhooks/bots (Fastify or Hono) · Zod at every boundary · pg-boss for jobs · WS or SSE invalidation push · React 18 + Vite + TanStack Query/Table/Virtual · plain CSS using SeamlessFM brand tokens (black surfaces, accent `#35b8f3`, Barlow Condensed headers / Barlow body — see `../UI Essentials/seamlessfm-brand-kit 1 (1).html`) · Drizzle or Kysely for typed SQL (pick one, stay consistent) · Vitest · Docker Compose.

**New repo, separate from Zeus.** Suggested layout: `apps/web`, `apps/api`, `apps/worker`, `packages/schema` (DB + Zod + shared types), `packages/grammar` (the predicate grammar), `docs/`.

## 4. Data model (the part you must not get wrong)

Schema-critical commitments — all exist from Phase 0 even where UI comes later:

- **Hierarchy:** `workspace → space → folder → list` rows, adjacency (`parent_id`) + materialized `ltree` path for subtree ops and ACL resolution. Tasks are NOT tree nodes.
- **`task`:** flat WO record. Keep `parent_task_id` nullable for future subtasks (unused in v1). Fields: title, description, `home_list_id`, `status_id`, denormalized `status_group`, `billing_entity`, assignees (M2M `task_assignee`), dates, `fields JSONB`, soft-delete, timestamps.
- **`task_list_membership(task_id, list_id, is_home)`:** tasks-in-multiple-lists is in production use today (2,056-task exec rollup). Exactly one `is_home=true` row per task (partial unique index). The home list determines applicable field schema + status set. **Routing = updating membership.** Log every move to the activity log.
- **`status_set` / `status`:** sets attach at space (optionally folder/list) with inheritance — resolver walks up the path; current workspace inherits space-level everywhere. Each status has `type` ∈ {open, active, done, closed} (= "status group"); groups drive open/closed filters, progress, dashboards.
- **`field_def`:** scoped to a container, shared across its lists (today: one shared ~100-field schema). Types (13, all used today): checkbox, short_text, long_text, dropdown, date, users, formula, currency, attachment, location, emoji/rating, url, number. `type_config JSONB` holds option sets (dropdowns run 40–120 options), formula AST, etc. Task values live in `task.fields` JSONB keyed by field id; promote hot fields (status_group, AM, City, State, Trade, Client, FM, Date-Time Received, SLA due, billing_entity…) to generated indexed columns.
- **`activity_log`:** immutable, append-only, every mutation with actor principal id, before/after per field. This feeds completion audits — treat as a product feature, not plumbing.
- **`outbox`:** transactional event stream written in the same transaction as every mutation. Single driver for automations, notifications, outbound webhooks, search indexing. Worker consumes via pg-boss.
- **`principal`:** humans, guests, **service accounts** (bots/AI agents) in one table; API tokens hashed; all authorization and attribution flows through principals.
- **`acl_entry`:** subject (principal/role) → object (any hierarchy node) → level (view/comment/edit/full), inherited down the `ltree` path; most-specific wins. Guests get list/dashboard-scoped grants (today: 2 exec guests see only dashboards).
- **`view_def`:** saved views = JSON predicate documents over **one shared grammar** (filter/sort/group/aggregate). The same grammar powers views, dashboards, automation conditions, and search filters. Design it once in `packages/grammar`; compile to parameterized SQL server-side.
- **`automation_rule` / `automation_run`:** trigger → condition (grammar predicate) → actions. Runs are idempotent via unique `(rule_id, task_id, trigger_event_id)`; loop-guard via cascade depth counter + per-event visited-rule set; every run logged.
- **`notification`:** per-principal inbox rows fed from outbox events.
- **`attachment`:** object-store key + metadata, linked to task/comment/field value.

## 5. Hard-problem guidance (from the architecture doc — follow unless you find a real blocker)

- **View engine:** execute filtering/grouping/sorting **server-side in SQL** over indexed columns; paginate; virtualized table rendering client-side. Dashboards aggregate in Postgres. Never ship all 21K tasks to the browser.
- **Formula engine:** implement ONLY the shapes in production (see map §5): date-diff aging, currency arithmetic (profit = invoiced − cost), simple conditionals. It is not a general expression language in v1.
- **Realtime:** WS/SSE channel broadcasting invalidation events (entity + id) from the outbox; clients re-fetch via TanStack Query. Field-level last-write-wins; conflicts are rare (different users touch different fields) and the activity log is the arbiter.
- **Permissions:** enforce in one choke point (tRPC middleware / service layer), resolving ACL against the `ltree` path. Never in the UI only.
- **Automations:** run in the worker, never inline in request handlers. Actions mirror today's usage: set field, change status, move/add to list, assign, notify, call outbound webhook, create task.
- **Ecotrak intake (Phase 1 core):** signed inbound webhook endpoint → normalize payload → create WO in "Incoming WOs" list. The existing `Downloads/ECOTRAK API/` project contains the field-mapping logic and logs — use it as the normalizer spec (note its `.env` mentions a mapping flag `DRY_RUN`-style behavior; replicate that pattern: log + map without creating until flipped live).
- **ClickUp import (Phase 2):** one-time read-only ETL. Pull field defs → build `field_def` rows; pull all tasks per list (paginated, ~100 req/min rate limit) → map statuses/fields/assignees → bulk COPY. Dry-run into staging first; reconcile per-list/per-status counts against `clickup-map-handoff.md` §3/§4 numbers before cutover. ClickUp is never written to.

## 6. Phases — scope and exit criteria

### Phase 0 — Walking skeleton (~1–2 wks)
Migrations for §4 in full · auth + principals + service accounts · tRPC API · seed one space/list with the real 19-status set and a subset of real field defs (pull names/types from `clickup-raw/field_*.json`) · React shell with ONE working table view driven by the grammar · Docker Compose deploy.
**Exit:** WO created via API appears in a live table view; the write is in the activity log; build + typecheck green.

### Phase 1 — Replace "Incoming WOs" intake (~3–5 wks)
Ecotrak webhook → normalized WO · full WO form (all 13 field types, server-side formula eval) · 19-status pipeline + status-group filters · move-between-lists routing · table + board views · activity log UI · attachments (S3) · notifications inbox · ~5 dispatch users in production.
**Exit:** a real Ecotrak WO flows in, is routed to a tech list, reaches done — entirely on Platform; dispatch runs intake one week with zero ClickUp fallback.

### Phase 2 — Parity with actual usage (~6–10 wks)
Dashboards (exec rollups over 20K+ rows incl. multi-homing) · calendar, map (location field → pins), workload views · saved/shared views · automations engine at parity with current ClickUp rules · one-time import (21K tasks) · ACL + guest access replicating the 2 exec-guest dashboards · FTS search · outbound webhooks · email-in. **Gate:** re-evaluate Zero for live-query UX before building more realtime plumbing.
**Exit:** 30–100 users live; ClickUp Vista space read-only → decommissioned; guests on Platform dashboards; automations at parity.

### Phase 3 — Zeus + AI actors (~6–10 wks)
Zeus canvas reads live Platform data (macro nodes ↔ lists/spaces, roll-ups from status groups) · Yjs islands (canvas, doc bodies) via self-hosted y-websocket, rooms authorized by core-issued ACL tokens · AI agents as service principals (triage incoming WOs, run automations, edit canvas/docs as collaborators) · custom task types (WO / Audit).
**Exit:** an AI agent triages a real WO and the change appears on the Zeus canvas in real time.

## 7. Explicitly out of scope

Gantt/timeline, sprints/points/velocity, milestones, goals/OKRs, time tracking, subtask & dependency **UIs** (schema stays ready), whiteboards/mind-maps (Zeus owns canvas), chat/clips/meeting AI, SSO/SAML/SCIM, billing/plans, integrations marketplace, mobile apps (Phase 4+ candidate; pairs with adopting Zero for offline). If you find yourself building any of these, stop and re-read the map.

## 8. Risks & standing orders

- The **custom-field engine is the product** — before UI work, review your DDL against the real 102-field inventory in `clickup-raw/` and map §5.
- Keep formula scope pinned to the ~10 real shapes.
- Table performance: promoted columns + server-side SQL from day one; test against a 25K-row seed early (generate synthetic WOs matching real field-fill distributions, map §7).
- Import: dry-run + count reconciliation before any cutover claim.
- **Never write to ClickUp.** Never commit tokens (they live in local `.env` files; see `clickup-map-handoff.md` §1).
- Bus factor: boring stack, docs-in-repo as you go, conventional code an AI agent can navigate cold.

## 9. Open items for Jordan (don't block Phase 0 on these except #1–2)

1. Hosting spend approval (decision #4). 2. Repo name/location. 3. Auth provider final pick (decision #7 shape). 4. Email-in provider (Phase 2). 5. Zero adoption (Phase 2 gate). 6. Guest onboarding for SFM execs (Phase 2).

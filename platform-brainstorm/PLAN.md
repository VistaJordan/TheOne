# SeamlessFM Platform — Master Plan

**Date:** 2026-07-24 · **Status:** Ready for Jordan's sign-off
**Inputs:** [clickup-workspace-map.md](clickup-workspace-map.md) · [clickup-feature-inventory.md](clickup-feature-inventory.md) · [platform-architecture-proposal.md](platform-architecture-proposal.md)

---

## 1. Objective

Replace ClickUp as the operational base layer of SeamlessFM's system with a self-built platform, scoped to what the Byblos Vista workspace **actually uses**: a structured work-order record engine (~100 custom fields), a 19-status pipeline, routing lists, table/board/dashboard/calendar/map views, automations, and webhook intake — designed from day one for ~100 users, guest access, and AI/bot actors as first-class citizens. Zeus becomes a view on Platform data in the final phase.

**Guiding principle:** build ClickUp's *primitives* (fields, statuses, views, automations), not its *features*. Work orders, audits, and future use cases become configuration, not code.

---

## 2. Working decisions (defaults — flip any before Phase 0 ends)

| # | Decision | Default we proceed with |
|---|---|---|
| 1 | Sync layer | Plain Postgres + tRPC + WS push now; re-evaluate **Zero** at Phase 2 gate |
| 2 | Custom-field storage | Hybrid: `field_def` table + JSONB values + ~15 promoted indexed hot columns |
| 3 | Formulas | Persist computed values on write; now-relative aging (`Days Since X`) computed in SQL at read |
| 4 | Hosting | Managed Postgres (Neon/Supabase/RDS) + one small VPS/container for API + worker |
| 5 | Multi-brand | **Brand-as-field** (matches today's `21. Comp` dropdown reality — corrected from proposal's space-per-brand) |
| 6 | Zeus boundary | Zeus keeps its Yjs stack as CRDT islands; structured data projected from the core; no Zeus rewrite |
| 7 | Auth | Lightweight/self-hosted auth with first-class **service accounts** (bots/AI agents = principals with tokens, scoped ACL, attributed writes) |
| 8 | Search | Postgres FTS + `pg_trgm`; dedicated engine only if relevance complaints appear |
| 9 | File storage *(orchestrator addition)* | S3-compatible object store (S3 or self-hosted MinIO) from **Phase 1** — WO PDFs arrive with intake |
| 10 | Email-in *(orchestrator addition)* | Phase 2 via inbound-email service (e.g. Postmark/SES inbound) → task comment/creation; confirm actual usage volume first |
| 11 | Notifications *(orchestrator addition)* | Notifications table + in-app inbox in **Phase 1** (schema-critical); email digests Phase 2 |

---

## 3. Stack

- **DB:** PostgreSQL 16+ (`ltree`, `pg_trgm`, JSONB + GIN)
- **API:** TypeScript, tRPC for the SPA + thin REST edge for webhooks/bots, Zod validation
- **Jobs:** pg-boss worker (automations, formula recompute, outbound webhooks) fed by a transactional outbox
- **Realtime:** WS/SSE invalidation push (upgradeable to Zero at Phase 2)
- **Frontend:** React + Vite + TS, TanStack Query (+ Table/Virtual for the table view), plain CSS with SeamlessFM brand tokens (consistent with Zeus)
- **Files:** S3-compatible object store
- **Deploy:** Docker Compose on one VPS + managed Postgres

## 4. Phase 0 schema commitments (expensive to retrofit — get these right first)

| Table (group) | Purpose |
|---|---|
| `workspace / space / folder / list` | Hierarchy: adjacency + `ltree` path; shallow tree, cheap subtree moves |
| `task` + `task_list_membership(task_id, list_id, is_home)` | Flat WOs; **M2M with home-list** — home list defines schema + status set; routing = membership row update |
| `status_set / status` | Container-scoped with inheritance (space→folder→list), **status groups** (open/active/done/closed) denormalized onto task |
| `field_def / task.fields JSONB` + hot columns | 13 field types incl. formula (stored AST), dropdown option sets, per-container scoping |
| `activity_log` | Immutable, every write attributed (human or service account) — feeds audits |
| `outbox` | Single transactional event stream driving automations, notifications, outbound webhooks, search indexing |
| `principal / service_account / api_token` | Humans, guests, bots/AI agents under one ACL model |
| `acl_entry` | Role + per-container grants with hierarchy inheritance (resolve via `ltree`) |
| `view_def` | Saved views = predicate documents (shared filter/sort/group grammar as JSON) |
| `automation_rule / automation_run` | Trigger/condition/action + idempotent run log, loop caps |
| `notification` | Per-principal inbox entries fed from outbox |

## 5. Phases

### Phase 0 — Walking skeleton (~1–2 wks, target ~Aug 7)
Schema above migrated; auth + principals; tRPC API; one seeded space/list; React shell with **one working table view** driven by the filter grammar; deployed.
**Exit:** create a WO via API → appears live in the table view → write lands in activity log. Build + typecheck green.

### Phase 1 — Replace "Incoming WOs" intake (~3–5 wks, target ~mid-Sep)
Ecotrak inbound webhook → normalize → WO created. Full WO record form (all 13 field types, server-side formula eval). 19-status pipeline + group filters. Move-between-lists routing. Table + board views. Activity log UI. **Attachments (S3) + notifications inbox.** ~5 dispatch users.
**Exit:** a real Ecotrak WO flows in, routes to a tech list, and reaches done **entirely in the new system**; dispatch runs intake for one week without falling back to ClickUp.

### Phase 2 — Parity with actual usage (~6–10 wks, target ~Nov)
Dashboards (exec rollups over 20K+ rows incl. multi-homed pattern), calendar, **map** (location field, dispatch), workload. Saved/shared views. **Automations engine** replicating current ClickUp rules. **One-time ClickUp import** (21K tasks, read-only pull — writes to ClickUp remain forbidden). ACL + **guest access** for the exec dashboards (the two SFM guests). FTS search. Outbound webhooks. Email-in. **Gate: re-evaluate Zero** for live-query UX.
**Exit:** ~30–100 users on Platform; the Vista space in ClickUp is read-only/decommissioned; guests use exec dashboards; automations at parity.

### Phase 3 — Zeus + AI actors (~6–10 wks, target ~Jan 2027)
Zeus canvas renders live Platform data (macro nodes ↔ lists/spaces, roll-ups from status groups). Yjs CRDT islands (canvas, doc bodies) via self-hosted y-websocket, gated by core ACL tokens. AI agents as service principals: triage incoming WOs, run automations, edit canvas/docs as live collaborators. Custom task types (WO / Audit).
**Exit:** an AI agent triages a real WO and the change appears on the Zeus canvas in real time.

**Timeline summary:** first real workflow live in ~5–7 weeks; ClickUp parity ~month 3–4; Zeus + AI ~month 4–6.

## 6. Explicitly not building

Gantt/timeline, sprints/points/velocity, milestones, goals/OKRs, subtask nesting (schema allows `parent_id`, UI deferred), dependencies UI (schema-latent), time tracking, whiteboards/mind-maps (Zeus owns canvas), chat/clips/meeting AI (Slack/Zoom cover it), enterprise SSO/SCIM, billing/plans, integrations marketplace, mobile apps (Phase 4+ candidate for field techs — Zero's offline story is the latent asset here).

## 7. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Custom-field engine under-designed (it IS the product) | Phase 0 DDL review against the real 102-field inventory in the workspace map before any UI code |
| Formula engine scope creep | Ship the ~10 formula shapes actually used (aging, profit arithmetic) — not a general expression language v1 |
| Table view performance at 20K–100K rows | Server-side SQL execution + promoted columns from day one; virtualized rendering; archive lists load paginated |
| One-shot import fidelity | Dry-run import into staging; reconcile counts per list/status against the map; keep ClickUp read-only (never decommission before Phase 2 exit) |
| Ecotrak webhook contract unknowns | Reuse the existing ECOTRAK API project's mapping code/logs as the spec for the normalizer |
| Solo-maintainer bus factor | Boring stack, heavy docs-in-repo, AI-agent-friendly codebase conventions from Phase 0 |

## 8. Immediate next actions

1. Jordan signs off / amends the 11 working decisions (§2).
2. Confirm repo home for the Platform (new repo, separate from Zeus).
3. Phase 0 DDL design session: draft actual `CREATE TABLE` statements for §4 and review against `clickup-raw/` field data.
4. Provision: managed Postgres instance + VPS + S3 bucket + domain.
5. Locate Ecotrak webhook payload samples (ECOTRAK API project) for the Phase 1 normalizer spec.

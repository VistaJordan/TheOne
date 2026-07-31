# The One — Feature Map & Sprint Roadmap (v1)

**Date:** 2026-07-29 · **Owner:** Jordan Brown
**Inputs merged:** `wo-lifecycle.md` (v3) · `platform-brainstorm/platform-build-plan-handoff.md` (§0 realignment) · `cmms-meeting-checklist.docx` (vendor evaluation criteria) · Facilio demo breakdown (2026-06-18) · Facilio market research · ClickUp parity map.

---

## Product principles

1. **API-first system of record.** From the CMMS checklist's own decision lens: "you mainly need a stable system of record your own tooling can read and write freely." n8n, Supabase, HubSpot, QuickBooks, OpenPhone, and Power BI are the constellation; The One is the sun. Every entity readable/writable via API + webhooks from day one — n8n is the automation layer until (and even after) a native rules engine exists.
2. **Primitives, not features.** Custom fields, statuses, views, automations as configuration (build plan). WOs, audits, vendor records = configurations of primitives.
3. **Lifecycle-native.** The 15 stages in `wo-lifecycle.md` are the spine. Facilio impressed because it mapped to the lifecycle (AM → dispatcher → vendor → sign-off); The One is built from it.
4. **Prototype first; the schema is the contract.** v0 is local and minimal; a builder rebuilds properly. What must be right early: field engine, membership model, `client_visible`, vendor + payable entities, activity log.
5. **Beat Facilio where it's weak.** Their known gaps (from our demo notes + market reviews): reporting locked inside dashboard widgets, no vendor-portal-free auto-assignment, integrations hand-built per customer, no free trial/self-serve. Ours: live SQL access for PBI, escalation logic designed for external vendors, adapters as first-class modules.

## Feature map — layer by layer

Tags: **[P]** prototype (R0) · **[1]** pilot (R1) · **[2]** cutover/parity (R2) · **[3]** differentiators (R3+)

### L0 · Foundation & core engine
- Custom-field engine — defs + typed values, 13 types, dropdown option sets **[P subset → 1 full]**
- 19-status pipeline + status groups + phase bar **[P]**
- WO record; task↔list M2M with home list **[P]**
- Activity log, every write attributed (humans + service accounts) **[P]**
- `client_visible` flag on every comment/photo/status update **[P]**
- Attachments (local disk in v0 → S3-compatible later) **[P]**
- Principals incl. service accounts for bots/n8n **[P minimal → 1]**
- Transactional outbox / event stream (drives webhooks + notifications) **[1]**

### L1 · Identity, roles & access
- RBAC: TL / ATL / AM / OA / OM (coordinator→senior) / AR (probation→HAR) / AP / exec guest / admin **[1]**
- Trust-tier gating (probation users: restricted actions, review queues) **[1]**
- Per-user data scoping (my book, my entity, my clients — Facilio L2 parity) **[1–2]**
- "TL can push to client CMMS, dispatchers cannot" — outbound gate by role **[2]**
- Audit-log UI, filterable, **exportable** (Facilio couldn't confirm export — we ship it) **[2]**

### L2 · Portfolio: clients, sites, entities
- Client (brand) + FM-company records (40 clients, 120 FMs from ClickUp vocab) **[P as dropdowns → 1 as entities]**
- Billing entities (Comp: SFM/AF/BKR/TPM/RF/EDS) **[P]**
- Sites/locations with geo + store numbers **[1]**
- Multi-entity structure for sister companies (drives per-entity compliance, L4) **[2]**
- Assets/equipment per site, service history, warranty (Facilio L3) **[3]**

### L3 · WO lifecycle engine
- Intake queue + **accept/decline with reason** **[P]**
- Manual WO creation, ordered intake form (the numbered 13.–38. fields) **[P]**
- Routing to OM books (assignment, not list-moving) **[P]**
- Approval fork: wait vs approved-on-site **[P status-level → 1 structured]**
- Soft-close checklists: quote, before/after photos, checkmarks **[1]**
- TL/ATL quote-audit gate **[1]**
- Materials/parts stage (structured, replaces the 12 tags) **[1]**
- NTE guardrails on quotes **[P display → 1 enforced]**
- SLA tracking + aging (Days Since X, grey flags) **[1–2]**
- Exception paths: return trips, recalls, penalties, missed ETA **[2]**
- Time-in-status metrics: response / assignment / resolution / labor time (Facilio 4.5) **[2]**

### L4 · Vendor management (the new vendor-relations department's system)
- Vendor DB: company, contacts, trades, geo coverage (state/county/city), labor rates, trip charges **[1]**
- **Pooled company map + per-OM "my book" lens** **[1]**
- Tiered classification: preferred / approved / probationary — drives dispatch **[2]**
- Compliance docs: W-9, COI, MSA, licenses — amounts, expiry, **per-entity tagging** (Facilio 5.3 validated) **[2]**
- Expiry alerts BEFORE lapse; **compliance gating blocks dispatch** **[2]**
- Vendor onboarding pipeline + standalone onboarding form (no login required — Facilio 5.2 pattern) **[2]**
- Vendor scorecards: response time, completion rate, callback rate, cost variance **[2–3]**
- Vendor invoice capture matched to WO (feeds QuickBooks via n8n) **[2]**
- 1099 tracking off W-9 data **[3]**
- Vendor self-service portal (accept/decline work, upload docs) **[3]**
- **Preferred-vendor auto-assignment** per client+region+trade with timeout escalation (#1 → #2 → #3) — requires portal or SMS/email accept **[3]**
- AI vendor validation (EIN↔COI match, coverage amounts, expiry) **[3]**

### L5 · Money: quotes → invoices → payables → collections
- Financial tab per WO: NTE, quote, cost, profit **[P]**
- **Quote/proposal builder ("Yoda" replacement):** line items, materials, auto-populate from WO, print/send **[1]**
- Quote approval chains (dispatcher → AM/TL → client) **[1–2]**
- Client invoicing + multi-level approval by amount **[2]**
- AP payables: tech payment records at soft close (amount, status, terms) **[P stub → 2 full]**
- AR audit workflows (Argus absorb path) **[2–3]**
- Collections queue: follow-ups, aging, promise-to-pay **[2]**
- QuickBooks sync (invoices out, payments back) **[2]**
- Client contracts / rate cards → auto-invoice contracted work (Facilio 6.1–6.2) **[3]**

### L6 · Integrations & client sync
- REST API with UI parity + native webhooks (created/status/assigned/completed) — n8n-friendly: API keys, no OAuth overhead, sandbox **[1 core → 2 full]**
- **Ecotrak adapter** (staging creds in `.env`, docs: api-docs.ecotrak.com) **[P read → 1 live]**
- Email-to-WO ingestion (replaces Gmail routing) **[2]**
- Corrigo + ServiceChannel adapters **[2–3 — pending feasibility spike]**
- Outbound selective sync: `client_visible` updates only, TL-gated **[2]**
- Seamgo: absorb or bridge (decision owed by R2) **[2–3]**
- HubSpot / Supabase kept in sync via n8n over our API **[1 by API availability]**
- Client-facing portal: submit requests, view status **[3]**

### L7 · Views, dashboards & analytics
- Table view + filters **[P]** · saved/shared views **[1]** · board view **[1]**
- Role dashboards with 2-click drill-down (KPI → list → record; Facilio 7.1) **[1 basic → 2]**
- Approval-aging / bottleneck dashboard (the 46-WO story) **[P demo → 1 live]**
- Map view — geographic WO + vendor dispatch (Gloria's Map parity) **[2]**
- Exec dashboards (Teresa/Ro rollups) **[2]**
- **Live read-replica SQL access for Power BI** (checklist §9 — beats Facilio's widget-only reporting) **[2]**
- Calendar + workload views **[2]**

### L8 · Communication
- In-app notifications inbox, configurable per event **[1]**
- Email digests **[2]**
- **OpenPhone/VoIP click-to-call from the WO + auto call-logging** (Facilio's Twilio dialer, our stack) **[2–3]**
- Teams dual-assignment retirement (platform feeds Teams, or kills the channel) **[1–2]**
- SMS to vendors (dispatch offers, links to upload photos) **[3]**

### L9 · Automations
- Rules engine: trigger → condition → action, run log, loop guards **[2]**
- SLA escalation rules (emergency WOs, aging thresholds) **[2]**
- AM auto-assignment by client list (Facilio: safe to automate; dispatcher assignment stays human) **[2]**
- n8n as the external automation layer from day one (webhooks + API) **[1]**

### L10 · AI (differentiators)
- AI intake triage (parse WO PDFs/emails → structured record) **[3]**
- Copilot Q&A over operational data **[3]**
- AI vendor validation (see L4) **[3]**
- AI outbound vendor follow-up calls **[3+]**

### L11 · Preventive maintenance & assets
- PM schedules (pm-scheduled status + HVAC PM trade exist today) **[3]**
- Asset-linked recurring WOs, service history **[3]**

## Release plan — sprints

Cadence: **1-week sprints**, heavy AI-assisted build. Each sprint ends demoable.

### R0 · Prototype (Sprints 1–4) — local, minimal, real data
- **S1 — Skeleton:** Docker Compose (Postgres+API+web), core schema (L0), brand-kit shell, seeded with real ClickUp sample WOs, basic table.
- **S2 — The WO record:** detail page w/ core fields, 19-status pipeline + phase bar, activity log, `client_visible` toggle, financial tab.
- **S3 — Intake → hire:** intake queue, accept/decline, route to OM book, minimal vendor record, quote + payable stubs; Ecotrak staging read test.
- **S4 — Demo:** bottleneck dashboard, filters, scripted 15-stage demo of hero WO-39403.
- **Gate:** leadership + one OA/OM/AR each confirm "this is our process." Feedback pack → builder.

### R1 · Pilot (Sprints 5–10) — "Incoming WOs" runs here, ~5 users
- **S5 —** Auth + RBAC v1 (roles, trust tiers), notifications inbox.
- **S6 —** Vendor DB v1: trades, geo, rates, pooled + my-book.
- **S7 —** Quote builder v1 (Yoda replacement), NTE enforcement, soft-close checklists w/ photo upload.
- **S8 —** Ecotrak live intake + REST API v1 + webhooks (n8n connected).
- **S9 —** Saved views, role dashboards v1, SLA aging.
- **S10 —** Hardening; pilot go-live.
- **Gate:** dispatch runs intake **one week with zero ClickUp fallback** (build-plan Phase 1 exit).

### R2 · Cutover (Sprints 11–18) — parity + money + sync
- **S11–12 —** Automations engine + SLA escalations + AM auto-assign.
- **S13 —** Compliance module: W-9/COI/MSA, per-entity, expiry alerts, dispatch gating + vendor onboarding form.
- **S14 —** Client invoicing + approval chains, payables full, QuickBooks sync.
- **S15 —** Outbound client sync (Ecotrak first, TL-gated) + email-to-WO.
- **S16 —** Map view, exec dashboards, PBI read-replica.
- **S17 —** One-time ClickUp import (21K WOs) + count reconciliation.
- **S18 —** Rollout waves (team by team), Teams retirement.
- **Gate:** ClickUp Vista space read-only → decommissioned (Phase 2 exit).

### R3 · Differentiators (Sprint 19+)
Vendor portal + preferred-vendor auto-assign escalation · VoIP click-to-call · AI triage + copilot · client portal · scorecards + 1099 · PM/assets · Argus absorption · Seamgo decision · client contracts.

## Standing risks / open decisions
1. **Corrigo + ServiceChannel API feasibility** — unproven; R2's outbound-sync scope hangs on it. Spike ASAP.
2. **Seamgo & Argus boundaries** — absorb-vs-bridge decisions owed by R2.
3. **Per-person ClickUp lists = OM books?** — confirm before S3 routing + S17 import mapping.
4. **Build capacity assumption** — sprints sized for one full-time builder + AI agents; resize if that changes.
5. **Facilio as fallback** — portfolio pricing from ~$25K/yr; if The One stalls, the evaluation checklist is ready. Keep it as leverage, not Plan A.

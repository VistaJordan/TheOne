# PRD-WRK-001 — The One: Work Order Platform (v1)

---

## 0. Document control

| Field | Value |
|---|---|
| **Document ID** | PRD-WRK-001 |
| **Feature name** | Work Order Platform v1 — intake to collection |
| **Module** | WRK (with QUO, PAY, OBL, REC sub-areas) |
| **Status** | Draft |
| **Version** | 0.1 |
| **Author** | J. Brown / Claude (drafted) |
| **Product owner** | Jordan Brown |
| **Business owner** | Jordan Brown |
| **Engineering lead** | TBD |
| **Target release** | R1 Pilot (~5 users, "Incoming WOs" live) |
| **Last updated** | 2026-08-07 |

**Reviewers and sign-off**

| Role | Name | Reviewed | Approved | Date |
|---|---|---|---|---|
| Business owner | Jordan Brown | ☐ | ☐ | |
| Operations lead | | ☐ | ☐ | |
| Engineering lead | | ☐ | ☐ | |
| Finance (touches money) | | ☐ | ☐ | |

---

## 1. Summary

Seamless FM runs ~21,000 work orders through a ClickUp workspace plus five disconnected side tools, with every work order re-keyed on intake, assigned twice (ClickUp and a Teams PDF channel), quoted in a separate tool, paid through another, and audited in a third. The One is a single operations platform that carries a work order natively from intake through dispatch, quoting, approval, fulfilment, technician payment, completion audit, invoicing, and collection — with an internal-versus-client visibility boundary on every update and a clock on everything the company owes. It replaces ClickUp and absorbs the side tools, so nothing about a work order lives outside the system of record.

---

## 2. Problem and opportunity

### 2.1 Problem statement

Operations staff run every work order across ClickUp plus Yoda (quotes), PPR (tech payments), Argus (completion audit), Quotato (tech texts/calls), a Teams PDF channel (assignment), and manual re-entry into each client's CMMS. Nothing connects: a dispatcher cannot see from one place what stage a job is in, what has been promised to the client, what the tech was told, whether the tech was paid, or whether the invoice went out. Deadlines live in people's heads — a quote that should have gone out Tuesday surfaces when the client calls angry. Finished jobs sit un-invoiced because nobody notices they cleared audit.

### 2.2 Evidence

| Evidence | Source | Value |
|---|---|---|
| Work orders in the live workspace | ClickUp workspace measurement, 2026-07-23 | ~21,239 |
| Workspace users | Same measurement | 98 |
| Lists a WO can live in (routing surface) | Same measurement | 163 |
| WOs stuck awaiting client approval, single sample | Same measurement | 46 |
| Distinct custom fields staff maintain by hand | Same measurement | 102 |
| Side tools that each hold part of the WO record | Repo inventory | 5 (Yoda, PPR, Argus, Quotato, escalation bot) |
| Duplicate assignment channels | `product/wo-lifecycle.md` stage 3 | 2 (ClickUp + Teams PDF) |

### 2.3 Cost of doing nothing

Every WO continues to cost duplicate keying at intake, assignment, TL Rep, and invoicing. Missed obligations keep surfacing as client escalations rather than internal warnings. The completion-audit backlog keeps delaying invoicing, and collection ages unmeasured. The fallback is licensing Facilio at roughly $25K/yr — while still hand-building every integration, per its known weaknesses.

### 2.4 Business objective and success metrics

| # | Metric | Definition | Baseline | Target | Measured by | By when |
|---|---|---|---|---|---|---|
| M1 | Intake double-entry | Number of systems a new WO is manually keyed into (platform, ClickUp, Teams) | 3 | 1 | Pilot observation | R1 exit |
| M2 | Obligation breach rate | Breached obligations ÷ obligations opened, per week (BR-OBL-007…013) | Not measurable today — instrumented from pilot day 1 | Baseline − 50% within 8 weeks of pilot | Platform report | R2 entry |
| M3 | Approval-chase coverage | Quotes awaiting client approval > 5 business days that have a recorded follow-up (BR-OBL-011) | Unknown; 46 WOs stuck in one sample with no tracked follow-up | 100% | Platform report | R1 exit |
| M4 | Quote review turnaround | Median business hours from quote submission to ATL decision (BR-OBL-009) | Not measured today | ≤ 4 business hours | Platform report | R1 exit |
| M5 | Audit-to-invoice lag | Median days from final soft close to invoice sent | Not measurable in ClickUp — instrumented from pilot | Baseline − 30% | Platform report | R2 exit |

### 2.5 Counter-metrics

- **Quote quality must not drop.** Rejection rate at ATL review must not rise above its first-month baseline while turnaround tightens.
- **Technician payment speed must not slow.** Median request-to-paid time must stay ≤ 2 business days (BR-OBL-012); techs go where they get paid.
- **Client-visibility incidents = 0.** No internal content may reach a client surface (BR-ACC-001); one incident is a stop-the-line event.

---

## 3. Users and personas

| Persona | Role in this feature | Job to be done | Current pain | Frequency of use | Device / context |
|---|---|---|---|---|---|
| Dispatcher (OM / Senior OM) | Primary | Source a tech, run both visits, quote, soft-close my book | 5 tools + Teams pings; deadlines in my head | All day | Desktop, office |
| Team Lead / Assistant TL | Primary | Accept work, audit quotes, keep the book honest | Quote review arrives by ping; no queue, no clock | Hourly | Desktop |
| Operations Admin (OA) | Primary | Intake WOs; push curated updates to client CMMS (TL Rep) | Re-keys everything twice | All day | Desktop |
| Account Manager | Primary | Accept/decline; own the client; chase approvals | Can't see what the client was told without asking | Daily | Desktop, calls |
| AP team | Primary | Pay techs fast and correctly; order parts | Requests arrive as links in chat (PPR); no queue | Daily | Desktop |
| AR team (HAR / Senior / AR) | Primary | Audit finished WOs, invoice, collect | Audit checklist lives in a separate tool; aging invisible | Daily | Desktop |
| Executive guest | Secondary | See rollups without touching records | Reads exported snapshots | Weekly | Desktop, read-only |
| Technician | External | Get the job, send photos, get paid | Texts vanish into one dispatcher's phone | Per job | SMS/phone only — no login in v1 |
| Client / FM contact | External | Approve quotes, see curated status | Updates arrive inconsistently per CMMS | Per WO | Their own CMMS — no login in v1 |
| Automations (n8n, bots) | Service | Act on the platform under attribution | No first-class identity in ClickUp | Continuous | API (BR-IAM-003) |

---

## 4. Scope

### 4.1 In scope

- Work-order record and lifecycle: single status pipeline, phases, books/routing, accept-decline, activity history (BR-WRK-001…009)
- Internal-vs-client visibility classification on every update (BR-ACC-001…003)
- Technician message/call thread on the WO (Quo channel, read view)
- Quote building, review, approval, sending — with incurred/proposed structure and money math (BR-QUO-001…010)
- Technician payment requests and the AP decision flow (BR-PAY-001…005)
- Obligations: the seven clocks, tiers, snooze, evidence-based resolution, notifications (BR-OBL-001…013)
- Completion audit and invoicing pipeline: grey-flag checks, release gate, ready → invoiced → paid, collections view (BR-REC-001…012)
- Work-order list, detail, Pulse (triage), Receivables screens; KPI figures (§13)
- Roles, tiers, and permission gates per §9

### 4.2 Explicitly out of scope

| Not included | Why | Revisit |
|---|---|---|
| Vendor database, pooled map, my-book lens | Own module; dispatch works from existing contacts in v1 | R1, PRD-VND-001 |
| Live client-CMMS adapters (Ecotrak first) and email-to-WO ingestion | Feasibility spike pending; TL Rep stays manual | R1–R2, PRD-INT-001 |
| Automations rules engine, saved views, dashboards beyond KPI row | Pilot doesn't need them; n8n covers automation externally | R2 |
| Client portal, vendor portal, technician login | Different trust levels and support paths — deliberate later phase | R3 |
| QuickBooks sync, client invoicing documents | Invoicing recorded in-platform v1; documents produced as today | R2, PRD-FIN-001 |
| Preventive maintenance, assets | `pm scheduled` status exists; no PM engine | R3 |
| One-time ClickUp import (21K WOs) | Cutover concern, not v1 | R2 |

### 4.3 Assumptions

| # | Assumption | Confirmed by | Status |
|---|---|---|---|
| A1 | The 19-status pipeline (Catalog Appendix A) is complete and correct for all teams | Jordan Brown | Confirmed in prototype seed |
| A2 | Quote gates: build = Senior OM+, approve & send = ATL+ | Jordan Brown | Confirmed 2026-07-30 (`product/quotes-payments.md` §4) |
| A3 | OT = ×1.5; tax derives from site state; options are internal | Jordan Brown | Confirmed 2026-07-30 |
| A4 | Business hours are Mon–Fri 08:00–18:00 CT for all obligation clocks | Jordan Brown | Confirmed in escalation rulebook |
| A5 | ~5 named pilot users will run "Incoming WOs" on the platform for R1 | Jordan Brown | Pending |
| A6 | Technicians remain phone/SMS-only in v1 — no tech-facing screens | Jordan Brown | Confirmed |

### 4.4 Dependencies

| # | Depends on | Type | Owner | Needed by | Status |
|---|---|---|---|---|---|
| D1 | Business Rules Catalog v1.0 approved | Internal | Jordan Brown | Build start | Drafted, pending review |
| D2 | Quo/OpenPhone data feed (calls, transcripts, SMS) for the Messages view | Internal (Quotato) | Jordan Brown | R1 | Prototype uses mirrored data |
| D3 | Ecotrak staging access for the first intake adapter | Third-party | Jordan Brown | R1 (S8) | Credentials in hand |
| D4 | Corrigo / ServiceChannel API feasibility spike | Third-party | TBD | R2 scoping | Not started |
| D5 | Real payment-method list from AP | Internal | AP lead | Build | Open — free text until then |

---

## 5. Business process — current and target

### 5.1 Current process (as-is)

A WO appears on a client CMMS, in email, or in Seamgo. An OA re-keys it into ClickUp, and in parallel posts it as a PDF to a Teams channel where TLs tag dispatchers — two assignment channels for one job. The dispatcher finds a tech from a pooled map plus their own book, texts and calls them (the thread lives in one person's phone unless Quotato catches it), and sends them to assess. The quote is built in Yoda, audited by a TL/ATL informally, and re-keyed into the client's CMMS by the OA ("TL Rep"). Waiting on approval, nobody owns the follow-up — WOs sit for weeks. After fulfilment, the dispatcher soft-closes: photos, checkmarks, and a PPR link for the tech's payment. AR audits in Argus's shadow, invoices into the client CMMS, and chases collection from memory. **Workarounds that are really requirements:** the Teams channel exists because ClickUp assignment isn't noticed (→ obligations/notifications); the escalation bot exists because deadlines had no owner (→ the OBL rules); Argus exists because invoicing errors were caught too late (→ the REC gate).

### 5.2 Target process (to-be)

| Step | Actor | Action | System behaviour | Business rules | Handoff to |
|---|---|---|---|---|---|
| 1 | OA | Registers an incoming WO (source, client, site, trade, NTE, SLA date, description) | Creates the record; starts intake clocks; emergency status starts the 2-hour clock | BR-INT-003, BR-OBL-007 | TL/ATL/AM |
| 2 | TL / ATL / AM | Accepts or declines with reason | Accept admits it to the pipeline; decline records decider + reason and ends the flow | BR-WRK-004 | OA |
| 3 | OA / TL | Routes the WO to a dispatcher's book | Home book changes; activity history records it; dispatcher notified | BR-WRK-003 | Dispatcher |
| 4 | Dispatcher | Sources a tech; contacts via SMS/call | Thread captured on the WO's Messages view; never client-visible | BR-DSP-001, BR-ACC-002 | Technician |
| 5 | Dispatcher | Schedules and runs the assessment visit | Statuses `assessment scheduled` → `assessment ongoing`; quote clock starts at `waiting for quote` | BR-WRK-005, BR-OBL-008 | Technician |
| 6 | Dispatcher (Senior OM) | Soft close pt 1: before-photos + builds the quote (incurred + options) | Totals, tax, NTE check computed live; submit moves quote to pending approval | BR-WRK-006, BR-QUO-001…006, BR-QUO-010 | ATL |
| 7 | ATL / TL | Reviews the quote; approves & sends, or rejects with feedback | Review clock (4 bus. hrs); reject returns to draft with feedback on the WO | BR-OBL-009, BR-QUO-007…009, BR-ACC-005 | OA |
| 8 | OA | TL Rep: pushes the client summary + status to the client's CMMS | Only client-visible content leaves; push recorded | BR-ACC-001, BR-ACC-006, BR-INT-002 | Client |
| 9 | AM / OA | Waits on client, follow-up every 5 business days; or records on-site approval | Approval-followup clock; on-site approval skips the wait | BR-OBL-011, BR-WRK-009 | Dispatcher |
| 10 | AP | Orders parts when needed | `please order parts` → `waiting for parts`; parts noted on the WO | — | Dispatcher |
| 11 | Dispatcher | Schedules and runs the fulfilment visit (same tech first) | Schedule clock (2 bus. hrs from approval); `job scheduled` → `job ongoing` | BR-OBL-010, BR-DSP-003 | Technician |
| 12 | Dispatcher | Soft close final: after-photos, checklist, raises tech payment request | Completeness checks; request enters AP queue with its 2-business-day clock | BR-WRK-007, BR-PAY-001, BR-PAY-004 | AP |
| 13 | AP | Decides the payment request; pays | requested → approved → paid, attributed; cost lands on the WO | BR-PAY-002…003, BR-FIN-002 | AR |
| 14 | AR | Completion audit: automatic checks + reviewer confirmation | Findings computed (photos, sign-off, quote, CICO, CO#); release gate | BR-REC-001…010 | AR |
| 15 | AR | Invoices; collections works aging until paid | ready → invoiced → paid; every follow-up recorded | BR-REC-011…012 | — |

### 5.3 What changes for whom

| Persona | Stops doing | Starts doing | Change impact |
|---|---|---|---|
| OA | Keying into ClickUp + posting Teams PDFs | Keying once into the platform | Medium |
| Dispatcher | Yoda, PPR links, memory-driven deadlines | Quote and payment on the WO; working from Pulse | High |
| TL/ATL | Ad-hoc quote review on ping | Working a review queue with a 4-hour clock | Medium |
| AP | Processing PPR links from chat | Working a payment queue with a 2-day clock | Medium |
| AR | Argus side-tool + manual aging | In-platform audit queue and invoicing lanes | Medium |
| AM | Chasing approvals from memory | Prompted follow-ups every 5 business days | Low |

---

## 6. Functional requirements

Priority: **M**ust / **S**hould / **C**ould / **W**on't-this-release.

### 6.1 Work-order record & lifecycle — WRK

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-WRK-001 | A user can register a work order with source, client, FM company, billing entity, site (city/state), trade, priority, NTE, SLA due date, date received, and description | OA | M | BR-INT-003 | Given a new WO from any of the five sources, when the OA saves it with mandatory fields complete, then it exists with a unique WO number and appears in the intake view |
| FR-WRK-002 | A TL, ATL, or AM can accept or decline a registered WO, with a reason required on decline | TL/ATL/AM | M | BR-WRK-004 | Given a registered WO, when an AM declines it without a reason, then the decline is refused; with a reason, the WO leaves the pipeline and records decider, reason, time |
| FR-WRK-003 | A user can change a WO's status along the single pipeline, and the phase bar reflects the status's phase | All internal | M | BR-WRK-001, BR-WRK-002 | Given a WO in `waiting for quote`, when its status changes to `quote ready`, then the activity history records actor and both statuses, and the phase shows Quote |
| FR-WRK-004 | A user can route a WO to a dispatcher's book; the WO has exactly one home book | OA/TL | M | BR-WRK-003 | Given a WO homed in Book A, when it is routed to Book B, then Book B is its only home and the change is attributed in the history |
| FR-WRK-005 | The WO detail shows people (dispatcher, AM), site, dates, money, flags, photos, checklist, obligations, and full field set | All internal | M | BR-FIN-001 | Given the hero demo WO, when opened, then all listed panels render with its real values |
| FR-WRK-006 | A user can post an update on a WO classified internal or client-visible at creation, immutable afterwards | All internal | M | BR-ACC-001 | Given a WO, when a user posts an update marked client-visible, then it is flagged as such in the feed and only such updates are offered to any outbound push |
| FR-WRK-007 | A user can upload photos to a WO, classified before / after / other | Dispatcher | M | BR-WRK-006, BR-WRK-007 | Given an assessment done, when the dispatcher uploads two photos tagged "before", then soft-close pt 1's photo condition is satisfied |
| FR-WRK-008 | The WO carries a soft-close checklist for part 1 and final, and shows completeness | Dispatcher | M | BR-WRK-006, BR-WRK-007 | Given final soft close with after-photos missing on a non-BFI WO, when the dispatcher views the checklist, then the missing item is shown as blocking |
| FR-WRK-009 | Every write to a WO appears in an append-only, filterable audit-trail view | TL/ATL, AR | M | BR-IAM-002 | Given any change, when the audit trail is opened, then the change appears with actor, timestamp, and before/after |
| FR-WRK-010 | A user can cancel/postpone a WO with a recorded reason | TL/ATL/AM | M | BR-WRK-008 | Given an active WO, when cancelled without a reason, then the change is refused; with one, status becomes `!! canceled/postponed` off-pipeline |
| FR-WRK-011 | A user can record an on-site approval (who granted it, when) which skips the client-approval wait | Dispatcher | S | BR-WRK-009 | Given a WO assessed with on-site approval, when recorded, then the WO may move directly to scheduling and no approval-followup clock starts |
| FR-WRK-012 | The technician SMS/call thread (calls, transcripts, summaries, messages, media) is visible on the WO | Dispatcher, TL | M | BR-ACC-002 | Given the demo WO with 2 calls and 5 messages, when Messages opens, then the thread renders chronologically and offers no client-visible marking |

### 6.2 Work-order list & search

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-WRK-020 | The WO list shows number, title, client, site, trade, entity, NTE, priority, status, age, and obligation state per row, filterable by status group and status, searchable | All internal | M | BR-WRK-002 | Given the seeded set, when filtered to group "done", then only done-group WOs appear with correct counts |
| FR-WRK-021 | The list can sort by obligation urgency ("sort by breach") | Dispatcher | S | BR-OBL-003 | Given WOs with tier 3, 1, 0 obligations, when sorted by breach, then they order 3 → 1 → 0 |

### 6.3 Quotes — QUO

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-QUO-001 | A Senior OM+ can create/edit the WO's quote: an incurred section plus one or more proposed options, each with narrative and typed line items (service, labor, part, material) | Senior OM | M | BR-ACC-004, BR-QUO-001, BR-QUO-002 | Given a `senior_om` actor, when they add Option A with 3 lines, then totals compute live; given an `om` actor, then editing is refused and the controls show locked with the reason |
| FR-QUO-002 | Line amounts, option totals, tax, and grand total are computed, never typed | Senior OM | M | BR-QUO-003…005, BR-FIN-005 | Given a labor line 4 × $120 with OT, when saved, then its amount reads $720; no amount field is directly editable |
| FR-QUO-003 | The quote shows the money position alongside: cost, grand total, tax, NTE, profit, margin, with an NTE meter | Senior OM, ATL | M | BR-FIN-001…004, BR-QUO-010 | Given a grand total above NTE, when displayed, then the NTE state is visibly flagged to builder and approver |
| FR-QUO-004 | A client-facing summary is generated from the included proposed sections and is editable before sending | Senior OM, ATL | M | BR-QUO-006 | Given two options with one marked for summary, when the summary generates, then only that option's content appears, and edits persist |
| FR-QUO-005 | Quote flows draft → pending approval → approved → sent; submit requires Senior OM+, decisions require ATL+ | Senior OM, ATL | M | BR-QUO-007…008, BR-ACC-005 | Given a pending quote and an `atl` actor, when approved and sent, then state is sent and both decisions are attributed; an `om` attempting any transition is refused |
| FR-QUO-006 | Rejection returns the quote to draft with the reviewer's feedback recorded on the WO | ATL | M | BR-QUO-009 | Given a pending quote, when rejected with feedback, then the builder sees the feedback on the WO and the quote is editable again as a new revision |
| FR-QUO-007 | A quotes index lists every quote with WO, state, total, and last-touched | TL/ATL | S | — | Given three quotes in mixed states, when the index opens, then all three appear with correct states and totals |

### 6.4 Technician payments — PAY

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-PAY-001 | A user can raise a payment request on a WO: payee (registered vendor or manual name + phone), amount, purpose, method, optional alternate recipient with reason | Dispatcher, AP | M | BR-PAY-001, BR-PAY-005 | Given a WO, when a request is raised with a manual payee and no phone, then it is refused; complete, it enters the AP queue as requested |
| FR-PAY-002 | Prior payments and requests on the WO are shown when raising a new one | Dispatcher | M | — | Given a WO with one paid request, when a second is raised, then the first is visible with amount and state before submission |
| FR-PAY-003 | AP can approve, reject, or mark paid; every decision attributed; paid amounts land in WO cost | AP | M | BR-PAY-002…003, BR-FIN-002 | Given a requested payment, when AP marks it paid, then WO cost includes it and profit/margin update |
| FR-PAY-004 | Amount entry is hardened: currency strings parse, nonsense is refused | Dispatcher | S | — | Given "1,250.00" entered, then the amount records as 1250.00; given "12oo", then it is refused with a message |

### 6.5 Obligations & notifications — OBL

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-OBL-001 | The system derives obligations from WO/quote/payment state per the seven clock rules, with business-hours or 24×7 clocks as each rule specifies | System | M | BR-OBL-001…002, BR-OBL-007…013 | Given a WO entering `waiting for quote` Friday 17:00, when 2 business days elapse, then the obligation breaches Tuesday 17:00 (clock paused over the weekend) |
| FR-OBL-002 | Obligations expose tier 0–3 per the thresholds; tier changes notify once per tier | All internal | M | BR-OBL-003, BR-OBL-006 | Given an obligation crossing 80%, then exactly one due-soon notification is ever produced for it, even across restarts |
| FR-OBL-003 | Pulse groups a user's obligations: Needs me now (tier 2–3), Due soon (tier 1), Watching (tier 0) | All internal | M | BR-OBL-003 | Given seeded obligations at known tiers, when Pulse opens, then each sits in the correct column with its clock |
| FR-OBL-004 | A user can snooze an obligation up to 72h with a mandatory reason; there is no dismiss anywhere | All internal | M | BR-OBL-004…005 | Given an obligation, when snoozed without a reason or beyond 72h, then it is refused; no interface offers dismissal |
| FR-OBL-005 | Obligations resolve automatically on evidence of the owed action | System | M | BR-OBL-004 | Given a breached quote-owed obligation, when the quote is submitted, then the obligation resolves without user action |
| FR-OBL-006 | A notification inbox lists pings with read/read-all; WO rows and the WO detail surface their open obligations | All internal | M | BR-OBL-006 | Given three unread pings, when read-all is used, then the unread count is zero and pings remain listed |

### 6.6 Completion audit & receivables — REC

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-REC-001 | Finished WOs enter an audit queue showing, per WO, every automatic check's outcome (pass / minor / major / n-a / offline) — not only failures | AR | M | BR-REC-001, BR-REC-003…009 | Given a WO missing its sign-off sheet, when its row expands, then the SO check reads major and the passing checks read pass |
| FR-REC-002 | The reviewer records the four audit marks (GTG, Elise, Admin, Quote); release requires Admin + Quote and no blocking findings | AR | M | BR-REC-002, BR-REC-010 | Given a WO with zero major findings and both release checks ticked, then it moves to the invoicing Ready lane; with a major finding, release is refused |
| FR-REC-003 | Findings carry resolution paths pointing at the WO or the external store holding the evidence | AR | S | — | Given a CO#-format finding, when expanded, then it links to where the CO# is corrected |
| FR-REC-004 | The invoicing view shows Ready → Invoiced → Paid lanes with amount, invoice number, and aging | AR | M | BR-REC-011…012 | Given a released WO, when invoiced is recorded, then it appears in Invoiced with aging counting from that date |
| FR-REC-005 | An unresolved-audit WO cannot be marked invoiced | AR | M | BR-REC-001 | Given a WO still in the audit queue, when an invoice is attempted, then it is refused with the blocking findings listed |

### 6.7 Reporting & KPIs — RPT

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-RPT-001 | The KPI row shows: active WOs; awaiting client approval (count + oldest age); ready to invoice (count + amount); margin % and average profit | TL, Exec | M | BR-FIN-003…004 | Given the seeded set, when the list loads, then each figure matches a hand count of the same data |
| FR-RPT-002 | Executive guests can view KPI figures and lists read-only | Exec | S | BR-ACC-007 | Given an exec actor, when any edit is attempted, then it is refused |

---

## 7. Business rules applied

Full text in `BUSINESS-RULES-CATALOG-v1.md`. This PRD applies: **IAM** 001–004 · **ACC** 001–007 · **WRK** 001–009 · **QUO** 001–010 · **FIN** 001–006 · **PAY** 001–005 · **OBL** 001–013 · **DSP** 001–003 · **REC** 001–012 · **INT** 001–003. All are **new in catalog v1.0**, drawn from existing practice; none conflict with a prior version.

---

## 8. Data requirements

### 8.1 Entities touched

| Entity | Created | Read | Updated | Deleted | Owning module |
|---|---|---|---|---|---|
| Work order | ✓ | ✓ | ✓ | Soft only (cancel) | WRK |
| Update / comment (with visibility flag) | ✓ | ✓ | — (immutable) | ✗ | WRK |
| Photo / attachment | ✓ | ✓ | ✗ | ✗ | WRK |
| Status (shared pipeline) | ✗ | ✓ | ✗ | ✗ | WRK |
| Book (routing container) | ✗ | ✓ | ✓ (membership) | ✗ | WRK |
| Technician thread (calls, messages) | via feed | ✓ | ✗ | ✗ | WRK |
| Quote (sections, lines, revisions) | ✓ | ✓ | ✓ | ✗ (revisions retained) | QUO |
| Payment request | ✓ | ✓ | ✓ (state only) | ✗ | PAY |
| Vendor (minimal payee record) | ✓ | ✓ | ✓ | ✗ | PAY |
| Obligation / notification | System | ✓ | System + snooze | ✗ | OBL |
| Audit marks & findings | ✓ | ✓ | ✓ | ✗ | REC |
| Activity entry | System | ✓ | ✗ (append-only) | ✗ | IAM |
| Principal (person / service account) | ✓ | ✓ | ✓ | Deactivate only | IAM |

### 8.2 Key fields (work order)

| Field | Type | Required | Default | Validation | PII | Retention |
|---|---|---|---|---|---|---|
| WO number | Identifier | Yes | System-issued | Unique | No | Life of company (Q7) |
| External ref (client CMMS #) | Text | No | — | — | No | Same as WO |
| Client / FM company / billing entity | Reference | Yes | — | Known values | No | Same as WO |
| Site: city, state | Text | Yes | — | State drives tax (BR-QUO-005) | No | Same as WO |
| Trade | Reference | Yes | — | Known trades | No | Same as WO |
| Priority | Enum | No | normal | urgent/high/normal/low | No | Same as WO |
| NTE | Money | No | — | ≥ 0 | No | Same as WO |
| SLA due date | Date | No | — | — | No | Same as WO |
| Status | Reference | Yes | `Open` | Pipeline only (BR-WRK-001) | No | Same as WO |
| Description | Rich text | Yes | — | — | Possible (site contacts) | Same as WO |
| Payee name + phone (manual payments) | Text | When manual | — | Phone format | **Yes** | Q7 |

### 8.3 Data ownership and lifecycle

- **Source of truth:** The One, from acceptance onward. The client's CMMS remains the source for the client's own WO identity (external ref). ClickUp is historical only (BR-INT-001).
- **Retention:** work orders and money records — indefinitely pending a policy decision (Q7). Technician thread media — same as the WO it attaches to.
- **Deletion behaviour:** nothing hard-deletes. Cancellation is a status (BR-WRK-008); principals deactivate; history is immutable (BR-IAM-002).
- **Tenant scoping:** single company, multi-brand. Every WO carries its billing entity; client-visibility (BR-ACC-001) is the isolation boundary that matters.

---

## 9. Permissions and visibility

| Persona | Create WO | View | Edit WO | Accept/Decline | Quote build | Quote approve/send | Payment raise | Payment decide | Audit release | Record scope |
|---|---|---|---|---|---|---|---|---|---|---|
| OA | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | All |
| OM (probation/standard) | ✗ | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | Own book (view all) |
| Senior OM | ✗ | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ | ✗ | ✗ | Own book (view all) |
| ATL / TL | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | All |
| AM | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Their clients (view all) |
| AP | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ | All |
| AR (by tier) | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ (waivers Senior+, BR-REC-010) | All |
| Exec guest | ✗ | ✓ (rollups) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | Read-only |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | All |
| Service accounts | Per grant | Per grant | Per grant | ✗ | ✗ | ✗ | Per grant | ✗ | ✗ | Per grant (BR-IAM-003) |

**Presentation rule:** a permitted-but-gated action renders locked with the reason — never hidden (`product/quotes-payments.md` §3).

**Field-level restrictions**

| Field | Hidden from | Reason |
|---|---|---|
| Cost, technician payments, profit, margin | Technicians, clients (all outbound surfaces) | BR-ACC-003 — commercially sensitive |
| Internal updates, technician thread | All client-facing channels | BR-ACC-001…002 |
| Tier-specific gates within OM/AR ladders | — | Defined per tier at R1 RBAC (Q3) |

---

## 10. Workflow and approvals

### 10.1 States

Work order: the 19-status pipeline (Catalog Appendix A). Quote: draft / pending approval / approved / sent (BR-QUO-007). Payment request: requested / approved / paid / rejected (BR-PAY-003). Obligation: open / snoozed / resolved (BR-OBL-004…005). Invoicing: ready / invoiced / paid (BR-REC-011).

### 10.2 Transitions (governing rules)

| From | To | Trigger | Who | Conditions | Rules |
|---|---|---|---|---|---|
| Registered | In pipeline | Accept | TL/ATL/AM | — | BR-WRK-004 |
| Registered | Declined (out) | Decline | TL/ATL/AM | Reason recorded | BR-WRK-004 |
| Quote draft | Pending approval | Submit | Senior OM+ | Quote has ≥ 1 proposed section | BR-ACC-004, BR-QUO-007 |
| Pending approval | Approved → Sent | Approve & send | ATL+ | NTE flag surfaced if exceeded | BR-ACC-005, BR-QUO-008, BR-QUO-010 |
| Pending approval | Draft | Reject | ATL+ | Feedback recorded | BR-QUO-009 |
| `!! waiting for approval` | `approved` | Client approves (or on-site recorded) | OA / dispatcher | On-site approval attributed | BR-WRK-009 |
| Payment requested | Approved → Paid | AP decision | AP only | Attributed | BR-PAY-002…003 |
| Audit queue | Invoicing Ready | Release | AR | Admin + Quote ticked, no majors | BR-REC-002, BR-REC-010 |
| Ready | Invoiced → Paid | Invoice sent / payment received | AR | Aging from invoice date | BR-REC-011…012 |

### 10.3 Approval routing

| Condition | Approver | Sequence | SLA | On breach | Delegation allowed |
|---|---|---|---|---|---|
| Quote submitted | ATL (TL/AM/admin may act) | Single | 4 business hours | Tiered obligation escalation (BR-OBL-009, BR-OBL-003) | Any ATL+ may act — pooled, not personal |
| Payment requested | AP | Single | 2 business days | Tiered obligation escalation (BR-OBL-012) | Within AP |
| Audit release | AR reviewer (waivers Senior AR+) | Single | — (grey-flag aging monitored) | Aging visible in queue | Within AR per tier |

- **Approver on leave:** approvals are pooled by role, not personal queues; anyone holding the role may act.
- **Self-approval:** unresolved — Q4 (an ATL who builds a quote approving their own work; conflict register C1).
- **Revocability:** a sent quote is not revocable; changes create a new revision (BR-QUO-001). A paid payment is not reversible in-system v1 (Q8).
- **Audit trail:** every decision records actor, timestamp, and outcome (BR-IAM-002).

---

## 11. Integrations

| System | Direction | Trigger | Data exchanged | Frequency | On failure | Owner |
|---|---|---|---|---|---|---|
| Client CMMS — Ecotrak first; Corrigo, ServiceChannel later | Inbound (v1: manual entry; R1: adapter) | New WO / status change at client | WO identity, scope, NTE, SLA | Per event | OA keys manually — the platform never blocks intake on an adapter | Jordan Brown |
| Client CMMS (TL Rep) | Outbound (v1: manual; R2: push) | Quote sent / curated update | Client-visible summary + status only (BR-INT-002) | Per event | OA pushes manually; the WO records what was sent either way | Jordan Brown |
| Quo / OpenPhone (via Quotato) | Inbound | Tech call or SMS | Calls, transcripts, summaries, messages, media onto the WO | Near-real-time | Thread gap flagged; dispatcher phones the tech — dispatch never blocks | Jordan Brown |
| SharePoint (deliverables store) | Read | Completion audit runs | Folder contents: sign-off, before/after photos, labels | Per audit | Checks report "offline — skipped" honestly; audit proceeds on the remaining checks; release still requires the reviewer | Head of AR |
| n8n automations | Bidirectional | Platform events | Per automation, as a service account | Continuous | Automation queues retry; obligations are the human backstop | Jordan Brown |
| ClickUp (legacy) | **None — read-only, forever** | — | Historical reference only | — | — (BR-INT-001) | Jordan Brown |

---

## 12. Notifications and communications

| Event | Recipient | Channel | Timing | Content summary | Can user opt out |
|---|---|---|---|---|---|
| Obligation reaches due-soon (tier 1) | The owing role/user | In-app (bell + Pulse) | At 80% of allowance, once (BR-OBL-006) | What's owed, on which WO, time left | No — snooze with reason instead |
| Obligation breaches (tier 2) | The owing role/user | In-app | At 100%, once | What breached, by how much | No |
| Obligation critical (tier 3) | Owner + their lead | In-app | At 200% or breached emergency, once | Same + escalation | No |
| Emergency WO arrives | Dispatch + TL | In-app | Immediate, clock visible (BR-OBL-007) | WO, site, 2-hour clock | No |
| Quote decided (approved/rejected) | The builder | In-app | Immediate | Outcome + feedback if rejected | No |
| Payment decided | The requester | In-app | Immediate | Outcome + method | No |
| WO routed to my book | Dispatcher | In-app | Immediate | WO, client, priority, SLA | No |

Email/Teams digests: R2 (the platform replaces the Teams channel rather than feeding it in v1). Quiet hours: none for in-app; business-hours clocks already pause overnight (BR-OBL-001). Delivery failure: the bell inbox is the durable record — pings persist until read.

---

## 13. Reporting and insights

| Metric / view | Definition | Dimensions | Persona | Refresh | Where it appears |
|---|---|---|---|---|---|
| Active WOs | Count of status group = active | Status, client, trade, book | All | Live | KPI row |
| Awaiting approval | Count in `!! waiting for approval` + oldest age in days | Client, AM | TL, AM | Live | KPI row |
| Ready to invoice | Count + total amount in `!! ready to invoice` | Client, entity | AR, Exec | Live | KPI row |
| Margin / avg profit | BR-FIN-003…004 over invoiced WOs | Entity, client, trade | Exec, Finance | Live | KPI row |
| Pulse columns | Obligations by tier (BR-OBL-003) per user | Rule, subject | All | Live | Pulse |
| Grey-flag aging | Days a finished WO has sat unreleased | Reviewer, client | HAR | Live | Receivables audit |
| Collection aging | Days since invoice for unpaid WOs | Client, entity | AR | Live | Receivables invoicing |

Finance reconciliation: invoiced/paid figures must match the invoicing records AR keeps today (manual reconciliation at pilot; QuickBooks sync at R2).

---

## 14. Non-functional requirements

| ID | Category | Requirement | Rationale |
|---|---|---|---|
| NFR-WRK-001 | Availability | Available during business hours (Mon–Fri 08:00–18:00 CT) with ≥ 99.5% uptime; emergencies arrive 24×7, so overnight outages must never lose an intake clock | Dispatch and the 2-hour emergency clock depend on it |
| NFR-WRK-002 | Auditability | Every change attributable to a principal, timestamped, immutable (BR-IAM-002) | Client disputes and internal trust tiers |
| NFR-WRK-003 | Correctness of clocks | Obligation clocks accurate to the minute across DST transitions in America/Chicago | The whole obligation model rests on them |
| NFR-WRK-004 | Capacity | 100 concurrent internal users; 25,000 work orders live + historical without degradation | Current workspace scale plus growth |
| NFR-WRK-005 | Usability | A new starter can execute SOP-OPS-001 end-to-end without asking a question; gated actions always explain themselves (locked, not hidden) | Training cost; trust-tier onboarding |
| NFR-WRK-006 | Money display | All monetary figures display with tabular numerals and consistent formatting | Misread money is the costliest UX bug |
| NFR-WRK-007 | Visibility safety | Zero paths by which internal content reaches a client surface (BR-ACC-001…003) | One leak is a client-relationship incident |

---

## 15. Edge cases and exception handling

| # | Scenario | Expected behaviour | Rule |
|---|---|---|---|
| E1 | Client approves on-site, no CMMS approval will ever come | On-site approval recorded with grantor; wait skipped; no follow-up clock | BR-WRK-009 |
| E2 | Emergency WO — quote would slow response | Dispatch may precede quoting; the 2-hour acknowledgment clock still applies; stage order for emergencies is Q5 | BR-OBL-007 |
| E3 | Tech no-shows the fulfilment visit | Status returns to scheduling; schedule-owed clock restarts; thread records the no-show; vendor note kept | BR-OBL-010 |
| E4 | WO cancelled after parts ordered / payment already made | Cancellation recorded with reason; incurred cost remains on the WO's money position; commercial recovery is Q9 | BR-WRK-008, BR-FIN-002 |
| E5 | Quote rejected after the client already approved on-site | New revision required; on-site approval stands for scope, not price — re-approval needed if total changes (policy to confirm, Q6) | BR-QUO-001 |
| E6 | Duplicate payment request for the same visit | Prior requests are surfaced at creation; AP refuses the duplicate at decision | FR-PAY-002, BR-PAY-002 |
| E7 | WO has incurred work but the client declines all options | WO closes as `done/incurred`; incurred billing path is Q2 | BR-QUO-002 |
| E8 | Return trip needed after final soft close | Status `return trip needed`; soft-close checks re-open; audit will not accept the WO meanwhile | BR-WRK-005, BR-REC-001 |
| E9 | Deliverables store (SharePoint) unreachable during audit | Affected checks report "offline — skipped"; reviewer decides on the remaining evidence; release gate still applies | BR-REC-002 |
| E10 | Snooze expires with the obligation still unmet | Obligation returns at its current tier; it never disappears | BR-OBL-004…005 |

---

## 16. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RSK-WRK-001 | Pilot users fall back to ClickUp out of habit and the pilot measures nothing | Medium | High | R1 gate is explicit: one week of intake with zero fallback; Pulse gives daily reasons to stay in | Jordan Brown |
| RSK-WRK-002 | Corrigo/ServiceChannel APIs prove infeasible and intake stays manual | Medium | Medium | Ecotrak first; OA manual intake remains a first-class path, not a workaround | Jordan Brown |
| RSK-WRK-003 | Obligation clocks mistrusted after one wrong fire, and Pulse gets ignored | Low | High | Clock rules published in the catalog; every ping shows its arithmetic; snooze-with-reason keeps humans in charge | Jordan Brown |
| RSK-WRK-004 | Quote gates block work when no ATL is available | Low | Medium | Approval is pooled across ATL/TL/AM/admin; 4-hour clock escalates | Jordan Brown |
| RSK-WRK-005 | Audit rules stricter than practice — release grinds | Medium | Medium | Waiver path for minors (BR-REC-010); rule thresholds reviewed after first month's findings | Head of AR |

---

## 17. Rollout and change management

| Phase | Scope | Duration | Entry criteria | Exit criteria | Rollback |
|---|---|---|---|---|---|
| Prototype validation (R0) | Leadership + one OA/OM/AR walk the demo | Done | — | "This is our process" confirmed | — |
| Pilot (R1) | ~5 named users run "Incoming WOs" | ~6 weeks of sprints + 1 gate week | Must-requirements pass; SOP-OPS-001 published; personas trained | One week of intake, zero ClickUp fallback | Per-WO reversion to the legacy process (SOP-OPS-001 §8.1); never edit records by hand |
| Cutover (R2) | Team-by-team waves, all WOs | Phased | Pilot exit met; import reconciled (21K WOs, counts match) | ClickUp Vista space read-only → decommissioned; Teams channel retired | Wave-by-wave hold; ClickUp remains readable (BR-INT-001) |

**Training:** per-role walkthrough of SOP-OPS-001 sections (OA §7 steps 1–3, dispatcher 4–12, ATL 6–7, AP 12–13, AR 14–15); competency = supervised handling of live WOs per SOP §12.
**Communications:** clients and techs notice nothing at pilot (their channels are unchanged); AM tells clients before R2 outbound-push changes anything they see.
**Data migration:** none at R1 (pilot runs on new intake). R2: one-time ClickUp import with count reconciliation, validated by OA + HAR.

---

## 18. Definition of done

- [ ] All **Must** requirements pass their acceptance criteria
- [ ] Every referenced business rule has automated test coverage, including each obligation clock across a weekend and a DST boundary
- [ ] Permissions verified per persona and per record scope, including both sides of every gate (403 + locked control)
- [ ] Zero-path verification that internal content cannot reach a client surface (BR-ACC-001…003)
- [ ] Each integration's failure path demonstrated, not just its success path (§11)
- [ ] SOP-OPS-001 written, reviewed, published
- [ ] Pilot personas trained; competency confirmed
- [ ] M1–M5 instrumentation live and reporting a baseline
- [ ] Known-issues list briefed to whoever supports the pilot
- [ ] Rollback (per-WO reversion) tested, not merely documented

---

## 19. Open questions

| # | Question | Blocks | Owner | Due | Status |
|---|---|---|---|---|---|
| Q1 | Accept/decline criteria — trade coverage, geography, NTE floor? Where is a decline recorded today? | FR-WRK-002 refinement | Jordan Brown | Pilot start | Open |
| Q2 | When a client declines all options, is incurred work billed, absorbed, or negotiated? | E7; BR-QUO-002 boundary | Jordan Brown + Finance | R1 | Open |
| Q3 | Which specific actions differ between probation / standard / senior within OM and AR? | §9 tier gates; R1 RBAC | Jordan Brown | R1 RBAC build | Open |
| Q4 | May an ATL approve a quote they built themselves? (Conflict register C1) | §10.3 | Jordan Brown | R1 | Open |
| Q5 | Do emergency WOs formally skip stages (dispatch before quote)? | E2; SOP decision points | Jordan Brown | Pilot start | Open |
| Q6 | Does an on-site approval bind price or only scope — is re-approval needed if the quote total changes? | E5 | Jordan Brown | R1 | Open |
| Q7 | Retention policy for WOs, money records, and PII (tech names/phones) | §8.3 | Jordan Brown + Finance | R2 | Open |
| Q8 | Is a recorded payment reversible in-system (clawback), or corrected outside? | §10.3 | AP lead | R1 | Open |
| Q9 | Commercial recovery when a WO cancels after cost was incurred | E4 | Finance | R2 | Open |
| Q10 | Tech payment terms: per visit or on completion? Are assessment-only visits paid? Who signs off besides AP? | BR-PAY-004 refinement | AP lead + Jordan Brown | Pilot start | Open |
| Q11 | Definitive payment-method list (replaces free text) | FR-PAY-001 | AP lead | Build | Open |
| Q12 | Does AP also settle parts/materials invoices (the `ap ordered` tag suggests yes)? | BR-FIN-002 scope | AP lead | R1 | Open |
| Q13 | Per-CMMS differences in the outbound TL Rep push (Ecotrak vs Corrigo vs ServiceChannel) | §11 adapters | Jordan Brown | R2 spike | Open |

> This PRD may enter review with open questions. It must not enter build with Q1, Q5, Q10, or Q11 unresolved — they block Must requirements.

---

## 20. Appendix

### 20.1 Glossary

Platform-wide terms live in `BUSINESS-RULES-CATALOG-v1.md` §4. PRD-specific: **Book** — a dispatcher's set of owned WOs (one home book per WO). **Pulse** — the obligations triage view. **Grey flag** — the completion-audit hold before invoicing. **TL Rep** — the curated outbound push to a client's CMMS.

### 20.2 Revision history

| Version | Date | Author | Change | Re-approval needed |
|---|---|---|---|---|
| 0.1 | 2026-08-07 | J. Brown / Claude (drafted) | Initial draft from product docs + validated prototype behaviour | — |

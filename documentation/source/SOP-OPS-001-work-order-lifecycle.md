# SOP-OPS-001 — Work Order Lifecycle: Intake to Collection

> A Standard Operating Procedure describes **how a person performs a task using the system**. Write it so a competent new starter can follow it on day one without asking anyone.

---

## 0. Document control

| Field | Value |
|---|---|
| **SOP ID** | SOP-OPS-001 |
| **Procedure name** | Work order lifecycle — intake to collection |
| **Version** | 1.0 |
| **Status** | Draft |
| **Effective from** | R1 pilot go-live (TBD) |
| **Next review due** | 6 months after effective date, then annually |
| **Process owner** | Jordan Brown (Operations) |
| **Author** | J. Brown / Claude (drafted) |
| **Approved by** | Pending |
| **Applies to** | OA, TL, ATL, AM, OM (all tiers), AP, AR (all tiers) — all brands (SFM / AF / BKR / TPM / RF / EDS) |
| **Related PRD** | PRD-WRK-001 |
| **Related rules** | BR-WRK-001…009 · BR-QUO-001…010 · BR-PAY-001…005 · BR-OBL-001…013 · BR-REC-001…012 · BR-ACC-001…007 |
| **Supersedes** | The undocumented ClickUp + Teams + Yoda + PPR + Argus practice |

---

## 1. Purpose

This procedure carries a work order from its arrival on a client system to cash collected. Following it keeps every promise on a clock (BR-OBL-007…013), keeps internal talk away from clients (BR-ACC-001), and keeps money right on both sides of the WO — the technician paid within two business days and the invoice released only when the record proves the work. Failure to follow it is how quotes sit unsent, techs quit over late payment, internal comments leak to clients, and finished jobs age un-invoiced.

---

## 2. Scope

### In scope
- Reactive client work orders from any intake source, through invoice and collection
- Emergency work orders (with the compressed handling in §7.1)
- The quote, technician payment, and completion-audit sub-procedures

### Out of scope

| Not covered here | See instead |
|---|---|
| Sourcing and vetting new vendors/technicians | SOP-VND-001 (to be written with the vendor module, R1) |
| Preventive-maintenance scheduling | R3 — no SOP yet |
| Client onboarding and contract setup | AM practice — outside the platform |
| One-time ClickUp data migration | R2 cutover runbook |

---

## 3. Definitions

Platform-wide terms are in `BUSINESS-RULES-CATALOG-v1.md` §4 (work order, book, NTE, soft close, TL Rep, client-visible, CICO, BFI, CO#, grey flag, obligation, tier, business hours). This SOP adds none.

---

## 4. Roles and responsibilities

| Role | Responsibility in this procedure |
|---|---|
| OA (Operations Admin) | Registers intake; performs the TL Rep push to the client CMMS |
| TL / ATL | Accept/decline; quote review and approval; escalation point |
| AM (Account Manager) | Accept/decline; client relationship; approval follow-ups |
| OM / Senior OM (dispatcher) | Sources the tech, runs both visits, soft-closes; Senior OM builds quotes |
| AP | Decides and pays technician payment requests; orders parts |
| AR (HAR / Senior / AR) | Completion audit, release, invoicing, collections |

### RACI

| Step | OA | TL/ATL | AM | Dispatcher | AP | AR |
|---|---|---|---|---|---|---|
| Register intake | **A/R** | I | I | — | — | — |
| Accept / decline | C | **A/R** | R | I | — | — |
| Route to book | R | **A** | C | I | — | — |
| Source tech & assess | — | I | — | **A/R** | — | — |
| Build quote | — | C | — | **A/R** (Senior OM) | — | — |
| Approve & send quote | I | **A/R** | C | I | — | — |
| TL Rep push | **R** | **A** | I | — | — | — |
| Chase client approval | I | I | **A/R** | I | — | — |
| Order parts | — | I | — | C | **A/R** | — |
| Fulfilment visit | — | I | — | **A/R** | — | — |
| Final soft close | — | I | — | **A/R** | C | I |
| Decide & pay tech | — | — | — | I | **A/R** | — |
| Completion audit & release | — | — | — | C | — | **A/R** |
| Invoice & collect | — | — | I | — | — | **A/R** |

*R = Responsible · A = Accountable · C = Consulted · I = Informed. One **A** per row.*

---

## 5. Prerequisites

**Before starting, the operator must have:**
- [ ] A platform account with the correct role and tier (§4; BR-IAM-004)
- [ ] Completed the role walkthrough for their steps (§12)
- [ ] Access to the client CMMS accounts they work (OA/AM) and the deliverables store (dispatchers/AR)

**Inputs required:**

| Input | Source | Format |
|---|---|---|
| The incoming work order | Client CMMS (Corrigo/Ecotrak/ServiceChannel), email, or Seamgo | Client's WO record / message |
| Client, site, trade, NTE, SLA date | The client's WO | Fields on registration |
| Technician contact | Vendor pool / dispatcher's book | Phone/SMS |

---

## 6. Trigger

A new work order appears on any of the five intake sources (BR-INT-003), at any hour. Emergencies are identified at registration and follow §7.1 immediately.

---

## 7. Procedure

| # | Who | Action | System response | Complete when | Target time |
|---|---|---|---|---|---|
| 1 | OA | Register the WO: source, client, FM company, billing entity, site, trade, priority, NTE, SLA date, description. Mark `emergency` if the client flags it | Issues the WO number; emergency starts the 2-hour 24×7 clock (BR-OBL-007) | WO exists in the intake view | Same business day; emergencies immediately |
| 2 | TL / ATL / AM | Accept or decline. Declining requires a reason | Accept admits it to the pipeline; decline records decider + reason and ends the flow (BR-WRK-004) | Decision recorded | 4 business hours |
| 3 | OA / TL | Route the accepted WO to the right dispatcher's book | Home book changes; dispatcher notified (BR-WRK-003) | WO in a dispatcher's book | Same business day |
| 4 | Dispatcher | Source a technician for the trade and location; contact by SMS/call. Record the agreed visit | Thread lands on the WO Messages view — internal only (BR-ACC-002); status `assessment scheduled` | Visit date agreed and status set | 1 business day |
| 5 | Dispatcher | Run the assessment: tech on site (`assessment ongoing`), collect findings and **before-photos** onto the WO | Photos and updates attributed on the feed | Findings + before-photos on the WO; status `waiting for quote` | Per visit date |
| 6 | Senior OM | Build the quote: incurred section for work already done; one or more proposed options with narrative and typed lines. Watch the NTE meter. Submit | Totals/tax computed (BR-QUO-003…005); NTE flag if exceeded (BR-QUO-010); submit sets pending approval and starts the 4-business-hour review clock (BR-OBL-009) | Quote pending approval | 2 business days from `waiting for quote` (BR-OBL-008) |
| 7 | ATL (any TL/AM/admin may act) | Review the quote. Approve & send, or reject with feedback | Approve & send sets sent; reject returns to draft with feedback (BR-QUO-008…009) | Quote sent, or back with the builder | 4 business hours (BR-OBL-009) |
| 8 | OA | TL Rep: push the client summary and status into the client's CMMS. Push **only** what the platform marks client-visible | The push is recorded on the WO (BR-ACC-006, BR-INT-002) | Client CMMS shows the quote; status `!! waiting for approval` | Same business day as sent |
| 9 | AM | While waiting: follow up with the client every 5 business days, recording each contact on the WO. If approval was granted **on-site**, record who granted it and skip to step 10 | Approval-followup obligation prompts at 5 business days (BR-OBL-011); on-site approval recorded per BR-WRK-009 | Client approves (status `approved`) or WO is declined/cancelled | Until resolved |
| 10 | Dispatcher | On approval: schedule the fulfilment visit — offer the assessing tech first (BR-DSP-003). If parts are needed, hand to AP first: status `please order parts` | Schedule clock: 2 business hours from approval (BR-OBL-010) | Status `job scheduled` (or `waiting for parts` → then `job scheduled`) | 2 business hours |
| 11 | AP *(only if parts)* | Order the parts; note supplier, cost, and ETA on the WO | Status `waiting for parts` until arrival | Parts in hand; dispatcher re-engaged | Per supplier ETA |
| 12 | Dispatcher | Run the fulfilment visit (`job ongoing`); collect **after-photos** and completion evidence; tick every checklist item | Soft-close completeness tracked (BR-WRK-007) | Work done; after-photos + checklist complete | Per visit date |
| 13 | Dispatcher | Raise the technician's payment request: payee, amount, purpose, method; alternate recipient only with reason (BR-PAY-001, 005). Check the prior-payments list first | Request enters the AP queue as requested; 2-business-day clock starts (BR-OBL-012) | Request submitted; status `done/incurred` | At final soft close (BR-PAY-004) |
| 14 | AP | Decide the request — approve and pay, or reject with reason | Decisions attributed; paid amount lands in WO cost (BR-PAY-003, BR-FIN-002) | Request paid or rejected | 2 business days (BR-OBL-012) |
| 15 | AR | Work the audit queue: open the WO's check read-out (quote on file, sign-off sheet, before/after photos, CICO, CO#, labels). Fix or bounce findings per §7.2 | Findings computed per BR-REC-003…009 | No major findings; minors corrected or waived (Senior AR+, recorded) | Grey-flag aging watched daily |
| 16 | AR | Release: confirm Admin Check and Quote Check | WO moves to invoicing Ready (BR-REC-002, BR-REC-010) | WO in Ready lane; status `!! ready to invoice` | Same day as clean audit |
| 17 | AR | Invoice the client in their CMMS; record it | WO to Invoiced; aging counts from invoice date (BR-REC-011) | Invoice recorded both sides; status `<< invoiced not paid >>` | Same business day as release |
| 18 | AR | Collections: work the aging list; record every follow-up until payment arrives | Paid closes the loop; WO archives `invoiced` (BR-REC-012) | Payment received and recorded | Follow-up cadence per client |

### 7.1 Decision points

| At step | Condition | Then | Rule |
|---|---|---|---|
| 1 | WO is an emergency | Register immediately at any hour; dispatch may proceed ahead of quoting (stage order pending PRD Q5); the 2-hour acknowledgment clock governs | BR-OBL-007 |
| 2 | Outside coverage (trade/geo) or NTE unworkable | Decline with reason — criteria being formalised (PRD Q1) | BR-WRK-004 |
| 5 | Job was approved up front by the client | Skip quoting (steps 6–9); go to step 10 | BR-WRK-005 |
| 6 | Quote total exceeds NTE | Do not submit silently: request an NTE increase via the AM, or restructure the options; the flag follows the quote to the approver | BR-QUO-010 |
| 9 | Client approves on-site during assessment | Record grantor + time; skip remaining wait | BR-WRK-009 |
| 10 | No parts needed | Skip step 11 | — |
| 12 | Job cannot complete in one fulfilment visit | Status `return trip needed`; repeat from step 10 scheduling | BR-WRK-005 |
| 13 | WO is BFI | After-photos are not required; everything else in final soft close still is | BR-REC-007 |
| 15 | SharePoint checks read "offline — skipped" | Audit on the remaining evidence; the release gate still applies | BR-REC-002 |

### 7.2 Sub-procedure — bouncing an audit finding

1. AR opens the finding and uses its resolution path (the WO, or the deliverables folder).
2. If the fix belongs to the dispatcher (missing photos, CICO, quote record): post an **internal** update on the WO naming the finding, and notify the dispatcher.
3. The dispatcher corrects within 1 business day and replies on the WO.
4. AR re-runs the read-out. Minors that remain may be waived only by Senior AR+ with the waiver recorded (BR-REC-010).
5. Repeat until clean, then release (step 16).

---

## 8. Exceptions and escalation

| # | Exception | Immediate action | Escalate to | Within | Record as |
|---|---|---|---|---|---|
| X1 | No technician found for trade/location | Keep sourcing; post an internal update with attempts made | TL | 1 business day | Internal update on the WO |
| X2 | Emergency clock at risk (no acknowledgment in sight) | Anyone seeing the tier-3 ping acts or phones the dispatcher | TL immediately | Within the 2-hour window | Obligation + internal update |
| X3 | Tech no-show | Reschedule at once (schedule clock restarts); note the vendor | TL if repeat offender | Same day | Internal update + vendor note |
| X4 | Client dispute after invoicing | Stop collections contact on that WO; assemble the WO record (photos, sign-off, approvals — this is why audit exists) | AM + HAR | 1 business day | Internal update; outcome on the WO |
| X5 | Suspected internal content reached a client | Stop the channel; capture what leaked | Jordan Brown | Immediately | Incident — stop-the-line (PRD counter-metric) |
| X6 | Platform unavailable | Follow §8.1 | Jordan Brown | Immediately | Retrospective entries within 4 business hours |

### 8.1 Manual fallback

1. New intake: register the WO in the legacy channel (client CMMS remains the client truth; note client, site, trade, NTE, time received on the shared intake sheet).
2. Emergencies: phone the dispatcher directly; the 2-hour obligation still stands — track it by hand.
3. In-flight WOs: continue by phone/SMS; keep photos and notes on the device.
4. When the platform returns: enter everything with original timestamps, marked "retrospective entry", within 4 business hours.
5. The TL verifies the intake sheet against the platform before the next business day opens. Reconciliation is not optional.

---

## 9. Timing and service targets

| Measure | Target | Source | Consequence of breach |
|---|---|---|---|
| Emergency acknowledgment | ≤ 2 hours, 24×7 | BR-OBL-007 | Critical obligation; TL escalation |
| Quote submitted | ≤ 2 business days from `waiting for quote` | BR-OBL-008 | Breached obligation on the dispatcher |
| Quote reviewed | ≤ 4 business hours from submission | BR-OBL-009 | Breached obligation on the ATL pool |
| Fulfilment scheduled | ≤ 2 business hours from approval | BR-OBL-010 | Breached obligation on the dispatcher |
| Client approval follow-up | Every 5 business days, recorded | BR-OBL-011 | Breached obligation on the AM |
| Payment request decided | ≤ 2 business days | BR-OBL-012 | Breached obligation on AP |
| Client SLA date | Per contract | BR-OBL-013 | Breached obligation; AM informed |

All clocks pause outside business hours except emergencies (BR-OBL-001…002). Snoozing any of these requires a reason and caps at 72 hours (BR-OBL-005). None can be dismissed (BR-OBL-004).

---

## 10. Records and evidence

| Record | Where held | Retained | Who may access |
|---|---|---|---|
| The WO, its history, updates, photos | Platform | Pending policy (PRD Q7) | All internal; client sees only client-visible content |
| Technician thread (calls, transcripts, SMS) | Platform (Quo mirror) | With the WO | Internal only — never client-facing (BR-ACC-002) |
| Quote revisions and decisions | Platform | With the WO | Internal; client receives the summary only |
| Payment requests and decisions | Platform | With the WO | Internal; amounts hidden from techs/clients (BR-ACC-003) |
| Sign-off sheet, before/after photos | Deliverables store (SharePoint), linked from the WO | With the WO | Dispatchers, AR |
| Audit findings, waivers, release | Platform | With the WO | AR, TL |
| Manual-fallback intake sheet | Shared drive | Until reconciled + 12 months | Ops |

---

## 11. Quality and monitoring

| KPI | Definition | Target | Reviewed | By |
|---|---|---|---|---|
| Obligation breach rate | Breached ÷ opened, weekly (PRD M2) | Falling; −50% in 8 pilot weeks | Weekly | Jordan Brown |
| Quote review turnaround | Median business hours submit → decision (PRD M4) | ≤ 4 | Weekly | TL |
| Payment turnaround | Median request → paid | ≤ 2 business days | Weekly | AP lead |
| Approval-chase coverage | Waiting-approval WOs > 5 days with a recorded follow-up (PRD M3) | 100% | Weekly | AM |
| First-pass audit clean rate | WOs released with zero findings ÷ audited | Rising | Monthly | HAR |
| Snooze hygiene | Snoozes with substantive reasons; repeat-snoozes on one obligation | ≤ 2 per obligation | Monthly | Jordan Brown |
| Retrospective entries | Records entered after the fact (fallback or otherwise) | ≤ 1% | Monthly | Jordan Brown |

**Audit:** this procedure is audited monthly by the process owner, sampling 10 completed WOs end-to-end; findings are recorded as internal updates on the sampled WOs and rolled into SOP revisions.

---

## 12. Training and competency

| Requirement | Applies to | Format | Refresh | Competency confirmed by |
|---|---|---|---|---|
| Platform walkthrough — own steps of §7 | Every role | 2h hands-on with seeded demo WOs (hero WO-39403) | On SOP revision | Supervised handling of 3 live WOs |
| Quote building | Senior OM+ | 1h on the quote screen: incurred vs proposed, NTE, summary | On rule change | 2 quotes approved without rejection |
| Audit read-out | AR | 1h on findings, waivers, release gate | On rule change | 5 audits alongside a Senior AR |
| Visibility discipline (client-visible vs internal) | Every role | Part of walkthrough; zero-tolerance briefing | Annual | Spot checks in monthly audit |

---

## 13. Related documents

| Type | Reference | Relationship |
|---|---|---|
| PRD | PRD-WRK-001 | Defines the system behaviour this procedure relies on |
| Business rules | BUSINESS-RULES-CATALOG-v1.md | Every clock, gate, and boundary cited here by ID |
| Process map | product/wo-lifecycle.md (v3) | The as-is source this procedure operationalises |
| SOP | SOP-VND-001 (planned) | Vendor sourcing and vetting |

---

## 14. Revision history

| Version | Date | Author | Change | Approved by | Retraining needed |
|---|---|---|---|---|---|
| 1.0 | 2026-08-07 | J. Brown / Claude (drafted) | Initial release | Pending | Yes — all roles at pilot start |

---

## Appendix — Author's checklist

- [x] A new starter could follow this without asking a question
- [x] Every step has one actor and one action
- [x] Every decision point has a mechanical rule (open judgement calls are flagged to PRD questions, not left silent)
- [x] Business rules referenced by ID, never restated
- [x] Manual fallback exists, with a non-optional reconciliation step
- [x] Every escalation names a role and a time limit
- [x] KPIs measurable from data the platform captures
- [x] Exactly one Accountable per RACI row

# Business Rules Catalog

**The One — Seamless FM Platform · Living document · v1.0 · 2026-08-07**

> This is a **single living document for the whole platform**, not a per-feature file. Never copy it. PRDs reference rule IDs; they do not restate rule text. Built per the structure of `02-BUSINESS-RULES-CATALOG.md`; rules are drawn from `product/wo-lifecycle.md` (v3), `product/quotes-payments.md`, the obligation rulebook (`Inbox Monitor/ESCALATION-BOT.md` lineage), and the completion-audit rules (Argus / Support Automation lineage).

---

## 1. What a business rule is

A business rule is a statement of policy that is **true regardless of any feature, screen or system**. It would still be true if you ran the business on paper. Policy lives here; implementation lives in a PRD or a ticket.

---

## 2. How to write one

**Atomic** (one rule, one statement) · **Declarative** (*must*, *must not*, *is calculated as*, *is defined as*) · **Testable** (pass/fail without a follow-up question) · **Free of implementation** (no tables, screens, buttons) · **Owned** (a named business owner, never a team or a developer).

Quality check before adding: atomic ☐ declarative ☐ testable ☐ unambiguous ☐ owned ☐ non-duplicative ☐.

---

## 3. Rule types

| Type | Code | Purpose |
|---|---|---|
| **Definition** | `DEF` | Establishes what a term means |
| **Constraint** | `CON` | States what must or must not be permitted |
| **Derivation** | `DRV` | Defines a calculation |
| **Action enabler** | `ACT` | Triggers something when a condition is met |
| **Routing** | `RTE` | Determines who receives or decides something |
| **Timing / SLA** | `SLA` | Defines a time obligation |
| **Access** | `ACC` | Determines who may see or do what |

---

## 4. Glossary

| Term | Definition | Owner |
|---|---|---|
| **Work order (WO)** | An accepted, authorised unit of client work against a site, tracked from intake to collection | Operations |
| **NTE** | Not-To-Exceed — the client's pre-authorised spending ceiling for a work order | Operations |
| **FM company** | The facilities-management company that manages the client's sites and issues work orders | Operations |
| **Billing entity (Comp)** | The Seamless company that bills the work (SFM, AF, BKR, TPM, RF, EDS) | Finance |
| **Book** | The set of work orders a dispatcher currently owns; every WO has exactly one home book | Operations |
| **Pooled map** | The shared, company-wide technician/vendor pool visible to all dispatchers | Operations |
| **Technician** | An external subcontractor (company or individual) sourced per job; never an employee | Operations |
| **Assessment visit** | The first site visit, to diagnose and gather quote inputs | Operations |
| **Fulfilment visit** | The visit that performs the approved work | Operations |
| **Return trip** | Any visit beyond the canonical two; an exception, not the norm | Operations |
| **Soft close, part 1** | Post-assessment completion: quote created, before-photos uploaded, checklist ticked | Operations |
| **Soft close, final** | Post-fulfilment completion: after-photos, remaining checks, technician payment initiated | Operations |
| **TL Rep** | The controlled push of curated updates from our system to the client's CMMS | Operations |
| **Client-visible** | Content explicitly classified as shareable with the client; everything else is internal | Operations |
| **Quo** | The SMS/voice channel with technicians (calls, transcripts, messages, photos) | Operations |
| **Incurred** | Work already performed before quoting (typically the assessment); context on a quote, never billed through it | Finance |
| **Proposed option** | One internally-drafted way to do the job, with narrative and priced line items | Operations |
| **Business hours** | Monday–Friday, 08:00–18:00, America/Chicago (CT) | Operations |
| **Obligation** | A tracked duty — something owed by someone, on a clock, derived from work-order state | Operations |
| **Emergency WO** | A work order in `emergency` status; its clocks run around the clock | Operations |
| **SLA due date** | The client-contractual completion deadline carried on a work order | Operations |
| **CICO** | The technician Check-In/Check-Out status on a work order | AR |
| **BFI** | Billed For Invoice — a WO flagged as billable without after-photos | AR |
| **CO#** | Closeout number issued at job completion; six digits when present | AR |
| **Grey flag** | The completion-audit hold: a finished WO not yet released for invoicing | AR |
| **Release gate** | The Admin Check + Quote Check confirmations that lift the grey flag | AR |
| **Principal** | Any actor — a person or a service account (bot/automation) — able to act in the system | Operations |
| **Trust tier** | Probation → standard → senior ladder within the dispatcher and AR roles | Operations |

---

## 5. Rule anatomy

Every entry carries: **ID** (`BR-<MODULE>-<NNN>`, never reused) · **Statement** · **Type** · **Owner** · **Exceptions** (who may override, and what is recorded) · **On violation** (block / warn / flag) · **Effective from** · **Configurable** (fixed / per client / per contract). All rules below are effective from **2026-08-07** unless noted. Financial rules are versioned by date: a historical figure is always evaluated under the rule version in force when the event occurred.

---

## 6. The catalog

### 6.1 Identity, accountability & tiers — `IAM`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-IAM-001 | Every action in the system is performed by an identified principal; anonymous or unattributed changes must not occur | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-IAM-002 | Every change to a work order or its money is recorded in an append-only activity history — actor, timestamp, what changed — and history entries are immutable | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-IAM-003 | Automations and bots act as service-account principals held to the same attribution and permission standards as people | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-IAM-004 | The dispatcher (OM) and AR roles each carry a trust tier — probation, standard, senior — and gated actions may require a minimum tier | DEF | Operations (J. Brown) | — | — | Per role |

### 6.2 Access & visibility — `ACC`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-ACC-001 | Every update, comment, photo and status note on a work order is classified internal or client-visible at the moment it is created; only client-visible content may reach any client-facing channel | ACC | Operations (J. Brown) | None | Block; log | Fixed |
| BR-ACC-002 | The technician SMS/voice channel (Quo) is never client-facing; nothing from it may be forwarded to a client surface without being explicitly re-created as client-visible content | ACC | Operations (J. Brown) | None | Block | Fixed |
| BR-ACC-003 | Internal costs, technician payment amounts, and margin must not be visible to clients or technicians | ACC | Finance | None | Hide | Fixed |
| BR-ACC-004 | Creating or editing a quote requires the Senior OM tier or above | ACC | Operations (J. Brown) | None | Block (shown as a locked action) | Fixed |
| BR-ACC-005 | Approving, sending, or rejecting a quote requires ATL authority or above (ATL, TL, AM, admin) | ACC | Operations (J. Brown) | None | Block (shown as a locked action) | Fixed |
| BR-ACC-006 | Pushing content to a client's CMMS requires TL-level authority or the OA performing TL Rep; dispatchers must not push outbound | ACC | Operations (J. Brown) | None | Block | Fixed |
| BR-ACC-007 | Executive guests hold read-only access to rollups and dashboards; they may not modify records | ACC | Operations (J. Brown) | None | Block | Fixed |

### 6.3 Work orders & lifecycle — `WRK`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-WRK-001 | All work orders follow the single company-wide status pipeline; no team or book may define alternative statuses | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-WRK-002 | Every status belongs to exactly one status group — open, active, done, closed — and maps to exactly one lifecycle phase, or to none for the cancelled off-ramp (see Appendix A) | DEF | Operations (J. Brown) | — | — | Fixed |
| BR-WRK-003 | A work order has exactly one home book at any time; assignment and routing are changes of home book and are recorded in the activity history | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-WRK-004 | A work order enters the operational pipeline only after an accept decision by a TL, ATL, or AM; a decline is recorded with the decider and a reason | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-WRK-005 | The canonical work-order shape is two visits — an assessment visit, then a fulfilment visit; any further visit is an exception recorded through the return-trip status | DEF | Operations (J. Brown) | Jobs approved up front proceed directly to fulfilment | — | Fixed |
| BR-WRK-006 | Soft close part 1 is complete only when the quote exists and before-photos are on the work order | CON | Operations (J. Brown) | None | Flag | Fixed |
| BR-WRK-007 | Soft close final is complete only when after-photos are on the work order (unless BFI), all checklist items are ticked, and the technician's payment request has been raised | CON | Operations (J. Brown) | BFI work orders per BR-REC-007 | Flag | Fixed |
| BR-WRK-008 | Cancelling or postponing a work order requires the actor and a reason to be recorded, and removes it from the lifecycle pipeline | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-WRK-009 | A work order approved on-site skips the client-approval wait; the on-site approval is recorded with who granted it and when | CON | Operations (J. Brown) | None | Flag | Fixed |

### 6.4 Quotes — `QUO`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-QUO-001 | A work order carries at most one quote; changes after a rejection or after sending create a new revision, and all revisions are retained | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-QUO-002 | A quote separates incurred work from proposed options; incurred amounts are context and are never included in the quote total | CON | Finance | None | Block | Fixed |
| BR-QUO-003 | The quote total is calculated as the sum of the proposed sections marked for inclusion in the client summary | DRV | Finance | — | — | Fixed |
| BR-QUO-004 | A line amount is calculated as quantity × rate, multiplied by 1.5 when the line is overtime | DRV | Finance | — | — | Fixed |
| BR-QUO-005 | Sales tax on a quote is derived from the state of the work order's site | DRV | Finance | — | — | Per state |
| BR-QUO-006 | Proposed options are internal alternatives; the client receives a single summary, never a menu of options | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-QUO-007 | A quote follows the states draft → pending approval → approved → sent; no state may be skipped | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-QUO-008 | A quote must be approved under BR-ACC-005 before it may be sent to a client | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-QUO-009 | A rejected quote returns to draft, and the reviewer's feedback is recorded on the work order | ACT | Operations (J. Brown) | — | — | Fixed |
| BR-QUO-010 | A quote whose total exceeds the work order's NTE must be flagged to the builder and the approver before submission | ACT | Finance | Client grants an NTE increase, recorded on the WO | Warn (v1); blocking is a per-client setting | Per client |

### 6.5 Money — `FIN`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-FIN-001 | The money position of a work order comprises: NTE, quote value, cost, invoiced amount, profit, and margin | DEF | Finance | — | — | Fixed |
| BR-FIN-002 | Cost is defined as the total paid out to fulfil the work order — technician payments and company-paid parts/materials | DEF | Finance | — | — | Fixed |
| BR-FIN-003 | Profit is calculated as invoiced amount minus cost | DRV | Finance | — | — | Fixed |
| BR-FIN-004 | Margin is calculated as profit ÷ invoiced amount, expressed as a percentage | DRV | Finance | — | — | Fixed |
| BR-FIN-005 | Derived financial figures are always computed from their source values and must not be manually overridden | CON | Finance | Recalculation of historical figures requires written Finance approval and an audit entry | Block | Fixed |
| BR-FIN-006 | Any financial figure is evaluated under the rule version effective on the transaction date, never the current version | CON | Finance | Per BR-FIN-005 exception | Block | Fixed |

### 6.6 Technician payments (AP) — `PAY`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-PAY-001 | A payment request must identify its payee — a registered vendor, or a named individual with contact details — plus amount, purpose, and payment method | CON | AP lead | None | Block | Fixed |
| BR-PAY-002 | Any team member may raise a payment request; only AP may approve it, reject it, or mark it paid | RTE | AP lead | None | Block | Fixed |
| BR-PAY-003 | A payment request follows the states requested → approved → paid, or requested → rejected; every decision is attributed | CON | AP lead | None | Block | Fixed |
| BR-PAY-004 | The technician's payment request for a work order must be raised no later than final soft close | SLA | AP lead | None | Flag | Fixed |
| BR-PAY-005 | When funds go to anyone other than the payee, the alternate recipient is explicitly recorded on the request | CON | AP lead | None | Block | Fixed |

### 6.7 Obligations & time — `OBL`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-OBL-001 | Business-hour clocks run only during business hours (see Glossary) and pause outside them | DEF | Operations (J. Brown) | — | — | Fixed |
| BR-OBL-002 | Obligations on emergency work orders run around the clock, without pause | CON | Operations (J. Brown) | None | — | Fixed |
| BR-OBL-003 | An obligation's urgency tier is: ambient below 80% of its allowance, due-soon at 80% or more, breached past 100%, critical past 200% — and a breached emergency obligation is always critical | DEF | Operations (J. Brown) | — | — | Fixed |
| BR-OBL-004 | An obligation resolves only on evidence that the owed action occurred; it must not be manually dismissable | CON | Operations (J. Brown) | None. There is no dismiss. | Block | Fixed |
| BR-OBL-005 | An obligation may be snoozed only with a recorded reason, for at most 72 hours | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-OBL-006 | Each obligation notifies at most once per tier, ever | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-OBL-007 | An emergency work order must be acknowledged by a human within 2 hours of arrival, around the clock; breach is critical | SLA | Operations (J. Brown) | None | Critical obligation | Fixed |
| BR-OBL-008 | A work order awaiting a quote must have its quote submitted within 2 business days | SLA | Operations (J. Brown) | Snooze per BR-OBL-005 | Breached obligation on the dispatcher | Per client |
| BR-OBL-009 | A submitted quote must be reviewed — approved or rejected — within 4 business hours | SLA | Operations (J. Brown) | Snooze per BR-OBL-005 | Breached obligation on the ATL | Fixed |
| BR-OBL-010 | An approved work order must have its fulfilment visit scheduled within 2 business hours | SLA | Operations (J. Brown) | Snooze per BR-OBL-005 | Breached obligation on the dispatcher | Fixed |
| BR-OBL-011 | A quote awaiting client approval for 5 business days requires a recorded follow-up with the client, and again every 5 business days thereafter | SLA | Operations (J. Brown) | Snooze per BR-OBL-005 | Breached obligation on the account owner | Per client |
| BR-OBL-012 | A payment request must be decided — approved or rejected — within 2 business days of being raised | SLA | AP lead | Snooze per BR-OBL-005 | Breached obligation on AP | Fixed |
| BR-OBL-013 | A work order past its client SLA due date and not yet done carries a breached obligation until completion | SLA | Operations (J. Brown) | — | Breached obligation on the dispatcher | Per contract |

### 6.8 Completion audit & receivables — `REC`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-REC-001 | Every finished work order passes the completion audit before it may be invoiced | CON | Head of AR | None | Block invoicing | Fixed |
| BR-REC-002 | Audit release requires both the Admin Check and the Quote Check to be confirmed by an AR reviewer | CON | Head of AR | None | Block release | Fixed |
| BR-REC-003 | The quote sent to the client must be recorded on the work order before audit; its absence is a major finding | CON | Head of AR | None | Major finding — blocks release | Fixed |
| BR-REC-004 | The technician must be checked out (CICO = Checked-out) at audit; any other CICO state is a minor finding | CON | Head of AR | None | Minor finding | Fixed |
| BR-REC-005 | A signed sign-off sheet must be on file for every audited work order; its absence is a major finding | CON | Head of AR | None | Major finding — blocks release | Fixed |
| BR-REC-006 | Before-photos are required on every work order; their absence is a major finding | CON | Head of AR | None | Major finding — blocks release | Fixed |
| BR-REC-007 | After-photos are required unless the work order is marked BFI; their absence is a major finding | CON | Head of AR | BFI flag set | Major finding — blocks release | Fixed |
| BR-REC-008 | Deliverable photos follow the naming convention "B (n)" for before and "a (n)" for after; deviations are minor findings | CON | Head of AR | None | Minor finding | Fixed |
| BR-REC-009 | The closeout number, when present, is exactly six digits; any other format is a minor finding | CON | Head of AR | Empty CO# is permitted — reviewer optional | Minor finding | Fixed |
| BR-REC-010 | Major findings block release; minor findings must be corrected or explicitly waived by a Senior AR or above, with the waiver recorded | CON | Head of AR | Senior AR+ waiver, recorded | Block (major) / Flag (minor) | Fixed |
| BR-REC-011 | After release, a work order moves through the invoicing states ready → invoiced → paid | DEF | Head of AR | — | — | Fixed |
| BR-REC-012 | An invoiced-unpaid work order is worked by collections until paid, with every follow-up recorded; aging counts from the invoice date | ACT | Head of AR | — | Flag | Per client |

### 6.9 Dispatch & vendors — `DSP`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-DSP-001 | Technicians are external subcontractors; every dispatch names the vendor (company or individual) performing the visit | DEF | Operations (J. Brown) | — | — | Fixed |
| BR-DSP-002 | The technician pool is shared company-wide; a dispatcher's book is a personal lens on the shared pool, never a private list | CON | Operations (J. Brown) | None | — | Fixed |
| BR-DSP-003 | The fulfilment visit is offered first to the technician who performed the assessment | ACT | Operations (J. Brown) | Tech unavailable or unsuitable — reason recorded | Warn | Fixed |

### 6.10 Integrations & data boundaries — `INT`

| ID | Statement | Type | Owner | Exceptions | On violation | Configurable |
|---|---|---|---|---|---|---|
| BR-INT-001 | The legacy ClickUp workspace is read-only from every system and every project, permanently; no writes under any circumstances | CON | Operations (J. Brown) | None. No exception may be granted. | Block; treat as an incident | Fixed |
| BR-INT-002 | Outbound sync to a client system sends only curated client-visible content; the internal record is never mirrored | CON | Operations (J. Brown) | None | Block | Fixed |
| BR-INT-003 | Work orders arrive from five intake sources: Corrigo, Ecotrak, ServiceChannel, email, and Seamgo | DEF | Operations (J. Brown) | — | — | Per client |

---

## Appendix A — The status pipeline (referenced by BR-WRK-002)

One pipeline, four groups, nine phases. The phase bar order is: Intake · Assessment · Quote · Approval · Scheduled · In Progress · Parts · Done · Invoiced.

| Status | Group | Phase |
|---|---|---|
| `Open` | open | Intake |
| `emergency` | open | Intake |
| `assessment scheduled` | active | Assessment |
| `assessment ongoing` | active | Assessment |
| `return trip needed` | active | Assessment |
| `waiting for quote` | active | Quote |
| `quote ready` | active | Quote |
| `!! waiting for advice` | active | Approval |
| `!! waiting for approval` | active | Approval |
| `approved` | active | Approval |
| `job scheduled` | active | Scheduled |
| `pm scheduled` | active | Scheduled |
| `job ongoing` | active | In Progress |
| `please order parts` | active | Parts |
| `waiting for parts` | active | Parts |
| `done/incurred` | done | Done |
| `!! ready to invoice` | done | Done |
| `<< invoiced not paid >>` | active | Invoiced |
| `!! canceled/postponed` | closed | — (off-pipeline) |
| `invoiced` *(archive)* | done | Invoiced |

---

## 7. Conflict register

| # | Rules in conflict | Nature | Raised by | Owner | Resolution | Date |
|---|---|---|---|---|---|---|
| C1 | BR-ACC-005 vs (unwritten) self-approval rule | An ATL who builds a quote could also approve it — no rule yet prevents self-approval | Drafting | Operations (J. Brown) | Open — see PRD-WRK-001 §19 Q4 | 2026-08-07 |

---

## 8. Change control

1. Anyone may **propose** a rule change. Only the named **owner** may approve it.
2. Changes affecting money, access, or client visibility require a second approver from Finance or Operations leadership respectively.
3. A changed rule gets a **new effective-from date**; the old version is retained with an effective-to date. **Never edit a rule in place.**
4. Every change is assessed for impact on existing work orders, in-flight approvals, historical reporting, and any PRD that references the rule.
5. Rules are re-reviewed annually by their owner, or on any client-contract change.

### Change log

| Date | Rule ID | Change | Proposed by | Approved by | Impact assessed |
|---|---|---|---|---|---|
| 2026-08-07 | All | Initial catalog v1.0 — 50 rules drawn from existing product documents and validated prototype behaviour | J. Brown / Claude (drafted) | Pending review | — |

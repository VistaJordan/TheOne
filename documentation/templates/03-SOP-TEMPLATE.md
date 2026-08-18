# SOP-<AREA>-<NNN> — <Procedure name>

> A Standard Operating Procedure describes **how a person performs a task using the system**. It is not a feature description and it is not training material. Write it so a competent new starter can follow it on day one without asking anyone.

---

## 0. Document control

| Field | Value |
|---|---|
| **SOP ID** | SOP-DSP-002 |
| **Procedure name** | |
| **Version** | 1.0 |
| **Status** | Draft / In review / Active / Retired |
| **Effective from** | |
| **Next review due** | *Maximum 12 months* |
| **Process owner** | *Accountable for the procedure being correct and followed* |
| **Author** | |
| **Approved by** | |
| **Applies to** | *Roles, sites, regions or tenants* |
| **Related PRD** | PRD-DSP-002 |
| **Related rules** | BR-DSP-001, BR-DSP-002 |
| **Supersedes** | |

---

## 1. Purpose

*One paragraph. Why this procedure exists and what happens if it is not followed. Lead with the consequence.*

> **Example.** This procedure covers dispatching a P1 reactive job from client call to technician on site. Following it ensures we meet the 4-hour contractual response obligation under BR-DSP-001. Failure to follow it results in SLA breach charges and, on repeat, contract review.

---

## 2. Scope

### In scope
- 

### Out of scope
*Name what looks similar but is covered elsewhere, and point to it.*

| Not covered here | See instead |
|---|---|
| *Planned preventive maintenance scheduling* | *SOP-DSP-004* |
| *Out-of-hours emergency callout* | *SOP-DSP-007* |

---

## 3. Definitions

*Only terms specific to this procedure. Platform-wide terms live in the Business Rules Catalog glossary — link rather than duplicate.*

| Term | Meaning |
|---|---|
| | |

---

## 4. Roles and responsibilities

| Role | Responsibility in this procedure |
|---|---|
| *Dispatcher* | *Triages, assigns and monitors to on-site confirmation* |
| *Technician* | *Accepts, travels, confirms arrival, executes* |
| *Duty manager* | *Resolves escalations, authorises subcontracting* |
| *Account manager* | *Client communication on breach risk* |

### RACI

| Step | Dispatcher | Technician | Duty manager | Account manager |
|---|---|---|---|---|
| *Triage and priority* | **A/R** | — | *C* | *I* |
| *Assign technician* | **A/R** | *I* | *C* | — |
| *Accept and travel* | *I* | **A/R** | — | — |
| *Escalate on breach risk* | **R** | *I* | **A** | **I** |

*R = Responsible · A = Accountable · C = Consulted · I = Informed. Exactly one **A** per row.*

---

## 5. Prerequisites

**Before starting, the operator must have:**
- [ ] *Dispatcher role assigned in the platform*
- [ ] *Access to the site's contract terms*
- [ ] *Completed training TRN-DSP-01*

**Inputs required:**

| Input | Source | Format |
|---|---|---|
| *Client request* | *Phone, portal or email* | *Request record* |
| *Site access requirements* | *Site record* | *System field* |

---

## 6. Trigger

*What starts this procedure? Be specific — a time, an event, or a system state.*

> **Example.** A request is created with priority P1, by any channel, at any hour.

---

## 7. Procedure

*Numbered, sequential, one action per step. Use the imperative. State who does it, what the system does in response, and what "done" looks like.*

| # | Who | Action | System response | Complete when | Target time |
|---|---|---|---|---|---|
| 1 | *Dispatcher* | *Open the request and confirm the reported fault against the asset record* | *Displays asset history and open jobs* | *Fault category selected* | *5 min* |
| 2 | *Dispatcher* | *Confirm the priority against the contract SLA matrix* | *Displays contractual response target* | *Priority confirmed or amended with reason* | *2 min* |
| 3 | *Dispatcher* | *Convert the request to a work order* | *Creates work order, starts SLA clock per BR-DSP-001* | *Work order reference issued* | *2 min* |
| 4 | *Dispatcher* | *Select a technician from the availability list* | *Shows only technicians holding required certifications per BR-DSP-002* | *Technician assigned* | *5 min* |
| 5 | *Technician* | *Accept the job on mobile* | *Sends push and SMS; records acceptance* | *Status = Accepted* | *15 min of assignment* |
| 6 | *Technician* | *Confirm arrival on site* | *Records arrival time and stops the response clock* | *Status = On site* | *Per SLA* |

### 7.1 Decision points

*Any step where the operator must choose. Make the choice mechanical, not a judgement call.*

| At step | Condition | Then | Rule |
|---|---|---|---|
| 4 | *No certified technician available within SLA* | *Go to §7.2 subcontracting* | *BR-DSP-002* |
| 5 | *Technician does not accept within 15 minutes* | *Reassign; do not wait* | — |
| 5 | *Two consecutive non-acceptances by the same technician* | *Notify duty manager* | — |

### 7.2 Sub-procedure — *<name>*

*Break out any branch longer than three steps into its own numbered sub-procedure here, or a separate SOP if it is reusable.*

---

## 8. Exceptions and escalation

| # | Exception | Immediate action | Escalate to | Within | Record as |
|---|---|---|---|---|---|
| X1 | *No technician available and no vendor accepts* | *Notify duty manager; inform account manager* | *Duty manager* | *30 min* | *Reason code NO-RESOURCE* |
| X2 | *Client refuses site access* | *Pause SLA clock per BR-DSP-003; log refusal* | *Account manager* | *1 hour* | *Reason code NO-ACCESS* |
| X3 | *Safety hazard reported on arrival* | *Technician withdraws; do not proceed* | *Duty manager + HSE* | *Immediate* | *Incident report* |
| X4 | *Platform unavailable* | *Follow the manual fallback in §8.1* | *IT on-call* | *Immediate* | *Retrospective entry within 4h* |

### 8.1 Manual fallback

*Every SOP that depends on the system needs an answer to "what do we do when it is down?" Write it, and make sure the reconciliation step is not optional.*

1. *Record on the paper P1 log sheet: client, site, fault, time, technician.*
2. *Contact the technician by phone; confirm acceptance verbally.*
3. *Within 4 hours of the system returning, enter all jobs with their original timestamps and mark them "retrospective entry".*
4. *The duty manager verifies the paper log against the system before the shift closes.*

---

## 9. Timing and service targets

| Measure | Target | Source | Consequence of breach |
|---|---|---|---|
| *Triage to work order created* | *≤ 10 min* | *BR-DSP-001* | *Erodes the response window* |
| *Work order to technician accepted* | *≤ 15 min* | *Internal* | *Escalation at 20 min* |
| *Acceptance to on site* | *≤ 4 hrs* | *Contract, BR-DSP-001* | *Contractual breach charge* |

---

## 10. Records and evidence

| Record | Where held | Retained | Who may access |
|---|---|---|---|
| *Work order and full audit trail* | *Platform* | *7 years* | *Ops, Finance, client on request* |
| *Call recording* | *Twilio via platform* | *90 days* | *Ops manager* |
| *Paper fallback log* | *Site office* | *Until reconciled + 12 months* | *Ops* |

---

## 11. Quality and monitoring

| KPI | Definition | Target | Reviewed | By |
|---|---|---|---|---|
| *P1 SLA attainment* | *P1 jobs on site within 4h ÷ all P1 jobs* | *≥ 97%* | *Weekly* | *Ops manager* |
| *Reassignment rate* | *Jobs reassigned ÷ jobs assigned* | *≤ 8%* | *Monthly* | *Dispatch lead* |
| *Retrospective entries* | *Jobs entered after the fact* | *≤ 1%* | *Monthly* | *Ops manager* |

**Audit:** *This procedure is audited [frequency] by [role], sampling [n] cases. Findings are recorded in [location].*

---

## 12. Training and competency

| Requirement | Applies to | Format | Refresh | Competency confirmed by |
|---|---|---|---|---|
| *TRN-DSP-01 Dispatch fundamentals* | *All dispatchers* | *Half-day + shadowing* | *Annual* | *Supervised handling of 5 live P1 jobs* |

---

## 13. Related documents

| Type | Reference | Relationship |
|---|---|---|
| PRD | PRD-DSP-002 | *Defines the system behaviour this procedure relies on* |
| Business rules | BR-DSP-001, BR-DSP-002, BR-DSP-003 | *Policies enforced during this procedure* |
| SOP | SOP-DSP-007 | *Out-of-hours variant* |

---

## 14. Revision history

| Version | Date | Author | Change | Approved by | Retraining needed |
|---|---|---|---|---|---|
| 1.0 | | | *Initial release* | | *Yes* |

---

## Appendix — Author's checklist

Before submitting for approval:

- [ ] A new starter could follow this without asking a question
- [ ] Every step has one actor and one action
- [ ] Every decision point has a mechanical rule, not "use judgement"
- [ ] Business rules are referenced by ID, never restated
- [ ] There is a manual fallback for system unavailability, with a reconciliation step
- [ ] Every escalation names a role and a time limit
- [ ] KPIs are measurable from data the system already captures
- [ ] Exactly one Accountable per RACI row

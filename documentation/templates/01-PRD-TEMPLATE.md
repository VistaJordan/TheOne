# PRD-<MODULE>-<NNN> — <Feature name>

> Copy this file. Delete every *italic guidance line* as you fill it in. Anything you cannot answer becomes an entry in §19 Open Questions — do not guess and do not leave blanks.

---

## 0. Document control

| Field | Value |
|---|---|
| **Document ID** | PRD-WRK-004 |
| **Feature name** | |
| **Module** | |
| **Status** | Draft / In review / Approved / In build / Shipped / Superseded |
| **Version** | 0.1 |
| **Author** | |
| **Product owner** | *Accountable for scope and trade-offs* |
| **Business owner** | *Accountable for the business rules and the outcome* |
| **Engineering lead** | |
| **Target release** | |
| **Last updated** | |

**Reviewers and sign-off**

| Role | Name | Reviewed | Approved | Date |
|---|---|---|---|---|
| Business owner | | ☐ | ☐ | |
| Operations lead | | ☐ | ☐ | |
| Engineering lead | | ☐ | ☐ | |
| Finance *(if it touches money)* | | ☐ | ☐ | |
| Security / compliance *(if it touches tenant data)* | | ☐ | ☐ | |

---

## 1. Summary

*Three sentences maximum. What are we building, who is it for, and what business outcome does it produce? If you cannot do it in three sentences, the scope is too wide — split the PRD.*

> **Example.** Technicians currently close work orders on paper and re-key them the next morning, so labour hours reach invoicing three to five days late. This feature gives technicians mobile completion with offline capture, syncing labour and parts directly to the work order. It moves billable hours from an average of 4.1 days to same-day, which pulls forward roughly $180k of annual cash flow.

---

## 2. Problem and opportunity

### 2.1 Problem statement
*Describe the business problem in the language of the people who have it. No solution language. If it reads like a feature description, you have skipped a step.*

### 2.2 Evidence
*Why do we believe this is real and worth solving? Cite numbers, not opinions.*

| Evidence | Source | Value |
|---|---|---|
| *Average delay from job completion to invoice* | *Finance report, Q2* | *4.1 days* |
| *Technician time spent re-keying per week* | *Time study, 12 techs* | *3.2 hrs each* |
| *Client complaints tagged "late invoice"* | *Support tickets, 6 months* | *34* |

### 2.3 Cost of doing nothing
*What happens over the next 12 months if we do not build this? Quantify where you can.*

### 2.4 Business objective and success metrics

| # | Metric | Definition | Baseline | Target | Measured by | By when |
|---|---|---|---|---|---|---|
| M1 | | *Exact calculation, no ambiguity* | | | *Dashboard / report* | |
| M2 | | | | | | |

> A metric without a **definition** and a **baseline** is a wish. "Improve technician efficiency" is not a metric. "Median minutes from job completion to work order closure, measured on completed reactive jobs" is.

### 2.5 Counter-metrics
*What must NOT get worse? Guards against optimising one number by damaging another.*

> **Example.** First-time-fix rate must not drop below 82%. Faster closure is worthless if technicians are closing jobs that reopen.

---

## 3. Users and personas

| Persona | Role in this feature | Job to be done | Current pain | Frequency of use | Device / context |
|---|---|---|---|---|---|
| *Field technician* | *Primary* | *Close a job and record what I used* | *Paper, re-keying, signal drops in plant rooms* | *8–12× daily* | *Mobile, often offline* |
| *Dispatcher* | *Primary* | | | | |
| *Account manager* | *Secondary* | | | | |
| *Vendor* | *External* | | | | |
| *Client contact* | *External* | | | | |
| *Finance* | *Downstream consumer* | | | | |

> **Do not skip external personas.** Vendors and client contacts are users of this platform with a different trust level, a different device profile and a different support path. Designing for them as an afterthought is how the vendor portal becomes a security incident.

---

## 4. Scope

### 4.1 In scope
- 
- 

### 4.2 Explicitly out of scope
*The most valuable section in the document. Write what a reasonable person might assume is included but is not, and say when it will be revisited.*

| Not included | Why | Revisit |
|---|---|---|
| *Parts reordering when stock hits zero* | *Depends on supplier catalogue integration, not yet scoped* | *Q3, PRD-PRC-002* |

### 4.3 Assumptions
*If any of these turns out false, the PRD needs re-approval. Name the assumption and who confirms it.*

| # | Assumption | Confirmed by | Status |
|---|---|---|---|
| A1 | *All technicians have a company device running iOS 15+* | *IT lead* | *Confirmed 12 Mar* |

### 4.4 Dependencies

| # | Depends on | Type | Owner | Needed by | Status |
|---|---|---|---|---|---|
| D1 | | *Internal / Third-party / Commercial / Legal* | | | |

---

## 5. Business process — current and target

### 5.1 Current process (as-is)
*Narrate what happens today, including the workarounds. Workarounds are requirements in disguise: people invented them because the process has a gap.*

### 5.2 Target process (to-be)

| Step | Actor | Action | System behaviour | Business rules | Handoff to |
|---|---|---|---|---|---|
| 1 | *Technician* | *Arrives on site, opens assigned job* | *Records arrival timestamp and GPS* | *BR-WRK-011* | *—* |
| 2 | | | | | |

### 5.3 What changes for whom

| Persona | Stops doing | Starts doing | Change impact |
|---|---|---|---|
| | | | *Low / Medium / High — drives §17 training* |

---

## 6. Functional requirements

*One row per requirement. Atomic, testable, no implementation language. Priority uses MoSCoW: **M**ust / **S**hould / **C**ould / **W**on't-this-release.*

| ID | Requirement | Persona | Priority | Business rules | Acceptance criteria |
|---|---|---|---|---|---|
| FR-WRK-021 | *A technician can record labour time against an assigned work order* | *Technician* | M | *BR-WRK-011, BR-FIN-007* | *Given an assigned in-progress work order, when the technician enters 2.5 hours and saves, then the work order shows 2.5 billable hours and an audit entry records who, when and from what device* |
| FR-WRK-022 | | | | | |

**Acceptance criteria format.** Use Given / When / Then. If you cannot write the Then as something observable, the requirement is not testable and needs rewriting.

---

## 7. Business rules applied

*Reference only. Full text lives in the Business Rules Catalog. If a rule you need does not exist yet, create it there first, then reference it.*

| Rule ID | Summary | Owner | New or existing |
|---|---|---|---|
| BR-APR-003 | *PO approval routing thresholds* | *Finance* | *Existing* |
| BR-WRK-011 | *Labour cannot be recorded against a closed work order* | *Operations* | **New — added for this PRD** |

---

## 8. Data requirements

### 8.1 Entities touched

| Entity | Created | Read | Updated | Deleted | Owning module |
|---|---|---|---|---|---|
| *Work order* | | ✓ | ✓ | | *WRK* |
| *Labour entry* | ✓ | ✓ | ✓ | *Soft only* | *WRK* |

### 8.2 Key fields

| Field | Type | Required | Default | Validation | PII | Retention |
|---|---|---|---|---|---|---|
| *hours_worked* | *Decimal(5,2)* | *Yes* | *—* | *> 0 and ≤ 24* | *No* | *7 years* |
| *technician_location* | *Point* | *No* | *—* | *—* | **Yes** | *90 days* |

### 8.3 Data ownership and lifecycle
- **Source of truth:** *Which system owns this data if more than one holds it?*
- **Retention period:** 
- **Deletion behaviour:** *Hard delete, soft delete, or anonymise? What does a tenant off-boarding request require?*
- **Tenant scoping:** *Confirm every new entity carries a tenant identifier. See BR-IAM-001.*

---

## 9. Permissions and visibility

*Specify per persona **and** per record scope. "Can view work orders" is not a permission — which work orders?*

| Persona | Create | View | Edit | Delete | Approve | Record scope |
|---|---|---|---|---|---|---|
| *Technician* | ✓ | ✓ | *Own only* | ✗ | ✗ | *Jobs assigned to them* |
| *Dispatcher* | ✓ | ✓ | ✓ | ✗ | ✗ | *All jobs at their sites* |
| *Account manager* | ✗ | ✓ | ✗ | ✗ | ✗ | *Jobs for their accounts* |
| *Vendor* | ✗ | ✓ | *Own only* | ✗ | ✗ | *Jobs assigned to their company only* |
| *Client contact* | *Request only* | ✓ | ✗ | ✗ | *Sign-off only* | *Their own sites* |

**Field-level restrictions**

| Field | Hidden from | Reason |
|---|---|---|
| *Cost price, margin* | *Technician, Vendor, Client contact* | *Commercially sensitive* |

---

## 10. Workflow and approvals

*Complete this section if the feature involves any state that changes over time or requires anyone's authorisation.*

### 10.1 States

| State | Meaning | Who can enter it | Exit conditions |
|---|---|---|---|
| *Draft* | | | |
| *Pending approval* | | | |
| *Approved* | | | |
| *Rejected* | | | |
| *Cancelled* | | | |

### 10.2 Transitions

| From | To | Trigger | Who | Conditions | Rules |
|---|---|---|---|---|---|
| *Draft* | *Pending approval* | *User submits* | *Requester* | *All mandatory fields complete* | *BR-APR-001* |

### 10.3 Approval routing

| Condition | Approver | Sequence | SLA | On breach | Delegation allowed |
|---|---|---|---|---|---|
| *Value ≤ $1,000* | *Site manager* | *Single* | *8 working hrs* | *Escalate to regional* | *Yes* |
| *Value > $5,000* | *Regional mgr → Finance* | *Sequential* | *24 working hrs* | *Escalate + notify CFO* | *Regional only* |

**Also specify:**
- What happens if the approver is on leave — *delegation, auto-escalation, or blocked?*
- Can a requester approve their own request? *Default: no. State the exception if any.*
- Is approval revocable after the fact? *If yes, what reverses downstream?*
- What is recorded in the audit trail on each decision?

---

## 11. Integrations

| System | Direction | Trigger | Data exchanged | Frequency | On failure | Owner |
|---|---|---|---|---|---|---|
| *Accounting* | *Outbound* | *Work order closed* | *Labour, parts, client, cost centre* | *Real-time* | *Queue and retry 24h, then alert finance; work order remains closed* | *Finance systems* |
| *Twilio* | *Bidirectional* | *Inbound call to service line* | *Caller ID, recording ref, call outcome* | *Real-time* | *Fall back to default IVR menu; log for manual match* | *Ops* |

> **Every integration must state its failure behaviour.** "Sends data to accounting" is not a requirement. What the user sees when accounting is down for four hours is a requirement.

---

## 12. Notifications and communications

| Event | Recipient | Channel | Timing | Content summary | Can user opt out |
|---|---|---|---|---|---|
| *Job assigned* | *Technician* | *Push + SMS* | *Immediate* | *Job ref, site, priority, window* | *No* |
| *Approval pending > 8h* | *Approver, then manager* | *Email* | *At 8h and 16h* | *What, who, value, link* | *No* |

Also state: quiet hours, language, per-tenant branding, and what happens on delivery failure.

---

## 13. Reporting and insights

| Metric / view | Definition | Dimensions | Persona | Refresh | Where it appears |
|---|---|---|---|---|---|
| *Open jobs by SLA status* | *Count of jobs not closed, bucketed by remaining SLA* | *Site, trade, technician, priority* | *Dispatcher* | *Live* | *Dispatch dashboard* |

- Which personas need this on a dashboard vs. an export?
- Does any figure here need to match a finance report exactly? *If yes, name the reconciliation source.*

---

## 14. Non-functional requirements

*State these in business terms with a number attached. "Fast" is not a requirement.*

| ID | Category | Requirement | Rationale |
|---|---|---|---|
| NFR-WRK-001 | Availability | *Available 99.9% during 06:00–20:00 local, per site region* | *Dispatch stops without it* |
| NFR-WRK-002 | Performance | *Job list loads in under 2s on 3G* | *Technicians work in plant rooms and basements* |
| NFR-WRK-003 | Offline | *Full job completion works offline for 8 hours and syncs on reconnect* | *No signal on most sites* |
| NFR-WRK-004 | Auditability | *Every change to labour or parts is attributable to a user, timestamped, and immutable for 7 years* | *Client billing disputes* |
| NFR-WRK-005 | Tenancy | *No user can access data belonging to another tenant under any circumstance* | *Contractual and regulatory* |
| NFR-WRK-006 | Capacity | *Supports 500 concurrent technicians and 20,000 open jobs per tenant* | *3-year growth plan* |
| NFR-WRK-007 | Accessibility | *WCAG 2.1 AA on all client-facing screens* | *Public-sector clients require it* |

---

## 15. Edge cases and exception handling

*The section that separates a real PRD from a wish list. Ask "what if" until it stops being productive.*

| # | Scenario | Expected behaviour | Rule |
|---|---|---|---|
| E1 | *Technician records labour, then dispatcher cancels the job* | *Labour is retained and flagged for review; job cannot close until resolved* | *BR-WRK-014* |
| E2 | *Same job completed by two technicians on two devices offline* | *Both entries retained; conflict flag raised to dispatcher* | *BR-WRK-015* |
| E3 | *Approver leaves the company mid-approval* | | |
| E4 | *Client disputes a closed job after invoicing* | | |
| E5 | *Vendor's contract expires while a job is assigned to them* | | |

---

## 16. Risks

| ID | Risk | Likelihood | Impact | Mitigation | Owner |
|---|---|---|---|---|---|
| RSK-WRK-001 | *Technicians resist mobile capture and keep using paper* | *Medium* | *High — no benefit realised* | *Pilot with 2 sites, involve 3 techs in design, manager dashboard on adoption* | *Ops lead* |

---

## 17. Rollout and change management

| Phase | Scope | Duration | Entry criteria | Exit criteria | Rollback |
|---|---|---|---|---|---|
| *Internal* | *Ops team only* | *1 week* | *All Must requirements pass* | *No Sev-1/2 defects* | *Feature flag off* |
| *Pilot* | *2 sites, 12 techs* | *3 weeks* | *Training complete* | *≥80% adoption, M1 trending* | *Feature flag off, paper fallback* |
| *General* | *All sites* | *Phased over 4 weeks* | *Pilot exit met* | *Full adoption* | *Per-tenant flag* |

**Training:** *Who needs it, in what format, delivered by whom, and how is competency confirmed? Link to the SOP.*

**Communications:** *Who tells clients and vendors, when, and in what words?*

**Data migration:** *Is there historical data to bring across? Who validates it, and against what?*

---

## 18. Definition of done

- [ ] All **Must** requirements pass acceptance criteria
- [ ] All referenced business rules have automated test coverage
- [ ] Permissions verified per persona **and** per record scope, including cross-tenant probe
- [ ] Every integration's failure path tested, not just its success path
- [ ] SOP written, reviewed and published
- [ ] Training delivered and competency confirmed
- [ ] Success metric instrumentation live and reporting a baseline
- [ ] Support team briefed with a known-issues list
- [ ] Rollback tested, not merely documented

---

## 19. Open questions

| # | Question | Blocks | Owner | Due | Status |
|---|---|---|---|---|---|
| Q1 | *Do we bill travel time separately per client contract, or is it absorbed?* | *FR-WRK-025, BR-FIN-009* | *Finance* | *14 Mar* | *Open* |

> A PRD may enter review with open questions. It must not enter build with open questions that block a **Must** requirement.

---

## 20. Appendix

### 20.1 Glossary
*Define every term that means something specific here. "Job", "work order", "task" and "request" are not interchangeable — pick one and define it.*

| Term | Definition |
|---|---|
| *Work order* | *An authorised unit of billable work against an asset or location. Distinct from a **request**, which is unauthorised and may be rejected.* |

### 20.2 Revision history

| Version | Date | Author | Change | Re-approval needed |
|---|---|---|---|---|
| 0.1 | | | *Initial draft* | — |

# Business Rules Catalog

**Seamless FM Platform · Living document · v1.0**

> This is a **single living document for the whole platform**, not a per-feature file. Never copy it. PRDs reference rule IDs; they do not restate rule text.

---

## 1. What a business rule is

A business rule is a statement of policy that is **true regardless of any feature, screen or system**. It would still be true if you ran the business on paper.

| This is a business rule | This is not |
|---|---|
| A work order cannot be closed while a mandatory checklist item is incomplete | The Close button is greyed out until the checklist is done |
| Purchase orders above $5,000 require regional manager approval | Show an approval modal after clicking Submit |
| Margin is calculated as (billable value − total cost) ÷ billable value | Store margin as a decimal in the work_order table |

The left column is policy. The right column is implementation, and it belongs in a PRD or a ticket.

---

## 2. How to write one

**Atomic.** One rule, one statement. If it contains "and also", split it.

**Declarative.** State what must be true, not what the system does. Use *must*, *must not*, *is calculated as*, *is defined as*.

**Testable.** Someone must be able to write a pass/fail test from it without asking a follow-up question.

**Free of implementation.** No table names, no screens, no buttons, no API references.

**Owned.** Every rule has a named business owner who can change it. Not a developer. Not "the product team."

### Quality check

Before adding a rule, confirm all six:

- [ ] Atomic — one statement, no compound conditions joined by "and also"
- [ ] Declarative — describes policy, not system behaviour
- [ ] Testable — an unambiguous pass/fail can be written from it
- [ ] Unambiguous — every term is either common English or defined in §4
- [ ] Owned — a named business owner, not a team
- [ ] Non-duplicative — searched the catalog first; does not overlap an existing rule

---

## 3. Rule types

Classify every rule. The type determines where it is enforced and how it is tested.

| Type | Code | Purpose | Example |
|---|---|---|---|
| **Definition** | `DEF` | Establishes what a term means | *A job is "overdue" when the current time exceeds its SLA target and it is not in a closed state* |
| **Constraint** | `CON` | States what must or must not be permitted | *Labour must not be recorded against a closed work order* |
| **Derivation** | `DRV` | Defines a calculation | *Gross margin = (billable value − total cost) ÷ billable value* |
| **Action enabler** | `ACT` | Triggers something when a condition is met | *When a vendor's insurance certificate expires, that vendor is suspended from new assignments* |
| **Routing** | `RTE` | Determines who receives or decides something | *Purchase orders above $5,000 route to the regional manager* |
| **Timing / SLA** | `SLA` | Defines a time obligation | *A P1 reactive job must have a technician on site within 4 hours of acceptance* |
| **Access** | `ACC` | Determines who may see or do what | *A vendor user may only view work orders assigned to their own company* |

---

## 4. Glossary

Rules are only as unambiguous as the terms in them. Define every term used in a rule.

| Term | Definition | Owner |
|---|---|---|
| **Work order** | An authorised unit of billable work against an asset or location | Operations |
| **Request** | An unauthorised report of a need, which may become a work order or be rejected | Operations |
| **Billable value** | The amount chargeable to the client, excluding tax, after contract discounts | Finance |
| **Total cost** | Labour cost + parts cost + subcontractor cost + travel, at the rates effective on the job completion date | Finance |
| **Working hours** | 08:00–17:00 local site time, Monday to Friday, excluding site-region public holidays | Operations |
| **Assigned vendor** | The vendor company named on the work order, not the individual technician | Operations |
| **Closed** | A terminal state in which no further labour, parts or cost may be added | Operations |

---

## 5. Rule anatomy

Every entry carries these fields. The last three are the ones teams skip and later regret.

| Field | Notes |
|---|---|
| **ID** | `BR-<MODULE>-<NNN>` — never reused, never renumbered |
| **Statement** | The rule itself, in one sentence |
| **Type** | From §3 |
| **Owner** | Named business role who may change it |
| **Rationale** | *Why* this rule exists — usually the most valuable field in the catalog |
| **Applies to** | Which entities or personas |
| **Exceptions** | Who may override, under what conditions, and what is recorded |
| **On violation** | Block, warn, or flag for review — and what the user sees |
| **Effective from** | Date the rule takes effect |
| **Effective to** | Blank if current |
| **Supersedes** | Rule ID and version this replaces |
| **Configurable** | Fixed in code / configurable per tenant / configurable per contract |

### Why "effective from" is not optional

A margin calculated in January under a 15% overhead rate must **still** show 15% when someone opens it in December, after the rate changed to 18%. Rules that touch money are versioned by date, and historical records are always evaluated against the rule version in force when the event occurred.

> **BR-FIN-001 (DEF)** — Any financial figure is calculated using the rule version effective on the transaction date, never the current version. Recalculation of historical figures requires written finance approval and produces an audit entry.

---

## 6. The catalog

### 6.1 Identity & access — `IAM`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-IAM-001 | Every record that belongs to a client organisation must carry a tenant identifier, and no user may access a record outside their own tenant | CON | Security | None. No exception may be granted. | Block; log as a security event | 2026-01-01 | Fixed |
| BR-IAM-002 | A user account deactivated for 90 consecutive days is archived and must be reinstated by an administrator before use | ACT | IT | | | | Per tenant |
| BR-IAM-003 | A user must not hold both the "raise purchase order" and "approve purchase order" permission for the same value band | CON | Finance | Sites with fewer than 3 staff, with CFO written approval, recorded in the audit log | Block at role assignment | | Per tenant |

### 6.2 Work management — `WRK`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-WRK-001 | A work order must reference either an asset or a location before it can leave Draft | CON | Operations | | Block | | Fixed |
| BR-WRK-002 | A work order is "overdue" when current time exceeds its SLA target and it is not in a closed state | DEF | Operations | | — | | Fixed |
| BR-WRK-011 | Labour must not be recorded against a work order in a closed state | CON | Operations | Ops manager may reopen within 7 days of closure, with a reason recorded | Block; offer reopen request | | Fixed |
| BR-WRK-014 | Labour already recorded against a cancelled work order is retained and flagged for review; the work order cannot reach a terminal state until the review is resolved | ACT | Operations | | Flag | | Fixed |

### 6.3 Vendor management — `VND`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-VND-001 | A vendor must hold current public liability insurance of at least $2,000,000 to be assigned work | CON | Procurement | Client-nominated vendors where the client accepts liability in writing | Block assignment | | Per tenant |
| BR-VND-002 | When a vendor's insurance or licence reaches its expiry date, the vendor is automatically suspended from new assignments; work already in progress continues | ACT | Procurement | | Auto-suspend; notify vendor 30/14/7 days before | | Per tenant |
| BR-VND-003 | A vendor scoring below 60 on the rolling 90-day scorecard is placed under review and excluded from automatic dispatch | ACT | Procurement | Manual assignment permitted with regional manager approval | Exclude from auto-dispatch | | Per tenant |

### 6.4 Financials & margin — `FIN`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-FIN-001 | Any financial figure is calculated using the rule version effective on the transaction date, never the current version | CON | Finance | Recalculation requires written finance approval and an audit entry | Block | 2026-01-01 | Fixed |
| BR-FIN-002 | Gross margin = (billable value − total cost) ÷ billable value, expressed to two decimal places | DRV | Finance | | — | 2026-01-01 | Fixed |
| BR-FIN-003 | A work order with a gross margin below 12% must be flagged for commercial review before invoicing | ACT | Finance | | Flag, do not block | | Per contract |
| BR-FIN-004 | Labour is charged at the rate effective on the date the labour was performed, not the date it was recorded | CON | Finance | | Block backdated rate changes | | Fixed |
| BR-FIN-005 | Travel time is billable only where the client contract explicitly permits it | CON | Finance | | Exclude from billable value | | Per contract |

### 6.5 Workflow & approvals — `APR`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-APR-001 | A request must not be approved by the person who raised it | CON | Finance | Sites with fewer than 3 staff, per BR-IAM-003 | Block | | Fixed |
| BR-APR-002 | An approval decision is immutable once recorded; reversal requires a new, separately recorded decision | CON | Compliance | None | Block edit | | Fixed |
| BR-APR-003 | Purchase order approval routes by value: ≤ $1,000 site manager; $1,001–$5,000 regional manager; > $5,000 regional manager then finance director, in sequence | RTE | Finance | Emergency purchases per BR-APR-005 | — | 2026-01-01 | Per tenant |
| BR-APR-004 | An approval not actioned within its SLA escalates to the approver's manager, and the original approver retains the ability to act | SLA | Operations | | Escalate | | Per tenant |
| BR-APR-005 | An emergency purchase may proceed without prior approval where a documented health, safety or business-continuity risk exists, and must be retrospectively approved within 48 hours | ACT | Finance | | Flag for retrospective approval | | Per tenant |
| BR-APR-006 | An approver who is unavailable may delegate authority for a defined period; the delegate cannot re-delegate | CON | Finance | | Block re-delegation | | Per tenant |

### 6.6 Scheduling & dispatch — `DSP`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-DSP-001 | A P1 reactive job must have a technician on site within 4 hours of client acceptance | SLA | Operations | Force majeure, recorded with a reason code | Breach flag; notify account manager | | Per contract |
| BR-DSP-002 | A technician must not be assigned work requiring a certification they do not currently hold | CON | Operations | None | Block assignment | | Fixed |
| BR-DSP-003 | SLA clocks pause while a job is in "awaiting client access" and resume on access confirmation | DEF | Operations | | — | | Per contract |

### 6.7 Access & visibility — `ACC`

| ID | Statement | Type | Owner | Exceptions | On violation | Effective from | Configurable |
|---|---|---|---|---|---|---|---|
| BR-ACC-001 | A vendor user may only view work orders assigned to their own vendor company | ACC | Security | None | Block; log | | Fixed |
| BR-ACC-002 | Cost price and margin must not be visible to any vendor, technician or client-contact persona | ACC | Finance | None | Hide field | | Fixed |
| BR-ACC-003 | A client contact may view work orders only for sites listed on their organisation's contract | ACC | Security | None | Block; log | | Fixed |

---

## 7. Conflict register

When two rules disagree, record it here and resolve it with the named owners. Do not let engineering pick a winner in a ticket comment.

| # | Rules in conflict | Nature | Raised by | Owner | Resolution | Date |
|---|---|---|---|---|---|---|
| C1 | BR-IAM-003 vs BR-APR-001 | *Small-site exception permits self-approval, which BR-APR-001 forbids* | *Eng* | *Finance* | *BR-IAM-003 exception narrowed to ≤ $500 and requires CFO sign-off; BR-APR-001 amended to reference it* | |

---

## 8. Change control

1. Anyone may **propose** a rule change. Only the named **owner** may approve it.
2. Changes affecting money, safety or access require a second approver from Finance, Compliance or Security respectively.
3. A changed rule gets a **new effective-from date**. The old version is retained with an effective-to date. **Never edit a rule in place.**
4. Every change is assessed for impact on: existing records, in-flight approvals, historical reporting, and any PRD that references the rule.
5. Rules are re-reviewed annually by their owner, or on any contract change.

### Change log

| Date | Rule ID | Change | Proposed by | Approved by | Impact assessed |
|---|---|---|---|---|---|
| | | | | | |

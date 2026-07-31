# Work Order Lifecycle — As-Is Process Map (v3)

**Source:** walkthrough by Jordan Brown, 2026-07-27, plus corrections (vendor pooling, client-CMMS sync model, corrected two-visit flow, absorb decision for Seamgo/Argus) and the AP tech-payment step (added 2026-07-27). This is the definition-stage source of truth for how a work order flows through Seamless FM / Byblos Vista today. The One must support every stage here at parity before improving on it.

---

## Roles glossary

| Code | Role | Notes |
|---|---|---|
| TL | Team Lead | Accept/decline authority; audits quotes |
| ATL | Assistant Team Lead | Same touchpoints as TL |
| OA | Operations Admin | Intake into ClickUp; client-CMMS updates at TL Rep |
| AM | Account Manager | Accept/decline authority; owns client relationship |
| OM | Operations Manager (**dispatcher**) | Sources techs, dispatches, soft-closes |
| Ops Coordinator | Dispatcher under probation | Reduced-trust tier of OM |
| Senior OM | Senior dispatcher | Elevated tier of OM |
| HAR | Head of Accounts Receivable | Owns AR audit |
| Senior AR / AR / AR (probation) | AR team tiers | AR audit + collections |
| AP | Accounts Payable team | Processes technician payments (under soft close); also orders parts (`ap will order` / `ap ordered` tags) |
| Technician | **External subcontractor** | Not an employee — sourced per job |

Note the pattern: OM and AR both have probation → standard → senior tiers. Permissions/trust levels are a real requirement, not a nice-to-have.

## Lifecycle stages (as-is, corrected flow)

### 1. Birth
WOs originate on **client CMMS platforms (Corrigo, Ecotrak, ServiceChannel)**, by **email**, or via **Seamgo** (our own software) — and must be pulled from there.
**Actors:** TL, ATL, OA, AM. **Pain point:** inbox management of incoming traffic — really multi-source intake aggregation.

### 2. Accept / Decline
ATL / TL / AM decide whether to take the job. Declined → flow ends.

### 3. Intake
OA adds the WO to ClickUp and assigns a dispatcher. In parallel, the WO is posted as a **PDF reminder on Teams**, where ATL/TL assign and tag dispatchers. (Dual-channel assignment — ClickUp + Teams — is duplicated effort.)

### 4. Hire
The OM finds a technician for the job. Tech data lives in **one pooled map accessible to all OMs**, while **each OM can simultaneously view their own book**; gaps are filled by searching online directories.

### 5. Dispatch — assessment visit
Send the tech to the job site to assess (or directly fulfill, for jobs approved up front).

### 6. Soft close, part 1 — quote + before photos
Create the quote, upload the tech's **before** photos, complete the ClickUp checkmarks, move status accordingly.

### 7. TL/ATL Audit
TL or ATL verifies the quote is in order. *(Placement between quote and client submission — confirm.)*

### 8. TL Rep — client-CMMS sync
OA updates the WO on the client's CMMS: **edits, status changes, and update messages** — not full re-keying. **Not all internal updates are shared with clients** — there is a deliberate internal vs. client-facing boundary on every update.

### 9. Approval
Two paths: **wait** for the client to approve the quote in their CMMS, or **approved on-site** (no wait).

### 10. Materials (conditional)
Order parts/materials if the job needs them. (The 12 parts tags + `please order parts` / `waiting for parts` statuses live here.)

### 11. Dispatch — fulfillment visit
Redispatch (same tech preferred) to perform the approved work.

### 12. Soft close, final — after photos + checks + tech payment
Upload **after** photos, complete all remaining checkmarks on the WO. The **AP team processes the technician's payment** as part of soft close — this is where the cost side of the WO (tech payable) is settled. Extra visits happen when needed (`return trip needed`), but the canonical shape is **two visits: assess, then fulfill** — not an open loop.

### 13. AR Audit
HAR / Senior AR / AR review everything — catch dispatcher mistakes, ensure the WO is pristine.
**Existing project "Argus" covers this stage; The One will ideally absorb it.**

### 14. Invoice
Invoice the client and input the data into the relevant client CMMS.

### 15. Collection
Calls and follow-ups on outstanding invoices until paid.

## Best-effort mapping to the 19 ClickUp statuses *(to confirm)*

| Lifecycle stage | Likely ClickUp statuses |
|---|---|
| Birth / Accept | `Open`, `emergency` (declined WOs never reach ClickUp) |
| Intake → Hire → assessment visit | `assessment scheduled`, `assessment ongoing`, `return trip needed` |
| Soft close pt 1 / quote | `waiting for quote`, `quote ready` |
| TL Rep → client decision | `!! waiting for approval`, `!! waiting for advice` |
| Approved → materials → fulfillment visit | `approved`, `please order parts`, `waiting for parts`, `job scheduled`, `job ongoing`, `pm scheduled` |
| Final soft close → AR | `done/incurred`, `!! ready to invoice` |
| Invoice / Collection | `<< invoiced not paid >>` → paid (archive list "Invoiced") |
| Off-ramp | `!! canceled/postponed` |

## Product insights from this lifecycle

1. **Technicians are external subcontractors; vendor sourcing is a core module.** Model: one shared, pooled tech map for all OMs **plus** a per-OM "my book" lens on the same data. Geographic search (trade × location) is the primary lookup.
2. **Outbound client sync is selective, not mirrored.** The client's CMMS gets edits, status changes, and curated update messages — never the full internal picture. Every update in The One needs an **internal vs. client-facing visibility flag**, and the sync layer needs per-CMMS adapters (Corrigo, Ecotrak, ServiceChannel). Inbound intake is still manual re-entry today (client CMMS → ClickUp) — that's the automation win.
3. **The flow is linear with branches, not a loop.** Canonical shape: assess → quote → approval (wait or on-site) → materials (if any) → fulfill → final soft close. Return trips are the exception path. UI implication: the phase bar works; it needs branch awareness (on-site approval skips the wait; materials stage is conditional).
4. **The One will ideally absorb Seamgo and Argus.** Open architecture decision: monolith vs. microservices. PM implication regardless of topology: define module boundaries now (intake, dispatch/vendors, quoting, client sync, AR audit, invoicing/collections) so absorption is a merge, not a rewrite.
5. **The `!! waiting for approval` bottleneck (46 WOs in sample) is client-side** — quotes sitting in the client's CMMS. The One can't eliminate it, but it can track aging, prompt follow-ups, and measure it.
6. **Money flows both ways, and both sides live on the WO.** AR bills and collects from clients (revenue); AP pays technicians at soft close (cost). Profit-per-WO = the two nets. Product implications: The One needs a **payables record tied to the vendor module** (rates, terms, payment status, history per tech), and paying techs fast/reliably is itself a vendor-retention lever — good techs go where they get paid.

## Open questions

- Accept/decline criteria (trade coverage? geography? NTE too low?) — and where is a decline recorded today?
- Confirm TL/ATL Audit and TL Rep placement in the corrected flow (between quote and approval?).
- Where does an **on-site approval** get recorded, and who confirms it with the client?
- Do emergency WOs compress/skip stages (dispatch before quote)?
- Who performs Collection calls — the AR team, or a separate role?
- Per-CMMS differences in the outbound sync (does Ecotrak/ServiceChannel work like Corrigo at TL Rep)?
- Tech payments: paid per visit or on completion? Are assessment-only visits (no approved job) paid? What terms (immediate, net-15/30)? Who approves the payable — AP alone, or OM/TL sign-off?
- Does AP also settle parts/materials invoices (the `ap ordered` tag suggests yes)?
- Status mapping table above — confirm/correct.

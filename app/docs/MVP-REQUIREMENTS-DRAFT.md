# The One — MVP Requirements (draft for correction)

**Date:** 2026-08-24 · **Drafted by:** Claude, from existing docs + production data · **Owner:** Jordan Brown
**To be corrected by:** Product Manager + Ops

---

## 0. How to read this

This is a **strawman**, written so it can be corrected rather than composed from nothing. Every claim is tagged:

| Tag | Means |
|---|---|
| **[DERIVED]** | Taken from `SOP-OPS-001`, `BUSINESS-RULES-CATALOG-v1`, `PRD-WRK-001`, the codebase, or the 232 production Ecotrak work orders read 2026-08-19. Correct it only if the source is wrong. |
| **[ASSUMED]** | My inference. **This is where to spend the review.** No source backs it. |
| **[OPEN]** | Nobody knows yet; needs a decision. |

Sources already covering ground this document does **not** repeat: the 18-stage lifecycle (`SOP-OPS-001` §6), 82 business rules (`BUSINESS-RULES-CATALOG-v1` §6), personas and success metrics (`PRD-WRK-001` §3, §2.4).

---

## 1. Volume model — the numbers everything calibrates against

**[DERIVED]** From 232 production Ecotrak work orders over 21 days (2026-07-29 → 08-19):

| Measure | Value |
|---|---|
| Ecotrak intake | **11.0 WOs/day** |
| Active clients in window | 9 (Flynn 92, PCRK 38, MOD Pizza 36, Sizzling Platter 23, GTI 23, Uncommon 14, +3) |
| Category split | Repair 169 · Capital Expense 40 · Maintenance 23 |
| Geography | 26 states; NJ 43, WA 30, TX 24, IN 18, PA 16, OH 11 — **6 states with a single WO** |
| Emergencies (L1) | 15 (6%) — **0.7/day** |
| NTE | min $250 · p10 $400 · **median $700** · p90 $2,831 · max $18,186 |
| Trades | 29 distinct → 5 general (Handyman 113, HVAC 61, Plumbing 29, Electric 16, Refrigeration 13) |

**Why this matters for calibration:** at 11 WOs/day and ~5 pilot users, nothing in the MVP needs bulk operations, pagination tuning, or background batch processing. A dispatcher's whole day fits on one screen. Build for legibility, not throughput.

⚠️ **This is Ecotrak only.** Total volume across all intake channels is unknown — the ClickUp workspace holds 21,239 WOs lifetime. **[OPEN]** What share of intake is Ecotrak vs email vs phone vs other CMMS? This changes the intake journey significantly.

---

## 2. Journeys

The SOP already defines stage, actor, effect, done-when and time budget for all 18 stages. What follows adds only what the SOP lacks: **the decision being made**, **the evidence needed to make it**, and **volume**.

### J1 · Intake → routing (OA, then TL/ATL/AM, then OA/TL)

**SOP stages 1–3** · **[DERIVED]**

| | |
|---|---|
| **Trigger** | Ecotrak pushes a WO (webhook, live today) or a client emails/calls |
| **Volume** | ~11/day from Ecotrak **[DERIVED]**; other channels unknown **[OPEN]** |
| **Decision 1** — accept or decline | See §3 Q1. **No decline has been observed in 3 weeks of production data.** |
| **Decision 2** — which dispatcher's book | **[ASSUMED]** by trade + geography + current load. The SOP says "the right dispatcher's book" without defining right. |
| **Evidence needed** | Trade, site + store number, NTE, client, priority, description, asset. All 100% populated by Ecotrak **[DERIVED]** |
| **Exceptions** | Emergency (6%) → see Q5 · outside coverage → decline · duplicate of an open WO **[ASSUMED — no dedupe rule exists in the catalog]** |
| **Done** | WO sits in a named dispatcher's book with a clock running |

> **[ASSUMED]** Intake is mostly **automatic** for Ecotrak — the WO arrives mapped, and the OA's stage-1 "register the WO" work largely disappears. The SOP was written for manual re-keying. If so, stage 1 collapses into a review step and M1 (intake double-entry 3 → 1) is already achieved for Ecotrak clients. **Confirm — this materially changes the OA's role.**

### J2 · Source and assess (Dispatcher)

**SOP stages 4–5** · **[DERIVED]**

| | |
|---|---|
| **Decision** | Which technician, and can they make the client's ETA |
| **Evidence needed** | Trade + subtrade, site address, `current_eta` (100% populated), NTE, prior techs used at this site **[ASSUMED — no vendor history exists yet]** |
| **Volume** | ~11/day inbound; unknown how many are actively sourced per dispatcher **[OPEN]** |
| **Exceptions** | No tech in region — **the 6 single-WO states are where this bites** · NTE too low to source **[ASSUMED]** |
| **Done** | Visit agreed, status `assessment scheduled`, before-photos expected |

### J3 · Quote and approval (Senior OM → ATL → OA → AM)

**SOP stages 6–9** · **[DERIVED]** · **50% of WOs carry a proposal**

| | |
|---|---|
| **Decisions** | (a) what to quote and at what price (b) ATL: approve, or reject with feedback (c) AM: chase the client |
| **Clocks** | quote owed 2 business days (BR-OBL-008) · ATL review 4 business hours (BR-OBL-009) · client follow-up every 5 business days (BR-OBL-011) |
| **Evidence needed** | Incurred work already done, NTE meter, prior quotes for this client **[ASSUMED]** |
| **Exceptions** | Quote exceeds NTE → BR-QUO-010 · on-site approval → skip to J4 (BR-WRK-009) · client rejects → **BFI, see Q2 (resolved)** |
| **Out of MVP** | The quote builder is a **link-out to the existing third-party tool**. Only the button is in scope. |

### J4 · Fulfil and pay the tech (Dispatcher → AP)

**SOP stages 10–14** · **[DERIVED]**

| | |
|---|---|
| **Decisions** | (a) schedule the visit — offer the assessing tech first (BR-DSP-003) (b) AP: approve and pay, or reject |
| **Clocks** | schedule within 2 business hours of approval (BR-OBL-010) · payment within 2 business days (BR-OBL-012) |
| **Evidence needed** | After-photos, checklist, prior payments to this payee (BR-PAY-005) |
| **Exceptions** | Parts needed → `waiting for parts` · return trip → repeat from scheduling · **[OPEN Q10]** are assessment-only visits paid? |

### J5 · Audit, release, invoice, collect (AR)

**SOP stages 15–18** · **[DERIVED]** — this is the grey-flag flow, already built and unit-tested (24 tests)

| | |
|---|---|
| **Decision** | Is the evidence complete enough to release for invoicing |
| **Evidence needed** | Quote on file, sign-off sheet, before/after photos, CICO, CO# (6 digits), file labels |
| **Gate** | Admin Check **and** Quote Check both ticked (BR-REC-002/010) |
| **Exceptions** | BFI waives after-photos (BR-REC-007) · SharePoint offline → audit on remaining evidence, gate still applies |
| **Note** | SharePoint checks currently report "offline". Credentials exist in the legacy project; wiring them is unscheduled. |

---

## 3. Proposed answers to the PRD's open questions

`PRD-WRK-001` §19 states: *"must not enter build with **Q1, Q5, Q10, Q11** unresolved."* Those four first.

### Q1 — Accept/decline criteria · **BLOCKING**

**[DERIVED] from production, and the finding is unexpected:**

- **Ecotrak `REJECTED` — the service-provider decline path — appears 0 times in 232 work orders over 3 weeks.** Declines are either genuinely rare, or they happen outside the system entirely (a phone call, and the WO is simply cancelled by the client).
- `CANCELLED` appears 10 times (4%) — but that is the **client** cancelling, not us declining.
- **NTE floor:** the minimum NTE in production is exactly **$250** and nothing falls below it. That looks like a floor already imposed upstream, not a filter we apply. 55% of WOs are under $750.
- **Geography:** 26 states, 6 of them with a single WO. Coverage thinness is real but concentrated in the tail.

**[ASSUMED] proposal:** there is no formal decline rule today because declining is rare and handled by conversation. For the MVP, implement decline as a **recorded action with a mandatory free-text reason** (per BR-WRK-004), collect reasons for the pilot, and derive criteria from real data at R2 rather than inventing thresholds now.

→ **Needs from PM:** confirm declines happen out-of-system today, and confirm nobody wants an NTE floor enforced at intake.

### Q5 — Do emergency WOs skip stages? · **BLOCKING**

**[DERIVED]:** 15 emergencies (6%, ~0.7/day). 6 of 15 carry a proposal, versus 50% across all WOs.

⚠️ **That is suggestive but statistically underpowered** — n=15, and 40% vs 50% is well within noise. It hints that emergencies bypass quoting more often, but it does not establish it.

**[ASSUMED] proposal:** emergencies do **not** get a separate pipeline. They keep the same stages, but the 2-hour acknowledgment clock (BR-OBL-007) runs and dispatch may proceed before a quote exists. That is the smallest change that matches both the rules and the data.

→ **Needs from PM:** one sentence from dispatch — "on an emergency we do X before quoting."

### Q10 — Tech payment terms · **BLOCKING**

**[OPEN]** — cannot be derived. Needs the AP lead: per visit or on completion? Are assessment-only visits paid? Who signs off besides AP?

### Q11 — Definitive payment-method list · **BLOCKING**

**[DERIVED]** The web UI already ships a list: `Zelle · ACH transfer · Check · Company card · Cash App`. **[ASSUMED]** this is the real list. → AP lead to confirm or replace. Cheapest of the four to close.

### Q2 — Client declines all options · **RESOLVED**

**[DERIVED]** Answered 2026-08-18: the WO moves to **completed** and the dispatcher is tagged **BFI — Bill For Incurred**. Implemented; `incurred_subtotal` already exists and bills independently of the option total.

### Q3, Q4, Q6, Q7, Q8, Q9, Q12, Q13 — not MVP-blocking

**[DERIVED]** Q3 (tier gates) and Q4 (ATL self-approval, conflict C1) both wait on auth, which is deferred past the MVP. Q13 (per-CMMS push differences) is R2 — but note **Ecotrak permits writing only 9 statuses**, which constrains any outbound design.

---

## 4. Which of the 102 custom fields matter

**[DERIVED]** Population across 232 production work orders:

| Field | Populated | MVP? |
|---|---|---|
| `problem_type`, `description`, `trade`, `priority_type`, `not_to_exceed`, `current_eta`, `asset.name`, `location.store_number`, `notes[]`, `over_time_approved` | **100%** | **Yes** |
| `requested_by` | 92% | Yes |
| `location.phone_1` | 89% | Yes — site contact |
| `proposal` (total, labor, material, incurred) | 50% | Yes |
| `asset.model_number` | 26% | Store, don't surface |
| **`purchase_order`** | **0%** | **No** — the legacy map routes this to `19. CO#`; it is always empty |
| **`invoice`** | **0%** | **No** |

**[ASSUMED]** The pilot needs roughly **15–20 fields**, not 102. The remaining ~85 are Seamless-internal workflow fields with no Ecotrak source (`BR-*` flags, `Days since…` formulas, link/pin fields) — they stay in the custom-field bag and surface only where a journey needs them.

→ **Needs from PM:** which internal fields a dispatcher actually reads during J1/J2. That is the list that gets promoted to real columns.

---

## 5. Feature calibration

**[DERIVED]** volume; **[ASSUMED]** cost/reversibility judgements.

| Feature | Volume/day | Actors | Cost of wrong | Reversible | → Depth |
|---|---|---|---|---|---|
| Ecotrak intake | 11 | automatic | duplicate or missed WO | yes | Medium — dedupe already keyed on Ecotrak id |
| Accept / decline | ~11 | TL/ATL/AM | declining real work | **no** (ends the flow) | Confirmation + mandatory reason + audit row |
| Route to book | ~11 | OA/TL | wrong dispatcher; delay | yes | Low — a dropdown |
| Status change | ~30–40 **[ASSUMED]** | all | wrong clock, wrong client view | yes | Medium — needs a transition allowlist |
| Quote build | ~5 (50% of WOs) | Senior OM | money, client-facing | yes, pre-send | **Out of MVP** — link-out |
| Tech payment | ~5 **[ASSUMED]** | Dispatcher → AP | **pays the wrong person; no clawback (Q8)** | **no** | Highest — dual control, prior-payment check |
| Grey-flag audit | ~8 **[ASSUMED]** | AR | invoicing unfinished work | yes | Medium — built and tested |
| Client-visible push | ~11 **[ASSUMED]** | OA, TL-gated | **stop-the-line incident (BR-ACC-001)** | **no** | Highest — explicit allowlist, TL gate |

**Two features carry irreversible risk: technician payment and the client-visible push.** Everything else can be undone by a human. Those two earn confirmation dialogs, tighter permissions, and audit rows; nothing else should be slowed down.

---

## 6. Assumption register — where to spend the review

Ordered by how much rework a wrong answer causes.

| # | Assumption | If wrong |
|---|---|---|
| A1 | Ecotrak intake is automatic; the OA's manual registration largely disappears | Rewrites J1 and changes the OA's role in the pilot |
| A2 | Routing is by trade + geography + load | Changes the routing UI and possibly needs a load model |
| A3 | Emergencies keep the same pipeline, just with a clock | Would need a separate fast-path flow |
| A4 | Declines are rare and handled out-of-system | Would need decline criteria enforced at intake |
| A5 | 15–20 fields matter, not 102 | Changes every WO screen |
| A6 | The 5 payment methods in the UI are the real list | Small — a lookup change |
| A7 | Pending = blocked on someone outside dispatch (3 statuses) | Changes filters and KPI counts |
| A8 | 13 trade mappings routed to Handyman | Mis-routes ~30 WOs/3 weeks |
| A9 | Dispatchers touch ~30–40 status changes/day | Changes whether bulk actions are needed |
| A10 | Assessment-only visits are paid (Q10) | Changes the payment trigger and BR-PAY-004 |

---

## 7. What I could not draft

Honest gaps — no source exists and inference would be invention:

- **Team shape.** How many dispatchers, how books are divided, who covers which clients.
- **Time budgets.** The SOP gives deadlines (business hours/days), not how long a task takes. Calibration for screen design needs the latter.
- **Non-Ecotrak intake.** Volume and shape of email/phone/other-CMMS work orders.
- **Vendor bench.** Which techs, which trades, which regions, what rates. This is the R1 vendor module's whole input.
- **What people do outside the system today.** Spreadsheets, WhatsApp threads, personal notes — usually where the real requirements hide.

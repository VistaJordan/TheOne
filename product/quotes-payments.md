# Quotes & Technician Payments — Requirements (v1)

**Source:** Jordan's walkthrough 2026-07-30, with screenshots of the current quote tool ("Yoda") and the technician payment-request tool as reference. UX corrections informed by the ui-ux-pro-max audit of those screenshots.

---

## 1. Quote (the Yoda replacement)

A quote belongs to a work order and produces the client-facing proposal that gets synced to the client's CMMS.

### Structure (observed in the current tool, carried forward)
- **Context strip** (read-only, from the WO): WO #, Comp (billing entity), FM company, location, dispatcher, trade, external TaskId, keywords.
- **Two work sections:**
  - **INCURRED** — work already performed (trip, assessment labor). Its own narrative + line items.
  - **PROPOSED** — one or more **Options** ("Add Option"); each option carries its own narrative + line-item table; options can be shown as separate quotes ("Show all options as separate quotes"); per-option "Include in Summary" toggle.
- **Narrative per section:** "Tech reported that…" + "Required is to…" (scope-of-work list). These feed the summary.
- **Line item:** type (Service / Labor / Part / Material), description, qty, rate, day, OT flag, amount (computed qty × rate; OT math TBD), drag-reorder, delete, add-row.
- **Money (live-computed):** Total Cost (our cost) · Grand Total (client price) · Sales Tax · **NTE** (warn as quote approaches; blocking over-NTE is TBD) · **Profit** (grand − cost) with margin %.
- **Extras:** Specs, Note to Customer.
- **SUMMARY (the money shot):** auto-generated text block — narratives + incurred/proposed line summaries + totals. **This is the text that goes to the client CMMS.** Editable before send? (open question)

### Workflow & permissions (DECIDED)
- States: **Draft → Pending approval → Approved → Sent to CMMS** (+ Rejected back to Draft).
- **Create/edit:** dispatcher (OM) and above.
- **Approve and Send to CMMS: ATL and above only** (ATL, TL, AM, admin). Dispatchers see the approve/send controls **visible but locked** with an explanation tooltip — never hidden (discoverability rule).
- An approved quote fills `money.quote` on the WO — the NTE meter binds to it (today that meter falls back to invoiced).
- Every state change → activity_log; the client-visible sync event follows the `client_visible` machinery.

## 2. Technician Payment Request (AP / payables)

- **Context header** (from WO): WO #, location, requestor (OM), Comp, FM.
- **Fields:** technician — should link to the **vendor record** (name + phone fallback for unregistered techs) · purpose · amount · payment method (list TBD) · attachment (receipt/invoice image) · note · optional **alternate recipient** ("send payment to someone other than the technician").
- **Flow:** submit → payment request lands in the AP queue → (approval chain TBD) → paid. Status on the request: Requested → Approved → Paid (or Rejected).
- **Previous payments for this WO** table: date, recipient, method, purpose, amount — visible right on the request screen.
- Persists to the `payable` table (schema extension needed: method, purpose, requestor, alternate recipient, attachment ref, status timeline).

## 3. UX corrections vs. the current tools (ui-ux-pro-max audit)

The reference tools violate several rules the skill flags; The One's versions must fix all of these:
1. **Labels above every field** — current tools are largely placeholder-only (`form-labels`, High).
2. **Required indicators** + validate on blur + error text adjacent to the field (`required-indicators`, `inline-validation`, `error-placement`).
3. **Disabled ≠ enabled styling**: submit disabled until valid with reduced opacity + cursor; loading state on submit (`disabled-states`, `submit-feedback`).
4. **Contrast:** current dark UI has sub-AA gray-on-dark labels; The One versions inherit the token gate (≥4.5:1 both themes).
5. **Role-gated actions render locked, not hidden**, with a "Requires ATL or above" tooltip (`empty-nav-state`).
6. **Computed values styled read-only, distinct from disabled** (`read-only-distinction`) — the green float text under inputs in the current tool is ambiguous.
7. **OT checkbox gets a label and defined semantics** (multiplier TBD).
8. **One primary CTA per screen per role**: OM sees "Submit for approval"; ATL+ sees "Approve & Send to CMMS" (`primary-action`).
9. **Autosave drafts** + confirm before dismissing with unsaved changes (`form-autosave`, `sheet-dismiss-confirm`).
10. Money columns right-aligned with **tabular numerals** (`number-tabular`).

## 4. Answers (Jordan, 2026-07-30)
1. **OT = overtime, ×1.5 rate.** The **Day** column's semantics will be reverse-engineered from the real quote-builder project when imported — leave the column present, math TBD.
2. **Sales tax derived from state** — the exact logic will be imported from the real project.
3. Payment methods + payment approval chain — **same: import from the real project.**
4. Proposal options are **internal** (for us, not client-picked). The "client chooses an option" framing is dropped.
5. Push to client CMMS after approval: **OA pushes manually once ATL+ approves — or the ATL+ can push themselves.** Two-role flow, both explicit actions.
6. Summary **is editable — text only** (no rich formatting).

### Permission refinement (supersedes §1 where different)
- **Quote builder access: Senior OM and above.** (Coordinators and standard OMs do not see the builder.)
- Approve & Send to CMMS: **ATL and above** (unchanged).
- Push execution: OA (manual) or ATL+ (self-serve).

## 5. Quo, Quotato, and the Messages tab (added 2026-07-30)

**Quo = OpenPhone** (the company's VoIP/SMS tool). The repo at `Quo X Quote Builder/` (codename **Quotato**) is a working Next.js connection layer that:
- Receives Quo webhooks for dispatcher↔technician **calls** (transcript/summary/recording arrive post-call) and **SMS/MMS** (fix plans, pricing, photos).
- Correlates events into **Jobs** — one tech + one dispatcher about one visit, segmented by time windows on the tech's phone number.
- Exposes **`getJobContext(jobId)`** — transcript + tech texts + photos + a ready-to-prompt blob — explicitly designed as the seam for **quote drafting / RAG**. (This is how "Tech reported that…" gets auto-drafted.)
- Stack: Next.js 15, Prisma (Postgres/Neon), Microsoft sign-in, Pinecone (RAG), monitored-lines model where dispatchers claim Quo lines.

**Integration direction:** The One absorbs/consumes Quotato as its tech-communication module. Full reverse-engineering map: `product/quo-map.md` (in progress).

### Messages tab (WO detail — new requirement)
- New tab on the WO screen: **Overview · Messages · Audit trail · All fields**.
- Mirrors the dispatcher↔technician conversation for this WO's job (from Quo via Quotato): SMS bubbles by side, MMS photo thumbnails, call entries (direction, duration, summary, expandable transcript), job-segment boundaries.
- **Dial from within**: call/text buttons that **open Quo (OpenPhone)** for now via deep link; a built-in dialer replaces this later.
- Clearly distinct from Updates & Activity: Messages = the external tech channel (never client-visible); Updates = internal team + client-visible items.
- Access follows WO access; no extra gate (the quote builder's Senior-OM+ gate does NOT apply here).

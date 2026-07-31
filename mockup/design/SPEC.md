# THE ONE — Mockup Shared Spec (v2 · Real ClickUp Data Edition)

**Product**: "The One" — the platform that recreates Byblos Vista / Seamless FM's real
ClickUp-based work-order operation as a purpose-built CMMS. One task = one work order.
Work arrives from FM intermediaries (Ecotrak intake and 120 FM companies like JDE, RCS,
FmUSA, DMG), is routed to account managers and field techs by moving between per-person
lists, quoted against a client NTE, and driven through a 19-status pipeline to invoicing.

**REQUIRED READING for every screen agent** (all in `mockup/design/`):
1. This file — vocabulary, mappings, hero WO, fragment contract.
2. `tokens.css` — design tokens + component classes (use them; don't restyle).
3. `clickup-data.json` — THE REAL DATA: 19 statuses w/ colors, 102 field defs (with
   dropdown options), 28 normalized real task samples, routing lists w/ task counts,
   people, tags, views, aggregates. Build screens from THIS data, not invented data.

**Demo persona**: Jordan B. ("JB", Admin — real workspace admin).
**Brand**: wordmark "THE ONE", sidebar sub-label "Byblos Vista". Logo = 24px rounded
square, `var(--primary)` bg, white bold "1".

## Fragment contract (MANDATORY — unchanged from v1)

Each screen is ONE self-contained fragment:
`<style>` (every selector prefixed `#screen-<name>`) + `<section class="screen"
id="screen-<name>">` + scoped IIFE `<script>` querying only inside the section.
- No external resources; icons = inline Lucide-style SVG (`viewBox="0 0 24 24"
  fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"
  stroke-linejoin="round"`); NEVER emoji as icons (emoji that appear inside real
  field names like `16. Client NTE 🔴` may be kept as text).
- Colors only via `var(--token)`. Both themes must work.
- Cross-screen nav ONLY via `data-goto="dashboard|workorders|workorder-detail|vendors|admin"`.
- Screen ids are FIXED (do not rename): screen-dashboard, screen-workorders,
  screen-workorder-detail, screen-vendors, screen-admin.
- Density: 13px body, compact, real data everywhere, tabular-nums on numbers,
  `mono` for WO ids and external reference numbers.

## The real workflow

### 19 statuses → pill hue mapping (order = pipeline order)

| Status | Pill class | Phase |
|---|---|---|
| Open | `pill--red` | Intake |
| emergency | `pill--red` | Intake |
| waiting for quote | `pill--red` | Quote |
| approved | `pill--violet` | Approval |
| return trip needed | `pill--red` | Assessment |
| assessment ongoing | `pill--amber` | Assessment |
| assessment scheduled | `pill--violet` | Assessment |
| job scheduled | `pill--violet` | Scheduled |
| job ongoing | `pill--amber` | In Progress |
| pm scheduled | `pill--indigo` | Scheduled |
| quote ready | `pill--blue` | Quote |
| please order parts | `pill--indigo` | Parts |
| waiting for parts | `pill--gray` | Parts |
| !! waiting for advice | `pill--cyan` | Approval |
| !! waiting for approval | `pill--teal` | Approval |
| << invoiced not paid >> | `pill--gray` | Invoiced |
| !! ready to invoice | `pill--green` | Done |
| done/incurred | `pill--green` | Done |
| !! canceled/postponed | `pill--gray` | (off-ramp) |

Phase bar for the detail header (19 statuses can't be a stepper — use phases):
**Intake → Assessment → Quote → Approval → Scheduled → In Progress → Parts → Done → Invoiced**

### Routing model (this replaces "assignment")
Dispatch = moving a WO between lists. Folder **Active** = 52 lists (one per tech/AM,
1,273 open WOs total) + ops buckets (Incoming WOs, Waiting for Approval Park,
DMG DONE park). Folder **✅ Finished WOs** = archive (Invoiced 17,770 · Canceled/
Postponed 124 · Ready To Invoice 15). Folder **SFM** = "Seamless FM Executive View",
2,056 multi-homed WOs surfaced for exec guest dashboards (Teresa/Ro).
Top workloads: AM Peter 116 · Matt Hammond 112 · Charly Snyder 89 · Sean Rodgers 72 ·
Adam Keller 67 · Joseph Foster 66 · Nate Hart 65 · Zach Malden 59 · Elio Armani 57 ·
John Hayes 54 (full list in clickup-data.json `routing`).

### Billing entities — `21. Comp` dropdown → chips

| Comp | Chip class | Share of sampled WOs |
|---|---|---|
| SFM | `chip--sfm` (blue) | 154 |
| AF | `chip--af` (violet) | 61 |
| BKR | `chip--bkr` (teal) | 54 |
| TPM | `chip--tpm` (amber) | 22 |
| RF | `chip--rf` (cyan) | 9 |
| EDS / sf | `chip--eds` / `chip--sf` (indigo/gray) | rare |

### People (real; use these, initials from names)
Owner: Michael Khoury. Admins: Jordan Brown (persona), Peter Hope (AM), Faysal AH,
Andrew El Housseini, Elise, Ion, Steven Khoury, Bernard Khoury. Techs/members seen in
tasks: Matt Hammond, Bob Sanders, Nadine Asher, Tania Quitalig, Mark Shannon, Jude
Baxter, Alan Tate, John Hayes, Adam Keller, Zach Malden, Kevin James, Carter Dane,
Mitchel Hampton. Exec guests: Teresa, Ro (Rocio).

### Clients / FMs / Trades / Tags (real vocabulary)
- Clients (top): SunHoldings 26 · Flynn 21 · MOD Pizza 15 · 7-Eleven 12 · RMH 12 ·
  WKS · Cheesecake Factory · Mobettahs · Swig · First Watch · Vuori · KinderCare.
- FM companies (top of 120): JDE, RCS, FmUSA, DMG, Trillium, Advanced, 7-Eleven,
  Flynn, CHEESECAKE FACTORY.
- Trades (16, by volume): Handyman 95 · Plumbing 94 · HVAC 42 · Electric 25 ·
  Appliance 13 · Refrigeration 12 · General Contracting 8 · Overhead Door 3.
- Tags = parts-procurement vocabulary ONLY: tech will order, tech ordered, ap will
  order, ap ordered, client ordered, vendor will order, vendor ordered, sourcing
  parts, dispatcher ordered part, dispatcher ordered door, corporate will order, efs.
  Render as small gray `.filter-chip`-like tags with a package icon.

### The real field schema (custom fields ARE the data model)
102 definitions; numbered names (`13.`–`38.`) = the ordered WO intake form. 100%-fill
fields: `35. WO Description`, `AM`, `City`, `State`, `Store`, `Trade`, `22. FM`,
`21. Comp`, `16. Client NTE 🔴`, `17. Address`, `Previous Assignees`,
`Date-Time Received`. Formula fields do SLA/profit math: `Profit`, `Give us Today`,
`Days Since INP`, `Days Since QC`, `Days Since Grey Flag`. Currency: `Total Invoiced`,
`34. Cost`, `Discount`. Full list with types + dropdown options in clickup-data.json.

## The hero work order (real — keep consistent everywhere)

**WO-39403** · external ref `WOT0452814` (7-Eleven's number) · 7-Eleven store 41669,
Galveston TX · "Standing freezer (customer facing) not holding temperature — stuck ice
cream freezer" · Trade: Refrigeration · Comp: SFM · FM: 7-Eleven · NTE **$3,202** ·
AM: Peter Hope · Tech: Matt Hammond (list "Matt Hammond") · status
`<< invoiced not paid >>` — BUT for the demo show it mid-flight at
**`!! waiting for approval`** with tag `tech ordered`, quote sent against NTE.
Money story (consistent with real averages): quote $2,890 vs cost $1,610 → profit
$1,280 (44%). Timeline: received 07-14 09:02 via Ecotrak → assessed 07-15 →
quote ready 07-16 → waiting for approval since 07-17 (aging 10d).

## Real numbers for dashboards (from clickup-data.json `aggregates`)

- Active WOs 1,273 across 52 lists; archive Invoiced 17,770.
- Status distribution (active samples): !! waiting for approval **46** (the #1
  bottleneck), quote ready 17, canceled 14, waiting for quote 12, waiting for parts 11,
  job scheduled 9, assessment scheduled 9, pm scheduled 7, Open 5, return trip 5,
  job ongoing 5, approved 4, invoiced-not-paid 3, assessment ongoing 2, advice 1, RTI 1.
- Invoiced sample (n=100): total invoiced $60,653 · cost $33,562 · profit $27,092
  (44.7% margin) · avg invoice $607 · avg profit $271.
- Flags in schema worth surfacing: `14. Missed ETA`, `13. Late quote`, `15. Recall`,
  `11. Penalty`, `Grey Flag Date` / `Days Since Grey Flag` (stale-WO aging).
- Real saved views (use as view tabs): All jobs, Today, Last 7 days, Last month, QC,
  QA, SunHoldings, MoD feedback + dashboards (Invoices Dashboard, Gloria's Dashboard)
  + Gloria's Map (geographic dispatch) + Workload.

## Charts rules (dashboard)
Categorical series: `var(--chart-1..4)` in fixed order, never cycled. Grid
`var(--chart-grid)`, axis text `var(--chart-axis)` 11px, thin marks, 2px gaps, legend
for ≥2 series, all chart text in ink tokens. Status colors reserved for state.

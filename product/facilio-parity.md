# Facilio parity — gap list and build batches

Written 2026-09-20. Companion to `feature-roadmap.md`, which keeps the layered
feature map and the sprint plan; this file is the **gap list against Facilio**
and the batches that close it.

- **Compared against:** the deployed app, not the branch tip — production deploy
  `the-nddtgogin` (15 Sep 2026), which serves commit `6c4ba83` of
  `phase-0-ground`. Verified by reading the live JS bundle's nav array.
- **Compared with:** "Facilio Platform Map" (Highly Sensitive, sections 1–10),
  the notes from the Facilio walkthrough.
- **Rule for this exercise:** nothing we have is dropped. Everything Facilio has
  gets added; where we already have a weaker version of it, it is listed as an
  adjustment.

Facilio is built for the **building owner** (the retailer, the hospital).
Seamless is the **service provider**. Their owner-side modules are listed here
for completeness but are deliberately last: Lease Management, Space Viewer,
Energy Analytics, AFE, Cost Center, Budget Monitoring.

## 1. Target sidebar

Facilio groups modules with sub-modules. Ours is flat plus an Admin group. The
target keeps every page we have, placed inside Facilio's groups.

| Module | Sub-modules (*italic* = we have it, **bold** = to build) |
|---|---|
| Home | *Dashboard* · *Pulse* · **Portfolio** · **Space** · **Site Event** · **Space Viewer** |
| Asset | **Assets** · **Asset Condition** · **Asset Management Request** · **Asset Warranty Contracts** |
| Maintenance | *Work Orders* · *Incoming Work Orders* · *WO Intake* · **Planned Maintenance** · **Job Plans** · **Technician Time Tracker** · **Services** · **Work Permit** · **Assignment Manager** |
| Approvals | *ours; in Facilio it is only a dashboard tab* |
| Help Center | **Service Requests** · **Service Catalog** |
| Financials | *Quotes* · *Payments* · *Receivables* · **Invoice** · **Purchase Request** · **RFQ** · **Purchase Order** · **Vendor Quotes** · **Budget Monitoring** · **Tax Rate** · **Cost Center** · **AFE** |
| Vendor | **Vendor** · **Vendor Contact** · **Certificate of Insurance** · **Vendor Invoicing Rule** · **Vendor Credit Note Rule** · **Vendor Dispatch** · **Consumables** · **Skills** · **Induction** · **Vendor Onboarding** |
| Contracts | **Contract** · **Labor Rates** (record holds Sites / Assets / Categories Covered) |
| Inspection | **Inspection** · **Inspection Models** · **Findings** |
| Project Management | **Projects** · **Tasks** |
| Lease Management | **owner-side, last** |
| Budget Monitoring | **Expenditure Budget Tracking** (Facilio lists it twice; build once, surface twice) |
| Setup (our Admin) | regrouped — see batch 7 |

Top bar: add an **All Sites** filter, a **profile menu** (name and sign-out are
at the foot of our sidebar today), and **email delivery of notifications**
(ours are in-app only). Facilio's floating Twilio **Call Center** widget maps to
our Quo/OpenPhone thread.

## 2. Build batches

Provisional migration numbers. **Next free number at the time of writing is
0041** — always `git fetch` and `ls packages/db/migrations | tail -1` before
claiming one; two sessions took 0035 on the same day.

Each batch is shippable and deployable on its own.

### Batch 1 · Vendors  (migrations 0041, 0042)

The one inert item in the live sidebar, and the biggest hole: a work order
cannot be assigned to a company. It blocks Facilio's Responsibility panel,
preferred-vendor dispatch, compliance gating, the vendor-performance dashboards
and vendor bills.

- Vendor list: ID, name, primary contact name / email / phone, communication
  type (call / email), insurance on file, active filter, New vendor.
- Vendor record: Summary · Contacts · Related (sites serviced, rates, categories
  covered) · History · Comments & Documents. Actions: Add as preferred vendor,
  Mark inactive.
- Trades and geographic coverage (state / county / city).
- Rates: standard, overtime, double time, trip charge.
- Certificates of insurance: cover type, insurer, policy number, valid from /
  to, the document, expiry warning before lapse.
- Preferred vendor per client + site + trade, ranked.
- **On the work order:** vendor field, Responsibility panel, "Assign /
  re-assign vendor" header action, assignment history in the audit trail.
- **Data:** `vendor` today has only name, trades[], phone, city, state.
  0041 extends it (code, status, description, website, address, tax id,
  communication type) and adds `vendor_contact`, `vendor_coverage`,
  `vendor_rate`, `task.vendor_id`. 0042 adds `vendor_document` and
  `preferred_vendor`.
- **Permissions:** the `vendors` branch exists but is marked "module not live";
  fill it in with `vendors/compliance` and `vendors/rates`.
- **Done when:** a dispatcher can pick a vendor on a work order, the header
  shows who is responsible, and an expiring COI is visible before it lapses.

### Batch 2 · Portfolio and Assets  (0043, 0044)

- Sites as records: store number, address, site type, managed by, phones,
  boundary radius (geofence), ownership status, equipment flags; counts strip
  for Sites / Buildings / Floors / Spaces; entity tag.
- Buildings, floors, spaces.
- Assets per site: type, model, warranty expiry, parent asset, space, category,
  service history.
- **Link the work order to its site and asset.** `site` and `asset` exist
  (imported from Ecotrak) and `task.site_id` / `task.asset_id` exist, but the
  Site tab is still loose text fields.
- Clients get a table (today client is plain text on task and site).
- **Scope people by site**, alongside today's Comp + assignee scoping
  (`work_orders/scope`, migration 0026).
- **Done when:** a work order opens its site and asset records, and a user can
  be restricted to a list of sites.

### Batch 3 · Creating a work order, and attachments  (0045)

"Add work order" is visible but disabled on the live site; work orders only
arrive from Ecotrak, CSV import, or the OP Admin's intake drafts.

- Full create form: site, asset (auto-filling warranty, parent asset, space,
  category), category and **sub category**, **type of problem** (damaged,
  electrical, gas, high temperature, leak inspection, leaking water, physical
  damage, power loss, temperature), priority, subject, description, **internal
  or external supplier**, work permit needed, preferred vendor, attachments.
- **Potential duplicates** panel while typing.
- **Attachments and photos that actually upload** — disabled today in the
  update composer, on payment requests and on quotes. Non-negotiable for a
  work-order system: before/after photos are how a job is proved.
- Form templates (Facilio's "Standard" selector).
- **Done when:** a coordinator can raise a complete work order in the app with
  photos, without Ecotrak or a CSV.

### Batch 4 · The work-order record  (0046)

- Summary right rail: Responsibility, Location, Time details (live timer,
  scheduled from/to, actual from check-in/out, response due, due date), Cost.
- New tabs: Tasks / checklist, Cost Breakdown, Timelog & Metrics, Related.
- Header actions: Cancel work order, Increase NTE (today an NTE task is only
  raised automatically when cost passes NTE), Pause, Add ETA, Tag + tag reason,
  Complete Service (completion note, fault code, action code, temporary fix?).
- Keep ours that Facilio lacks: All fields, Dates, CICO, People, Parts, Flags,
  Messages, Pulse clocks.

### Batch 5 · Money  (0047, 0048)

> **Built 2026-09-21** as migrations 0045 (invoices, the day before), 0046
> (contracts and labor rates), 0047 (vendor bills + approval tiers, rule 6.2.3)
> and 0048 (the quote as a document: number, type, bill/ship to, per-line UOM /
> tax / markup, print view). Not done from this list: auto-generate on
> completion is on-demand (Raise invoice reads the contract), and "PDF output
> via templates" is the browser's print dialog over one print stylesheet.

- **Invoices as records.** Receivables › Invoicing is front-end only today:
  ticks and stages live in page state and are lost on reload, and no invoice is
  ever saved.
- Both directions: our invoices to clients (AR) and vendor bills to us (AP).
  Facilio only models the vendor bill.
- Invoice contents: vendor block, contract reference, lines (item, unit price,
  qty, tax, UOM, amount), subtotal, discount, misc charges, adjustment,
  shipping, total tax, grand total. Tabs: Summary · Notes · Related · History.
- Auto-generate on completion from contract rate × hours on site; Confirm
  invoice; tiered approval by amount.
- **Contracts and Labor Rates:** contract (type Scheduled PM / T&M, account
  code, start, end), contract charges by rate type, sites / assets / categories
  covered. Replaces the hard-coded ×1.5 overtime in the quote builder.
- **Quote document upgrade:** quote number, document type, billing and shipping
  address, currency, per-line unit price / UOM / tax % / markup %, PDF output
  via templates, and Approved / Pending views on the Quotes list.

### Batch 6 · Dashboards  (0049)

> **Built 2026-09-21** as 0042 (library, folders, role sharing, drill-through),
> 0044 (line cards + the period stepper) and 0049 (gauge, live, narrative,
> image and button cards; cards over invoices / payments / vendor bills; the
> filter bar; `today±n` date rules; the Accounting and Service levels boards).
> Not done: tabs and groups inside one dashboard; the vendor / asset / store
> boards still wait on batches 1–2 for their records.

Library with folders per team, sharing to roles, tabs and groups inside a
dashboard, page filters (vendor, site), period stepper, and widget types beyond
our three: chart, gauge, table, filter, image, narrative, command button, live
data. Click-through from number → list → record; our KPI row is not clickable
today. Prebuilt: Maintenance Supervisor, Dispatch Center, Vendor Performance,
Accounting, Technician, Asset Management, WO Reports, Unified Ops, Store
Manager. Most of Facilio's cards (SLA met/missed, recalls, geofence, paused,
internal vs external, unassigned) only become possible after batches 1–2.

### Batch 7 · Setup (our Admin), regrouped

Keep all eight pages, regrouped into Facilio's sections, and add:

- **Users & Access:** search, verified filters, export; side panel with phone,
  mobile, time zone, language; site scoping and permission sets; Impersonate on
  the user row (we have Viewing-as in the top bar); Revoke app access. Plus
  Single Sign-On page, Security Policy, **Delegates** (hand your approvals over
  while away), Data Access Control. "Delete user" becomes a soft delete — the
  audit log is append-only at the database (0029) and cannot lose an actor.
  "Reset password" does not apply: sign-in is Microsoft Entra.
- **Roles:** module on/off switch above each sub-module, Share / Schedule /
  Export actions, "manage accessible users", permissions per device (web /
  mobile / tablet).
- **Customization:** Modules, Connected Apps, Connectors, Functions, Email
  Templates, Localization, Tabs & Layouts (ours are fixed in code), PDF
  Templates.
- **Automation:** enable the disabled Vendors / Quotes / Invoices tiles; add
  fill-a-field-by-lookup (auto-fill AM, dispatcher or vendor from other fields).
- **Logs:** add Email, Script, Impersonate, Background Activity, KPI Execution,
  Rule (our automation run log), Inbound Mail Conversion, User Session. Ours
  already exports, which Facilio's cannot.

### Later

Planned Maintenance · Job Plans · Technician Time Tracker · Services · Work
Permit · Assignment Manager · Help Center (service requests + catalog) · vendor
onboarding portal (5 steps, US forms: EIN / W-9 / routing, not Facilio's
ABN / BSB) · vendor & technician portal · Inspection · Projects · integrations
breadth (Maximo, ServiceNow, Vicinitee, ERP/CRM, Power BI, Tableau, QuickBooks,
Xero, WhatsApp, Teams, Twilio, CDYNE) · AI agents (helpdesk triage, invoice
validation, copilot, vendor document validation, OCR) · then the owner-side
modules.

## 3. Placeholders these batches replace

Nothing working is removed. What goes away:

1. The inert **Vendors** sidebar item → the real Vendor module (batch 1).
2. The orphan **`invoicing` permission**, which has no sidebar item → Financials
   › Invoice (batch 5).
3. **Page-only state in Receivables › Invoicing** → saved invoice records. The
   tab stays (batch 5).
4. Disabled "coming / later sprint" stubs go live: **Add work order**, the
   payment-request drop zone, attach and photo in the composer, "show all
   options as separate quotes".
5. `CLAUDE.md`'s line calling Vendors and Invoicing inert placeholders.

## 4. Constraints and open questions

- **No write-back to Ecotrak until go-live.** Standing rule; the adapter is
  inbound-only. Facilio's outbound pushes stay out of scope.
- **The audit log is append-only** (0029 trigger). Any Facilio feature that
  edits or deletes history becomes a new row instead.
- **Entra SSO** means no password management in Users.
- **Preferred-vendor auto-dispatch** (Facilio's 5-minute cascade to the next
  vendor) needs a vendor portal or SMS first — batch 1 builds the ranking, not
  the cascade.
- **Not captured in the walkthrough:** Inspection, Projects, Lease, Planned
  Maintenance, Work Permit, Help Center contents, and the Setup sections marked
  "Not reviewed" (General, Resources, Automation Plus, Process, Portfolio
  Settings, Workorder Settings, Energy Analytics, Data Administration). These
  need a second Facilio session before they can be scoped.
- **Open:** do we build the owner-side modules at all, or park them
  permanently?

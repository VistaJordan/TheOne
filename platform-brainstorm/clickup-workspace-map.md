# ClickUp Workspace Map — "Byblos Vista"

Generated: 2026-07-23 (strict read-only, GET-only mapping)
Token owner: **Faysal AH** (faysal@byblosvista.com), role = admin, timezone Asia/Beirut, user id 88042564.
Raw JSON saved under: `clickup-raw/`

---

## 1. Workspace Overview

| Attribute | Value |
|---|---|
| Team / Workspace name | **Byblos Vista** |
| Team ID | 9005131470 |
| Color | #40BC86 (green) |
| Members (total) | **98** |
| Spaces | **3** (1 production + 2 sandboxes) |
| Folders | **7** |
| Lists | **163** |
| Tasks (production space) | **~21,239** (task_count sum) |
| Goals | 0 (none) |
| Docs | 50+ (pagination cursor present; not exhausted) |

This is not a generic PM workspace — it is a **bespoke field-service / work-order (WO) management system** for a facilities-maintenance operation (multi-brand: Byblos Vista, Seamless FM, Alpha Fixers). Everything is built around a 19-status work-order lifecycle and ~100 custom fields per list.

### Member roles (from /team)
| Role | Count |
|---|---|
| owner | 1 (Michael Khoury, michael@byblosvista.com) |
| admin | 8 (Andrew El Housseini, Elise, Faysal AH, Ion, Steven Khoury, Bernard Khoury, Peter Hope, Jordan Brown) |
| member | 84 |
| readonly_guest | 5 (Teresa, Rocio, Michael Khoury@seamlessfm, Faysal Test@alphafixers, Bernard Test@seamlessfm) |

Email domains present: `@byblosvista.com` (bulk), `@seamlessfm.com` (guests/execs: Teresa, Rocio, Michael, Bernard), `@alphafixers.com` (Ion, Marc, a test). Confirms a three-brand relationship (Byblos Vista operating co / Seamless FM front / Alpha Fixers dev+ops).

---

## 2. Per-Space Breakdown

All 3 spaces are **clones of the same template** — identical 19-status workflow, identical enabled features, identical folder scaffolding (`Active`, `✅ Finished WOs`, per-person lists). Only **Vista** carries real data.

| Space | ID | Private | Folders | Lists | Non-empty lists | Task volume | Purpose |
|---|---|---|---|---|---|---|---|
| **Vista** | 90050318380 | public | 3 | 60 | 37 | ~21,239 | **PRODUCTION** |
| Vista Training | 901313728027 | private | 2 | 46 | 2 | 7 | Training sandbox (copy) |
| Vista karen support automation steven | 901313763247 | private | 2 | 57 | 0 | 0 | Automation sandbox (empty) |

### 2a. Enabled ClickApps / space features (identical across all 3 spaces)

**ON:**
- `due_dates` (with `start_date` = true; remap = false)
- `priorities` (Urgent / High / Normal / Low)
- `tags`
- `check_unresolved`
- `custom_fields`
- `dependency_warning`
- `status_pies`
- `multiple_assignees`
- `emails` (email-in / email from task)
- `remap_dependency_settings` (enforcement_mode 2, reschedule_closed_dependencies)
- `reschedule_closed_dependencies`

**OFF / not configured:**
- `sprints` (off)
- `points` (off — no story points/estimates)
- `custom_items` (off — no custom task types)
- `milestones` (off)
- `scheduler_enabled` (false)
- `dependency_type_enabled` (false)
- `time_tracking` — present in the object (`default_to_billable: 2`) but **effectively unused** (0 sampled tasks had time logged)

### 2b. Status workflow (19 statuses — inherited by every list; `override_statuses=false`)

The WO lifecycle (type in parens):
`Open (open)` → `emergency` → `waiting for quote` → `approved` → `return trip needed` → `assessment ongoing` → `assessment scheduled` → `job scheduled` → `job ongoing` → `pm scheduled` → `quote ready` → `please order parts` → `waiting for parts` → `!! waiting for advice` → `!! waiting for approval` → `<< invoiced not paid >>` → `!! ready to invoice (done)` → `done/incurred (done)` → `!! canceled/postponed (closed)`

(16 custom "active" statuses, 2 done-type, 1 closed-type.)

### 2c. Vista (production) folder & list structure

**Folder `Active` (90050890353) — 52 lists.** One list per **technician** and per **account manager (AM)**, plus operational buckets. Non-empty highlights:

| List | ID | Tasks |
|---|---|---|
| AM Peter | 900501628761 | 116 |
| Matt Hammond | 901306316538 | 112 |
| Charly Snyder | 901306013371 | 89 |
| Sean Rodgers | 901307894811 | 72 |
| Adam Keller | 901317309748 | 67 |
| Joseph Foster | 901324003282 | 66 |
| Nate Hart | 901306316534 | 65 |
| Zach Malden | 901306187416 | 59 |
| Elio Armani | 901305240162 | 57 |
| John Hayes | 901326884931 | 54 |
| Pierre Dale | 901324003265 | 48 |
| Alan Tate / Jay Murphy / Julian Garcia | — | 45 each |
| Ben Jackson | 901325742991 | 46 |
| (…~20 more per-person lists, 2–40 tasks each) | | |

Special/operational lists in `Active`: **Incoming WOs** (900501628245, the known intake list — 0 open at sample), AM Peter/AM Kevin/AM Steven/AM Ion (account-manager queues), Waiting for Approval Park, DMG DONE park, Template, Testing -- IT, User 1.

**Folder `✅ Finished WOs` (90050901488) — 5 lists (the archive):**
| List | ID | Tasks |
|---|---|---|
| **Invoiced** | 900501628667 | **17,770** |
| Canceled/Postponed | 900501628767 | 124 |
| Ready To Invoice | 900501628638 | 15 |
| Checked | 901306256119 | 0 |
| RTI - Park | 901303521755 | 0 |

**Folder `SFM` (901318368651) — 1 list:**
| List | ID | Tasks |
|---|---|---|
| Seamless FM Executive View | 901327405473 | 2,056 (see note §3c) |

**Folderless lists (2):** `Sam (Normal Prio)` (0), `List` (1).

---

## 3. Task Usage Patterns (from first-page sampling, 100 tasks each)

Sampled: Matt Hammond (tech), AM Peter (AM queue), Invoiced (archive). SFM Exec View returned 0 (see §3c).

### 3a. Field/attribute usage
| Metric | Matt Hammond | AM Peter | Invoiced |
|---|---|---|---|
| tasks w/ assignee | 100% | 100% | 100% |
| tasks w/ due date | 100% | 99% | 99% |
| tasks w/ priority set | 6% | 12% | 100% (all "high") |
| tasks w/ tags | 17% | 2% | 0% |
| subtasks (parent set) | 0 | 0 | 0 |
| time tracked | 0 | 0 | 0 |
| avg **filled** custom fields / task | **25.6** | **26.2** | **39.0** |

Universally-populated custom fields (100% fill): `35. WO Description`, `AM`, `City`, `State`, `Store`, `Trade`, `22. FM`, `21. Comp`, `16. Client NTE 🔴`, `17. Address`, `Previous Assignees`, `Date-Time Received`. Archive adds `Profit`, `Grey Flag Date`, `Days Since Grey Flag`, `Assignee Name TXT`.

### 3b. Status distribution (illustrative, sampled page)
- Active/tech lists spread across the full pipeline; heaviest buckets: `!! waiting for approval` (~21–25%), `done/incurred` (~18–31%), `quote ready`, `waiting for quote`, `waiting for parts`.
- Invoiced list = 100% `invoiced` status (terminal archive).

### 3c. Notable: "Seamless FM Executive View" is an aggregation list
`GET /list/901327405473/task` returns **0 tasks** despite `task_count = 2056`. The 2,056 are **multi-homed tasks** (ClickUp "tasks in multiple lists") surfaced here for reporting, not native to the list. Its only views are two dashboards: **Teresa's Dashboard** and **Ro's Dashboard** (the two Seamless FM sales/exec guests). This is an exec reporting rollup, not an operational queue.

### 3d. Interpretation
- Workflow is **flat** (no subtasks) — one task == one work order.
- Work is routed by **which list** (person/AM) a task lives in, combined with **status**. Assignee + due date are mandatory in practice.
- **Priority** is not a manual signal on active work (≤12%); the archive's uniform "high" looks programmatically set.
- **Tags** are a narrow parts-procurement vocabulary, not general labeling.

---

## 4. Custom Fields Inventory

~94–96 fields defined per list; **102 distinct field names** across sampled lists. Field definitions are shared across the space's lists (WO fields appear on tech lists, AM lists, and the archive alike).

### Field types actually in use (13 distinct)
`checkbox`, `short_text`, `text` (long/rich), `drop_down`, `date`, `users`, `formula`, `currency`, `attachment`, `location`, `emoji`, `url`, `number`.
(Not used: `labels`/multi-select, `rating` beyond emoji, `phone`, `email` type, `tasks` relationship type, `manual_progress`.)

### High-value fields by type
- **drop_down** (with option counts): `Client` (40 brands: Swig, First Watch, MOD Pizza, Flynn, Outback, Vuori, KinderCare…), `22. FM` (**120** facility-management companies: JDE, RCS, FmUSA, DMG, Trillium…), `State` (71), `Trade` (16: Plumbing, Electric, HVAC, Handyman, Janitorial, Roofing, HVAC PM…), `21. Comp` (7: AF, SFM, TPM, RF, BKR, EDS, sf — the billing entity), `MoD Call` (9), `QC` (7 issue categories), `18. Check-in/out Status` (3), `Sales Owner` (3: Ro/Teresa/-), `23. Action` (4), `Problem Type` (2).
- **formula**: `Profit`, `Give us Today`, `Days Since INP`, `Days Since QC`, `Days Since Grey Flag`, `Days since Done`, `Days since Invoiced` — SLA/aging + profitability math.
- **currency**: `Total Invoiced`, `34. Cost`, `16. Client NTE 🔴` (not-to-exceed), `Discount`.
- **users**: `AM`, `TL` (team lead), `Completion Assignee`, `Invoicing Assignee`, `Relationship Owner`, `Previous Assignees`, `31. Support Trainee`.
- **date**: `Date-Time Received`, `Invoice Date`, `Pay Date`, `QC Date`, `Grey Flag Date`, `SLA Due Date`, `Act ETA`, `👣 Parts Order Date`.
- **checkbox** (many status/flag toggles): `1. Not Fully Paid`, `11. Penalty`, `13. Late quote`, `14. Missed ETA`, `15. Recall`, `Quote Check`, `Admin Check`, `GTG`, `INV/COLL`, `🚨 SLA Requested/Updated`, `🚨 Feedback Requested/Updated`, `✅ On Sheet`, `Capital Project`, `Audited`, `Bill For Incurred`.
- **attachment**: `WO PDF`, `37. PDF`. **location**: `17. Address`. **url**: `28. Sharepoint Link`. **emoji**: `Tech Rating`. **number**: `Hours To Checkout`.
- Numbered fields (`13.`, `16.`, `17.`…`38.`) indicate a deliberately **ordered form schema** — this is a structured WO record, effectively a database table rendered as ClickUp tasks. Some legacy/duplicate fields exist (e.g., `29. PDF Link` vs `PDF Link`, `36. Name - OLD`).

---

## 5. Tags

Space `Vista` has **12 tags**, all a **parts-procurement vocabulary** (who is ordering parts):
`tech will order`, `tech ordered`, `ap will order`, `ap ordered`, `client ordered`, `vendor will order`, `vendor ordered`, `sourcing parts`, `dispatcher ordered part`, `dispatcher ordered door`, `corporate will order`, `efs`.

Tags are **not** used as a general labeling system — only ~2–17% of tasks carry one, and only in the parts phase.

---

## 6. Views Actually In Use

View types observed in real use (~12 distinct): **table, list, board, dashboard, box, activity, workload, calendar, conversation, location_overview, map, doc.**

**Team level (`/team/.../view`):** 3 `doc` views + 1 `conversation`:
`Company Wiki`, `Team Docs`, `Summaries of 25 Must-Read Productivity Books`, `Byblos Vista` (chat).

**Space `Vista` (21 views):**
- `table` ×9 — the workhorse: `QC`, `All jobs`, `SunHoldings`, `MoD feedback`, `Last 7 days`, `Last month`, `Today`, `QA`, `All jobs (copy)`
- `dashboard` ×2 — `Invoices Dashboard`, `Gloria's Dashboard`
- `list` ×2 — `All jobs (copy)` variants
- `conversation` ×2 — `Chat`, `Vista`
- `box` ×1 — `Team`
- `activity` ×1, `workload` ×1, `calendar` ×1
- `location_overview` ×1 — `Overview`
- `map` ×1 — `Gloria's Map` (geographic WO plotting)

**List level:** per-person lists default to a `board` view + a `conversation`; the SFM Exec View exposes only the two exec **dashboards** (`Teresa's Dashboard`, `Ro's Dashboard`).

Takeaway: heavy reliance on **table views** (spreadsheet-style filtering of the WO database) + **dashboards** for reporting; **map/workload/calendar** used for dispatch/logistics. Gantt/timeline **not** in use.

---

## 7. Docs & Goals Inventory

**Goals:** none (`/team/.../goal` returned empty — no OKRs/goals in use).

**Docs (v3):** 50+ (first page of 50; `next_cursor` present, not exhausted). Almost all authored by the **owner Michael Khoury** (id 50678998) in **2023**, and are business/ops notes rather than task docs:
- Ops/HR: `Company Wiki`, `Team Wiki`, `Employee Handbook`, `Onboarding Guide!`, `Welcome!`, `Privacy Considerations`, `Template Guide`, `Getting Started Guide` (several copies).
- Growth/sales: `HBS Partnerships Outreach`, `LinkedIn Message`, `Outreach Data`, `Software List`, `FM List`, `Future Improvements`, `IDEAS`, `Brainstorming`.
- Hiring: multiple `… Tech Lead Interview Scoring` docs, `Offer Discussion`.
- Recent (2026) automation artifacts: `Vista Daily Health Reporter Memory` (created by a **bot/integration user, id -39963952**), `WOFM0000110778` (a per-work-order doc), a few blank `Doc`s.

Docs are a **legacy knowledge base** (2023-heavy) plus a small trickle of 2026 automation output — not an actively maintained doc surface.

---

## 8. Gap Notes — What This Workspace Actually Uses vs. What ClickUp Offers

**Used heavily (core of the operation):**
- **Custom fields at extreme scale** (~100/list, 13 types incl. formulas, currency, location, attachments) — ClickUp is being used as a **structured WO database / light ERP**.
- **Custom statuses** — a 19-step WO lifecycle is the primary workflow engine.
- **Lists as routing buckets** — one list per technician / account manager; work moves between people by moving lists.
- **Multiple assignees**, mandatory **assignee + due date**.
- **Table views + dashboards** for filtering and exec reporting; **map/workload** for dispatch.
- **Docs** as a knowledge base; **emails** ClickApp (email-in on tasks).
- **Multi-homing** (tasks in multiple lists) to build exec rollups (SFM Exec View → 2,056 tasks).

**Enabled but NOT actually used:**
- **Time tracking** (ClickApp on, `default_to_billable` set, but 0 tasks with logged time).
- **Priorities** (largely ignored on active work; archive value looks automated).
- **Dependencies** (dependency_warning/remap ClickApps enabled, but sampled tasks show no dependency use — flat WO model).

**Not used at all (ClickUp features left on the table):**
- **Sprints, story points/estimates, milestones, custom task types (`custom_items`), goals/OKRs, subtasks, scheduler.**

**Bottom line:** Byblos Vista has bent ClickUp into a **vertical field-service management platform** — WO intake → assessment → quote → approval → parts → job → QC → invoice → collect — driven by custom statuses + a ~100-field record schema + per-person lists + table/dashboard/map views. Agile/PM primitives (sprints, points, milestones, goals, time tracking, dependencies) are essentially unused.

---

## Appendix — Key IDs
| Thing | ID |
|---|---|
| Team | 9005131470 |
| Space: Vista (prod) | 90050318380 |
| Space: Vista Training | 901313728027 |
| Space: Vista karen support automation steven | 901313763247 |
| Folder: Active | 90050890353 |
| Folder: ✅ Finished WOs | 90050901488 |
| Folder: SFM | 901318368651 |
| List: Incoming WOs | 900501628245 |
| List: Invoiced (archive, 17,770) | 900501628667 |
| List: Ready To Invoice | 900501628638 |
| List: Canceled/Postponed | 900501628767 |
| List: Seamless FM Executive View | 901327405473 |
| List: AM Peter (sampled) | 900501628761 |
| List: Matt Hammond (sampled) | 901306316538 |

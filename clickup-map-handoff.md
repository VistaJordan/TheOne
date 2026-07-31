# ClickUp Workspace Map — Portable Handoff

**Workspace:** "Byblos Vista" (team ID `9005131470`)
**Mapped:** 2026-07-23, strict read-only (GET-only; no writes were or may be made to ClickUp)
**Source raw data:** 25 API response dumps in `Zeus/platform-brainstorm/clickup-raw/` (spaces, folders, lists, fields, tasks samples, views, tags, docs, team, user)

This file is self-contained — hand it to any project that needs to understand or integrate with the workspace.

---

## 1. API access (for the receiving project)

- **Base URL:** `https://api.clickup.com/api/v2` (Docs endpoints on `/api/v3`)
- **Auth:** header `Authorization: <personal token>` — no `Bearer` prefix.
- **Working token location (do not commit tokens to docs/repos):**
  `Downloads/All Innovation Projects/Support Automation/support-automation/.env.local` → `CLICKUP_TOKEN` (owner: Faysal AH, user id 88042564, admin).
  The token in `Downloads/ECOTRAK API/.env` failed to connect as of 2026-07-23.
- **Rate limit:** ~100 requests/minute for personal tokens — pace bulk pulls.
- **House rule: ClickUp is READ-ONLY.** No POST/PUT/PATCH/DELETE, no webhook creation, from any project, until explicitly decided otherwise.

## 2. Key IDs (verified live)

| Thing | ID |
|---|---|
| Team / Workspace "Byblos Vista" | `9005131470` |
| Space: Vista (**production**) | `90050318380` |
| Space: Vista Training (sandbox) | `901313728027` |
| Space: Vista karen support automation steven (sandbox, empty) | `901313763247` |
| Folder: Active (routing lists) | `90050890353` |
| Folder: ✅ Finished WOs (archive) | `90050901488` |
| Folder: SFM | `901318368651` |
| List: **Incoming WOs** (Ecotrak intake) | `900501628245` |
| List: Invoiced (archive, ~17,770 tasks) | `900501628667` |
| List: Ready To Invoice | `900501628638` |
| List: Canceled/Postponed | `900501628767` |
| List: Seamless FM Executive View (multi-homed rollup) | `901327405473` |
| List: AM Peter (sampled) | `900501628761` |
| List: Matt Hammond (sampled) | `901306316538` |

## 3. Workspace overview

| Attribute | Value |
|---|---|
| Members | **98** — 1 owner (Michael Khoury), 8 admins (incl. Jordan Brown, Faysal AH), 84 members, 5 readonly guests |
| Brands / email domains | `@byblosvista.com` (operating co, bulk), `@seamlessfm.com` (exec guests: Teresa, Rocio, Michael, Bernard), `@alphafixers.com` (dev/ops) |
| Spaces | 3 (1 production + 2 sandbox clones of the same template) |
| Folders / Lists | 7 / 163 (production space: 3 folders, 60 lists, 37 non-empty) |
| Tasks | ~21,239 in production; archive list "Invoiced" alone = 17,770 |
| Goals | none |
| Docs | 50+ (legacy 2023 knowledge base by the owner + a 2026 bot-authored daily health report) |

**What it is:** not generic PM — a bespoke **field-service / work-order management system**. One task = one work order. Flat model: zero subtasks, zero dependencies in real use.

## 4. The workflow engine

### 4a. Status pipeline (19 statuses, identical everywhere; `override_statuses=false` on all lists)

`Open (open)` → `emergency` → `waiting for quote` → `approved` → `return trip needed` → `assessment ongoing` → `assessment scheduled` → `job scheduled` → `job ongoing` → `pm scheduled` → `quote ready` → `please order parts` → `waiting for parts` → `!! waiting for advice` → `!! waiting for approval` → `<< invoiced not paid >>` → `!! ready to invoice (done)` → `done/incurred (done)` → `!! canceled/postponed (closed)`

(16 "active"-type + 2 done-type + 1 closed-type. Status groups drive open/closed filtering.)

### 4b. Routing model

- Folder **Active** (52 lists): **one list per technician and per account manager** (AM Peter/Kevin/Steven/Ion + ~35 tech lists, 2–116 tasks each) plus operational buckets: **Incoming WOs** (intake), Waiting for Approval Park, DMG DONE park, Template, Testing -- IT.
- Work is dispatched by **moving a task between lists**; list membership + status = workflow state.
- Folder **✅ Finished WOs** (5 lists) is the archive: Invoiced (17,770), Canceled/Postponed (124), Ready To Invoice (15), Checked, RTI - Park.
- Folder **SFM** contains **Seamless FM Executive View**: `task_count=2056` but `GET /task` returns 0 — all 2,056 are **multi-homed** ("tasks in multiple lists") surfaced for two guest dashboards (Teresa's / Ro's). It's a reporting rollup, not an operational queue.

### 4c. Enabled ClickApps (identical across spaces)

ON: due_dates (+start_date), priorities, tags, check_unresolved, custom_fields, dependency_warning, status_pies, multiple_assignees, emails (email-in on tasks), remap_dependency_settings, reschedule_closed_dependencies.
OFF/unused: sprints, points, custom_items (task types), milestones, scheduler, dependency_type; time_tracking configured but 0 usage.

## 5. Custom fields (the real data model)

~94–96 field definitions per list, **102 distinct names** across sampled lists; definitions shared across lists. Numbered names (`13.`…`38.`) = a deliberately ordered WO form schema. Avg **25–39 filled fields per task**.

**Types in use (13):** checkbox, short_text, text, drop_down, date, users, formula, currency, attachment, location, emoji, url, number.
**Not used:** labels/multi-select, rating, phone, email-type, task-relationship, manual_progress.

**100%-fill fields (every sampled task):** `35. WO Description`, `AM`, `City`, `State`, `Store`, `Trade`, `22. FM`, `21. Comp`, `16. Client NTE 🔴`, `17. Address`, `Previous Assignees`, `Date-Time Received`. Archive adds: `Profit`, `Grey Flag Date`, `Days Since Grey Flag`, `Assignee Name TXT`.

**Key fields by type:**
- **drop_down:** `Client` (40 brands: Swig, First Watch, MOD Pizza, Flynn, Outback, Vuori, KinderCare…), `22. FM` (120 FM companies: JDE, RCS, FmUSA, DMG, Trillium…), `State` (71), `Trade` (16: Plumbing, Electric, HVAC, Handyman, Janitorial, Roofing, HVAC PM…), `21. Comp` (7 billing entities: AF, SFM, TPM, RF, BKR, EDS, sf), `MoD Call` (9), `QC` (7), `18. Check-in/out Status` (3), `Sales Owner` (Ro/Teresa/-), `23. Action` (4), `Problem Type` (2)
- **formula:** `Profit`, `Give us Today`, `Days Since INP`, `Days Since QC`, `Days Since Grey Flag`, `Days since Done`, `Days since Invoiced` — SLA/aging + profitability math
- **currency:** `Total Invoiced`, `34. Cost`, `16. Client NTE 🔴`, `Discount`
- **users:** `AM`, `TL`, `Completion Assignee`, `Invoicing Assignee`, `Relationship Owner`, `Previous Assignees`, `31. Support Trainee`
- **date:** `Date-Time Received`, `Invoice Date`, `Pay Date`, `QC Date`, `Grey Flag Date`, `SLA Due Date`, `Act ETA`, `👣 Parts Order Date`
- **checkbox flags:** `1. Not Fully Paid`, `11. Penalty`, `13. Late quote`, `14. Missed ETA`, `15. Recall`, `Quote Check`, `Admin Check`, `GTG`, `INV/COLL`, `🚨 SLA Requested/Updated`, `🚨 Feedback Requested/Updated`, `✅ On Sheet`, `Capital Project`, `Audited`, `Bill For Incurred`
- **other:** `WO PDF` + `37. PDF` (attachment), `17. Address` (location), `28. Sharepoint Link` (url), `Tech Rating` (emoji), `Hours To Checkout` (number)
- Known legacy/duplicates: `29. PDF Link` vs `PDF Link`, `36. Name - OLD`

## 6. Tags

12 tags in the production space — a **parts-procurement vocabulary only** (2–17% of tasks): `tech will order`, `tech ordered`, `ap will order`, `ap ordered`, `client ordered`, `vendor will order`, `vendor ordered`, `sourcing parts`, `dispatcher ordered part`, `dispatcher ordered door`, `corporate will order`, `efs`.

## 7. Task usage patterns (sampled: Matt Hammond, AM Peter, Invoiced — 100 tasks each)

| Metric | Matt Hammond | AM Peter | Invoiced |
|---|---|---|---|
| has assignee | 100% | 100% | 100% |
| has due date | 100% | 99% | 99% |
| priority set | 6% | 12% | 100% (all "high" — looks bot-set) |
| has tags | 17% | 2% | 0% |
| subtasks | 0 | 0 | 0 |
| time tracked | 0 | 0 | 0 |
| avg filled custom fields | 25.6 | 26.2 | 39.0 |

Status distribution on active lists: heaviest in `!! waiting for approval` (~21–25%) and `done/incurred` (~18–31%), then `quote ready`, `waiting for quote`, `waiting for parts`. Invoiced list = 100% terminal status.

## 8. Views in real use (~12 types)

- **Space level (21 views):** table ×9 (the workhorse: `QC`, `All jobs`, `SunHoldings`, `MoD feedback`, `Last 7 days`, `Last month`, `Today`, `QA`) · dashboard ×2 (`Invoices Dashboard`, `Gloria's Dashboard`) · list ×2 · conversation ×2 · box, activity, workload, calendar ×1 each · location_overview ×1 · **map ×1 (`Gloria's Map` — geographic WO plotting for dispatch)**
- **List level:** per-person lists default to board + conversation; SFM Exec View exposes only the two guest dashboards.
- **Team level:** 3 doc views (`Company Wiki`, `Team Docs`, …) + 1 conversation.
- **Gantt/timeline: zero use anywhere.**

## 9. Docs & goals

Goals: none. Docs: 50+ — almost all 2023-era ops/HR/sales knowledge base authored by the owner (Company Wiki, Employee Handbook, interview scoring, outreach lists), plus 2026 automation artifacts: `Vista Daily Health Reporter Memory` (authored by an integration **bot user, id −39963952**) and per-WO docs (`WOFM0000110778`).

## 10. Gap summary — used vs. ignored

**Heavily used (the core):** custom fields at extreme scale (incl. formulas/currency/location/attachments), 19-status pipeline, lists-as-routing, multiple assignees, mandatory assignee+due date, table views + dashboards, map/workload for dispatch, email-in, multi-homing for exec rollups, docs as legacy KB.

**Enabled but unused:** time tracking, priorities (as a human signal), dependencies.

**Never used:** sprints, story points, milestones, custom task types, goals/OKRs, subtasks, gantt/timeline.

**Bottom line:** ClickUp is operating as a structured WO database + pipeline + routing system + reporting layer. Any integration or rebuild should target those primitives; the agile/PM feature set is dead weight for this workspace.

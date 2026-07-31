# ClickUp Feature Inventory (2026) — Rebuild Planning Reference

**Purpose:** Complete feature map of ClickUp (SaaS PM platform) as of the ClickUp 3.0 → "Brain2/4.0" era (2026), organized for a REBUILD as the operational task-management base layer beneath SeamlessFM's Zeus canvas app.

**Verified against** (July 2026 web sources): ClickUp Help Center (Hierarchy, Custom Fields, ClickApps, Views, Automations, Dependencies, Custom Task Types, Roles, Sprints, Tasks in Multiple Lists), ClickUp product/changelog pages, and third-party reviews. Where the live help pages block automated fetch (403), search snippets + established product knowledge were cross-checked.

---

## Legend

**Build tier** (tuned to SeamlessFM: facilities-mgmt, small team, internal-only, WOs via integrations, completion audits, custom fields, statuses-as-pipeline, automations; NOT needing marketplace gallery / billing / mobile-first / enterprise SSO; Zeus already provides the infinite canvas):

- **T0** — Foundational data model. Must exist day one (even if UI lags). The schema is wrong without it.
- **T1** — MVP. Needed for the first usable internal release.
- **T2** — Power features. Second wave once the base is stable.
- **T3** — Skip / never / defer indefinitely. SaaS-only concern, redundant with Zeus, or better served by SeamlessFM's own differentiators/AI.

**Complexity:** S (small, days) · M (medium, 1–2 wks) · L (large, several wks) · XL (multi-month / whole subsystem).

**Schema-critical?** `yes` = the persistence model must anticipate it from day one or you eat a painful migration later, even if the UI ships much later. `no` = can be bolted on without reshaping core tables.

---

## 1. Hierarchy Model

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Workspace (Team) | Top container = the whole org; one per company recommended. Root of all permissions, billing, members. | T0 | S | yes |
| Space | Major division (dept/team/client/initiative). Owns its own statuses, ClickApp toggles, sharing, defaults. | T0 | M | yes |
| Folder (optional) | Optional grouping layer inside a Space; houses Lists. Can be skipped ("folderless" Lists). | T0 | S | yes |
| Subfolder | Nested folder layer. | T2 | S | yes |
| List | The container that actually holds Tasks; the atomic unit of a "project." Can live in Space, Folder, or Subfolder. | T0 | M | yes |
| Task | Core work unit. | T0 | L | yes |
| Subtask | Task nested under a task; can nest multiple levels (Nested Subtasks ClickApp). | T0 | M | yes |
| Checklist / checklist items | Lightweight to-do groups inside a task; items can be assigned; nestable; reusable checklist templates. | T1 | S | yes |
| **Tasks in Multiple Lists** | One task appears in N Lists. Has a "home List" (defines its Custom Fields + Statuses); other Lists share visibility but not permissions. | **T0** | **L** | **yes** |
| All Tasks / "Everything" | Workspace-wide roll-up level above Spaces; holds only views (no tasks of its own). Renamed "All Tasks." | T2 | M | no |
| Space-level & Folder-level views | Aggregate views spanning all child Lists. | T1 | M | no |

> **Rebuild note:** Tasks-in-Multiple-Lists + the home-List concept is the single most consequential schema decision. It forces a task↔list *many-to-many* join, and makes "which fields/statuses apply" a function of home_list, not the containing list. Get this into the schema on day one even if the UI only ever shows one list at first.

---

## 2. Task Anatomy

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Custom statuses | Per Space/Folder/List status sets, grouped Not-started/Active/Done/Closed; ordered; color; the pipeline engine. | **T0** | L | yes |
| Status groups & "Closed" semantics | Statuses roll into 4 groups driving progress %, filters, "open vs closed." | T0 | M | yes |
| Priority | Urgent/High/Normal/Low (flag). Toggleable ClickApp. | T0 | S | yes |
| Multiple assignees | Many users per task (ClickApp; can force single-assignee mode). | **T0** | M | **yes** |
| Watchers | Users subscribed to a task's notifications without being assignees. | T1 | S | yes |
| Dates: start / due | Start + due datetimes; time-of-day optional. | T0 | S | yes |
| Recurring dates / recurring tasks | Task regenerates or reschedules on a cadence; multiple recurrence behaviors. | T1 | M | yes |
| Time estimates | Estimated duration per task (and per-assignee estimates). ClickApp. | T1 | S | yes |
| Time tracking | Native start/stop timer + manual entries + ranges; billable flag; labels; via app/API/extensions. | T1 | L | yes |
| Tags | Free-form labels on tasks, Space-scoped; filterable. ClickApp. | T1 | S | yes |
| Dependencies (waiting on / blocking / linked) | Blocks, Waiting-on (blocked-by), and non-blocking Linked relations; reschedule cascades. ClickApp + Dependency Warning. | **T0** | L | **yes** |
| Task relationships / links | Ad-hoc "linked task" references + Relationship custom fields between tasks/Lists. | T1 | M | yes |
| Custom task types | Rename "Task" to domain objects (e.g., Work Order, Audit, Bug); Milestone is one; up to 100 types. | **T1** | M | **yes** |
| Milestones | Special task type rendered as a diamond on Gantt/Timeline. | T2 | S | yes |
| Comments & threads | Rich comments, threaded replies, @mentions, assigned comments (actionable), reactions. | T1 | L | yes |
| Proofing / annotations | Pin markup on images/PDFs/video; comment threads per annotation; resolve state; AI proof summaries. | T2 | L | yes |
| Attachments | Files on tasks/comments; from local, cloud drives, or URL; versioning. | T0 | M | yes |
| Activity log | Immutable audit trail of every field/status/assignee/date change per task. | **T0** | M | **yes** |
| Task description (rich) | Rich-text/Markdown body with embeds, /slash commands, banners. | T0 | M | yes |
| Task ID / custom ID | Sequential ID + optional custom-prefix IDs per Space. | T1 | S | yes |
| Sub-task rollups | Progress/time/points roll up from subtasks to parent. | T2 | M | yes |
| Sharing a single task (public link) | Per-task share incl. public read-only link. | T2 | M | no |

---

## 3. Custom Fields

Core extensibility layer — **schema-critical as a whole subsystem**. Model as `field_definition` (scoped to List/Folder/Space) + polymorphic `field_value` per task, typed.

| Field type | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Text (short) | Single-line text. | T0 | S | yes |
| Text (long / rich) | Multi-line / rich text. | T1 | S | yes |
| Number | Any numeric value. | T0 | S | yes |
| Money / Currency | Numeric with currency formatting. | T1 | S | yes |
| Dropdown (single-select) | One option from a fixed list; colored options. | T0 | S | yes |
| Labels (multi-select) | Multiple options from a list. | T0 | S | yes |
| Date | Extra date beyond start/due. | T0 | S | yes |
| Checkbox (boolean) | True/false toggle. | T0 | S | yes |
| URL | Hyperlink field. | T1 | S | yes |
| Email | Mailto-linked address. | T1 | S | yes |
| Phone | Tel-linked number. | T1 | S | yes |
| People / Users | One or more workspace users (distinct from assignees). | T1 | S | yes |
| Rating / Emoji rating | Star/emoji scale (e.g., 1–5). | T2 | S | yes |
| Emoji | Emoji counter/reaction field. | T3 | S | no |
| Progress (manual) | User-set 0–100% bar. | T2 | S | yes |
| Progress (automatic) | Auto % from subtask/checklist completion. | T2 | M | yes |
| Formula | Compute across fields (incl. date math, nested formulas). | T2 | L | yes |
| Relationship | Link tasks to other tasks/Lists/Docs (many-to-many references). | **T1** | L | **yes** |
| Rollup | Aggregate (sum/avg/count/range) a field across related/relationship/subtask tasks. | T2 | L | yes |
| Location | Address w/ map + geocode. | T2 | M | yes |
| Files / Attachment | Files attached via a field. | T1 | S | yes |
| Task (task-reference) | Reference to another task. | T1 | M | yes |
| Manual/auto progress, Voting | Misc: voting field, etc. | T3 | S | no |

> **Rebuild note:** For SeamlessFM, custom fields ARE the product surface (WO metadata, audit results, asset refs). Prioritize: text/number/money/dropdown/labels/date/checkbox/people/relationship/files first. Formula/rollup are XL-adjacent and can wait, but reserve schema room for them (store field `type` + `type_config` JSON per definition).

---

## 4. Views

Each view = a saved query (filters + grouping + sort + columns + view-type) bound to a location. **View config is schema-relevant** (persist per-view state); the renderers are not.

| View | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| List | Grouped, expandable rows; the workhorse. | T0 | M | no |
| Board (Kanban) | Drag cards across status/field columns. | T1 | M | no |
| Table | Spreadsheet grid; bulk edit; column reorder; rollups in-line. | T1 | M | no |
| Calendar | Month/week; drag to schedule; date-field driven. | T1 | L | no |
| Gantt | Dependency-aware timeline w/ critical path, drag to reschedule. | T2 | XL | no |
| Timeline | Linear roadmap per assignee/group (lighter than Gantt). | T2 | L | no |
| Workload | Capacity per person over time (points/estimates/count). | T2 | L | no |
| Box | Per-assignee task buckets (who's-doing-what snapshot). | T3 | M | no |
| Activity | Chronological activity feed for a location. | T2 | M | no |
| Map | Tasks plotted by Location field. | T2 | M | no |
| Mind Map | Node graph of tasks / free-form; convert nodes to tasks. | T3 | L | no |
| Whiteboard | Infinite canvas w/ shapes/sticky/connectors; convert to tasks. | **T3** | XL | no |
| Chat | Channel view embedded in hierarchy. | T3 | L | no |
| Doc | Rich document as a view. | T2 | L | no |
| Form | Intake form that creates tasks. | **T1** | L | no |
| Embed | iframe external URL/app. | T2 | S | no |
| Per-view filter/group/sort/columns | Every view carries its own saved filter+group+sort+column config. | **T0** | L | **yes** |
| Saved views | Named, persisted views at any hierarchy level. | T0 | M | yes |
| Pinned / default views | Pin ordering; set a default; personal vs shared views. | T1 | S | no |
| Private views / view protection | Views can be private, or "protected" (locked from edits). | T2 | S | no |
| "Me mode" | Filter any view to current user's items only, one click. | T1 | S | no |
| View templates | Save a view config as reusable template. | T2 | S | no |

> **Rebuild note:** Build List + Board + Table + Form first. Whiteboard/Mind Map = **skip** — Zeus already owns the infinite-canvas macro-planning niche; duplicating it is wasted effort and a strategic overlap. Gantt/Workload are the expensive-but-valuable second wave.

---

## 5. ClickApps (per-Space/Workspace toggles)

35+ toggles that switch behaviors on/off. In a rebuild, most "ClickApps" collapse into either (a) always-on features or (b) per-Space config flags. Listed so you can decide which get a toggle vs. hard-coded on.

| ClickApp | Toggles… | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Custom Fields | Field subsystem availability. | T0 | — | yes |
| Automations | Rule engine. | T1 | — | yes |
| Time Tracking | Native timer/entries. | T1 | — | yes |
| Time Estimates | Estimate fields. | T1 | — | yes |
| Sprints | Sprint folders/points/velocity. | T3 | — | yes |
| Multiple Assignees | Single vs multi assignee mode. | T0 | — | yes |
| Priorities | Priority flag. | T0 | — | yes |
| Tags | Tagging. | T1 | — | yes |
| Dependencies + Dependency Warning | Blocking relations + warning on close. | T0 | — | yes |
| Custom Task Types | Domain object types. | T1 | — | yes |
| Milestones | Milestone type. | T2 | — | yes |
| Nested Subtasks | Multi-level subtasks. | T1 | — | yes |
| Remap Subtask/Dependency dates | Cascade reschedule behavior. | T2 | — | no |
| Custom Statuses | Per-location status sets. | T0 | — | yes |
| Multiple List (Tasks in Multiple Lists) | M2M task↔list. | T0 | — | yes |
| Emails in ClickUp | Send/receive email from tasks. | T3 | — | yes |
| Conditional Logic in Forms | Dynamic form branching. | T2 | — | no |
| Task Merging / Relationships | Merge dupes; relationship fields. | T2 | — | yes |
| Checklists / Checklist templates | Checklist behaviors. | T1 | — | yes |
| Threaded / Assigned Comments | Comment behaviors. | T1 | — | yes |
| Rich Text / Markdown | Editor behaviors. | T1 | — | no |
| Priorities/Points/WIP limits (board) | Board WIP limits etc. | T2 | — | no |
| Start Dates | Enable start date field. | T0 | — | yes |
| Recurring Tasks | Recurrence engine. | T1 | — | yes |
| Multiple List colors / Task colors | Cosmetic. | T3 | — | no |

> **Rebuild note:** Don't reproduce the ClickApp *marketplace UX*. Model behaviors as a per-Space settings JSON. Only a handful genuinely need a runtime toggle for SeamlessFM (single-vs-multi assignee, dependencies, time tracking). Everything else can be on by default.

---

## 6. Automations

Trigger → (Conditions) → Action(s). This is core to SeamlessFM (WO routing, status pipelines, audit assignment). **Schema-critical** as an engine (persist rules, run history, idempotency).

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Trigger model | Status change, field change, assignee change, date arrives, task created/moved, comment posted, list/tag change, form submit, recurring/scheduled. | **T0** | L | yes |
| Conditions | Filter which tasks fire (field=, priority, assignee, tag, etc.). | T0 | M | yes |
| Action model | Change status/assignee/priority/field/date; move/duplicate/create task; apply template; add tag/comment/checklist; add to List; notify. | **T1** | L | yes |
| Multi-action sequences | Ordered actions per rule. | T1 | M | yes |
| Pre-built recipes | Library of templated automations. | T2 | S | no |
| **Call webhook (outbound)** | Action that POSTs task payload to an external HTTPS endpoint — the recommended integration path. | **T1** | M | yes |
| Chat webhook | Post to chat channels on triggers. | T3 | S | no |
| Inbound webhooks / API-triggered | External systems create/update tasks (WO intake). | **T1** | M | yes |
| Integration actions | Actions into email, Slack, GitHub, etc. | T3 | M | no |
| AI / Autopilot Agent actions | Trigger→condition AI agents that act on tasks/chats. | T3 | L | no |
| Audit log of automation runs | History + error surface. | T1 | M | yes |
| External trigger via Make/Zapier | Third-party glue. | T3 | S | no |

> **Rebuild note:** The engine (triggers/conditions/actions + run log) is worth building well and early because it's how WOs move through the pipeline. Skip the marketplace-integration actions; the generic **Call webhook** + inbound webhook/API pair covers SeamlessFM's integration needs.

---

## 7. Dashboards

Aggregate reporting across the hierarchy. Cards query task/time/status data.

| Card / widget | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Task List card | Filtered list of tasks. | T2 | M | no |
| Status/Priority/Assignee/Tag breakdown | Count-by cards (pie/bar). | T2 | M | no |
| Bar / Line / Pie / Battery charts | Generic chart cards over fields. | T2 | L | no |
| Custom Field charts | Sum/avg/chart over a custom field. | T2 | M | no |
| Time tracking cards | Tracked/billable/estimate reporting. | T2 | M | no |
| Calculation / number card | Single KPI number. | T2 | S | no |
| Table card | Configurable reporting grid. | T2 | M | no |
| Workload / Who's Behind | Capacity + overdue-by-person. | T2 | M | no |
| Sprint cards (velocity/burndown/burnup) | Agile reporting. | T3 | M | no |
| Goal / Target card | Goal progress. | T3 | S | no |
| Embed / Rich text / Portfolio | Misc cards. | T3 | S | no |
| AI summary card | Plain-language summary of dashboard data. | T3 | M | no |

> **Rebuild note:** Dashboards are pure read-model/reporting — none are schema-critical if your task/field/time tables are queryable. Build a small set (task list, status/assignee breakdown, custom-field number, time tracking) in the second wave; skip sprint/goal/AI cards.

---

## 8. Docs, Whiteboards, Chat, Clips

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Docs | Nested wiki pages, rich text, embeds, /slash, task-embeds; can be a view; templates; sharing/public. | T2 | XL | partial (own doc/page tables) |
| Doc → task linking / embeds | Two-way task references inside docs. | T2 | M | yes |
| Whiteboards | Infinite canvas, shapes, connectors, sticky notes, convert-to-task, live cursors. | **T3** | XL | no |
| Chat | Channels + DMs tied to hierarchy; link messages→tasks; threads. | T3 | XL | no |
| Clips | In-app screen/video recording + hosting + AI transcript. | T3 | L | no |
| SyncUps / AI Notetaker | Live meeting + AI transcription→action items. | T3 | L | no |

> **Rebuild note:** **Whiteboards = skip** (Zeus overlap). **Chat/Clips/SyncUps = skip** (SeamlessFM likely already has Slack/Teams/Zoom; these are heavy and non-differentiating). **Docs** is the only one worth a second-wave look — SOPs, audit procedures, WO runbooks — but even that can start as attached files or a lightweight markdown page table.

---

## 9. Goals, Sprints

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Goals | Measurable objectives w/ due dates + owners. | T3 | M | partial |
| Targets (key results) | Number/currency/true-false/task-completion targets rolling into a Goal %. | T3 | M | partial |
| Goal Folders | Group goals. | T3 | S | no |
| Sprints | Sprint folders, auto-cadence, backlog. | T3 | M | yes (if ever) |
| Sprint Points | Story-point effort field. | T3 | S | yes (if ever) |
| Burndown / Burnup / Velocity | Agile charts. | T3 | M | no |

> **Rebuild note:** Facilities management is not agile software delivery — **Sprints = skip entirely.** Goals/Targets are a nice-to-have OKR layer but not operational; defer to T3 unless leadership specifically wants outcome tracking. If they do, a generic "target rolls up linked-task/field values" model reuses the rollup machinery.

---

## 10. Forms

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Form view | Public/internal intake form that creates tasks in a List. | **T1** | L | no |
| Field mapping | Map form questions → task fields/custom fields. | T1 | M | yes (field mapping stored) |
| Conditional logic | Show/branch questions based on prior answers. | T2 | L | no |
| Template + routing on submit | Apply task template, route to List(s), set assignees/relationships on submit. | T1 | M | yes |
| Custom branding / redirect / responses | Cosmetic + submission handling. | T2 | S | no |

> **Rebuild note:** Forms are a strong fit for SeamlessFM's WO intake (and completion-audit capture) when an integration isn't the source. Build basic form→task with field mapping early (T1); conditional logic later.

---

## 11. Inbox / Home / Notifications

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Notifications | Per-event notifications (assign, mention, comment, status, due) across in-app/email/mobile/browser; granular prefs. | **T1** | L | yes |
| Notification preferences | Per-type, per-channel, per-Space controls; digests. | T2 | M | yes |
| Home | Personalized landing: my work, agenda/calendar, reminders, recents, assigned comments, LineUp. | T1 | L | no |
| Inbox / Notifications center | Unified feed of things needing attention; snooze/clear. | T1 | M | no |
| Reminders | Standalone personal reminders (not tasks). | T2 | S | yes |
| LineUp / My Work | Prioritized personal task queue. | T2 | M | no |

> **Rebuild note:** A durable **notifications table + delivery model** is schema-critical (assign/mention/status events must be recordable day one even if UI is minimal). Home/Inbox rendering is T1 UI work atop it.

---

## 12. Templates & Recurring

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Task templates | Save a task (subtasks, fields, assignees, checklists) as reusable template. | **T1** | M | yes |
| List templates | Whole-List blueprints (statuses, views, tasks, automations). | T1 | L | yes |
| Space / Folder templates | Reproduce entire structures. | T2 | L | yes |
| Doc / View / Checklist templates | Template each object type. | T2 | M | no |
| Template Center + sharing | Browse/import/share templates; template Space. | T2 | M | no |
| Recurring tasks | Cadence-based regeneration/reschedule; multiple recurrence modes. | T1 | M | yes |
| Apply template from Form/Automation | Auto-instantiate templates in workflows. | T1 | M | yes |

> **Rebuild note:** For repeated WO types and standard audits, task + list templates are high-value early. Model templates as serialized object graphs referencing field/status definitions.

---

## 13. Permissions & Sharing

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Roles: Owner / Admin / Member | Base role tiers; owner = all, admin = manage structure/users/security, member = create+contribute. | **T0** | M | yes |
| Limited Member | Reduced member (e.g., Chat + assigned work only). | T2 | S | yes |
| Guests (3 types: view-only / permission-controlled / full) | External users scoped to shared items; can't share onward. | T2 | M | yes |
| Custom Roles | Define roles beyond the defaults (Business Plus+/Enterprise). | T3 | L | yes |
| Granular sharing per Space/Folder/List/Task | Share any hierarchy item to specific users/roles. | **T0** | L | yes |
| Permission levels: View / Comment / Edit / Full | Per-shared-item access level. | **T0** | M | yes |
| Private items | Make a Space/Folder/List/Doc private to specific members. | T0 | M | yes |
| Inherited vs overridden permissions | Child inherits parent unless overridden. | T0 | L | yes |
| Public sharing links | Read-only public links to items. | T2 | M | no |
| SSO / SAML / SCIM | Enterprise identity. | **T3** | L | no |
| Audit/security settings (2FA, IP, session) | Workspace security controls. | T3 | M | no |

> **Rebuild note:** The **view/comment/edit/full × any-hierarchy-node × inheritance** model is schema-critical and easy to under-build. Nail the ACL model day one (subject → object → level, with inheritance resolution). Skip SSO/SCIM/custom-roles/2FA initially (internal, small team, no enterprise SSO need).

---

## 14. Search, Filters, Favorites, Command Center

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| Universal search | Workspace-wide search over tasks, docs, comments, files; connected-app search. | T1 | L | partial (search index) |
| Filters (advanced) | Multi-field AND/OR filter builder reused across views. | **T0** | L | yes |
| Sorting / grouping | Multi-level sort + group-by any field. | T0 | M | yes |
| Favorites / pinned | Star items/views to sidebar. | T1 | S | no |
| Command Center / Command-K | Quick-nav + quick-create + quick-actions palette. | T2 | M | no |
| Saved filters / filter presets | Reusable filter definitions. | T2 | S | yes |

> **Rebuild note:** The filter/sort/group grammar is shared by views, dashboards, automations conditions, and search — design it once as a reusable predicate model (T0). A dedicated search index is T1 (Postgres FTS/pg_trgm is enough at small scale).

---

## 15. Import / Export / API / Webhooks

| Feature | Description | Tier | Cx | Schema-critical |
|---|---|---|---|---|
| REST API (v2, migrating to v3) | CRUD across tasks, lists, spaces, fields, comments, time, docs, dashboards. | **T1** | L | yes |
| API auth (personal token + OAuth app) | Token + OAuth2 for integrations. | T1 | M | yes |
| Webhooks (inbound subscriptions) | Subscribe external endpoints to workspace events (task/comment/etc.); most-specific-location wins. | **T1** | M | yes |
| Automation webhooks (outbound) | Rule-driven POST to external URL (see §6). | T1 | M | yes |
| Import from Jira/Asana/Trello/CSV/etc. | Bulk import wizards. | T2 | L | no |
| Export (CSV/Excel, per-view) | Export view data. | T1 | S | no |
| MCP support | Model Context Protocol server so external AI can query workspace. | T3 | M | no |

> **Rebuild note:** For SeamlessFM, **the API + inbound webhooks ARE the WO-integration surface — treat as T1, not optional.** Design the write-API to match the internal domain model, not ClickUp's. One-time importers (Jira/CSV) are throwaway T2 scripts. MCP/AI connectors defer to SeamlessFM's own AI stack.

---

## 16. ClickUp Brain / AI (2025–2026) — brief

Rebuilder has their own AI plans, so this is reference-only; **all T3.**

| Feature | Description | Tier |
|---|---|---|
| Brain2 (2026 rebuild) | Context-aware AI over all workspace objects; routes to Claude/GPT/Gemini; generates docs/decks/dashboards/apps from a prompt. | T3 |
| Brain MAX | Standalone desktop/mobile "super app"; cross-tool search (Drive/GitHub/OneDrive) + Talk-to-Text. | T3 |
| Super Agents | AI "coworkers" as real workspace users — @mentionable, assignable, schedulable. | T3 |
| Autopilot Agents | Trigger/condition AI agents acting on tasks/chats per location. | T3 |
| AI fields / AI in views / AI Notetaker | Field auto-fill, summaries, meeting transcription→action items. | T3 |
| AI proofing summaries | Surface unresolved feedback. | T3 |

> **Rebuild note:** Skip wholesale. SeamlessFM should design its own AI layer against its own clean domain model rather than reproduce ClickUp's. Only carry forward the *hook points* (e.g., a place for an "AI action" in the automation engine, an embeddable field type) so their AI can plug in later.

---

## Appendix: Tier Rollup

**T0 (foundational, day-one schema):** Workspace, Space, Folder, Subfolder, List, Task, Subtask, Checklist, Tasks-in-Multiple-Lists, custom statuses + status groups, priority, multiple assignees, start/due dates, dependencies, activity log, attachments, task rich description, core custom-field types (text/number/money/dropdown/labels/date/checkbox/people/files), custom-field subsystem, per-view filter/group/sort config, saved views, automation trigger+condition model, roles (owner/admin/member), granular sharing, permission levels, private items, inheritance, filter/sort/group grammar. **≈ 30 items.**

**T1 (MVP first release):** watchers, recurring tasks, time estimates, time tracking, tags, task relationships/links, custom task types, comments/threads, custom-field types (url/email/phone/people/files/task/rich-text), List/Board/Table/Form views, "me mode", pinned/default views, automation actions + multi-action + call-webhook + inbound webhooks + run log, notifications engine, Home/Inbox, task+list templates, universal search, favorites, REST API + auth + webhooks, export. **≈ 30 items.**

**T2 (power, second wave):** Subfolders(UI), All-Tasks level, milestones, proofing, sub-task rollups, custom-field types (rating/progress/formula/relationship/rollup/location), Calendar/Gantt/Timeline/Workload/Activity/Map/Doc/Embed views, view templates/protection/private views, conditional-logic forms, dashboards (task list/breakdown/charts/time/table/workload), Docs, reminders, LineUp, Space/Folder templates, limited members, guests, public links, command center, saved filters, importers. **≈ 35 items.**

**T3 (skip / never / defer):** Sprints (+points/burndown/velocity/burnup), Goals/Targets, Whiteboards, Mind Map, Box view, Chat, Clips, SyncUps/AI Notetaker, Emails-in-ClickUp, integration-marketplace actions, chat webhooks, custom roles, SSO/SAML/SCIM/2FA, all ClickUp Brain/AI (Brain2, Brain MAX, Super/Autopilot Agents, AI cards/fields), MCP, sprint/goal/AI dashboard cards, emoji/voting fields, billing/plans. **≈ 30+ items.**

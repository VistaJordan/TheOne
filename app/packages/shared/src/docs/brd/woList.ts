// 0075 · BRD module: the Work Orders list and everything reachable from it.

import type { DocModule } from '../types';

export const WO_LIST_MODULE: DocModule = {
  key: 'wo-list',
  title: 'Work Orders list',
  where: 'Sidebar › Work Orders.',
  purpose: 'The working list: every work order the viewer may see, arranged the way each person needs it, with the bulk tools to move many at once.',
  value: 'Replaces the ClickUp list and the Teams reminders with one list that remembers each person\'s arrangement and enforces the rules on every bulk move.',
  users: ['Everyone with work_orders view'],
  features: [
    {
      name: 'Views (tabs)',
      what: 'All work orders, Due Today and Escalation Tracker are built in; saved views follow. A saved view keeps columns (up to 60), filters (up to 50 rules), grouping and sort; it opens read-only, the pencil puts it in Editing mode (Cancel, Save "<name>" disabled with "No changes yet"), and while just looking, changes show a Reset link ("Back to <name> as saved" / "Back to the default list"). Tab icons: pushpin = pinned, user = "Shared by <owner>" (not editable), globe = my shared view. The count badge sits on the active tab only. The pinned tab leads the strip; the pin is a per-account preference, is applied once per page load, can point at a colleague\'s shared view, and a /?filter= link beats it.',
      value: 'Each person opens the list already arranged for their job; shared views give the team one definition of "waiting on parts".',
      controls: [
        { label: 'Save view › Save this view', does: 'Name (80 characters), Share with the team ("Everyone can use it; only you can change it."), note of what is saved; a copy suggests "<name> copy". Hidden on Due Today and Escalation Tracker.' },
        { label: 'Pencil / trash on a view', does: 'Owner-only edit and delete; "Delete this view?" warns it is removed for everyone it is shared with and that work orders are not affected.' },
        { label: 'Pushpin', does: 'Makes Work Orders open on that view for you (preference wo.views.pinned).' },
        { label: 'Reset', does: 'Back to the view as saved, or the default list.' },
      ],
      rules: [
        'A duplicate name per owner is refused ("You already have a view called …"); every column, filter, group and sort is validated against the catalogue ("<field> does not support the <op> test"); only the owner may change or delete ("Only the person who created a view can change it"); re-saving an identical layout logs nothing.',
        'The working arrangement (not a saved view) persists per browser and is restored on reload; a deleted view bounces the tab back to All.',
        '/?filter=<json> opens the list on those filters (the Needs Attention cards use it) and strips itself from the address bar; malformed JSON is ignored.',
      ],
      permissions: ['work_orders view'],
      audit: ['view_created', 'view_updated', 'view_deleted'],
      since: '0011',
    },
    {
      name: 'Status-group segment and quick-filter chips',
      what: 'Segment buttons per phase group (All, Open, Active, Pending, Done, Closed and any admin-added group) are toggles that add groups (Open + Active = either); All clears; the segment writes one status_group rule that is visible in Filter. A saved view\'s own groups are locked while not editing (lock icon: "Part of the <view> view — change it under Filter"). Chips for Status, Assignee, FM, Comp and AM each write one is / is any of rule: tick values, Select all / Clear all, a search box above eight values, 200 values shown at most; the Status chip narrows to exact statuses unlike the group tabs; a chip that cannot show what Filter holds says so.',
      value: 'The two most common narrowings take one click.',
    },
    {
      name: 'Filter, Group, Sort, Columns',
      what: 'Filter: Add filter, a field, a test and a value, joined Where / and / or; Match all / Match any with two or more rules; Clear all; half-written rules are held, not sent ("N rules still need a value"); a removed field reads "<key> (removed)". Tests per type: is set, is not set, is, is not, contains, does not contain, starts with, ends with, is greater than, is at least, is less than, is at most, is between, is any of, is none of, is checked, is unchecked; dates read is on / is not on / is after / is on or after / is before / is on or before. Group: by any field ("Grouped by <field>"), counts per bucket ("n of total" when the bucket spans pages), "No <field>" for empties, collapse chevron, Select group. Sort: click a header to cycle ascending → descending → off, empties always last; Clock, Description, Age band and Last client message do not sort; Sort by breach orders the whole set by the worst obligation first, ahead of the column sort. Columns: Shown with up / down / ×, the last column cannot be removed, Reset to the default eight (WO #, Client, Trade, Status, Clock, NTE, Home list, Age (days)), Add a column with search, "Every field is already shown.", including the six computed columns (Location, Completed on, Age band, Last client message, Last client message on, Last sent to client).',
      value: 'Any question about the list is answered without an export.',
      rules: [
        '"is not", "is none of" and "does not contain" include blank rows; "is not set" treats an empty string as blank; "is unchecked" matches a never-written checkbox; date-times filter by whole day; a custom number or date that does not parse compares as not set; %, _ and \\ are typed literally.',
        'Date rules may say today, today+7, today-1 (resolved on the server; the dashboards use it).',
        'Fields hidden from the role are absent from the catalogue and stripped from requested columns.',
      ],
    },
    {
      name: 'Due Today',
      what: 'A built-in tab whose segments are All · Escalations · Scheduled · Quote · Parts arriving, each for a chosen day (Today, Tomorrow or Any day). "Today" is the business day and is re-read every minute, so it rolls over at midnight. Escalations is Due Date on or before the day and status not Job Sched or On Site (Job); Scheduled and Parts arriving are equality on the day; Quote is Quote Due Date on the day, widened to overdue quotes still before Quote Ready when the day is today. Fixed columns: WO #, Client, Trade, Status, Assignee, Due Date, Scheduled Date, Quote Due Date, Parts Arrival Date. Group, Sort by breach and Columns still work; Filter and Save view do not.',
      value: 'The daily to-do list of rule 4.3, with no spreadsheet: what is due, what is on site, which quote is late, what arrives.',
      brd: ['4.1', '4.3'],
      since: '0030',
    },
    {
      name: 'Escalation Tracker',
      what: 'A built-in tab listing every work order flagged Escalated (an ordinary filter, Escalated is checked, so the tabs, chips and Filter work on top and Reset restores it); columns WO #, Client, Trade, Status, Assignee, Clock, NTE, Age (days); not saveable or pinnable.',
      value: 'The team-wide view of what has been escalated, for the morning stand-up.',
      brd: ['7.3.3'],
      since: '0038',
    },
    {
      name: 'Rows and the status pill',
      what: 'A row click opens the record and the WO # is a link; the client cell carries "City, ST · Client WO #"; a trade glyph; red Emergency and amber Escalated badges and rails; Cost turns red above the NTE ("Cost is above the client NTE"); Quote Due Date turns red while the quote is overdue. Click the status pill to change (or request) the status without opening the work order; the gates and the Ecotrak check are enforced on the click (the tags are drawn on the record\'s menu, not here). Pagination: "Showing 1 to 25 of N", Rows per page 25 / 50 / 100 / 200.',
      value: 'A status move without opening the work order.',
    },
    {
      name: 'Selection and bulk actions',
      what: 'Tick rows, the header box ("Select every work order on this page"), shift-click a range, or Select all N matching (up to 5,000). Then: Edit (Set fields on every selected work order: Add a field, blank clears, Move to a list → Home list, Apply to selection; the fields offered are client, trade, city, state, billing entity, priority, NTE, date received and the custom fields), Set status (grouped by phase; hidden for request-mode roles), Enroll (Enroll N work orders in… an automation: Manual rules, or Automatic (re-run by hand); result "N applied, N waiting on the rule\'s timer, N skipped, N failed"; up to 500), Delete ("Move N work orders to Trash?" — they disappear from everyone\'s list; an administrator can restore them). Result: "N updated, M skipped".',
      value: 'A hundred work orders move in one audited action, and the gates (parts, quote, done, intake) are applied to the whole selection.',
      rules: [
        'Every bulk edit or delete is refused when any row sits outside the viewer\'s scope; a status move is refused when any row would fail a gate ("<gate sentence> N of the selected work orders are missing it (…)").',
        'Visit-owned fields, Quote Due Date, and a Cost or Total Invoiced the system has written are refused with the exact reason; an empty patch is "Nothing to change".',
        'A bulk Assignee on a work order still awaiting acceptance runs the Ready to Assign gate; a bulk move to Invoiced stamps Total Invoiced per row; rows already at the target are neither updated nor skipped; Move to a list needs the status permission.',
        'A paused rule cannot be enrolled ("<name> is paused — turn it on before enrolling"); Enroll is not scope-checked.',
      ],
      permissions: ['work_orders edit + edit on each field (Edit, Enroll)', 'work_orders/status edit (Set status, Move to a list)', 'work_orders delete'],
      audit: ['field_updated / status_changed via bulk', 'deleted'],
    },
    {
      name: 'Export',
      what: 'Export downloads the filtered rows in the shown columns as work-orders-<date>.csv: up to 10,000 rows, UTF-8 with BOM and CRLF, cells starting with = + - @ guarded against formulas, hidden-field columns dropped, presentation-only columns (Clock) left out, WO # / Title / Client / Status / NTE when no columns are given. Logged before the bytes leave with the row count, columns and criteria.',
      value: 'Any outside report is fed without a developer.',
      permissions: ['work_orders/export view'],
      audit: ['work_orders_exported'],
    },
    {
      name: 'Import',
      what: 'Import work orders: 1 Choose a CSV (parsed in the browser), 2 Match the columns (Ignore this column; targets WO # (match key), Status (by name), Home list (by name) and every writable field), Create and update or Only create, 3 What this import will do: Preview is mandatory (a dry run) and tallies N to create / N to update / N skipped / N with errors with the first twenty errors by row ("Rows with errors are left out; the rest still import."), then Import N rows and Done.',
      value: 'The ClickUp history came in through this import; a client\'s spreadsheet of jobs loads in minutes.',
      rules: [
        'Up to 2,000 rows in one transaction; a row without a WO # gets WO-<next>; duplicates within the file, unknown statuses and unknown home lists are errors; a new work order needs a title (the first line of the description serves); a create without a status starts in the first Open-group status and an update keeps its status; NTE and dates are cleaned or reported.',
        'Writable columns: Client WO #, Title, Description, Client, City, State, Trade, Billing entity, NTE, Priority, Date received and the custom fields, each checked against the person\'s field permissions.',
        'Not gated by the status gates on purpose (a data load is not a person pausing a job); created rows without an assignee raise acceptance tasks, SharePoint folders are filed, automations run per row.',
      ],
      permissions: ['work_orders create'],
      audit: ['created (source import)', 'field_updated / status_changed via import'],
    },
    {
      name: 'Add work order',
      what: 'The accent button opens a form built from configuration: which fields appear and which are required is the Add work order column in Admin › Custom fields, refined per client or trade by form layouts ("Using the <layout> layout for <client · trade>: some fields are hidden or required."). Steps: The number (WO #, "The number the client knows this job by"); Site and asset (a picked site fills client, store and address while they are empty or still hold what the last site put there; the asset list is the site\'s, with warranty chips "Under warranty — check before quoting."); then the sections Identity, Where, What is wrong, When it is due, Money and people (Assignee "Nobody yet" with Who\'s available?), More details; Sub Category suggestions "Within <trade>"; Photos and files (up to 10, uploaded after the work order exists and reviewed like any upload; shown only when storage is connected). The footer lists what the form Still needs, or reads Ready.',
      value: 'A new field reaches the intake form without a deploy, and a client-specific form needs no code.',
      controls: [
        { label: 'Start from a template…', does: 'Pre-fills from a saved template ("Filled in from <name>. The WO # is still yours to type."); My templates › Delete.' },
        { label: 'Save as template', does: 'Save what is filled in as a template; Share it with everyone needs admin/fields edit; "The WO # and the asset are not saved — they belong to one job."' },
        { label: 'Create work order / Create and upload N files', does: 'Inserts as Open, logs created (source manual), files the SharePoint folder, starts the dispatch cascade when it is on, runs the create automations, writes the Assignee as an audited edit, then opens the record.' },
      ],
      rules: [
        'The WO # is identity, matched ignoring case, punctuation and a leading "WO": a taken number is refused as you type and on create (409), trash included ("… already exists (in the trash) … restoring it would clash, so the number stays taken", with Open it).',
        'Possible duplicates warn and never block: open work on the same asset (any age), the same site and trade within 30 days, the same store and trade within 30 days; up to eight, with why ("Carry on if this is a different job.").',
        'A missing required field is 409 "This work order still needs …"; keys the form does not offer are dropped; the site must be one the person may see and the asset must stand at it; there must be a status named Open.',
        'Title = the first line of the description; Date received, NTE and Billing entity are promoted from their fields.',
      ],
      permissions: ['work_orders create', 'edit on every submitted field', 'sites view for the site pick', 'admin/fields edit to share a template'],
      audit: ['created (source manual)', 'wo_template_saved', 'wo_template_deleted'],
      since: '0041 / 0063',
    },
  ],
};

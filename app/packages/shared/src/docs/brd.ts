// 0075 · The BRD registry: every module of The One, every feature in it, the
// controls on screen (labels as they are in the JSX), the rules the system
// enforces, the permission the API checks and the value each feature brings.
//
// WHEN A SCREEN, A BUTTON LABEL OR A RULE CHANGES, CHANGE ITS ENTRY HERE.
// tests/docs.test.ts fails when a sidebar item, an admin section, a work-order
// tab, an integration or a status exists that no entry mentions.

import type { DocPart } from './types';

/** The date the prose was last reviewed against the screens (YYYY-MM-DD). */
export const DOCS_REVIEWED_ON = '2026-10-06';

export const BRD_PARTS: DocPart[] = [
  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'platform',
    title: 'Platform: sign-in, navigation, permissions and audit',
    intro:
      'Everything else stands on four things: who can sign in, how the application is laid out, what each role may see and do, and the fact that every change is recorded. These are built once and used by every module.',
    modules: [
      {
        key: 'signin',
        title: 'Sign-in and access',
        where: 'The sign-in page; Admin › Users for invitations.',
        purpose: 'One Microsoft account per person, no passwords held by The One, and a session that can be revoked at once.',
        value: 'Nobody manages a second password; leavers are cut off the moment they are disabled; every action is attributable to a real person because every session belongs to a verified email.',
        users: ['Everyone'],
        features: [
          {
            name: 'Microsoft sign-in (Entra ID)',
            what: 'The Sign in with Microsoft button runs a real OpenID Connect round trip with the company tenant. In development the same button signs in as a chosen account with no password (bypass mode, refused in production).',
            value: 'Single sign-on with the accounts IT already manages; no password resets, no shared logins.',
            controls: [
              { label: 'Sign in with Microsoft', does: 'Starts the Microsoft sign-in; returns to the page that was asked for.' },
              { label: 'Sign out', does: 'Ends the server-side session; the cookie is useless afterwards.' },
            ],
            rules: [
              'Sessions are rows in the database sent as an httpOnly cookie, never tokens the browser could forge; disabling a user ends their sessions immediately.',
              'Every /api route except the sign-in, public share links and signed webhooks answers 401 without a session.',
            ],
            audit: ['user_signed_in', 'user_auto_enrolled'],
            brd: ['5.1.1'],
            since: '0009',
          },
          {
            name: 'Who becomes what on first sign-in',
            what: 'A verified byblosvista.com address with no row on file is created on the spot as OM Under Probation and logged; any other address is invite-only, and creating the person in Admin › Users is the invitation.',
            value: 'New staff can start the same day without a ticket, at the lowest trust tier, and a super admin promotes them when ready; outsiders cannot get in by guessing.',
            rules: ['The allowed domain and the auto-enrol role are configuration (AUTH_ALLOWED_DOMAINS, AUTH_AUTO_ENROL_ROLE).'],
            brd: ['5.1.1'],
          },
          {
            name: 'Super admins',
            what: 'Four named people (Elise, Jordan Brown, Jeff S, Jack) hold the super-admin flag, which passes every permission check and alone unlocks per-person permission adjustments.',
            value: 'A small, named group can always recover access and settle disputes; the flag is separate from the Admin role so administering the system is not confused with working a work order.',
            rules: ['Nobody can change their own super-admin flag; the last super admin cannot be demoted or disabled.'],
            since: '0004',
          },
          {
            name: 'View as',
            what: 'A super admin can act as another person to see exactly what they see; the admin console and its routes still read the real signed-in user.',
            value: 'Support questions ("why can I not see this work order?") are answered by looking, not guessing, without handing the impersonator the admin switches.',
            rules: ['Admin routes, the override editor and the integrations switches read the real user, never the acted-as one.'],
          },
        ],
      },
      {
        key: 'shell',
        title: 'Application shell and navigation',
        where: 'Every page: the sidebar, the top bar, the breadcrumb.',
        purpose: 'One consistent frame around every module so people always know where they are and how to get anywhere in two clicks.',
        value: 'Less training, fewer wrong turns; the sidebar hides what a role cannot use, so each person sees a smaller, clearer application.',
        features: [
          {
            name: 'Sidebar',
            what: 'Dashboard, Pulse, Work Orders, Vendors, Sites, Assets, Clients, Quotes, Payments, Incoming Work Orders, Planned Maintenance, Maintenance, Approvals, Receivables, Contracts, Purchasing, Client Updates and the Admin group. An item shows only when the role holds its section; Admin lists the console sections the person may open.',
            value: 'Each role gets a sidebar that is exactly its job; a salesperson sees Dashboard alone.',
            controls: [
              { label: 'Work Orders badge', does: 'The live count of work orders the viewer may see.' },
              { label: 'Approvals badge', does: 'What waits on the viewer: decisions to make or decisions to acknowledge.' },
              { label: 'Incoming Work Orders badge', does: 'Work orders to accept plus open drafts.' },
            ],
            permissions: ['one section per item (work_orders, dashboard, vendors, …)'],
          },
          {
            name: 'Top bar',
            what: 'The wordmark, the breadcrumb trail, the search box, the notifications bell (Pulse rows plus "For you" notices), the assistant sparkle, the theme switch (sun / moon) and the account menu with Sign out.',
            value: 'The things people reach for most often are in the same place on every screen.',
            controls: [
              { label: 'Search', does: 'Finds work orders by number, client, store or description and opens them.' },
              { label: 'Notifications', does: 'Opens the bell: obligations due and personal notices (tasks given to you, reviews, decisions, expiring insurance).' },
              { label: 'Ask anything (sparkle)', does: 'Opens the assistant panel.' },
              { label: 'Theme', does: 'Switches between Blackout (night) and Daylight Dispatch (day) for this browser.' },
            ],
          },
          {
            name: 'Two themes and accessibility',
            what: 'Night and day themes drawn from one token file; every colour, chart hue and map marker is a token, validated for contrast and for the three common colour-vision deficiencies. Motion respects the reduced-motion preference.',
            value: 'Readable in a dark dispatch room and in daylight; charts stay distinguishable for colour-blind colleagues.',
            permissions: ['admin/themes view for the Themes page; the top-bar switch is for everyone'],
          },
          {
            name: 'Locked with a reason',
            what: 'A page or button a person may not use is shown locked with a sentence saying why and who to ask, instead of a dead end or a silent failure.',
            value: 'People learn the rules from the screen; fewer "it does not work" messages.',
          },
        ],
      },
      {
        key: 'permissions',
        title: 'Roles, permissions and data visibility',
        where: 'Admin › Roles; Adjust in Admin › Users; enforced everywhere.',
        purpose: 'One permission tree decides what every role may view, create, edit, delete and approve, down to a single field of a work order, and which records a person may see at all.',
        value: 'Trust tiers (probation → standard → senior) are real, not a convention; a sensitive field such as Cost can be hidden from a role without hiding the work order; the same resolver runs in the browser and the API so the screen never promises what the server refuses.',
        users: ['Super admins', 'Admin'],
        features: [
          {
            name: 'The permission tree',
            what: 'Every section and sub-section is a path (work_orders, work_orders/status, work_orders/fields/finances/fields.34. Cost, approvals/nte, admin/users, …) with five actions: view, create, edit, delete, approve. An unset action inherits from the path above; granting a write grants view. The tree is drawn on the Roles screen with a search box.',
            value: 'One screen answers "who can do what" for the whole application, and a new module arrives with its own rows.',
            controls: [
              { label: 'Find a section or field…', does: 'Filters the tree to matching rows.' },
              { label: 'View / Create / Edit / Delete / Approve cells', does: 'Click to set; faded cells are inherited.' },
              { label: 'Save role', does: 'Writes the tree; logged with before/after snapshots.' },
            ],
            audit: ['role_created', 'role_updated', 'role_deleted'],
            since: '0021',
          },
          {
            name: 'Per-person adjustments',
            what: 'A super admin can give one person exceptions on top of their role (Adjust in Admin › Users): the same tree, with the role\'s cells faded and the person\'s overrides on top.',
            value: 'A trusted dispatcher can be given one extra right without inventing a role for them.',
            permissions: ['super admin only'],
            audit: ['user_permissions_set'],
          },
          {
            name: 'Field-level visibility and redaction',
            what: 'Every work-order field is a row under its section (Overview, Finances, Dates, People, CICO, Payables, Invoicing, AR, QC, Integrations, …). A field a role cannot view is removed from every payload the API sends, not just hidden on screen; a field it cannot edit is drawn read-only and refused on write.',
            value: 'Cost, profit and client NTE can be kept from roles that should not see them, including in exports and the assistant.',
          },
          {
            name: 'Status-change mode',
            what: 'Work orders › Status changes is one three-way choice per role: Change directly, Must request, or Not allowed.',
            value: 'Dispatcher tiers propose; managers decide; nobody edits a status by accident.',
            brd: ['2.4.1', '8.1.3'],
          },
          {
            name: 'Which work orders a person sees (scope)',
            what: 'Work orders › Which work orders: Everything, or Only theirs (assigned to them by display name), widened by ticking billing entities (Entity · SFM, …), by the clients listed on the person in Admin › Users, and narrowed by a site restriction. Super admins are never scoped.',
            value: 'Each dispatcher works their own book; a manager sees the whole entity; the sales team counts only their clients; nothing leaks through a dashboard, an export, a queue or a shared link.',
            rules: [
              'The scope predicate is appended to every list, count, queue, badge, KPI, dashboard card and per-work-order route; a work order outside it answers 403.',
              'Bulk edit and delete refuse a selection that is not wholly inside the scope.',
              'The list header shows a "Yours only" / "Yours + SFM" chip for a scoped person.',
            ],
            brd: ['8.5'],
            since: '0032',
          },
          {
            name: 'Which dashboards a role opens',
            what: 'Dashboard › Which dashboards lists every board; under each, "Which work orders it counts": Same as work orders, Everything, or Only theirs.',
            value: 'A board can be shared with a role and still count each viewer\'s own book, or deliberately count everything for a management view.',
            since: '0050',
          },
          {
            name: 'Technician map rights',
            what: 'Technician map rows decide who sees VR vendors, all technicians or only theirs, statewide and nationwide vendors, subcontractors, and who may add a technician or hire.',
            value: 'The vendor database is never exposed wholesale; a dispatcher sees what one search needs.',
            since: '0057',
          },
        ],
      },
      {
        key: 'audit',
        title: 'Audit and traceability',
        where: 'Admin › Audit log; the Audit trail tab on every work order; the field history panel.',
        purpose: 'Every button in the application writes to one append-only log with who, when, what changed and the whole before and after.',
        value: 'Disputes ("who changed the NTE?") are settled in seconds; the log is also the raw material for the "time between" dashboard cards, the obligations engine and the AR audit.',
        features: [
          {
            name: 'One log for everything',
            what: 'Work-order edits, status changes (with how: direct, request, visit, automation, webhook, payment, quote), visits, attachments, messages, calls, quotes (whole snapshots), payments, invoices, admin changes (fields, statuses, roles, users, automations, settings), saved views, exports, sign-ins, assistant questions, integration switches.',
            value: 'There is no second place to look.',
            audit: ['field_updated', 'status_changed', 'created', 'visit_created', 'comment_added', 'quote_updated', 'role_updated', 'work_orders_exported', '…'],
            brd: ['1.2.1'],
          },
          {
            name: 'Append-only at the database',
            what: 'A database trigger refuses any UPDATE or DELETE on the log; a correction is a new row.',
            value: 'The trail is evidence, not an opinion.',
            brd: ['1.2.2'],
            since: '0029',
          },
          {
            name: 'Admin › Audit log',
            what: 'Filter by From, To, User, Change and Search; page with Newer and Older; Export CSV of the filtered rows (itself logged). Rows link to the record they changed.',
            value: 'Managers and auditors read it without asking a developer.',
            permissions: ['admin/audit view'],
            controls: [
              { label: 'From / To / User / Change / Search', does: 'Narrow the rows.' },
              { label: 'Export CSV', does: 'Downloads the filtered rows; logged as audit_log_exported.' },
            ],
          },
          {
            name: 'Not logged on purpose',
            what: 'Per-user preferences (column widths, collapsed cards, theme) and pure clicks (tabs, filters) change no record and are not logged.',
            value: 'The log stays about records, so it stays readable.',
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'work-orders',
    title: 'Work orders: list, record, visits, statuses and intake',
    intro:
      'The work order is the record everything else hangs on. This part covers how work orders arrive, how the list is worked, what the record holds, how visits and statuses move it along, and the gates that keep it honest.',
    modules: [
      {
        key: 'wo-list',
        title: 'Work Orders list',
        where: 'Sidebar › Work Orders.',
        purpose: 'The working list: every work order the viewer may see, arranged the way each person needs it, with the bulk tools to move many at once.',
        value: 'Replaces the ClickUp list and the Teams reminders with one list that remembers each person\'s arrangement and enforces the rules on every bulk move.',
        users: ['Everyone with work_orders view'],
        features: [
          {
            name: 'Views (tabs)',
            what: 'All work orders, Due Today and Escalation Tracker are built in; saved views follow. A saved view keeps filters, columns, grouping and sort, can be shared with the team, and can be pinned as the person\'s landing view.',
            value: 'Each person opens the list already arranged for their job; shared views give the team one definition of "waiting on parts".',
            controls: [
              { label: 'Save view', does: 'Name it, tick Share with the team, Save.' },
              { label: 'Pencil / trash on a view', does: 'Owner-only edit and delete.' },
              { label: 'Pushpin', does: 'Makes Work Orders open on that view for you.' },
            ],
            audit: ['view_created', 'view_updated', 'view_deleted'],
            since: '0011',
          },
          {
            name: 'Status-group segment and quick-filter chips',
            what: 'Segment buttons per phase group (All, Open, Active, Pending, Done, Closed and any admin-added group); chips for Status, Assignee, FM, Comp and AM with tickable values and Clear.',
            value: 'The two most common narrowings take one click.',
          },
          {
            name: 'Filter, Group, Sort, Columns',
            what: 'Filter on any field with a test and value, Match all / Match any; Group by a field with counts per bucket; sort by column or Sort by breach (closest deadline first); choose and reorder columns, including the five computed columns (location, completed on, age band, last client message, last sent to client).',
            value: 'Any question about the list is answered without an export.',
            controls: [
              { label: 'Filter › Add filter', does: 'Adds a rule (field, test, value).' },
              { label: 'Group', does: 'Buckets the list by a field; No grouping undoes it.' },
              { label: 'Columns › Shown / Add a column', does: 'Reorder, remove or add columns.' },
              { label: 'Sort by breach', does: 'Deadline order.' },
            ],
          },
          {
            name: 'Due Today',
            what: 'A built-in tab whose segments are All · Escalations · Scheduled · Quote · Parts arriving, each for a chosen day (Today, Tomorrow or a date). Quote includes overdue quotes while the status is still before Quote Ready.',
            value: 'The daily to-do list of rule 4.3, with no spreadsheet: what is due, what is on site, which quote is late, what arrives.',
            brd: ['4.1', '4.3'],
            since: '0030',
          },
          {
            name: 'Escalation Tracker',
            what: 'A built-in tab listing every work order flagged Escalated, with the ordinary chips and filters on top.',
            value: 'The team-wide view of what has been escalated, for the morning stand-up.',
            brd: ['7.3.3'],
            since: '0038',
          },
          {
            name: 'Status pill in the row',
            what: 'Click the status in a row to change it (or request it) with the same gates and Ecotrak tags as on the record.',
            value: 'A status move without opening the work order.',
          },
          {
            name: 'Selection and bulk actions',
            what: 'Tick rows, the header box or Select all N matching; then Edit (one field across the selection, blank clears), Set status (hidden for request-mode roles), Enroll (put the selection through an automation), Delete (Move to Trash).',
            value: 'A hundred work orders move in one audited action, and the gates (parts, quote, scope) are applied to the whole selection.',
            rules: ['Every bulk write is refused when any row would fail a gate or sits outside the viewer\'s scope.', 'Visit-owned and computed fields cannot be bulk-edited.'],
            permissions: ['work_orders edit + edit on each field', 'work_orders/status edit', 'work_orders delete'],
          },
          {
            name: 'Export and import',
            what: 'Export downloads the filtered rows in the shown columns as CSV (logged). Import maps CSV columns to fields, previews, then creates and updates by WO #.',
            value: 'The ClickUp history came in through this import; exports feed any outside report without a developer.',
            controls: [
              { label: 'Export', does: 'CSV of the filtered rows in the visible columns.' },
              { label: 'Import › Choose file › Match the columns › Preview › Import N rows', does: 'Create and update, or Only create.' },
            ],
            permissions: ['work_orders/export view', 'work_orders create'],
            audit: ['work_orders_exported', 'created (source import)'],
          },
          {
            name: 'Add work order',
            what: 'The accent button opens a form built from configuration: which fields appear and which are required is the Add work order column in Admin › Custom fields, refined per client or trade by form layouts. Site and asset pick fills the client, store and address; templates pre-fill the form; files upload once the work order exists.',
            value: 'A new field reaches the intake form without a deploy, and a client-specific form needs no code.',
            controls: [
              { label: 'Start from a template…', does: 'Pre-fills from a saved template (My templates, Share it with everyone).' },
              { label: 'WO #', does: 'Required; a number already in use, even in the trash, is refused (409).' },
              { label: 'Site / Asset', does: 'Links the records and fills address fields that are still empty.' },
              { label: 'Create work order', does: 'Inserts as Open, logs created (source manual), runs the create automations, writes the Assignee as an audited edit.' },
              { label: 'Save template', does: 'Keeps the filled form for next time.' },
            ],
            rules: ['Possible duplicates (same store and trade still open within the window, open work on the same asset or site) warn with links and never block.', 'Fields the form does not offer are dropped rather than written.'],
            permissions: ['work_orders create', 'sites view for the site pick'],
            since: '0041 / 0063',
          },
        ],
      },
      {
        key: 'wo-record',
        title: 'The work-order record',
        where: 'Open any row. Header, action bar, tabs and the right rail.',
        purpose: 'One page that holds everything about a job: the fields, the money, the dates, the people, the visits, the files, the conversation and the history.',
        value: 'Nobody re-keys between ClickUp, Teams and a spreadsheet; the record is the single source and every tab is gated by role.',
        features: [
          {
            name: 'Header',
            what: 'WO number and client reference (Ext ref), client, store, trade, status pill with Change status / Request status change, the phase bar, chips (In status, SLA due, Ecotrak · status, Awaiting acceptance, SharePoint folder, request decision), the Emergency / Escalated rails, Call and Mark as Escalated.',
            value: 'The state of the job in one glance.',
            controls: [
              { label: 'Change status / Request status change', does: 'Opens the status menu with gate tags (Needs quote, Needs parts, Needs check-out, Needs cost, Needs after photo, Ecotrak).' },
              { label: 'Call', does: 'Records the intent and dials through the Quo desktop app; Just call or Call and draft a quote.' },
              { label: 'Mark as Escalated / Escalated · Clear', does: 'Sets the Escalated field (managers).' },
            ],
          },
          {
            name: 'Action bar',
            what: 'Assign vendor / Re-assign vendor, Pause / Resume, Add ETA, Tag, Increase NTE, Complete service, Cancel work order / Reopen, Save as PDF.',
            value: 'The Facilio-style actions a dispatcher expects, each audited and each a plain column on the work order.',
            controls: [
              { label: 'Assign vendor', does: 'Find a vendor and pick one; a blacklisted vendor is refused.' },
              { label: 'Pause', does: 'Reason required; a marker only, no clock stops (rule 2.4.4).' },
              { label: 'Add ETA', does: 'Expected on site, Save ETA, Clear the ETA.' },
              { label: 'Tag', does: 'A tag with a reason.' },
              { label: 'Increase NTE', does: 'New NTE and why; a manager with approvals/nte approve decides on the Cost breakdown tab; approval writes the NTE as an audited field edit.' },
              { label: 'Complete service', does: 'Completion note, fault code, action code, temporary fix; records the completion without moving the status.' },
              { label: 'Cancel work order', does: 'Reason required; moves to the Cancel… status; Reopen undoes it.' },
              { label: 'Save as PDF', does: 'Work order (the main fields) or Request (what the client sent), in the billing entity\'s branding; logged.' },
            ],
            permissions: ['work_orders edit', 'work_orders/pdf view'],
            since: '0064 / 0073',
          },
          {
            name: 'Tabs',
            what: 'All fields, Finances, Dates, CICO, People, Payables, Site, Parts, Flags, Overview, Messages, Audit trail, Checklist, Cost breakdown, Timelog & metrics, Related. Each tab is a permission row (work_orders/tabs/<tab>).',
            value: 'A role sees the tabs of its job: AR sees Finances and the audit; a probation dispatcher does not see Payables.',
          },
          {
            name: 'Inline editing and the field catalogue',
            what: 'Click a value, change it, tick. The catalogue is the core columns plus every custom field (text, long text, dropdown, checkbox, date, date & time, money, number, people, phone, link, address, attachment, function, rating); money and dates are typed, dropdown options are the admin\'s list.',
            value: 'Fields are configuration: the team adds one in Admin and it appears on the record, the list, the filters, the automations and the exports.',
            rules: [
              'Visit-owned fields (Visit Type, Check-in/out Status, Checked-in At, Checked-out At, Tech Name, Tech Phone Number, CICO Method) mirror the latest visit and cannot be typed.',
              'Quote Due Date is computed and cannot be typed.',
              'Cost is the sum of accepted payment requests once the system has written it; Total Invoiced is the quote total once stamped; Profit = Total Invoiced minus Cost.',
            ],
            permissions: ['work_orders edit + edit on the field'],
            audit: ['field_updated'],
          },
          {
            name: 'Overview',
            what: 'Deadlines, the updates feed (read-only since the composer moved to Messages, with a Write a message button), the Photos card (Waiting for approval list, approved images grouped by kind, other files) and the activity.',
            value: 'The story of the job on one tab.',
          },
          {
            name: 'Finances',
            what: 'NTE and cost against it (Over NTE), the client quote card (Create quote, Approve / Decline from the card), the invoice card (Raise invoice, Confirm invoice from a proposal), Total Invoiced and Profit.',
            value: 'The money side of the work order with the quote and the invoice beside the numbers.',
          },
          {
            name: 'Dates, People, Site, Parts, Flags',
            what: 'Dates: received, due, SLA due, scheduled, parts arrival, quote due (red while owed). People: Assignee (with Who\'s available?), AM, Technicians card (Find a technician, Hire, Suggested vendors), dispatch offers. Site: the address fields and the Site record block (link a site and an asset, site events). Parts: Parts Required and the parts fields. Flags: Emergency first, then the other checkboxes.',
            value: 'Each cluster of fields where the person working that part of the job expects it.',
          },
          {
            name: 'Payables',
            what: 'Payment requests (Request payment), vendor bills (Record bill, Confirm bill), purchasing documents tied to the work order and the payment history.',
            value: 'The cost side of the work order next to the request that creates it.',
          },
          {
            name: 'Checklist, Cost breakdown, Timelog & metrics, Related',
            what: 'Checklist: steps (typed or pasted one per line, or from a job plan), ticked as done. Cost breakdown: Cost against NTE and NTE increase requests. Timelog: technician time entries and durations. Related: the schedule that raised it, work permits, purchasing documents, other work orders at the site or asset.',
            value: 'The Facilio parity set for the record, without leaving the page.',
            since: '0064 / 0065',
          },
          {
            name: 'Right rail',
            what: 'Responsibility (assignee, vendor), Location (site, geofence result), Time (a live timer in the status, SLA) and Cost, shown on Overview and the four record tabs.',
            value: 'The four numbers a manager asks about, always visible.',
          },
          {
            name: 'Audit trail tab and field history',
            what: 'Every change on this work order, with who, when, how (via visit, approval task, automation, webhook, payment, quote, sign-off) and the before/after; a per-field history panel.',
            value: 'Rule 1.2.1 at the record.',
          },
        ],
      },
      {
        key: 'visits',
        title: 'Visits (CICO), the quote clock and sign-off sheets',
        where: 'The CICO tab and the CICO section of All fields.',
        purpose: 'A log of every technician visit with its own check-in and check-out stamps, the status moves that follow, the 48-hour quote clock and the sign-off sheet the technician gets signed on site.',
        value: 'Replaces three free-text fields with a trustworthy log; the quote clock and the On Site moves run themselves; the sign-off sheet that used to take a Make + Paperform automation is one button.',
        features: [
          {
            name: 'The visit log',
            what: 'New visit: Visit type (Assessment, Job, Return trip), Technician (TechPicker: free text or anyone on file), Phone, Method (pre-filled from the FM). The row\'s status dropdown (Not checked in, Checked in, Checked out, Checked out · return trip needed) stamps the time to the second; the pencil corrects stamps; the trash icon deletes.',
            value: 'Every visit is dated and attributable; the latest one still drives the legacy columns and automations through the mirrored fields.',
            rules: ['A check-in moves the work order On Site (Assessment or Job); gates and the Ecotrak check still run and a refusal never undoes the check-in.', 'A technician picked from the records joins the dispatcher\'s own list.'],
            permissions: ['work_orders/fields/cico view / edit'],
            audit: ['visit_created', 'visit_updated', 'visit_deleted', 'field_updated via visit'],
            brd: ['2.2.2'],
            since: '0027',
          },
          {
            name: 'Check-in method by FM',
            what: 'An admin table FM → method (IVR, Portal, Email, Operator, App, Manual) with a detail, pre-filling a new visit.',
            value: 'The dispatcher does not have to remember how each facilities-management company wants check-ins done.',
            since: '0028',
          },
          {
            name: 'The quote clock',
            what: 'Quote Due Date = the latest Assessment check-out + 48 wall-clock hours skipping Saturdays, Sundays and the holiday table, in America/Chicago. Re-derived on every visit write; cleared when the assessment visit is deleted.',
            value: 'The promise to the client is computed, visible and red when missed, with no hand arithmetic.',
            brd: ['2.3.1', '2.3.2', '2.3.3'],
            since: '0030',
          },
          {
            name: 'Visit location and geofence',
            what: 'On a visit row, Use this device\'s location or Type coordinates records where the check-in happened; the result is compared with the site\'s pin and radius.',
            value: 'A check-in far from the site is visible, without a technician app.',
            since: '0064',
          },
          {
            name: 'Sign-off sheets',
            what: 'A one-page blank sheet in the billing entity\'s branding (SFM, TPM, AF, RF, EDS, BKR, BKR EMCOR) with the client\'s WO number and the address, generated automatically when the work order is assigned and by Generate / New sheet. Share with tech texts its link through Quo (or the Quo desktop app). The signed copy texted back is filed as a pending Sign-off attachment, sets Sign-Off Link and marks the sheet signed; when several sheets could match, each CICO card offers Yes, file it here / Not this one.',
            value: 'The proof the invoice needs comes back by itself, in the right place.',
            audit: ['signoff_generated', 'signoff_shared', 'signoff_received', 'signoff_reply_held', 'signoff_reply_dismissed'],
            since: '0070',
            deferred: ['Needs QUO_API_KEY and QUO_FROM_NUMBER on the server and the message.received webhook event.'],
          },
        ],
      },
      {
        key: 'status',
        title: 'Statuses, phases, gates, requests and Ecotrak rules',
        where: 'Change status on the record and in the list; Approvals › Status changes; Admin › Custom fields › Statuses.',
        purpose: 'The pipeline as data (statuses in phase groups), the rules that keep a status honest (gates), the request path for dispatcher tiers, and the check against what Ecotrak would allow.',
        value: 'A work order cannot be marked Quote Ready without a quote or Done without proof and cost; dispatchers propose and managers decide; every move is recorded with how it happened.',
        features: [
          {
            name: 'Statuses and phase groups',
            what: 'Statuses are rows with a colour and a position inside phase groups (Open, Active, Pending, Done, Closed and admin-added groups); each status also maps to a lifecycle phase for the phase bar (Intake, Assessment, Quote, Approval, Scheduled, In Progress, Parts, Done, Invoiced).',
            value: 'The team changes the pipeline in Admin without a deploy; the list tabs and the phase bar follow.',
            permissions: ['admin/fields edit'],
            audit: ['status_created', 'status_updated', 'status_deleted', 'status_group_created', '…'],
            since: '0013 / 0020',
          },
          {
            name: 'Direct change and bulk change',
            what: 'Change status in the header or the row pill; Set status in the bulk bar; every move runs the gates, the Ecotrak check, the money syncs and the automations, and logs status_changed with how.',
            value: 'One code path for every way a status can move, so no path skips a rule.',
            permissions: ['work_orders/status edit'],
            audit: ['status_changed'],
          },
          {
            name: 'Status change requests',
            what: 'Request-mode roles pick a status and a request lands in Approvals › Status changes (one open per work order; a new pick re-targets it). Approve moves the work order; Reject needs a reason. The requester sees the decision on the header chip and in My requests until Continue / Understood / Request again / Withdraw.',
            value: 'Probation and standard dispatchers keep working while managers keep control; nothing waits in Teams.',
            permissions: ['work_orders/status create to request', 'approvals/status approve to decide'],
            brd: ['2.4.1', '2.4.2', '2.4.3', '2.4.4'],
            since: '0031',
          },
          {
            name: 'Gates',
            what: 'Quote Ready needs a quote with data; Waiting for Parts and Please Order Parts need Parts Required; Done / Incurred needs a visit checked in and out, Cost, a quote with data and an approved after photo (or a before photo and sign-off for Bill For Incurred). The menu tags the pick (Needs quote, Needs parts, Needs check-out, Needs cost, Needs after photo, Not ready) and the API answers 409 with what is missing.',
            value: 'The record is complete before it claims to be; AR audits less.',
            rules: ['Gates run on the single move, the bulk move, a request (refused up front) and an approval (checked again before it commits); the CSV import is not gated by design.'],
            brd: ['11.2.1', '11.2.2', '11.3.1', '11.3.2', '11.3.3', '11.3.4'],
            since: '0035',
          },
          {
            name: 'Ecotrak allowed transitions',
            what: 'A shared table of what Ecotrak lets a service provider set from each Ecotrak status, and which Ecotrak status each of ours would push. Every move is checked: warn mode (default) lets it through and records the verdict on the audit row; block mode refuses with "API Violation: Ecotrack does not allow this status transition." The status menu tags a pick Ecotrak would refuse; the header shows an Ecotrak · status chip.',
            value: 'When the outbound push goes live the rules are already applied and the history already shows which moves would have been refused.',
            brd: ['2.6.3', '2.6.4', '2.7'],
            deferred: ['Nothing is pushed to Ecotrak until go-live; targets no allowed list names are answered "unlisted", never refused.'],
          },
          {
            name: 'What a status move triggers',
            what: 'Moving to Invoiced or Invoiced Not Paid stamps Total Invoiced from the quote; landing in the Done group proposes an invoice and a vendor bill from auto-invoice contracts; moving to the requested status by any route closes an open request; cancelling closes an open acceptance.',
            value: 'The side effects people used to remember are automatic.',
          },
        ],
      },
      {
        key: 'incoming',
        title: 'Incoming Work Orders: acceptance and drafts',
        where: 'Sidebar › Incoming Work Orders: To accept and Drafts tabs.',
        purpose: 'One door for every work order on its way in: the queue a manager accepts from and assigns, and the OP Admin\'s drafting area.',
        value: 'The inbox of client traffic is a queue with a badge, not an email folder; a work order cannot reach a dispatcher half-filled.',
        users: ['Team Lead', 'Assistant TL', 'Account Manager', 'Admin', 'Operations Admin'],
        features: [
          {
            name: 'To accept',
            what: 'Every work order created without an assignee (Ecotrak ingest, CSV import). Accept opens the assignee picker (dispatcher tiers first, Who\'s available? beside it) and Accept and assign writes the Assignee as the manager\'s edit; Reject needs a reason and moves it to Cancelled / Postponed. The row says Fill before assigning: … while intake fields are missing and Accept stays locked.',
            value: 'Rule 7.1 in one lane: decide fast, assign to the least loaded dispatcher, and never hand over an incomplete work order.',
            controls: [
              { label: 'Accept › Assign to › Accept and assign', does: 'Decides the task, then writes the Assignee.' },
              { label: 'Who\'s available?', does: 'People on this client or all dispatchers, each with active work orders per status; Fewest first / Most first.' },
              { label: 'Reject › Reject with note', does: 'Reason required; status → Cancelled / Postponed.' },
            ],
            permissions: ['approvals/intake view / approve'],
            brd: ['7.1.1', '7.1.2', '7.1.3', '7.1.4', '11.1.1', '11.1.2'],
            since: '0036 / 0037',
          },
          {
            name: 'Drafts (WO Intake)',
            what: 'New work order opens a draft with the WO #, the 13 intake fields, Client and Assignee; Save draft keeps it; Submit & assign creates the work order already assigned (no acceptance task); Discard keeps the row as discarded.',
            value: 'The Operations Admin\'s staging area for emails and phone calls, with the same completeness rule as acceptance.',
            permissions: ['intake view / create / edit'],
            audit: ['intake_draft_created', 'intake_draft_updated', 'intake_draft_submitted', 'intake_draft_discarded'],
            brd: ['14.1', '14.3.3'],
            since: '0040',
          },
          {
            name: 'Ready to Assign gate',
            what: 'Received on, Due date, SLA, Address, City, State, Zip code, Store, Trade, WO description, FM, Comp and Client NTE must be filled before an Assignee can be written while an acceptance is open.',
            value: 'A dispatcher never opens a work order to find the address missing.',
            brd: ['11.1.1', '11.1.2'],
          },
          {
            name: 'Assignee availability',
            what: 'Beside every Assignee picker (create form, draft, accept, the Assignee seat): For <client> (people listed on the client in Admin › Users) or All dispatchers, each with the number of active work orders across every client, a load bar, a chevron for their work orders per status, Fewest first / Most first, Show everyone else.',
            value: 'Assignment is by load, not by memory.',
          },
        ],
      },
      {
        key: 'approvals',
        title: 'Approvals inbox',
        where: 'Sidebar › Approvals.',
        purpose: 'The manager\'s to-do list: every yes-or-no the system needs from a person, in one sectioned inbox.',
        value: 'Nothing waits in a chat thread; the oldest waits first; escalated rows float to the top; every decision is audited and acted on by the system.',
        users: ['Team Lead', 'Assistant TL', 'Account Manager', 'Admin', 'Accounts Payable'],
        features: [
          {
            name: 'Sections and lanes',
            what: 'Sections All · NTE increases · Status changes · Manager reviews · Quotes · Payments (each a permission path approvals/<section>, the API trims the inbox to the viewer\'s sections plus their own requests); lanes For me · Open · Done · My requests. Escalated rows pin above the rest of the waiting lanes.',
            value: 'One inbox, each person seeing only the decisions that are theirs.',
            permissions: ['approvals view', 'approvals/nte|status|reviews approve', 'quotes approve', 'payments approve'],
            brd: ['7.2.2', '7.2.3', '7.3.3'],
            since: '0026',
          },
          {
            name: 'NTE override',
            what: 'Raised by the seeded automation when Cost rises above the client NTE; while open, quote approve / send and payment approve / send to Yoda are held (409, the button reads locked with the reason); cancelled by itself once Cost is back under the NTE. Decisions post an internal comment.',
            value: 'No money moves past the client\'s ceiling without a manager\'s yes.',
            brd: ['1.5.2'],
          },
          {
            name: 'Decide, claim, withdraw, acknowledge',
            what: 'Approve (optional note), Reject (reason required), Claim takes a task for yourself; My requests offers Withdraw, Continue (approved) and Understood (rejected).',
            value: 'The loop closes on both sides: the decider acts, the requester sees it.',
            controls: [
              { label: 'Approve / Reject with note', does: 'Decides one row; the system then moves the work order or holds the money.' },
              { label: 'Claim', does: 'Assigns the task to you.' },
              { label: 'Withdraw / Continue / Understood', does: 'The requester\'s side.' },
            ],
          },
          {
            name: 'Badge and counts',
            what: 'The sidebar badge counts what waits on the viewer: to decide, plus to acknowledge.',
            value: 'The manager knows from any page.',
          },
        ],
      },
      {
        key: 'flags',
        title: 'Emergency and Escalated flags',
        where: 'The work-order header, the Flags tab, every list.',
        purpose: 'Two checkbox fields that colour the work order everywhere it appears.',
        value: 'Urgent work is unmistakable in every list, queue and dashboard, and the escalation route from an email tool is one webhook.',
        features: [
          {
            name: 'Emergency',
            what: 'A checkbox in the Overview section; rows carry it so every list draws the red rail and badge without a second fetch. A paused automation "priority changed to urgent → Emergency" is the hook for the client portals.',
            value: 'The ClickUp "emergency" status becomes a flag that survives every status change.',
            brd: ['2.5.1'],
            since: '0034',
          },
          {
            name: 'Escalated',
            what: 'A checkbox the dispatcher tiers cannot edit; Mark as Escalated in the header; amber badge and rail; pinned in Approvals; the Escalation Tracker tab; an email webhook (POST /api/webhooks/email-escalation with a shared secret) sets it and logs the payload, never clears it.',
            value: 'A client escalation is visible to everyone within a minute and tracked until cleared.',
            brd: ['7.3.1', '7.3.2', '7.3.3'],
            since: '0038',
            deferred: ['The webhook secret is not set on the live site yet.'],
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'money',
    title: 'Money: quotes, payments, invoices, contracts and purchasing',
    intro:
      'Money flows both ways on a work order: the client is quoted and invoiced (receivables) and the technician is paid (payables). Every figure is computed in integer cents, every document is numbered, and the two sides meet in Cost, Total Invoiced and Profit on the work order.',
    modules: [
      {
        key: 'quotes',
        title: 'Quotes',
        where: 'Sidebar › Quotes; the Client quote card on a work order; the quote builder.',
        purpose: 'One quote per work order, built from the technician\'s report, priced from the client contract, submitted, approved and sent, then printed.',
        value: 'Quotes are consistent across dispatchers, priced from the contract rather than memory, approved by the right role, numbered, and never re-priced after approval.',
        users: ['Senior OM', 'Team Lead', 'Assistant TL', 'Account Manager'],
        features: [
          {
            name: 'The builder',
            what: 'Tech reported that… (required), priced lines (quantity, rate, unit, tax %, markup %, overtime), scope lines, options (alternatives, include in summary), sales tax from the tax-rate picker; autosaves; a red chip lists what blocks submission.',
            value: 'A quote that reads the same to every client and adds up the same on screen and in print.',
            controls: [
              { label: 'Create quote', does: 'Issues the number (Q-<entity>-<year>-<n>) and snapshots the contract rates.' },
              { label: 'Add line / Add scope line / Add option', does: 'Builds the document.' },
              { label: 'Submit for approval', does: 'Draft → pending approval.' },
              { label: 'Approve & Send to CMMS', does: 'Approves and marks sent (the push waits for go-live).' },
              { label: 'Reject with note', does: 'Back to draft with the note.' },
              { label: 'Print / PDF', does: 'The printable document with the default template\'s letterhead and terms.' },
            ],
            rules: ['Editable only while draft or pending approval.', 'Approving and sending are locked while an NTE override is open.', 'Amount = qty × rate × (1 + markup) × (overtime multiplier if overtime); tax rides with its option.'],
            permissions: ['quotes create / edit / approve'],
            audit: ['quote_created', 'quote_updated (whole snapshots)', 'quote_status_changed'],
            since: '0003 / 0048',
          },
          {
            name: 'Quotes queue',
            what: 'Lanes All · Drafts · Pending approval · Approved · Sent with the number, the work order and Approve & send / Decline on the row.',
            value: 'Managers approve from the list; the approval obligation (4 business hours) is measured on this queue.',
          },
          {
            name: 'Contract pricing',
            what: 'When a quote is created the contract in force for the work order (client, entity, sites, trades, dates) is snapshotted with its overtime multiplier.',
            value: 'An approved quote never changes price because a rate card was edited later.',
            since: '0046',
          },
          {
            name: 'AI quote draft from a call',
            what: 'From a Quo call with a transcript, Draft a quote with AI sends the transcript, the work order and its contract rates to Claude and returns a draft in the builder\'s own shape with assumptions and missing information; the review page lets the person adjust it beside the transcript and Submit quote files it as an ordinary quote.',
            value: 'The first draft is written while the dispatcher is still on the phone; prices are never invented (client price, vendor cost plus markup, contract rate, or a listed gap).',
            permissions: ['work_orders/calls create', 'quotes edit'],
            audit: ['quote_ai_drafted', 'quote_ai_redrafted', 'quote_ai_submitted', 'quote_ai_discarded'],
            since: '0054',
            deferred: ['Needs ANTHROPIC_API_KEY on the server; pricing references from past quotes (vector search) are next.'],
          },
        ],
      },
      {
        key: 'payments',
        title: 'Technician payments and vendor bills',
        where: 'Sidebar › Payments; the Payment requests and Vendor bills cards on the Payables tab.',
        purpose: 'The payables queue: a request per vendor payment, approved by the right role, handed to Yoda (the payment tool) and marked paid; the vendor\'s own bills beside it.',
        value: 'Technicians are paid fast and traceably, which keeps good technicians; the work order\'s Cost is the sum of what was actually approved, not a typed guess.',
        users: ['OM (dispatcher)', 'Team Lead', 'Accounts Payable'],
        features: [
          {
            name: 'Payment requests',
            what: 'Request payment (vendor record, purpose, amount, method) → Needs approval (Approve / Reject with note) → To process (Send to Yoda with a reference, Mark paid). Lanes Needs approval · To process · All requests · Vendor bills.',
            value: 'One queue with a clear owner per lane.',
            permissions: ['payments create / approve', 'payments/process edit'],
            audit: ['payment_requested', 'payment_approved', 'payment_rejected', 'payment_sent', 'payment_paid'],
            since: '0022',
          },
          {
            name: 'Cost follows the payments',
            what: 'Cost = the sum of the work order\'s accepted requests (approved, sent to Yoda or paid), re-derived inside every decision; rejecting takes one back out; once the system has written Cost it cannot be typed over.',
            value: 'Cost on the work order is a fact, and the Done gate and Profit read a fact.',
            brd: ['11.3.2'],
          },
          {
            name: 'Approval tiers by amount',
            what: 'Bands per decision kind (payment, vendor bill, invoice) naming the roles allowed inside them; the row carries the tier so the button is locked with the reason before the click.',
            value: 'A $3,000 payment cannot be approved by someone whose authority stops at $500.',
            brd: ['6.2.3'],
            since: '0047',
          },
          {
            name: 'Vendor bills',
            what: 'Record bill (vendor, their invoice #, dates, lines) → received → approved → paid, or disputed (internal comment) or void; credit notes against a bill; invoicing rules that warn (never block) on a bill that looks wrong.',
            value: 'The vendor\'s paper is matched to the work order and checked before it is paid.',
            audit: ['vendor_bill_created', 'vendor_bill_updated', 'vendor_bill_status_changed'],
            since: '0047 / 0066',
          },
          {
            name: 'Payments dashboard',
            what: 'A prebuilt board over the payment requests (dispatcher, company, FM, trade, state, purpose, vendor).',
            value: 'AP sees the backlog and the spend by dimension without an export.',
          },
        ],
      },
      {
        key: 'receivables',
        title: 'Receivables: audit and invoicing',
        where: 'Sidebar › Receivables: Audit and Invoicing tabs.',
        purpose: 'The AR audit of completed work (the Argus assistant absorbed) and the client invoice from the approved quote.',
        value: 'A pristine record before it is billed; one invoice per work order, numbered per entity and year, with figures frozen when sent.',
        users: ['Accounts Receivable', 'Admin'],
        features: [
          {
            name: 'Audit',
            what: 'Lanes All · Clean · Minor · Major with the auto-check results per work order, the Admin and Quote ticks, Grey flag handling and Resolve via; a clean, ticked work order becomes Ready to invoice.',
            value: 'Dispatcher mistakes are caught before the client sees them.',
          },
          {
            name: 'Invoicing',
            what: 'Stages All · Proposed · Ready · Drafts · Sent · Paid. Raise invoice drafts from the approved quote (incurred plus summary options, overtime folded in); amount editable until sent; Send needs invoicing approve and passes the amount tier; Mark paid; Void keeps the number and can be reopened. Lines are a snapshot. Print at /invoices/:id/print with the document template.',
            value: 'The invoice says what it said when it was sent, forever.',
            rules: ['Number <entity>-<year>-<n> claimed in the issuing transaction, never reused.', 'Money is computed in integer cents (1.5 × 99.99 bills 149.99).', 'A zero-total invoice cannot be sent.'],
            permissions: ['invoicing view / create / edit / approve'],
            audit: ['invoice_created', 'invoice_updated', 'invoice_status_changed'],
            since: '0045',
          },
          {
            name: 'Billing proposals',
            what: 'When a contract has Bill automatically on completion, landing in the Done group proposes an invoice (and a vendor bill from the vendor card); Confirm files it with exactly those lines, Dismiss drops it and keeps the note.',
            value: 'Completion drafts the paperwork; a person only confirms.',
            brd: ['6.4'],
            since: '0053',
          },
          {
            name: 'Total Invoiced follows the quote',
            what: 'Moving to Invoiced or Invoiced Not Paid stamps Total Invoiced with the quote total; after that it cannot be typed. Profit = Total Invoiced minus Cost.',
            value: 'Profit per work order is derived, not keyed.',
          },
        ],
      },
      {
        key: 'contracts',
        title: 'Contracts and labor rates',
        where: 'Sidebar › Contracts.',
        purpose: 'Rate cards: hourly, overtime, double-time, trip charge and markup on parts, for a client or a vendor, an entity, some sites and trades, between two dates.',
        value: 'Quotes and invoices price from the contract in force, and the most specific card wins.',
        users: ['Admin', 'Account Manager', 'Team Lead', 'Accounts Payable'],
        features: [
          {
            name: 'Rate cards',
            what: 'New contract: Name, Whose terms (client or vendor), Kind, Starts, rates (Add rate), optional Bill automatically on completion; lanes In force · All.',
            value: 'One place for every negotiated rate.',
            permissions: ['contracts view / create / edit / delete'],
            audit: ['contract_created', 'contract_updated', 'contract_deleted'],
            since: '0046 / 0053',
          },
          {
            name: 'Time and materials invoicing',
            what: 'A work order with no quote and a T&M contract bills hours on site (checked-out visits, to the quarter hour) at the standard rate plus the trip charge per visit.',
            value: 'Small jobs are billed from the visit log without a quote.',
          },
        ],
      },
      {
        key: 'purchasing',
        title: 'Purchasing, tax rates, document templates and budgets',
        where: 'Sidebar › Purchasing: Requests, Requests for quotation, Purchase orders, Budgets.',
        purpose: 'Purchase request → request for quotation → purchase order, with budgets and AFEs that warn, tax rates to pick from, and the templates that dress the printed quote, invoice and order.',
        value: 'Parts and materials are bought with a paper trail and compared quotes, and never double-counted against the work order\'s Cost.',
        users: ['Accounts Payable', 'Team Lead', 'Admin'],
        features: [
          {
            name: 'Purchase requests',
            what: 'New request (what is being bought, items, optional work order) → Save as draft / Submit for approval → Approve or Reject with a note → Ask vendors for quotes or Raise a purchase order.',
            value: 'Spend is approved before it happens.',
            permissions: ['purchasing/requests create / approve'],
          },
          {
            name: 'Requests for quotation',
            what: 'Items and vendors, Mark as sent to vendors (recorded, nothing emailed), Record quote per vendor, compare, Award drafts the purchase order.',
            value: 'The cheapest compliant quote is chosen on the record.',
            permissions: ['purchasing/rfqs create / edit'],
          },
          {
            name: 'Purchase orders',
            what: 'PO-n: draft → issued (needs approve) → partly / fully received (Save what arrived) → closed; Print / PDF with the template.',
            value: 'Receiving is tracked line by line.',
            rules: ['A purchase order never writes the work order\'s Cost; budgets count Cost plus orders not tied to a work order.'],
            permissions: ['purchasing/orders create / edit / approve'],
          },
          {
            name: 'Budgets and AFEs',
            what: 'Cost centers and AFEs with an authorized amount; going over warns on the order, never blocks.',
            value: 'Overspend is visible at the order, not at month end.',
            permissions: ['purchasing/budgets edit'],
          },
          {
            name: 'Tax rates and document templates',
            what: 'Admin › Settings lists tax rates (name, %, state, default) and document templates (company name, letterhead, terms, footer) per kind: quote, invoice, purchase order.',
            value: 'Printed documents carry the right letterhead and terms per entity without hand editing.',
            permissions: ['admin/settings edit'],
            since: '0067',
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'field',
    title: 'Vendors, technicians and dispatch',
    intro:
      'Technicians are external subcontractors, so finding the right one near the job is a core module. This part is The One\'s own copy of what VR - CRM and Tech Locator do, plus the suggestion and dispatch logic built on top; those two apps keep running untouched until the data moves.',
    modules: [
      {
        key: 'vendors',
        title: 'Vendor and technician records',
        where: 'Sidebar › Vendors: List, Board, Tasks, Alerts, Data quality, Performance, Coverage map.',
        purpose: 'One table for both kinds: vendors the VR team recruited and technicians dispatchers have worked with, with the profile, documents, compliance, notes and history.',
        value: 'The vendor network is a shared asset instead of spreadsheets and memory; compliance is derived from documents, not ticked by hand; nobody loses a good technician when a dispatcher leaves.',
        users: ['VR Officer', 'Team Lead', 'Assistant TL', 'Account Manager', 'Admin'],
        features: [
          {
            name: 'The record',
            what: 'Name, DBA, legal name, kind (VR vendor / technician), primary and secondary trades, city / state / ZIP (placed on the map from our own geo tables, no outside geocoder), phones, emails, rates (regular, after-hours, weekend / emergency, trip charge, diagnostic fee, minimum), availability (emergency same day, after hours, weekends, holiday emergency), coverage (radius, whole state, nationwide, other states), payment terms, owner, status, brand source, subcontractor flag, the long tail in profile sections.',
            value: 'Everything a dispatcher asks on the phone is already on the card.',
            rules: ['A new vendor whose name or phone matches one on file is refused until override_duplicate; technicians are duplicates by phone only.', 'Required fields (configurable) refuse a VR vendor record unless saved flagged, which opens a review task.'],
            permissions: ['vendors view / create / edit / delete', 'vendors/scope'],
            audit: ['vendor_created', 'vendor_updated', 'vendor_deleted'],
            since: '0057',
          },
          {
            name: 'Compliance, documents and insurance dates',
            what: 'Documents (W-9, MSA, COI, other) uploaded to private storage; a COI opens a compliance review with a six-point checklist and verdict per company; insurance dates banded by expiry; compliance_status is derived (APPROVED when W-9, MSA and an approved COI are in; EXPIRED when an insurance date passed), and a New / Interested / Ready vendor turns Active when approved.',
            value: 'Compliance is a fact computed from paper, and expiry is noticed before the job.',
            permissions: ['vendors/documents create', 'vendors/review approve'],
            audit: ['vendor_expiry_added', 'vendor_expiry_removed'],
            since: '0058',
          },
          {
            name: 'Notes, blacklist, calls and emails',
            what: 'Notes on the record; Mark blacklisted with a required reason (visible to all, sorts last, never suggested, cannot be assigned); Clear blacklist; a log of calls and emails whose outcome may set the status.',
            value: 'Bad experiences are shared with the whole team, not just remembered.',
            permissions: ['vendors/blacklist create / edit'],
            audit: ['vendor_note_added', 'vendor_blacklisted', 'vendor_blacklist_cleared'],
          },
          {
            name: 'Tasks, alerts and data quality',
            what: 'Tasks: review types (duplicate, missing info, compliance) in one review queue, compliance fixes and manual tasks assigned to a person, daily targets for nationwide / statewide vendors added. Alerts: every insurance date that counts, banded. Data quality: duplicates by name or phone, missing required fields, not on the map.',
            value: 'The VR team\'s day is a queue, and the database cleans itself.',
          },
          {
            name: 'List tools',
            what: 'Advanced filters (AND / OR rules), column picker, saved lists (private or everyone), bulk edit of one field, Export CSV, Look up a list (paste names / phones / emails), the Board by status (drag or Move to…), Performance (jobs, SLA met / missed, recalls, offers taken, billed).',
            value: 'The CRM\'s list features without leaving The One.',
            permissions: ['vendors/lists', 'vendors/export view', 'vendors/import create'],
            since: '0059',
          },
          {
            name: 'Import',
            what: 'CSV parsed in the browser, columns auto-matched, Check the file analyses without writing, rows go up in chunks; duplicates follow the picked strategy (skip, skip and report, add flagged, fill in the record on file); an unreadable cell is reported and left empty.',
            value: 'VR - CRM and Tech Locator data (exported read-only by a script) comes in through the same wizard.',
            deferred: ['The actual data transfer from the two apps has not been run.'],
          },
          {
            name: 'Skills, inductions, consumables, vendor portal',
            what: 'Skills and inductions on the record; a consumables catalogue used on work orders; a vendor portal link per vendor (token shown once, stored hashed) where a vendor sees its jobs in a fixed shape with no money or internal notes and fills an onboarding form that waits for acceptance.',
            value: 'Vendors self-serve what they need without an account and without seeing the inside.',
            permissions: ['vendors/portal'],
            since: '0066',
          },
        ],
      },
      {
        key: 'techmap',
        title: 'The technician map, suggested vendors and the dispatch cascade',
        where: 'A work order › People tab › Technicians card (Find a technician, Suggested vendors); Admin › Vendors & map.',
        purpose: 'Find the right person near the job: the map around the site, the top few suggestions by rule and by fit, and an optional cascade that offers the job to preferred vendors in turn.',
        value: 'The choice of vendor is made from distance, coverage, history and compliance in seconds, with the hand-picked preferences first; a dispatcher never sees more of the database than one job needs.',
        users: ['OM (dispatcher)', 'Senior OM', 'Ops Coordinator', 'Team Lead'],
        features: [
          {
            name: 'The map',
            what: 'Opens from a work order only, centred on it, radius from Admin (100 miles); VR vendors and technicians the role may see (all or only theirs; statewide and nationwide; subcontractors), filters Trade, Availability, Show; preferred vendors marked and sorted first; a vendor with no placed city pinned at the work order; clusters, pin colour by trade; each open logged and a daily alert in Admin.',
            value: 'Tech Locator inside the work order, with the dispatcher\'s own book on the same map.',
            controls: [
              { label: 'Find a technician', does: 'Opens the map for this work order.' },
              { label: 'Hire for <WO#>', does: 'Records the technician on the work order (compliance warns, never blocks).' },
              { label: 'Call', does: 'Through the Quo dialog.' },
            ],
            permissions: ['vendor_map view / create and its children'],
            audit: ['tech_hired', 'tech_released', 'tech_added'],
            since: '0056 / 0057',
          },
          {
            name: 'Suggested vendors',
            what: 'The top few for the work order: the hand-picked preferred rules first (client, trade, state, city; most specific wins, then rank), then an automatic fill of vendors that pass the hard filters (trade, coverage of the location, emergency availability when asked) sorted by a fixed order of tie-breakers (client history, distance, compliance, jobs, rate). Blacklisted vendors never appear. Settings in Admin › Vendors & map › Suggested vendors.',
            value: 'The best five are on the card before the dispatcher searches.',
            since: '0069',
          },
          {
            name: 'Preferred vendors',
            what: 'Rules per client and / or trade, optional state and city, ranked; edited in Admin › Vendors & map.',
            value: 'Client-mandated vendors and house favourites come first automatically.',
          },
          {
            name: 'Dispatch cascade',
            what: 'Off by default. When on, a work order is offered to the preferred vendors of its client / trade / state in turn (one live offer, a clock per offer); a decline or a lapsed clock moves it on; accepting sets the responsible vendor. Admin can let the automatic picks follow the hand-picked ones.',
            value: 'Routine jobs find their vendor without a dispatcher on the phone.',
            permissions: ['vendors/dispatch'],
            since: '0066',
          },
          {
            name: 'Who sees which technicians',
            what: 'Set in Admin › Roles under Technician map: VR vendors, all technicians or only theirs, statewide, nationwide, subcontractors, add a technician, hire.',
            value: 'The baseline dispatcher sees their own list plus the vendor network for one search; widening is a tick.',
          },
          {
            name: 'Vendors as a dashboard source and the Vendors board',
            what: 'Cards can count or total vendors (following the viewer\'s vendor scope); a prebuilt Vendors board ships.',
            value: 'Recruiting coverage is measured, not felt.',
          },
          {
            name: 'In-app notices',
            what: 'A task given to you, a review opened, a decision on your task, a vendor handed to you, your vendor blacklisted, an insurance date within 30 / 14 days or expired: one notice per person, in the bell under "For you".',
            value: 'Nobody has to poll the Tasks view.',
            since: '0059',
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'portfolio',
    title: 'Portfolio: sites, assets and clients',
    intro:
      'The places work is done at, the equipment standing in them, and the client accounts. Sites and assets came from the Ecotrak sync and were invisible until batch 2 made them records.',
    modules: [
      {
        key: 'sites',
        title: 'Sites, buildings, floors and spaces',
        where: 'Sidebar › Sites; the Site record block on a work order.',
        purpose: 'A site is a record: type, ownership, manager, billing entity, contact, hours, access notes, geofence radius, a pin, and a tree of buildings, floors and spaces.',
        value: 'Address, access and hours are known before the technician leaves; work orders at the same site are found together; the geofence check reads the pin.',
        features: [
          {
            name: 'Site records',
            what: 'List with map and counts, Add site, Edit, buildings and spaces (nested by rule), Add asset, site events (closure, restricted access, remodel) shown as a chip on the site\'s work orders while running, the space viewer (assets and open work orders of a place).',
            value: 'One record per place from three sources (Ecotrak, manual, made from work orders), with synced columns locked on Ecotrak sites.',
            rules: ['Delete is soft; removing a location cascades to what is inside and leaves the assets at the site.'],
            permissions: ['sites view / create / edit / delete'],
            audit: ['site_created', 'site_updated', 'site_deleted'],
            since: '0060',
          },
          {
            name: 'Sites from work orders',
            what: 'Preview and run: a place is client + the first of store number, street, store name, city; idempotent.',
            value: 'The history becomes a site list without typing.',
          },
          {
            name: 'A person restricted to sites',
            what: 'Admin › Sites & assets lists the sites a person may see; nobody listed = no restriction; the scope predicate ANDs it onto every list and route.',
            value: 'A store manager\'s account sees its own stores and nothing else.',
            since: '0062',
          },
        ],
      },
      {
        key: 'assets',
        title: 'Assets and asset requests',
        where: 'Sidebar › Assets; Assets › Requests.',
        purpose: 'Equipment with category, manufacturer, serial, tag, install date, warranty state, status, parent, the place it stands and a condition log with the work order each reading came from.',
        value: 'Repeat failures on the same unit are visible, warranty is checked before paying for a repair, and changes to the register go through a request a manager approves.',
        features: [
          {
            name: 'Asset records',
            what: 'Add asset (site, name, category), Edit, Record a reading; warranty state none / expired / expiring within 60 days / active.',
            value: 'The asset register the client never had.',
            permissions: ['assets view / create / edit / delete'],
            since: '0060',
          },
          {
            name: 'Asset management requests',
            what: 'Add, replace, retire or move, with a reason; approving makes the change as the approver (validated and logged); rejecting needs a reason; notices to both sides.',
            value: 'People who may not edit the register can still report what they see.',
            permissions: ['assets/requests create / approve'],
            since: '0062',
          },
        ],
      },
      {
        key: 'clients',
        title: 'Clients',
        where: 'Sidebar › Clients; the Clients column in Admin › Users.',
        purpose: 'The client account: contact, billing, account manager, payment terms, portal; adopted automatically from any new client name on a work order.',
        value: 'A client in use cannot be renamed into a fork or deleted; the sales team\'s scope and the SharePoint folders key off this record.',
        features: [
          {
            name: 'Client records',
            what: 'Add client (Name, Code, Account manager, Payment terms), Edit, make inactive; a client with work orders or sites cannot be removed.',
            value: 'One spelling per client across the whole system.',
            permissions: ['clients view / create / edit / delete'],
            since: '0062',
          },
          {
            name: 'Clients assigned to a person',
            what: 'Admin › Users › Clients: chips plus Assign / Edit opening a tickable list; widens "Only theirs" to those clients\' work orders.',
            value: 'The Sales board counts exactly the salesperson\'s clients.',
            since: '0072',
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'maintenance',
    title: 'Planned and preventive maintenance',
    intro: 'Recurring work raised by the calendar, and the job plans, services, time and permits that support it.',
    modules: [
      {
        key: 'planned',
        title: 'Planned Maintenance',
        where: 'Sidebar › Planned Maintenance.',
        purpose: 'A schedule is one job at one place on a rhythm (every n days / weeks / months / years from a first date, with lead days); it raises its own work orders, already assigned, as PM Sched.',
        value: 'Preventive contracts are honoured without a reminder spreadsheet; each occurrence is claimed once so nothing is raised twice.',
        features: [
          {
            name: 'Schedules',
            what: 'New schedule: What is the job?, How often, First due on, client, store, trade, NTE, assignee, optional job plan; Raise now, Skip, Edit, Delete (its work orders stay). Runs on opening the list, after create / update, on Raise now and daily from the Vercel cron.',
            value: 'The calendar does the dispatching.',
            permissions: ['planned_maintenance view / create / edit / delete'],
            audit: ['pm_schedule_created', 'pm_schedule_updated', 'pm_schedule_deleted', 'pm_schedule_skipped'],
            since: '0051',
          },
        ],
      },
      {
        key: 'maint',
        title: 'Maintenance: assignment, job plans, services, time, permits',
        where: 'Sidebar › Maintenance.',
        purpose: 'The Facilio maintenance set: bulk assignment, reusable job plans, a services catalogue, technician time and permits to work.',
        value: 'Standard jobs are done the same way every time; time and permits are on the record instead of in a notebook.',
        features: [
          { name: 'Assignment Manager', what: 'Unassigned, Everything open or a person; tick work orders; Assign to…; assigns through the ordinary field path so audit, gates and automations see it.', value: 'Rebalance a team in one screen.', permissions: ['maintenance/assignment edit'] },
          { name: 'Job plans and services', what: 'A plan is steps and services; applied once per work order it fills the checklist and the services; a planned-maintenance schedule may name one.', value: 'The checklist is written once.', permissions: ['maintenance/job_plans', 'maintenance/services'] },
          { name: 'Time tracker', what: 'Time entries per technician on the Timelog tab (a running timer when no end), listed across work orders.', value: 'Labour is measured.', permissions: ['maintenance/time'] },
          { name: 'Work permits', what: 'PTW-n: draft → requested → approved → closed, or rejected; active / expired read from the dates; once requested only the precaution ticks move.', value: 'Hazardous work has a signed permit on the record.', permissions: ['maintenance/permits create / approve'] },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'communication',
    title: 'Communication, files and documents',
    intro: 'The conversation on a work order, the calls around it, the files it collects, and what goes out to clients and into SharePoint.',
    modules: [
      {
        key: 'messages',
        title: 'Messages and calls',
        where: 'The Messages tab on every work order.',
        purpose: 'Internal and client-visible messages on the work order, an outbox per client system, the Quo technician thread, and the call log with transcripts.',
        value: 'The internal versus client-facing boundary is a switch on every message; a sent message cannot be rewritten; calls are on the record with what was said.',
        features: [
          {
            name: 'Internal and client-visible messages',
            what: 'Choose Internal or Client-visible, type, Post internally or Send to client. A client-visible message on a work order whose Client Portal Type names a CMMS queues a delivery per system (pending until an adapter sends it). Edits allowed only by the author and only until sent; a client\'s own note (synced in) is never editable.',
            value: 'Curated updates to the client, full candour inside.',
            permissions: ['work_orders/comments create / edit', 'work_orders/comments/client create (Message the client)'],
            audit: ['comment_added', 'message_edited', 'client_message_sent', 'client_message_failed', 'client_message_received'],
            since: '0052',
            deferred: ['No outbox adapter is registered yet (Ecotrak waits for go-live; Corrigo and ServiceChannel are not built); email as a target is deferred.'],
          },
          {
            name: 'Calls through Quo',
            what: 'Call in the header: Who, Just call or Call and draft a quote, Call via Quo; the Quo desktop app dials; Quo\'s webhooks return the call, its transcript and its summary to the Calls card; a transcript can be pasted by hand.',
            value: 'Every call about a job is attached to the job.',
            permissions: ['work_orders/calls view / create'],
            audit: ['call_placed', 'call_completed', 'call_transcribed'],
            since: '0054',
          },
        ],
      },
      {
        key: 'files',
        title: 'Photos, files and approval',
        where: 'The message composer (Add photo, Attach file); Overview › Photos.',
        purpose: 'Uploads to private storage, read back only through the work order so a photo is exactly as visible as its work order; every upload reviewed before anyone else sees it.',
        value: 'Before and after photos are classified and proven before the job is Done; a copied link is useless outside.',
        features: [
          {
            name: 'Attachments',
            what: 'Photos shrink in the browser before upload (4 MB cap); allowed types only; grouped by kind once approved; Remove.',
            value: 'Phone photos upload from the field without failing.',
            permissions: ['work_orders/attachments create / delete'],
            audit: ['attachment_added', 'attachment_removed'],
            since: '0043',
          },
          {
            name: 'Approval',
            what: 'Waiting for approval list: What is it? (Before photo, After photo, Sign-off, Other), Approve / Decline per file, reversible; pending files visible only to reviewers and the uploader.',
            value: 'Rules 1.3.1 to 1.3.4.',
            permissions: ['work_orders/attachments approve'],
            audit: ['attachment_approved', 'attachment_declined'],
            since: '0061',
          },
        ],
      },
      {
        key: 'pdf',
        title: 'Save as PDF and SharePoint folders',
        where: 'Save as PDF on the record bar; the SharePoint chip; Admin › Settings › Work-order PDFs and SharePoint folders.',
        purpose: 'A branded PDF of the work order or of the client\'s request, and the SharePoint folder tree the team files every work order in, created by the app.',
        value: 'The document the client or the technician needs is one click, and the SharePoint filing that used to be a manual chore happens on creation.',
        features: [
          {
            name: 'Work order and Request PDFs',
            what: 'Drawn on the server in the billing entity\'s branding; which fields, in what order, the title, whether empty fields are skipped and a note are one layout per kind in Admin › Settings; never widens what the person may see.',
            value: 'Printable, consistent, permission-safe.',
            permissions: ['work_orders/pdf view', 'admin/settings edit for the layouts'],
            audit: ['work_order_pdf_saved', 'wo_pdf_layout_updated'],
            since: '0073',
          },
          {
            name: 'SharePoint folders',
            what: 'Three switches: a folder per new client (under its entity), a folder per new work order (Documents / General / Work Orders - {year} / {year} - {Comp} / {Client} / WO#{number}, {City}, {ST}), approved files copied into it. Each switch files only records created after it was turned on; failures retry hourly; nothing is ever deleted or renamed in SharePoint. The chip on the work order and on the client shows the folder and can make it now.',
            value: 'The filing tree is kept by the system, with the client spelling from the Clients list.',
            permissions: ['admin/settings edit', 'work_orders/attachments create', 'clients edit'],
            audit: ['sharepoint_settings_updated', 'sharepoint_folder_created', 'sharepoint_file_copied'],
            since: '0071',
            deferred: ['Needs the SharePoint credentials and site URL on the server.'],
          },
        ],
      },
      {
        key: 'client-updates',
        title: 'Client Updates',
        where: 'Sidebar › Client Updates; /share/client-updates/<token> for the client.',
        purpose: 'A tracker per client: a saved question (filter, columns, charts, sections) shown live, shared by read-only link, by email or on a schedule, with a client-note column typed straight into the row.',
        value: 'Replaces the per-client tracking spreadsheets; the client sees only shared columns; every send is logged and counts as a chase.',
        features: [
          {
            name: 'Trackers',
            what: 'New tracker: Client, Tracker name, columns (Client sees it / Team only), charts (bar / donut), sections, sort, the note column; headline tiles and clickable charts that drill; Client view preview.',
            value: 'The weekly client call runs from a live page.',
            permissions: ['client_updates view / create / edit'],
            since: '0055',
          },
          {
            name: 'Sharing',
            what: 'Client link (switch on, Copy link, Make a new link, optional expiry), Email (To, Subject, Send a test to me, Send now, optional CSV), Schedule (daily / weekdays / weekly / monthly at a Chicago time) sent by the hourly cron.',
            value: 'The client is updated without anyone remembering to.',
            permissions: ['client_updates/share edit'],
            audit: ['client_update_sent', 'client_update_test_sent', 'client_update_send_failed', 'client_update_link_*'],
            deferred: ['Outgoing email needs a mail provider configured (Graph or Resend).'],
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'insight',
    title: 'Dashboards, Pulse and the assistant',
    intro: 'What the records say, drawn for the person looking: boards per role, the obligations watchdog, and an assistant that answers from the data the asker may see.',
    modules: [
      {
        key: 'dashboards',
        title: 'Dashboards',
        where: 'Sidebar › Dashboard.',
        purpose: 'Needs Attention and Main Dashboard are built in; every other board is a record of cards anyone with the create right can build, share and tab.',
        value: 'Management questions are answered by a card, not an export; the same board counts each viewer\'s own book, so sharing never leaks a row.',
        features: [
          {
            name: 'Building a board',
            what: 'New dashboard, then Add card: name, how it looks (A single number, bar, donut, table, line, gauge, live, narrative, image, link), what it measures (How many work orders, a total, an average, or Time between two moments), which records (Every work order, Open work only, Finished work only, or filters), what to cut it by, a target, a refresh. Cards sit in tabs and groups.',
            value: 'The dashboard the manager wants exists in ten minutes.',
            permissions: ['dashboard create'],
            since: '0042 / 0049',
          },
          {
            name: 'Sources beyond work orders',
            what: 'Invoices, payments, vendor bills, vendors, sites and assets as card sources with their own fields, status and overdue narrowing.',
            value: 'The money and the network are measured on the same page as the work.',
          },
          {
            name: 'Period and filter bar',
            what: 'All time / month / quarter / year / last 30 with stepping, ANDed into every card; a filter bar (client, billing entity, trade, store, dispatcher).',
            value: 'One control re-asks every card.',
            since: '0044',
          },
          {
            name: 'Time between two moments',
            what: 'A duration measure between two legs (the first time a field changed, or a date field), average or median, cut by a field or drawn along when the span ended; records with no complete span drop out.',
            value: 'Accepted → assigned, assigned → technician found, requested → approved are measured from the audit trail.',
          },
          {
            name: 'Sharing',
            what: 'Share… to everyone, to roles (written as role grants) or to people one by one (a per-person override); edit stays with the owner or a super admin; drill-through opens the list, or plain text when the list is closed to the viewer.',
            value: 'A board reaches exactly who should see it.',
            since: '0050',
          },
          {
            name: 'Shipped boards',
            what: 'Dispatch Center, Approvals & bottlenecks, Money, Service levels, Accounting, Payments, Vendors, Sites & assets, Maintenance Supervisor, Vendor Performance, Technician, Store Manager, Unified Ops, Sales; inserted on first read and never overwritten once edited.',
            value: 'Every role has a starting board.',
          },
          {
            name: 'Needs Attention and Main Dashboard',
            what: 'The built-in pages: attention cards (each the list query its click opens) and the per-user KPI cards.',
            value: 'The at-a-glance page for the morning.',
          },
        ],
      },
      {
        key: 'pulse',
        title: 'Pulse (obligations)',
        where: 'Sidebar › Pulse; the bell.',
        purpose: 'Who owes what, on which work order, by when: seven configurable rules (emergency acknowledgement 2 h, quote owed 2 business days, schedule owed 2 business hours after approval, approval follow-up 5 business days, quote review 4 business hours, payment processing 2 business days, SLA blown).',
        value: 'Deadlines chase people instead of people chasing deadlines; the bottleneck of quotes waiting at the client is measured.',
        features: [
          {
            name: 'Columns and snooze',
            what: 'Needs me now · Due soon · Watching; Snooze with a duration and a reason (a critical one needs an assistant team lead or above); each clock is cleared by the event it waits for (quote exists, client update sent, work order closed).',
            value: 'The owner, the deadline and the way out are on every card.',
            since: '0004',
          },
        ],
      },
      {
        key: 'assistant',
        title: 'The assistant',
        where: 'The sparkle in the top bar.',
        purpose: 'Ask anything about the data and how to use the app; Claude answers from look-ups made at that moment through the app\'s own routes with the asker\'s session, so permissions, scope, site restriction and field redaction apply.',
        value: 'New staff ask the app instead of a colleague; management asks a question instead of building a report; nothing is ever changed by it.',
        features: [
          {
            name: 'Questions on the data',
            what: 'Search work orders (the saved-view filter set, group by, count), read one work order (any part), look up a named resource (quotes, payments, approvals, invoices, vendors, sites, assets, admin lists); replies carry links inside the app; a thumb on every answer.',
            value: 'Read-only by construction.',
            permissions: ['assistant view'],
            audit: ['assistant_asked'],
            since: '0068',
          },
          {
            name: 'How-to guide',
            what: 'A hand-written guide to every screen (labels as on screen, the permission each step needs) with "what this person may do" resolved for the asker; anything outside The One is declined.',
            value: 'The SOP, answered in context.',
          },
          {
            name: 'Teaching',
            what: 'Taught notes read before every answer; Marked answers for a reviewer to teach from.',
            value: 'It gets better from the team\'s corrections.',
            permissions: ['assistant edit'],
            deferred: ['Needs ANTHROPIC_API_KEY on the server; 100 questions per person per day.'],
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'automation',
    title: 'Automations',
    intro: 'Rules that watch work orders and act: set a field, raise an approval task, after an optional delay.',
    modules: [
      {
        key: 'automations',
        title: 'Automations',
        where: 'Admin › Automations; Enroll in the bulk bar.',
        purpose: 'When a work order is created, a field changes (to a value, past a number, or past another field) or people enrol it by hand: if conditions hold (AND / OR), then set fields or raise an approval task, optionally after a wait.',
        value: 'Business rules such as the NTE override live as data the team can read and pause; new rules need no deploy.',
        features: [
          {
            name: 'Builder',
            what: 'New automation: Name; Trigger (A work order is created, A field changes with field / value / other field, Manually enrolled); Applies to (Work orders); Conditions (+ Add a condition, AND / OR with brackets); Actions (Set a field, Raise an approval task with type and role); Review and turn on. Each rule is a card with a switch, its run log (When, Work order, Result), edit and delete.',
            value: 'Readable by a manager, not only a developer.',
            rules: ['Computed and visit-owned fields cannot be set by an action.', 'A rule\'s own change does not trigger itself in a loop.', 'Timers are database rows, so they survive restarts; conditions are checked after the wait.'],
            permissions: ['admin/automations view / edit'],
            audit: ['automation_created', 'automation_updated', 'automation_deleted'],
            since: '0017 / 0018',
          },
          {
            name: 'Seeded rules',
            what: 'Cost changed to more than NTE → raise nte_override (on); priority changed to urgent → Emergency = true (paused until the portals drive priority).',
            value: 'Rule 1.5.2 ships as a rule the team can see.',
          },
        ],
      },
    ],
  },

  // ═════════════════════════════════════════════════════════════════════════
  {
    key: 'admin',
    title: 'Admin console',
    intro: 'Users, Roles, Settings, Automations, Custom fields, Themes, Audit log, Trash, Vendors & map, Sites & assets, Integrations and Documentation. Each is its own permission row, read from the real signed-in user.',
    modules: [
      {
        key: 'admin-users',
        title: 'Admin › Users and Roles',
        where: 'Admin › Users; Admin › Roles.',
        purpose: 'Who is on file, with what role, super-admin flag, status, clients and adjustments; and what each role may do.',
        value: 'Access is granted and revoked in one screen, and every change is logged.',
        features: [
          {
            name: 'Users',
            what: 'Invite a user (Work email, Full name, Role, Super admin); Role dropdown per row; Super admin switch; Disable / Re-enable; Adjust (super admins); Clients column (Assign / Edit); Last sign-in.',
            value: 'The invitation is the row.',
            permissions: ['admin/users view / edit'],
            audit: ['user_invited', 'user_role_changed', 'user_disabled', 'user_reenabled', 'user_super_admin_set', 'user_clients_changed', 'user_permissions_set'],
          },
          {
            name: 'Roles',
            what: 'New role (Name, Start from a copy); the permission tree with search; Save role; Delete (not built-in roles, not roles with users).',
            value: 'See Roles, permissions and data visibility.',
            permissions: ['admin/roles view / edit'],
          },
        ],
      },
      {
        key: 'admin-fields',
        title: 'Admin › Custom fields and statuses',
        where: 'Admin › Custom fields.',
        purpose: 'The field catalogue (type, options, order, the Add work order column), the statuses in their phases, and the check-in method by FM table.',
        value: 'The data model is configuration.',
        features: [
          {
            name: 'Fields',
            what: 'New field (Name, Type, Dropdown values); rename with the pencil; change type; drag to reorder; edit options (Save values); Add work order column (Not on the form / On the form / Required). Fields are never deleted.',
            value: 'A new field is live everywhere in a minute.',
            permissions: ['admin/fields edit'],
            audit: ['field_def_created', 'field_def_updated'],
          },
          {
            name: 'Statuses and phases',
            what: 'Add a status to a phase with a colour; rename; delete (only when empty); New phase (becomes a list tab); only an empty, non-built-in phase can be deleted.',
            value: 'The pipeline is edited where the fields are.',
          },
          {
            name: 'Check-in method by FM',
            what: 'FM company, Method, Detail; Add; delete.',
            value: 'Pre-fills visits.',
          },
        ],
      },
      {
        key: 'admin-settings',
        title: 'Admin › Settings',
        where: 'Admin › Settings.',
        purpose: 'How the instance is configured (authentication, server, database, contents, read-only) plus the editable tables: holidays, sub-categories, Add work order layouts, fault and action codes, tax rates, document templates, approval tiers, SharePoint folders, Work-order PDFs.',
        value: 'Every operating table the business owns is editable by the business.',
        features: [
          { name: 'Holidays', what: 'Day and Name; the quote clock skips them.', value: 'Rule 2.3.2 as a table.', permissions: ['admin/settings edit'] },
          { name: 'Sub-categories', what: 'Per trade; Rename, Switch off / on.', value: 'Suggestions on the form.' },
          { name: 'Add work order layouts', what: 'Per client and / or trade: Hidden / Optional / Required per field; the most specific wins; Client and Trade can never be hidden.', value: 'Client-specific intake without code.' },
          { name: 'Fault and action codes', what: 'Fault or Action, the code and What it means; switched off, not deleted.', value: 'Completion is coded for reporting.' },
          { name: 'Tax rates and document templates', what: 'Tax rates (name, %, state, default) the quote builder and purchase orders pick from; document templates (company name, letterhead, terms, footer) per printed kind. Detailed under Purchasing.', value: 'The printed paper carries the right letterhead and the right tax without hand editing.' },
          { name: 'Approval tiers by amount', what: 'Add a band: From $, Up to $, Roles; a band with no roles restricts nobody.', value: 'Rule 6.2.3.' },
          { name: 'SharePoint folders and Work-order PDFs', what: 'The three SharePoint switches with the site URL, library and path templates, and the per-kind field lists of the work-order PDFs. Detailed under Save as PDF and SharePoint folders.', value: 'Filing and printing are configured by the business, not deployed.' },
        ],
      },
      {
        key: 'admin-other',
        title: 'Admin › Themes, Audit log, Trash, Vendors & map, Sites & assets',
        where: 'Admin.',
        purpose: 'The remaining console sections.',
        value: 'Each is one screen with one job.',
        features: [
          { name: 'Themes', what: 'Blackout or Daylight Dispatch, for this browser.', value: 'Preview both.', permissions: ['admin/themes view'] },
          { name: 'Audit log', what: 'Every change in the system with filters, paging and CSV export; nobody can edit or delete a row. Detailed under Audit and traceability.', value: 'Evidence on demand.', permissions: ['admin/audit view'] },
          { name: 'Trash', what: 'Deleted work orders wait here; Restore; nothing is removed permanently.', value: 'Rule 8.1.1.', permissions: ['admin/trash view / edit'] },
          { name: 'Vendors & map', what: 'Search radius, daily alert, COI warning; preferred vendors; required fields; dispatch offers; vendor invoicing rules; suggested vendors; the lists (statuses, brand sources, trades, skills, consumables); map use log.', value: 'The vendor module\'s dials.', permissions: ['admin/vendors edit'] },
          { name: 'Sites & assets', what: 'Site types and asset categories (add, rename, switch off); the site-access card per person.', value: 'The portfolio\'s lists.', permissions: ['admin/portfolio edit'] },
        ],
      },
      {
        key: 'integrations',
        title: 'Admin › Integrations',
        where: 'Admin › Integrations.',
        purpose: 'Every connector on one page with the tool\'s mark, what it does, whether it is set up on the server and one on / off switch: Ecotrak, ServiceChannel, Corrigo, Quo, outgoing email, the escalation mailbox webhook, Claude, SharePoint, file storage, Microsoft sign-in (locked).',
        value: 'An integration misbehaving is switched off in one click, every button that uses it explains itself, and the keys stay on the server so switching back on needs nothing else.',
        features: [
          {
            name: 'Switches',
            what: 'Off makes each connector\'s code path refuse with "switched off in Admin › Integrations" (409); no row = on; each flip is logged with who and when.',
            value: 'Operational control without a developer.',
            permissions: ['admin/integrations view / edit'],
            audit: ['integration_turned_on', 'integration_turned_off'],
            since: '0074',
          },
          {
            name: 'Ecotrak (inbound only)',
            what: 'The sync reads work orders, sites and assets from Ecotrak and stamps Client Portal Type, Ecotrak ID and Ecotrak Status; manual trigger; nothing is written back until go-live.',
            value: 'Intake from the biggest client portal is automatic; the write-back rules are ready.',
            brd: ['2.6.1', '2.6.3'],
          },
          {
            name: 'Quo',
            what: 'Calls, transcripts and summaries by webhook; texts (sign-off sheets) through the API; the technician thread.',
            value: 'The phone is on the record.',
          },
          {
            name: 'Claude',
            what: 'The AI quote draft and the assistant.',
            value: 'See those modules.',
          },
          {
            name: 'Outgoing email, Escalation emails, SharePoint, File storage, Microsoft sign-in',
            what: 'Outgoing email for client updates (Graph or Resend); Escalation emails (the mailbox webhook that flags a work order Escalated); SharePoint folders through Microsoft Graph; File storage (private Vercel Blob for photos, documents and sign-off sheets); Microsoft sign-in (always on, locked).',
            value: 'Each is one switch and one credential set.',
          },
        ],
      },
      {
        key: 'docs',
        title: 'Admin › Documentation',
        where: 'Admin › Documentation: BRD, SOP, Lifecycle.',
        purpose: 'This document, the SOP and the lifecycle chart, drawn from a registry in the code and from the live instance (statuses, fields, roles, automations, integrations, migrations), with print and download.',
        value: 'The documentation describes the system as it is today, because the live sections are read when the page opens and the test suite fails when a screen exists that the registry forgets.',
        features: [
          {
            name: 'Three documents',
            what: 'BRD (what and why, with the live appendix), SOP (how, step by step, in the Tech Locator SOP format) and Lifecycle (the work-order flow with gates, side processes, live counts and Ecotrak pushes). Print / Save as PDF, Download Markdown, Download Word.',
            value: 'One link to send a reviewer, a new hire or an auditor.',
            permissions: ['admin/docs view'],
            since: '0075',
          },
        ],
      },
    ],
  },
];

/** Flat list of every module, in BRD order. */
export const BRD_MODULES = BRD_PARTS.flatMap((p) => p.modules);

// 0075 · BRD part: platform — sign-in, the shell, permissions, audit.
// Labels are the ones in the JSX; "needs" is what the API checks.

import type { DocPart } from '../types';

export const PLATFORM_PART: DocPart = {
  key: 'platform',
  title: 'Platform: sign-in, navigation, permissions and audit',
  intro:
    'Everything else stands on four things: who can sign in, how the application is laid out, what each role may see and do, and the fact that every change is recorded. These are built once and used by every module.',
  modules: [
    {
      key: 'signin',
      title: 'Sign-in, sessions and access',
      where: 'The sign-in page; Admin › Users for invitations; the Viewing as control in the top bar.',
      purpose: 'One Microsoft account per person, no passwords held by The One, and a session that can be revoked at once.',
      value: 'Nobody manages a second password; leavers are cut off the moment they are disabled; every action is attributable to a real person because every session belongs to a verified email.',
      users: ['Everyone'],
      features: [
        {
          name: 'Microsoft sign-in (Entra ID)',
          what: 'Sign in with Microsoft runs an OpenID Connect authorization-code flow with PKCE (S256) against the company tenant: a single-use state row that expires in ten minutes, a nonce check, the token signature verified against Microsoft\'s keys with issuer and audience pinned, a single-tenant check, prompt=select_account, scopes openid profile email offline_access. The person\'s Entra object id is bound on first sign-in and preferred over the email afterwards; the display name is re-synced from Entra at every sign-in and an invited row flips to active atomically. A failed sign-in returns to the sign-in page with the reason.',
          value: 'Single sign-on with the accounts IT already manages; no password resets, no shared logins.',
          controls: [
            { label: 'Sign in with Microsoft', does: 'Starts the Microsoft sign-in; returns to the page that was asked for.' },
            { label: 'Sign out', does: 'Ends the server-side session and Microsoft\'s session too (the logout URL is followed).' },
          ],
          rules: [
            'Sessions are rows in the database sent as the httpOnly cookie theone.sid (SameSite=Lax, Secure when the site is https), a 32-byte random id, 12 hours by default (SESSION_TTL_HOURS), last-seen stamped on every request; the join excludes disabled users, so disabling someone ends their sessions at once.',
            'A disabled account is refused with "This account has been disabled".',
            'The server refuses to boot with no authentication configured.',
          ],
          audit: ['signed_in', 'signed_out', 'user_auto_enrolled'],
          brd: ['5.1.1'],
          since: '0009',
        },
        {
          name: 'Who becomes what on first sign-in',
          what: 'A verified address on an allowed domain (AUTH_ALLOWED_DOMAINS, default byblosvista.com) with no row on file is created on the spot as the auto-enrol role (AUTH_AUTO_ENROL_ROLE, default OM Under Probation) and logged; the row is attributed to the person themselves, and a race between two first sign-ins is settled by the unique lower-cased email. Any other address is invite-only: creating the person in Admin › Users is the invitation.',
          value: 'New staff can start the same day without a ticket, at the lowest trust tier, and a super admin promotes them when ready; outsiders cannot get in by guessing.',
          rules: ['AUTH_ALLOWED_DOMAINS=none makes the whole site invite-only.', 'If the auto-enrol role does not exist the sign-in fails with the reason auto_enrol_role_missing instead of inventing a role.'],
          brd: ['5.1.1'],
        },
        {
          name: 'Super admins',
          what: 'Four named people (Elise, Jordan Brown, Jeff S, Jack) hold the super-admin flag, which passes every permission check and alone unlocks per-person permission adjustments.',
          value: 'A small, named group can always recover access and settle disputes; the flag is separate from the Admin role so administering the system is not confused with working a work order.',
          rules: ['Nobody can change their own super-admin flag or disable themselves; the last active super admin cannot be demoted or disabled.', 'A super admin is never scoped: site restrictions and client lists are cleared for them when the session loads.'],
          since: '0004',
        },
        {
          name: 'Viewing as (impersonation)',
          what: 'A super admin picks a person in the top bar\'s Viewing as select (Myself clears it) and sees exactly what they see; the admin console, the override editor and the integration switches still read the real signed-in user. Impersonation stops the moment the impersonator stops being a super admin.',
          value: 'Support questions ("why can I not see this work order?") are answered by looking, not guessing, without handing the impersonator the admin switches.',
          controls: [{ label: 'Viewing as … / Myself', does: 'Starts or ends acting as another person; the control says "Impersonation is recorded in the activity log".' }],
          permissions: ['super admin only'],
          audit: ['impersonation_started', 'impersonation_ended'],
        },
        {
          name: 'What needs no session',
          what: 'The health check, the sign-in routes, and by exact path the signed webhooks (email escalation, Quo, the planned-maintenance and client-updates cron runs); by pattern, 32-character tokens for the public client-updates page and its CSV, the sign-off sheet download and the vendor portal (its onboarding, offers, ETAs and notes). Everything else under /api answers 401 without a session.',
          value: 'The public surface is a short, reviewable list.',
        },
        {
          name: 'Development bypass and the public demo',
          what: 'With AUTH_DEV_BYPASS the same button signs in as DEV_DEFAULT_EMAIL with no password, and a footnote (Sign in as someone else / Hide other accounts) lists every non-disabled person; the bypass refuses to run in production unless DEMO_MODE is set. DEMO_MODE is the one sanctioned bypass in production: the mail provider is forced off, the Ecotrak status and sync routes answer 403 "Integrations are disabled in the public demo", and every webhook and cron answers 403.',
          value: 'The demo can be shown to anyone without a credential and without touching a client system.',
        },
        {
          name: 'Configuration (environment)',
          what: 'ENTRA_TENANT_ID / CLIENT_ID / CLIENT_SECRET / REDIRECT_URI, WEB_ORIGIN, API_PORT / API_HOST, SESSION_TTL_HOURS, AUTH_ALLOWED_DOMAINS, AUTH_AUTO_ENROL_ROLE, ECOTRAK_TRANSITION_MODE (warn | block), ESCALATION_WEBHOOK_SECRET, CRON_SECRET, QUO_WEBHOOK_SECRET / QUO_API_KEY / QUO_FROM_NUMBER / QUO_API_BASE, ANTHROPIC_API_KEY, QUOTE_AI_MODEL, ASSISTANT_AI_MODEL / ASSISTANT_AI_EFFORT / ASSISTANT_DAILY_LIMIT, MAIL_PROVIDER (graph | resend) / MAIL_FROM / MAIL_FROM_NAME / MAIL_REPLY_TO / RESEND_API_KEY / MAIL_GRAPH_*, SHAREPOINT_* (falling back to MAIL_GRAPH_* then ENTRA_*), BLOB_READ_WRITE_TOKEN, DEMO_MODE. Admin › Settings shows the safe part (mode, directory, redirect URI, session length, environment, web origin, API port, secure cookies, database engine and migrations) and never a secret.',
          value: 'Every knob is named once, and the Integrations page says whether each credential set is present.',
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
          what: 'Dashboard, Pulse, Work Orders, Vendors, Sites, Assets, Clients, Quotes, Payments, Incoming Work Orders, Planned Maintenance, Maintenance, Approvals, Receivables, Contracts, Purchasing, Client Updates and the Admin group. An item shows only when the role holds its section (a list of sections means any of them); Admin lists the console sections the person may open; a role with no Work orders section lands on the Dashboard.',
          value: 'Each role gets a sidebar that is exactly its job; a salesperson sees Dashboard alone.',
          controls: [
            { label: 'Work Orders badge', does: 'On the Work Orders page, the count of the CURRENT filtered list (it changes with every tab and filter); empty elsewhere.' },
            { label: 'Approvals badge', does: 'What waits on the viewer: decisions to make plus decisions to acknowledge.' },
            { label: 'Incoming Work Orders badge', does: 'Work orders to accept plus open drafts.' },
          ],
          permissions: ['one section per item (work_orders, dashboard, vendors, sites, assets, clients, quotes, payments, approvals/intake or intake, planned_maintenance, maintenance, approvals, invoicing, contracts, purchasing, client_updates, admin/*)'],
        },
        {
          name: 'Top bar',
          what: 'The wordmark, the breadcrumb trail, the search box, the notifications bell (Pulse rows plus "For you" notices), the assistant sparkle, the theme switch (sun / moon), the Viewing as select for super admins and the account menu with Sign out.',
          value: 'The things people reach for most often are in the same place on every screen.',
          controls: [
            { label: 'Search', does: 'Finds work orders by WO #, client WO #, title, client, city, state or trade and opens them.' },
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
          what: 'A page or button a person may not use is shown locked with a sentence saying why and who to ask (the admin console says "Ask a super admin — Elise, Jordan, Jeff or Jack"), instead of a dead end or a silent failure.',
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
          what: 'Every section and sub-section is a path (work_orders, work_orders/status, work_orders/fields/finances/fields.34. Cost, approvals/nte, admin/users, …) with five actions: view, create, edit, delete, approve. An unset action inherits from the path above; granting a write grants view; nothing set anywhere means no. A person\'s overrides are walked first, then the role, so an override at any ancestor beats a more specific role grant. A few rows are read exactly at their path and never inherited (the dashboard scope choice). The tree is drawn on the Roles screen with a search box and a legend ("Inherited · from the <role> role").',
          value: 'One screen answers "who can do what" for the whole application, and a new module arrives with its own rows.',
          controls: [
            { label: 'Find a section or field…', does: 'Filters the tree to matching rows.' },
            { label: 'View / Create / Edit / Delete / Approve cells', does: 'Click to set; faded cells are inherited; × returns a cell to inherited; a section button removes every setting under it.' },
            { label: 'Save role', does: 'Writes the tree; logged with before/after snapshots.' },
          ],
          rules: ['A permission map is capped at 2,000 entries and keys at 400 characters; non-boolean values are dropped on the way in.'],
          audit: ['role_created', 'role_updated', 'role_deleted'],
          since: '0021',
        },
        {
          name: 'What the tree contains',
          what: 'Dashboard (view, create = build and share; Which dashboards per board with Which work orders it counts), Work orders (create = import and Add work order, delete = move to Trash; Which work orders; Status changes; Messages with Message the client; Calls (Quo); Photos and files with approve; Export to CSV; Save as PDF; Field history; Detail tabs, one row per tab; every field by section), Quotes (approve covers reject and send), Payments with Process (send to Yoda, mark paid), Approvals with Pending acceptance / NTE increases / Status changes / Manager reviews / Quotes / Payments, WO Intake, Vendors (Which vendors: Everything / Only theirs; Notes and blacklist; Review queue; Documents; Import; Export; Saved lists; Portal; Dispatch), Technician map (Which technicians: All / Only theirs; VR vendors; Statewide; Nationwide; Subcontractors; Add a technician; hire), Sites, Assets with Requests, Clients, Planned maintenance, Maintenance sub-rows, Purchasing sub-rows, Invoicing, Contracts and rates, Client updates with Share with clients, Assistant, and the Admin console with one row per section (Themes, Audit log and Documentation view-only).',
          value: 'The whole application is one checklist.',
        },
        {
          name: 'Per-person adjustments',
          what: 'A super admin can give one person exceptions on top of their role (Adjust in Admin › Users): the same tree, with the role\'s cells faded and the person\'s overrides on top; Save adjustments, Remove all adjustments. The dashboard Share dialog writes the same kind of override (one board\'s view) for a ticked person without needing a super admin.',
          value: 'A trusted dispatcher can be given one extra right without inventing a role for them.',
          permissions: ['super admin only (Adjust)', 'dashboard create (Share to people)'],
          audit: ['user_permissions_set'],
        },
        {
          name: 'Field-level visibility and redaction',
          what: 'Every work-order field is a row under its section (Overview, Finances, Dates, People, CICO, Payables, Invoicing, AR, QC, Integrations, …; the promoted columns under "Work order header", unknown custom fields under "More fields"). A field a role cannot view is removed from every payload the API sends (promoted columns nulled, hidden keys stripped, the whole money block hidden when the NTE is hidden; identity, number, title and status always ship); editing a field needs view and edit; a hidden field is absent from the catalogue the list, the filters and the exports offer.',
          value: 'Cost, profit and client NTE can be kept from roles that should not see them, including in exports and the assistant.',
        },
        {
          name: 'Status-change mode',
          what: 'Work orders › Status changes is one three-way choice per role: Change directly, Must request, or Not allowed, stored as edit and create on work_orders/status.',
          value: 'Dispatcher tiers propose; managers decide; nobody edits a status by accident.',
          permissions: ['work_orders/status edit (direct) · create (request)'],
          brd: ['2.4.1', '8.1.3'],
        },
        {
          name: 'Which work orders a person sees (scope)',
          what: 'Work orders › Which work orders: Everything, or Only theirs (assigned to them by display name, the Assignee field or Assignee Name TXT as backstop), widened by ticking billing entities (Entity · SFM, …, stored as work_orders/scope/entity/<Comp>), by the clients listed on the person in Admin › Users, and narrowed by a site restriction (a work order with no site record is then outside every list). Super admins are never scoped.',
          value: 'Each dispatcher works their own book; a manager sees the whole entity; the sales team counts only their clients; nothing leaks through a dashboard, an export, a queue or a shared link.',
          rules: [
            'The scope predicate is appended to every list, count, queue, badge, KPI, dashboard card and per-work-order route; a work order outside it answers 403 "is not assigned to you".',
            'Bulk edit and delete refuse a selection that is not wholly inside the scope; Enroll is not scope-checked.',
            'The list header shows a "Yours only" / "Yours + SFM, 7-Eleven" chip for a scoped person, naming the entities and clients that widen it.',
          ],
          permissions: ['work_orders/scope view', 'work_orders/scope/entity/<Comp> view'],
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
          what: 'Work-order edits, status changes (with how: direct, request, visit, automation, webhook, payment, quote, sign-off, bulk, import), creation (source manual, import, intake, planned_maintenance, ecotrak), deletion and restore, visits, attachments, messages, calls, quotes (whole snapshots), payments, invoices, admin changes (fields, statuses, roles, users, automations, holidays, tiers, SharePoint, PDF layouts, integrations, portfolio lists, codes, layouts, templates, tax rates), saved views, exports, sign-ins and impersonation, assistant questions. Admin entities carry a name and before/after snapshots; thirty-five entity types are known.',
          value: 'There is no second place to look.',
          audit: ['field_updated', 'status_changed', 'created', 'deleted', 'restored', 'visit_created', 'comment_added', 'quote_updated', 'role_updated', 'user_updated', 'work_orders_exported', '…'],
          brd: ['1.2.1'],
        },
        {
          name: 'Append-only at the database',
          what: 'A database trigger refuses any UPDATE or DELETE on the log; a correction is a new row. Only the local seed\'s TRUNCATE passes.',
          value: 'The trail is evidence, not an opinion.',
          brd: ['1.2.2'],
          since: '0029',
        },
        {
          name: 'Service principals',
          what: 'Acts the system takes are signed by named service accounts, created lazily: Ecotrak sync, Email escalations, Planned maintenance, Client updates, Quo, Dispatch, Vendor portal, Client messaging, and the rules engine\'s Automations. They are drawn with a service avatar in the log and are not human logins.',
          value: 'A row always says who acted, even when nobody did.',
        },
        {
          name: 'Admin › Audit log',
          what: 'Filter by From, To, User, Change (human labels) and Search (WO #, client reference, field, entity type and both snapshots); Clear; page with Newer and Older, 100 rows a page ("n–m of t entries"); Export CSV of the filtered rows (up to 10,000; Time (UTC), User, Action, Entity, Name, WO #, Ext ref, Field, From, To), itself logged. Rows link to the record they changed where one exists (work orders, users, roles, fields, statuses, automations, drafts, vendors, sites, assets, …); "via <automation>" links to the rule; an Ecotrak verdict is appended to a status row; status requests read From → To; approval rows are labelled NTE override / Work order acceptance / Manager review.',
          value: 'Managers and auditors read it without asking a developer.',
          permissions: ['admin/audit view'],
          controls: [
            { label: 'From / To / User / Change / Search / Clear', does: 'Narrow the rows.' },
            { label: 'Newer / Older', does: 'Page through.' },
            { label: 'Export CSV', does: 'Downloads the filtered rows; logged as audit_log_exported.' },
          ],
          audit: ['audit_log_exported'],
        },
        {
          name: 'Not logged on purpose',
          what: 'Per-user preferences (column widths, collapsed cards, pinned view, theme), the working list arrangement kept in the browser, and pure clicks (tabs, filters) change no record and are not logged. An admin save that changes nothing logs nothing.',
          value: 'The log stays about records, so it stays readable.',
        },
      ],
    },
  ],
};

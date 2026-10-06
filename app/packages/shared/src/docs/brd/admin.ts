// 0075 · BRD parts: automations, and the admin console.

import type { DocPart } from '../types';

export const AUTOMATION_PART: DocPart = {
  key: 'automation',
  title: 'Automations',
  intro: 'Rules that watch work orders and act: set a field, raise an approval task, after an optional wait.',
  modules: [
    {
      key: 'automations',
      title: 'Automations',
      where: 'Admin › Automations; Enroll in the bulk bar; ?rule=<id> deep links from audit rows.',
      purpose: 'When a work order is created, a field changes (to a value, past a number, or past another field) or people enrol it by hand: if conditions hold (AND / OR), then set fields or raise an approval task, optionally after a wait.',
      value: 'Business rules such as the NTE override live as data the team can read and pause; new rules need no deploy.',
      features: [
        {
          name: 'Builder',
          what: 'New automation: Name; Trigger tiles A work order is created / A field changes (which field or Any field; "to exactly / to more than / to at least / to less than / to at most" against "an amount" or "another field", money and number fields only) / Manually enrolled; Applies to (Work orders; Vendors, Quotes and Invoices are drawn disabled with a Soon chip); Conditions ("+ Add a condition (optional — no conditions means always)", AND / OR with brackets); Actions ("+ Add an action": Set a field — status, priority or a custom field, "new value (empty clears)" — or Raise an approval task — nte_override or manager_review, "for any approver / for <role>"); Next on each step, Review and turn on (Save changes and Back when editing). Each rule is a card with the switch ("On — click to pause" / "Paused — click to enable"), a Manual chip, "n runs" with the log (When, Work order, Result: Applied / Skipped — conditions no longer matched / error), edit and delete ("run history is deleted with it. Changes it already made … stay").',
          value: 'Readable by a manager, not only a developer.',
          rules: [
            'Settable: status (by name, validated at save; a rename makes later runs error), priority (urgent / high / normal / low) and custom fields except formula and attachment types; visit-owned and computed fields are refused; up to 10 actions; a role code must exist.',
            'Untriggerable keys: age, created / updated stamps, WO #, status group; a field never compares against itself; a missing or non-numeric NTE never matches.',
            'A wait (API only; the builder does not expose it yet) of up to 30 days: conditions are checked when it ends, another matching change restarts the clock, timers are database rows (swept every 30 seconds, 25 a sweep), and a paused or deleted rule drops its timers.',
            'A rule\'s own change does not trigger itself (depth cap 5); the dispatcher also runs the approval-task reconcile, Previous Assignees and the sign-off generation before any rule.',
            'Enroll from the bulk bar takes any ENABLED rule (Manual or Automatic (re-run by hand)), up to 500 work orders, and refuses a paused rule.',
          ],
          permissions: ['admin/automations view / edit', 'work_orders edit (Enroll)'],
          audit: ['automation_created', 'automation_updated', 'automation_deleted', 'field_updated / status_changed via automation'],
          since: '0017 / 0018',
        },
        {
          name: 'Seeded rules',
          what: '"Rule 1.5.2 · Manager escalation (cost over NTE)": Cost changed to more than NTE → raise nte_override (on). "Rule 2.5.1 · Emergency from client priority": priority changed to urgent → Emergency = true (paused until the portals drive priority).',
          value: 'Rule 1.5.2 ships as a rule the team can see.',
        },
      ],
    },
  ],
};

export const ADMIN_PART: DocPart = {
  key: 'admin',
  title: 'Admin console',
  intro:
    'Users, Roles, Settings, Automations, Custom fields, Themes, Audit log, Trash, Vendors & map, Sites & assets, Integrations and Documentation. Each is its own permission row, read from the real signed-in user; the locked page says "Ask a super admin — Elise, Jordan, Jeff or Jack".',
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
          what: 'Columns User (a You chip), Role (a select that saves at once), Status (Active "Has signed in at least once" / Invited "Can sign in, but never has" / Disabled "Blocked from signing in"), Super admin (a switch; disabled on yourself; "Every permission, the admin console, and view as anyone"), Last sign-in ("Never"), Clients (All clients for super admins; chips + Assign / Edit → Find a client…, Save clients), Permissions (Everything for super admins; Adjust; an Adjusted pill), Disable ("Blocks sign-in and ends every live session") / Re-enable (back to invited). Invite a user: Work email (name@byblosvista.com), Full name, Role, Super admin, Send invitation (no email is sent: the row is the invitation).',
          value: 'The invitation is the row.',
          rules: ['A duplicate email is refused ("is already a user"); you cannot remove your own super-admin flag or disable yourself; the last active super admin cannot be demoted or disabled; disabling destroys every session; users are never deleted; a client list on a super admin is refused.'],
          permissions: ['admin/users view / edit', 'super admin (Adjust)'],
          audit: ['user_invited', 'user_updated (name, email, role, status, super admin)', 'user_disabled', 'user_clients_changed', 'user_permissions_set', 'user_site_access_changed'],
        },
        {
          name: 'Roles',
          what: 'New role: Name (the code is derived from it), Description, Start from (Copy of <role>), the tree, Create role ("Assignable immediately after saving"). A role card: the tree with Find a section or field…, the legend "Inherited · from the <role> role", × Back to inherited, a section button to clear a whole section, choice rows as radio groups; Save role; Delete → Cancel / Confirm ("Built-in roles are referenced by the seed and by migrations"; "Move its users to another role first").',
          value: 'See Roles, permissions and data visibility.',
          rules: ['A built-in role\'s code is fixed (label, description and permissions edit); the only role that can reach the admin console cannot lose that row ("This is the only role that can reach the admin console"); a role with users cannot be deleted; a code change cascades to the people holding it.'],
          permissions: ['admin/roles view / edit (the list is readable with Users view)'],
          audit: ['role_created', 'role_updated', 'role_deleted'],
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
          what: 'Columns Field / Type / Options / Add work order / Used by with a drag handle. New field: Name (becomes the permanent key; must be unique), Type (Text, Long text, Dropdown, Checkbox, Date, Date & time, $ amount, Number, People, Phone number, Link, Address, Attachment, Function, Rating), Dropdown values one per line, Create … field. Rename with the pencil; change the type in the row (values that no longer parse read as not set); edit options under "<n> values ▾" with Save values / Reset (de-duplicated; removing a value never changes work orders holding it); drag to reorder; Add work order column (Not on the form / On the form / Required; WO # is always required). Fields are never deleted.',
          value: 'A new field is live everywhere in a minute.',
          permissions: ['admin/fields edit'],
          audit: ['field_def_created', 'field_def_updated', 'field_defs_reordered'],
        },
        {
          name: 'Statuses and phases',
          what: 'Per phase card: Add a status to … with a colour (default grey), Add; pencil to rename; trash then Delete status. New phase (Name, Create phase) becomes a list tab; only an empty, non-built-in phase can be deleted.',
          value: 'The pipeline is edited where the fields are.',
          rules: ['A duplicate status name (case-insensitive) is refused; a status with work orders at it, trashed ones included ("(n in the trash)"), cannot be deleted; renaming Waiting for Approval or Ready to Invoice empties two dashboard tiles (warned on screen).'],
          audit: ['status_created', 'status_updated', 'status_deleted', 'status_group_created', 'status_group_renamed', 'status_group_deleted'],
        },
        {
          name: 'Check-in method by FM',
          what: 'FM company ("Type or pick an FM"), Method, Detail, Add; an Updated column; delete per row. Pre-fills a new visit\'s method and detail from the work order\'s FM.',
          value: 'Pre-fills visits.',
          permissions: ['admin/fields edit'],
          audit: ['cico_method_created', 'cico_method_changed', 'cico_method_deleted'],
        },
      ],
    },
    {
      key: 'admin-settings',
      title: 'Admin › Settings',
      where: 'Admin › Settings.',
      purpose: 'How the instance is configured (read-only: Authentication — mode, access, directory, redirect URI, session length; Server — environment, web origin, API port, secure cookies; Database — engine, migrations applied, latest; Contents — work orders, users, roles, statuses, custom fields) plus the editable tables.',
      value: 'Every operating table the business owns is editable by the business.',
      features: [
        { name: 'Holidays', what: 'Day and Name; the button reads Add, or Rename when the day is on file; remove per row; "48 hours from an assessment check-out … add the observed weekday". Quote due dates already stamped do not move until the visit is next edited.', value: 'Rule 2.3.2 as a table.', permissions: ['admin/settings edit'], audit: ['holiday_created', 'holiday_changed', 'holiday_deleted'] },
        { name: 'Sub-categories', what: 'Per trade: Add a sub-category of …, Rename, Switch off / on; suggestions for the Sub Category field, which still takes anything typed.', value: 'Suggestions on the form.', audit: ['wo_subcategory_added', 'wo_subcategory_updated'] },
        { name: 'Add work order layouts', what: 'New layout: Name, For the client and / or For the trade ("Pick a client, a trade, or both"), then Hidden / Optional / Required per field; Add the layout. The most specific layout wins (client + trade, then client, then trade); Client and Trade can never be hidden.', value: 'Client-specific intake without code.', audit: ['wo_form_layout_added', 'wo_form_layout_updated', 'wo_form_layout_deleted'] },
        { name: 'Fault and action codes', what: 'Fault or Action, the CODE and What it means, Add; Reword; switched off, not deleted; a code\'s letters never change.', value: 'Completion is coded for reporting.', audit: ['wo_code_added', 'wo_code_updated'] },
        { name: 'Tax rates and document templates', what: 'Tax rates (Name, %, State, Make default) and document templates per printed kind (quote, invoice, purchase order). Detailed under Purchasing.', value: 'The printed paper carries the right letterhead and the right tax without hand editing.' },
        { name: 'Approval tiers by amount', what: 'One table per kind (Payment requests / Vendor bills / Client invoices): From $, Up to $ (blank = no ceiling), Roles, Add band; Remove this band. Detailed under Technician payments.', value: 'Rule 6.2.3.' },
        { name: 'SharePoint folders and Work-order PDFs', what: 'The SharePoint card (site URL, library, the three path templates, the three switches, Test connection, Run now, the filed-so-far tables) and the Work-order PDFs card (per kind: Edit / Open; Title on the document, hide empty fields, Note under the fields, the ordered field list with Add a field by section, Standard list, Save). Detailed under Save as PDF and SharePoint folders.', value: 'Filing and printing are configured by the business, not deployed.' },
      ],
    },
    {
      key: 'admin-other',
      title: 'Admin › Themes, Audit log, Trash, Vendors & map, Sites & assets',
      where: 'Admin.',
      purpose: 'The remaining console sections.',
      value: 'Each is one screen with one job.',
      features: [
        { name: 'Themes', what: 'Cards Blackout ("Near-black ground, cyan accent…") and Daylight Dispatch, for this browser; a Current palette card showing the live tokens (Background, Surface, Text, Muted text, Accent, Warning, Danger, Border).', value: 'Preview both.', permissions: ['admin/themes view'] },
        { name: 'Audit log', what: 'Every change in the system with filters, paging and CSV export; nobody can edit or delete a row. Detailed under Audit and traceability.', value: 'Evidence on demand.', permissions: ['admin/audit view'] },
        { name: 'Trash', what: 'Columns WO #, Title, Client, Status at deletion, Deleted; Restore. Not scoped by Which work orders (admin only); nothing is removed permanently.', value: 'Rule 8.1.1.', permissions: ['admin/trash view / edit'], audit: ['restored'] },
        { name: 'Vendors & map', what: 'The map (Search radius (miles) 5 to 500, Daily alert at — "An alert only — nobody is blocked.", Hiring › Warn when a vendor\'s COI is missing or expired — "It never stops the hire.", Save); Required fields (18 tickable; defaults Name, a phone, Email, Owner, City, State; "A vendor always needs a name"); Preferred vendors (Client, Trade, State, City, Vendor, Rank, Note); Suggested vendors (Vendors on the list 1 to 20, Fill the places left over automatically, An automatic pick must: Be filed under the work order\'s trade / Cover its location / Take same-day emergencies when the work order is an Emergency; Paperwork and offers: Leave out a vendor whose COI is missing or expired / Dispatch offers may go to automatic picks; Tie-breakers, in order with Move up / Move down / Turn on / Turn off); Dispatch offers (Allow dispatch offers, Start by itself when a work order is added with no vendor, Hours a vendor has to answer); Vendor invoicing rules (seven, warn-only, with their numbers); the lists Vendor statuses (colour, Rename, Turn off / on, Built in lock), Brand sources, Vendor trades, Skills, Consumables; Map use, last 14 days (Day, Person, Map opens; "Over N" chips).', value: 'The vendor module\'s dials.', permissions: ['admin/vendors edit'], audit: ['vendor_settings_updated', 'vendor_setting_updated', 'vendor_required_field_changed', 'preferred_vendor_created', 'preferred_vendor_updated', 'preferred_vendor_deleted', 'vendor_list_value_added', 'vendor_list_value_updated'] },
        { name: 'Sites & assets', what: 'Site types and Asset categories (Add a value…, Rename — carries every record holding the old value — Switch off / on, an in-use count); Site access (super admins only: Restrict another person, Choose a person…, pick sites, Lift the restriction; "nobody listed = no restriction").', value: 'The portfolio\'s lists.', permissions: ['admin/portfolio view / edit', 'super admin (site access)'], audit: ['portfolio_list_value_added', 'portfolio_list_value_updated', 'user_site_access_changed'] },
      ],
    },
    {
      key: 'integrations',
      title: 'Admin › Integrations',
      where: 'Admin › Integrations.',
      purpose: 'Every connector on one page, grouped Client systems / Calls, texts and email / AI / Files / Platform, each with the tool\'s mark, what it does, whether it is set up on the server ("Connected", "On · not set up on the server", "Connector not built yet", "Off"), a "When off:" line, who changed it and one switch: Ecotrak, ServiceChannel, Corrigo, Quo, Outgoing email, Escalation emails, Claude, SharePoint, File storage, Microsoft sign-in (Always on).',
      value: 'An integration misbehaving is switched off in one click, every button that uses it explains itself, and the keys stay on the server so switching back on needs nothing else.',
      features: [
        {
          name: 'Switches',
          what: 'The list is code; the switch is a row per key (no row = on, so a connector added later is on). A flip is read by every server instance within 20 seconds. Off: Quo refuses texts and its webhook (Quo retries once it is back on); Ecotrak refuses the ingest; Claude refuses the assistant and the quote draft; Outgoing email refuses sends ("switched off"); Escalation emails answers the webhook 409; SharePoint stops filing whatever the Settings switches say; File storage refuses uploads (stored files still open). ServiceChannel and Corrigo have no connector yet: the switch is remembered. Microsoft sign-in cannot be switched off (409 INTEGRATION_LOCKED).',
          value: 'Operational control without a developer.',
          permissions: ['admin/integrations view / edit (read from the real signed-in user)'],
          audit: ['integration_turned_on', 'integration_turned_off (a no-op flip logs nothing)'],
          since: '0074',
        },
        {
          name: 'Ecotrak (inbound only)',
          what: 'The sync reads work orders, sites and assets from Ecotrak and stamps Client Portal Type, Ecotrak ID and Ecotrak Status; GET /integrations/ecotrak/status and POST /integrations/ecotrak/sync (manual trigger, 403 in the public demo); nothing is written back until go-live.',
          value: 'Intake from the biggest client portal is automatic; the write-back rules are ready.',
          brd: ['2.6.1', '2.6.3'],
        },
        {
          name: 'Quo, Claude, Outgoing email, Escalation emails, SharePoint, File storage, Microsoft sign-in',
          what: 'Quo: calls, transcripts and summaries by webhook (signature verified), texts through the API from the Quo line. Claude: the AI quote draft and the assistant. Outgoing email: client updates through Microsoft Graph (the mailbox needs the Mail.Send application permission) or Resend. Escalation emails: the mailbox webhook that flags a work order Escalated. SharePoint: the folder tree through Graph. File storage: the private Vercel Blob store behind photos, documents and sheets. Microsoft sign-in: the platform\'s sign-in, always on.',
          value: 'Each is one switch and one credential set, and the page says which credentials are present.',
        },
        {
          name: 'Webhooks and scheduled runs',
          what: 'POST /api/webhooks/email-escalation (shared secret), POST /api/webhooks/quo (Quo signature), and the two cron endpoints planned-maintenance-run (daily 12:00 UTC) and client-updates-run (hourly; also sweeps lapsed dispatch offers and retries SharePoint filing), each accepting GET from Vercel or POST by hand with the CRON_SECRET as a Bearer or x-webhook-secret header; an unset secret answers 403, a wrong one 401, the public demo 403. Server functions may run up to 300 seconds (the AI draft).',
          value: 'The scheduled work has a door, a key and a log.',
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
          what: 'BRD (what and why, with the live appendix), SOP (how, step by step, in the Tech Locator SOP format) and Lifecycle (the work-order flow with gates, side processes, live counts and Ecotrak pushes; click a status for its card). Print / Save as PDF ("Opens the print dialog; choose Save as PDF"), Download Markdown, Download Word (BRD and SOP) or Download SVG (Lifecycle); a Contents rail.',
          value: 'One link to send a reviewer, a new hire or an auditor.',
          permissions: ['admin/docs view'],
          since: '0075',
        },
      ],
    },
  ],
};

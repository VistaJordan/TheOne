// 0068 · The guide the assistant answers "how do I…" questions from.
//
// Written from the screens themselves: every quoted name is a label in the
// JSX, and every "needs" is the permission the API checks for that task.
// WHEN A SCREEN CHANGES, CHANGE ITS ENTRY HERE — the assistant repeats these
// names to people, and it is told to say "I am not sure" about anything this
// file does not cover rather than guess.
//
// It is part of the cached system prompt, so it is one static string: no
// dates, no per-person content.

import { GUIDE_WORK_ORDERS } from './assistantGuideWorkOrders.js';
import { GUIDE_MODULES } from './assistantGuideModules.js';

const GUIDE_ADMIN = `### Admin console (sidebar: Admin)

Sections: Users, Roles, Settings, Automations, Custom fields, Themes, Audit log, Trash, Vendors & map, Sites & assets. Each needs its own permission row, \`admin/<section>\`: view to open it, edit to change anything. Users, Roles, Automations, Custom fields (with statuses), Holidays, Approval tiers, Audit log and Trash are checked against the person actually signed in, never the person they are viewing as. Super admins pass every check.

**Automations** (Admin › Automations; needs \`admin/automations\` edit to add, change, pause or delete; view to see them and their run logs)
An automation watches work orders and, when its trigger and conditions are met, sets fields or raises an approval task. To create one:
1. Open **Admin › Automations** and click **New automation**.
2. Type a **Name** (required).
3. Step **Trigger**: pick **A work order is created**, **A field changes** (then choose which field, or **Any field**, and optionally the value or other field it must change to), or **Manually enrolled** (never fires by itself; people select work orders in the list and enrol them from the bulk bar). Click **Next**.
4. Step **Applies to**: **Work orders** is the only live choice; Vendors, Quotes and Invoices are shown but not available yet. Click **Next**.
5. Step **Conditions** (the "If"): click **+ Add a condition** for each one: a field, a test and a value. No conditions means it always runs. Each condition joins the one above with AND or OR; AND binds before OR and the brackets on screen show the grouping. Click **Next**.
6. Step **Actions** (the "Then"): click **+ Add an action** and choose **Set a field** (pick the field and the new value; an empty value clears it) or **Raise an approval task** (pick the task type and optionally the role code that should decide it; empty means any approver).
7. Click **Review and turn on**.
Afterwards each automation is a card with a switch (on, or paused), its run log (When, Work order, Result) and edit and delete. Rules: an action can set a status, the priority or a custom field; the fields a visit owns (check-in and check-out fields) and Quote Due Date cannot be set by an automation's action because they are computed; an automation's own change does not trigger itself in a loop.

**Users** (Admin › Users; needs \`admin/users\` edit)
- Invite someone: click **Invite a user**, fill **Work email** and **Full name**, pick a **Role**, optionally tick **Super admin**, click **Send invitation**. The email must match their Microsoft account exactly. A byblosvista.com account needs no invitation: it enrols itself as OM Under Probation the first time it signs in.
- Change a role: pick from the **Role** dropdown in the person's row; it saves at once.
- Make or unmake a super admin: the **Super admin** switch in the row. Nobody can change their own, and the last super admin cannot be demoted.
- Block or restore sign-in: **Disable** (ends their sessions immediately) or **Re-enable**. Nobody can disable themselves or the last super admin.
- Change one person's permissions without changing their role (super admins only): click **Adjust** in the **Permissions** column, click a cell to set it for that person (faded cells come from the role), then **Save adjustments**. **Remove all adjustments** clears them.

**Roles** (Admin › Roles; needs \`admin/roles\` edit)
- Create a role: **New role**, fill **Name**, optionally **Start from** a copy of another role, set the cells, **Create role**.
- Change what a role can do: click the role's card, find the row (**Find a section or field…**), click a cell under View, Create, Edit, Delete or Approve, then **Save role**. An unset cell follows the row above it. Granting a write also grants View on that row.
- Which work orders a role sees: open the role, expand **Work orders**, row **Which work orders**: **Everything** or **Only theirs**; under Only theirs, tick **Entity · <Comp>** rows to add whole billing entities. **Save role**.
- Whether a role changes statuses directly: **Work orders** › **Status changes**: **Change directly**, **Must request** or **Not allowed**.
- Which dashboards a role opens: **Dashboard** › **Which dashboards**, tick View per dashboard; under each, **Which work orders it counts**.
- Which Admin sections a role opens: **Admin console**, tick View or Edit per section.
- Delete a role: **Delete** then **Confirm** on its card. Built-in roles cannot be deleted, nor a role that still has users.

**Custom fields and statuses** (Admin › Custom fields; needs \`admin/fields\` edit)
- Add a field: **New field**, fill **Name**, pick **Type** (Text, Long text, Dropdown, Checkbox, Date, Date & time, $ amount, Number, People, Phone number, Link, Address, Attachment, Function, Rating); for a Dropdown fill **Dropdown values**, one per line; click the **Create … field** button. The name becomes the permanent key and must be unique. Fields cannot be deleted.
- Rename a field: the pencil beside its name, then **Save**. Change its type: the **Type** dropdown in its row. Reorder: drag the handle at the left of the row.
- Edit a dropdown's values: in the **Options** column click the values count, remove with × or add with **Add**, then **Save values**. Removing a value never changes work orders that already hold it.
- Put a field on the Add work order form: the **Add work order** column: **Not on the form**, **On the form** or **Required**.
- Statuses live on the same page under **Statuses**. Add one: in its phase's card type in **Add a status to …**, pick a colour, click **Add**. Rename with the pencil; delete with the trash icon then **Delete status**. A status that work orders are sitting in cannot be deleted; move them first.
- Phases (status groups): **New phase**, **Name**, **Create phase**; it becomes a tab on the work-orders list. Only an empty phase that is not built in can be deleted.
- Check-in method by FM: fill **FM company**, **Method** and optional **Detail**, click **Add**. It pre-fills the method of a new visit.

**Settings** (Admin › Settings; needs \`admin/settings\` edit)
- Holidays (the days the quote clock skips): pick **Day**, type **Name**, click **Add**. Edit a name in the table; the trash icon removes one. Quote due dates already stamped do not move until the visit is next edited.
- Sub-categories: pick the trade, type in **Add a sub-category of …**, click **Add**. **Rename**, **Switch off** or **Switch on** per row.
- Add work order layouts: **New layout**, **Name**, **For the client** and/or **For the trade**, then per field choose **Hidden**, **Optional** or **Required**; **Add the layout**. The most specific layout wins.
- Fault and action codes: pick **Fault** or **Action**, type the code and **What it means**, click **Add**. A code's letters never change; codes are switched off, not deleted.
- Tax rates: name, **%**, optional **State**, **Add**; **Make default** per row. Changing a rate recomputes nothing already on file.
- Document templates (the printed quote, invoice and purchase order): **New template**, fill **Name**, **Kind of document**, **Company name on the document**, **Letterhead**, **Terms**, **Footer**, tick **Use it**, **Save**.
- Approval tiers by amount (who may approve payment requests, vendor bills and client invoices of what size): **Add a band**, **From $**, **Up to $**, tick **Roles**, **Add band**. A band with no roles restricts nobody.

**Audit log** (Admin › Audit log; needs \`admin/audit\` view)
Filter with **From**, **To**, **User**, **Change** and **Search**; page with **Newer** and **Older**. **Export CSV** downloads the filtered rows. The log cannot be edited or deleted by anyone.

**Trash** (Admin › Trash; \`admin/trash\` view to see it, edit to restore)
Deleted work orders wait here; click **Restore** on a row. Nothing is removed permanently.

**Themes** (Admin › Themes; \`admin/themes\` view)
Click the **Blackout** or **Daylight Dispatch** card. It applies to that browser only. Everyone can also switch with the sun/moon button in the top bar.

**Vendors & map** (Admin › Vendors & map; needs \`admin/vendors\` edit)
- The map: **Search radius (miles)**, **Daily alert at**, and **Warn when a vendor’s COI is missing or expired**; **Save**. Neither the alert nor the warning blocks anyone.
- Preferred vendors: pick **Client** and/or **Trade**, optional **State**, find the **Vendor**, set **Rank**, **Add**. The most specific rule wins.
- Required fields for a vendor record: tick or untick each.
- Dispatch offers: tick **Allow dispatch offers**, optionally **Start by itself when a work order is added with no vendor**, set **Hours a vendor has to answer**. Offers only go to the preferred vendors listed.
- Vendor invoicing rules: switch each rule on or off and set its number. A tripped rule only warns.
- The lists (vendor statuses, brand sources, vendor trades, skills, consumables): type in the add box and click **Add**; turn a value off rather than deleting it.
Who sees which technicians on the map is set in Admin › Roles under **Technician map**, not here.

**Sites & assets** (Admin › Sites & assets; needs \`admin/portfolio\` edit)
- Site types and asset categories: type in **Add a value…**, click **Add**; **Rename** or **Switch off** per row.
- Restrict a person to certain sites (super admins only): under **Site access**, **Choose a person…**, pick their first site, then add more on their row. **Lift the restriction** removes it. A restricted person sees only those sites, their assets and their work orders.`;

export const APP_GUIDE = `## Guide to the app's screens

Each task says what it needs: a permission row and an action, as in \`admin/automations\` edit. Compare it with "What this person may do" before giving steps. Bold names are the labels on screen.

The sidebar: Dashboard, Pulse, Work Orders, Vendors, Sites, Assets, Clients, Quotes, Payments, Incoming Work Orders, Planned Maintenance, Maintenance, Approvals, Receivables, Contracts, Purchasing, Client Updates, and Admin with its sections. A person only sees the items their role includes. The top bar has the search box, **Viewing as** (super admins), this assistant, the notifications bell and the theme switch.

${GUIDE_WORK_ORDERS}

${GUIDE_MODULES}

${GUIDE_ADMIN}`;

// 0068 · The assistant's guide, part 1: the Work Orders list, the work-order
// page and Incoming Work Orders. See assistantGuide.ts for the rules of this
// text (labels are the ones on screen; "needs" is what the API checks).

export const GUIDE_WORK_ORDERS = `### Work Orders list (sidebar: Work Orders)

Needs \`work_orders\` view. A person limited to their own work orders sees a "Yours only" or "Yours + <Comp>" chip, and another person's work order answers "is not assigned to you".

- Open a work order: click its row or its WO number.
- The tabs along the top are views: **All work orders**, **Due Today**, **Escalation Tracker**, then saved views.
- Filter by status group: the segment buttons starting with **All**.
- Quick filters: the **Status**, **Assignee**, **FM**, **Comp** and **AM** chips; tick values, **Clear** to remove.
- Filter on any field: click **Filter**, **Add filter**, pick a field, a test and a value; with two or more rules choose **Match all** or **Match any**. (Not shown on the Due Today tab.)
- Group: click **Group** and pick a field; **No grouping** undoes it.
- Sort: click a column header. **Sort by breach** puts the work orders closest to a deadline first.
- Choose columns: click **Columns**; reorder or remove under **Shown**, add under **Add a column**.
- Save a view: arrange filters, columns, grouping and sort, click **Save view**, type a **Name**, tick **Share with the team** if everyone should have it, click **Save**. Only its owner can change or delete it (the pencil, then **Save**; the trash icon, then **Delete view**). The pushpin makes Work Orders open on that view for you.
- **Due Today**: segments **All**, **Escalations**, **Scheduled**, **Quote**, **Parts arriving**, with a day picker (**Today**, **Tomorrow** or a date). Quote lists quotes due that day, and overdue ones while the status is still before Quote Ready.
- **Escalation Tracker**: every work order flagged Escalated.
- Change a status from the list: click the status pill in the row (same rules as on the work-order page).
- Bulk actions: tick rows (the header box ticks the page; **Select all N matching** takes everything that matches). Then in the bar:
  - **Edit**: **Add a field**, set the value (blank clears), **Apply to selection**. Needs \`work_orders\` edit and edit on each field.
  - **Set status**: needs \`work_orders/status\` edit; not shown to people who must request status changes.
  - **Enroll**: put the selection through an automation.
  - **Delete**, then **Move to Trash**: needs \`work_orders\` delete. Restorable from Admin › Trash.
  The whole selection must be work orders the person may see.
- Export: click **Export** for a CSV of the filtered rows in the columns shown. Needs \`work_orders/export\` view.
- Import a CSV: click **Import**, **Choose file**, map each column under **Match the columns**, choose **Create and update** or **Only create**, click **Preview**, then **Import N row(s)**. Needs \`work_orders\` create. A row whose WO # already exists updates that work order; a WO # that is in the trash is skipped ("In trash"). Three refusals stop the whole file, the Preview included (never for a super admin), and the dialog lists the rows refused: a row that is a work order outside the person's own work orders ("Some rows in this file are work orders that are not assigned to you"); a **Status (by name)** cell without \`work_orders/status\` edit ("You cannot set work-order status — remove the status column, or clear it on these rows"); a **Home list (by name)** cell on a new row without it ("You cannot route work orders to a home list — remove the home list column, or clear it on these rows").

**Add a work order** (needs \`work_orders\` create)
1. Click **Add work order**.
2. Optionally pick **Start from a template…**.
3. Type the **WO #** (required; a number already in use, even in the trash, is refused).
4. Optionally pick a **Site** and an **Asset**; the site fills in the client, store and address.
5. Fill the sections; fields marked * are required, and the footer lists what is **Still needs …**.
6. Optionally add files under **Photos and files**.
7. Click **Create work order**.
"Possible duplicates" is a warning only. **Save as template** keeps the filled form for next time. Which fields appear, and which are required, is set in Admin › Custom fields (the **Add work order** column) and Admin › Settings (layouts per client or trade).

### The work-order page

Tabs, each shown only if the role includes it (\`work_orders/tabs/<tab>\` view): **All fields**, **Finances** (sub-tabs **Finances**: money, client quote, invoice; **Payables**: vendor bills, purchasing, payment history; **Cost breakdown**), **Dates**, **CICO** (the ETA and the visit log), **People** (sub-tabs **Our team**: our people and the **Assignment history**; **Technicians**: the responsible vendor, technicians, suggested vendors, dispatch), **Site**, **Parts**, **Overview** (deadlines, updates and activity, photos), **Timelog**, **Messages**, **Audit trail**. There is no Flags tab (the flags are checkboxes in All fields). Checklist and Related have no tab button; a link to them (for example from Maintenance › Work permits) still opens them. The header opens unfolded on every work order.

- Edit a field: on **All fields**, click the value, change it, click the tick. **Search fields…** finds a field. Needs \`work_orders\` edit and edit on that field.
  - The visit fields (Visit Type, Check-in/out Status, Checked-in At, Checked-out At, Tech Name, Tech Phone Number, CICO Method) cannot be typed: they follow the latest visit, so edit the visit on the CICO tab.
  - Quote Due Date cannot be typed: it is computed from the assessment visit's check-out.
  - **Cost** fills itself in: paying a payment request adds its amount to Cost, and deleting a paid one takes it back out. Once a payment has written it, it cannot be typed. A work order with no paid payment request still takes a typed Cost.
  - **Total Invoiced** fills itself in: when the work order's invoice is sent it becomes the invoice total. It can never be typed.
  - Profit is always Total Invoiced minus Cost.
- Change the status: **Change status** in the header, pick a status. Needs \`work_orders/status\` edit.
- Request a status change: for people who must request, the same button reads **Request status change**. Pick a status; a manager approves or rejects it in Approvals, and the result shows on a chip in the header.
- Statuses the app holds back until the work order is ready (the menu tags them):
  - Quote Ready needs a quote with at least one line or scope item.
  - Waiting for Parts and Please Order Parts need the **Parts Required** field filled.
  - Done / Incurred needs a visit that was checked in and out, the final **Cost**, a quote with data and an approved after photo (for a Bill For Incurred job: an approved before photo and a sign-off instead).
  - Ready to Invoice, Invoiced Not Paid and Invoiced need the same as Done / Incurred, unless the work order is already in Done / Incurred or another of those three.
  - While the work order sits in one of those statuses, what it needed cannot be emptied: **Parts Required** in the parts statuses, the **Cost** from Done / Incurred on, the quote's lines in Quote Ready and from Done / Incurred on.
  - The quote moves the status too: **Send to client** moves it to Waiting for Approval, the client's approval to Approved, the client's decline back to Waiting for Quote (only from the quote and approval statuses; a work order further along stays put).
  - A move Ecotrak would refuse is tagged **Ecotrak**; it is a warning unless the site is set to block.

The **More** menu in the header, beside **Save as PDF** (all need \`work_orders\` edit; Pause, Complete service, Cancel and Reopen also need \`work_orders/lifecycle\` edit, which people who must request status changes do not have, so they do not see those items):
- **Pause**: type why, click **Pause**; **Resume** ends it. A pause is a marker: it does not stop any clock.
- **Tag**: type a **Tag** and a **Reason**, **Add the tag**.
- **Complete service**: fill the **Completion note**, fault code and action code, click **Complete service**. It records the completion and does not change the status.
- **Cancel work order**: type why, **Cancel the work order**. The button is gone once the client invoice is sent or paid, or a vendor payment is paid. **Reopen** undoes it: type why, click **Reopen**; the work order goes back to the status it had before the cancel.

Elsewhere on the page (need \`work_orders\` edit):
- **Assign vendor** / **Re-assign vendor**: **People** tab, **Technicians**, the **Responsible vendor** card; search under **Find a vendor** and click one. Blacklisted vendors cannot be picked.
- **Add ETA** / **Change ETA**: **CICO** tab, the **ETA** card; set **Expected on site**, **Save ETA**.
- There is no button to ask for a higher NTE any more. Requests already open are decided on **Finances** › **Cost breakdown** under **NTE increases** or in Approvals (needs \`approvals/nte\` approve).

Visits (the **CICO** tab; needs \`work_orders\` edit and \`work_orders/fields/cico\` edit):
1. Click **New visit**.
2. Pick the **Visit type** (required), and the **Technician**, **Phone** and **Method**.
3. Click **Log visit**.
Check a technician in or out by changing the status dropdown on the visit row (**Not checked in**, **Checked in**, **Checked out**, **Checked out · return trip needed**); the time is stamped by itself, and a time someone typed is never replaced. Typing a check-in or check-out time sets the visit's status to match. A check-in moves the work order to On Site; when the person checking in must request status changes, it sends a request to move it to On Site instead, which a manager approves in Approvals. Checking out of an Assessment visit sets the Quote Due Date. Correct times with the pencil (**Save visit**); delete with the trash icon.

Messages (the **Messages** tab): choose **Internal** or **Client-visible**, type, then **Post internally** or **Send to client**. Needs \`work_orders/comments\` create; a client-visible message also needs \`work_orders/comments/client\` create. A message sent to the client cannot be edited afterwards.

Photos and files: in the message box click the camera (**Add photo**) or **Attach file** (needs \`work_orders/attachments\` create). An upload stays hidden from others until someone approves it: **Overview** tab, **Photos** card, **Waiting for approval**, click **Review** to open the photo full size (← and → step through the waiting ones), pick **What is it?** (Before photo, After photo, Sign-off, Other), then **Approve** or **Decline** there (needs \`work_orders/attachments\` approve; the person who uploaded a photo may approve it). Approved photos also show on the **Client invoice** card.

Calls: **Call** in the header, pick who under **Who**, pick **Just call** or **Call and draft a quote**, click **Call via Quo** (needs \`work_orders/calls\` create). Calls and their transcripts are on the Messages tab in the **Calls** card. From a call with a transcript, **Draft a quote with AI** opens a draft to adjust and **Submit quote** (needs \`quotes\` edit). Without a Quo call, **Import transcript** on the quote builder or the Client quote card takes a .txt / .vtt / .srt file (Teams, Zoom, Meet) or pasted text and opens the same AI draft.

Flags: **Mark as Escalated** in the header (it then appears on the Escalation Tracker); the **Emergency** checkbox is on All fields. Both need \`work_orders\` edit and edit on the field.

Technicians (the **People** tab, **Technicians**, the **Technicians** card): **Find a technician** opens the map (needs \`vendor_map\` view); filter by **Trade**, **Availability** and **Show**, pick one and click **Hire for <WO#>** (needs \`vendor_map\` create).

Checklist (no tab button; opened from a link to the work order's checklist): type a step in the add box, or paste several one per line, click **Add**; tick steps as they are done.

### Incoming Work Orders (sidebar: Incoming Work Orders)

Two tabs: **To accept** (needs \`approvals/intake\` view) and **Drafts** (needs \`intake\` view).

- Accept a work order: on **To accept** click **Accept**, choose **Assign to**, click **Accept and assign** (needs \`approvals/intake\` approve). **Who’s available?** beside Assign to lists the people assigned to that client in Admin › Users, or **All dispatchers**, each with the number of active work orders they hold across every client; **Fewest first** / **Most first** flips the order, the chevron on a row shows their work orders per status, and clicking a name picks them. The same button sits beside the Assignee on **New work order**, on a draft, and on the Assignee seat of a work order. Accept stays locked while the row says **Fill before assigning: …**; the fields it needs are Received on, Due date, SLA, Address, City, State, Zip code, Store, Trade, WO description, FM, Comp and Client NTE.
- Reject one: **Reject**, type the reason, **Reject with note**.
- Draft a new work order: on **Drafts** click **New work order** (needs \`intake\` create), fill the fields and the **Assignee**, **Save draft** to keep it, and when it shows **Ready to submit** click **Submit & assign** (needs \`intake\` edit). That creates the work order already assigned.
- **Discard**, then **Yes, discard**, removes a draft.`;

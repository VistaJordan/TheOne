// 0068 · The assistant's guide, part 2: money, approvals, maintenance,
// vendors, the portfolio, client updates and dashboards. See assistantGuide.ts
// for the rules of this text (labels are the ones on screen; "needs" is what
// the API checks).

export const GUIDE_MODULES = `### Quotes (sidebar: Quotes; also the **Client quote** card on a work order)

Lanes on the Quotes page: **All**, **Drafts**, **Pending approval**, **Approved**, **Sent**. One quote per work order. It can be edited only while it is a draft or pending approval.

- Start a quote (needs \`quotes\` create): on the work order's **Client quote** card click **Create quote**, then **Create quote** again in the builder. Fill **Tech reported that…** (required), add priced lines with **Add line**, scope with **Add scope line**, alternatives with **Add option**. It saves by itself as you type.
- Send it for approval (needs \`quotes\` edit): fix anything the red chip flags, then click **Submit for approval**.
- Approve and send (needs \`quotes\` approve): in the builder **Approve & Send to CMMS**; on the Quotes list **Approve & send**; in Approvals › **Quotes**, **Approve** then **Approve quote** (that approves only; sending is done from the builder).
- Send back (needs \`quotes\` approve): **Reject with note** in the builder, or **Decline** on the list; a note is required, and the quote returns to draft.
- Print: **Print / PDF**, then save as PDF from the print dialog.
Rule: approving and sending are locked while an NTE increase is open on the work order ("On hold — decide the NTE override under Approvals first"). Rejecting is never locked.

### Payments (sidebar: Payments; also the **Payment requests** card on a work order)

Lanes: **Needs approval**, **To process**, **All requests**, **Vendor bills**.

- Request a vendor payment (needs \`payments\` create): on the work order's **Payment requests** card click **Request payment**, pick the **Vendor record**, fill **Purpose**, **Amount** and **Method**, then **Submit payment request**.
- Approve or reject (needs \`payments\` approve): Payments › **Needs approval**, **Approve** then **Approve payment**, or **Reject**, give the reason, **Reject with note**.
- Pay it (needs \`payments/process\` edit, normally accounts payable): Payments › **To process**, **Send to Yoda** (optional **Yoda reference**), and later **Mark paid**.
- Record a vendor's bill (needs \`payments\` create): Payments › **Vendor bills**, **Record bill**, fill the work order, **Vendor**, **Their invoice #**, dates and lines, **Record bill**. Then **Approve** (\`payments\` approve), **Mark paid** (\`payments/process\` edit), or **Dispute** with what is wrong; **Credit note** raises a credit against it.
Rules: every accepted payment request (approved, sent to Yoda or paid) counts toward the work order's Cost, which is their total; rejecting one takes it back out. If that total passes the NTE, an NTE increase request is raised in Approvals. Approving a payment and sending it to Yoda are locked while an NTE increase is open on the work order. Approval tiers by amount (set in Admin › Settings) can limit which roles may approve a payment or a bill of a given size; a role outside the band sees the button locked.

### Receivables (sidebar: Receivables)

Tabs **Audit** and **Invoicing**. Invoicing stages: **All**, **Proposed**, **Ready**, **Drafts**, **Sent**, **Paid**.

- A work order becomes **Ready** to invoice when its audit is clean and the Admin and Quote checks are ticked on the **Audit** tab.
- Raise an invoice (needs \`invoicing\` create): on a ready row click **Raise invoice**; it is drafted from the approved quote. One invoice per work order.
- Send it (needs \`invoicing\` approve): **Send** on the draft row. Amount tiers apply; an invoice totalling zero cannot be sent; its figures are fixed once sent.
- Mark it paid (needs \`invoicing\` edit): **Mark paid** on the sent row.
- Proposed invoices: when a contract has **Bill automatically on completion** ticked, a proposal appears under **Proposed** when the work order is completed; **Confirm** files the invoice, **Dismiss** drops it (needs \`invoicing\` create).

### Contracts (sidebar: Contracts)

Client rate cards and vendor terms. **New contract**, fill **Name**, **Whose terms**, **Kind** and **Starts**, add each rate with **Add rate**, **Create contract** (needs \`contracts\` create). **Edit** then **Save contract** (\`contracts\` edit); the trash icon then **Delete contract** (\`contracts\` delete). Lanes: **In force**, **All**. The quote builder prices labour from the contract that applies to the work order.

### Purchasing (sidebar: Purchasing)

Tabs: **Requests**, **Requests for quotation**, **Purchase orders**, **Budgets**; each shows only with its own view permission.

- Purchase request (needs \`purchasing/requests\` create): **New request**, fill **What is being bought** and the **Items** (**+ Add a line**), optionally the **Work order**, then **Save as draft** or **Submit for approval**. A manager opens it and clicks **Approve**, or writes a **Note to the requester** and clicks **Reject** (needs \`purchasing/requests\` approve). From an approved request: **Ask vendors for quotes** or **Raise a purchase order**.
- Request for quotation (needs \`purchasing/rfqs\` create or edit): **New request for quotation**, fill what is to be quoted, the items and the vendors, **Save as draft**; **Mark as sent to vendors** (this records it; nothing is emailed); **Record quote** for each vendor's answer; **Award** on the chosen one, which drafts a purchase order.
- Purchase order (needs \`purchasing/orders\` create or edit): **New purchase order**, pick the **Vendor** and **Items**, **Save as draft**; **Issue the order** (needs \`purchasing/orders\` approve); when goods arrive enter the quantities and **Save what arrived**; **Close the order**. **Print / PDF** prints it.
- Budgets (needs \`purchasing/budgets\` edit): add a **Cost center** (Code, Name) or an **AFE** (AFE number, Amount authorized, Title).
Rules: a purchase order never changes a work order's Cost. Going over a budget or an AFE warns and does not block.

### Approvals (sidebar: Approvals)

Sections: **All**, **NTE increases**, **Status changes**, **Manager reviews**, **Quotes**, **Payments**. Lanes: **For me**, **Open**, **Done**, **My requests**. Needs \`approvals\` view; deciding in a section needs that section's approve (\`approvals/nte\`, \`approvals/status\`, \`approvals/reviews\`), and a quote or a payment also needs \`quotes\` approve or \`payments\` approve.

- Decide: on the row click **Approve** (optional **Note**), or **Reject**, say why, **Reject with note**. **Claim** takes a task for yourself. Open rows are oldest first, and each is decided on its own.
- Your own requests: under **My requests**, **Withdraw** cancels one that is still open; after a decision click **Continue** (approved) or **Understood** (rejected) to clear it.
- An approved status change request moves the work order by itself.

### Planned Maintenance (sidebar: Planned Maintenance)

Recurring jobs that raise their own work orders. **New schedule**, fill **What is the job?**, **How often** and **First due on** (all required), plus the client, store, trade and NTE, optionally a **Job plan** whose steps become the checklist; **Create schedule** (needs \`planned_maintenance\` create). On a row: **Raise now**, **Skip**, **Edit** then **Save schedule** (\`planned_maintenance\` edit), or the trash icon then **Delete schedule** (\`planned_maintenance\` delete). Each work order it raises starts in the status PM Sched.

### Maintenance (sidebar: Maintenance)

Tabs: **Assignment**, **Job plans**, **Services**, **Time tracker**, **Work permits**; each needs its own view permission.

- Assign work orders in bulk (needs \`maintenance/assignment\` edit): on **Assignment** pick **Unassigned**, **Everything open** or a person, tick work orders, choose in **Assign to…**, click **Assign**.
- Job plan (needs \`maintenance/job_plans\` create): **New job plan**, **Name**, **Steps** one per line, **Add job plan**. A plan is applied from a work order's Checklist tab or by a planned-maintenance schedule.
- Service (needs \`maintenance/services\` create): **New service**, **Name**, **Unit**, **Price per unit**, **Cost per unit**, **Add service**.
- **Time tracker** and **Work permits** are lists here. Time is logged on a work order's Timelog tab (\`maintenance/time\` create); a permit is written on a work order's Related tab (\`maintenance/permits\` create) and decided by someone with \`maintenance/permits\` approve.

### Vendors (sidebar: Vendors)

Views: **List**, **Board**, **Tasks**, **Alerts**, **Data quality**, **Performance**, **Coverage map**.

- Add a vendor (needs \`vendors\` create): **Add vendor**, fill **Name** (required), **Kind**, **Primary trade**, **City**, **State** and phones, **Add vendor**. "This may already be on file." warns of a likely duplicate; "Still needed:" lists required fields.
- Edit: open the vendor, **Edit**, **Save changes** (\`vendors\` edit). **Remove** needs \`vendors\` delete.
- Documents and insurance: on the vendor's **Documents**, pick the document type and **Upload** (needs \`vendors/documents\` create). A reviewer approves it or sends it back (\`vendors/review\` approve). Insurance dates are added on the **Insurance dates** card.
- Blacklist: on the vendor's **Notes**, type the reason, tick **Blacklist with this as the reason**, **Mark blacklisted** (needs \`vendors/blacklist\` create). **Clear blacklist** needs \`vendors/blacklist\` edit. A blacklisted vendor cannot be assigned to a work order.
- Save a list: set filters on **List**, **Save as a list**, give a **Name** and **Who sees it**, **Save list** (needs \`vendors/lists\` create).
- Import: **Import**, choose the kind and a CSV, map the columns, **Check the file**, choose how to treat duplicates, **Import N rows** (needs \`vendors/import\` create). **Export CSV** needs \`vendors/export\` view.

### Sites, Assets, Clients (sidebar: Sites, Assets, Clients)

- Site (needs \`sites\` create / edit / delete): **Add site**, fill **Client**, **Store number**, address, **Add site**. Open a site to **Edit**, add a **Building** or **Space**, or **Add asset**. On a site that came from Ecotrak, the name, client, store number and address are locked.
- Asset (needs \`assets\` create / edit / delete): **Add asset**, pick the **Site**, fill **Name** and **Category**, **Add asset**. On an asset: **Edit**, **Record a reading** for its condition.
- Asset requests, for people who may not change assets directly: Assets › **Requests** › **Request a new asset**, or on an asset **Request a change**, say what and why, **Send the request** (needs \`assets/requests\` create). A manager decides under Assets › **Requests** (\`assets/requests\` approve).
- Client (needs \`clients\` create / edit / delete): **Add client**, fill **Name**, **Code**, **Account manager**, **Payment terms**, **Add client**. A client with work orders or sites cannot be removed, only made inactive.

### Client Updates (sidebar: Client Updates)

A tracker per client, shared read-only.

- Create one (needs \`client_updates\` create): **New tracker**, fill **Client** and **Tracker name**, adjust columns (**Add column**) and charts (**Add chart**), mark each **Client sees it** or **Team only**, **Create tracker**. Change it later under **Settings**.
- Share it (needs \`client_updates/share\` edit): **Share**, then the **Client link** tab (switch the link on, **Copy link**; **Make a new link** kills the old one), the **Email** tab (**To**, **Subject**, **Send a test to me**, **Send now**), or the **Schedule** tab (switch on **Send this update automatically**, choose how often and when, **Save schedule**). If a banner says email is not switched on for the site, nothing is sent.

### Dashboard and Pulse (sidebar: Dashboard, Pulse)

- Dashboard tabs **Needs Attention** and **Main Dashboard** are built in. Add your own (needs \`dashboard\` create): click **+** at the end of the tabs, name it, **Create dashboard**; it starts private. On your dashboard, **Add card**, say what it is called, how it looks, what it measures and which work orders, **Add card**. **Share…** opens it to everyone, to roles or to people one by one; which roles see which dashboard is set in Admin › Roles under **Which dashboards**. Only a dashboard's owner or a super admin can change it. Each card counts only what the viewer may see, and clicking a number opens the list behind it.
- Pulse shows deadlines in three columns: **Needs me now**, **Due soon**, **Watching**. **Snooze** a card by picking a duration and giving a **Reason**. Snoozing a critical one needs an assistant team lead or above.`;

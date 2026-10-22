// 0068 · The assistant's guide, part 2: money, approvals, maintenance,
// vendors, the portfolio, client updates and dashboards. See assistantGuide.ts
// for the rules of this text (labels are the ones on screen; "needs" is what
// the API checks).

export const GUIDE_MODULES = `### Quotes (sidebar: Quotes; also the **Client quote** card on a work order)

Lanes on the Quotes page: **All**, **Drafts**, **Pending correction**, **Pending approval**, **Approved**, **Sent**. One quote per work order. It can be edited only while it is a draft, pending correction or pending approval.

- Start a quote (needs \`quotes\` create): on the work order's **Client quote** card click **Create quote**, then **Create quote** again in the builder. Fill **Tech reported that…** (required, one line that grows). Each section opens with five **Required is to…** lines ("Full inspection of the working area" first, "Clean the working area" last — any line can be removed) and a Trip service line at the rate card's trip rate; **Add scope line** adds a line above the last one; **Add line** adds a priced line (Day is 1 unless **Multi-day job** shows the Day column). One option is already open and carries no name; **Add another option** adds Option A, B… with names. Required fields turn red only after a Submit is tried while they are empty. It saves by itself as you type.
- Send it on (needs \`quotes\` edit): fix anything the red chip flags, then click the Submit button. For a dispatcher (OM Under Probation, OM, Senior OM) it reads **Submit for correction**: the quote goes to a manager, who corrects it in the builder (edits there do not return it to draft) and clicks **Submit for approval**; in Approvals › **Quotes** such a row offers **Correct and submit**. For a manager it reads **Submit for approval** straight away. Whoever submits for approval cannot approve it (maker ≠ checker).
- Approve (needs \`quotes\` approve): in the builder **Approve**; on the Quotes list **Approve**; in Approvals › **Quotes**, **Approve** then **Approve quote**. Approving is the internal yes only — nothing goes to the client.
- Send to the client (needs \`quotes\` approve, the quote approved): in the builder **Send to client**. This posts the client-visible "Quote … sent to the client for approval" message and moves the work order to Waiting for Approval (when that status exists and the work order is not further along).
- Record the client's decision: in the builder, on the option the client chose click **Record client decision — approved** (it needs a note saying how they approved, or a file on the work order picked under **Client’s approval on file**), or **Record client decision — declined** with their reason; confirm with **Record client decision**. The three quote acts are always **Approve** (the internal yes), **Send to client**, **Record client decision**. Approval moves the work order to Approved; a decline moves it back to Waiting for Quote.
- Send back (needs \`quotes\` approve): **Reject with note** in the builder, or **Decline** on the list; a note is required, and the quote returns to draft.
- Print: **Print / PDF**, then save as PDF from the print dialog.
Rule: approving and sending are locked while an NTE increase is open on the work order ("On hold — decide the NTE override under Approvals first"). Rejecting is never locked.

### Payments (sidebar: Payments; also the **Payment requests** card on a work order)

Lanes: **Needs approval**, **To pay**, **All requests**, **Vendor bills**; filters **Search**, **Company**, **W9 needed**, **Pending delete**.

- Request a vendor payment (needs \`payments\` create; an OM or Senior OM's request under $500 is approved as it is raised and goes straight to AP, an OM Under Probation's always waits for approval): on the work order's **Payment requests** card click **Request payment**, pick the **Vendor record** (or name the technician and phone by hand), pick the **Purpose** — J (Job), M (Materials) or A (Assessment); a repeat on the same work order is numbered J1, J2… by itself — fill **Amount** and **Method** with its payout details, then **Submit payment request**. A blacklisted technician cannot be paid ("This technician is blacklisted — AP cannot pay them").
- Approve or reject (needs \`payments\` approve; the amount's band decides who — $500 to $3,000 a TL or ATL, $3,000 and over an AM; under $500 anyone with the grant — and the button says so when it is not you): Payments › **Needs approval**, **Approve** (it approves at once, there is no confirm step); or **Reject**, fill **Reason for the requester**, **Reject** again — the request becomes **Rejected** (the reason shows on the row and as an internal comment on the work order; only a **Requested** one can be edited, so delete it and request again). The same rows sit in Approvals › **Payments** (**Approve** — no confirm step).
- Pay it (needs \`payments/process\` edit, normally accounts payable): Payments › **To pay** lists the approved ones, **Mark paid**. A request has to be approved before it can be paid. **Change method** switches how it is sent.
- Delete a request: **Delete**, fill **Deletion reason**, **Delete** again (the requester or AP). An approved or paid one waits as pending delete until an admin clicks **Confirm delete** or **Keep** (needs \`payments/process\` delete); an admin's own delete is immediate.
- Record a vendor's bill (needs \`payments\` create): Payments › **Vendor bills**, **Record bill**, fill the work order, **Vendor**, **Their invoice #**, dates and lines, **Record bill**. Then **Approve** (\`payments\` approve), **Mark paid** (\`payments/process\` edit), or **Dispute** with what is wrong and **Resolved** once settled; **Credit note** then **Raise credit note** raises a credit against it.
Rules: whoever requested a payment cannot approve or pay it, and whoever recorded a vendor bill cannot approve it ("someone else has to approve it (maker ≠ checker)"); a super admin may, and the audit row says so. Paying a request adds its amount to the work order's Cost, and deleting a paid one takes it back out. Before approving or paying, a payment that would take Cost past the NTE raises an NTE override in Approvals, and one that would go past the approved quote raises a hold under Approvals › **Money holds**; the click is refused until a manager approves it, then the same button goes through. A vendor bill above what is still owed against the approved quote is held the same way. While an NTE override is open, approving or paying is locked ("On hold — the NTE override on this work order has to be decided first"). Approval tiers by amount (Admin › Settings) limit which roles may approve a vendor bill or send a client invoice of a given size; payment requests are not tier-gated.

### Receivables (sidebar: Receivables; needs \`invoicing\` view)

Tabs **Audit** and **Invoicing**. Invoicing stages: **All**, **Proposed**, **Ready**, **Drafts**, **Sent**, **Paid**.

- **Audit** is a browser-side prototype (its banner says so): Done work orders checked against what the lists carry. A dash means The One does not track that fact yet; it is never a finding. Filter with **All**, **Major**, **Minor**, **Clean**; click a row for **Auto-check results** and **Findings**. Its ticks are not saved and decide nothing on Invoicing.
- A work order is **Ready** to invoice when it is in the Done group, its quote is approved, sent or client-approved, and it has no invoice yet.
- Raise an invoice (needs \`invoicing\` create): on a ready row click **Raise invoice**; it is drafted from the approved quote. Only once the work order is done (Done / Incurred or later). One live invoice per work order — raising it again opens the one already there.
- Send it (needs \`invoicing\` approve): **Send** on the draft row. Not by the person who raised it; amount tiers apply; an invoice totalling zero cannot be sent; its figures are fixed once sent. Sending sets the work order's Total Invoiced to the invoice total.
- Mark it paid (needs \`invoicing\` edit): **Mark paid** on the sent row, then fill **Payment reference** and **Date paid**.
- Proposed invoices: when a contract has **Bill automatically on completion** ticked, a proposal appears under **Proposed** when the work order is completed; **Confirm** files the invoice, **Dismiss** drops it (needs \`invoicing\` create).
- The lists are windows: the 500 most recent Done work orders, the 200 most recently updated quotes and the 500 newest invoices. A notice says when one is hit; a Done work order whose quote is past the window reads "not checked" and does not reach Ready.

### Contracts (sidebar: Contracts)

Client rate cards and vendor terms. **New contract**, fill **Name**, **Whose terms**, **Kind** and **Starts**, add each rate with **Add rate**, **Create contract** (needs \`contracts\` create). **Edit** then **Save contract** (\`contracts\` edit); the trash icon then **Delete contract** (\`contracts\` delete). Lanes: **In force**, **All**. The quote builder prices labour from the contract that applies to the work order.

### Purchasing (sidebar: Purchasing)

Tabs: **Requests**, **Requests for quotation**, **Purchase orders**, **Budgets**; each shows only with its own view permission.

- Purchase request (needs \`purchasing/requests\` create): **New request**, fill **What is being bought** and the **Items** (**+ Add a line**), optionally the **Work order**, then **Save as draft** or **Submit for approval**. A manager other than the requester opens it and clicks **Approve**, or writes a **Note to the requester** and clicks **Reject** (needs \`purchasing/requests\` approve). From an approved request: **Ask vendors for quotes** or **Raise a purchase order**.
- Request for quotation (needs \`purchasing/rfqs\` create or edit): **New request for quotation**, fill what is to be quoted, the items and the vendors, **Save as draft**; **Mark as sent to vendors** (this records it; nothing is emailed); **Record quote** for each vendor's answer; **Award** on the chosen one, which drafts a purchase order.
- Purchase order (needs \`purchasing/orders\` create or edit): **New purchase order**, pick the **Vendor** from the vendor list (a typed name is refused) and the **Items**, **Save as draft**; **Issue the order** (needs \`purchasing/orders\` approve). One live order per purchase request. An order with no request above the PO limit (Admin › Settings, default $5,000) first needs **Approve over limit** from someone other than whoever drafted it; when goods arrive enter the quantities and **Save what arrived**; **Close the order**. **Print / PDF** prints it.
- Budgets (needs \`purchasing/budgets\` edit): add a **Cost center** (Code, Name) or an **AFE** (AFE number, Amount authorized, Title).
Rules: a purchase order never changes a work order's Cost. Going over a budget or an AFE warns and does not block.

### Approvals (sidebar: Approvals)

Sections: **All**, **NTE override (cost over NTE)** (the cost passed the NTE, rule 1.5.2), **NTE increase requests** (manual asks for a higher NTE still open; the button that raised them was removed), **Status changes**, **Manager reviews**, **Quotes**, **Payments**. Lanes: **For me**, **Open**, **Done**, **My requests**. Needs \`approvals\` view; deciding in a section needs that section's approve (\`approvals/nte\`, \`approvals/status\`, \`approvals/reviews\`), and a quote or a payment also needs \`quotes\` approve or \`payments\` approve.

- Decide: on the row click **Approve** (optional **Note**), or **Reject**, say why, **Reject with note**. **Claim** takes a task for yourself. Open rows are oldest first, and each is decided on its own.
- Your own requests: under **My requests**, **Withdraw** cancels one that is still open; after a decision click **Continue** (approved) or **Understood** (rejected) to clear it.
- An approved status change request moves the work order by itself.

### Planned Maintenance (sidebar: Planned Maintenance)

Recurring jobs that raise their own work orders. **New schedule**, fill **What is the job?**, **How often** and **First due on** (all required), plus the client, store, trade and NTE, optionally a **Job plan** whose steps become the checklist; **Create schedule** (needs \`planned_maintenance\` create). On a row: **Raise now**, **Skip**, **Edit** then **Save schedule** (\`planned_maintenance\` edit), or the trash icon then **Delete schedule** (\`planned_maintenance\` delete). Each work order it raises starts in the status PM Sched.

### Maintenance (sidebar: Maintenance)

Tabs: **Assignment**, **Job plans**, **Services**, **Time tracker**, **Work permits**; each needs its own view permission.

- Assign work orders in bulk (needs \`maintenance/assignment\` edit): on **Assignment** pick **Unassigned**, **Everything open** or a person, tick work orders, choose in **Assign to…**, click **Assign**.
- Job plan (needs \`maintenance/job_plans\` create): **New job plan**, **Name**, **Steps** one per line, **Add job plan**. A plan is applied from a work order's Checklist (no tab button; reached from a link) or by a planned-maintenance schedule.
- Service (needs \`maintenance/services\` create): **New service**, **Name**, **Unit**, **Price per unit**, **Cost per unit**, **Add service**.
- **Time tracker** and **Work permits** are lists here. Time is logged on a work order's **CICO** tab, in the **Technician time** card under the visits (\`maintenance/time\` create); a permit is written on a work order's Related view, opened from the permit's work-order link (\`maintenance/permits\` create) and decided by someone with \`maintenance/permits\` approve.

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
- Pulse (needs \`work_orders\` view; it lists only the work orders the person may see, the same book as the Work Orders list) shows deadlines in three columns: **Needs me now**, **Due soon**, **Watching**. **Snooze** a card by picking a duration under **Snooze for** (up to 72 hours) and giving a **Reason** (required); a snooze on a work order outside the person's book answers "This work order is not assigned to you". Snoozing a critical one needs an assistant team lead or above. Someone without \`approvals/snooze\` approve (the dispatcher tiers, VR Officer, OP Admin) sees **Request snooze** instead: the ask lands in Approvals under **Snooze requests**, the card reads **Snooze requested** and the clock keeps running until a manager approves it; a manager's **Approve** applies the snooze and **Reject** needs a note.`;

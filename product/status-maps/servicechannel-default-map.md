# ServiceChannel: default The one status map

**Default map for every ServiceChannel client** · 2026-10-08

Each client starts from this map. Changes for a specific client go in that client's own file (`servicechannel-<client>.md`). The reasoning behind the fixes is in [servicechannel-review.md](servicechannel-review.md).

## Final logic (summary)

**Moves allowed in The one**
* New -> can change to: Open (pushes DISPATCH CONFIRMED), Cancelled / Postponed (pushes DECLINED)
* Open -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment), On Site (Job), Cancelled / Postponed
* Assessment Sched -> can change to: Job Sched, PM Sched, On Site (Assessment), Cancelled / Postponed
* Job Sched -> can change to: Assessment Sched, PM Sched, On Site (Job), Cancelled / Postponed
* PM Sched -> can change to: Assessment Sched, Job Sched, On Site (Assessment), On Site (Job), Cancelled / Postponed
* On Site (Assessment) -> can change to: Return Trip Needed, Waiting for Quote, Waiting for Parts, Please Order Parts, Done / Incurred
* On Site (Job) -> can change to: Return Trip Needed, Waiting for Quote, Waiting for Parts, Please Order Parts, Waiting for Approval, Done / Incurred
* Please Order Parts -> can change to: Return Trip Needed, Waiting for Quote, Waiting for Parts, Done / Incurred (only while the portal shows ON SITE), Cancelled / Postponed
* Return Trip Needed -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment), On Site (Job), Waiting for Advice, Waiting for Quote, Cancelled / Postponed
* Waiting for Quote -> can change to: Quote Ready, Waiting for Advice, Waiting for Approval, Cancelled / Postponed
* Waiting for Parts -> can change to: Job Sched, On Site (Job), Waiting for Advice, Waiting for Quote, Cancelled / Postponed
* Quote Ready -> can change to: Waiting for Advice, Waiting for Approval, Cancelled / Postponed
* Waiting for Advice -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment), On Site (Job), Waiting for Quote, Cancelled / Postponed
* Waiting for Approval -> can change to: Waiting for Quote (before the client approves); Job Sched, Please Order Parts or Waiting for Parts (once the client approves); Cancelled / Postponed (any time)
* Done / Incurred -> can change to: Ready to Invoice
* Ready to Invoice -> can change to: Invoiced
* Invoiced -> can change to: Invoiced Not Paid
* Invoiced Not Paid -> can change to: Invoiced
* Cancelled / Postponed -> can change to: Open (only if it was cancelled in The one and the portal still shows DISPATCH CONFIRMED)

**Rules behind the moves**
1. Every move is checked against the last status pushed to ServiceChannel.
2. A status with no ServiceChannel equivalent pushes nothing, so the portal keeps showing its last status.
3. When ServiceChannel needs two steps to reach a status, The one pushes both:
   - Moving to Waiting for Parts from a visit pushes INCOMPLETE, then PARTS ON ORDER.
   - Moving to Waiting for Quote while the portal shows PARTS ON ORDER pushes INCOMPLETE, then WAITING FOR QUOTE.
4. Once the client approves, the portal shows PROPOSAL APPROVED, which can only move to INCOMPLETE or PARTS ON ORDER:
   - Job Sched and Please Order Parts push INCOMPLETE.
   - Waiting for Parts pushes PARTS ON ORDER.
5. Moving to Waiting for Approval submits the proposal in ServiceChannel, which sets WAITING FOR APPROVAL.
6. Cancelling in The one doesn't change the portal. The only exception is declining a New work order, which pushes DECLINED.

**When the client changes the status on the portal**
* OPEN (new work order): The one creates it as New
* PROPOSAL APPROVED: unlocks the moves for an approved quote out of Waiting for Approval
* COMPLETED/NO CHARGE: the client cancelled, so The one moves the work order to Cancelled / Postponed. The one never pushes NO CHARGE itself.
* COMPLETED/PENDING CONFIRMATION that The one didn't push: the client cancelled, so The one moves the work order to Cancelled / Postponed. If The one pushed it, the work order is just Done / Incurred.

## What each The one status pushes
| The one status | ServiceChannel |
|---|---|
| New | nothing (the portal shows OPEN) |
| Open | IN PROGRESS/DISPATCH CONFIRMED |
| On Site (Assessment), On Site (Job) | INPROGRESS/ON SITE |
| Return Trip Needed | INPROGRESS/INCOMPLETE |
| Waiting for Parts | INPROGRESS/PARTS ON ORDER |
| Waiting for Quote | INPROGRESS/WAITING FOR QUOTE |
| Waiting for Approval | INPROGRESS/WAITING FOR APPROVAL (set by submitting the proposal) |
| Done / Incurred | COMPLETED/PENDING CONFIRMATION, always (jobs are always billable) |
| Cancelled / Postponed | nothing (DECLINED only when declining a New work order) |
| Assessment Sched, Job Sched, PM Sched, Quote Ready, Please Order Parts, Waiting for Advice, Ready to Invoice, Invoiced, Invoiced Not Paid | nothing |

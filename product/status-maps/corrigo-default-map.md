# Corrigo: default The one status map

**Default map for every Corrigo client** · 2026-10-08

Each client starts from this map. Changes for a specific client go in that client's own file (`corrigo-<client>.md`).

The fixes from [corrigo-review.md](corrigo-review.md) are applied. A quote can't be submitted from New (Jack, confirmed); every work order is accepted first.

## Final logic (summary)

**Moves allowed in The one** (the buttons the bot presses are in brackets)
* New -> can change to: Open [Accept], Cancelled / Postponed [Reject > Write the Reason > Reject]
* Open -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Cancelled / Postponed [Reject > Write the Reason > Reject]
* Assessment Sched -> can change to: Job Sched, PM Sched, On Site (Assessment) [Check In], Cancelled / Postponed
* Job Sched -> can change to: Assessment Sched, PM Sched, On Site (Job) [Check In], Cancelled / Postponed
* PM Sched -> can change to: Assessment Sched, Job Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Cancelled / Postponed
* On Site (Assessment) -> can change to: Return Trip Needed [Pause], Waiting for Quote [Pause], Waiting for Parts [Pause], Please Order Parts, Done / Incurred [Check Out > OK]
* On Site (Job) -> can change to: Return Trip Needed [Pause], Waiting for Quote [Pause], Waiting for Parts [Pause], Please Order Parts, Done / Incurred [Check Out > OK]
* Please Order Parts -> can change to: Return Trip Needed [Pause], Waiting for Quote [Pause], Waiting for Parts [Pause], Done / Incurred [Check Out > OK], Cancelled / Postponed
* Return Trip Needed -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Waiting for Advice, Waiting for Quote, Cancelled / Postponed
* Waiting for Quote -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Quote Ready, Waiting for Advice, Cancelled / Postponed
* Waiting for Parts -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Quote Ready, Waiting for Advice, Waiting for Approval [Submit quote], Cancelled / Postponed
* Quote Ready -> can change to: Waiting for Advice, Waiting for Approval [Submit quote, or Resubmit Quote after a rejection], Cancelled / Postponed
* Waiting for Advice -> can change to: Assessment Sched, Job Sched, PM Sched, On Site (Assessment) [Check In], On Site (Job) [Check In], Waiting for Quote, Cancelled / Postponed
* Waiting for Approval -> can change to: Job Sched, PM Sched, On Site (Job) [Check In] (only once the client approves); Quote Ready (once the client rejects); Cancelled / Postponed (any time)
* Done / Incurred -> can change to: Ready to Invoice
* Ready to Invoice -> can change to: Invoiced
* Invoiced -> can change to: Invoiced Not Paid
* Invoiced Not Paid -> can change to: Invoiced
* Cancelled / Postponed -> can change to: Open (only if it was cancelled internally while Corrigo still shows Accepted; a work order rejected on Corrigo can't be reopened)

**Rules behind the moves**
1. Every move is checked against the last Corrigo state the bot reached.
2. A status with no Corrigo equivalent presses nothing.
3. Return Trip Needed, Waiting for Quote and Waiting for Parts all press Pause, and the bot posts a chat message saying which one it is.
4. Cancelling a New or Open work order presses Reject with a reason, which The one must ask for. Cancelling later is internal.

**When the client acts on Corrigo**
* NEW work order: The one creates it as New
* Quote Approved: opens the moves out of Waiting for Approval
* Quote Rejected: opens Waiting for Approval → Quote Ready, for a resubmit
* Client cancels: the bot sees **"This WO is no longer available"** and can't send chat messages or change anything. The one moves the work order to **Cancelled / Postponed**, stops all bot actions and chat messages on it, and the cancel is final (confirmed by Jack)

## What each The one status presses
| The one status | Bot presses on Corrigo |
|---|---|
| Open | Accept |
| On Site (Assessment), On Site (Job) | Check In |
| Return Trip Needed, Waiting for Quote, Waiting for Parts | Pause (plus a chat message with the reason) |
| Waiting for Approval | Submit quote (Resubmit Quote after a rejection) |
| Done / Incurred | Check Out > OK (→ Completed) |
| Cancelled / Postponed | Reject > Write the Reason > Reject from New or Open, otherwise nothing |
| All other statuses | nothing |

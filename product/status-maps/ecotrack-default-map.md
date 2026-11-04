# EcoTrack: default The one status map

**Default map for every EcoTrack client** · Set by Jack on 2026-10-08

Each client starts from this map. Changes for a specific client are kept in that client's own modifications file and override this one.

This is Jack's original map with the decisions from the review applied. The reasoning behind each change is in [ecotrack-review.md](ecotrack-review.md).

## Final logic (summary)

**Moves allowed in The one**
* New -> can change to: Open (accepts the work order in EcoTrack), Cancelled / Postponed
* Open -> can change to: Assessment Sched, Job Sched, PM Sched, Waiting for Advice, Cancelled / Postponed
* Assessment Sched -> can change to: On Site (Assessment), Assessment Sched (reschedule), Open (only while the portal still shows Accepted), Waiting for Advice, Cancelled / Postponed
* Job Sched -> can change to: On Site (Job), Job Sched (reschedule), Open (only while the portal still shows Accepted), Waiting for Advice, Cancelled / Postponed
* PM Sched -> can change to: On Site (Job), Open, Cancelled / Postponed
* On Site (Assessment) -> can change to: Return Trip Needed, Waiting for Quote, Waiting for Advice
* On Site (Job) -> can change to: Done / Incurred, Return Trip Needed, Please Order Parts, Waiting for Parts, Waiting for Quote, Waiting for Advice
* Return Trip Needed -> can change to: Job Sched, Please Order Parts, Waiting for Parts, Waiting for Advice, Cancelled / Postponed
* Waiting for Quote -> can change to: Quote Ready, Waiting for Advice, Cancelled / Postponed
* Quote Ready -> can change to: Waiting for Approval (submitting the proposal), Cancelled / Postponed
* Waiting for Approval -> can change to: Job Sched, Please Order Parts or Waiting for Parts (once the client approves); Done / Incurred or Return Trip Needed (once the client rejects); Cancelled / Postponed (any time)
* Please Order Parts -> can change to: Waiting for Parts, Waiting for Advice, Cancelled / Postponed
* Waiting for Parts -> can change to: Job Sched, Cancelled / Postponed
* Waiting for Advice -> can change to: Assessment Sched, Job Sched, Open (only while the portal still shows Accepted), Return Trip Needed (not while the portal shows Accepted, Proposal Submitted or Proposal Approved), Cancelled / Postponed
* Done / Incurred -> can change to: Ready to Invoice
* Ready to Invoice -> can change to: Invoiced
* Invoiced -> can change to: Invoiced Not Paid
* Invoiced Not Paid -> can change to: Invoiced
* Cancelled / Postponed -> can change to: Open (only if it was cancelled in The one and the portal still shows Accepted)

**Rules behind the moves**
1. Every move is checked against the last status pushed to EcoTrack.
2. A status with no EcoTrack equivalent pushes nothing, so the portal keeps showing its last status.
3. When a work order moves to Assessment Sched or Job Sched while the portal shows Arrived or Pending Parts, The one pushes Return Visit Required.
4. Moving to On Site (Assessment) or On Site (Job) pushes En route, then Arrived.
5. Cancelling in The one doesn't change the portal, because EcoTrack doesn't let us set Canceled.

**When the client changes the status on the portal**
* Pending SP Acceptance (new work order): The one creates it as New
* Proposal Approved or Proposal Rejected: unlocks the matching moves out of Waiting for Approval
* Canceled: The one moves the work order to Cancelled / Postponed, and the cancel is final

## Details

### General rules
1. **Remember the last push.** Every work order stores the last EcoTrack status pushed. A move is allowed only if its push is allowed in EcoTrack from that status.
2. **Internal statuses push nothing.** These are the statuses with no EcoTrack equivalent: Assessment Sched, Job Sched, PM Sched, Quote Ready, Please Order Parts, Waiting for Advice, Ready to Invoice, Invoiced and Invoiced Not Paid. Cancelled / Postponed also pushes nothing, because EcoTrack doesn't let us set Canceled.
3. **Starting a new visit.** When a work order moves into Assessment Sched or Job Sched while the portal shows Arrived or Pending Parts, push **Return Visit Required**. This fixes two problems:
   - From Pending Parts, EcoTrack can't move to En route, so the visit would get stuck.
   - From Arrived, the new visit would otherwise never show on the portal.
4. **On Site statuses push two steps.** Moving into On Site (Assessment) or On Site (Job) pushes En route, then Arrived. If clients track arrival times, En route should be pushed when the tech is dispatched.

### Moves allowed in The one (with pushes)

| From | To | Pushes to EcoTrack | Condition |
|---|---|---|---|
| **New** | Open | Accept the work order → Accepted | |
| New | Cancelled / Postponed | nothing | |
| **Open** | Assessment Sched, Job Sched, PM Sched, Waiting for Advice | nothing | |
| Open | Cancelled / Postponed | nothing | |
| **Assessment Sched** | On Site (Assessment) | En route, then Arrived | |
| Assessment Sched | Assessment Sched (reschedule) | nothing, sends a reschedule message | |
| Assessment Sched | Open | nothing | Portal still shows Accepted |
| Assessment Sched | Waiting for Advice, Cancelled / Postponed | nothing | |
| **Job Sched** | On Site (Job) | En route, then Arrived | |
| Job Sched | Job Sched (reschedule) | nothing, sends a reschedule message | |
| Job Sched | Open | nothing | Portal still shows Accepted |
| Job Sched | Waiting for Advice, Cancelled / Postponed | nothing | |
| **PM Sched** | On Site (Job) | En route, then Arrived | |
| PM Sched | Open | nothing | |
| PM Sched | Cancelled / Postponed | nothing | |
| **On Site (Assessment)** | Return Trip Needed | Return Visit Required | |
| On Site (Assessment) | Waiting for Quote | Submitting Proposal | |
| On Site (Assessment) | Waiting for Advice | nothing | |
| **On Site (Job)** | Done / Incurred | Completed | |
| On Site (Job) | Return Trip Needed | Return Visit Required | |
| On Site (Job) | Waiting for Parts | Pending Parts | |
| On Site (Job) | Waiting for Quote | Submitting Proposal | |
| On Site (Job) | Please Order Parts, Waiting for Advice | nothing | |
| **Return Trip Needed** | Job Sched, Please Order Parts, Waiting for Advice, Cancelled / Postponed | nothing | |
| Return Trip Needed | Waiting for Parts | Pending Parts | |
| **Waiting for Quote** | Quote Ready, Waiting for Advice, Cancelled / Postponed | nothing | |
| **Quote Ready** | Waiting for Approval | Submitting the proposal sets Proposal Submitted | |
| Quote Ready | Cancelled / Postponed | nothing | |
| **Waiting for Approval** | Job Sched | nothing | Portal shows Proposal Approved |
| Waiting for Approval | Please Order Parts | nothing | Portal shows Proposal Approved |
| Waiting for Approval | Waiting for Parts | Pending Parts | Portal shows Proposal Approved |
| Waiting for Approval | Done / Incurred | Completed | Portal shows Proposal Rejected |
| Waiting for Approval | Return Trip Needed | Return Visit Required | Portal shows Proposal Rejected |
| Waiting for Approval | Cancelled / Postponed | nothing | |
| **Please Order Parts** | Waiting for Parts | Pending Parts | |
| Please Order Parts | Waiting for Advice, Cancelled / Postponed | nothing | |
| **Waiting for Parts** | Job Sched | Return Visit Required (rule 3) | |
| Waiting for Parts | Cancelled / Postponed | nothing | |
| **Waiting for Advice** | Assessment Sched, Job Sched | nothing (rule 3 applies) | |
| Waiting for Advice | Open | nothing | Portal still shows Accepted |
| Waiting for Advice | Return Trip Needed | Return Visit Required | Portal shows Arrived, Pending Parts, Submitting Proposal, Proposal Rejected or Return Visit Required |
| Waiting for Advice | Cancelled / Postponed | nothing | |
| **Done / Incurred** | Ready to Invoice | nothing | |
| **Ready to Invoice** | Invoiced | nothing | |
| **Invoiced** | Invoiced Not Paid | nothing | |
| **Invoiced Not Paid** | Invoiced | nothing | |
| **Cancelled / Postponed** | Open | nothing | Cancelled in The one and portal still shows Accepted |

**Removed from Jack's draft:**
- Return Trip Needed → Waiting for Quote: EcoTrack doesn't allow Return Visit Required → Submitting Proposal.
- Done / Incurred → Return Trip Needed: Completed is final in EcoTrack. A recall comes in as a new work order.

## When the client changes the status on the portal

| EcoTrack status appears | What The one does |
|---|---|
| Pending SP Acceptance (new work order) | Create it as **New** |
| Proposal Approved | Stays Waiting for Approval; unlocks Job Sched (and the parts moves) |
| Proposal Rejected | Stays Waiting for Approval; unlocks the rejection moves |
| Canceled | Move to **Cancelled / Postponed**. This is final, and reactivating isn't possible |
| Completed- Pending Review, Not Fixed, Deferred, RMA\*, RFP Submitted, Internal Review, Unassigned | _To be decided_ |

## Still open (for the default)
- Should PM Sched → Waiting for Advice be added?
- Should there be a Paid / Closed status after Invoiced?
- When The one cancels internally, should a message ask the client to cancel on the portal?

## Client modifications
Each client gets its own file named `ecotrack-<client>.md`. It lists only the moves that client adds, removes or changes compared with this default.

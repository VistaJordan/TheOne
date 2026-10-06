// 0075 · BRD part: insight — dashboards, the Pulse, the assistant.

import type { DocPart } from '../types';

export const INSIGHT_PART: DocPart = {
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
          name: 'Needs Attention and Main Dashboard',
          what: 'Needs Attention: "No visit logged" (work orders whose Visit Type is not set; opens the list on that filter) and "Awaiting approval" (open approval tasks, with the approvals grant; opens Approvals). Main Dashboard: the KPI tiles Active WOs (open + active + pending), Waiting approval (with "Oldest Nd"), Ready to invoice (with "$X queued", the NTE sum) and Margin (Total Invoiced minus Cost over Total Invoiced, all time despite its "(30d)" label; a placeholder "· est." when nothing is invoiced), plus the person\'s own cards (Add card: Count — how many work orders match a condition; Breakdown — the whole set bucketed by one field, six rows plus Other values and Not set; Duration — average time between two field changes, with median; a card label of 80 characters; Edit / Remove on hover). The two pages are each a tick under Roles › Dashboard › Which dashboards and count with that page\'s "Which work orders it counts".',
          value: 'The at-a-glance page for the morning; the personal cards are a scratchpad (preferences, not audited).',
          permissions: ['dashboard view', 'dashboard/boards/attention view', 'dashboard/boards/main view', 'approvals view for the approval card'],
        },
        {
          name: 'Building a board',
          what: '"+" (Build a dashboard) → New dashboard; it starts private. Add card: What is this card called?; How should it look? (A single number · Bars · A donut · A table · A line over time · A gauge against a target · A live number (re-reads itself) · A block of text · A picture · A button to a page); Asked of (Work orders · Client invoices · Payment requests · Vendor bills · Vendors and technicians · Sites · Assets); What does it measure? (How many <source> · Total of · Average of · Time between two moments); Between which two moments? (From / To: When a field changes "becomes" a value or any change, or A date field\'s value; other sources take two dates); Reduced to (Average · Median); Which number?; Along which date? and Grouped By day / week / month; Cut it by; Which work orders? (Every work order · Open work only · Finished work only); Only these statuses and past due only for the other sources; Read against (target); Re-read every (seconds); The text / Picture URL / Where the button goes / Button reads; Tab and Group heading; How wide? (A quarter / Half / Full width). The footer says what the card Still needs, then Add card / Save card. Remove asks "Remove "X"? The work orders it counted are untouched."',
          value: 'The dashboard the manager wants exists in ten minutes.',
          rules: [
            'Server checks: a text card needs text; a picture needs a URL and a button somewhere to go (http(s):// or /); totals and averages need a numeric field the source has; a line needs a date; a group needs a field; a gauge target is above zero; a live card re-reads no faster than every 5 seconds (default 30, max 3600).',
            'Rename, re-folder and delete a board are API-only today (Share… is the only board-level button); a shipped board that is deleted is re-inserted on the next read, while edits to it stick.',
          ],
          permissions: ['dashboard create (build and share)'],
          since: '0042 / 0049',
        },
        {
          name: 'How cards draw and drill',
          what: 'Eight buckets then "Everything else" (up to 50); a line keeps the 24 most recent points in one hue; money formatting when the field name says so (nte, cost, invoiced, profit, amount, price, total, tax); averages to one decimal; durations as "2d 4h" with "· N work orders"; a gauge with no target reads against the largest plain figure on the board, turning "near" at 80 % and "full" at 100 %; a live dot "Re-reads every Ns"; a card whose field was deleted reports its own error while the rest draw. Clicking a bucket opens the list with the card\'s filters plus the bucket (Not set drills as is not set; Everything else opens the card\'s own list); other sources open Receivables › Invoicing, Payments, Vendor bills, Vendors, Sites or Assets; the drill is plain text when the viewer lacks the list, and the opened list follows the person\'s own Which work orders, never the board\'s.',
          value: 'Every number is a door to the rows behind it.',
        },
        {
          name: 'Sources beyond work orders',
          what: 'Client invoices (total, subtotal, tax, status, client, billing entity, created / issued / due / paid dates; overdue), Payment requests (amount, status, method, payee, client, requested by, billing entity, FM, trade, state, purpose, WO #, the vendor\'s owner / trade / state), Vendor bills (total, status, vendor, client, received / due / paid; overdue), Vendors and technicians (24 fields: status, kind, trades, state, city, owner, paperwork, coverage, W-9 / MSA / COI, blacklisted, rates, jobs; follows the viewer\'s VENDOR scope), Sites and Assets (follow the site restriction). Each source has its own period date (created, received).',
          value: 'The money and the network are measured on the same page as the work.',
        },
        {
          name: 'Period and filter bar',
          what: 'All time · By month · By quarter · By year · Last 30 days with Earlier / Later stepping (UTC; default All time), ANDed into every card on the source\'s own date (work orders: date received). The filter bar (Narrow every card: Client, Billing entity, Trade, Store, Dispatcher; Any; Clear) applies to work-order cards only.',
          value: 'One control re-asks every card.',
          since: '0044',
        },
        {
          name: 'Time between two moments',
          what: 'A duration measure between two legs (the first time a field changed, to a value or at all, or a date field), average or median, cut by a field or drawn along when the span ended; records with no complete span drop out and are never counted as zero.',
          value: 'Accepted → assigned, assigned → technician found, requested → approved are measured from the audit trail.',
        },
        {
          name: 'Sharing',
          what: 'Share…: Everyone who can open dashboards, Roles (only roles with the Dashboard section; written as role grants dashboard/boards/<ref>), or People, one by one (Find a person…; super admins excluded; a per-person override) — "A person ticked here sees this dashboard whatever their role says. What its cards count is still scoped to them — sharing spreads the question, never the rows."; Save sharing. The board header says "Only you can see this dashboard" / "Everyone can see this dashboard" / "Shared with <roles> and <people>" · built by X. Edit (Share…, Add card) is the owner\'s or a super admin\'s.',
          value: 'A board reaches exactly who should see it.',
          audit: ['role_updated', 'user_permissions_set'],
          since: '0050',
        },
        {
          name: 'Shipped boards',
          what: 'Folders Operations / Finance / Clients / Sales. Dispatch Center (open, emergencies, escalated, nobody assigned, open by trade / client / dispatcher, status donut, received by month); Approvals & bottlenecks (nobody assigned, quote clock running, open by phase / account manager / problem type); Money (NTE and Cost on open work, average NTE, total invoiced, cost by trade / entity, profit by client); Accounting (outstanding, overdue, payments awaiting approval, unpaid vendor bills, invoices by status, billed by client, invoiced per month, paid to vendors, a how-to-read note); Payments (paid, approved not yet paid, awaiting approval, average, per month, by status, top vendors, by dispatcher / client / company / method / trade / state); Sites & assets; Vendors; Service levels (past SLA, due today, due within 7 days, a gauge of open work inside SLA, past SLA by client / dispatcher, deadlines by week); Maintenance Supervisor (tabs Today / Team / Trends / Equipment); Vendor Performance (Network / Compliance / Billing); Technician (Jobs / Roster / Pay); Store Manager (Open now / History groups); Unified Ops (Work / Money in / Money out / Vendors / Portfolio); Sales (received, open, emergencies, completed, by client / month / status / trade / city). Inserted on first read and never overwritten once edited.',
          value: 'Every role has a starting board.',
        },
      ],
    },
    {
      key: 'pulse',
      title: 'Pulse (obligations)',
      where: 'Sidebar › Pulse; the bell; the Obligations card on a work order and the Clock column of the list.',
      purpose: 'Who owes what, on which work order, by when, and who hears about it when the clock runs out.',
      value: 'Deadlines chase people instead of people chasing deadlines; the bottleneck of quotes waiting at the client is measured.',
      features: [
        {
          name: 'The seven rules',
          what: 'Ack emergency (Emergency not acknowledged): 2 hours, 24 × 7, on an Open or Emergency work order with high priority, critical on any breach; cleared by any activity on the work order. Quote owed: 2 business days in Waiting for Quote; cleared when any quote exists. ETA owed (after approval): 2 business hours in Approved; cleared by the next status change. Chase client (Client approval needs chasing): 5 business days in Waiting for Approval; cleared by a client-visible staff message or a client update sent, or a status change. Quote review (Quote waiting on review): 4 business hours with the quote pending approval, owed to the ATL role; cleared by approve or reject. Payment owed (Payment request unprocessed): 2 business days in requested, owed to the admin role; cleared by any change on the request. SLA blown: SLA Due Date passed (18:00 Chicago that day) while open or active, with 10 business hours of grace; cleared when the work order leaves open / active. A business day is 10 hours; business clocks pause outside hours. The owner is the dispatcher named by the work order\'s home list, else the owed role.',
          value: 'Each promise has an owner, a clock and a way out.',
          rules: ['The thresholds are rows in the obligation_rule table; there is no admin screen for them yet.'],
          since: '0004',
          deferred: ['Pulse is not scoped by Which work orders and its page is not permission-wrapped: an Only-theirs dispatcher sees every obligation under Watching.'],
        },
        {
          name: 'Tiers, escalation and the columns',
          what: 'Watching below 80 % of the budget, Due soon at 80 %, Breached past 100 %, Critical past 200 % (or any breach of Ack emergency). Each tier pings once: tier 1 the owner (or everyone with the owed role), tier 2 adds TL and ATL, tier 3 adds Admin and AM; with nobody resolvable, ATL / TL / AM / Admin are the backstop. Columns: Needs me now (breached and critical), Due soon (80 % gone), Watching (running clocks); the first two hold what is owed to me, or everything for ATL / TL / AM / Admin. Header "N open obligations · N needs attention now · refreshes every minute"; "All clear — the watchdog is watching." The engine is lazy: re-evaluated on reads and after writes, no cron.',
          value: 'Escalation reaches the right level without a meeting.',
        },
        {
          name: 'Snooze',
          what: 'Presets 1h · 2h · 4h · 8h · 1d · 2d · 3d (72 hours at most), a reason of 3 to 500 characters, measured in business hours for business-clock rules; it resets the clock. A critical (tier 3) obligation can be snoozed only by ATL, TL, AM or Admin. There is no dismiss.',
          value: 'A deadline is moved on the record, with a reason, never silenced.',
          audit: ['obligation_snoozed'],
        },
        {
          name: 'The bell',
          what: 'Badge = unread Pulse pings plus unread "For you" notices (9+ cap); the For you block (Mark all read, 12 rows, each a link) above The Pulse block (12 rows, "<WO> · <rule>", "Breached — 3h past due (business hours). Owed by X."); Open the Pulse. Notice kinds: vendor tasks, reviews and decisions, a vendor handed to you, your vendor blacklisted, insurance expiring (30 / 14 days / expired), NTE increase requested / decided, a work order assigned to you, a work permit needing approval / decided, a credit note to approve, dispatch offers (accepted / declined / nobody took it), a vendor onboarding form, a note from the vendor portal, an asset request / decided, a purchase request needing approval / decided, a purchase order issued. Viewing as shows that person\'s bell.',
          value: 'Nobody has to poll a queue.',
        },
      ],
    },
    {
      key: 'assistant',
      title: 'The assistant',
      where: 'The sparkle in the top bar (shown with the assistant grant).',
      purpose: 'Ask anything about the data and how to use the app; Claude answers from look-ups made at that moment through the app\'s own routes with the asker\'s session, so permissions, scope, site restriction and field redaction apply.',
      value: 'New staff ask the app instead of a colleague; management asks a question instead of building a report; nothing is ever changed by it.',
      features: [
        {
          name: 'The panel',
          what: 'Tabs Ask (becomes Conversation) / Earlier / Taught / Marked answers (the last two with the edit grant); New conversation; starters ("Which work orders are waiting on a quote?", "What is due today?", "How do I save a view of the work orders list?", and on a work order "Summarise this work order", "What happened on this work order in the last week?", "Is anything blocking this work order?"); Enter sends, Shift+Enter a new line; "Looking it up…"; a "Looked up N things" disclosure listing each look-up; thumbs "This answer was right" / "This answer was wrong" with "What was wrong? (optional)"; "N questions left today" under ten and "No questions left today. The limit resets at midnight."; questions up to 4,000 characters; conversations belong to the signed-in person (not the acted-as), 40 kept.',
          value: 'A colleague who has read every record you may see.',
          permissions: ['assistant view'],
        },
        {
          name: 'How it answers',
          what: 'Three tools: search_work_orders (the saved-view filter set, group by, count), get_work_order (parts: details, updates, messages, visits, quote, payments, invoice, vendor bills, billing proposals, approvals, calls, record, place, contract, technicians, maintenance, purchasing, dispatch, attachments, field times) and lookup over named resources (quotes, payments, approvals and counts, invoices, vendor bills, billing proposals, contracts, vendors and alerts, sites, assets, clients, site events, planned maintenance, purchase requests, RFQs, purchase orders, budgets, services, job plans, work permits, intake drafts, people, KPIs, Pulse, saved views, and the admin lists: users, roles, audit log, automations, custom fields, status setup, trash, holidays, approval tiers, each checking the signed-in person\'s admin grant). Every look-up runs through the app\'s GET routes with the asker\'s cookie (a 403 reads "Not available to this person"). One question = one request, up to 12 model steps and 240 seconds, 16 earlier messages replayed as text; answers can be cut short or declined, and failed pairs are not replayed. Replies render paragraphs, lists, bold, code and links to in-app paths only.',
          value: 'Read-only by construction; it names a resource, never a path.',
          audit: ['assistant_asked (the look-up summaries, not the question or answer)'],
          since: '0068',
        },
        {
          name: 'How-to guide',
          what: 'A hand-written guide to every screen (labels as on screen, the permission each step needs) with "What this person may do" resolved for the asker (admin rows for the signed-in person, the rest for who they act as); anything outside The One is declined in one sentence.',
          value: 'The SOP, answered in context.',
        },
        {
          name: 'Teaching and limits',
          what: 'Taught: "Teach it something" (What it is about, 120 characters; What the assistant should know, 2,000), In use / Switched off, edit, delete; notes are read before every answer. Marked answers: "N marked right · N marked wrong", wrong first, Teach from this, Mark reviewed / Reopen. Earlier: the person\'s conversations with Delete. Limit: ASSISTANT_DAILY_LIMIT (100) questions per person per Chicago day (409); the panel says it is not switched on when the Claude integration is off or no key is set.',
          value: 'It gets better from the team\'s corrections.',
          permissions: ['assistant edit (teach, review)'],
          audit: ['assistant_note_created', 'assistant_note_updated', 'assistant_note_deleted'],
          deferred: ['Needs ANTHROPIC_API_KEY on the server.'],
        },
      ],
    },
  ],
};

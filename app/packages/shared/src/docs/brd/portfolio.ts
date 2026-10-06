// 0075 · BRD parts: portfolio (sites, assets, clients) and maintenance
// (planned maintenance, the maintenance tabs).

import type { DocPart } from '../types';

export const PORTFOLIO_PART: DocPart = {
  key: 'portfolio',
  title: 'Portfolio: sites, assets and clients',
  intro:
    'The places work is done at, the equipment standing in them, and the client accounts. Sites and assets came from the Ecotrak sync and were invisible until batch 2 made them records.',
  modules: [
    {
      key: 'sites',
      title: 'Sites, buildings, floors and spaces',
      where: 'Sidebar › Sites (List · Map · Events); the Site record block on a work order\'s Site tab.',
      purpose: 'A site is a record: type, ownership, manager, billing entity, contact, hours, access notes, geofence radius, a pin, and a tree of buildings, floors and spaces.',
      value: 'Address, access and hours are known before the technician leaves; work orders at the same site are found together; the geofence check reads the pin.',
      features: [
        {
          name: 'The list and the map',
          what: 'Counts strip Sites · Buildings · Floors · Spaces · Assets; search (name, store number, address or city); filters Client, State, Site type, Managed by, a Flag (With open work orders / No assets on file / Not on the map), Active sites / Closed sites / Active and closed; Clear filters; sortable columns Site, Client, Store, City, State, Type, Assets, Open, Work orders; 50 a page. Row chips: From Ecotrak / From work orders, Closed, Not on the map ("The ZIP or city could not be placed — correct the address, or pin it by hand"). Map: a filled pin has open work orders, a ring has none; pick a pin → Open the site.',
          value: 'Where the work is, at a glance.',
          permissions: ['sites view'],
        },
        {
          name: 'Site records',
          what: 'Add site / Edit: Client, Store number, Site name ("Left empty, it is the client and the store number."), Street address, Suite / unit, City, State, ZIP, Site type, Ownership (Owned / Leased / Franchise / Managed), Managed by, Billing entity, Site phone, Second phone, Site contact, Contact email, Opening hours, Getting in, Notes, Boundary (feet, 50 to 26,400), Latitude / Longitude ("Only to place the pin by hand"), Active. Three sources: Ecotrak (name, client, store number and address locked: "This site comes from Ecotrak, which keeps its name, client, store number and address up to date."), manual, work orders. The pin is placed from the ZIP, else the city, or by hand (a hand pin is not moved by an address change; clearing both coordinates reverts). Remove is soft ("Remove <site>?"). A Change history card lists every edit.',
          value: 'One record per place.',
          rules: ['A site needs a name, or a client and a store number.', 'Site reads and edits outside the person\'s site restriction answer 403 "That site is not one of the sites you have access to".'],
          permissions: ['sites view / create / edit / delete'],
          audit: ['site_created', 'site_updated', 'site_deleted'],
          since: '0060',
        },
        {
          name: 'Buildings, floors and spaces',
          what: '+ Building and + Space at the site, + Floor / + Space inside a building, Edit, Remove; Name, Inside (On the site itself / a building), Level (0 = ground, −1 basement), Space type, Area (sq ft). A building sits on the site, a floor in a building, a space on a floor, in a building or on the site. The Space viewer shows the tree with asset counts and open work orders per place, including "Not placed anywhere".',
          value: 'A technician is sent to the right floor.',
          rules: ['Removing a place removes everything inside it; assets standing there stay at the site and lose their place.'],
          audit: ['site_location_added', 'site_location_updated', 'site_location_removed'],
        },
        {
          name: 'Site events',
          what: 'Closure, Restricted access, Remodel, Incident, Inspection, Weather, Notice: Kind, What is happening, From, Until (empty = until ended), What a technician should know; Add the event, End today, Remove. Phases Now / Upcoming / Ended; listed at Sites › Events with "N running · N upcoming · N ended in the last 30 days"; shown as a chip on the site\'s work orders while running.',
          value: 'A closed store is known before the visit is booked.',
          permissions: ['sites edit'],
          audit: ['site_event_added', 'site_event_updated', 'site_event_removed'],
          since: '0064',
        },
        {
          name: 'Sites from work orders',
          what: 'When work orders name a site that is not on file and the person may create sites, a callout offers "Create sites from work orders": preview, then Create and link; a place is client + the first of store number, street, store name, city; the new sites are geo-placed; idempotent.',
          value: 'The history becomes a site list without typing.',
          audit: ['sites_created_from_work_orders'],
        },
        {
          name: 'A person restricted to sites',
          what: 'Admin › Sites & assets › Site access (super admins only): Restrict another person, Choose a person…, pick the first site, add or remove sites, Lift the restriction. Nobody listed = no restriction; a super admin cannot be restricted. The scope predicate ANDs the list onto every work-order list and route; "A work order with no site record is at none of them."',
          value: 'A store manager\'s account sees its own stores and nothing else.',
          permissions: ['super admin only'],
          audit: ['user_site_access_changed'],
          since: '0062',
        },
      ],
    },
    {
      key: 'assets',
      title: 'Assets and asset requests',
      where: 'Sidebar › Assets (List · Requests); the asset page.',
      purpose: 'Equipment with category, manufacturer, serial, tag, install date, warranty state, status, parent, the place it stands and a condition log with the work order each reading came from.',
      value: 'Repeat failures on the same unit are visible, warranty is checked before paying for a repair, and changes to the register go through a request a manager approves.',
      features: [
        {
          name: 'Asset records',
          what: 'Quick chips Warranty ends soon / Warranty expired / Critical condition / Poor condition; filters (name, model, serial, tag or site; Client, Category, Type, Status In service / Out of service / Retired, Condition Good / Fair / Poor / Critical / Not recorded, Warranty Under warranty / Ends within 60 days / Expired / None on file). Add asset / Edit: Site, Name, Category, Type, Manufacturer, Model, Serial number, Asset tag, Where it stands, Part of, Status, Installed on, Warranty ends, Warranty with, What the warranty covers, Description, Notes. The asset page: The asset, Parts of this asset, Requests about this asset, Service history, Warranty, Condition with Record a reading (Good / Fair / Poor / Critical, what was seen, the work order it was seen on). Remove: "Its N work orders keep pointing at it… Its parts stay on file as assets of their own."',
          value: 'The asset register the client never had.',
          rules: ['Site and Name are required; the place must be at the asset\'s own site; a parent loop is refused ("That would make the asset part of itself").'],
          permissions: ['assets view / create / edit / delete'],
          audit: ['asset_created', 'asset_updated', 'asset_deleted', 'asset_condition_recorded'],
          since: '0060',
        },
        {
          name: 'Asset management requests',
          what: 'Request a new asset from the queue; Request a change (Replace / Retire / Move) from an asset: the site, where it stands, the name of the asset or replacement, category, type, manufacturer, model, serial, an optional work order, and Why (required); Send the request. Queue Waiting · N / All with statuses Waiting / Approved / Rejected / Withdrawn; Approve — make the change (as the approver, validated and logged; a replacement takes the old asset\'s place and the old one is retired), Reject (why is required), Withdraw (the requester). Deciders and the requester get notices.',
          value: 'People who may not edit the register can still report what they see.',
          rules: ['The same request already waiting on an asset is refused; approving needs the asset rights too; a vanished asset or site conflicts.'],
          permissions: ['assets/requests create / approve'],
          audit: ['asset_request_created', 'asset_request_approved', 'asset_request_rejected', 'asset_request_withdrawn'],
          since: '0062',
        },
      ],
    },
    {
      key: 'clients',
      title: 'Clients',
      where: 'Sidebar › Clients; the Clients column in Admin › Users.',
      purpose: 'The client account: contact, billing, account manager, portal, terms; adopted automatically from any new client name on a work order.',
      value: 'A client in use cannot be renamed into a fork or deleted; the sales team\'s scope and the SharePoint folders key off this record.',
      features: [
        {
          name: 'Client records',
          what: 'Search (name, code or contact), Active clients / Inactive clients / Active and inactive; columns Client (Code, Inactive chips), Contact, Account manager, Portal, Sites, Assets, Open, Work orders. Add client / Edit: Name ("Exactly as it is written on work orders."), Code, Account manager, Contact name / phone / email, Billing email, Billing entity, Client portal (Ecotrak / Corrigo / ServiceChannel / Email / Other), Payment terms, Billing address, Notes, Active. The client page: chips for sites, assets and work orders, the SharePoint folder chip, cards The client, Sites, Work orders, Contracts, Change history. Every list read adopts a record for any new client name.',
          value: 'One spelling per client across the whole system.',
          rules: ['Only Name is required; a duplicate name is refused; a client in use can only be re-capitalised; a client with work orders or sites cannot be removed ("Mark it inactive instead").'],
          permissions: ['clients view / create / edit / delete'],
          audit: ['client_created', 'client_updated', 'client_deleted'],
          since: '0062',
        },
        {
          name: 'Clients assigned to a person',
          what: 'Admin › Users › Clients: chips plus Assign / Edit opening a tickable list (Find a client…, Save clients); widens "Only theirs" to those clients\' work orders; refused for a super admin ("A super admin sees every client already").',
          value: 'The Sales board counts exactly the salesperson\'s clients.',
          audit: ['user_clients_changed'],
          since: '0072',
        },
      ],
    },
  ],
};

export const MAINTENANCE_PART: DocPart = {
  key: 'maintenance',
  title: 'Planned and preventive maintenance',
  intro: 'Recurring work raised by the calendar, and the job plans, services, time and permits that support it.',
  modules: [
    {
      key: 'planned',
      title: 'Planned Maintenance',
      where: 'Sidebar › Planned Maintenance.',
      purpose: 'A schedule is one job at one place on a rhythm (every n days / weeks / months / years from a first date, with lead days); it raises its own work orders, already assigned, as PM Sched.',
      value: 'Preventive contracts are honoured without a reminder spreadsheet; each occurrence is claimed once so nothing is raised twice.',
      features: [
        {
          name: 'Schedules',
          what: 'Lanes Active N / All N; columns Schedule (the code opens its history: Due, Work order, Status, Skipped rows), Client · Site, Trade, Rhythm, Next due (today / tomorrow / in N days / N days overdue / paused), Last raised, Dispatcher, Actions. New schedule: What is the job?, Client, Billing entity, Store, Site name, Address, City, State, Trade, Work order description, Client NTE, Dispatcher (display name, blank = unassigned), Job plan (its steps become the checklist), How often (Every N days / weeks / months / years, 1 to 365), First due on, Ends (blank = open), "Raise the work order this many days ahead", Active. Raise now (the next date, lead window or not), Skip (records a skipped occurrence), Edit, Delete schedule ("Work orders it already raised stay where they are; no more will be raised." — to pause, untick Active instead).',
          value: 'The calendar does the dispatching.',
          rules: [
            'The end cannot precede the start; the dispatcher must be an active person on file; a schedule past its end date refuses Raise and Skip.',
            'A run raises at most 12 occurrences per schedule; each is claimed first (unique schedule + date) so the page read, the button and the cron cannot double-raise.',
            'The raised work order carries Client, Comp, Store, Address, City, State, Trade, Client NTE, "<code> · <name>" plus the description, Received on, Scheduled Date and Due Date = the due date, status PM Sched (falling back to Open), the SharePoint folder, the job plan, and the dispatcher through the field path; no acceptance task is raised.',
            'Runs on opening the list, after saving, on Raise now, and daily at 12:00 UTC from the Vercel cron (CRON_SECRET; unset = 403).',
          ],
          permissions: ['planned_maintenance view / create / edit / delete'],
          audit: ['pm_schedule_created', 'pm_schedule_updated', 'pm_schedule_deleted', 'pm_schedule_skipped', 'created (source planned_maintenance) on each work order'],
          since: '0051',
        },
      ],
    },
    {
      key: 'maint',
      title: 'Maintenance: assignment, job plans, services, time, permits',
      where: 'Sidebar › Maintenance (Assignment · Job plans · Services · Time tracker · Work permits, each with its own view grant).',
      purpose: 'The Facilio maintenance set: bulk assignment, reusable job plans, a services catalogue, technician time and permits to work.',
      value: 'Standard jobs are done the same way every time; time and permits are on the record instead of in a notebook.',
      features: [
        {
          name: 'Assignment Manager',
          what: 'Workload list (Unassigned, Everything open, each person with open / emergency / past-SLA counts); search; tick work orders; Assign to… (each person with their open count, or Nobody (unassign)); Assign; result "N work orders assigned. N could not be changed: …". Emergencies first, then oldest; 300 rows at most, 200 per assignment. Assigns through the ordinary field path so audit, gates, mirrors and automations see it; the assignee gets a notice.',
          value: 'Rebalance a team in one screen.',
          permissions: ['maintenance/assignment edit + work_orders edit; the selection must be inside the person\'s scope'],
        },
        {
          name: 'Job plans and services',
          what: 'Job plan: Name, Trade (Any trade), Estimated minutes, What it is for, Steps (one per line), Services with quantities, Active; applied once per work order from its Checklist tab or by a schedule; Delete keeps the steps already applied. Service: Name, Code, Trade, Unit (each / hour / visit / sq ft / linear ft / lb / gallon), Estimated minutes, Price per unit (what the client is charged), Cost per unit (what it costs us), Description, Active. Services and time never feed Cost.',
          value: 'The checklist is written once.',
          rules: ['Duplicate names are refused; applying a plan twice is refused.'],
          permissions: ['maintenance/job_plans view / create / edit / delete', 'maintenance/services view / create / edit / delete'],
          audit: ['job_plan_added', 'job_plan_updated', 'job_plan_deleted', 'service_item_added', 'service_item_updated', 'service_item_deleted'],
        },
        {
          name: 'Time tracker',
          what: 'Entries per technician on a work order\'s Timelog tab (Labor / Travel / Waiting; a running timer when no end, one per technician); across work orders: From / To range, tiles Total time / Billable / Labor value / Timers running, By technician and Entries tables, refreshed every minute.',
          value: 'Labour is measured.',
          rules: ['One running timer per technician; a start cannot be in the future; an end cannot precede its start.'],
          permissions: ['maintenance/time view / create (log, start) / edit (change, stop) / delete'],
        },
        {
          name: 'Work permits',
          what: 'PTW-n written on a work order\'s Related tab: Kind (General work, Hot work, Electrical, Working at height, Roof access, Confined space, Lockout / tagout, Excavation, each with pre-filled precautions), Permit holder, First day, Last day, Hazards, precaution ticks; Save as draft, Send for approval, Approve / Reject (a note is needed to reject), Close the permit, Back to draft. States Draft / Waiting for approval / Approved / Active / Expired / Rejected / Closed (active and expired are read from the dates). The Maintenance tab lists every permit with search and state chips; the list follows the work-order scope.',
          value: 'Hazardous work has a signed permit on the record.',
          rules: ['Request only from draft or rejected; once requested only the precaution ticks move; close only an approved permit; a closed permit never changes; a draft or rejected permit can be deleted.'],
          permissions: ['maintenance/permits view / create / edit / approve'],
          audit: ['field rows "Work permit" on the work order'],
        },
      ],
    },
  ],
};

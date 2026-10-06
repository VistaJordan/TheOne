// Who is free to take a work order — the "availability" view behind every
// Assignee picker (the Add work order form, Accept on Incoming, a Draft's
// Submit & assign, and the seat on the work order itself).
//
// The question a manager asks before handing a job out is "who do we have on
// this client, and how loaded are they?". Two lists answer it, from the same
// rows:
//
//   for this client   the people assigned to the work order's Client in
//                     Admin › Users (principal_client, 0072) — the ones who
//                     know the account.
//   all dispatchers   everyone in a dispatcher tier, whatever their clients.
//
// Either way a person's load is ALL their active work orders, every client —
// a dispatcher who is light on Walmart but drowning in Target is not free.
// "Active" is the Assignment Manager's definition (not done / closed, not
// cancelled, not deleted), counted over the same `Assignee` field the 0026
// scope matches by display name, so the number here is exactly the length of
// that person's "Only theirs" list.
//
// The server returns everyone once (GET /principals/availability?client=…);
// the two lists, the sort and the "everyone else" fold are pure functions here
// so the panel and a test agree.

/** The role codes rule 7.1.4 hands a new work order to — the dispatcher
    tiers. Ops Coordinator dispatches too (0031 leaves it on direct status
    changes). A person outside these can still be picked; they are just not
    in the first list. */
export const DISPATCHER_ROLE_CODES: readonly string[] = ['om', 'senior_om', 'om_probation', 'ops_coord'];

export function isDispatcherRole(code: string | null | undefined): boolean {
  return code != null && DISPATCHER_ROLE_CODES.includes(code);
}

/** One status a person holds active work orders in, pipeline order. */
export interface AvailabilityStatusCount {
  name: string;
  group: string;
  /** The status's own colour (ClickUp hex) for the dot; null when unknown. */
  color: string | null;
  n: number;
}

export interface AvailabilityPerson {
  id: string;
  name: string;
  role: string | null;
  role_label: string | null;
  /** In a dispatcher tier (`DISPATCHER_ROLE_CODES`). */
  dispatcher: boolean;
  /** Assigned to the client the request named, in Admin › Users. Always
      false when no client was named. */
  for_client: boolean;
  /** ALL their active work orders, every client. */
  active: number;
  /** The same count split by status, pipeline order; empty when `active` is 0. */
  by_status: AvailabilityStatusCount[];
}

export interface AssigneeAvailabilityResponse {
  /** The client the request named, trimmed, or null. */
  client: string | null;
  /** Everyone on file who could take a work order (humans, not disabled). */
  items: AvailabilityPerson[];
}

/** Which list is open. */
export type AvailabilityScope = 'client' | 'all';
/** Fewest active first (who is free) or most first (who is drowning). */
export type AvailabilityOrder = 'freest' | 'busiest';

/** The people in one list. `client` is the ones assigned to the client;
    `all` is the dispatcher tiers, plus everyone else when `includeOthers`. */
export function filterAvailability(
  items: readonly AvailabilityPerson[],
  scope: AvailabilityScope,
  includeOthers = false,
): AvailabilityPerson[] {
  if (scope === 'client') return items.filter((p) => p.for_client);
  return includeOthers ? [...items] : items.filter((p) => p.dispatcher);
}

/** Stable: ties fall back to the name so the list never jumps between reads. */
export function sortAvailability(items: readonly AvailabilityPerson[], order: AvailabilityOrder): AvailabilityPerson[] {
  const dir = order === 'freest' ? 1 : -1;
  return [...items].sort((a, b) => dir * (a.active - b.active) || a.name.localeCompare(b.name));
}

/** The people in `all` who are NOT dispatchers — what the "everyone else"
    fold would add, so its label can carry the count. */
export function othersCount(items: readonly AvailabilityPerson[]): number {
  return items.filter((p) => !p.dispatcher).length;
}

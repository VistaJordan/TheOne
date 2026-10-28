/**
 * The account team per client and billing entity (migration 0096, Elise,
 * 2026-10-27).
 *
 * Who looks after a client depends on which of our companies bills the work:
 * PH has one team under BKR, another under AF, TPM and RF. So a team is a row
 * per (client, Comp): the Team Lead, the Assistant Team Lead, the salesperson
 * and the Account Manager. It is kept on the client record (Clients › a
 * client › Account team) so it can always be adjusted, and "Add work order"
 * fills AM, TL and ATL from it once the Client and the Comp are picked. The
 * dispatcher is never filled: it is always picked by hand.
 *
 * The names are stored as typed ("Josh", "Fady", "House") — the team sheet
 * uses first names. `resolvePersonName` turns one into an account's display
 * name when exactly one active person answers to it; a name nobody answers to
 * is written as typed, never guessed into someone else's account.
 */

/** The bag keys the team fills on a new work order, and where each comes from. */
export const CLIENT_TEAM_FIELDS: readonly { key: string; from: 'am' | 'tl' | 'atl' }[] = [
  { key: 'AM', from: 'am' },
  { key: 'TL', from: 'tl' },
  { key: 'ATL', from: 'atl' },
];

/**
 * The role a person must hold to sit in each seat (Elise, 2026-10-27): the AM
 * picker lists only people whose role is AM, the TL picker only TLs, the ATL
 * picker only ATLs — on Add work order, in the work order's own fields, in
 * bulk edit and filters, and on a client's Account team.
 */
export const CLIENT_TEAM_SEAT_ROLE: Readonly<Record<'am' | 'tl' | 'atl', string>> = { am: 'am', tl: 'tl', atl: 'atl' };

/** The role a work-order seat (bag key AM / TL / ATL) asks for, else null. */
export function seatRoleForField(key: string): string | null {
  const seat = CLIENT_TEAM_FIELDS.find((f) => f.key === key);
  return seat ? CLIENT_TEAM_SEAT_ROLE[seat.from] : null;
}

/** The names a seat offers: the people holding its role. */
export function seatNames(people: readonly { name: string; role: string | null }[], seat: 'am' | 'tl' | 'atl'): string[] {
  const role = CLIENT_TEAM_SEAT_ROLE[seat];
  return people.filter((p) => p.role === role).map((p) => p.name);
}

/** Who a team name may resolve to: one list for every seat, or one per seat
    (`seatNames`), so "Mary" in the TL column only ever means a TL. */
export type TeamNames = readonly string[] | Readonly<Record<'am' | 'tl' | 'atl', readonly string[]>>;

/** The salesperson column's "nobody in particular". */
export const CLIENT_TEAM_HOUSE = 'House';

/** The work-order field the team's salesperson fills on Add work order
    (2026-10-27, Elise: "in People also add Sales"). A dropdown of first
    names, "House" included. */
export const SALES_OWNER_KEY = 'Sales Owner';

/** The Sales Owner options a fresh database starts with (0105, seed.ts —
    KEEP IN STEP). */
export const SALES_OWNER_DEFAULT_OPTIONS = ['Rocio', 'Teresa', 'Kevin', 'House'] as const;

/**
 * The Sales Owner a team puts on a new work order: the dropdown option that
 * matches the team's salesperson (any case; "House" is an option like any
 * other here), else null — a name the list does not offer is never written.
 */
export function salesOwnerFromTeam(
  team: Pick<ClientTeam, 'sales'> | null,
  options: readonly string[],
): string | null {
  const want = norm(team?.sales);
  if (want === '') return null;
  return options.find((o) => norm(o) === want) ?? null;
}

export interface ClientTeam {
  id: string;
  /** The billing entity, a `21. Comp` value (SFM, BKR, AF, TPM, RF, EDS). */
  billing_entity: string;
  tl: string | null;
  atl: string | null;
  sales: string | null;
  am: string | null;
  updated_at: string;
}

/** One team as the create form reads it: which client it belongs to. */
export interface ClientTeamForForm extends Omit<ClientTeam, 'id' | 'updated_at'> {
  client: string;
}

/** GET /client-teams — every client's teams, for the Clients list. */
export interface ClientTeamsOverview {
  teams: (Omit<ClientTeam, 'updated_at'> & { client_id: string })[];
  /** false = this database has no account teams yet (0096 not applied). */
  ready: boolean;
  /** 2026-10-27 · what the Clients list needs to edit the teams in place
      (the same vocabulary as ClientTeamsResponse). Absent on an older API. */
  billing_entities?: string[];
  people?: string[];
  people_by_seat?: Record<'am' | 'tl' | 'atl', string[]>;
  /** 2026-10-28 · the Sales column's dropdown: the Sales Owner options. */
  salespeople?: string[];
  can_edit?: boolean;
}

export interface ClientTeamInput {
  billing_entity: string;
  tl?: string | null;
  atl?: string | null;
  sales?: string | null;
  am?: string | null;
}

export interface ClientTeamsResponse {
  teams: ClientTeam[];
  /** The Comp values a team may be filed under. */
  billing_entities: string[];
  /** Active people's display names, for the pickers. */
  people: string[];
  /** The active people holding each seat's role (`CLIENT_TEAM_SEAT_ROLE`):
      what the AM / TL / ATL columns suggest and resolve against. */
  people_by_seat: Record<'am' | 'tl' | 'atl', string[]>;
  /** 2026-10-28 (Elise) · what the Sales column offers: the Sales Owner
      dropdown's options, "House" included. A team saved with a name the list
      lacks adds it there (`addSalesperson`), so the list grows from here or
      from Admin › Custom fields. */
  salespeople: string[];
  can_edit: boolean;
}

const isNameList = (n: TeamNames): n is readonly string[] => Array.isArray(n);

const norm = (s: string | null | undefined): string => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * The team for a client under a Comp. With no Comp picked yet, a client that
 * has exactly one team uses it; one with several waits for the Comp.
 */
export function pickClientTeam<T extends { client?: string; billing_entity: string }>(
  teams: readonly T[],
  client: string | null | undefined,
  comp: string | null | undefined,
): T | null {
  const c = norm(client);
  if (c === '') return null;
  const mine = teams.filter((t) => t.client === undefined || norm(t.client) === c);
  const e = norm(comp);
  if (e !== '') return mine.find((t) => norm(t.billing_entity) === e) ?? null;
  return mine.length === 1 ? mine[0] : null;
}

/**
 * The account a team name stands for: an exact display name (any case), else
 * the one person whose first name it is (or whose name starts with it). Null
 * when nobody, or more than one person, answers to it — and for "House".
 */
export function resolvePersonName(raw: string | null | undefined, names: readonly string[]): string | null {
  const want = norm(raw);
  if (want === '' || want === norm(CLIENT_TEAM_HOUSE)) return null;
  const exact = names.filter((n) => norm(n) === want);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const first = names.filter((n) => norm(n).split(' ')[0] === want);
  if (first.length === 1) return first[0];
  if (first.length > 1) return null;
  const prefix = names.filter((n) => norm(n).startsWith(want));
  return prefix.length === 1 ? prefix[0] : null;
}

/**
 * What a team writes on a work order: AM, TL and ATL — the account's
 * display name when the team's name resolves to one, else the name exactly as
 * the team has it (Elise, 2026-10-27: the leads must show on the work order
 * even before they have an account). The ones written as typed are listed in
 * `unmatched` (key → the name on file) so the form can say so. "House" is
 * never written.
 */
export function clientTeamValues(
  team: Pick<ClientTeam, 'am' | 'tl' | 'atl'> | null,
  names: TeamNames,
): { values: Record<string, string>; unmatched: Record<string, string> } {
  const values: Record<string, string> = {};
  const unmatched: Record<string, string> = {};
  if (!team) return { values, unmatched };
  for (const { key, from } of CLIENT_TEAM_FIELDS) {
    const raw = (team[from] ?? '').trim();
    if (raw === '') continue;
    const pool: readonly string[] = isNameList(names) ? names : names[from];
    const name = resolvePersonName(raw, pool);
    if (name) values[key] = name;
    else if (norm(raw) !== norm(CLIENT_TEAM_HOUSE)) {
      values[key] = raw;
      unmatched[key] = raw;
    }
  }
  return { values, unmatched };
}

/** One seat a client / Comp change re-fills on an existing work order. */
export interface TeamRefillChange {
  key: string;
  before: unknown;
  after: string | null;
}

const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Editing a work order (Elise, 2026-10-27): when a save changes the Client or
 * the Comp, AM, TL and ATL follow the account team the way the create form
 * fills them. A seat is re-filled only while it is empty or still holds
 * exactly what the PREVIOUS client / Comp's team would have put there, so a
 * name picked by hand is never overwritten; a seat the same save sets is left
 * as typed. A seat the new team leaves blank is cleared only when it held the
 * old team's name. An empty Comp is filled when the new client has a single
 * team, as on the form. Pure: `bag` is the bag as the save leaves it and is
 * changed in place; the changes are returned for the audit trail.
 */
export function refillFromClientTeam<T extends { client?: string; billing_entity: string; am: string | null; tl: string | null; atl: string | null; sales?: string | null }>(
  before: { client: unknown; comp: unknown },
  bag: Record<string, unknown>,
  explicit: ReadonlySet<string>,
  teams: readonly T[],
  names: TeamNames,
  /** 2026-10-28 (Elise) · the Sales Owner options. Given, Sales Owner follows
      the team too, as the create form fills it (`salesOwnerFromTeam`). */
  salesOptions?: readonly string[],
): TeamRefillChange[] {
  const changes: TeamRefillChange[] = [];
  const oldTeam = pickClientTeam(teams, str(before.client), str(before.comp));
  const newTeam = pickClientTeam(teams, str(bag['Client']), str(bag['21. Comp']));
  if (newTeam && blank(bag['21. Comp']) && !explicit.has('21. Comp')) {
    changes.push({ key: '21. Comp', before: bag['21. Comp'] ?? null, after: newTeam.billing_entity });
    bag['21. Comp'] = newTeam.billing_entity;
  }
  if (newTeam === oldTeam) return changes;
  const was = clientTeamValues(oldTeam, names).values;
  const now = clientTeamValues(newTeam, names).values;
  const seats = CLIENT_TEAM_FIELDS.map((f) => f.key);
  if (salesOptions) {
    const oldSales = salesOwnerFromTeam(oldTeam ? { sales: oldTeam.sales ?? null } : null, salesOptions);
    const newSales = salesOwnerFromTeam(newTeam ? { sales: newTeam.sales ?? null } : null, salesOptions);
    if (oldSales) was[SALES_OWNER_KEY] = oldSales;
    if (newSales) now[SALES_OWNER_KEY] = newSales;
    seats.push(SALES_OWNER_KEY);
  }
  for (const key of seats) {
    if (explicit.has(key)) continue;
    const cur = bag[key];
    const held = str(cur);
    if (held !== null && held !== (was[key] ?? null)) continue;
    const next = now[key] ?? null;
    if ((held ?? null) === next) continue;
    if (next === null) delete bag[key];
    else bag[key] = next;
    changes.push({ key, before: cur ?? null, after: next });
  }
  return changes;
}

/**
 * The Client choices once a Comp is picked (Elise, 2026-10-27): only the
 * clients that work under that Comp — those with an account team or a
 * check-in row filed under it (`WoFieldOption.comps`). No Comp, or a Comp no
 * client is filed under yet, offers every client, so the list is never empty
 * by accident. The value already chosen always stays offered. A narrowing of
 * the choices only: the API still takes any client on file.
 */
export function clientOptionsForComp<O extends { value: string; comps?: string[] }>(
  options: readonly O[],
  comp: string | null | undefined,
  current?: string | null,
): O[] {
  const e = norm(comp);
  if (e === '') return [...options];
  const under = options.filter((o) => (o.comps ?? []).some((c) => norm(c) === e));
  if (under.length === 0) return [...options];
  const cur = norm(current);
  if (cur !== '' && !under.some((o) => norm(o.value) === cur)) {
    const held = options.find((o) => norm(o.value) === cur);
    if (held) return [held, ...under];
  }
  return under;
}

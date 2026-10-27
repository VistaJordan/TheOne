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

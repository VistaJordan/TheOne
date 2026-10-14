// Seed host guard (W3-14 / W4-20) — pure, so a test can pin the decision.
//
// seed.ts TRUNCATEs the data tables and re-inserts the sample set. That is
// fine on a laptop and catastrophic on Neon: DATABASE_URL is whatever the
// shell holds, and the Vercel-scoped URL has sat in developers' environments.
// The rule: a localhost host runs; any other host runs only when ALLOW_SEED
// spells the target's `<host>/<database>` — the operator typing out what they
// are about to empty. The database name alone is NOT a confirmation (architect
// review, 2026-10-14): Neon calls every branch's database `neondb`, so an
// `ALLOW_SEED=neondb` persisted once for the development branch would have
// confirmed production in every later shell. The host is compared
// case-insensitively — hostnames are, and the WHATWG parser keeps whatever
// case a postgres:// URL gives its host — and the database exactly, as
// Postgres does; nothing is folded off the host (the pooled and the direct
// spelling of one Neon endpoint are two tokens). The refusal prints the exact
// value to set. seed.ts asks this BEFORE it creates a pool, so no connection
// is ever made to a database that is then refused.
//
// The host is read the way pg-connection-string (what pg.Pool opens) reads
// it, not off the bare authority: a `?host=` query parameter REPLACES the
// host — the last one given wins, an empty one is ignored — so
// postgres://localhost/theone?host=ep-xyz.neon.tech opens Neon and must say
// so here. The forms pg accepts that the WHATWG parser does not (credentials
// with no host, `postgres://u:p@/db?host=…`; the socket: scheme; a bare
// socket path) come out as "not a URL", and an empty authority
// (postgres:///db, which pg sends to PGHOST or localhost) as an empty host:
// all REFUSED, and a target with no host or no database can never be
// confirmed — the token would not name what the seed empties. The guard may
// over-refuse, never under-refuse. `?port=` moves no host and is ignored.
//
// Kept apart from seed.ts because seed.ts runs main() at import.

export interface SeedTarget {
  host: string;
  database: string;
}

/** Hosts that mean "this machine". Compared case-insensitively: the WHATWG
    parser keeps the case of a non-special scheme's host (postgres://LOCALHOST). */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/** The env var that confirms a seed of a database that is not on this machine.
    Its value is `seedConfirmToken(target)`, exactly as the refusal prints it. */
export const SEED_CONFIRM_VAR = 'ALLOW_SEED';

const NOT_A_URL = 'seed: DATABASE_URL is not a URL';

/** Host and database of a connection URL as pg resolves them: a `?host=`
    parameter over the authority, percent-encoding decoded, brackets off an
    IPv6 host, the query string dropped. Garbage → a plain Error (the seed
    prints it and exits). */
export function seedTarget(url: string): SeedTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(NOT_A_URL);
  }
  // pg-connection-string copies every query parameter into its config first
  // and sets the host from the authority only "if there is no equivalent
  // query param" — so the last `host` wins and an empty one falls through.
  const hostParams = parsed.searchParams.getAll('host');
  const hostParam = hostParams.length > 0 ? hostParams[hostParams.length - 1] : '';
  let host: string;
  let database: string;
  try {
    host = hostParam !== '' ? hostParam : decodeURIComponent(parsed.hostname);
    database = decodeURI(parsed.pathname.slice(1));
  } catch {
    throw new Error(NOT_A_URL);
  }
  host = host.replace(/^\[(.*)\]$/, '$1');
  return { host, database };
}

/** What ALLOW_SEED must spell to confirm this target: `<host>/<database>`, the
    host as pg opens it. A hostname holds no '/', so the first one splits it. */
export function seedConfirmToken(target: SeedTarget): string {
  return `${target.host}/${target.database}`;
}

/** True when ALLOW_SEED (trimmed) spells the target — the host
    case-insensitively, the database exactly. Never true for a target with no
    host or no database: the token would not name what the seed empties. */
export function seedConfirmed(allowSeed: string | undefined, target: SeedTarget): boolean {
  if (allowSeed === undefined || target.host === '' || target.database === '') return false;
  const value = allowSeed.trim();
  const slash = value.indexOf('/');
  if (slash < 0) return false;
  return (
    value.slice(0, slash).toLowerCase() === target.host.toLowerCase() &&
    value.slice(slash + 1) === target.database
  );
}

export type SeedDecision =
  | { ok: true; target: SeedTarget }
  | { ok: false; target: SeedTarget; reason: string };

/** localhost → ok; anything else only when ALLOW_SEED spells `<host>/<database>`. */
export function seedAllowed(url: string, allowSeed: string | undefined): SeedDecision {
  const target = seedTarget(url);
  const local = LOCAL_HOSTS.includes(target.host.toLowerCase());
  if (local || seedConfirmed(allowSeed, target)) return { ok: true, target };
  const token = seedConfirmToken(target);
  const reason =
    target.host === '' || target.database === ''
      ? `seed: REFUSED — DATABASE_URL names ${target.host === '' ? 'no host' : 'no database'} (${token}); ` +
        `spell both out in the URL — no ${SEED_CONFIRM_VAR} value confirms a target the guard cannot name.`
      : `seed: REFUSED — DATABASE_URL points at ${token}, which is not localhost. ` +
        `Set ${SEED_CONFIRM_VAR}=${token} to confirm you really mean to TRUNCATE it.`;
  return { ok: false, target, reason };
}

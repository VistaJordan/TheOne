/* W3-14 / W4-20 — the seed refuses a database that is not on this machine
 * (fix batch G2).
 *
 * seed.ts TRUNCATEs twenty-odd tables and re-inserts the sample data. With
 * the Neon DATABASE_URL scoped to Preview and Development on Vercel, one
 * `npm run setup` in the wrong shell would have emptied it. The decision —
 * localhost runs; any other host runs only when ALLOW_SEED spells its
 * `<host>/<database>` — is the pure module packages/db/src/seedGuard.ts,
 * pinned here; seed.ts asks it before it creates a pool.
 *
 * Architect review (2026-10-14): the token was the database name alone, and
 * Neon calls every branch's database `neondb` — an `ALLOW_SEED=neondb`
 * persisted once for the development branch would have confirmed production
 * in every later shell. The token now names the host too (as pg opens it,
 * compared case-insensitively; the database exactly), the refusal prints the
 * exact value to set, and the third block pins that the name alone, a
 * different host with the same name and every other near miss are refused.
 *
 * Loop 2 (skeptic): the host must be the one pg-connection-string resolves,
 * not the bare authority — `?host=` replaces it (last wins, empty ignored),
 * and percent-encoding is decoded — or the guard prints "localhost" for a
 * URL whose pool opens Neon. The second block pins that, with the exact
 * cases probed against pg-connection-string 2.14.0 (pg 8.23.0).
 *
 * Fails on the tree before the fix: the module does not exist.
 */

import { describe, expect, it } from 'vitest';
import {
  LOCAL_HOSTS,
  SEED_CONFIRM_VAR,
  seedAllowed,
  seedConfirmToken,
  seedConfirmed,
  seedTarget,
} from '../packages/db/src/seedGuard';

const NEON = 'postgres://u:p@ep-xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
const NEON_HOST = 'ep-xyz-pooler.us-east-2.aws.neon.tech';

describe('seedTarget', () => {
  it('reads host and database off a Neon pooler URL, dropping the query string', () => {
    expect(seedTarget(NEON)).toEqual({ host: NEON_HOST, database: 'neondb' });
  });

  it('reads the local default', () => {
    expect(seedTarget('postgres://theone:theone@localhost:5432/theone')).toEqual({
      host: 'localhost',
      database: 'theone',
    });
  });

  it('strips the brackets off an IPv6 host', () => {
    expect(seedTarget('postgres://u:p@[::1]:5432/theone')).toEqual({ host: '::1', database: 'theone' });
  });

  it('takes the postgresql:// spelling too', () => {
    expect(seedTarget('postgresql://u:p@127.0.0.1/theone')).toEqual({ host: '127.0.0.1', database: 'theone' });
  });

  it('refuses garbage with a plain error, before anything else happens', () => {
    expect(() => seedTarget('not a url')).toThrow('seed: DATABASE_URL is not a URL');
    expect(() => seedTarget('')).toThrow('seed: DATABASE_URL is not a URL');
  });
});

describe('seedTarget resolves the host the way pg does (a ?host= parameter replaces the authority)', () => {
  // pg-connection-string copies the query parameters into its config FIRST and
  // sets the host from the authority only "if there is no equivalent query
  // param": postgres://localhost/theone?host=<neon> opens Neon. Before this
  // fix the guard read parsed.hostname, printed "localhost" and would have
  // let the seed TRUNCATE the pooler.
  const CRAFTED = `postgres://u:p@localhost:5432/theone?host=${NEON_HOST}`;

  it('takes the ?host= over the host in the authority', () => {
    expect(seedTarget(CRAFTED)).toEqual({ host: NEON_HOST, database: 'theone' });
  });

  it('…so the crafted URL is refused, naming the host the pool would open', () => {
    const d = seedAllowed(CRAFTED, undefined);
    expect(d.ok).toBe(false);
    expect(d.target).toEqual({ host: NEON_HOST, database: 'theone' });
    if (d.ok) throw new Error('expected a refusal');
    expect(d.reason).toContain(`points at ${NEON_HOST}/theone, which is not localhost`);
    expect(d.reason).toContain(`Set ALLOW_SEED=${NEON_HOST}/theone `);
    // The token names the host pg opens, not the one in the authority: only
    // the operator typing THAT host out confirms it.
    expect(seedAllowed(CRAFTED, `${NEON_HOST}/theone`).ok).toBe(true);
    expect(seedAllowed(CRAFTED, 'localhost/theone').ok).toBe(false);
    expect(seedAllowed(CRAFTED, 'theone').ok).toBe(false);
  });

  it('the last ?host= wins and an empty one is ignored, as in pg', () => {
    expect(seedTarget('postgres://u:p@localhost/theone?host=a.example&host=b.example').host).toBe('b.example');
    expect(seedTarget('postgres://u:p@localhost/theone?host=').host).toBe('localhost');
    expect(seedAllowed('postgres://u:p@localhost/theone?host=', undefined).ok).toBe(true);
  });

  it('a ?host= that IS local counts as local — pg connects there, not to the authority', () => {
    expect(seedAllowed(`${NEON}&host=127.0.0.1`, undefined)).toEqual({
      ok: true,
      target: { host: '127.0.0.1', database: 'neondb' },
    });
  });

  it('decodes a percent-encoded host and database like pg', () => {
    expect(seedTarget('postgres://u:p@local%68ost/the%20one')).toEqual({ host: 'localhost', database: 'the one' });
    expect(seedAllowed(`postgres://u:p@${NEON_HOST}/the%20one`, `${NEON_HOST}/the one`).ok).toBe(true);
  });

  it('?port= moves no host', () => {
    expect(seedAllowed('postgres://u:p@localhost:5432/theone?port=5433', undefined).ok).toBe(true);
  });

  it('refuses the forms pg resolves but this parser does not, rather than guessing', () => {
    // An empty authority: pg falls back to PGHOST, then localhost; the guard
    // sees no host and refuses — over-refusal is the safe side.
    const empty = seedAllowed('postgres:///theone', undefined);
    expect(empty.ok).toBe(false);
    expect(empty.target).toEqual({ host: '', database: 'theone' });
    // Credentials with no host: pg retries with a dummy host and takes ?host=.
    expect(() => seedTarget('postgres://u:p@/theone?host=neon.example')).toThrow('seed: DATABASE_URL is not a URL');
    // The socket: scheme: pg reads the path as the socket directory.
    expect(seedAllowed('socket:/var/run/postgresql?db=theone', undefined).ok).toBe(false);
  });
});

describe('seedAllowed', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('lets %s through without ALLOW_SEED', (host) => {
    const d = seedAllowed(`postgres://theone:theone@${host}:5432/theone`, undefined);
    expect(d.ok).toBe(true);
    expect(d.target.database).toBe('theone');
  });

  it('matches a local host whatever its case (the URL parser keeps it)', () => {
    expect(seedAllowed('postgres://u:p@LOCALHOST/theone', undefined).ok).toBe(true);
  });

  it('refuses the Neon URL with no ALLOW_SEED', () => {
    const d = seedAllowed(NEON, undefined);
    expect(d.ok).toBe(false);
    expect(d.target).toEqual({ host: NEON_HOST, database: 'neondb' });
  });

  it('refuses when ALLOW_SEED names a different database on the same host', () => {
    expect(seedAllowed(NEON, `${NEON_HOST}/theone`).ok).toBe(false);
  });

  it('refuses an empty or blank ALLOW_SEED', () => {
    expect(seedAllowed(NEON, '').ok).toBe(false);
    expect(seedAllowed(NEON, '   ').ok).toBe(false);
  });

  it('never lets an empty database name match an empty ALLOW_SEED, or a host-only token', () => {
    expect(seedAllowed('postgres://u:p@db.example.com:5432', '').ok).toBe(false);
    expect(seedAllowed('postgres://u:p@db.example.com:5432', 'db.example.com/').ok).toBe(false);
  });

  it('lets the Neon URL through when ALLOW_SEED spells <host>/<database>', () => {
    expect(seedAllowed(NEON, `${NEON_HOST}/neondb`)).toEqual({
      ok: true,
      target: { host: NEON_HOST, database: 'neondb' },
    });
    expect(seedAllowed(NEON, ` ${NEON_HOST}/neondb `).ok).toBe(true);
  });

  it('the reason names the host, the database and the exact ALLOW_SEED to set', () => {
    const d = seedAllowed(NEON, undefined);
    if (d.ok) throw new Error('expected a refusal');
    expect(d.reason).toBe(
      `seed: REFUSED — DATABASE_URL points at ${NEON_HOST}/neondb, which is not localhost. ` +
        `Set ALLOW_SEED=${NEON_HOST}/neondb to confirm you really mean to TRUNCATE it.`,
    );
    expect(d.reason).not.toContain('u:p@');
  });
});

describe('ALLOW_SEED names the host as well as the database (architect review, 2026-10-14)', () => {
  // Neon calls every branch's database `neondb`: the runbook cuts preview and
  // development as branches of main, so all three share the name, and an
  // `ALLOW_SEED=neondb` persisted once for the development branch would have
  // confirmed production in every later shell. The token is <host>/<database>.
  const OTHER_BRANCH_HOST = 'ep-prod-pooler.us-east-2.aws.neon.tech';
  const OTHER_BRANCH = `postgres://u:p@${OTHER_BRANCH_HOST}/neondb?sslmode=require`;

  it('SEED_CONFIRM_VAR is ALLOW_SEED and the token is <host>/<database>, the host as pg opens it', () => {
    expect(SEED_CONFIRM_VAR).toBe('ALLOW_SEED');
    expect(seedConfirmToken(seedTarget(NEON))).toBe(`${NEON_HOST}/neondb`);
    expect(seedConfirmToken(seedTarget(`postgres://u:p@localhost/neondb?host=${NEON_HOST}`))).toBe(
      `${NEON_HOST}/neondb`,
    );
  });

  it('refuses the database name alone, and the refusal prints the full token to set', () => {
    const d = seedAllowed(NEON, 'neondb');
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('expected a refusal');
    expect(d.reason).toBe(
      `seed: REFUSED — DATABASE_URL points at ${NEON_HOST}/neondb, which is not localhost. ` +
        `Set ALLOW_SEED=${NEON_HOST}/neondb to confirm you really mean to TRUNCATE it.`,
    );
    expect(seedConfirmed('neondb', seedTarget(NEON))).toBe(false);
  });

  it('accepts <host>/<database> for this host', () => {
    expect(seedAllowed(NEON, `${NEON_HOST}/neondb`).ok).toBe(true);
    expect(seedConfirmed(`${NEON_HOST}/neondb`, seedTarget(NEON))).toBe(true);
    // Copied straight off the refusal, surrounding whitespace and all.
    expect(seedConfirmed(`\t${NEON_HOST}/neondb\n`, seedTarget(NEON))).toBe(true);
  });

  it('compares the host case-insensitively (hostnames are) and the database exactly (Postgres does)', () => {
    expect(seedAllowed(NEON, 'EP-XYZ-POOLER.US-EAST-2.AWS.NEON.TECH/neondb').ok).toBe(true);
    // The URL parser keeps the case a postgres:// URL gives its host; the
    // lower-case token still names it.
    expect(
      seedAllowed('postgres://u:p@EP-XYZ-Pooler.us-east-2.aws.neon.tech/neondb', `${NEON_HOST}/neondb`).ok,
    ).toBe(true);
    expect(seedAllowed(NEON, `${NEON_HOST}/NEONDB`).ok).toBe(false);
    expect(seedAllowed(NEON, `${NEON_HOST}/Neondb`).ok).toBe(false);
  });

  it('refuses a different host with the same database name — every Neon branch is neondb', () => {
    const d = seedAllowed(OTHER_BRANCH, `${NEON_HOST}/neondb`);
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('expected a refusal');
    expect(d.reason).toContain(`Set ALLOW_SEED=${OTHER_BRANCH_HOST}/neondb `);
    expect(seedAllowed(OTHER_BRANCH, `${OTHER_BRANCH_HOST}/neondb`).ok).toBe(true);
    // Nothing is folded off the host: the pooled and the direct spelling of
    // one endpoint are two tokens, each printed by its own refusal.
    expect(seedAllowed(NEON, 'ep-xyz.us-east-2.aws.neon.tech/neondb').ok).toBe(false);
  });

  it('refuses every other near miss', () => {
    for (const v of [
      `neondb/${NEON_HOST}`, // reversed
      NEON_HOST, // host alone
      `${NEON_HOST}/`, // host, no database
      '/neondb',
      `${NEON_HOST}//neondb`,
      `${NEON_HOST}/neondb/`,
      `${NEON_HOST}/neondb?sslmode=require`,
      `${NEON_HOST}:5432/neondb`, // the port is not part of the token
      `postgres://u:p@${NEON_HOST}/neondb`, // the whole URL
      `ALLOW_SEED=${NEON_HOST}/neondb`, // the printed assignment, pasted whole
    ]) {
      expect(seedAllowed(NEON, v).ok, v).toBe(false);
    }
  });

  it('a target with no host or no database can never be confirmed, and the refusal offers no token', () => {
    // postgres:///theone — pg falls back to PGHOST, then localhost; the guard
    // cannot say what it would empty, so nothing confirms it.
    const noHost = seedAllowed('postgres:///theone', '/theone');
    expect(noHost.ok).toBe(false);
    if (noHost.ok) throw new Error('expected a refusal');
    expect(noHost.reason).toBe(
      'seed: REFUSED — DATABASE_URL names no host (/theone); spell both out in the URL — ' +
        'no ALLOW_SEED value confirms a target the guard cannot name.',
    );
    const noDb = seedAllowed('postgres://u:p@db.example.com:5432', 'db.example.com/');
    expect(noDb.ok).toBe(false);
    if (noDb.ok) throw new Error('expected a refusal');
    expect(noDb.reason).toContain('names no database (db.example.com/)');
    expect(noDb.reason).not.toContain('Set ALLOW_SEED=');
  });
});

describe('LOCAL_HOSTS', () => {
  it('is exactly localhost, 127.0.0.1 and ::1', () => {
    expect(LOCAL_HOSTS).toEqual(['localhost', '127.0.0.1', '::1']);
  });
});

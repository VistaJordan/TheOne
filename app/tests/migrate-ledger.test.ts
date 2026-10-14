/* G8 — the migration ledger (AUDIT.md Must-fix, finding W3-6).
 *
 * Until this batch the runner keyed `_migrations` by filename alone: an
 * applied file edited after it ran was accepted in silence, the ledger INSERT
 * ran on a second pooled connection after the file, and two runners could
 * interleave. Now the ledger carries a sha256 per file, a changed applied file
 * stops the run unless MIGRATE_ALLOW_CHECKSUM_MISMATCH=1, each file and its
 * ledger row commit together, and the run holds pg_advisory_lock — on a DIRECT
 * connection only: a pooled host (Neon's `-pooler`, PgBouncer in transaction
 * mode) is refused before any connection is opened, DATABASE_URL_UNPOOLED is
 * preferred when set, the wait for another run's lock is bounded, and an
 * unlock that misses is reported, never swallowed.
 *
 * This file pins the pure half (packages/db/src/migrateLedger.ts) — the
 * target decision, the CRLF-insensitive checksum, the plan and the refusal
 * messages — and reads migrate.ts as TEXT for the guard, the lock and the
 * transaction (importing it would run main() and open a database). It fails
 * on the tree before the fix because the module does not exist.
 *
 * Remediation (the architect's blocking item on this batch): migrationTarget
 * took DATABASE_URL_UNPOOLED whenever it was set, while seed.ts reads only
 * DATABASE_URL — so a production direct URL left exported in a shell made
 * `npm run setup` migrate production and seed the laptop. Now a pair that
 * names different databases is refused, DATABASE_URL_UNPOOLED alone and off
 * this machine needs ALLOW_MIGRATE=<host>/<database>, urlTarget reads the
 * host pg opens (`?host=`, as seedGuard does), and seed.ts warns when the
 * variable points elsewhere. The blocks after the "Remediation" rule fail on
 * the tree before it: the exports do not exist, and neither the pair nor the
 * lone remote URL was refused.
 *
 * Follow-up (F4-migrate-and-locks): a file to apply that manages its own
 * transaction (BEGIN / START TRANSACTION / COMMIT / ROLLBACK at a statement
 * start) or runs CONCURRENTLY cannot run inside the runner's BEGIN … COMMIT;
 * planMigrations lists it under `invalid` with its line, describeInvalid
 * prints it and migrate.ts exits 1 before the backfills. Comments, strings,
 * quoted identifiers and $$ bodies are blanked first — three shipped files
 * carry a plpgsql BEGIN at a line start, so the naive line-start regex would
 * refuse a fresh database at 0001. MIGRATE_LOCK_KEY now reads the shared
 * advisory-lock registry (tests/advisory-locks.test.ts), and ALLOW_MIGRATE is
 * compared as ALLOW_SEED is: the host case-insensitively, the database
 * exactly, by seedConfirmed itself. The blocks after the "Follow-up" rule
 * fail on the tree before it.
 *
 * Second round (the skeptics' concerns): the transaction-control check is a
 * STATEMENT-start check, never a line-start one — a column named commit on a
 * line of its own in a column list is not transaction control — and a
 * DATABASE_URL_UNPOOLED the guard cannot read (Node's parser throws on
 * `u:p@/db`, which pg would open as PGHOST or localhost) is refused outright:
 * ALLOW_MIGRATE=?/? used to confirm it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHECKSUM_OVERRIDE_VAR,
  LOCK_NOT_AVAILABLE,
  MIGRATE_CONFIRM_VAR,
  MIGRATE_LOCK_KEY,
  MIGRATE_LOCK_WAIT_MS,
  UNPOOLED_URL_VAR,
  blankCommentsAndStrings,
  checksumMismatchAllowed,
  checksumOf,
  describeInvalid,
  describeLockWait,
  describeRefusal,
  describeSeedUnpooledMismatch,
  directHostKey,
  isLockTimeout,
  isPooledHost,
  migrateConfirmed,
  migrationFileProblems,
  migrationTarget,
  planMigrations,
  readUrlTarget,
  sameDatabase,
  urlTarget,
  type LedgerRow,
  type MigrationFile,
} from '../packages/db/src/migrateLedger';
import { seedConfirmed, seedTarget } from '../packages/db/src/seedGuard';

const file = (filename: string, sql: string): MigrationFile => ({ filename, sql });
const row = (filename: string, checksum: string | null): LedgerRow => ({ filename, checksum });

const LOCAL = 'postgres://theone:theone@localhost:5432/theone';
const POOLED = 'postgres://u:p@ep-xyz-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require';
const POOLED_HOST = 'ep-xyz-pooler.us-east-2.aws.neon.tech';
const DIRECT = 'postgres://u:p@ep-xyz.us-east-2.aws.neon.tech/neondb?sslmode=require';
const DIRECT_HOST = 'ep-xyz.us-east-2.aws.neon.tech';
// Another endpoint, and the same endpoint under another database name.
const OTHER_DIRECT = 'postgres://u:p@ep-abc.us-east-2.aws.neon.tech/neondb?sslmode=require';
const DIRECT_OTHER_DB = 'postgres://u:p@ep-xyz.us-east-2.aws.neon.tech/otherdb?sslmode=require';

describe('isPooledHost', () => {
  it('recognises Neon\'s -pooler hostname, whatever its case', () => {
    expect(isPooledHost(POOLED_HOST)).toBe(true);
    expect(isPooledHost('EP-XYZ-POOLER.US-EAST-2.AWS.NEON.TECH')).toBe(true);
  });

  it('passes the direct Neon host, localhost and an IP', () => {
    expect(isPooledHost(DIRECT_HOST)).toBe(false);
    expect(isPooledHost('localhost')).toBe(false);
    expect(isPooledHost('127.0.0.1')).toBe(false);
    expect(isPooledHost('::1')).toBe(false);
  });
});

describe('urlTarget', () => {
  it('reads host and database, dropping the query string and the password', () => {
    expect(urlTarget(POOLED)).toEqual({ host: POOLED_HOST, database: 'neondb' });
    expect(urlTarget(LOCAL)).toEqual({ host: 'localhost', database: 'theone' });
  });

  it('strips the brackets off an IPv6 host', () => {
    expect(urlTarget('postgres://u:p@[::1]:5432/theone')).toEqual({ host: '::1', database: 'theone' });
  });

  it('answers ? for a string that is not a URL instead of throwing, where readUrlTarget answers null', () => {
    // Node's parser throws on credentials before an empty host and on nothing after them; a database
    // percent-encoded beyond reading throws in the decode.
    for (const u of ['not a url', '', 'postgres://u:p@/neondb', 'postgres://u:p@:5432/neondb', 'postgres://u:p@h/%E0%A4%A']) {
      expect(urlTarget(u), u).toEqual({ host: '?', database: '?' });
      expect(readUrlTarget(u), u).toBeNull();
    }
    expect(readUrlTarget(LOCAL)).toEqual({ host: 'localhost', database: 'theone' });
  });
});

describe('migrationTarget — which database, decided before any connection', () => {
  it('falls back to the default (localhost) when nothing is set', () => {
    expect(migrationTarget({}, LOCAL)).toEqual({
      url: LOCAL,
      source: 'default',
      host: 'localhost',
      database: 'theone',
      refusal: null,
    });
  });

  it('takes DATABASE_URL when that is all there is', () => {
    const t = migrationTarget({ DATABASE_URL: DIRECT }, LOCAL);
    expect(t).toEqual({ url: DIRECT, source: 'DATABASE_URL', host: DIRECT_HOST, database: 'neondb', refusal: null });
  });

  it('prefers DATABASE_URL_UNPOOLED over a pooled DATABASE_URL — the Neon layout', () => {
    expect(UNPOOLED_URL_VAR).toBe('DATABASE_URL_UNPOOLED');
    const t = migrationTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT }, LOCAL);
    expect(t.url).toBe(DIRECT);
    expect(t.source).toBe('DATABASE_URL_UNPOOLED');
    expect(t.host).toBe(DIRECT_HOST);
    expect(t.refusal).toBeNull();
  });

  it('refuses a pooled DATABASE_URL with no direct URL, naming the variable, the host and the fix', () => {
    const t = migrationTarget({ DATABASE_URL: POOLED }, LOCAL);
    expect(t.source).toBe('DATABASE_URL');
    expect(t.refusal).toMatch(/^migrate: REFUSED — DATABASE_URL is a pooled endpoint \(ep-xyz-pooler\.us-east-2\.aws\.neon\.tech\)\./);
    expect(t.refusal).toContain('PgBouncer');
    expect(t.refusal).toContain('set DATABASE_URL_UNPOOLED to it');
    expect(t.refusal).toContain("'-pooler'");
    // Never the URL: it carries the password.
    expect(t.refusal).not.toContain('u:p@');
  });

  it('refuses a DATABASE_URL_UNPOOLED that is itself pooled', () => {
    const t = migrationTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: POOLED }, LOCAL);
    expect(t.source).toBe('DATABASE_URL_UNPOOLED');
    expect(t.refusal).toMatch(/^migrate: REFUSED — DATABASE_URL_UNPOOLED is a pooled endpoint/);
  });

  it('ignores a blank DATABASE_URL_UNPOOLED and trims the value it takes', () => {
    expect(migrationTarget({ DATABASE_URL: DIRECT, DATABASE_URL_UNPOOLED: '   ' }, LOCAL).source).toBe('DATABASE_URL');
    expect(migrationTarget({ DATABASE_URL: '', DATABASE_URL_UNPOOLED: '' }, LOCAL).source).toBe('default');
    const t = migrationTarget({ DATABASE_URL_UNPOOLED: `  ${DIRECT}\n` }, LOCAL);
    expect(t.url).toBe(DIRECT);
    expect(t.host).toBe(DIRECT_HOST);
  });

  it('leaves a string that is not a URL to pg: no refusal, ? printed', () => {
    const t = migrationTarget({ DATABASE_URL: 'not a url' }, LOCAL);
    expect(t.url).toBe('not a url');
    expect(t.host).toBe('?');
    expect(t.refusal).toBeNull();
  });
});

describe('the lock wait', () => {
  it('isLockTimeout recognises SQLSTATE 55P03 (lock_not_available) and nothing else', () => {
    expect(LOCK_NOT_AVAILABLE).toBe('55P03');
    expect(isLockTimeout({ code: '55P03' })).toBe(true);
    expect(isLockTimeout(Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }))).toBe(true);
    expect(isLockTimeout({ code: '42P01' })).toBe(false);
    expect(isLockTimeout(new Error('x'))).toBe(false);
    expect(isLockTimeout('55P03')).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
  });

  it('MIGRATE_LOCK_WAIT_MS is a bounded, positive wait in whole seconds', () => {
    expect(Number.isInteger(MIGRATE_LOCK_WAIT_MS)).toBe(true);
    expect(MIGRATE_LOCK_WAIT_MS).toBeGreaterThan(0);
    expect(MIGRATE_LOCK_WAIT_MS % 1000).toBe(0);
    expect(MIGRATE_LOCK_WAIT_MS).toBeLessThanOrEqual(10 * 60 * 1000);
  });

  it('describeLockWait says how long it waited, blames a leaked lock and names the pg_locks query', () => {
    const text = describeLockWait(MIGRATE_LOCK_WAIT_MS);
    expect(text.startsWith(`migrate: REFUSED — another migration run has held the lock for more than ${MIGRATE_LOCK_WAIT_MS / 1000} s.`)).toBe(true);
    expect(text).toContain('leaked');
    expect(text).toContain('DATABASE_URL_UNPOOLED');
    expect(text).toContain(`SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${MIGRATE_LOCK_KEY}`);
    expect(describeLockWait(90_000)).toContain('more than 90 s');
  });
});

describe('checksumOf', () => {
  it('is a 64-character lowercase sha256 hex', () => {
    expect(checksumOf('CREATE TABLE t (id int);')).toMatch(/^[0-9a-f]{64}$/);
    // sha256 of the empty string — pins the algorithm, not just the shape.
    expect(checksumOf('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('ignores the line ending, so an autocrlf checkout does not look edited', () => {
    expect(checksumOf('a\r\nb')).toBe(checksumOf('a\nb'));
    expect(checksumOf('a\r\nb\r\n')).toBe(checksumOf('a\nb\n'));
  });

  it('changes when the text changes', () => {
    expect(checksumOf('a\nb')).not.toBe(checksumOf('a\nc'));
    expect(checksumOf('a\nb')).not.toBe(checksumOf('a\nb\n'));
  });
});

describe('planMigrations', () => {
  const init = file('0001_init.sql', 'CREATE TABLE a (id int);');
  const next = file('0002_next.sql', 'CREATE TABLE b (id int);');

  it('applies a file the ledger does not know', () => {
    const plan = planMigrations([init, next], [row(init.filename, checksumOf(init.sql))], false);
    expect(plan.apply).toEqual([next]);
    expect(plan.backfill).toEqual([]);
    expect(plan.mismatched).toEqual([]);
    expect(plan.missingFiles).toEqual([]);
  });

  it('backfills a ledger row with no checksum instead of applying it again', () => {
    const plan = planMigrations([init], [row(init.filename, null)], false);
    expect(plan.apply).toEqual([]);
    expect(plan.backfill).toEqual([{ filename: init.filename, checksum: checksumOf(init.sql) }]);
    expect(plan.mismatched).toEqual([]);
  });

  it('does nothing for an applied file whose checksum still matches', () => {
    const plan = planMigrations([init], [row(init.filename, checksumOf(init.sql))], false);
    expect(plan).toEqual({ apply: [], backfill: [], mismatched: [], missingFiles: [], invalid: [] });
  });

  it('accepts a CRLF copy of a file the ledger recorded as LF', () => {
    const crlf = file(init.filename, init.sql.replace(/\n/g, '\r\n') + '\r\n');
    const lf = file(init.filename, init.sql + '\n');
    const plan = planMigrations([crlf], [row(init.filename, checksumOf(lf.sql))], false);
    expect(plan.mismatched).toEqual([]);
    expect(plan.backfill).toEqual([]);
  });

  it('reports an applied file that changed since it ran, and does not backfill it', () => {
    const recorded = checksumOf(init.sql);
    const edited = file(init.filename, init.sql + '\nALTER TABLE a ADD COLUMN n int;');
    const plan = planMigrations([edited], [row(init.filename, recorded)], false);
    expect(plan.apply).toEqual([]);
    expect(plan.backfill).toEqual([]);
    expect(plan.mismatched).toEqual([
      { filename: init.filename, ledger: recorded, file: checksumOf(edited.sql) },
    ]);
  });

  it('with allowMismatch, still reports the change AND backfills the new checksum', () => {
    const recorded = checksumOf(init.sql);
    const edited = file(init.filename, init.sql + '\nALTER TABLE a ADD COLUMN n int;');
    const plan = planMigrations([edited], [row(init.filename, recorded)], true);
    expect(plan.mismatched).toHaveLength(1);
    expect(plan.backfill).toEqual([{ filename: init.filename, checksum: checksumOf(edited.sql) }]);
    expect(plan.apply).toEqual([]);
  });

  it('lists a ledger row with no file on disk under missingFiles and never applies it', () => {
    const plan = planMigrations(
      [init],
      [row(init.filename, checksumOf(init.sql)), row('0002_gone.sql', 'abc')],
      false,
    );
    expect(plan.missingFiles).toEqual(['0002_gone.sql']);
    expect(plan.apply).toEqual([]);
    expect(plan.mismatched).toEqual([]);
  });

  it('orders every list by filename whatever order the inputs arrive in', () => {
    const a = file('0003_c.sql', 'c');
    const b = file('0001_a.sql', 'a');
    const c = file('0002_b.sql', 'b');
    const d = file('0005_e.sql', 'e');
    const e = file('0004_d.sql', 'd');
    const plan = planMigrations(
      [a, b, c, d, e],
      [row(d.filename, null), row(e.filename, null), row('0007_z.sql', 'z'), row('0006_y.sql', 'y')],
      false,
    );
    expect(plan.apply.map((f) => f.filename)).toEqual(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
    expect(plan.backfill.map((f) => f.filename)).toEqual(['0004_d.sql', '0005_e.sql']);
    expect(plan.missingFiles).toEqual(['0006_y.sql', '0007_z.sql']);
  });

  it('plans nothing from nothing', () => {
    expect(planMigrations([], [], false)).toEqual({ apply: [], backfill: [], mismatched: [], missingFiles: [], invalid: [] });
  });

  it('does not mutate the files it was given', () => {
    const files = [next, init];
    planMigrations(files, [], false);
    expect(files.map((f) => f.filename)).toEqual(['0002_next.sql', '0001_init.sql']);
  });
});

describe('describeRefusal', () => {
  it('names each changed file, both checksums and the override', () => {
    const plan = planMigrations(
      [file('0010_x.sql', 'new text')],
      [row('0010_x.sql', 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111')],
      false,
    );
    const text = describeRefusal(plan);
    expect(text.startsWith('migrate: REFUSED — 1 applied migration file(s) changed since they ran:')).toBe(true);
    expect(text).toContain('  0010_x.sql: ledger aaaaaaaa… file ' + checksumOf('new text').slice(0, 8) + '…');
    expect(text).toContain('MIGRATE_ALLOW_CHECKSUM_MISMATCH=1');
    expect(
      text.endsWith('Restore the files, or set MIGRATE_ALLOW_CHECKSUM_MISMATCH=1 to accept the new checksums.'),
    ).toBe(true);
    expect(text.split('\n')).toHaveLength(3);
  });

  it('counts every changed file', () => {
    const plan = planMigrations(
      [file('0001_a.sql', 'a2'), file('0002_b.sql', 'b2')],
      [row('0001_a.sql', checksumOf('a1')), row('0002_b.sql', checksumOf('b1'))],
      false,
    );
    expect(describeRefusal(plan)).toContain('2 applied migration file(s)');
    expect(describeRefusal(plan).split('\n')).toHaveLength(4);
  });
});

describe('the override and the lock key', () => {
  it('MIGRATE_ALLOW_CHECKSUM_MISMATCH must be exactly "1"', () => {
    expect(CHECKSUM_OVERRIDE_VAR).toBe('MIGRATE_ALLOW_CHECKSUM_MISMATCH');
    expect(checksumMismatchAllowed('1')).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) {
      expect(checksumMismatchAllowed(v)).toBe(false);
    }
  });

  it('the advisory lock key is a fixed int4', () => {
    expect(Number.isInteger(MIGRATE_LOCK_KEY)).toBe(true);
    expect(Math.abs(MIGRATE_LOCK_KEY)).toBeLessThan(2 ** 31);
  });
});

describe('migrate.ts (source text — importing it would run main())', () => {
  const src = readFileSync(new URL('../packages/db/src/migrate.ts', import.meta.url), 'utf8');

  it('decides the database and refuses a pooled host BEFORE any pool exists, then pins the pool to the direct URL', () => {
    const decide = src.indexOf('const target = migrationTarget(process.env, connectionString())');
    const refuse = src.indexOf('if (target.refusal)');
    const setUrl = src.indexOf('process.env.DATABASE_URL = target.url');
    const connect = src.indexOf('getPool().connect()');
    expect(decide).toBeGreaterThan(0);
    expect(refuse).toBeGreaterThan(decide);
    expect(setUrl).toBeGreaterThan(refuse);
    expect(connect).toBeGreaterThan(setUrl);
    // The refusal prints and exits 1 without connecting.
    expect(src.slice(refuse, setUrl)).toMatch(/console\.error\(target\.refusal\)/);
    expect(src.slice(refuse, setUrl)).toMatch(/process\.exitCode = 1/);
    expect(src).toMatch(/import \{[^}]*\bconnectionString\b[^}]*\} from '\.\/client\.js'/);
  });

  it('holds pg_advisory_lock for the run on the connection that runs the files and unlocks in finally', () => {
    expect(src).toMatch(/const client = await getPool\(\)\.connect\(\)/);
    expect(src).toMatch(/client\.query\('SELECT pg_advisory_lock\(\$1\)', \[MIGRATE_LOCK_KEY\]\)/);
    const finallyAt = src.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThan(0);
    expect(src.slice(finallyAt)).toMatch(/pg_advisory_unlock\(\$1\)/);
    expect(src.slice(finallyAt)).toMatch(/client\.release\(\)/);
  });

  it('bounds the wait for the lock with lock_timeout and refuses on 55P03 instead of hanging', () => {
    const tryAt = src.indexOf('pg_try_advisory_lock($1)');
    const setAt = src.indexOf('SET lock_timeout = ${MIGRATE_LOCK_WAIT_MS}');
    const lockAt = src.indexOf("client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY])");
    const resetAt = src.indexOf('RESET lock_timeout');
    expect(tryAt).toBeGreaterThan(0);
    expect(setAt).toBeGreaterThan(tryAt);
    expect(lockAt).toBeGreaterThan(setAt);
    expect(resetAt).toBeGreaterThan(lockAt);
    const waitBody = src.slice(lockAt, resetAt);
    expect(waitBody).toMatch(/if \(!isLockTimeout\(err\)\) throw err/);
    expect(waitBody).toMatch(/console\.error\(describeLockWait\(MIGRATE_LOCK_WAIT_MS\)\)/);
    expect(waitBody).toMatch(/process\.exitCode = 1/);
    // The lock is taken before the ledger table exists.
    expect(src.indexOf('CREATE TABLE IF NOT EXISTS _migrations')).toBeGreaterThan(resetAt);
  });

  it('unlocks only what it locked and reports an unlock that misses or fails instead of swallowing it', () => {
    const fin = src.slice(src.indexOf('} finally {'));
    expect(fin).toMatch(/if \(locked\)/);
    expect(fin).toMatch(/pg_advisory_unlock\(\$1\) AS ok/);
    expect(fin).toMatch(/console\.error\(\s*'migrate: WARNING pg_advisory_unlock returned false/);
    expect(fin).toMatch(/console\.error\('migrate: WARNING pg_advisory_unlock failed:'/);
    // No parameterless catch anywhere in the runner: every failure is reported.
    expect(src).not.toMatch(/catch\s*\{/);
  });

  it('adds the checksum column and reads it from the ledger', () => {
    expect(src).toMatch(/ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text/);
    expect(src).toMatch(/SELECT filename, checksum FROM _migrations/);
  });

  it('runs each file and its ledger INSERT between an explicit BEGIN and COMMIT, with ROLLBACK on failure', () => {
    const loopAt = src.indexOf('for (const f of plan.apply)');
    expect(loopAt).toBeGreaterThan(0);
    const body = src.slice(loopAt);
    const begin = body.indexOf("client.query('BEGIN')");
    const run = body.indexOf('client.query(f.sql)');
    const insert = body.indexOf('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)');
    const commit = body.indexOf("client.query('COMMIT')");
    const rollback = body.indexOf("client.query('ROLLBACK')");
    expect(begin).toBeGreaterThan(0);
    expect(run).toBeGreaterThan(begin);
    expect(insert).toBeGreaterThan(run);
    expect(commit).toBeGreaterThan(insert);
    expect(rollback).toBeGreaterThan(commit);
    // The ledger row and the file go on the SAME connection — never the pool's
    // bare query() or exec() (a call not preceded by `.` or a word character).
    expect(body).not.toMatch(/(?<![.\w])exec\(/);
    expect(body).not.toMatch(/(?<![.\w])query\(/);
    expect(src).not.toMatch(/import \{[^}]*\b(exec|query)\b[^}]*\} from '\.\/client\.js'/);
  });

  it('refuses a changed applied file unless the override is set, and never splits a file on ";"', () => {
    expect(src).toMatch(/plan\.mismatched\.length > 0 && !allowMismatch/);
    expect(src).toMatch(/console\.error\(describeRefusal\(plan\)\)/);
    expect(src).toMatch(/process\.exitCode = 1/);
    expect(src).toMatch(/process\.exit\(process\.exitCode \?\? 0\)/);
    expect(src).not.toMatch(/split\(['"];/);
  });

  it('refuses a file to apply that cannot run inside its transaction AFTER the plan and BEFORE the backfills and the apply loop — nothing written', () => {
    const planAt = src.indexOf('const plan = planMigrations(files, ledger, allowMismatch)');
    const mismatchAt = src.indexOf('plan.mismatched.length > 0 && !allowMismatch');
    const invalidAt = src.indexOf('if (plan.invalid.length > 0)');
    const backfillAt = src.indexOf('UPDATE _migrations SET checksum');
    const applyAt = src.indexOf('for (const f of plan.apply)');
    expect(planAt).toBeGreaterThan(0);
    expect(mismatchAt).toBeGreaterThan(planAt);
    expect(invalidAt).toBeGreaterThan(mismatchAt);
    expect(backfillAt).toBeGreaterThan(invalidAt);
    expect(applyAt).toBeGreaterThan(backfillAt);
    const body = src.slice(invalidAt, backfillAt);
    expect(body).toMatch(/console\.error\(describeInvalid\(plan\)\)/);
    expect(body).toMatch(/process\.exitCode = 1/);
    expect(body).toMatch(/return;/);
    expect(src).toMatch(/import \{[^}]*\bdescribeInvalid\b[^}]*\} from '\.\/migrateLedger\.js'/);
  });
});

// ── Remediation: DATABASE_URL_UNPOOLED is fenced to the database the seed would empty ──

describe('urlTarget reads the host pg opens', () => {
  it('lets the last ?host= parameter replace the authority host, an empty one falling through (pg-connection-string, as seedGuard reads it)', () => {
    expect(urlTarget(`postgres://u:p@localhost/theone?host=${DIRECT_HOST}`)).toEqual({ host: DIRECT_HOST, database: 'theone' });
    expect(urlTarget(`postgres://u:p@${DIRECT_HOST}/neondb?host=`).host).toBe(DIRECT_HOST);
    expect(urlTarget(`postgres://u:p@localhost/theone?host=${DIRECT_HOST}&host=`).host).toBe('localhost');
    expect(urlTarget(`postgres://u:p@localhost/theone?host=&host=${DIRECT_HOST}`).host).toBe(DIRECT_HOST);
  });

  it('decodes the database name and agrees with the seed guard on every URL both read', () => {
    expect(urlTarget(`postgres://u:p@${DIRECT_HOST}/the%20one`).database).toBe('the one');
    for (const u of [
      LOCAL,
      POOLED,
      DIRECT,
      'postgres://u:p@[::1]:5432/theone',
      `postgres://u:p@${DIRECT_HOST}/the%20one`,
      `postgres://u:p@localhost/theone?host=${DIRECT_HOST}`,
    ]) {
      expect(urlTarget(u)).toEqual(seedTarget(u));
    }
  });
});

describe('directHostKey / sameDatabase', () => {
  it('strips the -pooler label suffix and the case, nothing else', () => {
    expect(directHostKey(POOLED_HOST)).toBe(DIRECT_HOST);
    expect(directHostKey('EP-XYZ.US-EAST-2.AWS.NEON.TECH')).toBe(DIRECT_HOST);
    expect(directHostKey('ep-xyz-pooler')).toBe('ep-xyz');
    expect(directHostKey('localhost')).toBe('localhost');
    expect(directHostKey('my-pooler-ish.example.com')).toBe('my-pooler-ish.example.com');
  });

  it('the pooled and the direct host of one Neon endpoint are one database; another endpoint or another name is not', () => {
    expect(sameDatabase(urlTarget(POOLED), urlTarget(DIRECT))).toBe(true);
    expect(sameDatabase(urlTarget(DIRECT), urlTarget(DIRECT))).toBe(true);
    expect(sameDatabase(urlTarget(DIRECT), urlTarget(OTHER_DIRECT))).toBe(false);
    expect(sameDatabase(urlTarget(DIRECT), urlTarget(DIRECT_OTHER_DB))).toBe(false);
    expect(sameDatabase(urlTarget(LOCAL), urlTarget(DIRECT))).toBe(false);
  });
});

describe('migrationTarget — the fence between DATABASE_URL_UNPOOLED and DATABASE_URL', () => {
  it("both set and naming one database (Neon's pooled / direct pair, one direct URL twice, a host in another case) → ok, no confirmation asked", () => {
    expect(migrationTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: DIRECT }, LOCAL).refusal).toBeNull();
    expect(migrationTarget({ DATABASE_URL: DIRECT, DATABASE_URL_UNPOOLED: DIRECT }, LOCAL).refusal).toBeNull();
    expect(
      migrationTarget(
        { DATABASE_URL: 'postgres://u:p@EP-XYZ-POOLER.US-EAST-2.AWS.NEON.TECH/neondb', DATABASE_URL_UNPOOLED: DIRECT },
        LOCAL,
      ).refusal,
    ).toBeNull();
    expect(migrationTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: LOCAL }, LOCAL).refusal).toBeNull();
  });

  it('both set and naming different databases → refused, naming both targets, never a password', () => {
    // The runbook scenario: a production direct URL left exported in a shell whose DATABASE_URL is the laptop.
    const t = migrationTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: DIRECT }, LOCAL);
    expect(t.source).toBe('DATABASE_URL_UNPOOLED');
    expect(t.refusal).toMatch(
      /^migrate: REFUSED — DATABASE_URL_UNPOOLED \(ep-xyz\.us-east-2\.aws\.neon\.tech\/neondb\) and DATABASE_URL \(localhost\/theone\) name different databases; unset the stale one\./,
    );
    expect(t.refusal).toContain('seed');
    expect(t.refusal).not.toContain('u:p@');
    expect(t.refusal).not.toContain('theone:theone');
    // The same endpoint under another database name is still two databases.
    expect(migrationTarget({ DATABASE_URL: DIRECT, DATABASE_URL_UNPOOLED: DIRECT_OTHER_DB }, LOCAL).refusal).toMatch(
      /name different databases/,
    );
    // Two endpoints.
    expect(migrationTarget({ DATABASE_URL: POOLED, DATABASE_URL_UNPOOLED: OTHER_DIRECT }, LOCAL).refusal).toMatch(
      /name different databases/,
    );
    // An unreadable DATABASE_URL cannot be shown to agree.
    expect(migrationTarget({ DATABASE_URL: 'not a url', DATABASE_URL_UNPOOLED: DIRECT }, LOCAL).refusal).toContain(
      'DATABASE_URL (?/?)',
    );
  });

  it('DATABASE_URL_UNPOOLED alone, off this machine, without ALLOW_MIGRATE → refused, naming the value to set', () => {
    expect(MIGRATE_CONFIRM_VAR).toBe('ALLOW_MIGRATE');
    const t = migrationTarget({ DATABASE_URL_UNPOOLED: DIRECT }, LOCAL);
    expect(t.source).toBe('DATABASE_URL_UNPOOLED');
    expect(t.url).toBe(DIRECT);
    expect(t.refusal).toMatch(
      /^migrate: REFUSED — DATABASE_URL_UNPOOLED points at ep-xyz\.us-east-2\.aws\.neon\.tech\/neondb, which is not localhost/,
    );
    expect(t.refusal).toContain('ALLOW_MIGRATE=ep-xyz.us-east-2.aws.neon.tech/neondb');
    expect(t.refusal).toContain('seed');
    expect(t.refusal).not.toContain('u:p@');
    // A wrong confirmation is no confirmation: the database alone, the host alone, another database, the pooled spelling, a boolean.
    for (const v of ['neondb', DIRECT_HOST, `${DIRECT_HOST}/otherdb`, `${POOLED_HOST}/neondb`, '1', 'true', '']) {
      expect(migrationTarget({ DATABASE_URL_UNPOOLED: DIRECT, ALLOW_MIGRATE: v }, LOCAL).refusal).not.toBeNull();
    }
    // A string that is not a URL is refused outright (the block below), never offered as ALLOW_MIGRATE=?/?.
    expect(migrationTarget({ DATABASE_URL_UNPOOLED: 'not a url' }, LOCAL).refusal).not.toContain('?/?');
  });

  it('DATABASE_URL_UNPOOLED alone with ALLOW_MIGRATE=<host>/<database> → ok (trimmed; the host case-insensitively, the database exactly — the ALLOW_SEED rule)', () => {
    const t = migrationTarget({ DATABASE_URL_UNPOOLED: DIRECT, ALLOW_MIGRATE: ` ${DIRECT_HOST}/neondb ` }, LOCAL);
    expect(t).toEqual({ url: DIRECT, source: 'DATABASE_URL_UNPOOLED', host: DIRECT_HOST, database: 'neondb', refusal: null });
    expect(migrateConfirmed(`${DIRECT_HOST}/neondb`, DIRECT_HOST, 'neondb')).toBe(true);
    expect(migrateConfirmed(undefined, DIRECT_HOST, 'neondb')).toBe(false);
    expect(migrateConfirmed('neondb', DIRECT_HOST, 'neondb')).toBe(false);
    // Hostnames are case-insensitive (and the WHATWG parser keeps whatever case a postgres:// URL gives); a database name is not.
    expect(migrateConfirmed(`${DIRECT_HOST.toUpperCase()}/neondb`, DIRECT_HOST, 'neondb')).toBe(true);
    expect(migrateConfirmed(`${DIRECT_HOST}/neondb`, DIRECT_HOST.toUpperCase(), 'neondb')).toBe(true);
    expect(migrateConfirmed(`${DIRECT_HOST}/NEONDB`, DIRECT_HOST, 'neondb')).toBe(false);
    expect(
      migrationTarget(
        { DATABASE_URL_UNPOOLED: `postgres://u:p@${DIRECT_HOST.toUpperCase()}/neondb`, ALLOW_MIGRATE: `${DIRECT_HOST}/neondb` },
        LOCAL,
      ).refusal,
    ).toBeNull();
    expect(migrationTarget({ DATABASE_URL_UNPOOLED: DIRECT, ALLOW_MIGRATE: `${DIRECT_HOST}/NEONDB` }, LOCAL).refusal).toMatch(
      /not localhost/,
    );
  });

  it('ALLOW_MIGRATE and ALLOW_SEED are ONE comparison: migrateConfirmed answers exactly what seedConfirmed answers', () => {
    const targets = [
      { host: DIRECT_HOST, database: 'neondb' },
      { host: DIRECT_HOST.toUpperCase(), database: 'neondb' },
      { host: 'localhost', database: 'the one' },
      { host: '', database: 'neondb' },
      { host: DIRECT_HOST, database: '' },
    ];
    const values = [
      undefined,
      '',
      'neondb',
      DIRECT_HOST,
      `${DIRECT_HOST}/neondb`,
      ` ${DIRECT_HOST}/neondb `,
      `${DIRECT_HOST.toUpperCase()}/neondb`,
      `${DIRECT_HOST}/NEONDB`,
      `${POOLED_HOST}/neondb`,
      '/neondb',
      `${DIRECT_HOST}/`,
      'localhost/the one',
      'LOCALHOST/the one',
    ];
    for (const target of targets) {
      for (const value of values) {
        expect(migrateConfirmed(value, target.host, target.database), `${value} vs ${target.host}/${target.database}`).toBe(
          seedConfirmed(value, target),
        );
      }
    }
    // The rule itself, so a change on either side shows here as well as in tests/seed-guard.test.ts.
    expect(migrateConfirmed('/neondb', '', 'neondb')).toBe(false);
    expect(migrateConfirmed(`${DIRECT_HOST}/`, DIRECT_HOST, '')).toBe(false);
    expect(migrateConfirmed('LOCALHOST/the one', 'localhost', 'the one')).toBe(true);
  });

  it('DATABASE_URL_UNPOOLED alone naming no host or no database is refused outright: no value confirms a target the guard cannot name', () => {
    const noHost = migrationTarget({ DATABASE_URL_UNPOOLED: 'postgres:///neondb', ALLOW_MIGRATE: '/neondb' }, LOCAL);
    expect(noHost.host).toBe('');
    expect(noHost.refusal).toMatch(/^migrate: REFUSED — DATABASE_URL_UNPOOLED names no host \(\/neondb\) while DATABASE_URL is unset/);
    expect(noHost.refusal).toContain('no ALLOW_MIGRATE value confirms');
    expect(noHost.refusal).not.toContain('ALLOW_MIGRATE=');
    const noDb = migrationTarget({ DATABASE_URL_UNPOOLED: `postgres://u:p@${DIRECT_HOST}/`, ALLOW_MIGRATE: `${DIRECT_HOST}/` }, LOCAL);
    expect(noDb.database).toBe('');
    expect(noDb.refusal).toMatch(/names no database \(ep-xyz\.us-east-2\.aws\.neon\.tech\/\)/);
    expect(noDb.refusal).not.toContain('u:p@');
  });

  it('a DATABASE_URL_UNPOOLED the guard cannot read is refused outright, DATABASE_URL beside it or not: ALLOW_MIGRATE=?/? confirms nothing', () => {
    // Node's parser throws on credentials before an empty host (pg-connection-string would open PGHOST or localhost
    // for it) and on nothing after them, and the decode throws on a database percent-encoded beyond reading. The
    // old fence printed `points at ?/?` and took ALLOW_MIGRATE=?/? as the confirmation.
    const unreadable = [
      'postgres://u:s3cret@/neondb',
      'postgres://u:s3cret@:5432/neondb',
      'not a url',
      `postgres://u:s3cret@${DIRECT_HOST}/%E0%A4%A`,
    ];
    for (const u of unreadable) {
      for (const allow of [undefined, '?/?', ' ?/? ', 'neondb', `${DIRECT_HOST}/neondb`]) {
        const t = migrationTarget({ DATABASE_URL_UNPOOLED: u, ALLOW_MIGRATE: allow }, LOCAL);
        expect(t.url, u).toBe(u);
        expect(t.host, u).toBe('?');
        expect(t.refusal, `${u} with ALLOW_MIGRATE=${allow}`).toMatch(
          /^migrate: REFUSED — DATABASE_URL_UNPOOLED is not a URL the guard can read/,
        );
        expect(t.refusal).toContain('no ALLOW_MIGRATE value confirms');
        expect(t.refusal).toContain('postgres://user:password@host/database');
        expect(t.refusal).not.toContain('ALLOW_MIGRATE=');
        expect(t.refusal).not.toContain('?/?');
        expect(t.refusal).not.toContain('s3cret');
      }
      // Beside a DATABASE_URL, readable or not, the same refusal: a pair with an unreadable side cannot be shown to
      // agree (two unreadable strings used to compare equal as ?/? and go through to pg).
      expect(migrationTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: u }, LOCAL).refusal, u).toMatch(
        /not a URL the guard can read/,
      );
      expect(migrationTarget({ DATABASE_URL: u, DATABASE_URL_UNPOOLED: u }, LOCAL).refusal, u).toMatch(
        /not a URL the guard can read/,
      );
    }
    // The comparison itself is still the seed's (a '?' host is a non-empty host to it): the fence refuses before asking.
    expect(migrateConfirmed('?/?', '?', '?')).toBe(seedConfirmed('?/?', { host: '?', database: '?' }));
  });

  it('DATABASE_URL_UNPOOLED alone on this machine needs no confirmation', () => {
    for (const u of [
      LOCAL,
      'postgres://u:p@127.0.0.1:5432/theone',
      'postgres://u:p@[::1]:5432/theone',
      'postgres://u:p@LOCALHOST/theone',
    ]) {
      expect(migrationTarget({ DATABASE_URL_UNPOOLED: u }, LOCAL).refusal).toBeNull();
    }
  });

  it('ALLOW_MIGRATE never excuses a pooled host or a pair that differs; the pooled refusal comes first', () => {
    expect(
      migrationTarget({ DATABASE_URL_UNPOOLED: POOLED, ALLOW_MIGRATE: `${POOLED_HOST}/neondb` }, LOCAL).refusal,
    ).toMatch(/pooled endpoint/);
    expect(
      migrationTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: DIRECT, ALLOW_MIGRATE: `${DIRECT_HOST}/neondb` }, LOCAL)
        .refusal,
    ).toMatch(/name different databases/);
    expect(migrationTarget({ DATABASE_URL: LOCAL, DATABASE_URL_UNPOOLED: POOLED }, LOCAL).refusal).toMatch(
      /^migrate: REFUSED — DATABASE_URL_UNPOOLED is a pooled endpoint/,
    );
  });

  it('a DATABASE_URL alone is decided as before: no confirmation asked (the seed guard fences that shell)', () => {
    expect(migrationTarget({ DATABASE_URL: DIRECT }, LOCAL).refusal).toBeNull();
    expect(migrationTarget({ DATABASE_URL: DIRECT, ALLOW_MIGRATE: '' }, LOCAL).refusal).toBeNull();
  });

  it('the fence reads the host pg opens: a ?host= parameter on a localhost-looking URL counts', () => {
    const crafted = `postgres://u:p@localhost/theone?host=${DIRECT_HOST}`;
    const t = migrationTarget({ DATABASE_URL_UNPOOLED: crafted }, LOCAL);
    expect(t.host).toBe(DIRECT_HOST);
    expect(t.refusal).toMatch(/not localhost/);
    expect(t.refusal).toContain(`ALLOW_MIGRATE=${DIRECT_HOST}/theone`);
    // …and the pooled check sees through it too.
    expect(migrationTarget({ DATABASE_URL: `postgres://u:p@localhost/theone?host=${POOLED_HOST}` }, LOCAL).refusal).toMatch(
      /pooled endpoint/,
    );
  });
});

describe('describeSeedUnpooledMismatch — the warning seed.ts prints under "seed: database"', () => {
  const laptop = { host: 'localhost', database: 'theone' };

  it('is silent when DATABASE_URL_UNPOOLED is unset or blank', () => {
    expect(describeSeedUnpooledMismatch(undefined, laptop)).toBeNull();
    expect(describeSeedUnpooledMismatch('', laptop)).toBeNull();
    expect(describeSeedUnpooledMismatch('   ', laptop)).toBeNull();
  });

  it('is silent when it names the database the seed is about to empty, pooled or direct', () => {
    expect(describeSeedUnpooledMismatch(DIRECT, urlTarget(POOLED))).toBeNull();
    expect(describeSeedUnpooledMismatch(DIRECT, urlTarget(DIRECT))).toBeNull();
    expect(describeSeedUnpooledMismatch(LOCAL, laptop)).toBeNull();
  });

  it('names both databases, says which command goes where, and never a password', () => {
    const w = describeSeedUnpooledMismatch(DIRECT, laptop);
    expect(w).toMatch(
      /^seed: WARNING DATABASE_URL_UNPOOLED is set and names ep-xyz\.us-east-2\.aws\.neon\.tech\/neondb, not this database/,
    );
    expect(w).toContain('db:migrate');
    expect(w).toContain('empties localhost/theone');
    expect(w).toContain('Unset it if it is stale');
    expect(w).not.toContain('u:p@');
    expect(describeSeedUnpooledMismatch(DIRECT_OTHER_DB, urlTarget(DIRECT))).toContain('otherdb');
  });
});

describe('seed.ts (source text — importing it would run main())', () => {
  const src = readFileSync(new URL('../packages/db/src/seed.ts', import.meta.url), 'utf8');

  it('prints the DATABASE_URL_UNPOOLED warning right under the database line, before the guard decides and before any TRUNCATE', () => {
    const database = src.indexOf('console.log(`seed: database ${decision.target.host}/${decision.target.database}`)');
    const warn = src.indexOf('describeSeedUnpooledMismatch(process.env.DATABASE_URL_UNPOOLED, decision.target)');
    const decide = src.indexOf('if (!decision.ok)');
    const truncate = src.indexOf('TRUNCATE TABLE');
    expect(database).toBeGreaterThan(0);
    expect(warn).toBeGreaterThan(database);
    expect(decide).toBeGreaterThan(warn);
    expect(truncate).toBeGreaterThan(decide);
    expect(src.slice(warn, decide)).toMatch(/console\.warn\(unpooledWarning\)/);
    expect(src).toMatch(/import \{[^}]*\bdescribeSeedUnpooledMismatch\b[^}]*\} from '\.\/migrateLedger\.js'/);
  });
});

// ── Follow-up: files that cannot run inside the runner's transaction (the lock registry is tests/advisory-locks.test.ts) ──

describe('blankCommentsAndStrings', () => {
  // Same length, same line breaks; runs of spaces squashed so the assertions read.
  const blanked = (sql: string) => {
    const out = blankCommentsAndStrings(sql);
    expect(out).toHaveLength(sql.length);
    expect(out.split('\n')).toHaveLength(sql.split('\n').length);
    return out.replace(/ +/g, ' ');
  };
  const BS = String.fromCharCode(92);

  it('blanks -- comments, block comments (nested, as Postgres nests them), strings, quoted identifiers and $$ bodies to spaces, keeping every newline', () => {
    expect(blanked('SELECT 1; -- BEGIN\nSELECT 2;')).toBe('SELECT 1; \nSELECT 2;');
    expect(blanked('/* a\nb */x')).toBe(' \n x');
    expect(blanked('/* outer /* inner */ COMMIT */ x')).toBe(' x');
    expect(blanked("a 'it''s' b")).toBe('a b');
    expect(blanked(`a E'x${BS}'y' b`)).toBe('a E b');
    expect(blanked('a "commit" b')).toBe('a b');
    expect(blanked('a $$ BEGIN $$ b')).toBe('a b');
    expect(blanked('a $fn$ $$ BEGIN $$ $fn$ b')).toBe('a b');
    expect(blanked('a\r\n-- COMMIT\r\nb')).toBe('a\r\n \r\nb');
  });

  it('leaves code alone: a positional $1 is not a dollar tag, and an unterminated quote blanks to the end', () => {
    expect(blanked('x $1 y')).toBe('x $1 y');
    expect(blanked("a 'unterminated\nBEGIN")).toBe('a \n ');
    expect(blanked('')).toBe('');
  });
});

describe('migrationFileProblems / planMigrations.invalid — a file that cannot run inside the runner\'s transaction', () => {
  it('names BEGIN / START TRANSACTION / COMMIT / ROLLBACK at a statement start, with the line, in file order', () => {
    expect(migrationFileProblems('BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;')).toEqual([
      'line 1: BEGIN — a migration must not manage its own transaction; the runner wraps each file in one',
      'line 3: COMMIT — a migration must not manage its own transaction; the runner wraps each file in one',
    ]);
    expect(migrationFileProblems('start   transaction isolation level serializable;\nSELECT 1;')).toEqual([
      expect.stringMatching(/^line 1: START TRANSACTION — /),
    ]);
    expect(migrationFileProblems('CREATE TABLE a (id int); ROLLBACK;')).toEqual([expect.stringMatching(/^line 1: ROLLBACK — /)]);
    expect(migrationFileProblems('\n  begin work;')).toEqual([expect.stringMatching(/^line 2: BEGIN — /)]);
    expect(migrationFileProblems('CREATE TABLE a (id int);\nCOMMIT')).toEqual([expect.stringMatching(/^line 2: COMMIT — /)]);
    expect(migrationFileProblems('CREATE TABLE a (id int);\r\nCOMMIT;\r\n')).toEqual([expect.stringMatching(/^line 2: COMMIT — /)]);
    expect(migrationFileProblems('COMMIT AND CHAIN;')).toHaveLength(1);
    expect(migrationFileProblems('ROLLBACK TO SAVEPOINT s;')).toHaveLength(1);
    // Blank lines between the `;` and the word are no bar: it is the statement start that counts, not the line.
    expect(migrationFileProblems('SELECT 1;\n\n\n  COMMIT\n;')).toEqual([expect.stringMatching(/^line 4: COMMIT — /)]);
    // A BEGIN that forgot its `;` is still a BEGIN (Postgres would refuse `BEGIN SELECT` anyway).
    expect(migrationFileProblems('BEGIN\nSELECT 1;')).toEqual([expect.stringMatching(/^line 1: BEGIN — /)]);
    // The word must end there: a longer word at a statement start is not transaction control.
    expect(migrationFileProblems('COMMITTED;\nBEGINNING;')).toEqual([]);
  });

  it('names CONCURRENTLY anywhere, with the line', () => {
    expect(migrationFileProblems('CREATE INDEX CONCURRENTLY i ON a (id);')).toEqual([
      'line 1: CONCURRENTLY — cannot run inside a transaction, and the runner wraps each file in one',
    ]);
    expect(migrationFileProblems('SELECT 1;\nreindex index concurrently i;')).toEqual([expect.stringMatching(/^line 2: CONCURRENTLY — /)]);
    expect(migrationFileProblems('REFRESH MATERIALIZED VIEW CONCURRENTLY mv;')).toHaveLength(1);
  });

  it('a file with both is reported once per statement, in line order', () => {
    const reasons = migrationFileProblems('BEGIN;\nSELECT 1;\nCREATE INDEX CONCURRENTLY i ON a (id);\nCOMMIT;');
    expect(reasons.map((r) => r.slice(0, r.indexOf(' — ')))).toEqual(['line 1: BEGIN', 'line 3: CONCURRENTLY', 'line 4: COMMIT']);
  });

  it('does not trip on the word in a -- comment, a block comment, a string, a quoted identifier or a dollar-quoted body', () => {
    const BS = String.fromCharCode(92);
    for (const sql of [
      '-- BEGIN of the schema\nCREATE TABLE a (id int);',
      'CREATE TABLE a (id int); -- then COMMIT\n',
      '/* COMMIT\n   BEGIN */ CREATE TABLE a (id int);',
      '/* outer /* inner */ COMMIT */ SELECT 1;',
      "INSERT INTO t (name) VALUES ('BEGIN');",
      "INSERT INTO t VALUES ('x;\nBEGIN;');",
      `INSERT INTO t VALUES (E'it${BS}'s;\nCOMMIT;');`,
      'CREATE TABLE "commit" ("begin" int);',
      // The shape 0001 ships: the plpgsql body on the line after the opening $$.
      'CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$\nBEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;',
      'CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  RAISE EXCEPTION $x$no$x$;\nEND;\n$$ LANGUAGE plpgsql;',
      'DO $body$ BEGIN\n  PERFORM 1;\nEND $body$;',
      '-- CREATE INDEX CONCURRENTLY i ON a (id);\nSELECT 1;',
      "SELECT 'CONCURRENTLY';",
      'DO $$ BEGIN EXECUTE $q$CREATE INDEX CONCURRENTLY i ON a (id)$q$; END $$;',
    ]) {
      expect(migrationFileProblems(sql), sql).toEqual([]);
    }
  });

  it('a comment with the word and a real statement in the same file → only the statement, with its own line', () => {
    expect(migrationFileProblems('-- BEGIN here\nBEGIN;\nSELECT 1;')).toEqual([expect.stringMatching(/^line 2: BEGIN — /)]);
  });

  it('does not trip on a column named commit / begin / rollback (on a line of its own too: a statement start, never a line start), on ON COMMIT DROP, or on a SQL-standard BEGIN ATOMIC body', () => {
    for (const sql of [
      'CREATE TABLE deploy (\n  commit text,\n  begin timestamptz,\n  rollback boolean\n);',
      // The word alone on a line of a column list — what a line-start regex (/^\s*COMMIT\b/m) reads as transaction control.
      'SELECT\n  id,\n  commit\nFROM t;',
      'INSERT INTO t (\n  a,\n  rollback\n) VALUES (1, 2);',
      'UPDATE t SET\n  begin\n  = now()\nWHERE id = 1;',
      'CREATE TABLE deploy (\n  id int,\n  commit\n    text\n);',
      'CREATE TEMP TABLE t (x int)\n  ON COMMIT DROP;',
      'CREATE FUNCTION one() RETURNS int LANGUAGE sql\nBEGIN ATOMIC\n  SELECT 1;\nEND;',
    ]) {
      expect(migrationFileProblems(sql), sql).toEqual([]);
    }
  });

  it('planMigrations lists the problems of files to apply under invalid, by filename then line, and still plans them', () => {
    const bad = file('0084_bad.sql', 'BEGIN;\nCREATE TABLE b (id int);');
    const worse = file('0083_worse.sql', 'CREATE INDEX CONCURRENTLY i ON a (id);');
    const plan = planMigrations([bad, worse, file('0085_fine.sql', 'CREATE TABLE c (id int);')], [], false);
    expect(plan.apply.map((f) => f.filename)).toEqual(['0083_worse.sql', '0084_bad.sql', '0085_fine.sql']);
    expect(plan.invalid).toEqual([
      { filename: '0083_worse.sql', reason: expect.stringMatching(/^line 1: CONCURRENTLY — /) },
      { filename: '0084_bad.sql', reason: expect.stringMatching(/^line 1: BEGIN — /) },
    ]);
  });

  it('checks only files to apply: an applied file, changed or not, or one awaiting its checksum is never reported', () => {
    const applied = file('0001_init.sql', 'BEGIN;\nCREATE TABLE a (id int);\nCOMMIT;');
    expect(planMigrations([applied], [row(applied.filename, checksumOf(applied.sql))], false).invalid).toEqual([]);
    expect(planMigrations([applied], [row(applied.filename, null)], false).invalid).toEqual([]);
    expect(planMigrations([applied], [row(applied.filename, checksumOf('other'))], false).invalid).toEqual([]);
    expect(planMigrations([applied], [row(applied.filename, checksumOf('other'))], true).invalid).toEqual([]);
  });
});

describe('describeInvalid', () => {
  it('counts the files, names each statement with its file and line, and says nothing was applied', () => {
    const plan = planMigrations(
      [file('0083_x.sql', 'BEGIN;\nSELECT 1;\nCREATE INDEX CONCURRENTLY i ON a (id);'), file('0084_y.sql', 'COMMIT;')],
      [],
      false,
    );
    const text = describeInvalid(plan);
    const lines = text.split('\n');
    expect(lines[0]).toBe('migrate: REFUSED — 2 migration file(s) to apply cannot run as written:');
    expect(lines[1]).toBe('  0083_x.sql: line 1: BEGIN — a migration must not manage its own transaction; the runner wraps each file in one');
    expect(lines[2]).toBe('  0083_x.sql: line 3: CONCURRENTLY — cannot run inside a transaction, and the runner wraps each file in one');
    expect(lines[3]).toBe('  0084_y.sql: line 1: COMMIT — a migration must not manage its own transaction; the runner wraps each file in one');
    expect(lines[4]).toBe('Fix the file(s) and run again; nothing was applied.');
    expect(lines).toHaveLength(5);
    // No override for this one: the file is wrong, not the ledger.
    expect(text).not.toContain('MIGRATE_ALLOW');
  });
});

describe('the migrations on disk', () => {
  const dir = new URL('../packages/db/migrations/', import.meta.url);
  const files: MigrationFile[] = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((filename) => ({ filename, sql: readFileSync(new URL(filename, dir), 'utf8') }));

  it('every shipped file passes the check as a fresh database (CI, a new Neon branch) would apply it', () => {
    expect(files.length).toBeGreaterThanOrEqual(82);
    const plan = planMigrations(files, [], false);
    expect(plan.apply).toHaveLength(files.length);
    expect(plan.invalid).toEqual([]);
  });

  it('…which is why the check blanks dollar-quoted bodies: the naive line-start regex trips on the plpgsql BEGIN of 0001, 0029 and 0048', () => {
    const naive = files.filter((f) => /^\s*(BEGIN|START TRANSACTION|COMMIT|ROLLBACK)\b/im.test(f.sql)).map((f) => f.filename);
    expect(naive).toEqual(expect.arrayContaining(['0001_init.sql', '0029_activity_log_immutable.sql', '0048_quote_document.sql']));
  });
});

// Migration ledger — the pure half of migrate.ts.
//
// migrate.ts runs main() at import, so everything that can be checked without
// a database lives here: which connection string a run uses (and the refusals
// — a pooled host, DATABASE_URL_UNPOOLED and DATABASE_URL naming different
// databases, a lone DATABASE_URL_UNPOOLED off this machine without
// ALLOW_MIGRATE, a DATABASE_URL_UNPOOLED the guard cannot read), the checksum
// of a migration file, the plan a run follows
// (what to apply, which of those files cannot run inside the runner's
// transaction, which ledger rows to backfill, which applied files changed
// since they ran, which ledger rows have no file on disk), the refusal
// messages, and the warning seed.ts prints when DATABASE_URL_UNPOOLED points
// at some other database. tests/migrate-ledger.test.ts pins all of it.

import { createHash } from 'node:crypto';
import { ADVISORY_LOCKS } from '@theone/shared';
import { LOCAL_HOSTS, seedConfirmed } from './seedGuard.js';

/**
 * The session-level advisory lock a migration run holds on the connection
 * that runs the files, so two runners cannot interleave. Its value is the
 * registry's (packages/shared/src/advisoryLocks.ts): an advisory key is
 * global to the database, so every key in the system is listed there and
 * no two purposes share one. Who holds it:
 * `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = <MIGRATE_LOCK_KEY>`.
 */
export const MIGRATE_LOCK_KEY = ADVISORY_LOCKS.migrate;

/**
 * How long a run waits for another run's lock before it refuses (lock_timeout
 * on the pg_advisory_lock call). Bounded on purpose: a lock leaked by a pooled
 * session would otherwise hang every later run.
 */
export const MIGRATE_LOCK_WAIT_MS = 120_000;

/** SQLSTATE lock_not_available — what lock_timeout raises when the wait runs out. */
export const LOCK_NOT_AVAILABLE = '55P03';

/** The direct-connection variable Neon writes beside DATABASE_URL (`neon env pull`, the Vercel integration). */
export const UNPOOLED_URL_VAR = 'DATABASE_URL_UNPOOLED';

/**
 * The env var that confirms a migrate of a database that is not on this
 * machine when DATABASE_URL_UNPOOLED is the only URL set. Its value must be
 * the `<host>/<database>` the run prints — the operator typing out what they
 * are about to migrate, the shape the seed's ALLOW_SEED takes, compared by
 * the seed's rule (migrateConfirmed).
 */
export const MIGRATE_CONFIRM_VAR = 'ALLOW_MIGRATE';

/** The env var that lets a run accept changed applied files (value must be exactly '1'). */
export const CHECKSUM_OVERRIDE_VAR = 'MIGRATE_ALLOW_CHECKSUM_MISMATCH';

/** `MIGRATE_ALLOW_CHECKSUM_MISMATCH=1` and nothing else — any other value refuses. */
export function checksumMismatchAllowed(value: string | undefined): boolean {
  return value === '1';
}

/** True for the error pg_advisory_lock throws when lock_timeout fires. */
export function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/** The message printed (to stderr) when the wait for the lock runs out. */
export function describeLockWait(waitMs: number): string {
  const seconds = Math.round(waitMs / 1000);
  return (
    `migrate: REFUSED — another migration run has held the lock for more than ${seconds} s. ` +
    `If no other migrate is running, the lock was leaked by a session that never released it (a pooled ` +
    `connection does that): run on the direct host (${UNPOOLED_URL_VAR}) once that session has ended — ` +
    `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = ${MIGRATE_LOCK_KEY} names it.`
  );
}

/**
 * Neon's pooled endpoint carries `-pooler` in its hostname
 * (ep-…-pooler.us-east-2.aws.neon.tech). It is PgBouncer in transaction mode:
 * each statement may land on a different server backend, so a session-level
 * advisory lock taken there is held by one backend while the files run on
 * another, the unlock misses, and the lock leaks until that backend is recycled.
 */
export function isPooledHost(hostname: string): boolean {
  return hostname.toLowerCase().includes('-pooler');
}

/**
 * Host and database of a connection URL, for printing and for the fence in
 * migrationTarget (never the URL: it carries the password). The host is the
 * one pg opens, read as seedGuard.ts reads it: the last `?host=` query
 * parameter replaces the authority's host (an empty one falls through —
 * pg-connection-string's rule), percent-encoding decoded, brackets off an
 * IPv6 host, query string dropped; a string that is not a URL → '?' for
 * printing (readUrlTarget answers null — how migrationTarget tells a target
 * it cannot name from one it can).
 */
export function urlTarget(url: string): { host: string; database: string } {
  return readUrlTarget(url) ?? { host: '?', database: '?' };
}

/**
 * urlTarget's parse: null when the string is not a URL (Node's parser throws
 * on credentials before an empty host, `u:p@/db`, and on nothing after them)
 * or its host or database is percent-encoded beyond reading.
 * pg-connection-string reads such a string by rules of its own — `u:p@/db`
 * opens PGHOST, else localhost — which the fence must never let through.
 */
export function readUrlTarget(url: string): { host: string; database: string } | null {
  try {
    const parsed = new URL(url);
    const hostParams = parsed.searchParams.getAll('host');
    const hostParam = hostParams.length > 0 ? hostParams[hostParams.length - 1] : '';
    const host = hostParam !== '' ? hostParam : decodeURIComponent(parsed.hostname);
    return {
      host: host.replace(/^\[(.*)\]$/, '$1'),
      database: decodeURI(parsed.pathname.slice(1).split('?')[0]),
    };
  } catch {
    return null;
  }
}

/**
 * What the pooled and the direct URL of one Neon database share: the hostname
 * lower-cased with the `-pooler` label suffix removed (ep-xyz-pooler.us-east-2…
 * and ep-xyz.us-east-2… are one endpoint).
 */
export function directHostKey(hostname: string): string {
  return hostname.toLowerCase().replace(/-pooler(?=\.|$)/, '');
}

/** True when both name the same database: one endpoint (pooled or direct), one database name. */
export function sameDatabase(
  a: { host: string; database: string },
  b: { host: string; database: string },
): boolean {
  return directHostKey(a.host) === directHostKey(b.host) && a.database === b.database;
}

/**
 * `ALLOW_MIGRATE` must spell the `<host>/<database>` the run prints (trimmed):
 * the host case-insensitively, the database exactly, and never a target with
 * no host or no database — ALLOW_SEED's rule, by the seed guard's own
 * comparison (seedConfirmed), so the two confirmations cannot drift apart.
 */
export function migrateConfirmed(value: string | undefined, host: string, database: string): boolean {
  return seedConfirmed(value, { host, database });
}

export type MigrationUrlSource = typeof UNPOOLED_URL_VAR | 'DATABASE_URL' | 'default';

export interface MigrationTarget {
  /** The connection string the run uses — migrate.ts puts it in DATABASE_URL before the pool is created. */
  url: string;
  /** Which variable supplied it. */
  source: MigrationUrlSource;
  host: string;
  database: string;
  /**
   * The printed refusal, when the run is refused before any connection: a
   * DATABASE_URL_UNPOOLED the guard cannot read; a pooled host;
   * DATABASE_URL_UNPOOLED and DATABASE_URL naming different databases;
   * DATABASE_URL_UNPOOLED alone, off this machine, unconfirmed.
   */
  refusal: string | null;
}

/** A variable counts as set when it is non-empty after trim; the trimmed value is used. */
function setVar(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Which database a run migrates: DATABASE_URL_UNPOOLED when set (Neon's
 * direct host), else DATABASE_URL, else `defaultUrl` (client.ts's localhost).
 * Refused, before any connection: a pooled hostname, whichever variable
 * supplied it; both variables set and naming different databases — the seed
 * reads only DATABASE_URL, so `npm run setup` would migrate one and seed the
 * other; DATABASE_URL_UNPOOLED alone, pointing off this machine, unless
 * ALLOW_MIGRATE spells its `<host>/<database>` — a remote migrate is a
 * deliberate act, as a remote seed is; one naming no host or no database is
 * refused outright, as the seed guard refuses it (pg would open PGHOST or
 * localhost, which no confirmation can name), and so is one the guard cannot
 * read at all (the seed guard throws on it; pg-connection-string reads
 * `u:p@/db` as PGHOST or localhost) — whether or not DATABASE_URL is set
 * beside it, whatever ALLOW_MIGRATE says. Both variables set and agreeing
 * (the Neon / Vercel layout) need no confirmation. A DATABASE_URL alone the
 * guard cannot read is left to pg as before (the seed guard fences that
 * shell).
 */
export function migrationTarget(env: Record<string, string | undefined>, defaultUrl: string): MigrationTarget {
  const unpooled = setVar(env[UNPOOLED_URL_VAR]);
  const standard = setVar(env.DATABASE_URL);
  const [url, source]: [string, MigrationUrlSource] = unpooled
    ? [unpooled, UNPOOLED_URL_VAR]
    : standard
      ? [standard, 'DATABASE_URL']
      : [defaultUrl, 'default'];
  const read = readUrlTarget(url);
  const { host, database } = read ?? { host: '?', database: '?' };
  let refusal: string | null = null;
  if (unpooled && !read) {
    refusal =
      `migrate: REFUSED — ${UNPOOLED_URL_VAR} is not a URL the guard can read (pg would fill the host in by rules of ` +
      `its own: PGHOST, else localhost). Spell it out as postgres://user:password@host/database — no ` +
      `${MIGRATE_CONFIRM_VAR} value confirms a target the guard cannot name.`;
  } else if (isPooledHost(host)) {
    refusal =
      `migrate: REFUSED — ${source} is a pooled endpoint (${host}). A session advisory lock is not honoured ` +
      `through PgBouncer transaction pooling: two runs could interleave and a leaked lock could hang the next ` +
      `one. Run migrations on the direct connection string — set ${UNPOOLED_URL_VAR} to it (Neon's host ` +
      `without '-pooler').`;
  } else if (unpooled && standard) {
    const other = urlTarget(standard);
    if (!sameDatabase({ host, database }, other)) {
      refusal =
        `migrate: REFUSED — ${UNPOOLED_URL_VAR} (${host}/${database}) and DATABASE_URL ` +
        `(${other.host}/${other.database}) name different databases; unset the stale one. ` +
        `npm run setup would migrate one and seed the other.`;
    }
  } else if (unpooled && !LOCAL_HOSTS.includes(host.toLowerCase())) {
    if (host === '' || database === '') {
      refusal =
        `migrate: REFUSED — ${UNPOOLED_URL_VAR} names ${host === '' ? 'no host' : 'no database'} (${host}/${database}) ` +
        `while DATABASE_URL is unset: spell both out in the URL — no ${MIGRATE_CONFIRM_VAR} value confirms a target ` +
        `the guard cannot name.`;
    } else if (!migrateConfirmed(env[MIGRATE_CONFIRM_VAR], host, database)) {
      refusal =
        `migrate: REFUSED — ${UNPOOLED_URL_VAR} points at ${host}/${database}, which is not localhost, while ` +
        `DATABASE_URL is unset: npm run setup would migrate it and seed the local default. Unset it if it is ` +
        `stale, or set ${MIGRATE_CONFIRM_VAR}=${host}/${database} to confirm you really mean to migrate it.`;
    }
  }
  return { url, source, host, database, refusal };
}

/**
 * The line seed.ts prints under `seed: database …` when DATABASE_URL_UNPOOLED
 * is set and names a database other than the one the seed is about to empty:
 * `npm run db:migrate` reads that variable first, the seed never does. Null
 * when it is unset, blank, or agrees (Neon's pooled / direct pair agrees).
 */
export function describeSeedUnpooledMismatch(
  unpooledUrl: string | undefined,
  seed: { host: string; database: string },
): string | null {
  const unpooled = setVar(unpooledUrl);
  if (!unpooled) return null;
  const target = urlTarget(unpooled);
  if (sameDatabase(target, seed)) return null;
  return (
    `seed: WARNING ${UNPOOLED_URL_VAR} is set and names ${target.host}/${target.database}, not this database — ` +
    `npm run db:migrate goes there while this seed empties ${seed.host}/${seed.database}. Unset it if it is stale.`
  );
}

/**
 * sha256 hex of the file text with CRLF folded to LF, so a checkout with
 * core.autocrlf (CRLF on Windows, LF on CI and Vercel) does not look edited.
 */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * The SQL with every `--` comment, block comment (nested, as Postgres nests
 * them), 'string' (E'' backslash escapes honoured, '' doubling otherwise),
 * "identifier" and $tag$ … $tag$ body blanked to spaces — newlines kept, so
 * an offset in the result is a line in the file. What is left is the code a
 * keyword search may read: the plpgsql BEGIN of a function body, a COMMIT
 * in a comment and a column named commit must never read as transaction
 * control. An unterminated quote blanks to the end (Postgres would refuse
 * the file anyway).
 */
export function blankCommentsAndStrings(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let code = 0; // where the current run of unblanked text starts
  const blank = (from: number, to: number) => {
    out.push(sql.slice(code, from), sql.slice(from, to).replace(/[^\r\n]/g, ' '));
    code = to;
  };
  let i = 0;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol < 0 ? n : eol;
      blank(i, end);
      i = end;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      const end = Math.min(j, n);
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      // E'…' takes backslash escapes; every other quote doubles itself instead.
      const escapes = c === "'" && /^[Ee]$/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? '');
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      const end = Math.min(j + 1, n);
      blank(i, end);
      i = end;
    } else if (c === '$') {
      // $$ or $tag$ (a tag starts with a letter or _, so $1 is not one).
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? n : close + tag[0].length;
        blank(i, end);
        i = end;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  out.push(sql.slice(code));
  return out.join('');
}

/**
 * Transaction control at a statement start — the file's first token, or the
 * first after a `;`, whitespace and blanked comments between. At a statement
 * start BEGIN, START TRANSACTION, COMMIT and ROLLBACK are only ever that: no
 * other statement begins with them, whatever follows (WORK, the modes, AND
 * [NO] CHAIN, PREPARED, TO [SAVEPOINT], a `;`, or nothing — a BEGIN that
 * forgot its `;` is still a BEGIN), so no lookahead is needed. A statement
 * start, never a line start: no `m` flag, so `^` is the start of the file,
 * and a column named commit on a line of its own in a column list, ON COMMIT
 * DROP, or a SQL-standard BEGIN ATOMIC function body (never at a statement
 * start) stay out of it. Runs on the output of blankCommentsAndStrings only.
 */
const TRANSACTION_CONTROL = /(?:^|;)\s*(BEGIN|START\s+TRANSACTION|COMMIT|ROLLBACK)\b/gi;

/** CREATE / DROP INDEX CONCURRENTLY, REINDEX … CONCURRENTLY, REFRESH MATERIALIZED VIEW CONCURRENTLY: none runs inside a transaction block. */
const CONCURRENTLY = /\bCONCURRENTLY\b/gi;

/** 1-based line of an offset. */
function lineOf(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Why a migration file cannot run as written — one reason per offending
 * statement in file order, each naming its line; empty when it can. The
 * runner wraps every file in a BEGIN … COMMIT of its own (so a failure
 * leaves no ledger row): a file that manages its own transaction would
 * commit half of itself, or leave the runner's COMMIT nothing to commit, and
 * CONCURRENTLY refuses to run inside any transaction block.
 */
export function migrationFileProblems(sql: string): string[] {
  const code = blankCommentsAndStrings(sql);
  const found: { at: number; reason: string }[] = [];
  for (const m of code.matchAll(TRANSACTION_CONTROL)) {
    const at = (m.index ?? 0) + m[0].length - m[1].length;
    const statement = m[1].replace(/\s+/g, ' ').toUpperCase();
    found.push({
      at,
      reason: `line ${lineOf(code, at)}: ${statement} — a migration must not manage its own transaction; the runner wraps each file in one`,
    });
  }
  for (const m of code.matchAll(CONCURRENTLY)) {
    const at = m.index ?? 0;
    found.push({
      at,
      reason: `line ${lineOf(code, at)}: CONCURRENTLY — cannot run inside a transaction, and the runner wraps each file in one`,
    });
  }
  return found.sort((a, b) => a.at - b.at).map((p) => p.reason);
}

/** One `_migrations` row: `checksum` is NULL for rows written before the column existed. */
export interface LedgerRow {
  filename: string;
  checksum: string | null;
}

export interface MigrationFile {
  filename: string;
  sql: string;
}

export interface MigrationPlan {
  /** Files not in the ledger, in filename order — the ones the run applies. */
  apply: MigrationFile[];
  /** Ledger rows to stamp with a checksum: NULL ones, plus the mismatched ones when accepted. */
  backfill: { filename: string; checksum: string }[];
  /** Applied files whose text no longer matches what the ledger recorded. */
  mismatched: { filename: string; ledger: string; file: string }[];
  /** Ledger rows with no file on disk — reported, never fatal. */
  missingFiles: string[];
  /**
   * Files in `apply` that cannot run as written — transaction control of
   * their own, or CONCURRENTLY (migrationFileProblems) — one entry per
   * offending statement, `reason` naming its line. The caller refuses the
   * whole run before it writes anything. Applied files are not re-checked.
   */
  invalid: { filename: string; reason: string }[];
}

function byFilename(a: { filename: string }, b: { filename: string }): number {
  return a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0;
}

/**
 * Decide what a run does. The caller refuses the whole run when
 * `mismatched.length > 0 && !allowMismatch`, and when `invalid.length > 0`;
 * with `allowMismatch` the changed files are ALSO listed in `backfill` with
 * their new checksum, so the ledger is rewritten to match the files on disk.
 */
export function planMigrations(
  files: MigrationFile[],
  ledger: LedgerRow[],
  allowMismatch: boolean,
): MigrationPlan {
  const sorted = [...files].sort(byFilename);
  const ledgerByFile = new Map(ledger.map((row) => [row.filename, row]));
  const plan: MigrationPlan = { apply: [], backfill: [], mismatched: [], missingFiles: [], invalid: [] };

  for (const file of sorted) {
    const row = ledgerByFile.get(file.filename);
    if (!row) {
      plan.apply.push(file);
      continue;
    }
    const current = checksumOf(file.sql);
    if (!row.checksum) {
      plan.backfill.push({ filename: file.filename, checksum: current });
      continue;
    }
    if (row.checksum !== current) {
      plan.mismatched.push({ filename: file.filename, ledger: row.checksum, file: current });
      if (allowMismatch) plan.backfill.push({ filename: file.filename, checksum: current });
    }
  }

  const onDisk = new Set(sorted.map((file) => file.filename));
  plan.missingFiles = ledger
    .map((row) => row.filename)
    .filter((filename) => !onDisk.has(filename))
    .sort();

  for (const file of plan.apply) {
    for (const reason of migrationFileProblems(file.sql)) plan.invalid.push({ filename: file.filename, reason });
  }

  return plan;
}

/** The message printed (to stderr) when applied files changed and the override is not set. */
export function describeRefusal(plan: MigrationPlan): string {
  const lines = [
    `migrate: REFUSED — ${plan.mismatched.length} applied migration file(s) changed since they ran:`,
  ];
  for (const m of plan.mismatched) {
    lines.push(`  ${m.filename}: ledger ${m.ledger.slice(0, 8)}… file ${m.file.slice(0, 8)}…`);
  }
  lines.push(`Restore the files, or set ${CHECKSUM_OVERRIDE_VAR}=1 to accept the new checksums.`);
  return lines.join('\n');
}

/**
 * The message printed (to stderr) when a file to apply cannot run inside the
 * runner's transaction: every offending statement with its file and line.
 * There is no override — the file is wrong, not the ledger.
 */
export function describeInvalid(plan: MigrationPlan): string {
  const files = new Set(plan.invalid.map((p) => p.filename)).size;
  const lines = [`migrate: REFUSED — ${files} migration file(s) to apply cannot run as written:`];
  for (const p of plan.invalid) lines.push(`  ${p.filename}: ${p.reason}`);
  lines.push('Fix the file(s) and run again; nothing was applied.');
  return lines.join('\n');
}

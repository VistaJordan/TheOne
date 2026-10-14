// Migration runner — passes each migrations/*.sql WHOLE to one query call in
// filename order. NO semicolon-splitting: a split runner dies on the
// dollar-quoted plpgsql body of set_updated_at() ("unterminated dollar-quoted
// string at or near \"$$\"") and migration 0001 fails before any table exists.
//
// The ledger (_migrations) is keyed by filename AND carries the sha256 of the
// file text as it ran (`checksum`, CRLF folded to LF — migrateLedger.ts).
// Each file and its ledger INSERT commit in ONE explicit transaction, so a
// file that fails half-way leaves no ledger row. The whole run holds a
// session-level advisory lock (pg_advisory_lock(MIGRATE_LOCK_KEY)) on the
// connection that runs the files, so two runners cannot interleave: the
// second waits at the lock (up to MIGRATE_LOCK_WAIT_MS, then refuses rather
// than hang), then reads the ledger the first left behind. The lock is taken
// before the ledger table is created, so two runners on an empty database
// cannot race that either.
//
// The connection must be DIRECT. A session lock means nothing through a
// transaction-mode pooler (Neon's `-pooler` host, PgBouncer): the lock lands
// on one server backend, the files run on another, the unlock misses, and the
// leaked lock makes the NEXT run wait. So the run prefers DATABASE_URL_UNPOOLED
// (Neon writes it beside DATABASE_URL) and REFUSES a pooled hostname before it
// opens any connection (migrationTarget in migrateLedger.ts). The seed reads
// only DATABASE_URL, so the two variables must name ONE database: a pair that
// differs is refused (`npm run setup` would migrate one and seed the other),
// and DATABASE_URL_UNPOOLED on its own, pointing off this machine, needs
// ALLOW_MIGRATE=<host>/<database> — a remote migrate is a deliberate act, as
// a remote seed is (ALLOW_SEED). Both set and agreeing, the Neon / Vercel
// layout, run without a confirmation.
//
// Refusal rule: an already-applied file whose checksum no longer matches the
// ledger stops the run (the list on stderr, exit 1) — the history on disk no
// longer matches what the database ran. MIGRATE_ALLOW_CHECKSUM_MISMATCH=1
// accepts the new checksums and rewrites them in the ledger, one printed line
// each. Ledger rows with a NULL checksum (written before the column existed)
// are backfilled from the current files, one printed line each. A ledger row
// with no file on disk is reported, never fatal. A file to apply that manages
// its own transaction (BEGIN / START TRANSACTION / COMMIT / ROLLBACK at a
// statement start — comments, strings and $$ bodies do not count) or runs
// CONCURRENTLY cannot run inside the transaction below: refused with its file
// and line (migrationFileProblems), no override — fix the file. A refused run
// — pooled host, a pair of URLs naming different databases, an unconfirmed
// remote DATABASE_URL_UNPOOLED, lock wait, checksum mismatch, a file that
// cannot run — writes NOTHING, the NULL-checksum backfills included: fix the
// cause and run again.
//
// Idempotent: re-running `npm run setup` against an existing database is a
// no-op (CREATE TYPE would otherwise error "already exists").
//
// A whole file still works as one call because client.query(sql) with no
// parameters uses the simple protocol, which takes many statements at once
// (client.ts explains); the parameterised ledger statements go through the
// extended protocol one statement at a time.

import { connectionString, getPool, closePool } from './client.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MIGRATE_LOCK_KEY,
  MIGRATE_LOCK_WAIT_MS,
  checksumMismatchAllowed,
  checksumOf,
  describeInvalid,
  describeLockWait,
  describeRefusal,
  isLockTimeout,
  migrationTarget,
  planMigrations,
  type LedgerRow,
} from './migrateLedger.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function main() {
  const allowMismatch = checksumMismatchAllowed(process.env.MIGRATE_ALLOW_CHECKSUM_MISMATCH);

  // Which database — decided before any pool exists. A pooled host, a pair of
  // URLs naming different databases and a lone remote DATABASE_URL_UNPOOLED
  // without ALLOW_MIGRATE are refused here; the chosen URL is what client.ts
  // reads when the pool is created.
  const target = migrationTarget(process.env, connectionString());
  if (target.refusal) {
    console.error(target.refusal);
    process.exitCode = 1;
    return;
  }
  process.env.DATABASE_URL = target.url;
  console.log(`migrate: ${target.host}/${target.database} (${target.source})`);

  // ONE connection for the whole run: the advisory lock is session-level, so
  // it must live on the same connection that runs the files.
  const client = await getPool().connect();
  let locked = false;
  try {
    // The lock comes first — before the ledger even exists — so two runners
    // starting on an empty database cannot both try to create it. Try it
    // first only to say WHY the run is waiting; the blocking call does the
    // work, bounded by lock_timeout (55P03 when it runs out) so a lock leaked
    // by a pooled session can never hang this run.
    const tried = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATE_LOCK_KEY]);
    if (tried.rows[0]?.ok) {
      locked = true;
    } else {
      console.log(
        `migrate: another migration run holds the lock — waiting up to ${MIGRATE_LOCK_WAIT_MS / 1000} s for it to finish …`,
      );
      await client.query(`SET lock_timeout = ${MIGRATE_LOCK_WAIT_MS}`);
      try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
        locked = true;
      } catch (err) {
        if (!isLockTimeout(err)) throw err;
        console.error(describeLockWait(MIGRATE_LOCK_WAIT_MS));
        process.exitCode = 1;
        return;
      }
      // The files themselves wait for their own locks as they always did.
      await client.query('RESET lock_timeout');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum   text
      )
    `);
    // Ledgers written before the checksum existed.
    await client.query('ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum text');

    const ledger = (await client.query<LedgerRow>('SELECT filename, checksum FROM _migrations')).rows;

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort() // filename order — 0001_, 0002_, …
      .map((filename) => ({ filename, sql: readFileSync(join(MIGRATIONS_DIR, filename), 'utf8') }));

    if (files.length === 0) {
      console.log('No migration files found in', MIGRATIONS_DIR);
      return;
    }

    const plan = planMigrations(files, ledger, allowMismatch);

    if (plan.mismatched.length > 0 && !allowMismatch) {
      console.error(describeRefusal(plan));
      process.exitCode = 1;
      return;
    }

    // A file to apply that manages its own transaction, or runs CONCURRENTLY,
    // cannot run inside the BEGIN … COMMIT below. Refused here, before the
    // backfills, so the refusal writes nothing.
    if (plan.invalid.length > 0) {
      console.error(describeInvalid(plan));
      process.exitCode = 1;
      return;
    }

    const accepted = new Map(plan.mismatched.map((m) => [m.filename, m]));
    for (const b of plan.backfill) {
      await client.query('UPDATE _migrations SET checksum = $2 WHERE filename = $1', [b.filename, b.checksum]);
      const m = accepted.get(b.filename);
      if (m) {
        console.log(
          `migrate: checksum ACCEPTED for ${b.filename} (ledger ${m.ledger.slice(0, 8)}… → file ${m.file.slice(0, 8)}…, MIGRATE_ALLOW_CHECKSUM_MISMATCH=1)`,
        );
      } else {
        console.log(`migrate: checksum recorded for ${b.filename}`);
      }
    }
    for (const m of plan.missingFiles) {
      console.log(`migrate: WARNING ${m} is in the ledger but not on disk`);
    }

    for (const f of plan.apply) {
      process.stdout.write(`migrate: applying ${f.filename} … `);
      await client.query('BEGIN');
      try {
        // WHOLE file, one call — never split on ';'.
        await client.query(f.sql);
        await client.query('INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)', [
          f.filename,
          checksumOf(f.sql),
        ]);
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          // Report but do not mask the failure that matters.
          console.error('migrate: ROLLBACK failed:', (rollbackErr as Error).message);
        }
        throw err;
      }
      console.log('ok');
    }

    console.log(
      `migrate: done (${plan.apply.length} newly applied, ${files.length} total, ${plan.backfill.length} checksum(s) recorded)`,
    );
  } finally {
    // Only what this run locked; the result is reported — on a direct
    // connection `false` cannot happen, and through a pooler it is the one
    // symptom of a leaked lock.
    if (locked) {
      try {
        const unlocked = await client.query<{ ok: boolean }>('SELECT pg_advisory_unlock($1) AS ok', [MIGRATE_LOCK_KEY]);
        if (!unlocked.rows[0]?.ok) {
          console.error(
            'migrate: WARNING pg_advisory_unlock returned false — this session did not hold the lock (a pooled connection?); it is released when the session that holds it ends.',
          );
        }
      } catch (unlockErr) {
        console.error('migrate: WARNING pg_advisory_unlock failed:', (unlockErr as Error).message);
      }
    }
    client.release();
  }
}

main()
  .finally(() => closePool())
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error('migrate: FAILED');
    console.error(err);
    process.exit(1);
  });

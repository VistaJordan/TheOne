// Postgres client — node-postgres over a real server (Phase 1).
//
// Replaces the S1–S5 embedded PGlite build. The whole reason for the swap is
// concurrency: PGlite is single-writer, so exactly one process could hold the
// datadir. That structurally blocked the worker, and the worker is what runs
// the Ecotrak poll, the obligation clocks and webhook delivery.
//
// TYPE PARITY (measured 2026-08-19, PGlite vs node-postgres, same SQL):
//   numeric      string  -> string    MATCH  (both return "12.34" — do NOT add
//                                            a float parser, it would DIVERGE)
//   timestamptz  Date    -> Date      MATCH
//   text[]       array   -> array     MATCH
//   int4         number  -> number    MATCH
//   bool / null  same              MATCH
//   int8         BigInt  -> string    DIFFERS — the only one.
//
// int8 reaches JS in exactly one place, messages.ts STATS_SQL (uncast count(*)),
// and that row is already typed `number | string` and read through Number(),
// which is correct for BigInt, string and number alike. So NO custom type
// parsers are registered here: pg's defaults already match PGlite everywhere
// that matters, and overriding them is what would introduce drift.

import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

const { Pool } = pg;

/** Matches pg's QueryResult on the members this codebase actually reads. */
export interface QueryResult<T> {
  rows: T[];
  rowCount: number | null;
}

/**
 * The minimum a caller needs, satisfied by both the pool and a transaction
 * handle — so a service function can take either without knowing which.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

const DEFAULT_URL = 'postgres://theone:theone@localhost:5432/theone';

export function connectionString(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

let _pool: pg.Pool | null = null;

/** The process-wide pool, created on first use. */
export function getPool(): pg.Pool {
  if (_pool === null) {
    _pool = new Pool({
      connectionString: connectionString(),
      // The API and the worker each hold their own pool; keep both modest so a
      // laptop-hosted Postgres is not the bottleneck.
      max: Number(process.env.PGPOOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // An idle client erroring (server restart, network drop) must not take the
    // process down — the pool discards it and the next query reconnects.
    _pool.on('error', (err) => {
      console.error('[db] idle client error:', err.message);
    });
  }
  return _pool;
}

/** Parameterized query on a pooled connection. `$1, $2, …` placeholders. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const ctx = currentAuditContext();
  // Viewing as: a statement that can reach activity_log runs in its own
  // transaction carrying the two ids (see AuditContext). Everything else —
  // and every request that is not viewing as — takes the plain pool path.
  if (ctx && ACTIVITY_LOG_RE.test(sql)) {
    return withTransaction((tx) => tx.query<T>(sql, params));
  }
  const res = await getPool().query(sql, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

// ── Viewing as: who really made the change ──────────────────────────────────
//
// While a super admin views the app as somebody else, the API acts as that
// person (their rights, their scope, their name on the records they create),
// but the audit log must still say who was at the keyboard. Sixty-odd
// statements write activity_log, so the fix is not in them: the API runs each
// such request inside `runWithAuditContext`, every transaction it opens sets
// two transaction-local settings, and the BEFORE INSERT trigger of migration
// 0088 (activity_log_viewing_as) rewrites a row signed by the viewed person to
// the real one, with `viewing_as_id` naming whom they were viewing as. Local
// settings end with their transaction, so a pooled connection never carries
// them into somebody else's request.

/** The two people behind a request made while viewing as someone. */
export interface AuditContext {
  /** The person signed in. */
  realActorId: string;
  /** The person they are viewing as. */
  viewingAsId: string;
}

const auditContext = new AsyncLocalStorage<AuditContext>();

/** Run `fn` (and everything it awaits) as a request made while viewing as. */
export function runWithAuditContext<T>(ctx: AuditContext, fn: () => T): T {
  return auditContext.run(ctx, fn);
}

/** The viewing-as context of the current request, or null. */
export function currentAuditContext(): AuditContext | null {
  return auditContext.getStore() ?? null;
}

/** A statement that names activity_log: only these need the settings outside
    a transaction (no trigger or function writes activity_log by itself). */
export const ACTIVITY_LOG_RE = /\bactivity_log\b/i;

/** The setting names migration 0088's trigger reads. Keep in step. */
export const AUDIT_SETTING_REAL_ACTOR = 'theone.real_actor_id';
export const AUDIT_SETTING_VIEWING_AS = 'theone.viewing_as_id';

async function applyAuditContext(client: pg.PoolClient): Promise<void> {
  const ctx = currentAuditContext();
  if (!ctx) return;
  await client.query(
    `SELECT set_config($1, $2, true), set_config($3, $4, true)`,
    [AUDIT_SETTING_REAL_ACTOR, ctx.realActorId, AUDIT_SETTING_VIEWING_AS, ctx.viewingAsId],
  );
}

/**
 * Run `fn` inside a transaction on a single checked-out connection.
 *
 * Replaces PGlite's `db.transaction(cb)`. Commits on resolve, rolls back on
 * throw, and always releases the client.
 *
 * Ordering: a read that needs no lock (the acting principal, a scope or
 * status pre-check) runs on the pool BEFORE the transaction opens, so the
 * transaction holds its connection for the writes alone; a write that depends
 * on a row it read must re-read that row under a lock inside `fn` (the task
 * bag: updateWorkOrderFields in apps/api/src/services/woFieldValues.ts).
 * Never await, from inside `fn`, a pool write to a row `fn` has locked: it
 * runs on another connection and waits on that lock while `fn` waits on it,
 * which is why the automations run after the commit.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyAuditContext(client);
    const tx: Queryable = {
      async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        const res = await client.query(sql, params as unknown[]);
        return { rows: res.rows as R[], rowCount: res.rowCount };
      },
    };
    const out = await fn(tx);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // Report but do not mask the original failure.
      console.error('[db] ROLLBACK failed:', (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Execute a multi-statement SQL string with no parameters — the replacement for
 * PGlite's `db.exec()`, used by the migration runner and the seed.
 *
 * pg's simple-query protocol accepts multiple statements in one call ONLY when
 * no parameters are supplied, which is exactly the migration case. Never split
 * on ';': migration 0001 contains a dollar-quoted plpgsql body and a splitting
 * runner dies on it.
 */
export async function exec(sql: string): Promise<void> {
  await getPool().query(sql);
}

/** Close the pool. Call from short-lived scripts (migrate, seed) so they exit. */
export async function closePool(): Promise<void> {
  if (_pool !== null) {
    const p = _pool;
    _pool = null;
    await p.end();
  }
}

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
  const res = await getPool().query(sql, params as unknown[]);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

/**
 * Run `fn` inside a transaction on a single checked-out connection.
 *
 * Replaces PGlite's `db.transaction(cb)`. Commits on resolve, rolls back on
 * throw, and always releases the client.
 *
 * Note for anyone reading the older comments in the services: under PGlite the
 * actor had to be resolved BEFORE opening a transaction, because a second
 * query would queue behind the open one on the single connection and
 * self-deadlock. That constraint is gone — the pool hands out a separate
 * connection. The existing ordering is harmless, so it is left alone rather
 * than restructured without test cover.
 */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
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

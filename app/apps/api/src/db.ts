// Re-export the DB runtime from @theone/db.
//
// Phase 1: the API no longer "holds" a datadir — it opens a pool against the
// Postgres server, and the worker opens its own alongside it. That concurrency
// is the entire point of the swap.
export { query, withTransaction, exec, getPool, closePool } from '@theone/db';
export type { Queryable, QueryResult } from '@theone/db';

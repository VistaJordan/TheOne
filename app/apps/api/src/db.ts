// Re-export the DB runtime from @theone/db (read-only consumer per spec §2/§8 Card B).
// The API is the long-running single-writer holder of pgdata.
export { query, getDb } from '@theone/db';

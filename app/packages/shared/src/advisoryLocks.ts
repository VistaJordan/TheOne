// Advisory lock registry — EVERY advisory lock key in the system is listed
// here, and no call site writes a key literal of its own.
//
// pg_advisory_lock / pg_advisory_xact_lock keys are global to the DATABASE,
// not to the code that takes them: Postgres has no namespace for them, so two
// callers that pick the same int4 for two different purposes serialise each
// other for no reason, a session-level hold under one meaning blocks a
// transaction-level take under another, and one caller's unlock can release
// the other's hold. This file is the namespace: one key per purpose, every
// value distinct, each saying who takes it, at which level, and why.
// tests/advisory-locks.test.ts pins the values, that they differ, and that
// every pg_advisory* call site in the tree reads its key from here.
//
// Who holds one: SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = <key>
// (the one-argument form takes a bigint; these fit an int4, so `objid` shows
// the whole key and `classid` is 0).

export const ADVISORY_LOCKS = {
  /**
   * The migration runner (packages/db/src/migrate.ts, MIGRATE_LOCK_KEY in
   * migrateLedger.ts): session-level, held on the direct connection for the
   * whole run so two runners cannot interleave, released in its finally.
   */
  migrate: 7262026,
  /**
   * The super-admin ring (apps/api/src/services/users.ts,
   * SUPER_ADMIN_RING_LOCK_KEY): transaction-level, taken before the "last
   * super admin" count so two demotions of the last two cannot both pass it.
   */
  superAdminRing: 7262027,
} as const;

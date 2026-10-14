-- 0082 · app_meta: one row per fact about this database that no record
-- carries — key → jsonb value, stamped when it last changed.
--
-- The first fact is the seed marker (W4-11). DEMO_MODE promises "seed data
-- only": the public demo signs anyone in without a password, so the promise
-- has to be something the code can check, not a deployment note. seed.ts
-- writes `seeded` → {at, demo: true} as its LAST step, and the DEMO_MODE
-- sign-in (services/auth.ts, devBypassSignIn) refuses with DEMO_NOT_SEEDED
-- until that row exists. A database that was never seeded — a real one the
-- demo was pointed at by mistake — has no row and admits nobody. Local
-- development (AUTH_DEV_BYPASS without DEMO_MODE) never reads it.
--
-- No foreign key to principal or task: the seed's TRUNCATE … CASCADE must
-- never reach this table, and it is not on the seed's TRUNCATE list — the
-- marker survives a re-seed and is simply rewritten.

CREATE TABLE IF NOT EXISTS app_meta (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

// PGlite client — embedded Postgres 16 (WASM), filesystem-persisted.
//
// CRITICAL: the data dir is resolved MODULE-RELATIVE and ABSOLUTE
// (fileURLToPath(new URL('../pgdata', import.meta.url))), never CWD-relative,
// so migrate / seed / api all open the SAME packages/db/pgdata regardless of
// which directory the process was launched from.
//
// PGlite is single-writer: exactly one process may hold the dir at a time.
// migrate/seed are short-lived (open → write → exit); the long-running holder
// is the API. Never run db:seed while the API is up.

import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import type { Results } from '@electric-sql/pglite';

const DATA_DIR = fileURLToPath(new URL('../pgdata', import.meta.url));

let _db: PGlite | null = null;

/** Returns the singleton PGlite instance, opening it (at the absolute pgdata) on first use. */
export function getDb(): PGlite {
  if (_db === null) {
    _db = new PGlite(DATA_DIR);
  }
  return _db;
}

/** Parameterized query helper. `$1, $2, …` placeholders. */
export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<Results<T>> {
  return getDb().query<T>(sql, params);
}

export { DATA_DIR };

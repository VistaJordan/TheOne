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
//
// OneDrive: a live datadir must NOT sit inside a OneDrive-synced folder.
// OneDrive stamps/locks the files minutes after they are written, after which
// PGlite can no longer open the dir (wasm "RuntimeError: unreachable" in
// _pg_initdb). If this package resolves to a path under OneDrive, the datadir
// is redirected to %LOCALAPPDATA%\the-one\pgdata instead. Override with
// THEONE_PGDATA.

import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import type { Results } from '@electric-sql/pglite';

function resolveDataDir(): string {
  if (process.env.THEONE_PGDATA) return process.env.THEONE_PGDATA;
  const moduleRelative = fileURLToPath(new URL('../pgdata', import.meta.url));
  const underOneDrive = moduleRelative
    .split(sep)
    .some((seg) => seg.toLowerCase().startsWith('onedrive'));
  if (underOneDrive && process.env.LOCALAPPDATA) {
    const redirected = join(process.env.LOCALAPPDATA, 'the-one', 'pgdata');
    console.error(`[db] repo is inside OneDrive — using datadir ${redirected}`);
    return redirected;
  }
  return moduleRelative;
}

const DATA_DIR = resolveDataDir();

let _db: PGlite | null = null;

/** Returns the singleton PGlite instance, opening it (at the absolute pgdata) on first use. */
export function getDb(): PGlite {
  if (_db === null) {
    _db = new PGlite(DATA_DIR);
  }
  return _db;
}

/* NOTE: T is deliberately UNCONSTRAINED. A `T extends Record<string, unknown>`
   bound rejects every `interface XRow {...}` in the services — interfaces have
   no implicit index signature, only `type` aliases do — which is what the 18
   TS2344 errors were when this package was first typechecked. PGlite's own
   query<T> is unconstrained too, and node-postgres bounds R by
   `{[column: string]: any}`, which interfaces DO satisfy. So this stays valid
   through the Phase 1 Postgres swap. */
/** Parameterized query helper. `$1, $2, …` placeholders. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<Results<T>> {
  return getDb().query<T>(sql, params);
}

export { DATA_DIR };

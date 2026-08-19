// Migration runner — passes each migrations/*.sql WHOLE to exec() in
// filename order. NO semicolon-splitting: a split runner dies on the
// dollar-quoted plpgsql body of set_updated_at() ("unterminated dollar-quoted
// string at or near \"$$\"") and migration 0001 fails before any table exists.
//
// Idempotent: a _migrations ledger records each applied filename so re-running
// `npm run setup` against an existing pgdata is a no-op (CREATE TYPE would
// otherwise error "already exists").

import { exec, query, closePool } from './client.js';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

async function main() {


  await exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM _migrations')).rows.map(
      (r) => r.filename,
    ),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filename order — 0001_, 0002_, …

  if (files.length === 0) {
    console.log('No migration files found in', MIGRATIONS_DIR);
    return;
  }

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`migrate: skip ${file} (already applied)`);
      continue;
    }
    const path = fileURLToPath(new URL(`../migrations/${file}`, import.meta.url));
    const sql = readFileSync(path, 'utf8');
    process.stdout.write(`migrate: applying ${file} … `);
    // WHOLE file, one call — never split on ';'.
    await exec(sql);
    await query('INSERT INTO _migrations (filename) VALUES ($1)', [file]);
    count++;
    console.log('ok');
  }

  console.log(`migrate: done (${count} newly applied, ${files.length} total)`);
}

main()
  .finally(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('migrate: FAILED');
    console.error(err);
    process.exit(1);
  });

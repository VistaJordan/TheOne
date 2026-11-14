#!/usr/bin/env node
// Migrate the PRODUCTION database without pasting its URL.
//
//   npm run db:migrate:prod            (from the repo root or app/)
//   npm run db:migrate:prod -- --check  only list what would be applied
//   npm run db:migrate:prod -- --yes    skip the confirmation
//
// 1. `vercel env pull` writes the Production variables of the linked project
//    (app/.vercel) to a temporary file; it is deleted when the script ends.
// 2. The direct (unpooled) Neon URL is picked: DATABASE_URL_UNPOOLED, else
//    POSTGRES_URL_NON_POOLING, else DATABASE_URL with '-pooler' taken out of
//    the host (migrate.ts refuses a pooled host: its advisory lock needs a
//    session).
// 3. The ledger is read to list the migrations not yet applied; nothing is
//    written until you answer y.
// 4. `npm run db:migrate` runs with DATABASE_URL and DATABASE_URL_UNPOOLED
//    both set to that URL — every guard in migrate.ts (checksums, the lock,
//    the file checks) applies as on any run.
//
// Needs the Vercel CLI signed in (`vercel login`) with access to the project.
// No URL or password is printed: only the host and database.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const assumeYes = args.has('--yes');
const isWin = process.platform === 'win32';

function fail(msg) {
  console.error(`migrate:prod — ${msg}`);
  process.exit(1);
}

/** KEY="value" lines as `vercel env pull` writes them. */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\n/g, '\n');
    }
    out[m[1]] = v;
  }
  return out;
}

function directUrl(env) {
  const raw = env.DATABASE_URL_UNPOOLED || env.POSTGRES_URL_NON_POOLING || env.DATABASE_URL;
  if (!raw) return null;
  const u = new URL(raw);
  u.hostname = u.hostname.replace('-pooler.', '.');
  return u;
}

if (!existsSync(join(appDir, '.vercel', 'project.json'))) {
  fail('app/ is not linked to a Vercel project — run `vercel link` in app/ first.');
}

const dir = mkdtempSync(join(tmpdir(), 'obi-prod-env-'));
const envFile = join(dir, '.env.production');
// The pulled file holds every production secret: removed however the script
// ends (process.exit skips a finally block).
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
try {
  console.log('Pulling the Production environment from Vercel…');
  const pull = spawnSync('vercel', ['env', 'pull', envFile, '--environment=production', '--yes'], {
    cwd: appDir,
    stdio: ['ignore', 'ignore', 'inherit'],
    shell: isWin,
  });
  if (pull.status !== 0 || !existsSync(envFile)) fail('`vercel env pull` failed (signed in? `vercel login`).');

  const url = directUrl(parseEnvFile(readFileSync(envFile, 'utf8')));
  if (!url) fail('the Production environment has no DATABASE_URL.');
  const host = url.hostname;
  const database = url.pathname.replace(/^\//, '');
  if (['localhost', '127.0.0.1', '::1'].includes(host)) fail(`Production's DATABASE_URL points at ${host} — refusing.`);

  // What is not applied yet (read only).
  const require = createRequire(join(appDir, 'packages', 'db', 'package.json'));
  const pg = require('pg');
  const client = new pg.Client({ connectionString: url.toString(), ssl: url.searchParams.has('sslmode') ? undefined : { rejectUnauthorized: true } });
  await client.connect();
  let applied = new Set();
  try {
    const r = await client.query(`SELECT filename FROM _migrations`);
    applied = new Set(r.rows.map((x) => x.filename));
  } catch (e) {
    if (e.code !== '42P01') throw e; // no ledger yet = nothing applied
  } finally {
    await client.end();
  }
  const files = readdirSync(join(appDir, 'packages', 'db', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  const pending = files.filter((f) => !applied.has(f));

  console.log(`\nTarget: ${host}/${database}  (Vercel Production)`);
  if (pending.length === 0) {
    console.log('Nothing to apply — the production database is up to date.');
    process.exit(0);
  }
  console.log(`Not applied yet (${pending.length}):`);
  for (const f of pending) console.log(`  ${f}`);
  if (checkOnly) process.exit(0);

  if (!assumeYes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`\nApply ${pending.length === 1 ? 'it' : 'them'} to PRODUCTION? (y/N) `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log('Stopped — nothing was written.');
      process.exit(0);
    }
  }

  const run = spawnSync('npm', ['run', 'db:migrate'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, DATABASE_URL: url.toString(), DATABASE_URL_UNPOOLED: url.toString() },
  });
  process.exitCode = run.status ?? 1;
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

/* W4-11 / W6-4 — the two config guards (fix batch G2).
 *
 * W4-11: DEMO_MODE promises "seed data only, every real integration off". The
 * boot now refuses when any real credential sits beside it, naming the
 * variable, so a public demo can never be pointed at Ecotrak, ClickUp, Quo,
 * Claude, the Blob store or a mailbox by accident. `demoModeConflict` is pure
 * — it reads the snapshot it is handed, never process.env — so this test
 * needs no environment of its own.
 *
 * W6-4: CI was red for 24 pushes because config.ts loaded the developer's
 * app/.env at import and CI has none. Under vitest the environment is
 * tests/setup.ts and the .env load is skipped; the second block pins the guard
 * in the source so it cannot quietly disappear.
 *
 * The last block drives the DEMO_MODE seed-marker check — `assertDemoSeeded`,
 * which the sign-in calls — against a scripted database: the marker row, no
 * row, no table (migration 0082 not run → not seeded) and, since skeptic loop
 * 2, an outage, which must surface as the database's own error and never as
 * a 403 that reads like an operator who forgot to seed.
 *
 * F2 (follow-up batch, FIX-RUNBOOK §10): DEMO_MODE_SECRET_VARS gains
 * SALES_TAX_API_KEY, the RapidAPI key services/salesTax.ts presents, and
 * CRON_SECRET stays out on purpose — it authenticates Vercel's cron TO US,
 * not us to anything outside The One. The drift block keeps the list honest
 * from now on: it reads config.ts as text, collects every variable read by
 * literal name — str('X'), bool('X'), num('X'), process.env.X,
 * process.env['X'] — and fails when one ending in _SECRET, _KEY, _TOKEN,
 * _JSON, _PASSWORD or _PRIVATE_KEY is in neither DEMO_MODE_SECRET_VARS nor
 * the PUBLIC_OR_INTERNAL allowlist (one reason per entry). lib/gmail.ts,
 * whose GMAIL_* reads config.ts goes through, is scanned the same way, and
 * so is every file under apps/api/src — three of the credentials are read
 * outside config.ts, and the walk reads the bare env.X form too, so a
 * credential read through a function handed process.env (gmail's pattern)
 * cannot slip past it — plus the reverse: a name in the list that nothing
 * reads is a typo guarding nothing, and an allowlist entry nothing reads is
 * stale. CRON_SECRET's exception is pinned to the code: read once in
 * config.ts, consumed only as the value routes/webhooks.ts compares a
 * caller's header against, and inert in the demo (every cron route answers
 * 403 before it looks at the secret).
 *
 * Skeptic loop 2 (F2): two blind spots made visible and one tripwire made
 * honest. The text scan cannot see a read by computed name, so the set of
 * dynamic process.env[...] reads in the tree is pinned file by file — a new
 * one fails the suite and sends its author to pin the names it reaches by
 * hand; a credential folded into a URL (DATABASE_URL's user:pass@host) has
 * no suffix to catch, so that limit is a test of its own, naming the
 * seed-marker sign-in guard as what covers it; and the CRON_SECRET check
 * reads routes/webhooks.ts for its meaning — the secret is only ever the
 * expected value of checkWebhookSecret, after the demo 403 — rather than
 * pinning a line, so a rename or a reflow passes and only a real change
 * trips it, with a message that says to fix the tripwire, not the lists.
 *
 * Fails on the tree before the fix: the exports do not exist, config.ts
 * loads app/.env unguarded, and no setup file sets the variables; before F2,
 * SALES_TAX_API_KEY is read by services/salesTax.ts and is in no list.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEMO_MODE_SECRET_VARS, demoModeConflict } from '../apps/api/src/config';

// The sign-in block below drives services/auth.ts against a scripted `query`:
// no pool is ever created (getPool throws), so the test cannot touch a database.
vi.mock('../apps/api/src/db', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  exec: vi.fn(),
  getPool: () => {
    throw new Error('no database in tests');
  },
  closePool: vi.fn(),
}));

/** The contract's list, in its order — the first one set is the one named. */
const EXPECTED_VARS = [
  'ENTRA_CLIENT_SECRET',
  'ECOTRAK_CLIENT_SECRET',
  'CLICKUP_API_TOKEN',
  'QUO_API_KEY',
  'ANTHROPIC_API_KEY',
  'BLOB_READ_WRITE_TOKEN',
  'GMAIL_SERVICE_ACCOUNT_JSON',
  'GMAIL_PRIVATE_KEY',
  'RESEND_API_KEY',
  'MAIL_GRAPH_CLIENT_SECRET',
  'SHAREPOINT_CLIENT_SECRET',
  'ESCALATION_WEBHOOK_SECRET',
  'QUO_WEBHOOK_SECRET',
  'SALES_TAX_API_KEY',
];

describe('W4-11 · DEMO_MODE refuses to boot beside a real credential', () => {
  it('lists the fourteen credentials, in the contract order', () => {
    expect([...DEMO_MODE_SECRET_VARS]).toEqual(EXPECTED_VARS);
  });

  it('is silent when DEMO_MODE is off, whatever else is set', () => {
    const env: Record<string, string | undefined> = {};
    for (const name of DEMO_MODE_SECRET_VARS) env[name] = 'x';
    expect(demoModeConflict(env)).toBeNull();
    expect(demoModeConflict({ ...env, DEMO_MODE: 'false' })).toBeNull();
    expect(demoModeConflict({ ...env, DEMO_MODE: '' })).toBeNull();
    expect(demoModeConflict({ ...env, DEMO_MODE: '1' })).toBeNull();
  });

  it('is silent when DEMO_MODE is on and no credential is set', () => {
    expect(demoModeConflict({ DEMO_MODE: 'true' })).toBeNull();
    // Case and whitespace follow bool(): ' TRUE ' is on. Non-credential
    // variables (the bypass, the database, a public id) never count.
    expect(
      demoModeConflict({
        DEMO_MODE: ' TRUE ',
        AUTH_DEV_BYPASS: 'true',
        DATABASE_URL: 'postgres://localhost:5432/theone',
        ENTRA_CLIENT_ID: '00000000-0000-0000-0000-000000000000',
        ECOTRAK_CLIENT_ID: 'public-id',
        QUO_FROM_NUMBER: '+14695011510',
        MAIL_FROM: 'contact@seamlessfm.com',
      }),
    ).toBeNull();
  });

  it.each(EXPECTED_VARS)('names %s when it is the one set', (name) => {
    expect(demoModeConflict({ DEMO_MODE: 'true', [name]: 'secret' })).toBe(name);
  });

  it('cannot see a credential folded into a URL: DATABASE_URL user:pass@host trips nothing (the seed-marker sign-in guard covers a demo on the wrong database)', () => {
    // No suffix marks it, so this guard cannot tell a demo database from a
    // real one. What can: a real database was never seeded, so it has no
    // app_meta.seeded row and the DEMO_MODE sign-in (last block) refuses it.
    const real = 'postgres://theone:s3cret@ep-real-123.us-east-2.aws.neon.tech/neondb';
    expect(demoModeConflict({ DEMO_MODE: 'true', DATABASE_URL: real })).toBeNull();
    expect(demoModeConflict({ DEMO_MODE: 'true', DATABASE_URL_UNPOOLED: real })).toBeNull();
  });

  it('ignores a whitespace-only value, as str() does', () => {
    expect(demoModeConflict({ DEMO_MODE: 'true', CLICKUP_API_TOKEN: '   ' })).toBeNull();
    expect(demoModeConflict({ DEMO_MODE: 'true', QUO_API_KEY: '\t\n' })).toBeNull();
    expect(demoModeConflict({ DEMO_MODE: 'true', ANTHROPIC_API_KEY: '' })).toBeNull();
  });

  it('names the first set credential in list order when several are set', () => {
    expect(demoModeConflict({ DEMO_MODE: 'true', QUO_WEBHOOK_SECRET: 'a', ANTHROPIC_API_KEY: 'b' })).toBe(
      'ANTHROPIC_API_KEY',
    );
    const all: Record<string, string> = { DEMO_MODE: 'true' };
    for (const name of DEMO_MODE_SECRET_VARS) all[name] = 'x';
    expect(demoModeConflict(all)).toBe('ENTRA_CLIENT_SECRET');
  });
});

describe('W4-11 · DEMO_MODE_SECRET_VARS keeps up with what the API reads (drift, F2)', () => {
  const API_SRC = fileURLToPath(new URL('../apps/api/src/', import.meta.url));
  const source = (file: string) => readFileSync(join(API_SRC, file), 'utf8');
  const CONTRACT: readonly string[] = DEMO_MODE_SECRET_VARS;

  /** A name that looks like a credential. _PRIVATE_KEY is already caught by
      _KEY; it is spelled out so the rule reads as the audit wrote it. */
  const CREDENTIAL_SUFFIX = /_(?:SECRET|KEY|TOKEN|JSON|PASSWORD|PRIVATE_KEY)$/;

  /** Credential-looking names the API reads that are NOT a key to anything
      outside The One — one line of reason each. Disjoint from the contract:
      a name belongs in exactly one of the two lists. An entry may be read
      anywhere under apps/api/src, not only in config.ts (three contract
      names are read in services already): the hygiene test asks only that
      something in the tree still reads it, or the entry is stale. */
  const PUBLIC_OR_INTERNAL: Record<string, string> = {
    CRON_SECRET:
      "authenticates Vercel's cron TO US (Authorization: Bearer on our own /api/webhooks/* routes), " +
      'not us to an external system; holding it pulls no real data into the demo — where every cron ' +
      'route answers 403 before it looks at the secret — unlike the two webhook secrets, which let ' +
      'Quo and the email tool deliver real events here',
  };

  /** Every environment variable `src` reads by literal name: str('X'),
      bool('X'), num('X'), process.env.X, process.env['X'] / ["X"] and, with
      bareEnv, the env.X / env['X'] forms of a function handed process.env as
      a parameter (lib/gmail.ts). A dynamic read — process.env[key] — names
      nothing and is not collected; the one such credential,
      ECOTRAK_CLIENT_SECRET, is pinned by hand below, and the set of such
      reads is pinned file by file (dynamicEnvReads) so a new one fails
      loudly instead of slipping past; a credential folded into a *_URL
      value (user:pass@host) has no credential suffix to catch either — that
      limit is a test of its own in the first block. Comments are not
      stripped: a process.env.X_KEY in prose counts,
      loudly, rather than risk a stripper eating a real read. */
  function envNamesRead(src: string, opts: { bareEnv?: boolean } = {}): string[] {
    const NAME = '([A-Z][A-Z0-9_]*)';
    const env = opts.bareEnv ? '(?:process\\.)?env' : 'process\\.env';
    const patterns = [
      new RegExp(`\\b(?:str|bool|num)\\(\\s*['"]${NAME}['"]\\s*\\)`, 'g'),
      new RegExp(`\\b${env}\\??\\.${NAME}\\b`, 'g'),
      new RegExp(`\\b${env}\\??\\.?\\[\\s*['"]${NAME}['"]\\s*\\]`, 'g'),
    ];
    const names = new Set<string>();
    for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
    return [...names].sort();
  }

  /** Every .ts file under `dir`, recursively, sorted (absolute paths). */
  function tsFiles(dir = API_SRC): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(path));
      else if (/\.[cm]?ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
    }
    return out.sort();
  }
  const rel = (path: string) => relative(API_SRC, path).replace(/\\/g, '/');
  const covered = new Set<string>([...CONTRACT, ...Object.keys(PUBLIC_OR_INTERNAL)]);

  /** Every name read by literal name anywhere under apps/api/src → the files
      that read it (relative, in path order). The bare env.X form is included,
      so a read through a function handed process.env — lib/gmail.ts's
      pattern — cannot escape the walk; the only other bare read in the tree
      today is demoModeConflict's own env.DEMO_MODE. Walked once, shared by
      the tree-wide tests below. */
  let treeReadsCache: Map<string, string[]> | undefined;
  function treeReads(): Map<string, string[]> {
    if (!treeReadsCache) {
      const seen = new Map<string, string[]>();
      for (const f of tsFiles()) {
        for (const n of envNamesRead(readFileSync(f, 'utf8'), { bareEnv: true })) {
          seen.set(n, [...(seen.get(n) ?? []), rel(f)]);
        }
      }
      treeReadsCache = seen;
    }
    return treeReadsCache;
  }

  /** Every read of process.env (or of a bare env parameter) by a COMPUTED
      name — process.env[key], process.env[`${ref}_${k}`] — as the expression
      text, in source order. These are exactly the reads envNamesRead cannot
      see, so the tree test below pins the set file by file. */
  function dynamicEnvReads(src: string): string[] {
    const re = /(?:(?<![\w$])process\.env|(?<![\w$.])env)\??\.?\[\s*(?!['"])[^\]]*\]/g;
    return [...src.matchAll(re)].map((m) => m[0].replace(/\s+/g, ''));
  }

  /** routes/webhooks.ts's handling of config.cronSecret, read for its
      MEANING rather than as a pinned line (skeptic loop 2): every use is the
      expected value of checkWebhookSecret(<what the caller presented>, …)
      and sits in a handler that threw the demo 403 first. A rename, a
      reflow or a reworded message passes; presenting the secret outward,
      comparing it by hand or dropping the guard is reported. [] = safe. */
  function cronSecretProblems(src: string): string[] {
    const problems: string[] = [];
    const uses = [...src.matchAll(/config\.cronSecret\b/g)];
    if (uses.length === 0) problems.push('config.cronSecret is not used at all');
    for (const use of uses) {
      const at = use.index ?? 0;
      // The statement around the use, from the previous ';' or '{' to the
      // next ';', with its whitespace and a closing brace before it folded.
      const from = Math.max(src.lastIndexOf(';', at), src.lastIndexOf('{', at)) + 1;
      const to = src.indexOf(';', at);
      const stmt = src
        .slice(from, to < 0 ? undefined : to)
        .replace(/\s+/g, ' ')
        .replace(/^[}\s]+/, '')
        .replace(/\s*([(),.=])\s*/g, '$1');
      if (!/^(?:const|let) \w+=checkWebhookSecret\(presentedSecret\(\w+\.headers\),config\.cronSecret,?\)$/.test(stmt)) {
        problems.push(`not the expected value of checkWebhookSecret: "${stmt}"`);
      }
      const handlers = [...src.slice(0, at).matchAll(/async\s*\(\s*\w+/g)];
      const handler = handlers.length ? (handlers[handlers.length - 1].index ?? -1) : -1;
      if (handler < 0) {
        problems.push('used outside a request handler');
      } else if (!/if\s*\(\s*config\.demoMode\s*\)\s*\{?\s*throw new ApiError\(\s*'FORBIDDEN'/.test(src.slice(handler, at))) {
        problems.push('a handler looks at the secret before answering the demo 403');
      }
    }
    return problems;
  }

  it('the extractor sees every read form, so a regex regression cannot make the drift test vacuous', () => {
    const fixture = [
      "const a = str('A_SECRET') ?? null;",
      'const b = bool("B_KEY");',
      "const c = num( 'C_TOKEN' );",
      'if (process.env.D_JSON) {}',
      "process.env['E_PASSWORD']",
      'process.env["F_PRIVATE_KEY"]?.trim()',
      'process.env?.G_SECRET',
      'const h = env.H_KEY?.trim();',
      "const i = env?.['I_TOKEN'];",
      'process.env[key]', // dynamic: names nothing
      '// prose: J_SECRET is mentioned, not read',
      "const k = ['K_SECRET'];", // a list entry is not a read either
    ].join('\n');
    expect(envNamesRead(fixture)).toEqual([
      'A_SECRET',
      'B_KEY',
      'C_TOKEN',
      'D_JSON',
      'E_PASSWORD',
      'F_PRIVATE_KEY',
      'G_SECRET',
    ]);
    expect(envNamesRead(fixture, { bareEnv: true })).toEqual([
      'A_SECRET',
      'B_KEY',
      'C_TOKEN',
      'D_JSON',
      'E_PASSWORD',
      'F_PRIVATE_KEY',
      'G_SECRET',
      'H_KEY',
      'I_TOKEN',
    ]);
  });

  it('the dynamic-read detector sees a computed name in every form and never a literal one', () => {
    const fixture = [
      'const v = process.env[key];',
      'const w = process.env[`${ref}_${k}`];',
      'const x = process.env[ `ECOTRAK_${k}` ]?.trim();',
      'const y = process.env?.[name];',
      'const z = env[name];',
      "const a = process.env['A_SECRET'];", // literal: envNamesRead's job
      'const b = process.env.B_KEY;',
      'const c = fieldEnv[idx];', // some other array, not the environment
    ].join('\n');
    expect(dynamicEnvReads(fixture)).toEqual([
      'process.env[key]',
      'process.env[`${ref}_${k}`]',
      'process.env[`ECOTRAK_${k}`]',
      'process.env?.[name]',
      'env[name]',
    ]);
  });

  it('the cron tripwire reads meaning, not formatting: a rename or a reflow passes, a real change trips it', () => {
    const GUARD = "  if (config.demoMode) throw new ApiError('FORBIDDEN', 'Webhooks are disabled in the public demo.');\n";
    const handler = (body: string) => `const run = async (req: { headers: Record<string, unknown> }) => {\n${body}\n};`;
    const asShipped = handler(GUARD + '  const outcome = checkWebhookSecret(presentedSecret(req.headers), config.cronSecret);');
    expect(cronSecretProblems(asShipped)).toEqual([]);
    // Renamed, reflowed, reworded — the same meaning.
    const reflowed =
      'const run = async (\n  request: { headers: Record<string, unknown> },\n) => {\n' +
      '  if (config.demoMode) {\n' +
      "    throw new ApiError('FORBIDDEN', 'No webhooks in the demo.');\n" +
      '  }\n' +
      '  const verdict = checkWebhookSecret(\n    presentedSecret(request.headers),\n    config.cronSecret,\n  );\n};';
    expect(cronSecretProblems(reflowed)).toEqual([]);
    // Presented to something outside The One: one problem, the statement.
    const presented = handler(GUARD + '  await fetch(url, { headers: { Authorization: `Bearer ${config.cronSecret}` } });');
    expect(cronSecretProblems(presented)).toEqual([expect.stringContaining('not the expected value of checkWebhookSecret')]);
    // Compared by hand, not through the constant-time helper.
    const byHand = handler(GUARD + "  if (req.headers.authorization !== `Bearer ${config.cronSecret}`) throw new Error('no');");
    expect(cronSecretProblems(byHand)).toEqual([expect.stringContaining('not the expected value of checkWebhookSecret')]);
    // The demo guard dropped: one problem, the handler.
    const unguarded = handler('  const outcome = checkWebhookSecret(presentedSecret(req.headers), config.cronSecret);');
    expect(cronSecretProblems(unguarded)).toEqual(['a handler looks at the secret before answering the demo 403']);
    // The route gone is a change too.
    expect(cronSecretProblems('')).toEqual(['config.cronSecret is not used at all']);
  });

  it('names a credential by its suffix only', () => {
    for (const n of ['X_SECRET', 'X_KEY', 'X_TOKEN', 'X_JSON', 'X_PASSWORD', 'X_PRIVATE_KEY', 'CRON_SECRET', 'SALES_TAX_API_KEY']) {
      expect(CREDENTIAL_SUFFIX.test(n), n).toBe(true);
    }
    for (const n of ['SALES_TAX_API_HOST', 'GMAIL_SERVICE_ACCOUNT_EMAIL', 'ENTRA_CLIENT_ID', 'QUO_API_BASE', 'QUO_FROM_NUMBER', 'SECRET_THING', 'API_KEYS', 'NODE_ENV']) {
      expect(CREDENTIAL_SUFFIX.test(n), n).toBe(false);
    }
  });

  it('every credential-looking name config.ts reads is in DEMO_MODE_SECRET_VARS or allowlisted with a reason', () => {
    const names = envNamesRead(source('config.ts'));
    // The extractor really read the file: one name of each form it uses.
    expect(names).toEqual(
      expect.arrayContaining(['NODE_ENV', 'AUTH_DEV_BYPASS', 'DEMO_MODE', 'VITEST', 'ENTRA_CLIENT_SECRET', 'CRON_SECRET', 'ANTHROPIC_API_KEY']),
    );
    const forgotten = names.filter((n) => CREDENTIAL_SUFFIX.test(n) && !covered.has(n));
    expect(
      forgotten,
      `config.ts reads ${forgotten.join(', ')}: add each to DEMO_MODE_SECRET_VARS, or to PUBLIC_OR_INTERNAL here with its reason`,
    ).toEqual([]);
  });

  it('the allowlist holds only credential-looking names the API still reads, each with a reason, none in the contract', () => {
    for (const [name, reason] of Object.entries(PUBLIC_OR_INTERNAL)) {
      expect(CREDENTIAL_SUFFIX.test(name), `${name} does not look like a credential — it needs no exception`).toBe(true);
      // Anywhere in the tree, as the scan accepts the allowlist for any file:
      // an exception is not forced into config.ts to be allowed to exist.
      expect(treeReads().has(name), `${name} is allowlisted but nothing under apps/api/src reads it any more — drop the entry`).toBe(true);
      expect(CONTRACT, `${name} is in both lists`).not.toContain(name);
      expect(reason.trim().length, `${name} needs its reason`).toBeGreaterThan(20);
    }
  });

  it("CRON_SECRET stays out of the contract on purpose: it authenticates Vercel's cron to us, not us to anything", () => {
    expect(CONTRACT).not.toContain('CRON_SECRET');
    expect(PUBLIC_OR_INTERNAL.CRON_SECRET).toMatch(/Vercel's cron TO US/);
    // Read once, in config.ts ...
    expect(treeReads().get('CRON_SECRET')).toEqual(['config.ts']);
    expect(source('config.ts')).toMatch(/cronSecret:\s*str\('CRON_SECRET'\)/);
    // ... and consumed by one file, only ever as the value a caller's header is
    // compared against — nothing under apps/api/src presents it to anyone.
    const consumers = tsFiles().filter((f) => readFileSync(f, 'utf8').includes('cronSecret')).map(rel);
    expect(consumers).toEqual(['config.ts', 'routes/webhooks.ts']);
    const routes = source('routes/webhooks.ts');
    expect(routes.match(/config\.cronSecret\b/g)?.length).toBeGreaterThanOrEqual(4); // planned-maintenance, client-updates, clickup, ecotrak
    // Read for meaning, not as a pinned line (see cronSecretProblems and its
    // fixture test): a rename or a reflow of routes/webhooks.ts passes here.
    expect(
      cronSecretProblems(routes),
      'routes/webhooks.ts changed what it does with config.cronSecret. Re-read the CRON_SECRET reason in ' +
        "PUBLIC_OR_INTERNAL: if the secret is still only compared against a caller's header behind the demo " +
        '403, teach cronSecretProblems the new shape; if it is now presented to anything outside The One, ' +
        'move it into DEMO_MODE_SECRET_VARS instead. Never fix this by dropping the allowlist entry.',
    ).toEqual([]);
    // Which is why it must not trip the boot.
    expect(demoModeConflict({ DEMO_MODE: 'true', CRON_SECRET: 'x' })).toBeNull();
  });

  it('SALES_TAX_API_KEY — the RapidAPI key services/salesTax.ts presents — is in the contract (runbook §10)', () => {
    const src = source('services/salesTax.ts');
    expect(envNamesRead(src)).toEqual(expect.arrayContaining(['SALES_TAX_API_KEY', 'SALES_TAX_API_HOST']));
    expect(src).toContain("'x-rapidapi-key': key");
    expect(CONTRACT).toContain('SALES_TAX_API_KEY');
    expect(demoModeConflict({ DEMO_MODE: 'true', SALES_TAX_API_KEY: 'rapid' })).toBe('SALES_TAX_API_KEY');
    // The host is the API's address, not a credential: it never trips the demo.
    expect(demoModeConflict({ DEMO_MODE: 'true', SALES_TAX_API_HOST: 'x.p.rapidapi.com' })).toBeNull();
  });

  it("lib/gmail.ts's GMAIL_* credentials, which config.ts reads through gmailCredentialsFromEnv(), are in the contract", () => {
    expect(source('config.ts')).toMatch(/const gmail = gmailCredentialsFromEnv\(\);/);
    const names = envNamesRead(source('lib/gmail.ts'), { bareEnv: true }).filter((n) => n.startsWith('GMAIL_'));
    expect(names).toEqual(expect.arrayContaining(['GMAIL_SERVICE_ACCOUNT_JSON', 'GMAIL_SERVICE_ACCOUNT_EMAIL', 'GMAIL_PRIVATE_KEY']));
    const credentials = names.filter((n) => CREDENTIAL_SUFFIX.test(n));
    expect(credentials).toEqual(expect.arrayContaining(['GMAIL_SERVICE_ACCOUNT_JSON', 'GMAIL_PRIVATE_KEY']));
    const forgotten = credentials.filter((n) => !CONTRACT.includes(n));
    expect(forgotten, `lib/gmail.ts reads ${forgotten.join(', ')}: add each to DEMO_MODE_SECRET_VARS`).toEqual([]);
    // The service account's EMAIL is an address, not a secret.
    expect(CONTRACT).not.toContain('GMAIL_SERVICE_ACCOUNT_EMAIL');
  });

  it('the same rule over every file under apps/api/src — three of the credentials are read outside config.ts', () => {
    expect(tsFiles().length).toBeGreaterThan(100);
    const seen = [...treeReads()].filter(([n]) => CREDENTIAL_SUFFIX.test(n)); // name → the files that read it
    const forgotten = seen.filter(([n]) => !covered.has(n)).map(([n, where]) => `${n} (${where.join(', ')})`);
    expect(forgotten, `read but in neither list: ${forgotten.join('; ')}`).toEqual([]);
    // The walk really covered the tree: the reads the audit knew of outside
    // config.ts, and — bare env.X — the two lib/gmail.ts reads config.ts goes
    // through, which a walk without bareEnv would miss.
    const where = new Map(seen);
    expect(where.get('SALES_TAX_API_KEY')).toEqual(expect.arrayContaining(['services/salesTax.ts']));
    expect(where.get('CLICKUP_API_TOKEN')).toEqual(expect.arrayContaining(['lib/clickupApi.ts']));
    expect(where.get('BLOB_READ_WRITE_TOKEN')).toEqual(expect.arrayContaining(['services/attachments.ts']));
    expect(where.get('GMAIL_PRIVATE_KEY')).toEqual(['lib/gmail.ts']);
    expect(where.get('GMAIL_SERVICE_ACCOUNT_JSON')).toEqual(['lib/gmail.ts']);
  });

  it('every read by computed name is a known one — the scan is blind to them, so a new one must be pinned by hand', () => {
    const found: Record<string, string[]> = {};
    for (const f of tsFiles()) {
      const reads = dynamicEnvReads(readFileSync(f, 'utf8'));
      if (reads.length) found[rel(f)] = reads;
    }
    expect(
      found,
      'a new process.env[<computed>] read: envNamesRead cannot see which names it reaches. Pin every ' +
        'credential it can reach by hand (as ECOTRAK_CLIENT_SECRET is below), or read it by literal name, ' +
        'then add the file here',
    ).toEqual({
      'config.ts': ['process.env[key]', 'env[name]'], // str() itself; demoModeConflict over its snapshot
      'modules/integrations/ecotrak/client.ts': ['process.env[`${ref}_${k}`]'], // the ECOTRAK_* credentials, through get()
      'services/ecotrakAdmin.ts': ['process.env[`ECOTRAK_${k}`]'], // presence only (credentials_set)
      'services/integrations.ts': ['process.env[`ECOTRAK_${k}`]'], // presence only (the "configured" note)
    });
  });

  it('ECOTRAK_CLIENT_SECRET is read by template (`${ref}_${k}`), which no text scan can see — pinned by hand', () => {
    const src = source('modules/integrations/ecotrak/client.ts');
    expect(src).toContain('process.env[`${ref}_${k}`]');
    expect(src).toContain("clientSecret: get('CLIENT_SECRET')");
    expect(CONTRACT).toContain('ECOTRAK_CLIENT_SECRET');
  });

  it('every name in the contract is one the API reads: a typo in the list would guard nothing', () => {
    const readAnywhere = new Set<string>(['ECOTRAK_CLIENT_SECRET', ...treeReads().keys()]); // + the template read, pinned above
    const unread = CONTRACT.filter((n) => !readAnywhere.has(n));
    expect(unread, `in DEMO_MODE_SECRET_VARS but read nowhere under apps/api/src: ${unread.join(', ')}`).toEqual([]);
  });
});

describe('W6-4 · the suite never reads app/.env', () => {
  it('runs under vitest, which marks its workers', () => {
    expect(process.env.VITEST).toBe('true');
  });

  it('config.ts skips loadEnvFile under VITEST', () => {
    const src = readFileSync(new URL('../apps/api/src/config.ts', import.meta.url), 'utf8');
    // The one call, inside the guard (\s* also eats the CRLF the file is saved with).
    expect(src).toMatch(/if \(!process\.env\.VITEST\)\s*\{\s*try\s*\{\s*process\.loadEnvFile\(/);
    expect(src.match(/process\.loadEnvFile\(/g)).toHaveLength(1);
  });

  it('tests/setup.ts puts the suite in bypass mode on a database it never opens', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(process.env.AUTH_DEV_BYPASS).toBe('true');
    expect(process.env.WEB_ORIGIN).toBe('http://127.0.0.1:5173');
    expect(process.env.DATABASE_URL).toBe('postgres://localhost:5432/theone_test');
    expect(process.env.DEMO_MODE).toBeUndefined();
    expect(process.env.ENTRA_CLIENT_SECRET).toBeUndefined();
  });
});

describe('W4-11 · the DEMO_MODE sign-in needs the seed marker (app_meta.seeded)', () => {
  const PRINCIPAL = {
    id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Demo User',
    email: 'demo@example.com',
    role: 'om',
    role_label: 'OM',
    kind: 'human',
    is_super_admin: false,
    status: 'active',
    role_permissions: {},
    permission_overrides: {},
    site_restricted: false,
    client_names: [],
  };
  type Answer = (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
  type Marker = 'row' | 'none' | 'no-table' | 'outage' | 'other-pg-error' | 'plain-error';

  /** What the database would say to the marker query — the row, no row, no
      table at all (migration 0082 not run), or a failure that is not about the
      table — then the two queries a sign-in makes. */
  const database =
    (marker: Marker): Answer =>
    async (sql) => {
      if (sql.includes('app_meta')) {
        if (marker === 'no-table') {
          throw Object.assign(new Error('relation "app_meta" does not exist'), { code: '42P01' });
        }
        if (marker === 'outage') {
          throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
        }
        if (marker === 'other-pg-error') {
          throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
        }
        if (marker === 'plain-error') throw new Error('timeout exceeded when trying to connect');
        const rows = marker === 'row' ? [{ value: { at: '2026-10-14T00:00:00.000Z', demo: true } }] : [];
        return { rows, rowCount: rows.length };
      }
      if (sql.includes('UPDATE principal')) return { rows: [{ id: PRINCIPAL.id }], rowCount: 1 };
      if (sql.includes('FROM principal p')) return { rows: [PRINCIPAL], rowCount: 1 };
      throw new Error(`unexpected SQL in test: ${sql}`);
    };

  /** A fresh config + auth module graph for this DEMO_MODE, over the scripted db. */
  async function load(demoMode: boolean, answer: Answer) {
    vi.resetModules();
    if (demoMode) process.env.DEMO_MODE = 'true';
    else delete process.env.DEMO_MODE;
    const db = await import('../apps/api/src/db');
    if (!vi.isMockFunction(db.query)) throw new Error('db is not mocked — refusing to touch a database');
    const q = vi.mocked(db.query);
    q.mockReset();
    q.mockImplementation(((sql: string) => answer(sql)) as never);
    const { assertDemoSeeded, devBypassSignIn } = await import('../apps/api/src/services/auth');
    return { assertDemoSeeded, devBypassSignIn, q };
  }

  type Thrown = Error & { code?: string; details?: unknown; statusCode?: number };
  /** The rejection of `p` — a resolution is the failure. */
  const thrown = (p: Promise<unknown>): Promise<Thrown> =>
    p.then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Thrown,
    );

  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    // A developer's shell may export one of the credentials; DEMO_MODE would
    // then refuse to boot (the other guard) before this one is reached.
    for (const name of [...DEMO_MODE_SECRET_VARS, 'DEMO_MODE']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
  });
  afterEach(() => {
    for (const [name, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[name];
      else process.env[name] = v;
    }
    vi.resetModules();
  });

  it('refuses with 403 DEMO_NOT_SEEDED while the marker row is missing, before any write', async () => {
    const { devBypassSignIn, q } = await load(true, database('none'));
    const err = await thrown(devBypassSignIn(PRINCIPAL.id));
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('FORBIDDEN');
    expect(err.statusCode).toBe(403);
    expect(err.details).toEqual({ code: 'DEMO_NOT_SEEDED' });
    expect(err.message).toBe('This demo database has not been seeded — sign-in is refused.');
    expect(q.mock.calls.some(([sql]) => String(sql).includes('UPDATE principal'))).toBe(false);
  });

  it('counts a missing app_meta table (migration 0082 not run, 42P01) as not seeded', async () => {
    const { devBypassSignIn, q } = await load(true, database('no-table'));
    const err = await thrown(devBypassSignIn(PRINCIPAL.id));
    expect(err.details).toEqual({ code: 'DEMO_NOT_SEEDED' });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['outage', 'ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:5432'],
    ['other-pg-error', '57P01', 'terminating connection due to administrator command'],
    ['plain-error', undefined, 'timeout exceeded when trying to connect'],
  ] as const)(
    'rethrows a %s as itself — a database outage is a 500 in the logs, not DEMO_NOT_SEEDED',
    async (kind, code, message) => {
      const { devBypassSignIn, q } = await load(true, database(kind));
      const err = await thrown(devBypassSignIn(PRINCIPAL.id));
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.message).toBe(message);
      expect(err.statusCode).toBeUndefined();
      expect(err.details).toBeUndefined();
      expect(q.mock.calls.some(([sql]) => String(sql).includes('UPDATE principal'))).toBe(false);
    },
  );

  it('signs in once the seed has written the marker', async () => {
    const { devBypassSignIn, q } = await load(true, database('row'));
    const principal = await devBypassSignIn(PRINCIPAL.id);
    expect(principal.id).toBe(PRINCIPAL.id);
    expect(String(q.mock.calls[0][0])).toContain("FROM app_meta WHERE key = 'seeded'");
    expect(q).toHaveBeenCalledTimes(3);
  });

  it('never asks for the marker outside DEMO_MODE — local AUTH_DEV_BYPASS is unaffected', async () => {
    const { devBypassSignIn, q } = await load(false, database('no-table'));
    const principal = await devBypassSignIn(PRINCIPAL.id);
    expect(principal.id).toBe(PRINCIPAL.id);
    expect(q.mock.calls.some(([sql]) => String(sql).includes('app_meta'))).toBe(false);
  });

  it('exports the check on its own, so the account picker (GET /auth/dev-candidates) can ask it too', async () => {
    const missing = await load(true, database('none'));
    const err = await thrown(missing.assertDemoSeeded());
    expect(err.statusCode).toBe(403);
    expect(err.details).toEqual({ code: 'DEMO_NOT_SEEDED' });

    const seeded = await load(true, database('row'));
    await expect(seeded.assertDemoSeeded()).resolves.toBeUndefined();
    expect(seeded.q).toHaveBeenCalledTimes(1);

    const local = await load(false, database('outage'));
    await expect(local.assertDemoSeeded()).resolves.toBeUndefined();
    expect(local.q).not.toHaveBeenCalled();
  });

  it('GET /auth/dev-candidates calls assertDemoSeeded before listing accounts (skeptic S2-2)', () => {
    const src = readFileSync(new URL('../apps/api/src/routes/auth.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/import \{[^}]*\bassertDemoSeeded\b[^}]*\} from '\.\.\/services\/auth\.js'/);
    const start = src.indexOf("app.get('/auth/dev-candidates'");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\n  app.', start + 1);
    const block = src.slice(start, end > start ? end : undefined);
    const seededAt = block.indexOf('await assertDemoSeeded();');
    const listAt = block.indexOf('listSignInCandidates()');
    expect(seededAt).toBeGreaterThan(-1);
    expect(listAt).toBeGreaterThan(seededAt);
  });
});

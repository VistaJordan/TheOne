/* Commit completeness: remediation of the architect's blocking item
 * "Tracked files import untracked new files: stage them together or the
 * build breaks" (2026-10-14).
 *
 * The audit batch wired new files into tracked ones and left them
 * untracked: packages/shared/src/index.ts re-exports ./advisoryLocks,
 * migrate.ts and seed.ts import ./migrateLedger.js and ./seedGuard.js,
 * vitest.config.mts names tests/setup.ts, and services/auth.ts and seed.ts
 * read migration 0082's app_meta table. Committed without them, every
 * importer of @theone/shared (API boot, web build, db scripts) and the suite
 * itself break, and the new test files (the only enforcement of the
 * source-text pins) never leave this machine.
 *
 * This file asks git which files it knows (`git ls-files`: the index, so a
 * staged new file counts) and fails while a file the commit needs is still
 * untracked:
 *   1. imported: reachable by import from a file git knows (relative
 *      specifiers, `./x.js` meaning x.ts as tsc and Vite read it, `?raw` and
 *      `#hash` dropped; the @theone/* workspace entries; CSS @import),
 *      followed on through every untracked file it finds;
 *   2. vitest setup: a setupFiles / globalSetup entry in vitest.config.mts;
 *   3. migration: a .sql in packages/db/migrations (migrate.ts applies the
 *      folder, so an untracked one is schema production never gets);
 *   4. test: a file vitest collects (the config's include), because a guard
 *      that exists on one machine enforces nothing after the push;
 *   5. build configuration read by name: package.json and tsconfig*.json at
 *      the app root or a workspace root, vite / vitest config, vercel.json.
 * Ignored files are never required (api/_bundle.cjs and .env are generated
 * or local by design), and nothing else untracked is: notes, PDFs, the
 * .agents skills, skills-lock.json. The failure prints the `git add` that
 * fixes it; nothing here writes to git. Without a git work tree (an exported
 * tarball) the checks on this checkout skip and the pure ones still run.
 * The checkout checks are OPT-IN (COMMIT_CHECK=1) so a developer's suite does
 * not go red on a file they have not added yet; run them before committing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'tests/commit-completeness.test.ts';

interface Tree {
  /** Paths git knows (the index), relative to app/, with forward slashes. */
  known: string[];
  /** Paths on disk that git neither knows nor ignores. */
  untracked: string[];
  /** A file's text, or null when it cannot be read. */
  read: (path: string) => string | null;
}

interface Missing {
  path: string;
  why: string;
}

const SOURCE = /\.(?:[cm]?[jt]sx?|css)$/;

/** Every module specifier a file names. Comments count too: a stale mention
 *  resolves to nothing on disk and is dropped. */
const SPECIFIERS = [
  /\bfrom\s*['"]([^'"\n]+)['"]/g, // import … from, export … from
  /\bimport\s*['"]([^'"\n]+)['"]/g, // import './side-effect.css'
  /\b(?:import|require|vi\.(?:mock|doMock|importActual|importMock))\s*\(\s*['"]([^'"\n]+)['"]/g,
  /\/\/\/\s*<reference\s+path\s*=\s*['"]([^'"\n]+)['"]/g,
  /\bnew\s+URL\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
  /@import\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g, // CSS
];
const specifiersOf = (source: string): string[] =>
  SPECIFIERS.flatMap((re) => [...source.matchAll(re)].map((m) => m[1]));

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css'];
// tsc (bundler / nodenext resolution) and Vite both read `./x.js` as x.ts.
const SOURCE_FOR: Record<string, string[]> = { '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };

/** resolve(from, specifier): the app-relative file a specifier names, or null
 *  for an npm package, node:*, a folder, or anything git neither knows nor
 *  sees untracked (ignored, or not on disk). Case-insensitive, as Windows is. */
function makeResolver(tree: Tree): (from: string, specifier: string) => string | null {
  const onDisk = new Map<string, string>();
  for (const path of [...tree.untracked, ...tree.known]) onDisk.set(path.toLowerCase(), path);
  const find = (base: string): string | null => {
    const ext = posix.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    const candidates = [
      base,
      ...(SOURCE_FOR[ext] ?? []).map((e) => stem + e),
      ...EXTENSIONS.map((e) => base + e),
      ...EXTENSIONS.map((e) => `${base}/index${e}`),
    ];
    for (const candidate of candidates) {
      const hit = onDisk.get(candidate.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };
  // A workspace import (@theone/shared) means its package's exports['.'] or main.
  const workspaces = new Map<string, { dir: string; entry?: string }>();
  for (const path of onDisk.values()) {
    const m = /^((?:apps|packages)\/[^/]+)\/package\.json$/.exec(path);
    if (!m) continue;
    try {
      const pkg = JSON.parse(tree.read(path) ?? 'null');
      const dot = pkg?.exports && typeof pkg.exports === 'object' ? pkg.exports['.'] : pkg?.exports;
      const entry = typeof dot === 'string' ? dot : typeof pkg?.main === 'string' ? pkg.main : undefined;
      if (typeof pkg?.name === 'string') workspaces.set(pkg.name, { dir: m[1], entry });
    } catch {
      // An unreadable manifest is npm's error to report, not this guard's.
    }
  }
  return (from, specifier) => {
    const spec = specifier.split(/[?#]/)[0];
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../')) {
      const base = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\/+$/, '');
      return base.startsWith('../') ? null : find(base); // outside app/: not this tree
    }
    const m = /^(@[^/]+\/[^/]+|[^@./][^/]*)(?:\/(.+))?$/.exec(spec);
    const workspace = m ? workspaces.get(m[1]) : undefined;
    const target = m?.[2] ?? workspace?.entry;
    return workspace && target ? find(posix.normalize(posix.join(workspace.dir, target))) : null;
  };
}

/** A vitest config list (`include: [...]`, `setupFiles: '...'`), read as text. */
function configList(config: string, key: string): string[] {
  const m = new RegExp(`\\b${key}\\s*:\\s*(\\[[^\\]]*\\]|'[^']*'|"[^"]*")`).exec(config);
  return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
}

/** A glob as vitest reads include (`**`, `*`, `?`, `{a,b}`), over app-relative paths. */
function globToRegExp(glob: string): RegExp {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const g = glob.replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    const close = c === '{' ? g.indexOf('}', i) : -1;
    if (c === '*' && g[i + 1] === '*') {
      const dirs = g[i + 2] === '/';
      re += dirs ? '(?:.*/)?' : '.*';
      i += dirs ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (close > i) {
      re += `(?:${g.slice(i + 1, close).split(',').map(escape).join('|')})`;
      i = close;
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`);
}

const MIGRATION = /^packages\/db\/migrations\/[^/]+\.sql$/;
const BUILD_CONFIG =
  /^(?:(?:apps|packages)\/[^/]+\/)?(?:package\.json|tsconfig[^/]*\.json|vite(?:st)?\.config\.[cm]?[jt]s|vercel\.json)$/;

/** Every untracked file the commit needs, each with the first reason found. */
function unshipped(tree: Tree): Missing[] {
  const resolve = makeResolver(tree);
  const untracked = new Set(tree.untracked);
  const missing = new Map<string, string>();
  const queue = tree.known.filter((path) => SOURCE.test(path));
  const need = (path: string, why: string) => {
    if (!untracked.has(path) || missing.has(path)) return;
    missing.set(path, why);
    if (SOURCE.test(path)) queue.push(path);
  };
  const config = tree.read('vitest.config.mts') ?? '';
  for (const key of ['setupFiles', 'globalSetup']) {
    for (const entry of configList(config, key)) {
      const hit = resolve('vitest.config.mts', entry.startsWith('.') ? entry : `./${entry}`);
      if (hit) need(hit, `named by vitest.config.mts (${key})`);
    }
  }
  const include = configList(config, 'include').map(globToRegExp);
  for (const path of tree.untracked) {
    if (MIGRATION.test(path)) need(path, 'a migration: migrate.ts applies every .sql in packages/db/migrations');
    else if (include.some((re) => re.test(path))) need(path, 'a test vitest collects (vitest.config.mts include)');
    else if (BUILD_CONFIG.test(path)) need(path, 'build configuration read by name (npm, tsc, Vite, vitest, Vercel)');
  }
  for (let i = 0; i < queue.length; i++) {
    const source = tree.read(queue[i]);
    if (source === null) continue;
    for (const specifier of specifiersOf(source)) {
      const hit = resolve(queue[i], specifier);
      if (hit) need(hit, `imported by ${queue[i]}`);
    }
  }
  return [...missing].map(([path, why]) => ({ path, why })).sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** This checkout as git sees it from app/, or null without git or a work tree. */
function gitTree(): (Tree & { prefix: string }) | null {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });
  const list = (...args: string[]) => git('ls-files', '-z', ...args).split('\0').filter(Boolean);
  const cache = new Map<string, string | null>();
  try {
    if (git('rev-parse', '--is-inside-work-tree').trim() !== 'true') return null;
    return {
      prefix: git('rev-parse', '--show-prefix').trim(),
      known: list(),
      untracked: list('--others', '--exclude-standard'),
      read: (path) => {
        if (!cache.has(path)) {
          let text: string | null = null;
          try {
            text = readFileSync(join(APP, path), 'utf8');
          } catch {
            // In the index but deleted on disk: nothing to scan.
          }
          cache.set(path, text);
        }
        return cache.get(path) ?? null;
      },
    };
  } catch {
    return null;
  }
}

describe('the guard (pure: a made-up tree, no git)', () => {
  const FILES: Record<string, string> = {
    'package.json': '{"name":"the-one","workspaces":["packages/*","apps/*"]}',
    'vitest.config.mts': "export default { test: { include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] } };\n",
    'packages/shared/package.json': '{"name":"@theone/shared","exports":{".":"./src/index.ts"}}',
    'packages/shared/src/index.ts': "export * from './status';\nexport * from './locks';\n",
    'packages/shared/src/status.ts': 'export const s = 1;\n',
    'packages/shared/src/locks.ts': "import { key } from './lockKeys.js';\nexport const locks = { key };\n",
    'packages/shared/src/lockKeys.ts': 'export const key = 7;\n',
    'packages/db/src/migrate.ts': "import { locks } from '@theone/shared';\nconst dir = new URL('../migrations', import.meta.url);\n",
    'packages/db/migrations/0001_init.sql': 'CREATE TABLE a ();\n',
    'packages/db/migrations/0002_meta.sql': 'CREATE TABLE app_meta ();\n',
    'apps/web/src/main.tsx': "import './styles/app.css';\nconst Page = lazy(() => import('./Page'));\n",
    'apps/web/src/styles/app.css': "@import './tokens.css';\n",
    'apps/web/src/styles/tokens.css': ':root {}\n',
    'apps/web/src/Page.tsx': 'export default function Page() {}\n',
    'apps/worker/tsconfig.json': '{}',
    // ./_bundle.cjs is in neither list: git ignores it (a build artifact).
    'api/index.js': "const { buildApp } = require('./_bundle.cjs');\n",
    'tests/setup.ts': "process.env.NODE_ENV = 'test';\n",
    'tests/old.test.ts': "import { s } from '../packages/shared/src/status';\n",
    'tests/new.test.ts': "import { locks } from '../packages/shared/src/locks';\n",
    'tests/fixtures/notes.md': '',
    'scratch.ts': "// copied from './lockKeys', which is not a file next to this one\n",
    'notes.pdf': '',
  };
  const tree = (untracked: string[]): Tree => ({
    known: Object.keys(FILES).filter((path) => !untracked.includes(path)),
    untracked,
    read: (path) => FILES[path] ?? null,
  });
  const reasons = (untracked: string[]) =>
    Object.fromEntries(unshipped(tree(untracked)).map((m) => [m.path, m.why]));

  it('passes when git knows every file', () => {
    expect(unshipped(tree([]))).toEqual([]);
  });

  it('flags an untracked module a tracked file imports, and what that module imports in turn (`.js` read as .ts)', () => {
    expect(reasons(['packages/shared/src/locks.ts', 'packages/shared/src/lockKeys.ts', 'scratch.ts', 'notes.pdf'])).toEqual({
      'packages/shared/src/locks.ts': 'imported by packages/shared/src/index.ts',
      'packages/shared/src/lockKeys.ts': 'imported by packages/shared/src/locks.ts',
    });
  });

  it('follows a workspace import to the package entry, a dynamic import and a CSS @import', () => {
    expect(reasons(['packages/shared/src/index.ts', 'apps/web/src/Page.tsx', 'apps/web/src/styles/tokens.css'])).toEqual({
      'packages/shared/src/index.ts': 'imported by packages/db/src/migrate.ts',
      'apps/web/src/Page.tsx': 'imported by apps/web/src/main.tsx',
      'apps/web/src/styles/tokens.css': 'imported by apps/web/src/styles/app.css',
    });
  });

  it('requires the vitest setup file, every migration and every collected test, though nothing imports them', () => {
    expect(reasons(['tests/setup.ts', 'packages/db/migrations/0002_meta.sql', 'tests/new.test.ts', 'tests/fixtures/notes.md'])).toEqual({
      'tests/setup.ts': 'named by vitest.config.mts (setupFiles)',
      'packages/db/migrations/0002_meta.sql': 'a migration: migrate.ts applies every .sql in packages/db/migrations',
      'tests/new.test.ts': 'a test vitest collects (vitest.config.mts include)',
    });
  });

  it('requires build configuration read by name', () => {
    expect(reasons(['apps/worker/tsconfig.json'])).toEqual({
      'apps/worker/tsconfig.json': 'build configuration read by name (npm, tsc, Vite, vitest, Vercel)',
    });
  });

  it('never requires an ignored file, a folder, or an untracked file nothing needs', () => {
    expect(unshipped(tree(['scratch.ts', 'notes.pdf', 'tests/fixtures/notes.md']))).toEqual([]);
  });

  it('reads include globs as vitest does', () => {
    const re = globToRegExp('tests/**/*.test.ts');
    expect(['tests/a.test.ts', 'tests/deep/b.test.ts'].every((p) => re.test(p))).toBe(true);
    expect(['tests/setup.ts', 'tests/a.test.tsx', 'apps/tests/a.test.ts'].some((p) => re.test(p))).toBe(false);
    expect(globToRegExp('./src/**/*.{test,spec}.ts').test('src/x/y.spec.ts')).toBe(true);
  });
});

const TREE = gitTree();

// Opt-in on a developer machine (COMMIT_CHECK=1): a new file is untracked
// until it is added, and a suite that goes red on every unstaged module would
// punish ordinary work. Run it before committing: COMMIT_CHECK=1 npx vitest run tests/commit-completeness.test.ts
describe.skipIf(!TREE || !process.env.COMMIT_CHECK)('this checkout, as git sees it (opt-in: COMMIT_CHECK=1)', () => {
  const tree = TREE as Tree & { prefix: string };

  it('the resolver reads this tree: the edges the blocking item named resolve, and nearly every relative import does', () => {
    const resolve = makeResolver(tree);
    expect(resolve('packages/shared/src/index.ts', './advisoryLocks')).toBe('packages/shared/src/advisoryLocks.ts');
    expect(resolve('packages/db/src/migrate.ts', './migrateLedger.js')).toBe('packages/db/src/migrateLedger.ts');
    expect(resolve('packages/db/src/seed.ts', './seedGuard.js')).toBe('packages/db/src/seedGuard.ts');
    expect(resolve('apps/api/src/services/users.ts', '@theone/shared')).toBe('packages/shared/src/index.ts');
    const relative = tree.known
      .filter((path) => SOURCE.test(path))
      .flatMap((from) =>
        specifiersOf(tree.read(from) ?? '')
          .filter((s) => s.startsWith('.'))
          .map((s) => resolve(from, s)),
      );
    // The few that resolve to nothing are ignored files or folders (./_bundle.cjs, .env, ../migrations).
    expect(relative.length).toBeGreaterThan(1000);
    expect(relative.filter(Boolean).length / relative.length).toBeGreaterThan(0.99);
  });

  it('with the files the audit batch added taken back out of the index, it names each one and why', () => {
    const added = [
      'packages/shared/src/advisoryLocks.ts',
      'packages/db/src/migrateLedger.ts',
      'packages/db/src/seedGuard.ts',
      'packages/db/migrations/0082_app_meta.sql',
      'tests/setup.ts',
      SELF,
    ];
    const before: Tree = {
      ...tree,
      known: tree.known.filter((path) => !added.includes(path)),
      untracked: [...new Set([...tree.untracked, ...added])],
    };
    const why = Object.fromEntries(unshipped(before).map((m) => [m.path, m.why]));
    expect(why['packages/shared/src/advisoryLocks.ts']).toMatch(/^imported by /);
    expect(why['packages/db/src/migrateLedger.ts']).toMatch(/^imported by /);
    expect(why['packages/db/src/seedGuard.ts']).toMatch(/^imported by /);
    expect(why['packages/db/migrations/0082_app_meta.sql']).toMatch(/^a migration/);
    expect(why['tests/setup.ts']).toBe('named by vitest.config.mts (setupFiles)');
    expect(why[SELF]).toMatch(/^a test vitest collects/);
  });

  it('every file the commit needs is one git knows (git add it with the change that needs it)', () => {
    const missing = unshipped(tree);
    const lines = missing.map((m) => `  ${tree.prefix}${m.path}: ${m.why}`).join('\n');
    const add = missing.map((m) => JSON.stringify(tree.prefix + m.path)).join(' ');
    expect(
      missing,
      missing.length
        ? `\nGit does not know these files, and the commit needs them:\n${lines}\nFrom the repo root:\n  git add -- ${add}\n`
        : '',
    ).toEqual([]);
  });
});

/* The advisory-lock registry (follow-up F4-migrate-and-locks).
 *
 * pg_advisory_lock keys are global to the database, so two purposes that
 * pick the same int4 serialise each other and one's unlock can release the
 * other's hold. packages/shared/src/advisoryLocks.ts is the one place a key
 * is written: this file pins the values, that they differ, that the migrate
 * runner reads its key from there and — by text — that the super-admin ring
 * in services/users.ts reads it from there too (integrated 2026-10-14, once
 * that file was free: a literal of its own now fails). The sweep at the end fails
 * when a pg_advisory* call appears anywhere else in the tree, so a lock
 * cannot be added without registering its key. Fails on the tree before the
 * change: the module does not exist.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADVISORY_LOCKS } from '@theone/shared';
import { MIGRATE_LOCK_KEY } from '../packages/db/src/migrateLedger';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8');

describe('ADVISORY_LOCKS', () => {
  it('every key is a fixed int4, and no two purposes share one', () => {
    const entries = Object.entries(ADVISORY_LOCKS);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    for (const [name, key] of entries) {
      expect(Number.isInteger(key), name).toBe(true);
      expect(Math.abs(key), name).toBeLessThan(2 ** 31);
    }
    expect(new Set(entries.map(([, key]) => key)).size).toBe(entries.length);
  });

  it('names the two locks the system takes today', () => {
    expect(ADVISORY_LOCKS).toEqual({ migrate: 7262026, superAdminRing: 7262027 });
  });

  it('is exported from the package root, so every workspace reads one copy', () => {
    expect(read('packages/shared/src/index.ts')).toMatch(/^export \* from '\.\/advisoryLocks';/m);
  });
});

describe('the call sites read the registry', () => {
  it('the migrate runner: MIGRATE_LOCK_KEY is ADVISORY_LOCKS.migrate, by value and by source', () => {
    expect(MIGRATE_LOCK_KEY).toBe(ADVISORY_LOCKS.migrate);
    const ledger = read('packages/db/src/migrateLedger.ts');
    expect(ledger).toMatch(/import \{[^}]*\bADVISORY_LOCKS\b[^}]*\} from '@theone\/shared'/);
    expect(ledger).toMatch(/export const MIGRATE_LOCK_KEY = ADVISORY_LOCKS\.migrate;/);
    expect(ledger).not.toMatch(/MIGRATE_LOCK_KEY = \d/);
  });

  it('the super-admin ring (services/users.ts, pinned by text): SUPER_ADMIN_RING_LOCK_KEY is ADVISORY_LOCKS.superAdminRing', () => {
    const users = read('apps/api/src/services/users.ts');
    // The registry's key, never a literal of its own (the registry's header contract).
    expect(users).toMatch(/import \{[^}]*\bADVISORY_LOCKS\b[^}]*\} from '@theone\/shared'/);
    expect(users).toMatch(/const SUPER_ADMIN_RING_LOCK_KEY = ADVISORY_LOCKS\.superAdminRing;/);
    expect(users).not.toMatch(/SUPER_ADMIN_RING_LOCK_KEY = \d/);
    expect(ADVISORY_LOCKS.superAdminRing).toBe(7262027);
    expect(users).toMatch(/pg_advisory_xact_lock\(\$1::bigint\)`, \[SUPER_ADMIN_RING_LOCK_KEY\]/);
  });
});

describe('no advisory lock outside the registry', () => {
  const CALL = /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?\s*\(/;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : walk(path);
      return /\.(?:ts|tsx|mts|js|mjs|sql)$/.test(entry.name) ? [path] : [];
    });

  it('every pg_advisory* call in the tree is one of the registered sites (add a key to ADVISORY_LOCKS and a line here for a new one)', () => {
    const roots = ['apps/api/src', 'apps/worker/src', 'packages/db/src', 'packages/db/migrations', 'packages/shared/src'];
    const sites = roots
      .flatMap((root) => walk(join(APP, root)))
      .filter((path) => CALL.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(APP.length).split(sep).join('/'))
      .sort();
    expect(sites).toEqual(['apps/api/src/services/users.ts', 'packages/db/src/migrate.ts']);
  });
});

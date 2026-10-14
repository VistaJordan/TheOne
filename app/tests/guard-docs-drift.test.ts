/* CLAUDE.md (the map every agent and reviewer works from) and FIX-RUNBOOK.md
 * (the operator half of the 2026-10-14 batch) quote three facts the code
 * decides, and the batch first went up for review with two of them stale:
 * how many credentials DEMO_MODE refuses to boot beside, the lock strength
 * every task.fields write takes, and the advisory lock keys. Each is read
 * here off the code and compared with every place the two documents state
 * it, so the next change to one fails the suite until the documents follow.
 * Hermetic: files read as text, no database, no network. FIX-RUNBOOK.md is a
 * batch document and may be retired; its share of each check goes with it. */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_MODE_SECRET_VARS } from '../apps/api/src/config';
import { ADVISORY_LOCKS } from '../packages/shared/src/advisoryLocks';

const APP = resolve(__dirname, '..');
const REPO = resolve(APP, '..');
const text = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** The documents that state these facts, as text. CLAUDE.md must exist. */
const DOCS = ['CLAUDE.md', 'FIX-RUNBOOK.md']
  .filter((name) => name === 'CLAUDE.md' || existsSync(resolve(REPO, name)))
  .map((name) => ({ name, body: text(resolve(REPO, name)) }));

/** Every first capture of `re` in every document, as "<document>: <capture>". */
function stated(re: RegExp): string[] {
  return DOCS.flatMap((d) => [...d.body.matchAll(re)].map((m) => `${d.name}: ${m[1]}`));
}

describe('DEMO_MODE: the credential count the documents state is the length of DEMO_MODE_SECRET_VARS', () => {
  it('every "N credentials" (a line break may fall inside it) says that length', () => {
    const counts = stated(/\b(\d+)\s+(?:real\s+)?credentials\b/g);
    expect(counts.length, 'neither document states the count any more: re-point this test').toBeGreaterThan(0);
    expect(counts).toEqual(counts.map((c) => c.replace(/\d+$/, String(DEMO_MODE_SECRET_VARS.length))));
  });
});

describe('the bag lock: the strength the documents name is the one updateWorkOrderFields takes', () => {
  const src = text(resolve(APP, 'apps/api/src/services/woFieldValues.ts'));
  const code = src.match(/SELECT fields FROM task WHERE id = \$1[^`]*?\bFOR ((?:NO KEY )?UPDATE)\b/);

  it('finds the locked read of task.fields in woFieldValues.ts', () => {
    expect(code, 'the locked read moved: re-point this test at the bag-lock note').not.toBeNull();
  });

  it('every lock on task.fields the documents describe names that strength', () => {
    const strength = code?.[1] ?? '?';
    const named = [
      ...stated(/SELECT fields FROM task[^`]*?\bFOR ((?:NO KEY )?UPDATE)\b/g),
      ...stated(/`task\.fields`[^`\n]{0,40}`FOR ((?:NO KEY )?UPDATE)`/g),
    ];
    expect(named.length, 'neither document names the bag lock any more: re-point this test').toBeGreaterThan(0);
    expect(named).toEqual(named.map((n) => n.replace(/: .*$/, `: ${strength}`)));
  });
});

describe('advisory locks: every key the documents quote is in ADVISORY_LOCKS', () => {
  it('each 72620xx key named is a registered value', () => {
    const registered = new Set(Object.values(ADVISORY_LOCKS).map(String));
    const keys = stated(/\b(72620\d\d)\b/g);
    expect(keys.length, 'neither document quotes a key any more: re-point this test').toBeGreaterThan(0);
    expect(keys.filter((k) => !registered.has(k.slice(k.indexOf(': ') + 2)))).toEqual([]);
  });
});

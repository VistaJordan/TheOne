/* G6 — the Pulse works again (AUDIT.md Must-fix: W3-2 and W4-7).
 *
 * W3-2: `activity_log.entity_id` is TEXT since migration 0023 while `task.id`
 * (and the `task_id` columns) are uuid. Four comparisons in the obligation
 * engine were left uncast, Postgres answered `operator does not exist:
 * text = uuid`, every evaluation swallowed it, and not one obligation was
 * ever derived — the Pulse has been empty since 0023.
 *
 * W4-7: the readers were open to anyone signed in and unscoped: every clock on
 * every work order, whatever the viewer's book. GET /pulse, /obligations,
 * /notifications and the snooze now gate on `work_orders` view (the permission
 * the sidebar opens the Pulse with), the list carries the rule-8.5 scope
 * predicate, and `?wo=` resolves through resolveTaskId.
 *
 * Round 2, from the skeptics' review of the same files: the snooze refuses a
 * clock whose work order is outside the viewer's book (the list hides it, so
 * the write must too — same predicate, same 403); two reconciles racing on
 * two pooled connections cannot both INSERT the same clock (the 0004 partial
 * unique index is the ON CONFLICT referee, and only the winner fans out); a
 * swallowed error with no SQLSTATE prints its stack; and the NAV_PERM guard
 * fails by name if AppShell ever changes the shape of its Pulse entry.
 *
 * Hermetic: the service module is imported (no database is opened) and the
 * rest is read as source text — the house pattern for "is the guard present".
 * Every assertion here fails on the tree before the fix.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STATUS_SINCE_SQL } from '../apps/api/src/services/obligations';

const serviceSrc = readFileSync(new URL('../apps/api/src/services/obligations.ts', import.meta.url), 'utf8');
const routeSrc = readFileSync(new URL('../apps/api/src/routes/obligations.ts', import.meta.url), 'utf8');
const shellSrc = readFileSync(new URL('../apps/web/src/components/AppShell.tsx', import.meta.url), 'utf8');
const migrationSrc = readFileSync(new URL('../packages/db/migrations/0004_obligations.sql', import.meta.url), 'utf8');

/** The text of `export async function name(` up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/** A non-exported function: from `async function name(` to `async function until(`. */
function privateFnBody(src: string, name: string, until: string): string {
  const start = src.indexOf(`\nasync function ${name}(`);
  expect(start, `function ${name}`).toBeGreaterThan(-1);
  const end = src.indexOf(`\nasync function ${until}(`, start + 1);
  expect(end, `function ${until} after ${name}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

/** One route handler: from its registration to the next `app.` call. */
function handler(src: string, registration: string): string {
  const start = src.indexOf(registration);
  expect(start, `route ${registration}`).toBeGreaterThan(-1);
  const next = src.indexOf('\n  app.', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

/**
 * NAV_PERM.Pulse as AppShell.tsx declares it: a 'key', or a [list] meaning ANY
 * of them (the shape 'Incoming Work Orders' uses). A shape this does not
 * recognise fails by name instead of as a misleading "expected undefined".
 */
function pulseNavPerms(src: string): string[] {
  const m = /^\s*Pulse: (?:'([^']+)'|\[([^\]]*)\]),/m.exec(src);
  if (!m) throw new Error("NAV_PERM.Pulse not found in AppShell.tsx as a 'key' or a [list] — update this test's regex with the new shape");
  if (m[1]) return [m[1]];
  const keys = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (keys.length === 0) throw new Error('NAV_PERM.Pulse is a list with no quoted key in it — update this test');
  return keys;
}

const count = (s: string, needle: string) => s.split(needle).length - 1;

describe('W3-2 · entity_id is text, so the uuid side of every comparison is cast', () => {
  it('STATUS_SINCE_SQL casts both of its task-id comparisons', () => {
    expect(count(STATUS_SINCE_SQL, 'a.entity_id = t.id::text')).toBe(2);
    expect(STATUS_SINCE_SQL).not.toMatch(/entity_id = t\.id(?!::text)/);
  });

  it('leaves no comparison against a task_id column uncast', () => {
    expect(serviceSrc).not.toMatch(/a\.entity_id = [a-z]+\.task_id(?!::text)/);
    expect(serviceSrc).not.toMatch(/a\.entity_id = t\.id(?!::text)/);
    // Every `a.entity_id = …` in the file ends in ::text — the four W3-2 found
    // and the one 0055 already had right.
    const comparisons = serviceSrc.match(/a\.entity_id = [a-z]+\.[a-z_]+(::text)?/g) ?? [];
    expect(comparisons.length).toBeGreaterThanOrEqual(5);
    for (const c of comparisons) expect(c).toMatch(/::text$/);
  });

  it('logs a swallowed evaluation error with its SQL code, message and task', () => {
    const forTask = fnBody(serviceSrc, 'evaluateForTask');
    expect(forTask).toContain('task_id: taskId');
    expect(forTask).toContain('code: e.code');
    expect(forTask).toContain('message: e.message');
    expect(fnBody(serviceSrc, 'evaluateDebounced')).toContain('code: e.code');
    expect(fnBody(serviceSrc, 'evaluateNow')).toContain('code: e.code');
  });

  it('prints the stack of a swallowed error that has no SQLSTATE to name it', () => {
    for (const name of ['evaluateDebounced', 'evaluateForTask', 'evaluateNow']) {
      expect(fnBody(serviceSrc, name), name).toContain('stack: e.stack');
    }
  });

  it('no longer explains itself with the embedded database it left behind', () => {
    expect(serviceSrc).not.toContain('PGlite');
  });
});

describe('W4-7 · the readers are scoped and gated', () => {
  it('listObligations binds the rule-8.5 scope predicate with the same Params', () => {
    const body = fnBody(serviceSrc, 'listObligations');
    expect(body).toContain('woScopeSql(actor, p)');
    expect(body).toContain('new Params()');
    expect(body).toContain('p.values');
    expect(body).not.toContain('params.push');
  });

  it("the snooze refuses a clock outside the viewer's book with the 403 every per-work-order route gives", () => {
    const body = fnBody(serviceSrc, 'snoozeObligation');
    expect(body).toContain('woScopeSql(actor, p)');
    expect(body).toContain('LEFT JOIN task t ON t.id = o.task_id');
    expect(body).toContain('AS in_scope');
    expect(body).toContain('if (!ob.in_scope) throw outOfScope();');
    // The 403 is woScope's own, so the message and required_permission match
    // resolveTaskId's — not a second wording of the same refusal.
    expect(serviceSrc).toMatch(/import \{[^}]*outOfScope[^}]*\} from '\.\/woScope\.js'/);
  });

  it('gates every Pulse surface on the permission the sidebar opens it with', () => {
    // The route gates on ONE key, so the nav must open the Pulse with exactly
    // one too; a list here means the two have drifted apart.
    const navPerms = pulseNavPerms(shellSrc);
    expect(navPerms).toEqual(['work_orders']);
    const gate = `requirePerm(actor, '${navPerms[0]}', 'view'`;
    for (const registration of [
      "app.get('/pulse'",
      "app.get('/obligations'",
      "app.get('/notifications'",
      "app.post('/notifications/:id/read'",
      "app.post('/notifications/read-all'",
      "app.post('/obligations/:id/snooze'",
    ]) {
      expect(handler(routeSrc, registration), registration).toContain(gate);
    }
  });

  it('resolves ?wo= through resolveTaskId: scope 403 outside the book, empty when unknown', () => {
    const h = handler(routeSrc, "app.get('/obligations'");
    expect(h).toContain('resolveTaskId(q.wo, actor)');
    expect(h).toContain('return { items: [], total: 0 }');
    expect(h).toContain('listObligations({ ...q, wo }, actor)');
    expect(routeSrc).toMatch(/import \{[^}]*resolveTaskId[^}]*\} from '\.\.\/services\/activity\.js'/);
  });
});

describe('reconcile on pooled Postgres · two runs cannot double-insert a clock', () => {
  it('the INSERT names the 0004 partial unique index as its ON CONFLICT referee and only the winner fans out', () => {
    const body = privateFnBody(serviceSrc, 'reconcile', 'fanOut');
    expect(body).toContain("ON CONFLICT (rule_key, subject_id) WHERE status <> 'resolved' DO NOTHING");
    expect(body).toContain('const inserted = ins.rows[0];');
    expect(body).toContain('if (inserted && tier >= 1) await fanOut(inserted.id, tier, people, rules);');
    expect(body).not.toContain('fanOut(ins.rows[0].id');
  });

  it('the conflict target is the index the migration created (keep the two in step)', () => {
    // A target Postgres cannot match is refused at plan time ("there is no
    // unique or exclusion constraint matching the ON CONFLICT specification"),
    // and the engine would swallow that too — so the SQL and the migration
    // are pinned together here.
    expect(migrationSrc).toMatch(
      /CREATE UNIQUE INDEX obligation_live_identity_idx\s+ON obligation \(rule_key, subject_id\)\s+WHERE status <> 'resolved';/,
    );
  });
});

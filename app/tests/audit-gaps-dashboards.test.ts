/* Audit gaps closed 2026-10-20 (rule 1.2.1, "every button"): dashboards and
 * their cards, the assistant's delete / thumb / review, and a manual
 * enrollment into an automation each leave an activity_log row through
 * logAdminEvent.
 *
 * Pinned by source text, like the other guards: the suite opens no database.
 * Each writer's body (from its `export async function` to the next one) must
 * call logAdminEvent with its action name, and the system upsert of shipped
 * boards must not log.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

function src(rel: string): string {
  return readFileSync(new URL(`../apps/api/src/${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
}

/** The text of one exported function, up to the next top-level export. */
function body(text: string, fn: string): string {
  const start = text.indexOf(`export async function ${fn}(`);
  expect(start, `${fn} not found`).toBeGreaterThanOrEqual(0);
  const next = text.indexOf('\nexport ', start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function expectLogs(text: string, fn: string, action: string, entity: string): void {
  const b = body(text, fn);
  expect(b, `${fn} must call logAdminEvent`).toMatch(/logAdminEvent\(/);
  expect(b, `${fn} must log ${action}`).toContain(`'${action}'`);
  expect(b, `${fn} must log on entity ${entity}`).toContain(`entity: '${entity}'`);
}

describe('dashboards log every write', () => {
  const s = src('services/dashboards.ts');
  it.each([
    ['createDashboard', 'dashboard_created'],
    ['updateDashboard', 'dashboard_updated'],
    ['deleteDashboard', 'dashboard_deleted'],
    ['addWidget', 'dashboard_widget_added'],
    ['updateWidget', 'dashboard_widget_updated'],
    ['deleteWidget', 'dashboard_widget_removed'],
  ])('%s logs %s', (fn, action) => expectLogs(s, fn, action, 'dashboard'));

  it('card rows are keyed by the dashboard and name the card in field', () => {
    for (const fn of ['addWidget', 'updateWidget', 'deleteWidget']) {
      expect(body(s, fn)).toMatch(/field: `widget:\$\{/);
    }
  });

  it('updates skip a no-op save', () => {
    expect(body(s, 'updateDashboard')).toContain('snapshotsDiffer(');
    expect(body(s, 'updateWidget')).toContain('snapshotsDiffer(');
  });

  it('the shipped-board upsert is a system act and logs nothing', () => {
    expect(body(s, 'ensureSystemDashboards')).not.toMatch(/logAdminEvent\(/);
  });
});

describe('the assistant logs delete, thumb and review', () => {
  const s = src('services/assistant.ts');
  it.each([
    ['deleteConversation', 'assistant_conversation_deleted'],
    ['setFeedback', 'assistant_feedback_set'],
    ['markReviewed', 'assistant_feedback_reviewed'],
  ])('%s logs %s', (fn, action) => expectLogs(s, fn, action, 'assistant'));

  it('the thumb row never carries the answer, question or note text', () => {
    const b = body(s, 'setFeedback');
    const log = b.slice(b.indexOf('const before: Snapshot'), b.indexOf('return toMessage'));
    expect(log).not.toMatch(/\bbody\b/);
    expect(log).not.toMatch(/feedback_note:/);
  });
});

describe('manual enrollment logs who enrolled what', () => {
  const s = src('services/automations.ts');
  it('enrollAutomation logs automation_enrolled', () => {
    expectLogs(s, 'enrollAutomation', 'automation_enrolled', 'automation');
    expect(body(s, 'enrollAutomation')).toContain('slice(0, ENROLL_LOG_CAP)');
  });

  it('the route passes the actor through', () => {
    expect(src('routes/automations.ts')).toMatch(/enrollAutomation\(id, ids, p\.id\)/);
  });
});

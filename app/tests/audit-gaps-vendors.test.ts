/* Audit gaps closed 2026-10-20 (rule 1.2.1, "every button"), the vendors and
 * integrations half: daily targets, the task decisions that changed no vendor
 * column (acknowledge / fixed / done), a task being opened, saved lists, a
 * skill edit, the technician record behind a visit, and the ClickUp /
 * Ecotrak / SharePoint buttons each leave an activity_log row.
 *
 * Pinned by source text, like the other guards: the suite opens no database.
 * Each writer's body (from its `export async function` to the next export)
 * must reach an audit call with its action name.
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

describe('vendor workflow logs every write', () => {
  const s = src('services/vendorWork.ts');

  it('setDailyTarget logs set / removed on the person, and only when it changed', () => {
    const b = body(s, 'setDailyTarget');
    expectLogs(s, 'setDailyTarget', 'vendor_target_set', 'vendor_target');
    expect(b).toContain(`'vendor_target_removed'`);
    expect(b).toContain('entityId: input.principal_id');
    expect(b).toMatch(/snapshotsDiffer\(before, after\)/);
  });

  it('resolveTask logs acknowledge, fixed and done through logTaskDecision', () => {
    const b = body(s, 'resolveTask');
    for (const a of ['vendor_task_acknowledged', 'vendor_task_fixed', 'vendor_task_done']) {
      expect(b, a).toContain(`logTaskDecision(actor.id, task, '${a}'`);
    }
    // The fix's COI reset to PENDING is carried on the row.
    expect(b).toMatch(/coi_reset: coiReset/);
    const helper = s.slice(s.indexOf('async function logTaskDecision('), s.indexOf('async function closeTask('));
    expect(helper).toMatch(/logAdminEvent\(/);
    expect(helper).toContain(`entity: 'vendor_task'`);
  });

  it('saved lists log created and deleted', () => {
    expectLogs(s, 'saveView', 'vendor_saved_view_created', 'vendor_saved_view');
    expectLogs(s, 'deleteView', 'vendor_saved_view_deleted', 'vendor_saved_view');
  });
});

describe('a task being opened is logged under whoever raised it', () => {
  it('openVendorTask logs vendor_task_created for a new row with a creator', () => {
    const s = src('services/vendorTasks.ts');
    expectLogs(s, 'openVendorTask', 'vendor_task_created', 'vendor_task');
    expect(body(s, 'openVendorTask')).toMatch(/if \(t\.createdBy\) \{\s*await logAdminEvent/);
  });
});

describe('a skill edit is logged like the add', () => {
  it('saveVendorSkill logs vendor_skill_added and vendor_skill_updated', () => {
    const s = src('services/vendorExtras.ts');
    expectLogs(s, 'saveVendorSkill', 'vendor_skill_added', 'vendor');
    const b = body(s, 'saveVendorSkill');
    expect(b).toContain(`'vendor_skill_updated'`);
    expect(b).toMatch(/snapshotsDiffer\(before, after\)/);
  });
});

describe('the technician record behind a visit is logged on the work order', () => {
  it('linkVisitVendor logs visit_vendor_linked under visit:<id>, only on a change', () => {
    const s = src('services/vendorMap.ts');
    const b = body(s, 'linkVisitVendor');
    expect(b).toMatch(/if \(visit\.rows\[0\]\.was === vendorId\) return;/);
    expect((b.match(/await logVisitVendorLink\(/g) ?? []).length).toBe(2);
    expect(b).toContain(`'visit_vendor_linked'`);
    expect(b).toContain("VALUES ($1, 'task', $2, 'visit_vendor_linked'");
    expect(b).toContain('`visit:${visitId}`');
  });
});

describe('integration buttons are logged', () => {
  const c = src('services/clickup.ts');
  it.each([
    ['refreshClickUp', 'clickup_refreshed'],
    ['retryClickUpTask', 'clickup_task_retried'],
    ['syncClickUpNow', 'clickup_sync_requested'],
  ])('%s logs %s', (fn, action) => {
    expectLogs(c, fn, action, 'integration');
    expect(body(c, fn)).toContain(`entityId: 'clickup'`);
  });

  it('a ClickUp retry names the work order in field', () => {
    expect(body(c, 'retryClickUpTask')).toContain('field: taskId');
  });

  it('Ecotrak Sync now logs ecotrak_sync_requested', () => {
    const e = src('services/ecotrakAdmin.ts');
    expectLogs(e, 'syncEcotrakNow', 'ecotrak_sync_requested', 'integration');
    expect(body(e, 'syncEcotrakNow')).toContain(`entityId: 'ecotrak'`);
  });

  it('SharePoint Run now logs sharepoint_retry_requested with the reset count', () => {
    const sp = src('services/sharepoint.ts');
    expectLogs(sp, 'retrySharePoint', 'sharepoint_retry_requested', 'sharepoint_setting');
    expect(body(sp, 'retrySharePoint')).toMatch(/reset: resetFolders \+ resetFiles/);
  });
});

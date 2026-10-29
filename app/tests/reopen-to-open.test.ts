/* 2026-10-29 (Elise) — "Reopen leaves status wrong": reopening a job left it
 * at Cancelled and asked for no reason. Now:
 *   - Reopen always asks why and moves the work order to Open;
 *   - it is offered for any work order in a Cancel… status, however it got
 *     there (Cancel button, status menu, rejected acceptance, approved request);
 *   - a direct status pick out of a Cancel… status is refused (409
 *     REOPEN_REQUIRED), and the status menu greys those picks. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REOPEN_REQUIRED_CODE,
  REOPEN_STATUS_NAME,
  isCancelStatusName,
} from '../packages/shared/src/workflow';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const fn = (src: string, head: string) => {
  const at = src.indexOf(head);
  const end = src.indexOf('\nexport ', at + head.length);
  return src.slice(at, end === -1 ? undefined : end);
};

describe('what counts as cancelled', () => {
  it('a status whose name starts with Cancel', () => {
    expect(isCancelStatusName('Cancelled / Postponed')).toBe(true);
    expect(isCancelStatusName(' cancelled')).toBe(true);
    expect(isCancelStatusName('Open')).toBe(false);
    expect(isCancelStatusName(null)).toBe(false);
  });
  it('reopen goes to Open', () => {
    expect(REOPEN_STATUS_NAME).toBe('Open');
    expect(REOPEN_REQUIRED_CODE).toBe('REOPEN_REQUIRED');
  });
});

describe('the wiring (source pins)', () => {
  const rec = read('apps/api/src/services/woRecord.ts');
  const reopen = fn(rec, 'export async function reopenWo(');

  it('reopenWo asks why, accepts a Cancel… status without a stamp, and moves to Open', () => {
    expect(reopen).toContain("if (!why) throw badRequest('Say why it is reopened', { field: 'reason' });");
    expect(reopen).toContain('if (!t.cancelled_at && !inCancelStatus)');
    expect(reopen).toContain('[REOPEN_STATUS_NAME]');
    expect(reopen).toContain('moveStatus(taskId, st.rows[0].id, st.rows[0].name, actor)');
    expect(reopen).not.toContain('cancelled_from_status_id) {');
  });

  it('the record offers Reopen for a Cancel… status', () => {
    expect(rec).toContain('reopen: Boolean(t.cancelled_at) || isCancelStatusName(t.status_name),');
    const menu = read('apps/web/src/components/wo/record/RecordParts.tsx');
    expect(menu).toContain('const cancelled = Boolean(s.cancelled) || Boolean(record.can.reopen);');
    expect(menu).toContain('{lifecycle && (cancelled ? (');
  });

  it('a direct status pick out of a Cancel… status is refused', () => {
    const route = read('apps/api/src/routes/workOrders.ts');
    const body = route.slice(route.indexOf("app.patch('/work-orders/:id/status'"));
    const patch = body.slice(0, body.indexOf('app.post('));
    expect(patch).toContain('isCancelStatusName(row.cur) && !isCancelStatusName(row.target)');
    expect(patch).toContain('code: REOPEN_REQUIRED_CODE');
    expect(patch.indexOf('REOPEN_REQUIRED_CODE')).toBeLessThan(patch.indexOf('return changeStatus('));
    const menu = read('apps/web/src/components/StatusChangeMenu.tsx');
    expect(menu).toContain("const lockedCancelled = mode !== 'request' && isCancelStatusName(current.name);");
  });
});

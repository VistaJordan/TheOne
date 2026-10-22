/* 0091 (Elise, 2026-10-22) — statuses a dispatcher may not even request.
 *
 * The "!!" statuses in ClickUp (Approved, Waiting for Advice, Waiting for
 * Approval, Ready to Invoice, Cancelled / Postponed) are a manager's call.
 * `status.request_hidden` carries the flag per status; the pure half is
 * `requestableStatuses` (what a request-mode person is offered), the wired
 * half is pinned here: the migration and the seed tick the same names, the
 * status menu filters in request mode, the API refuses the ask, and Admin ›
 * Custom fields › Statuses draws the tick.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  REQUEST_HIDDEN_STATUS_NAMES,
  STATUS_REQUEST_HIDDEN_CODE,
  describeRequestHidden,
  requestableStatuses,
} from '../packages/shared/src/workflow';
import { PHASE_BY_STATUS_NAME } from '../packages/shared/src/index';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('REQUEST_HIDDEN_STATUS_NAMES — the five "!!" statuses', () => {
  it('names exactly the statuses Elise listed, as the pipeline spells them', () => {
    expect([...REQUEST_HIDDEN_STATUS_NAMES]).toEqual([
      'Approved',
      'Waiting for Advice',
      'Waiting for Approval',
      'Ready to Invoice',
      'Cancelled / Postponed',
    ]);
  });

  it('every name is a status the pipeline knows (a typo would hide nothing)', () => {
    for (const name of REQUEST_HIDDEN_STATUS_NAMES) {
      expect(Object.keys(PHASE_BY_STATUS_NAME)).toContain(name);
    }
  });
});

describe('requestableStatuses — what a request-mode person is offered', () => {
  const statuses = [
    { id: 'a', name: 'Open', request_hidden: false },
    { id: 'b', name: 'Approved', request_hidden: true },
    { id: 'c', name: 'Job Sched', request_hidden: false },
    { id: 'd', name: 'Cancelled / Postponed', request_hidden: true },
  ];

  it('drops every hidden status', () => {
    expect(requestableStatuses(statuses, 'a').map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('keeps the current status even when it is hidden (drawn as current, never a pick)', () => {
    expect(requestableStatuses(statuses, 'b').map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats a missing flag as not hidden, and a null current id as none', () => {
    expect(requestableStatuses([{ id: 'x' }], null)).toEqual([{ id: 'x' }]);
    expect(requestableStatuses(statuses, null).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('the refusal names the status and sends them to a manager', () => {
    expect(describeRequestHidden('Approved')).toMatch(/^Approved is a manager's call/);
    expect(describeRequestHidden('Approved')).toMatch(/manager/i);
    expect(STATUS_REQUEST_HIDDEN_CODE).toBe('STATUS_REQUEST_HIDDEN');
  });
});

describe('0091 is wired', () => {
  it('migration 0091 adds the column and ticks the five names; the seed ticks the same list', () => {
    const sql = read('packages/db/migrations/0091_status_request_hidden.sql');
    expect(sql).toMatch(/ALTER TABLE status\s+ADD COLUMN IF NOT EXISTS request_hidden boolean NOT NULL DEFAULT false/);
    for (const name of REQUEST_HIDDEN_STATUS_NAMES) {
      expect(sql.toLowerCase()).toContain(`'${name.toLowerCase()}'`);
    }
    const seed = read('packages/db/src/seed.ts');
    expect(seed).toContain('REQUEST_HIDDEN_STATUS_NAMES');
    expect(seed).toMatch(/UPDATE status SET request_hidden = true WHERE lower\(name\) = ANY\(\$1::text\[\]\)/);
  });

  it('the API reads the flag on every status and refuses a request for a hidden one', () => {
    expect(read('apps/api/src/services/workOrders.ts')).toMatch(/SELECT id, name, status_group AS "group", color, position, is_archive, request_hidden/);
    const approvals = read('apps/api/src/services/approvals.ts');
    const fn = approvals.slice(approvals.indexOf('export async function requestStatusChange'));
    expect(fn).toContain('SELECT name, request_hidden FROM status WHERE id = $1');
    expect(fn).toContain('if (to.rows[0].request_hidden)');
    expect(fn).toContain('code: STATUS_REQUEST_HIDDEN_CODE');
    // Refused before the gate and the Ecotrak check, so a hidden status is
    // never asked about at all.
    expect(fn.indexOf('request_hidden)')).toBeLessThan(fn.indexOf('assertStatusGate'));
  });

  it('the status menu offers a request-mode person only the requestable statuses', () => {
    const menu = read('apps/web/src/components/StatusChangeMenu.tsx');
    expect(menu).toContain('requestableStatuses(statusesQuery.data ?? [], current.id)');
    expect(menu).toMatch(/mode === 'request'\s*\?\s*requestableStatuses/);
  });

  it('Admin › Custom fields › Statuses draws a Managers only tick that PATCHes request_hidden', () => {
    const admin = read('apps/web/src/pages/admin/AdminSections.tsx');
    expect(admin).toContain('<span>Managers only</span>');
    expect(admin).toContain('checked={s.request_hidden}');
    expect(admin).toContain("input: { request_hidden }");
    const route = read('apps/api/src/routes/admin.ts');
    expect(route).toContain('request_hidden: z.boolean().optional()');
    const svc = read('apps/api/src/services/statusAdmin.ts');
    expect(svc).toContain('request_hidden = COALESCE($4, request_hidden)');
    // The admin audit row shows the flag flipping.
    expect(svc).toContain('request_hidden: s.request_hidden');
  });
});

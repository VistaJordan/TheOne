/* BRD 2.7 (Elise, 2026-11-04) — "No status order": a work order could jump
 * from any status to any other. Now each client follows its portal's steps
 * (product/status-maps/*-default-map.md, keyed by Client Portal Type); a work
 * order with no portal is not restricted (on hold). The tables in
 * packages/shared/src/statusOrder.ts must say what the map files say: this
 * test reads each file's "Moves allowed in The one" list and compares. */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  STATUS_ORDER_BY_PORTAL,
  allowedNextStatusNames,
  checkStatusOrder,
  describeStatusOrderRefusal,
  statusOrderRefused,
  type StatusOrderPortal,
} from '../packages/shared/src/statusOrder';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

const MAP_FILES: Record<StatusOrderPortal, string> = {
  ecotrak: '../product/status-maps/ecotrack-default-map.md',
  corrigo: '../product/status-maps/corrigo-default-map.md',
  servicechannel: '../product/status-maps/servicechannel-default-map.md',
};

/** The map file's moves, from → to set. "New" rows and reschedules (a status
    to itself) are left out, as the tables leave them out. */
function movesFromFile(md: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const block = md.split('**Moves allowed in The one**')[1].split('**Rules behind the moves**')[0];
  for (const line of block.split(/\r?\n/)) {
    const m = /^\* (.+?) -> can change to: (.+)$/.exec(line.trim());
    if (!m) continue;
    const from = m[1].trim();
    if (from === 'New') continue;
    const tos = m[2]
      .replace(/\[[^\]]*\]/g, '')
      // A condition in brackets goes; "(Assessment)" / "(Job)" are names.
      .replace(/\((?!Assessment\)|Job\))[^)]*\)/g, '')
      .split(/,|;| or /)
      .map((s) => s.trim())
      .filter((s) => s && s !== from);
    out.set(from, new Set(tos));
  }
  return out;
}

describe('the tables follow the map files', () => {
  for (const portal of Object.keys(MAP_FILES) as StatusOrderPortal[]) {
    it(`${portal}: every move in the file, and nothing else but Approved`, () => {
      const file = movesFromFile(read(MAP_FILES[portal]));
      const table = STATUS_ORDER_BY_PORTAL[portal];
      expect(file.size).toBeGreaterThan(10);
      for (const [from, tos] of file) {
        expect(Object.keys(table), `${portal}: ${from}`).toContain(from);
        // Approved is ours: the client's yes lands there after Waiting for Approval.
        const ours = new Set([...table[from]].filter((t) => t !== 'Approved'));
        expect([...ours].sort(), `${portal}: ${from}`).toEqual([...tos].sort());
      }
      const extra = Object.keys(table).filter((k) => !file.has(k));
      expect(extra).toEqual(['Approved']);
    });
  }
});

describe('checkStatusOrder', () => {
  it('no portal is not restricted', () => {
    expect(checkStatusOrder(null, 'Open', 'Invoiced').outcome).toBe('no_portal');
    expect(checkStatusOrder('', 'Open', 'Invoiced').outcome).toBe('no_portal');
    expect(checkStatusOrder('7-Eleven', 'Open', 'Invoiced').outcome).toBe('no_portal');
  });

  it('reads the portal off Client Portal Type, case and spacing folded', () => {
    expect(checkStatusOrder('Service Channel', 'Open', 'Invoiced').outcome).toBe('blocked');
    expect(checkStatusOrder('EcoTrack', 'Open', 'Job Sched').outcome).toBe('allowed');
  });

  it('follows each portal', () => {
    // Ecotrak needs a schedule first; Corrigo and ServiceChannel check in from Open.
    expect(statusOrderRefused(checkStatusOrder('Ecotrak', 'Open', 'On Site (Job)'))).toBe(true);
    expect(statusOrderRefused(checkStatusOrder('Corrigo', 'Open', 'On Site (Job)'))).toBe(false);
    expect(statusOrderRefused(checkStatusOrder('ServiceChannel', 'Open', 'On Site (Job)'))).toBe(false);
  });

  it('Invoiced and Cancelled are terminal but for their one step', () => {
    for (const p of ['Ecotrak', 'Corrigo', 'ServiceChannel']) {
      expect(allowedNextStatusNames(p, 'Invoiced')).toEqual(['Invoiced Not Paid']);
      expect(allowedNextStatusNames(p, 'Cancelled / Postponed')).toEqual(['Open']);
      expect(statusOrderRefused(checkStatusOrder(p, 'Invoiced', 'Open'))).toBe(true);
    }
  });

  it('a status no table names is never restricted, in or out', () => {
    expect(checkStatusOrder('Ecotrak', 'Emergency', 'Invoiced').outcome).toBe('unlisted');
    expect(checkStatusOrder('Ecotrak', 'Open', 'Emergency').outcome).toBe('unlisted');
    expect(allowedNextStatusNames('Ecotrak', 'Emergency')).toBeNull();
  });

  it('the same status is no move', () => {
    expect(checkStatusOrder('Ecotrak', 'Invoiced', 'invoiced').outcome).toBe('allowed');
  });

  it('the refusal names the portal and the next steps', () => {
    const s = describeStatusOrderRefusal(checkStatusOrder('Ecotrak', 'Waiting for Parts', 'Done / Incurred'));
    expect(s).toContain('Ecotrak');
    expect(s).toContain('Job Sched, Cancelled / Postponed');
  });
});

describe('where it is asked', () => {
  const wo = read('apps/api/src/services/workOrders.ts');
  const appr = read('apps/api/src/services/approvals.ts');
  const bulk = read('apps/api/src/services/woBulk.ts');
  const rec = read('apps/api/src/services/woRecord.ts');
  const menu = read('apps/web/src/components/StatusChangeMenu.tsx');
  const header = read('apps/web/src/components/wo/WoHeader.tsx');

  it('changeStatus, except automations and the quote', () => {
    expect(wo).toMatch(/if \(!auto && source !== 'quote'\) \{\s*await assertStatusOrder\(tx, task_id, newStatusName, currentStatusName\);/);
  });
  it('a status request and its approval', () => {
    expect(appr.match(/await assertStatusOrder\(\{ query \}/g)?.length).toBe(2);
  });
  it('bulk edit and Cancel', () => {
    expect(bulk).toContain('checkStatusOrder(');
    expect(rec).toContain('assertStatusOrder({ query }, taskId, cancelStatus.rows[0].name');
  });
  it('the menu offers only the next steps, from the header portal', () => {
    expect(menu).toContain('statusOrderRefused(checkStatusOrder(portalType, current.name, s.name))');
    expect(header).toContain('portalType={f[CLIENT_PORTAL_TYPE_KEY]}');
  });
});

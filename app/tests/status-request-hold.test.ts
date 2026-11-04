// 0123 · Hold on a status change request (Elise, 2026-11-04). Source-text
// pins, like the rest of the suite: no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

describe('Hold on a status change request (0123)', () => {
  it('adds the three hold columns and leaves the status CHECK alone', () => {
    const sql = read('packages', 'db', 'migrations', '0123_approval_task_hold.sql');
    expect(sql).toMatch(/held_by\s+uuid REFERENCES principal/);
    expect(sql).toMatch(/held_at\s+timestamptz/);
    expect(sql).toMatch(/hold_note text/);
    expect(sql).not.toMatch(/CHECK/);
  });

  it('holds and releases through their own routes, scoped like a decision', () => {
    const routes = read('apps', 'api', 'src', 'routes', 'approvals.ts');
    expect(routes).toContain("'/approval-tasks/:id/hold'");
    expect(routes).toContain("'/approval-tasks/:id/release'");
    // The note is optional.
    expect(routes).toMatch(/holdSchema = z\.object\(\{ note: z\.string\(\)\.trim\(\)\.max\(2000\)\.nullable\(\)\.optional\(\) \}\)/);
    expect(routes.match(/assertRecordInScope\('approval_task'/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps a held request open, status changes only, never the requester’s own', () => {
    const svc = read('apps', 'api', 'src', 'services', 'approvals.ts');
    const hold = svc.slice(svc.indexOf('export async function holdApprovalTask'), svc.indexOf('export async function releaseApprovalTask'));
    expect(hold).toContain("cur.type !== 'status_change'");
    expect(hold).toContain("requireDecide(actor, cur.type, 'hold')");
    expect(hold).toContain("WHERE id = $3 AND status = 'open'");
    expect(hold).not.toMatch(/SET\s+status\s*=/);
    expect(hold).toContain('approval_task_held');
    expect(svc).toContain('approval_task_released');
    // Asking for a different status lifts the hold.
    expect(svc).toContain("input.type === 'status_change' && before.title !== title");
  });

  it('draws Hold / Release between Reject and Approve on the header chip and in the inbox', () => {
    const banner = read('apps', 'web', 'src', 'components', 'wo', 'StatusChangeBanner.tsx');
    expect(banner.indexOf('Reject\n') >= 0 || banner.includes('Reject\r\n')).toBe(true);
    expect(banner).toContain('Hold');
    expect(banner).toContain("'Releasing…' : 'Release'");
    expect(banner).toContain("'on hold' : 'pending approval'");
    const inbox = read('apps', 'web', 'src', 'pages', 'ApprovalsPage.tsx');
    expect(inbox).toContain("verb('Hold', 'clock'");
    expect(inbox).toContain("verb('Release', 'refresh'");
    expect(inbox).toContain("label: 'On hold'");
  });
});

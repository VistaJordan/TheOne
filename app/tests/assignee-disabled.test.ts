// A work order is never assigned to a disabled account — not by a person
// (assertDispatchers already asks status <> 'disabled'), and not by the paths
// that skip the dispatcher check: a rule's own write, the PM raise, the CSV
// import. Source pins; the suite opens no database.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ASSIGNEE_DISABLED_CODE, assigneeDisabledMessage } from '@theone/shared';

const read = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');
const svc = (f: string) => read('apps', 'api', 'src', 'services', f);

describe('assigning a disabled account', () => {
  it('names the account in the refusal', () => {
    expect(ASSIGNEE_DISABLED_CODE).toBe('ASSIGNEE_DISABLED');
    expect(assigneeDisabledMessage(['Ana'])).toBe('"Ana" is a disabled account — a work order cannot be assigned to them');
    expect(assigneeDisabledMessage(['Ana', 'Bo'])).toContain('"Ana", "Bo" are disabled accounts');
  });

  it('the dispatcher check refuses disabled people', () => {
    expect(svc('dataRules.ts')).toMatch(/status <> 'disabled' AND role = ANY/);
  });

  it('a disabled name is one with no account that is not disabled', () => {
    expect(svc('dataRules.ts')).toMatch(/HAVING bool_and\(status = 'disabled'\)/);
  });

  it('rule and system writes of the seat are asked too', () => {
    const src = svc('woFieldValues.ts');
    expect(src).toMatch(/\} else if \(seat\) \{\s*await assertNoDisabledAssignees\(addedAssignees\(seat\.before, seat\.after\)/);
  });

  it('the PM raise leaves the work order unassigned instead of stopping', () => {
    const src = svc('plannedMaintenance.ts');
    expect(src).toMatch(/try \{\s*await updateWorkOrderFields\(taskId, \{ 'fields\.Assignee': s\.assignee \}[\s\S]*?catch \(err\)/);
  });

  it('the CSV import refuses a file that assigns a disabled account', () => {
    const src = svc('woBulk.ts');
    expect(src).toContain('disabledAssigneeKeys(');
    expect(src).toContain('code: ASSIGNEE_DISABLED_CODE');
  });
});

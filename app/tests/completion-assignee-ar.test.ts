/* Elise, 2026-10-30 — the Completion Assignee is only ever a user with the AR
 * role: the picker (field editor, bulk edit, filters, Add work order) lists
 * AR users only, and the API refuses a name ADDED to the field that is not an
 * active AR user (field editor, bulk edit, Add work order). A rule's own write
 * is asked only that the account is not disabled, as for the Assignee seat.
 *
 * The vocabulary is pure; the wiring is pinned to the source.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMPLETION_ASSIGNEE_KEY,
  COMPLETION_ASSIGNEE_NOT_AR_CODE,
  COMPLETION_ASSIGNEE_ROLE_CODES,
  ROLE_LIMITED_PERSON_FIELDS,
  completionAssigneeNotArMessage,
} from '../packages/shared/src/index';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('Completion Assignee is AR only', () => {
  it('names the field and the role', () => {
    expect(COMPLETION_ASSIGNEE_KEY).toBe('Completion Assignee');
    expect([...COMPLETION_ASSIGNEE_ROLE_CODES]).toEqual(['ar']);
    expect(ROLE_LIMITED_PERSON_FIELDS[COMPLETION_ASSIGNEE_KEY]).toBe('ar');
    expect(COMPLETION_ASSIGNEE_NOT_AR_CODE).toBe('COMPLETION_ASSIGNEE_NOT_AR');
  });

  it('says who is refused', () => {
    expect(completionAssigneeNotArMessage(['Mary Smith'])).toBe(
      '"Mary Smith" is not an active AR user — the Completion Assignee must hold the AR role',
    );
    expect(completionAssigneeNotArMessage(['A', 'B'])).toContain('"A", "B" are not active AR users');
  });

  it('the picker options list AR users only', () => {
    expect(read('apps/api/src/services/woFields.ts')).toContain(
      'const seatRole = seatRoleForField(key) ?? ROLE_LIMITED_PERSON_FIELDS[key] ?? null;',
    );
  });

  it('every person write path asks the AR check', () => {
    const fv = read('apps/api/src/services/woFieldValues.ts');
    expect(fv).toContain('await assertCompletionAssignees(addedAssignees(closer.before, closer.after), closer.field, tx);');
    expect(fv).toContain('await assertNoDisabledAssignees(addedAssignees(closer.before, closer.after), closer.field, tx);');
    expect(read('apps/api/src/services/woBulk.ts')).toContain(
      'await assertCompletionAssignees(assigneeNames(closer.value));',
    );
    expect(read('apps/api/src/services/woCreate.ts')).toContain(
      'await assertCompletionAssignees(assigneeNames(bag[COMPLETION_ASSIGNEE_KEY]));',
    );
    const rules = read('apps/api/src/services/dataRules.ts');
    expect(rules).toMatch(/assertRoleHolders\(\s*names,\s*COMPLETION_ASSIGNEE_ROLE_CODES/);
  });
});

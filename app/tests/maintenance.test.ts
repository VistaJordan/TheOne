// 0065 — the pure rules of the maintenance modules: what a permit reads as on
// a given day, when it may be sent for approval, what an entry of time is
// worth, and who should take the next job.
import { describe, expect, it } from 'vitest';
import { PERMIT_PRECAUTIONS, PERMIT_TYPES, permitRequestProblem, permitState, suggestAssignees, timeAmount } from '@theone/shared';

describe('what a permit reads as', () => {
  it('keeps the stored status until it is approved', () => {
    expect(permitState('draft', '2026-10-01', '2026-10-05', '2026-10-03')).toBe('draft');
    expect(permitState('requested', '2026-10-01', '2026-10-05', '2026-10-09')).toBe('requested');
    expect(permitState('closed', '2026-10-01', '2026-10-05', '2026-10-03')).toBe('closed');
  });

  it('is active between its dates (both included), approved before, expired after', () => {
    expect(permitState('approved', '2026-10-02', '2026-10-05', '2026-10-01')).toBe('approved');
    expect(permitState('approved', '2026-10-02', '2026-10-05', '2026-10-02')).toBe('active');
    expect(permitState('approved', '2026-10-02', '2026-10-05', '2026-10-05')).toBe('active');
    expect(permitState('approved', '2026-10-02', '2026-10-05', '2026-10-06')).toBe('expired');
  });
});

describe('when a permit may be sent for approval', () => {
  const ok = { permit_type: 'Hot work', holder: 'Ray Tech', valid_from: '2026-10-02', valid_to: '2026-10-03' };
  it('needs a kind, a holder and both days in order', () => {
    expect(permitRequestProblem(ok)).toBeNull();
    expect(permitRequestProblem({ ...ok, holder: '  ' })).toMatch(/holds/);
    expect(permitRequestProblem({ ...ok, valid_to: null })).toMatch(/first and the last day/);
    expect(permitRequestProblem({ ...ok, valid_to: '2026-10-01' })).toMatch(/before/);
    expect(permitRequestProblem({ ...ok, permit_type: '' })).toMatch(/kind/);
  });

  it('every kind of permit starts with a list of precautions', () => {
    for (const t of PERMIT_TYPES) expect(PERMIT_PRECAUTIONS[t]?.length).toBeGreaterThan(0);
  });
});

describe('what time is worth', () => {
  it('is minutes times the hourly rate, to the cent, and nothing without a rate', () => {
    expect(timeAmount(90, 80)).toBe(120);
    expect(timeAmount(20, 85)).toBe(28.33);
    expect(timeAmount(90, null)).toBeNull();
    expect(timeAmount(0, 80)).toBe(0);
  });
});

describe('who takes the next job', () => {
  const p = (name: string, open: number, emergencies = 0) => ({ id: name, name, role_label: 'OM', open, emergencies, overdue: 0 });
  it('offers the lightest load first, fewer emergencies breaking a tie', () => {
    const out = suggestAssignees([p('Ann', 5), p('Bob', 2, 1), p('Cal', 2), p('Dee', 9)], 2);
    expect(out.map((x) => x.name)).toEqual(['Cal', 'Bob']);
  });
});

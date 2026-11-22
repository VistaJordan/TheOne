/* OP Admin on the work order and their interim rights (migration 0161, Elise
 * 2026-11-19). Pure vocabulary plus source-text pins: the field lists OP Admins
 * only, counts as on the job, and the status route, the visits and the
 * Approvals decision all ask oaInterimFor, which ends when OBI → Ecotrak is on. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSIGNED_SEAT_KEYS,
  OA_INTERIM_INTEGRATION,
  OA_ROLE_CODE,
  OA_SEAT_KEY,
  ROLE_LIMITED_PERSON_FIELDS,
  seatNamesInclude,
} from '@theone/shared';

const api = (p: string) => readFileSync(join(__dirname, '..', 'apps', 'api', 'src', p), 'utf8');

describe('OP Admin seat', () => {
  it('lists OP Admins only and counts as on the job', () => {
    expect(OA_SEAT_KEY).toBe('OP Admin');
    expect(ROLE_LIMITED_PERSON_FIELDS[OA_SEAT_KEY]).toBe(OA_ROLE_CODE);
    expect(ASSIGNED_SEAT_KEYS).toContain(OA_SEAT_KEY);
  });

  it('matches a name in a comma-joined seat, case and spaces folded', () => {
    expect(seatNamesInclude('Olivia OA, Oscar OA', 'oscar oa')).toBe(true);
    expect(seatNamesInclude('Olivia OA', 'Oscar OA')).toBe(false);
    expect(seatNamesInclude(null, 'Olivia OA')).toBe(false);
    expect(seatNamesInclude('Olivia OA', '')).toBe(false);
  });

  it('ends with OBI → Ecotrak', () => {
    expect(OA_INTERIM_INTEGRATION).toBe('ecotrak_outbound');
    expect(api('services/oaInterim.ts')).toContain('integrationOnNow(OA_INTERIM_INTEGRATION)');
  });

  it('is asked by the status route, the visits and the decision', () => {
    expect(api('routes/workOrders.ts')).toContain('await oaInterimFor(p, scoped)');
    expect(api('services/visits.ts').match(/oaInterimFor\(/g)?.length).toBe(2);
    expect(api('services/approvals.ts')).toContain("await requireDecideOrOa(actor, cur, 'approve')");
    expect(api('services/approvals.ts')).toContain("await requireDecideOrOa(actor, cur, 'reject')");
  });

  it('is refused for anyone else in the seat by every writer', () => {
    expect(api('services/woFieldValues.ts')).toContain('assertOaSeat(');
    expect(api('services/woBulk.ts')).toContain('assertOaSeat(');
    expect(api('services/woCreate.ts')).toContain('assertOaSeat(');
  });
});

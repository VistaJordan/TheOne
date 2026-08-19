/* Work-order lifecycle through to the GREY FLAG — the completion-audit hold.
 *
 * Business Rules Catalog §4:
 *   Grey flag   — the completion-audit hold: a finished WO not yet released
 *                 for invoicing (owner: AR)
 *   Release gate — the Admin Check + Quote Check confirmations that lift it
 *
 * SOP-OPS-001 stage 15 is the behaviour under test: AR works the audit queue,
 * opens the WO's check read-out (quote on file, sign-off sheet, before/after
 * photos, CICO, CO#, labels), and the WO stays held until the gate is ticked.
 *
 * These are pure functions over a fixture, so they need no database. They lock
 * the rules BEFORE the Phase 1 Postgres swap and the Phase 2 restructure move
 * the code underneath them.
 */

import { describe, it, expect } from 'vitest';

import {
  computeAuditIssues,
  summarizeIssues,
  overallStatus,
  deriveReceivables,
  type AuditRow,
  type AuditChecks,
} from '../apps/web/src/lib/receivables';
import type { WorkOrderListItemV2 } from '../apps/web/src/api/client';
import { PHASE_BY_STATUS_NAME, PHASE_ORDER } from '../packages/shared/src/index';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function wo(
  id: string,
  statusName: string,
  group: 'open' | 'active' | 'done' | 'closed',
  ageDays = 10,
): WorkOrderListItemV2 {
  return {
    id,
    wo_number: `WO-${id}`,
    ext_name: null,
    title: 'Condenser fan motor seized',
    client: 'Dollar General',
    city: 'Tulsa',
    state: 'OK',
    trade: 'HVAC',
    billing_entity: 'SFM',
    nte: 5000,
    priority: 'normal',
    date_received: '2026-07-01',
    home_list: 'Incoming WOs',
    status: { id: `st-${statusName}`, name: statusName, group },
    age_days: ageDays,
  } as unknown as WorkOrderListItemV2;
}

/** A WO that has passed every check — the only shape that should audit clean. */
function cleanRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    wo: wo('39403', 'done/incurred', 'done'),
    bfi: false,
    cico: 'Checked-out',
    hasClientQuote: true,
    clientQuotePreview: 'Option A — $4,200.00',
    coNumber: '123456',
    daysDone: 3,
    daysGrey: 3,
    fm: 'CBRE',
    comp: 'SFM',
    assignee: 'A. Rivera',
    sp: {
      live: true,
      accessible: true,
      empty: false,
      hasSo: true,
      hasBefore: true,
      hasAfter: true,
      mislabeled: 0,
    },
    checks: { gtg: true, elise: true, admin: true, quote: true },
    ...overrides,
  };
}

const GATE_OPEN: AuditChecks = { gtg: true, elise: true, admin: true, quote: true };
const GATE_SHUT: AuditChecks = { gtg: true, elise: true, admin: false, quote: false };

const ids = (row: AuditRow, checks: AuditChecks) =>
  computeAuditIssues(row, checks).map((i) => i.id.replace(`${row.wo.id}-`, ''));

// ── 1. The pipeline the WO travels before it can be audited ──────────────────

describe('lifecycle: intake -> done', () => {
  it('every seeded status name maps to a phase or an explicit off-pipeline null', () => {
    for (const [name, phase] of Object.entries(PHASE_BY_STATUS_NAME)) {
      if (phase !== null) {
        expect(PHASE_ORDER, `"${name}" -> "${phase}"`).toContain(phase);
      }
    }
  });

  it('phases run intake -> assessment -> quote -> approval -> scheduled -> in progress', () => {
    const order = PHASE_ORDER;
    expect(order.indexOf('Intake')).toBeLessThan(order.indexOf('Assessment'));
    expect(order.indexOf('Assessment')).toBeLessThan(order.indexOf('Quote'));
    expect(order.indexOf('Quote')).toBeLessThan(order.indexOf('Approval'));
    expect(order.indexOf('Approval')).toBeLessThan(order.indexOf('Scheduled'));
    expect(order.indexOf('Scheduled')).toBeLessThan(order.indexOf('In Progress'));
  });

  it('Done precedes Invoiced — the grey flag sits between them', () => {
    expect(PHASE_ORDER.indexOf('Done')).toBeLessThan(PHASE_ORDER.indexOf('Invoiced'));
  });

  it('a finished WO lands in the grey-flag queue, not in history', () => {
    const items = Array.from({ length: 10 }, (_, i) => wo(`d${i}`, 'done/incurred', 'done', 30 - i));
    const { queue } = deriveReceivables(items);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0].wo.status.group).toBe('done');
  });

  it('closed WOs never enter the audit queue', () => {
    const items = Array.from({ length: 6 }, (_, i) => wo(`c${i}`, 'invoiced', 'closed'));
    const { queue, history } = deriveReceivables(items);
    expect(queue.every((r) => r.wo.status.group !== 'closed')).toBe(true);
    expect(history.length).toBe(6);
  });
});

// ── 2. The grey-flag audit: a fully-evidenced WO ─────────────────────────────

describe('grey flag: a complete WO audits clean', () => {
  it('raises no issues at all when every check passes and the gate is ticked', () => {
    expect(computeAuditIssues(cleanRow(), GATE_OPEN)).toEqual([]);
  });

  it('overall status is clean', () => {
    expect(overallStatus(computeAuditIssues(cleanRow(), GATE_OPEN))).toBe('clean');
  });
});

// ── 3. Each individual check, isolated ───────────────────────────────────────

describe('grey flag: individual audit rules', () => {
  it('CICO not Checked-out is MINOR', () => {
    const issues = computeAuditIssues(cleanRow({ cico: 'RTN' }), GATE_OPEN);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('minor');
    expect(overallStatus(issues)).toBe('minor');
  });

  it('missing client quote is MAJOR — it blocks the audit', () => {
    const issues = computeAuditIssues(cleanRow({ hasClientQuote: false }), GATE_OPEN);
    expect(issues[0].severity).toBe('major');
    expect(overallStatus(issues)).toBe('major');
  });

  it('missing sign-off sheet is MAJOR', () => {
    const row = cleanRow();
    row.sp.hasSo = false;
    expect(ids(row, GATE_OPEN)).toContain('so-missing');
    expect(overallStatus(computeAuditIssues(row, GATE_OPEN))).toBe('major');
  });

  it('missing before-images is MAJOR and is never waived', () => {
    const row = cleanRow({ bfi: true }); // BFI waives AFTER images, not BEFORE
    row.sp.hasBefore = false;
    expect(ids(row, GATE_OPEN)).toContain('before-images');
  });

  it('mislabeled images are MINOR and report the count', () => {
    const row = cleanRow();
    row.sp.mislabeled = 3;
    const issues = computeAuditIssues(row, GATE_OPEN);
    expect(issues[0].severity).toBe('minor');
    expect(issues[0].title).toContain('3 images');
  });

  it('CO# is validated only when populated, and must be exactly 6 digits', () => {
    expect(ids(cleanRow({ coNumber: null }), GATE_OPEN)).toEqual([]);
    expect(ids(cleanRow({ coNumber: '12345' }), GATE_OPEN)).toContain('co');
    expect(ids(cleanRow({ coNumber: '1234567' }), GATE_OPEN)).toContain('co');
    expect(ids(cleanRow({ coNumber: '12a456' }), GATE_OPEN)).toContain('co');
    expect(ids(cleanRow({ coNumber: '123456' }), GATE_OPEN)).toEqual([]);
  });
});

// ── 4. BFI — the rule Jordan set for rejected proposals ──────────────────────

describe('grey flag: BFI waives after-images', () => {
  it('after-images missing is MAJOR on a normal WO', () => {
    const row = cleanRow({ bfi: false });
    row.sp.hasAfter = false;
    expect(ids(row, GATE_OPEN)).toContain('after-images');
    expect(overallStatus(computeAuditIssues(row, GATE_OPEN))).toBe('major');
  });

  it('after-images missing is NOT raised when the WO is BFI', () => {
    // Bill For Incurred: the proposed work never happened, so there is no
    // "after" to photograph. Only the incurred diagnostic visit bills.
    const row = cleanRow({ bfi: true });
    row.sp.hasAfter = false;
    expect(ids(row, GATE_OPEN)).not.toContain('after-images');
    expect(overallStatus(computeAuditIssues(row, GATE_OPEN))).toBe('clean');
  });
});

// ── 5. SharePoint coverage: offline must not read as a pass ─────────────────

describe('grey flag: SharePoint coverage', () => {
  it('offline is reported, but never colors the overall status', () => {
    const row = cleanRow();
    row.sp.live = false;
    const issues = computeAuditIssues(row, GATE_OPEN);
    expect(issues.map((i) => i.severity)).toContain('offline');
    // Coverage gap, not a WO defect — the WO is not "clean-because-unchecked".
    expect(overallStatus(issues)).toBe('clean');
    expect(summarizeIssues(issues).offline).toBe(1);
  });

  it('offline SKIPS the folder checks rather than passing them', () => {
    const row = cleanRow();
    row.sp.live = false;
    row.sp.hasSo = false;
    row.sp.hasBefore = false;
    row.sp.hasAfter = false;
    const got = ids(row, GATE_OPEN);
    expect(got).toContain('sp-offline');
    expect(got).not.toContain('so-missing');
    expect(got).not.toContain('before-images');
  });

  it('an inaccessible folder is MAJOR — the link is set but unusable', () => {
    const row = cleanRow();
    row.sp.accessible = false;
    expect(ids(row, GATE_OPEN)).toContain('sp-inaccessible');
    expect(overallStatus(computeAuditIssues(row, GATE_OPEN))).toBe('major');
  });

  it('an empty folder is MAJOR', () => {
    const row = cleanRow();
    row.sp.empty = true;
    expect(ids(row, GATE_OPEN)).toContain('sp-empty');
  });
});

// ── 6. The release gate that lifts the grey flag ────────────────────────────

describe('grey flag: the release gate', () => {
  it('an unticked gate raises an INFO issue, not a blocking one', () => {
    const issues = computeAuditIssues(cleanRow(), GATE_SHUT);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('info');
    // Info alone still reads clean — the gate is a human confirmation, not a defect.
    expect(overallStatus(issues)).toBe('clean');
  });

  it('BOTH Admin and Quote are required — either alone leaves it pending', () => {
    const only = (a: boolean, q: boolean) =>
      ids(cleanRow(), { gtg: true, elise: true, admin: a, quote: q });
    expect(only(true, false)).toContain('gate');
    expect(only(false, true)).toContain('gate');
    expect(only(false, false)).toContain('gate');
    expect(only(true, true)).toEqual([]);
  });

  it('GTG and Elise are triage marks and do NOT gate release', () => {
    const issues = computeAuditIssues(cleanRow(), {
      gtg: false, elise: false, admin: true, quote: true,
    });
    expect(issues).toEqual([]);
  });
});

// ── 7. Severity precedence ──────────────────────────────────────────────────

describe('grey flag: severity precedence', () => {
  it('major outranks minor, minor outranks clean', () => {
    const row = cleanRow({ cico: 'RTN', hasClientQuote: false });
    const s = summarizeIssues(computeAuditIssues(row, GATE_SHUT));
    expect(s.major).toBe(1);
    expect(s.minor).toBe(1);
    expect(s.info).toBe(1);
    expect(overallStatus(computeAuditIssues(row, GATE_SHUT))).toBe('major');
  });

  it('a worst-case WO reports every failure at once rather than stopping at the first', () => {
    const row = cleanRow({ cico: 'RTN', hasClientQuote: false, coNumber: 'XX', bfi: false });
    row.sp.hasSo = false;
    row.sp.hasBefore = false;
    row.sp.hasAfter = false;
    row.sp.mislabeled = 2;
    const got = ids(row, GATE_SHUT);
    for (const expected of [
      'cico', 'client-quote', 'so-missing', 'before-images',
      'after-images', 'labels', 'co', 'gate',
    ]) {
      expect(got, `missing "${expected}"`).toContain(expected);
    }
  });
});

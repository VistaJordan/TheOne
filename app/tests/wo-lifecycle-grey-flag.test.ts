/* Work-order lifecycle through to the GREY FLAG — the completion-audit hold.
 *
 * Business Rules Catalog §4:
 *   Grey flag   — the completion-audit hold: a finished WO not yet released
 *                 for invoicing (owner: AR)
 *   Release gate — the Admin Check + Quote Check confirmations that lift it
 *
 * SOP-OPS-001 stage 15 is the behaviour under test: AR works the audit queue,
 * opens the WO's check read-out (quote on file, CICO, CO#, BFI, and the
 * SharePoint folder checks once a reader exists), and the WO stays held until
 * the gate is ticked.
 *
 * Since AUDIT.md W2-1 the engine reads FACTS, never guesses: a fact The One
 * does not carry is `null` and yields one "offline" coverage line, never a
 * finding; a quote the quotes list did not reach is unknown the same way; the
 * SharePoint folder checks are always offline (no reader runs in the
 * browser); the queue is the done group alone, with no padding and no
 * invented history. These are pure functions over a fixture, so they need no
 * database.
 */

import { describe, it, expect } from 'vitest';

import {
  QUOTES_LIST_CAP,
  computeAuditIssues,
  summarizeIssues,
  overallStatus,
  deriveReceivables,
  type AuditRow,
  type AuditChecks,
} from '../apps/web/src/lib/receivables';
import type { QuoteListItem, WorkOrderListItemV2 } from '../apps/web/src/api/client';
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

function quoteFor(taskId: string, i = 0): QuoteListItem {
  return {
    id: `q-${taskId}-${i}`,
    task_id: taskId,
    wo_number: `WO-${taskId}`,
    number: null,
    title: null,
    client: 'Dollar General',
    status: 'approved',
    rev: 1,
    current_round: 1,
    grand_total: 4200,
    updated_at: null,
    wo_due: null,
    wo_nte: 5000,
    wo_cost: null,
    wo_emergency: false,
    wo_escalated: false,
  };
}

/** A WO that has passed every check The One can run — the only shape that
    should audit clean. Days and the folder contents are not tracked. */
function cleanRow(overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    wo: wo('39403', 'done/incurred', 'done'),
    bfi: false,
    cico: 'Checked-out',
    hasClientQuote: true,
    clientQuotePreview: 'Q-SFM-2026-0001 · $4,200.00 · approved',
    coNumber: '123456',
    daysDone: null,
    daysGrey: null,
    fm: 'CBRE',
    comp: 'SFM',
    assignee: 'A. Rivera',
    sp: { live: false },
    checks: { gtg: true, elise: true, admin: true, quote: true },
    ...overrides,
  };
}

const GATE_OPEN: AuditChecks = { gtg: true, elise: true, admin: true, quote: true };
const GATE_SHUT: AuditChecks = { gtg: true, elise: true, admin: false, quote: false };

const ids = (row: AuditRow, checks: AuditChecks) =>
  computeAuditIssues(row, checks).map((i) => i.id.replace(`${row.wo.id}-`, ''));

/** The findings proper — everything that is not a coverage line. */
const findings = (row: AuditRow, checks: AuditChecks) =>
  computeAuditIssues(row, checks).filter((i) => i.severity !== 'offline');

/** The folder checks a SharePoint reader would run; none exists yet. */
const FOLDER_IDS = ['so-missing', 'before-images', 'after-images', 'labels', 'sp-inaccessible', 'sp-empty'];

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

  it('a finished WO lands in the grey-flag queue, oldest first', () => {
    const items = Array.from({ length: 10 }, (_, i) => wo(`d${i}`, 'done/incurred', 'done', 30 - i));
    const { queue } = deriveReceivables(items, []);
    expect(queue).toHaveLength(10);
    expect(queue.every((r) => r.wo.status.group === 'done')).toBe(true);
    expect(queue[0].wo.id).toBe('d0');
  });

  it('closed WOs never enter the audit queue — and nothing is invented for them', () => {
    const items = Array.from({ length: 6 }, (_, i) => wo(`c${i}`, 'invoiced', 'closed'));
    const { queue } = deriveReceivables(items, []);
    expect(queue).toEqual([]);
  });

  it('the queue is never padded from active work', () => {
    const items = [wo('d1', 'done/incurred', 'done'), ...Array.from({ length: 5 }, (_, i) => wo(`a${i}`, 'open', 'active'))];
    expect(deriveReceivables(items, []).queue.map((r) => r.wo.id)).toEqual(['d1']);
  });

  it('the quote on file is read off the quotes list, and only off it', () => {
    const items = [wo('d1', 'done/incurred', 'done'), wo('d2', 'done/incurred', 'done')];
    const { queue } = deriveReceivables(items, [quoteFor('d1')]);
    expect(queue.find((r) => r.wo.id === 'd1')?.hasClientQuote).toBe(true);
    expect(queue.find((r) => r.wo.id === 'd2')?.hasClientQuote).toBe(false);
  });

  it('a quotes list that did not come back, or came back full, leaves the quote unknown', () => {
    const items = [wo('d1', 'done/incurred', 'done')];
    expect(deriveReceivables(items, null).queue[0].hasClientQuote).toBeNull();
    const full = Array.from({ length: QUOTES_LIST_CAP }, (_, i) => quoteFor(`elsewhere-${i}`));
    expect(deriveReceivables(items, full).queue[0].hasClientQuote).toBeNull();
    expect(deriveReceivables(items, [...full, quoteFor('d1')]).queue[0].hasClientQuote).toBe(true);
  });
});

// ── 2. The grey-flag audit: a fully-evidenced WO ─────────────────────────────

describe('grey flag: a complete WO audits clean', () => {
  it('raises no finding when every tracked check passes and the gate is ticked', () => {
    expect(findings(cleanRow(), GATE_OPEN)).toEqual([]);
    // The only line left is coverage: the folder checks have no reader.
    expect(ids(cleanRow(), GATE_OPEN)).toEqual(['sp-offline']);
  });

  it('overall status is clean', () => {
    expect(overallStatus(computeAuditIssues(cleanRow(), GATE_OPEN))).toBe('clean');
  });
});

// ── 3. Each individual check, isolated ───────────────────────────────────────

describe('grey flag: individual audit rules', () => {
  it('CICO not Checked-out is MINOR', () => {
    const issues = findings(cleanRow({ cico: 'RTN' }), GATE_OPEN);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('minor');
    expect(overallStatus(issues)).toBe('minor');
  });

  it('a Done WO with no visit recorded at all is MINOR — tracked, and empty', () => {
    const issues = findings(cleanRow({ cico: '' }), GATE_OPEN);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('minor');
    expect(issues[0].title).toBe('CICO is empty — no visit recorded');
    expect(ids(cleanRow({ cico: '' }), GATE_OPEN)).not.toContain('cico-offline');
  });

  it('missing client quote is MAJOR — it blocks the audit', () => {
    const issues = findings(cleanRow({ hasClientQuote: false }), GATE_OPEN);
    expect(issues[0].severity).toBe('major');
    expect(overallStatus(issues)).toBe('major');
  });

  it('a quote the list could not reach is coverage, never a finding', () => {
    expect(findings(cleanRow({ hasClientQuote: null }), GATE_OPEN)).toEqual([]);
    expect(ids(cleanRow({ hasClientQuote: null }), GATE_OPEN)).toContain('client-quote-offline');
    expect(ids(cleanRow({ hasClientQuote: null }), GATE_OPEN)).not.toContain('client-quote');
    expect(overallStatus(computeAuditIssues(cleanRow({ hasClientQuote: null }), GATE_OPEN))).toBe('clean');
  });

  it('CO# is validated only when populated, and must be exactly 6 digits', () => {
    expect(findings(cleanRow({ coNumber: null }), GATE_OPEN)).toEqual([]);
    expect(ids(cleanRow({ coNumber: null }), GATE_OPEN)).toContain('co-offline');
    expect(ids(cleanRow({ coNumber: '12345' }), GATE_OPEN)).toContain('co');
    expect(ids(cleanRow({ coNumber: '1234567' }), GATE_OPEN)).toContain('co');
    expect(ids(cleanRow({ coNumber: '12a456' }), GATE_OPEN)).toContain('co');
    expect(findings(cleanRow({ coNumber: '123456' }), GATE_OPEN)).toEqual([]);
  });

  it('a fact The One does not carry is a coverage line, never a finding', () => {
    const row = cleanRow({ cico: null, bfi: null, coNumber: null, hasClientQuote: null });
    const got = ids(row, GATE_OPEN);
    for (const expected of ['cico-offline', 'bfi-offline', 'co-offline', 'client-quote-offline', 'sp-offline']) {
      expect(got, `missing "${expected}"`).toContain(expected);
    }
    expect(findings(row, GATE_OPEN)).toEqual([]);
    expect(overallStatus(computeAuditIssues(row, GATE_OPEN))).toBe('clean');
  });
});

// ── 4. BFI — the rule Jordan set for rejected proposals ──────────────────────

describe('grey flag: BFI waives after-images', () => {
  it('after-images are a folder check: never raised until a reader exists, BFI or not', () => {
    // Bill For Incurred: the proposed work never happened, so there is no
    // "after" to photograph. Only the incurred diagnostic visit bills. With no
    // folder reader the check is offline either way — a waiver cannot be
    // read off facts that are not there.
    for (const bfi of [true, false, null]) {
      const got = ids(cleanRow({ bfi }), GATE_OPEN);
      expect(got).not.toContain('after-images');
      expect(overallStatus(computeAuditIssues(cleanRow({ bfi }), GATE_OPEN))).toBe('clean');
    }
  });

  it('an unknown BFI is reported as coverage, not as a tick', () => {
    expect(ids(cleanRow({ bfi: null }), GATE_OPEN)).toContain('bfi-offline');
    expect(ids(cleanRow({ bfi: false }), GATE_OPEN)).not.toContain('bfi-offline');
  });
});

// ── 5. SharePoint coverage: offline must not read as a pass ─────────────────

describe('grey flag: SharePoint coverage', () => {
  it('offline is reported, but never colors the overall status', () => {
    const issues = computeAuditIssues(cleanRow(), GATE_OPEN);
    expect(issues.map((i) => i.severity)).toContain('offline');
    // Coverage gap, not a WO defect — the WO is not "clean-because-unchecked".
    expect(overallStatus(issues)).toBe('clean');
    expect(summarizeIssues(issues).offline).toBe(1);
  });

  it('offline SKIPS the folder checks rather than passing or failing them', () => {
    const got = ids(cleanRow(), GATE_OPEN);
    expect(got).toContain('sp-offline');
    for (const folder of FOLDER_IDS) expect(got).not.toContain(folder);
  });
});

// ── 6. The release gate that lifts the grey flag ────────────────────────────

describe('grey flag: the release gate', () => {
  it('an unticked gate raises an INFO issue, not a blocking one', () => {
    const issues = findings(cleanRow(), GATE_SHUT);
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
    expect(only(true, true)).not.toContain('gate');
  });

  it('GTG and Elise are triage marks and do NOT gate release', () => {
    const issues = findings(cleanRow(), {
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
    expect(s.offline).toBe(1);
    expect(overallStatus(computeAuditIssues(row, GATE_SHUT))).toBe('major');
  });

  it('a worst-case WO reports every failure at once rather than stopping at the first', () => {
    const row = cleanRow({ cico: 'RTN', hasClientQuote: false, coNumber: 'XX', bfi: false });
    const got = ids(row, GATE_SHUT);
    for (const expected of ['cico', 'client-quote', 'co', 'gate', 'sp-offline']) {
      expect(got, `missing "${expected}"`).toContain(expected);
    }
    // And still nothing the engine cannot see.
    for (const folder of FOLDER_IDS) expect(got).not.toContain(folder);
  });
});

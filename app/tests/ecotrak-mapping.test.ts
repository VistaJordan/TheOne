/* Ecotrak mapping — verified against the 232 production work orders read
 * 2026-08-19 (GET only). These tests encode what production ACTUALLY contains,
 * so a vocabulary drift on Ecotrak's side fails here rather than silently
 * mis-filing live work orders the way the current sync does. */

import { describe, it, expect } from 'vitest';
import {
  ECOTRAK_INBOUND,
  ECOTRAK_OUTBOUND,
  ECOTRAK_WRITABLE,
  classifyInbound,
  isWritable,
  type Canonical,
} from '../apps/api/src/modules/integrations/ecotrak/statusMap';
import {
  TRADE_MAP,
  GENERAL_TRADES,
  resolveTrade,
  unconfirmedTrades,
  subtradesOf,
  volumeByGeneral,
  tradeLabel,
} from '../apps/api/src/modules/integrations/ecotrak/tradeMap';
import {
  planFolder,
  woFolderName,
  clientFolderName,
  sanitizeFolderName,
  stateAbbr,
  baseFolderPath,
  encodeGraphPath,
} from '../apps/api/src/modules/integrations/ecotrak/sharepointPath';
import { mapPriority } from '../apps/api/src/modules/integrations/ecotrak/ingest';

/** Statuses observed in the production read, with counts. Sums to 232. */
const PRODUCTION_STATUSES: Record<string, number> = {
  COMPLETED: 130,
  SOFT_COMPLETED: 21,
  PROPOSAL_APPROVED: 20,
  PROPOSAL_SUBMITTED: 17,
  CANCELLED: 10,
  SUBMITTING_PROPOSAL: 9,
  RETURN_VISIT_REQUIRED: 8,
  ACCEPTED: 8,
  ARRIVED: 4,
  PENDING_PARTS: 2,
  PROPOSAL_REJECTED: 2,
  PENDING_SP_ACCEPTANCE: 1,
};

/** Trades observed in production, with counts. 29 distinct, sums to 232. */
const PRODUCTION_TRADES: Record<string, number> = {
  'HVAC': 58, 'Handyman': 56, 'Plumber': 27, 'Electrician': 16,
  'Windows and Storefront': 10, 'Refrigeration - Walk-in': 10, 'Painter': 10,
  'Door Repair': 8, 'Tile/Grout Repair': 7, 'MISC': 4, 'Safe / Locksmith': 3,
  'Refrigeration': 3, 'Internal': 2, 'Plumber - Water Heater': 2,
  'HVAC - Preventative Maintenance': 2, 'Cooking Equipment': 1, 'Tea Brewer': 1,
  'Appliance': 1, 'Landscaper': 1, 'Fire / Life / Safety Company': 1,
  'Signage Company': 1, 'Store Graphics': 1, 'HVAC Test and Balance': 1,
  'Roofing Company': 1, 'Parking Lot': 1, 'Janitorial': 1,
  'Flooring Contractor': 1, 'Door Key Program': 1, 'Locksmith': 1,
};

// ── Status coverage ─────────────────────────────────────────────────────────

describe('ecotrak statuses: production coverage', () => {
  it('every status seen in production is mapped', () => {
    for (const s of Object.keys(PRODUCTION_STATUSES)) {
      expect(ECOTRAK_INBOUND[s], `unmapped production status "${s}"`).toBeDefined();
    }
  });

  it('recorded counts match the production read', () => {
    for (const [s, n] of Object.entries(PRODUCTION_STATUSES)) {
      expect(ECOTRAK_INBOUND[s].seen, s).toBe(n);
    }
  });

  it('covers 100% of the 232 sampled work orders', () => {
    const total = Object.values(PRODUCTION_STATUSES).reduce((a, b) => a + b, 0);
    expect(total).toBe(232);
    const mapped = Object.keys(PRODUCTION_STATUSES)
      .filter((s) => ECOTRAK_INBOUND[s])
      .reduce((sum, s) => sum + PRODUCTION_STATUSES[s], 0);
    expect(mapped).toBe(232);
  });

  it('does NOT map Ecotrak UI labels that never appear on the wire', () => {
    // These came from the UI status picker, not the SP API. Mapping them would
    // encode vocabulary the integration can never actually receive.
    for (const ghost of [
      'completed pending review', 'rfp submitted', 'rma requested',
      'rma shipped', 'rma received', 'deferred', 'internal review',
    ]) {
      expect(classifyInbound(ghost), ghost).toBeNull();
    }
  });

  it('parks unknown values instead of defaulting them', () => {
    expect(classifyInbound('SOME_NEW_STATUS')).toBeNull();
    expect(classifyInbound('')).toBeNull();
  });
});

// ── Authority discipline ────────────────────────────────────────────────────

describe('ecotrak statuses: authority', () => {
  it('only facts the CLIENT owns are authoritative', () => {
    const authoritative = Object.entries(ECOTRAK_INBOUND)
      .filter(([, r]) => r.authority === 'authoritative')
      .map(([k]) => k)
      .sort();
    expect(authoritative).toEqual([
      'CANCELLED', 'PENDING_SP_ACCEPTANCE', 'PROPOSAL_APPROVED',
      'PROPOSAL_REJECTED', 'REJECTED',
    ]);
  });

  it('echoes of our own actions are advisory, never authoritative', () => {
    // If Ecotrak could overwrite dispatcher state from these, a stale poll
    // would fight the live board.
    for (const s of ['ACCEPTED', 'ENROUTE', 'ARRIVED', 'SOFT_COMPLETED', 'SUBMITTING_PROPOSAL']) {
      expect(ECOTRAK_INBOUND[s].authority, s).toBe('advisory');
    }
  });

  it('PROPOSAL_REJECTED carries the BFI rule', () => {
    const r = ECOTRAK_INBOUND.PROPOSAL_REJECTED;
    expect(r.canonical).toBe('completed');
    expect(r.authority).toBe('authoritative');
    expect(r.note).toContain('BFI');
  });
});

// ── Outbound is a lossy projection, not the inverse ─────────────────────────

describe('ecotrak statuses: outbound', () => {
  it('every canonical value has an explicit decision, including "never push"', () => {
    const canonicals: Canonical[] = [
      'received', 'assessing', 'quoting', 'awaiting_client', 'approved',
      'scheduled', 'in_progress', 'awaiting_parts', 'completed', 'invoiced',
      'declined', 'cancelled', 'on_hold',
    ];
    for (const c of canonicals) {
      expect(Object.prototype.hasOwnProperty.call(ECOTRAK_OUTBOUND, c), c).toBe(true);
    }
  });

  it('never emits a status Ecotrak would reject', () => {
    for (const [canonical, wire] of Object.entries(ECOTRAK_OUTBOUND)) {
      if (wire !== null) expect(isWritable(wire), `${canonical} -> ${wire}`).toBe(true);
    }
  });

  it('internal-only canonicals emit nothing', () => {
    for (const c of ['assessing', 'awaiting_client', 'approved', 'scheduled', 'invoiced', 'on_hold'] as Canonical[]) {
      expect(ECOTRAK_OUTBOUND[c], c).toBeNull();
    }
  });

  it('is NOT the inverse of inbound — the collapse is deliberate and lossy', () => {
    // Three inbound statuses map to canonical 'completed'; outbound picks one.
    const toCompleted = Object.entries(ECOTRAK_INBOUND)
      .filter(([, r]) => r.canonical === 'completed')
      .map(([k]) => k);
    expect(toCompleted.length).toBeGreaterThan(1);
    expect(ECOTRAK_OUTBOUND.completed).toBe('SOFT_COMPLETED');
  });

  it('cancelled routes out via REJECTED — CANCELLED is not writable', () => {
    expect(isWritable('CANCELLED')).toBe(false);
    expect(ECOTRAK_OUTBOUND.cancelled).toBe('REJECTED');
  });

  it('the writable set is exactly the 9 Ecotrak documents', () => {
    expect([...ECOTRAK_WRITABLE].sort()).toEqual([
      'ACCEPTED', 'ARRIVED', 'ENROUTE', 'NOT_FIXED', 'PENDING_PARTS',
      'REJECTED', 'RETURN_VISIT_REQUIRED', 'SOFT_COMPLETED', 'SUBMITTING_PROPOSAL',
    ]);
  });
});

// ── Trades: the live 30% mis-classification ─────────────────────────────────

describe('ecotrak trades: production coverage', () => {
  it('resolves every one of the 29 production trades', () => {
    const missed = Object.keys(PRODUCTION_TRADES).filter((t) => resolveTrade(t) === null);
    expect(missed, `unresolved: ${missed.join(', ')}`).toEqual([]);
  });

  it('covers 100% of the 232 sampled work orders', () => {
    const total = Object.values(PRODUCTION_TRADES).reduce((a, b) => a + b, 0);
    expect(total).toBe(232);
    const covered = Object.entries(PRODUCTION_TRADES)
      .filter(([t]) => resolveTrade(t) !== null)
      .reduce((sum, [, n]) => sum + n, 0);
    expect(covered).toBe(232);
  });

  it('fixes the walk-in refrigeration mis-classification in the live sync', () => {
    // 10 WOs become "Handyman" today. Walk-in is refrigeration work.
    const r = resolveTrade('Refrigeration - Walk-in');
    expect(r?.general).toBe('Refrigeration');
    expect(r?.sub).toBe('Walk-in');
  });

  it('every general trade is one of the five', () => {
    for (const [src, rule] of Object.entries(TRADE_MAP)) {
      expect(GENERAL_TRADES, `${src} -> ${rule.general}`).toContain(rule.general);
    }
  });

  it('matches case- and whitespace-insensitively (production has trailing spaces)', () => {
    expect(resolveTrade('  HVAC  ')?.general).toBe('HVAC');
    expect(resolveTrade('hvac')?.general).toBe('HVAC');
    expect(resolveTrade('PLUMBER')?.general).toBe('Plumbing');
  });

  it('returns null for unknown trades rather than defaulting to Handyman', () => {
    // The silent Handyman fallback is the current 30% bug. Callers must decide.
    expect(resolveTrade('Nuclear Technician')).toBeNull();
    expect(resolveTrade(null)).toBeNull();
    expect(resolveTrade('')).toBeNull();
  });

  it('flags the judgement calls that still need an ops decision', () => {
    const pending = unconfirmedTrades();
    expect(pending).toContain('Windows and Storefront');
    expect(pending).toContain('Painter');
    // Highest-volume unconfirmed first, so the ops review is ordered by impact.
    expect(pending[0]).toBe('Windows and Storefront');
  });
});

// ── The two-level hierarchy ─────────────────────────────────────────────────

describe('trades: general + subtrade hierarchy', () => {
  it('has exactly the five general trades', () => {
    expect([...GENERAL_TRADES]).toEqual([
      'Handyman', 'Electric', 'Plumbing', 'HVAC', 'Refrigeration',
    ]);
  });

  it('every production WO lands under a general trade — 232 accounted for', () => {
    const v = volumeByGeneral();
    expect(v.HVAC).toBe(61);
    expect(v.Handyman).toBe(113);
    expect(v.Plumbing).toBe(29);
    expect(v.Electric).toBe(16);
    expect(v.Refrigeration).toBe(13);
    expect(Object.values(v).reduce((a, b) => a + b, 0)).toBe(232);
  });

  it('keeps the detail that changes who you dispatch', () => {
    expect(subtradesOf('Refrigeration')).toEqual(['Walk-in']);
    expect(subtradesOf('Plumbing')).toEqual(['Water Heater']);
    expect(subtradesOf('HVAC')).toEqual(['Preventative Maintenance', 'Test and Balance']);
    expect(subtradesOf('Electric')).toEqual([]); // no detail in production yet
  });

  it('collapses variants onto one subtrade', () => {
    // Three Ecotrak strings, one dispatch reality.
    for (const s of ['Safe / Locksmith', 'Locksmith', 'Door Key Program']) {
      expect(resolveTrade(s)?.sub, s).toBe('Locksmith');
    }
    for (const s of ['Cooking Equipment', 'Tea Brewer', 'Appliance']) {
      expect(resolveTrade(s)?.sub, s).toBe('Appliance');
    }
  });

  it('renders a single display label', () => {
    expect(tradeLabel(resolveTrade('Refrigeration - Walk-in')!)).toBe('Refrigeration / Walk-in');
    expect(tradeLabel(resolveTrade('HVAC')!)).toBe('HVAC');
  });
});

// ── SharePoint folder naming ────────────────────────────────────────────────

describe('sharepoint: folder naming matches the live tree', () => {
  const wo = {
    id: 6339414,
    work_order_id: null,
    customer: { customer_name: 'Flynn Restaurant Group' },
    location: { city: 'Phoenix', state: 'Arizona' },
  };

  it('builds the documented WO folder name', () => {
    expect(woFolderName(wo)).toBe('WO#6339414, Phoenix, AZ');
  });

  it('falls back to the Ecotrak id — work_order_id is null on 100% of production', () => {
    expect(woFolderName({ ...wo, work_order_id: null })).toContain('WO#6339414');
    expect(woFolderName({ ...wo, work_order_id: 90210 })).toContain('WO#90210');
  });

  it('drops missing city/state rather than rendering blanks', () => {
    expect(woFolderName({ id: 1, location: { city: null, state: null } })).toBe('WO#1');
    expect(woFolderName({ id: 2, location: { city: 'Tulsa', state: null } })).toBe('WO#2, Tulsa');
  });

  it('abbreviates state names and passes through existing abbreviations', () => {
    expect(stateAbbr('Indiana')).toBe('IN');
    expect(stateAbbr('north carolina')).toBe('NC');
    expect(stateAbbr('AZ')).toBe('AZ');
    expect(stateAbbr('Freedonia')).toBeNull();
  });

  it('resolves client aliases to the folders that already exist', () => {
    expect(clientFolderName(wo)).toBe('Flynn');
    // Ecotrak sends U+2019; the live folder uses a straight apostrophe.
    expect(clientFolderName({ id: 1, customer: { customer_name: 'Mimi’s Cafe' } })).toBe("Mimi's Cafe");
    expect(clientFolderName({ id: 1, customer: { customer_name: 'Green Thumb Industries (GTI)' } }))
      .toBe('Green Thumb Industries');
    // Unaliased customers pass through unchanged.
    expect(clientFolderName({ id: 1, customer: { customer_name: 'MOD Pizza' } })).toBe('MOD Pizza');
  });

  it('strips characters SharePoint rejects', () => {
    expect(sanitizeFolderName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j');
    expect(sanitizeFolderName('trailing dots...')).toBe('trailing dots');
    expect(sanitizeFolderName('  spaced   out  ')).toBe('spaced out');
  });

  it('rolls the base path over by year', () => {
    expect(baseFolderPath(2026)).toBe('General/Work Orders - 2026/2026 - SFM');
    expect(baseFolderPath(2027)).toBe('General/Work Orders - 2027/2027 - SFM');
  });

  it('assembles the full path', () => {
    expect(planFolder(wo, 2026).fullPath)
      .toBe('General/Work Orders - 2026/2026 - SFM/Flynn/WO#6339414, Phoenix, AZ');
  });

  it('REFUSES to guess an unknown client — that would fork the live tree', () => {
    expect(() => planFolder({ id: 7, location: { city: 'Tulsa', state: 'OK' } }, 2026))
      .toThrow(/no customer name/);
  });

  it('encodes # and & per segment while keeping / as the separator', () => {
    const enc = encodeGraphPath('General/Work Orders - 2026/Flynn/WO#123, Phoenix, AZ');
    expect(enc).toContain('WO%23123');
    expect(enc.split('/')).toHaveLength(4);
    expect(encodeGraphPath('a/B & C/d')).toContain('%26');
  });
});

// ── Priority: two schemes coexist in production ─────────────────────────────

describe('ecotrak priority: L-scheme and P-scheme', () => {
  it('maps the L-scheme across its full range, not just L1-L4', () => {
    // The legacy field-mapping proposal only anticipated L1-L4. Production
    // carries L5 (39 WOs), L6 (13), L7 (15) and L8 (1) as well — 68 records
    // that a four-value map would drop on the floor.
    expect(mapPriority('L1 - Emergency')).toBe('urgent');
    expect(mapPriority('L2 - Same Day')).toBe('high');
    expect(mapPriority('L3 - 24 Hours')).toBe('normal');
    for (const p of ['L4 - 48 Hours', 'L5 - One Week', 'L6 - Two Weeks', 'L7 - 30 Days', 'L8 - Low Priority']) {
      expect(mapPriority(p), p).toBe('low');
    }
  });

  it('maps the P-scheme — 36 of 232 production WOs use it', () => {
    expect(mapPriority('P2 - Urgent - 8-24 hours')).toBe('normal');
    for (const p of ['P3 - Normal - 48 hours', 'P4 - Small Project', 'P5 - Large Project', 'P7 - Scheduled Maintenance ']) {
      expect(mapPriority(p), p).toBe('low');
    }
  });

  it('tolerates the trailing space production actually sends', () => {
    // "P7 - Scheduled Maintenance " ships with a trailing space.
    expect(mapPriority('P7 - Scheduled Maintenance ')).toBe('low');
    expect(mapPriority('  L1 - Emergency  ')).toBe('urgent');
  });

  it('returns null for an unknown scheme rather than guessing', () => {
    expect(mapPriority('X9 - Something New')).toBeNull();
    expect(mapPriority(null)).toBeNull();
    expect(mapPriority('')).toBeNull();
  });

  it('only L1 is urgent — emergency is a priority, not a status', () => {
    const urgent = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'P2', 'P3', 'P4', 'P5', 'P7']
      .filter((c) => mapPriority(`${c} - x`) === 'urgent');
    expect(urgent).toEqual(['L1']);
  });
});

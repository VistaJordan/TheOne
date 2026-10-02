// 0060 — the pure rules of the portfolio: what may sit under what, how the
// flat list of locations becomes a tree, and how a warranty reads against a day.
import { describe, expect, it } from 'vitest';
import {
  WARRANTY_SOON_DAYS,
  allowedParentKinds,
  canNestUnder,
  flattenLocations,
  locationPath,
  locationTree,
  portfolioPermNodes,
  warrantyState,
} from '@theone/shared';
import type { SiteLocation } from '@theone/shared';

const loc = (id: string, kind: SiteLocation['kind'], name: string, parent_id: string | null = null, extra: Partial<SiteLocation> = {}): SiteLocation => ({
  id, kind, name, parent_id, level: null, space_type: null, area_sqft: null, notes: null, position: 0, assets: 0, ...extra,
});

describe('what may sit under what', () => {
  it('a building is on the site, a floor in a building, a space anywhere', () => {
    expect(allowedParentKinds('building')).toEqual([null]);
    expect(allowedParentKinds('floor')).toEqual(['building']);
    expect(canNestUnder('space', 'floor')).toBe(true);
    expect(canNestUnder('space', 'building')).toBe(true);
    expect(canNestUnder('space', null)).toBe(true);
  });

  it('refuses the nestings that make no sense', () => {
    expect(canNestUnder('building', 'building')).toBe(false);
    expect(canNestUnder('floor', null)).toBe(false);
    expect(canNestUnder('floor', 'floor')).toBe(false);
    expect(canNestUnder('space', 'space')).toBe(false);
    expect(canNestUnder('building', 'space')).toBe(false);
  });
});

describe('the location tree', () => {
  const rows = [
    loc('k', 'space', 'Kitchen', 'f0'),
    loc('f0', 'floor', 'Ground floor', 'b', { level: 0 }),
    loc('lot', 'space', 'Parking lot'),
    loc('f1', 'floor', 'Floor 2', 'b', { level: 1 }),
    loc('b', 'building', 'Main building'),
    loc('d', 'space', 'Dining room', 'f0'),
    loc('roof', 'space', 'Roof', 'b'),
  ];

  it('nests by parent and reads buildings, then floors top-down, then spaces by name', () => {
    const flat = flattenLocations(locationTree(rows));
    expect(flat.map((n) => `${n.depth}:${n.name}`)).toEqual([
      '0:Main building', '1:Floor 2', '1:Ground floor', '2:Dining room', '2:Kitchen', '1:Roof', '0:Parking lot',
    ]);
  });

  it('keeps a row whose parent is gone, at the top, rather than losing it', () => {
    const tree = locationTree([loc('x', 'space', 'Orphan', 'missing')]);
    expect(tree).toHaveLength(1);
    expect(tree[0].depth).toBe(0);
  });

  it('sorts numbered names as numbers', () => {
    const flat = flattenLocations(locationTree([loc('a', 'space', 'Bay 10'), loc('b', 'space', 'Bay 2')]));
    expect(flat.map((n) => n.name)).toEqual(['Bay 2', 'Bay 10']);
  });

  it('spells the path to a place', () => {
    expect(locationPath(rows, 'k')).toBe('Main building › Ground floor › Kitchen');
    expect(locationPath(rows, 'lot')).toBe('Parking lot');
    expect(locationPath(rows, null)).toBe('');
    expect(locationPath(rows, 'nope')).toBe('');
  });

  it('survives a loop in the data without hanging', () => {
    const loop = [loc('a', 'space', 'A', 'b'), loc('b', 'space', 'B', 'a')];
    expect(locationPath(loop, 'a').split(' › ').length).toBeLessThanOrEqual(10);
  });
});

describe('warranty against today', () => {
  const today = '2026-10-02';
  it('has four states', () => {
    expect(warrantyState(null, today)).toBe('none');
    expect(warrantyState('', today)).toBe('none');
    expect(warrantyState('2026-10-01', today)).toBe('expired');
    expect(warrantyState('2027-06-01', today)).toBe('active');
  });

  it('the last day is still under warranty, and "soon" is the last 60 days', () => {
    expect(warrantyState(today, today)).toBe('expiring');
    expect(WARRANTY_SOON_DAYS).toBe(60);
    expect(warrantyState('2026-12-01', today)).toBe('expiring'); // exactly 60 days out
    expect(warrantyState('2026-12-02', today)).toBe('active');
  });
});

describe('permissions', () => {
  it('offers sites, assets and clients as rows with the four record actions', () => {
    const nodes = portfolioPermNodes();
    expect(nodes.map((n) => n.key)).toEqual(['sites', 'assets', 'clients']);
    expect(nodes[1].children?.map((c) => c.key)).toEqual(['assets/requests']);
    for (const n of nodes) expect(n.actions).toEqual(['view', 'create', 'edit', 'delete']);
  });
});

// 0062 — what an asset management request needs before it can be raised.
import { assetRequestProblem, SOURCE_FIELDS, WIDGET_SOURCES } from '@theone/shared';

describe('asset requests', () => {
  it('an add names its site and the asset; every request says why', () => {
    expect(assetRequestProblem({ type: 'add', reason: 'x', proposed: { name: 'Ice machine' } })).toMatch(/site/);
    expect(assetRequestProblem({ type: 'add', site_id: 's', reason: 'x', proposed: {} })).toMatch(/Name/);
    expect(assetRequestProblem({ type: 'add', site_id: 's', reason: '  ', proposed: { name: 'Ice machine' } })).toMatch(/why/);
    expect(assetRequestProblem({ type: 'add', site_id: 's', reason: 'found on site', proposed: { name: 'Ice machine' } })).toBeNull();
  });

  it('replace, retire and move are about an asset', () => {
    expect(assetRequestProblem({ type: 'retire', reason: 'scrapped' })).toMatch(/which asset/);
    expect(assetRequestProblem({ type: 'retire', asset_id: 'a', reason: 'scrapped' })).toBeNull();
    expect(assetRequestProblem({ type: 'replace', asset_id: 'a', reason: 'failed', proposed: {} })).toMatch(/replacement/);
    expect(assetRequestProblem({ type: 'replace', asset_id: 'a', reason: 'failed', proposed: { name: 'New unit' } })).toBeNull();
    expect(assetRequestProblem({ type: 'move', asset_id: 'a', reason: 'remodel' })).toMatch(/where/);
    expect(assetRequestProblem({ type: 'move', asset_id: 'a', reason: 'remodel', site_id: 's' })).toBeNull();
    expect(assetRequestProblem({ type: 'move', asset_id: 'a', reason: 'remodel', proposed: { location_id: 'l' } })).toBeNull();
  });
});

describe('sites and assets as dashboard sources', () => {
  it('both are sources with something to count by, total and run along', () => {
    for (const s of ['sites', 'assets'] as const) {
      expect(WIDGET_SOURCES).toContain(s);
      expect(new Set(SOURCE_FIELDS[s].map((f) => f.type))).toEqual(new Set(['text', 'number', 'date']));
    }
  });
});

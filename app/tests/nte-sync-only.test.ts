/*
 * The Client NTE follows Ecotrak once "Ecotrak → OBI" is on (Elise, 2026-11-16).
 *
 * A work order linked to Ecotrak takes its NTE from the sync only: the field
 * editor, automations, bulk edit, the client's approval of a quote and NTE
 * increase requests leave it alone. Source pins plus the pure rule; the suite
 * opens no database.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NTE_SYNCED_CODE, NTE_SYNCED_MESSAGE, nteFollowsPortal } from '../packages/shared/src/nteSync';

const APP = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(APP, ...p), 'utf8');
const svc = (f: string) => read('apps', 'api', 'src', 'services', f);

describe('the NTE follows the portal', () => {
  it('only a linked work order with the sync on', () => {
    expect(nteFollowsPortal(true, true)).toBe(true);
    expect(nteFollowsPortal(true, false)).toBe(false);
    expect(nteFollowsPortal(false, true)).toBe(false);
    expect(NTE_SYNCED_CODE).toBe('NTE_SYNCED');
    expect(NTE_SYNCED_MESSAGE).toMatch(/Ecotrak/);
  });

  it('asks the switch from the table and the Ecotrak link', () => {
    const s = svc('nteSync.ts');
    expect(s).toMatch(/integrationOnNow\('ecotrak'\)/);
    expect(s).toMatch(/FROM cmms_wo_link l\s+JOIN cmms_connection c ON c\.id = l\.connection_id\s+WHERE c\.provider = 'ecotrak'/);
  });

  it('refuses hand, rule and bulk writes', () => {
    expect(svc('woFieldValues.ts')).toMatch(/await assertNteNotSynced\(\[task\.id\], patch\.map\(\(p\) => p\.jsonKey\), tx\)/);
    expect(svc('woBulk.ts')).toMatch(/assertNteNotSynced\(rows\.rows\.map\(\(r\) => r\.id\), customPatch\.map\(\(c\) => c\.key\), undefined, patch\.nte !== undefined\)/);
  });

  it("the client's approval of a quote leaves a synced NTE alone", () => {
    const q = svc('quotes.ts');
    const fn = q.slice(q.indexOf('async function setNteFromApproval'));
    expect(fn.indexOf('isNteSynced(taskId)')).toBeGreaterThan(-1);
    expect(fn.indexOf('isNteSynced(taskId)')).toBeLessThan(fn.indexOf('updateWorkOrderFields'));
  });

  it('NTE increase requests are refused (asked and approved)', () => {
    const r = svc('woRecord.ts');
    const ask = r.slice(r.indexOf('export async function requestNteIncrease'), r.indexOf('INSERT INTO wo_nte_request'));
    expect(ask).toMatch(/await refuseIfNteSynced\(taskId\)/);
    const decide = r.slice(r.indexOf('export async function decideNteIncrease'));
    expect(decide.indexOf('refuseIfNteSynced(taskId)')).toBeLessThan(decide.indexOf('UPDATE wo_nte_request SET status'));
  });

  it('the screens draw it read-only and hide Request NTE increase', () => {
    expect(svc('workOrders.ts')).toMatch(/nte_synced: await isNteSynced\(r\.id\)/);
    const web = (...p: string[]) => read('apps', 'web', 'src', ...p);
    expect(web('components', 'wo', 'fieldEdit.tsx')).toMatch(/wo\.nte_synced === true && fieldKey === `fields\.\$\{FIELD\.nte\}`/);
    expect(web('components', 'wo', 'AllFieldsPanel.tsx')).toMatch(/wo\.nte_synced === true && f\.key === `fields\.\$\{FIELD\.nte\}`/);
    expect(web('pages', 'QuoteBuilderPage.tsx')).toMatch(/woQuery\.data\?\.nte_synced !== true && \(\s*<NteIncreaseButton/);
  });
});

/* 0070 — sign-off sheets. The pure halves: which layout a work order gets,
 * the text a technician receives, and the renderer — every layout must come
 * out as exactly ONE page (the Paperform sheets had a blank second page and
 * BKR's signature on its own page; that is what this replaces). The
 * database half (services/signoff.ts) and Quo's API are exercised against
 * the live site. */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  SIGNOFF_LAYOUTS,
  signoffLayoutFor,
  signoffMessageText,
  signoffPublicPath,
  SIGNOFF_TOKEN_RE,
} from '../packages/shared/src/signoff';
import { renderSignoffSheet, safeText } from '../apps/api/src/lib/signoffPdf';

describe('signoffLayoutFor', () => {
  it('maps each Comp to its sheet, BKR by client', () => {
    expect(signoffLayoutFor('SFM', 'FrontStreet')).toBe('sfm');
    expect(signoffLayoutFor('tpm', null)).toBe('tpm');
    expect(signoffLayoutFor('AF', null)).toBe('af');
    expect(signoffLayoutFor('RF', null)).toBe('rf');
    expect(signoffLayoutFor('EDS', null)).toBe('eds');
    expect(signoffLayoutFor('BKR', 'HFS')).toBe('bkr');
    expect(signoffLayoutFor('BKR', 'EMCOR')).toBe('bkr_emcor');
    expect(signoffLayoutFor('BKR', 'Emcor Facilities')).toBe('bkr_emcor');
  });
  it('has no sheet for an unset or unknown entity', () => {
    expect(signoffLayoutFor(null, 'EMCOR')).toBeNull();
    expect(signoffLayoutFor('', null)).toBeNull();
    expect(signoffLayoutFor('XYZ', null)).toBeNull();
  });
});

describe('signoffMessageText', () => {
  it('names the entity, the number, the address and the link, under Quo\'s cap', () => {
    const t = signoffMessageText('Seamless Facility Management', '7886797', '7218 E. Hillsborough Ave, Tampa, FL 33610', 'https://x.test/api/public/signoff/abc');
    expect(t).toContain('7886797');
    expect(t).toContain('Tampa');
    expect(t.endsWith('https://x.test/api/public/signoff/abc')).toBe(true);
    expect(t.length).toBeLessThan(1600);
  });
  it('copes without an address', () => {
    expect(signoffMessageText('Alpha Fixers', 'R1', null, 'https://x')).not.toContain(' at ');
  });
  it('the public path is what the auth guard allowlists', () => {
    const token = 'A'.repeat(32);
    expect(SIGNOFF_TOKEN_RE.test(token)).toBe(true);
    expect(signoffPublicPath(token)).toMatch(/^\/api\/public\/signoff\/[A-Za-z0-9_-]{32}$/);
    expect(SIGNOFF_TOKEN_RE.test('A'.repeat(31))).toBe(false);
  });
});

describe('safeText', () => {
  it('keeps Latin-1, folds the rest to something the standard fonts can draw', () => {
    expect(safeText('Café — “quoted” ’s')).toBe('Cafe - "quoted" \'s');
    expect(safeText('北京 Store')).toBe('?? Store');
    expect(safeText('  a   b  ')).toBe('a b');
    expect(safeText(null)).toBe('');
  });
});

describe('renderSignoffSheet', () => {
  for (const layout of SIGNOFF_LAYOUTS) {
    it(`${layout}: one US-Letter page`, async () => {
      const bytes = await renderSignoffSheet({
        layout,
        wo_ref: 'WOFM0000127312',
        address: '208 North Park Road Unit 1, Wyomissing, PA 19610-2908, USA — Suite «B»',
      });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect([Math.round(width), Math.round(height)]).toEqual([612, 792]);
    });
  }
  it('survives a missing address and a very long one', async () => {
    const short = await renderSignoffSheet({ layout: 'bkr_emcor', wo_ref: '1084899-00000007', address: null });
    expect((await PDFDocument.load(short)).getPageCount()).toBe(1);
    const long = await renderSignoffSheet({ layout: 'af', wo_ref: 'R1148243', address: 'x'.repeat(40).split('').join(' ').repeat(6) });
    expect((await PDFDocument.load(long)).getPageCount()).toBe(1);
  });
});

// ── Previous Assignees (kept by the system on reassignment) ──────────────────
import { departedAssignees, mergePreviousAssignees } from '../apps/api/src/services/assigneeHistory';

describe('Previous Assignees history', () => {
  it('names who left the seat, case-insensitively', () => {
    expect(departedAssignees('Elise Abdel Massih', 'Alan Tate')).toEqual(['Elise Abdel Massih']);
    expect(departedAssignees('Elise Abdel Massih, Alan Tate', 'alan tate')).toEqual(['Elise Abdel Massih']);
    expect(departedAssignees(null, 'Alan Tate')).toEqual([]);
    expect(departedAssignees('Alan Tate', null)).toEqual(['Alan Tate']);
  });
  it('appends once, keeps order, and is a no-op when nothing is new', () => {
    expect(mergePreviousAssignees(null, ['Elise Abdel Massih'])).toEqual({ before: null, after: 'Elise Abdel Massih' });
    expect(mergePreviousAssignees('Elise Abdel Massih', ['Alan Tate'])).toEqual({ before: 'Elise Abdel Massih', after: 'Elise Abdel Massih, Alan Tate' });
    expect(mergePreviousAssignees('Elise Abdel Massih', ['elise abdel massih'])).toBeNull();
  });
});

// 0116 · The sign-off sheet as a link (Elise, 2026-11-02): the entity's
// Paperform, prefilled as the team texted it before The One, beside the PDF.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SIGNOFF_FORM_URLS,
  SIGNOFF_LAYOUTS,
  signoffFormLink,
  signoffFormMessageText,
  signoffLayoutFor,
} from '../packages/shared/src/signoff';

const root = resolve(__dirname, '..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('the prefilled form link', () => {
  it('reproduces the link the team sent for BKR / EMCOR', () => {
    const layout = signoffLayoutFor('BKR', 'EMCOR Facilities');
    expect(signoffFormLink(layout, '1116794-00000003', '201 Market St, Rockland, MA 02370, USA')).toBe(
      'https://bkremcor.paperform.co/?ed9ra=1116794-00000003&bf7ou=201%20Market%20St%2C%20Rockland%2C%20MA%2002370%2C%20USA',
    );
  });
  it('picks the form by Comp, as the ClickUp tasks did', () => {
    const host = (comp: string, client = 'Walmart') => {
      const link = signoffFormLink(signoffLayoutFor(comp, client), 'WO1', null);
      return link ? new URL(link).host : null;
    };
    expect(host('SFM')).toBe('seamlessfm.paperform.co');
    expect(host('AF')).toBe('alphafixerssignoff.paperform.co');
    expect(host('TPM')).toBe('bf8xowiy.paperform.co');
    expect(host('RF')).toBe('repairfected.paperform.co');
    expect(host('BKR')).toBe('bkrform.paperform.co');
    expect(host('BKR', 'EMCOR')).toBe('bkremcor.paperform.co');
    // EDS never had a form; no Comp, no form.
    expect(host('EDS')).toBeNull();
    expect(signoffFormLink(null, 'WO1', null)).toBeNull();
  });
  it('needs a WO number; the address is left off when blank', () => {
    expect(signoffFormLink('sfm', '  ', 'x')).toBeNull();
    expect(signoffFormLink('sfm', 'ABC 1', '  ')).toBe('https://seamlessfm.paperform.co/?ed9ra=ABC%201');
  });
  it('every layout is listed, and the text carries the link', () => {
    for (const l of SIGNOFF_LAYOUTS) expect(l in SIGNOFF_FORM_URLS).toBe(true);
    const text = signoffFormMessageText('Alpha Fixers', 'WO1', '1 Main St', 'https://x.paperform.co/?ed9ra=WO1');
    expect(text).toContain('https://x.paperform.co/?ed9ra=WO1');
    expect(text.length).toBeLessThan(1600);
  });
});

describe('Send to tech: link or PDF', () => {
  it('a link share needs no sheet, and is never matched to a texted reply', () => {
    const sql = read('packages/db/migrations/0116_signoff_form_link.sql');
    expect(sql).toMatch(/ALTER COLUMN signoff_id DROP NOT NULL/);
    expect(sql).toMatch(/CHECK \(kind = 'link' OR signoff_id IS NOT NULL\)/);
    const svc = read('apps/api/src/services/signoff.ts');
    // Reply matching joins the sheet, so a link share (no sheet) never matches.
    expect(svc).toMatch(/FROM wo_signoff_share s\s+JOIN wo_signoff g ON g\.id = s\.signoff_id/);
    expect(svc).toMatch(/SIGNOFF_NO_FORM/);
    expect(read('apps/api/src/routes/signoff.ts')).toMatch(/kind: z\.enum\(\['pdf', 'link'\]\)\.optional\(\)/);
  });
});

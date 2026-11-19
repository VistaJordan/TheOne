/* 0156 (Elise, 2026-11-17) — the sign-off sheet is a form. The manager signs
 * on the technician's phone (/signoff/<token>); Submit draws the signed PDF in
 * the entity's design and files it on the work order (Drive, approved) and in
 * SharePoint when that integration copies files. The pure halves are tested
 * here; the rest is pinned by its source. */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { SIGNOFF_LAYOUTS, signoffFormPath, signoffFormProblem, signoffRatingNoticeTitle, signoffRatingSeats } from '../packages/shared/src/signoff';
import { renderSignoffSheet } from '../apps/api/src/lib/signoffPdf';

const ROOT = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

// A 1×1 transparent PNG: enough for the renderer to embed a "signature".
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

describe('what the form asks for', () => {
  const ok = { manager_name: 'Dana Whitfield', closeout_number: null, rating: 5, has_signature: true };
  it('a name, a signature, and the closeout number on an EMCOR sheet', () => {
    expect(signoffFormProblem(ok, false)).toBeNull();
    expect(signoffFormProblem({ ...ok, manager_name: ' ' }, false)).toMatch(/name/);
    expect(signoffFormProblem({ ...ok, has_signature: false }, false)).toMatch(/Sign in the box/);
    expect(signoffFormProblem(ok, true)).toMatch(/closeout/);
    expect(signoffFormProblem({ ...ok, closeout_number: 'CO-1' }, true)).toBeNull();
    expect(signoffFormProblem({ ...ok, manager_name: 'x'.repeat(121) }, false)).toMatch(/longer/);
  });
  it('a rating of 1 to 5 whole stars (Elise, 2026-11-19)', () => {
    for (const r of [1, 2, 3, 4, 5]) expect(signoffFormProblem({ ...ok, rating: r }, false)).toBeNull();
    for (const r of [0, 6, 2.5, null, undefined]) expect(signoffFormProblem({ ...ok, rating: r as number }, false)).toMatch(/Rate the work/);
  });
  it('3 stars or fewer tell the TL and ATL, 2 or fewer the AM too', () => {
    expect(signoffRatingSeats(5)).toEqual([]);
    expect(signoffRatingSeats(4)).toEqual([]);
    expect(signoffRatingSeats(3)).toEqual(['TL', 'ATL']);
    expect(signoffRatingSeats(2)).toEqual(['TL', 'ATL', 'AM']);
    expect(signoffRatingSeats(1)).toEqual(['TL', 'ATL', 'AM']);
    expect(signoffRatingNoticeTitle('WO-12', 1)).toBe('Rated 1 of 5 star at sign-off on WO-12');
    expect(signoffRatingNoticeTitle('WO-12', 3)).toBe('Rated 3 of 5 stars at sign-off on WO-12');
  });
  it('the rating is kept, printed and sent as a notification', () => {
    expect(read('packages/db/migrations/0158_signoff_rating.sql')).toContain('signed_rating smallint CHECK (signed_rating BETWEEN 1 AND 5)');
    const svc = read('apps/api/src/services/signoff.ts');
    expect(svc).toContain('signed_rating = $4');
    expect(svc).toContain('await notifyLowRating(row.task_id, row.id, f, rating, name);');
    expect(svc).toContain('kind: SIGNOFF_LOW_RATING_NOTICE_KIND');
    expect(read('apps/api/src/routes/signoff.ts')).toContain('rating: z.number().int().min(1).max(5)');
    expect(read('apps/web/src/pages/SignoffFormPage.tsx')).toContain('role="radiogroup"');
    expect(read('packages/shared/src/notices.ts')).toContain("signoff_low_rating: { label: 'Low sign-off ratings'");
  });
  it('the form lives in the web app, by the sheet token', () => {
    expect(signoffFormPath('A'.repeat(32))).toBe(`/signoff/${'A'.repeat(32)}`);
  });
});

describe('the signed sheet', () => {
  for (const layout of SIGNOFF_LAYOUTS) {
    it(`${layout}: still one US-Letter page, with the signature on it`, async () => {
      const blank = await renderSignoffSheet({ layout, wo_ref: 'WO-41017', address: '7898 Bradley Long Dr, Sherrills Ford, NC 28673' });
      const signed = await renderSignoffSheet({
        layout,
        wo_ref: 'WO-41017',
        address: '7898 Bradley Long Dr, Sherrills Ford, NC 28673',
        signed: { manager_name: 'Dana Whitfield', date_label: 'Nov 17, 2026', closeout_number: 'CO-558201', rating: 2, signature_png: PNG, stamp: 'Signed electronically · Nov 17, 2026, 3:42 PM CT' },
      });
      const doc = await PDFDocument.load(signed);
      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect([Math.round(width), Math.round(height)]).toEqual([612, 792]);
      expect(doc.getTitle()).toMatch(/^Signed sign-off sheet/);
      expect(signed.length).toBeGreaterThan(blank.length);
    });
  }
});

describe('the form route and its filing', () => {
  it('the auth guard lets the sheet\'s form be read and sent, nothing else', () => {
    const guard = read('apps/api/src/plugins/authGuard.ts');
    expect(guard).toContain('/^\\/api\\/public\\/signoff\\/[A-Za-z0-9_-]{32}(\\/form|\\/submit)?$/,');
    const routes = read('apps/api/src/routes/signoff.ts');
    expect(routes).toMatch(/app\.get\('\/public\/signoff\/:token\/form'/);
    expect(routes).toMatch(/app\.post\('\/public\/signoff\/:token\/submit'/);
  });
  it('a sheet is signed on the form once: the claim asks signed_name to be empty, and is undone if filing fails', () => {
    const svc = read('apps/api/src/services/signoff.ts');
    expect(svc).toMatch(/WHERE id = \$1 AND superseded_at IS NULL AND signed_name IS NULL/);
    expect(svc).toMatch(/SIGNOFF_ALREADY_SIGNED/);
    expect(svc).toMatch(/SET signed_name = NULL, signed_closeout = NULL/);
  });
  it('the signed PDF is filed approved on Drive, then copied to SharePoint like an approval', () => {
    const svc = read('apps/api/src/services/signoff.ts');
    expect(svc).toMatch(/\{ approved: true, sheetId: row\.id \}/);
    const att = read('apps/api/src/services/attachments.ts');
    expect(att).toMatch(/approved \? 'approved' : 'pending'/);
    expect(att).toMatch(/if \(approved\) \{\s+const \{ fileAttachment \} = await import\('\.\/sharepoint\.js'\);/);
  });
  it('the Form link is OBI\'s own form, and the Sign-Off Link field points at it', () => {
    const svc = read('apps/api/src/services/signoff.ts');
    expect(svc).toMatch(/form_link: row \? formUrl\(row\.token\) : null/);
    expect(svc).toMatch(/const link = formUrl\(linkToken\);/);
    expect(read('apps/web/src/App.tsx')).toMatch(/<Route path="\/signoff\/:token" element=\{<SignoffFormPage \/>\} \/>/);
    expect(read('packages/db/migrations/0156_signoff_form.sql')).toMatch(/ADD COLUMN signed_name text/);
  });
});

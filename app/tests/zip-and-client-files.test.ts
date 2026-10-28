/* Two asks of Elise's, 2026-10-28: Zip Code takes digits only, and the Drive
 * tab has a fourth kind of file, From client (0106). Pure functions and
 * source-text pins; no database. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeZip, zipInputValue } from '../packages/shared/src/addressParts';
import { ATTACHMENT_KINDS, ATTACHMENT_KIND_LABEL, completionProofMissing } from '../packages/shared/src/attachments';

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

describe('Zip Code is digits only', () => {
  it('keeps five digits or ZIP+4, dashes nine bare digits', () => {
    expect(normalizeZip('77002')).toBe('77002');
    expect(normalizeZip(' 77002-1234 ')).toBe('77002-1234');
    expect(normalizeZip('770021234')).toBe('77002-1234');
    expect(normalizeZip(77002)).toBe('77002');
  });

  it('refuses text and wrong lengths', () => {
    for (const bad of ['abc', '7700', '77002a', 'Houston', '77002-12', '770021', 'TX 77002']) {
      expect(normalizeZip(bad)).toBeNull();
    }
  });

  it('the input box drops letters as they are typed or pasted', () => {
    expect(zipInputValue('7a7b0')).toBe('770');
    expect(zipInputValue('77002')).toBe('77002');
    expect(zipInputValue('77002-')).toBe('77002-');
    expect(zipInputValue('770021')).toBe('77002-1');
    expect(zipInputValue('77002-1234567')).toBe('77002-1234');
    expect(zipInputValue('Houston')).toBe('');
  });

  it('the API checks the field and every form filters its box', () => {
    expect(read('apps/api/src/services/dataRules.ts')).toMatch(/jsonKey === ADDRESS_ZIP_KEY[\s\S]{0,80}normalizeZip/);
    for (const f of [
      'apps/web/src/components/wo/list/CreateWorkOrderDialog.tsx',
      'apps/web/src/pages/IntakePage.tsx',
      'apps/web/src/components/wo/fieldEdit.tsx',
    ]) {
      expect(read(f)).toContain('zipInputValue(e.target.value)');
    }
  });
});

describe('From client on the Drive tab', () => {
  it('is a kind, labelled From client', () => {
    expect(ATTACHMENT_KINDS).toContain('client');
    expect(ATTACHMENT_KIND_LABEL.client).toBe('From client');
  });

  it('is not proof of work', () => {
    expect(completionProofMissing(false, ['client'])).toBe('after_photo');
    expect(completionProofMissing(true, ['before', 'client'])).toBe('bfi_proof');
  });

  it('the database, the route and the Drive column all know it', () => {
    expect(read('packages/db/migrations/0106_attachment_kind_client.sql')).toContain(
      "CHECK (kind IN ('before', 'after', 'signoff', 'client', 'other'))",
    );
    expect(read('apps/api/src/routes/workOrders.ts')).toContain("z.enum(['before', 'after', 'signoff', 'client', 'other'])");
    expect(read('apps/web/src/components/wo/PhotosCard.tsx')).toContain('label="From client"');
  });
});

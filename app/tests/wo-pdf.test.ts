/* 0073 — a work order saved as a PDF. The pure halves: the renderer (every
 * entity's branding and the unbranded fallback, both kinds, pagination of a
 * long description), the value formatting the service applies, and the
 * shared defaults the migration seeds. The database half (the layouts, the
 * redaction) is exercised against the live site. */

import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { SIGNOFF_LAYOUTS } from '../packages/shared/src/signoff';
import { WO_PDF_CORE_KEYS, WO_PDF_DEFAULTS, WO_PDF_KINDS, woPdfFileName, woPdfPath } from '../packages/shared/src/woPdf';
import { renderWorkOrderPdf, type WoPdfRow } from '../apps/api/src/lib/woPdf';
import { assetBytes, embedAsset } from '../apps/api/src/lib/signoffPdf';
import { SIGNOFF_ASSETS, type SignoffAssetName } from '../apps/api/src/lib/signoffAssets';
import { formatForPdf, paperLabel } from '../apps/api/src/services/woPdf';

describe('the inlined brand images', () => {
  it('decode into their own buffer, so pdf-lib reads them from byte 0', async () => {
    // Buffer.from(base64) may return a slice of Node's pool (byteOffset > 0);
    // pdf-lib's JPEG embedder reads `.buffer` from 0 and then fails with
    // "SOI not found in JPEG" — seen on rf_header under Node 24.
    for (const name of Object.keys(SIGNOFF_ASSETS) as SignoffAssetName[]) {
      // Churn the pool first so a pooled decode would land mid-arena.
      for (let i = 0; i < 20; i++) Buffer.from('x'.repeat(1000 + i * 37));
      const bytes = assetBytes(name);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(bytes.byteLength);
      const doc = await PDFDocument.create();
      const img = await embedAsset(doc, name);
      expect(img.width).toBe(SIGNOFF_ASSETS[name].width);
    }
  });
});

const ROWS: WoPdfRow[] = [
  { label: 'WO #', value: 'WO-39403' },
  { label: 'Client WO #', value: 'WOT0452814' },
  { label: 'Status', value: 'Waiting for Quote' },
  { label: 'Priority', value: 'High' },
  { label: 'Client', value: 'FrontStreet Facility Solutions' },
  { label: 'Store', value: 'Store #1182 — Round Rock' },
  { label: 'Address', value: '2600 N Interstate 35 Frontage Rd, Round Rock, TX 78681' },
  { label: 'NTE', value: '$1,250.00' },
  { label: 'Client NTE', value: null },
  { label: 'WO Description', value: 'Walk-in cooler not holding temperature.\n\nTech to assess compressor and door gaskets; quote any parts before proceeding.', wide: true },
];

async function pagesOf(bytes: Uint8Array): Promise<number> {
  return (await PDFDocument.load(bytes)).getPageCount();
}

describe('renderWorkOrderPdf', () => {
  it('draws every entity and the unbranded fallback, for both kinds', async () => {
    for (const layout of [...SIGNOFF_LAYOUTS, null]) {
      for (const kind of WO_PDF_KINDS) {
        const bytes = await renderWorkOrderPdf({
          layout,
          entity_name: layout ? 'An entity' : 'The One',
          kind,
          title: kind === 'request' ? 'Service request' : 'Work order',
          wo_number: 'WO-39403',
          headline: 'Walk-in cooler not holding temperature',
          rows: ROWS,
          note: 'Please call the dispatcher before any work beyond the NTE.',
          generated_at: new Date('2026-10-06T15:00:00Z'),
          generated_by: 'Elise',
        });
        expect(bytes.byteLength).toBeGreaterThan(1000);
        expect(await pagesOf(bytes)).toBe(1);
      }
    }
  });

  it('runs a long description over several pages and numbers them', async () => {
    const long = Array.from({ length: 260 }, (_, i) => `Line ${i + 1}: the technician found the condenser coil heavily iced and the door gasket torn along the hinge side.`).join('\n');
    const bytes = await renderWorkOrderPdf({
      layout: 'sfm',
      entity_name: 'Seamless Facility Management',
      kind: 'full',
      title: 'Work order',
      wo_number: 'WO-1',
      headline: null,
      rows: [...ROWS, { label: 'Last Update', value: long, wide: true }, ...ROWS],
      note: null,
      generated_at: new Date(),
      generated_by: null,
    });
    expect(await pagesOf(bytes)).toBeGreaterThan(2);
  });

  it('copes with an empty field list and non-Latin text', async () => {
    const bytes = await renderWorkOrderPdf({
      layout: 'bkr_emcor',
      entity_name: 'BKR',
      kind: 'request',
      title: 'Solicitud — “prueba” → 日本語',
      wo_number: 'WO-2',
      headline: 'Café ☕ façade',
      rows: [],
      note: null,
      generated_at: new Date(),
      generated_by: null,
    });
    expect(await pagesOf(bytes)).toBe(1);
  });
});

describe('formatForPdf', () => {
  const t = (type: 'text' | 'number' | 'money' | 'date' | 'datetime' | 'select' | 'boolean') => ({ type, subtype: undefined, options: undefined });
  it('prints money and numbers for people', () => {
    expect(formatForPdf(1250, t('money'))).toBe('$1,250.00');
    expect(formatForPdf('$1,250', t('money'))).toBe('$1,250.00');
    expect(formatForPdf(12345.678, t('number'))).toBe('12,345.68');
  });
  it('keeps a day a day, whatever the time zone', () => {
    expect(formatForPdf('2026-10-06', t('date'))).toBe('Oct 6, 2026');
    expect(formatForPdf('2026-10-06', t('datetime'))).toBe('Oct 6, 2026');
    expect(formatForPdf('1791126000000', t('datetime'))).toMatch(/2026/);
    expect(formatForPdf(1791126000000, t('date'))).toMatch(/2026/);
  });
  it('says Yes / No, and nothing for nothing', () => {
    expect(formatForPdf(true, t('boolean'))).toBe('Yes');
    expect(formatForPdf('false', t('boolean'))).toBe('No');
    expect(formatForPdf('', t('text'))).toBeNull();
    expect(formatForPdf(null, t('money'))).toBeNull();
    expect(formatForPdf([], t('text'))).toBeNull();
  });
  it('joins lists and names objects', () => {
    expect(formatForPdf(['Jordan Brown', 'Jack'], t('text'))).toBe('Jordan Brown, Jack');
    expect(formatForPdf({ name: 'Elise' }, t('text'))).toBe('Elise');
  });
});

describe('paperLabel', () => {
  it('drops the ClickUp numbering and emoji', () => {
    expect(paperLabel('16. Client NTE 🔴')).toBe('Client NTE');
    expect(paperLabel('✅ Client AFM')).toBe('Client AFM');
    expect(paperLabel('35. WO Description')).toBe('WO Description');
    expect(paperLabel('Store')).toBe('Store');
  });
});

describe('the defaults the migration seeds', () => {
  it('list only catalogue keys, once each', () => {
    const core = new Set<string>(WO_PDF_CORE_KEYS);
    for (const kind of WO_PDF_KINDS) {
      const items = WO_PDF_DEFAULTS[kind].items;
      expect(new Set(items).size).toBe(items.length);
      for (const k of items) expect(k.startsWith('fields.') || core.has(k), k).toBe(true);
    }
  });
  it('names the file by the WO number', () => {
    expect(woPdfFileName('WO-39403', 'full')).toBe('WO-39403.pdf');
    expect(woPdfFileName('WO 1/2', 'request')).toBe('WO-1-2-request.pdf');
    expect(woPdfPath('WO-1', 'request')).toBe('/api/work-orders/WO-1/pdf?kind=request&download=1');
  });
});

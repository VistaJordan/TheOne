// 0058 — the pure rules of the vendor relations workflow.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  autoMapImportColumns,
  buildImportRow,
  expiryBand,
  missingFields,
  requiredFieldKeys,
  rollUpCoiApproval,
} from '@theone/shared';

const lists = {
  statuses: [{ key: 'ACTIVE', label: 'Active' }, { key: 'INTERESTED', label: 'Interested' }],
  brand_sources: [{ key: 'SEAMLESS_FM', label: 'Seamless FM' }, { key: 'BYBLOS_VISTA', label: 'Byblos Vista' }],
};

describe('import: matching columns', () => {
  it('recognises the usual headers whatever their case and punctuation', () => {
    const m = autoMapImportColumns(['Company Name', 'Phone #', 'ST', 'E-mail', 'Zip Code', 'Trade', 'Favourite colour']);
    expect(m['Company Name']).toBe('name');
    expect(m.ST).toBe('state');
    expect(m['Zip Code']).toBe('zip');
    expect(m.Trade).toBe('primary_trade');
    expect(m['Favourite colour']).toBeUndefined();
  });

  it('lets several columns be phones but gives any other field to the first column only', () => {
    const m = autoMapImportColumns(['Phone', 'Mobile', 'City', 'Town']);
    expect(m.Phone).toBe('phones');
    expect(m.Mobile).toBe('phones');
    expect(m.City).toBe('city');
    expect(m.Town).toBeUndefined();
  });
});

describe('import: reading one row', () => {
  const mapping = { Company: 'name', Phone: 'phones', ST: 'state', Rate: 'regular_hourly_rate', Statewide: 'statewide', W9: 'w9_received', Brand: 'brand_source', License: 'licenseNumber' };

  it('turns cells into the vendor body', () => {
    const { input, errors } = buildImportRow(
      { Company: 'Lone Star HVAC', Phone: '(214) 555-0150; 214-555-0151', ST: 'Texas', Rate: '$1,095.50', Statewide: 'Yes', W9: 'pending', Brand: 'seamless fm', License: 'TX-99' },
      mapping, lists, 'vendor',
    );
    expect(errors).toEqual([]);
    expect(input.name).toBe('Lone Star HVAC');
    expect(input.phones).toHaveLength(2);
    expect(input.state).toBe('TX');
    expect(input.regular_hourly_rate).toBe(1095.5);
    expect(input.statewide).toBe(true);
    expect(input.w9_received).toBe('PENDING');
    expect(input.brand_source).toBe('SEAMLESS_FM');
    expect((input.details as Record<string, unknown>).licenseNumber).toBe('TX-99');
  });

  it('reports a cell it cannot read and leaves the field out, never guessing', () => {
    const { input, errors } = buildImportRow({ Company: 'A', Phone: 'ask Bob', ST: 'Ontario', Rate: 'call us', Statewide: 'maybe', W9: '', Brand: '', License: '' }, mapping, lists, 'vendor');
    expect(errors).toHaveLength(4);
    expect(input.state).toBeUndefined();
    expect(input.regular_hourly_rate).toBeUndefined();
    expect(input.statewide).toBeUndefined();
    expect(input.phones).toBeUndefined();
  });
});

describe('required fields', () => {
  it('an admin override wins over the default, either way', () => {
    const base = requiredFieldKeys({});
    expect(base.length).toBeGreaterThan(0);
    const off = requiredFieldKeys({ [base[0]]: false });
    expect(off).not.toContain(base[0]);
  });

  it('a complete record has nothing missing; an empty one names each required field', () => {
    const keys = requiredFieldKeys({});
    const empty = missingFields({ name: 'A' }, keys);
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.every((p) => keys.includes(p.key))).toBe(true);
    expect(missingFields({ name: 'A' }, [])).toEqual([]);
  });
});

describe('COI roll-up', () => {
  it('is YES only when every company is approved, NO while any is sent back', () => {
    expect(rollUpCoiApproval([])).toBe('PENDING');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'YES' }])).toBe('YES');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'PENDING' }])).toBe('PENDING');
    expect(rollUpCoiApproval([{ approved: 'YES' }, { approved: 'NO' }])).toBe('NO');
  });
});

describe('expiry bands', () => {
  it('sorts a date into past, two weeks, a month, later', () => {
    expect(expiryBand('2026-09-30', '2026-10-01')).toBe('expired');
    expect(expiryBand('2026-10-01', '2026-10-01')).toBe('two_weeks');
    expect(expiryBand('2026-10-15', '2026-10-01')).toBe('two_weeks');
    expect(expiryBand('2026-10-16', '2026-10-01')).toBe('month');
    expect(expiryBand('2026-10-31', '2026-10-01')).toBe('month');
    expect(expiryBand('2026-11-01', '2026-10-01')).toBe('later');
  });
});

// 2026-10-14 follow-up (FIX-RUNBOOK section 10, the W1-8 class): vendorWork.ts
// was read for DELETE-then-INSERT rewrites of one parent's child rows, to wrap
// each in a transaction as purchasing.ts and maintenance.ts were. It has none.
// Its four DELETEs each remove one row (a daily target, which is an either/or
// with an upsert, not a rewrite; a document; a call; a saved list) and no plain
// INSERT INTO the same table follows any of them. This pins both facts, so a
// rewrite added later either runs on one `withTransaction` (its DELETE and its
// INSERTs through `tx.query`, or a helper's `q.query` on the Queryable handed
// down) or turns this red. Source-text assertions in the pattern of
// tests/purchasing-tx.test.ts: no database is opened.
//
// What the guard sees: a DELETE and the INSERTs after it in the same function,
// AND inside any helper of THIS file the function awaits after the DELETE
// (purchasing.ts splits its rewrites that way: the DELETE and the INSERTs sit
// in `writeRequestLines(q, …)`, called by the writer). A helper in another
// file is not followed. The detector is a function of the source text so that
// it can be proved on a synthetic file, below.

/** Every top-level function of `src`: from its header to the first `}` at column 0. */
function functionsOf(src: string): { name: string; body: string }[] {
  return [...src.matchAll(/^(?:export )?(?:async )?function (\w+)\(/gm)].map((m) => ({
    name: m[1],
    body: src.slice(m.index!, src.indexOf('\n}', m.index!) + 2),
  }));
}

/** Every DELETE that a plain INSERT INTO the same table follows — in the same
 *  function, or in a same-file helper awaited after it — with the channel each
 *  statement went through (`query` is the pool). */
function rewrites(src: string): { fn: string; table: string; del: string; ins: string }[] {
  const byName = new Map(functionsOf(src).map((f) => [f.name, f.body]));
  const inlined = (text: string, seen: Set<string>): string =>
    text.replace(/\bawait (\w+)\(/g, (call, name: string) => {
      const helper = byName.get(name);
      return helper && !seen.has(name) ? `${call}${inlined(helper, new Set([...seen, name]))}` : call;
    });
  const out: { fn: string; table: string; del: string; ins: string }[] = [];
  for (const [fn, body] of byName) {
    for (const del of body.matchAll(/await (query|tx\.query|q\.query)\(`DELETE FROM (\w+)/g)) {
      const table = del[2];
      const after = inlined(body.slice(del.index! + del[0].length), new Set([fn]));
      const ins = [...after.matchAll(/await (query|tx\.query|q\.query)\(\s*`INSERT INTO (\w+) [^`]*`/g)].find((m) => m[2] === table);
      // An upsert (ON CONFLICT) after a DELETE is an either/or, not a rewrite.
      if (!ins || /ON CONFLICT/.test(ins[0])) continue;
      out.push({ fn, table, del: del[1], ins: ins[1] });
    }
  }
  return out;
}

describe('vendorWork.ts: no delete-then-insert rewrite runs statement by statement on the pool', () => {
  const src = readFileSync(new URL('../apps/api/src/services/vendorWork.ts', import.meta.url), 'utf8');
  const functions = functionsOf(src);

  it('reads the file into its functions', () => {
    const names = functions.map((f) => f.name);
    expect(names).toContain('removeDocument');
    expect(names).toContain('setDailyTarget');
    expect(functions.every((f) => f.body.endsWith('\n}'))).toBe(true);
  });

  it('deletes single rows only: a daily target, a document, a call, a saved list', () => {
    const tables = [...src.matchAll(/DELETE FROM (\w+)/g)].map((m) => m[1]).sort();
    expect(tables).toEqual(['vendor_call', 'vendor_daily_target', 'vendor_document', 'vendor_saved_view']);
  });

  it('a function that deletes from a table and then plainly inserts into it — itself or through a helper it awaits — does both on one transaction', () => {
    for (const r of rewrites(src)) {
      expect(r.del, `${r.fn}: DELETE FROM ${r.table} before an INSERT INTO it runs on the pool`).not.toBe('query');
      expect(r.ins, `${r.fn}: INSERT INTO ${r.table} after a DELETE FROM it runs on the pool`).not.toBe('query');
    }
  });

  // The detector itself, on a synthetic file: a rewrite split across a helper
  // is seen and each statement's channel is read where it stands; an upsert
  // pair is not a rewrite; a helper in another file is not followed.
  it('follows a rewrite into a same-file helper and reads each statement’s channel there', () => {
    const synthetic = [
      'export async function rewrite(id: string): Promise<void> {',
      '  await query(`DELETE FROM widget_line WHERE widget_id = $1`, [id]);',
      '  await writeLines(id);',
      '}',
      'async function writeLines(id: string): Promise<void> {',
      '  await query(`INSERT INTO widget_line (widget_id) VALUES ($1)`, [id]);',
      '}',
      'export async function safe(id: string): Promise<void> {',
      '  await withTransaction(async (tx) => {',
      '    await tx.query(`DELETE FROM gadget_line WHERE gadget_id = $1`, [id]);',
      '    await writeGadgets(tx, id);',
      '  });',
      '}',
      'async function writeGadgets(q: Queryable, id: string): Promise<void> {',
      '  await q.query(`INSERT INTO gadget_line (gadget_id) VALUES ($1)`, [id]);',
      '}',
      'export async function upsert(id: string): Promise<void> {',
      '  await query(`DELETE FROM target WHERE id = $1`, [id]);',
      '  await query(`INSERT INTO target (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`, [id]);',
      '}',
      'export async function elsewhere(id: string): Promise<void> {',
      '  await query(`DELETE FROM thing WHERE id = $1`, [id]);',
      '  await writeThings(id);',
      '}',
      '',
    ].join('\n');
    expect(rewrites(synthetic)).toEqual([
      { fn: 'rewrite', table: 'widget_line', del: 'query', ins: 'query' },
      { fn: 'safe', table: 'gadget_line', del: 'tx.query', ins: 'q.query' },
    ]);
  });
});

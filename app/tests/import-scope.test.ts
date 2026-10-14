/* G4b — AUDIT.md Must-fix: W4-4 (decision D7) and W3-3 (decision D4).
 *
 * W4-4: the CSV import took only an actor ID, so a scoped dispatcher could
 * update any work order whose number they typed into a file, and anyone with
 * work_orders:create could set a status — or route a new row to a home list —
 * by way of a file. Pinned here: `importRefusal` refuses the WHOLE file (scope
 * first, then the status permission, then routing under the same grant) with
 * the codes, messages and details the contract names; `importWorkOrders`
 * takes the acting principal, projects the scope as `in_scope` on its lookup
 * and refuses before the plan runs and before the dry-run return, so a
 * preview reveals nothing either; the route hands the principal down.
 *
 * W3-3: bulk edit and the import's update branch read the row on the pool,
 * merged in JS and wrote the whole bag back inside a later transaction, so a
 * write that landed in between was lost. Pinned here: both read the row
 * `… FOR NO KEY UPDATE` inside the transaction (the strength every bag writer
 * takes since F3 — the reason is in woFieldValues.ts and the six files are
 * swept in bag-lock.test.ts), diff against and merge over THAT read, write
 * only what the diff names (an update without a status cell no longer puts a
 * moved status back), lock in id order, and skip a row trashed meanwhile — or
 * a row already in Trash — instead of writing it.
 *
 * Hermetic: the pure helpers are called directly; the shape of the service is
 * asserted from its source text (the house pattern, see docs.test.ts). No
 * database, no network.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  importRefusal,
  importRoutingRows,
  importStatusRows,
  type ImportRow,
} from '../apps/api/src/services/woBulk';
import { ApiError } from '../apps/api/src/errors';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const woBulkSrc = read('../apps/api/src/services/woBulk.ts');
const routeSrc = read('../apps/api/src/routes/workOrders.ts');

/** The text of an exported async function: from its header to the next export. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\nexport ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

const clean = { outsideScope: [] as string[], statusRows: [] as string[], canSetStatus: true, isSuperAdmin: false };

const STATUS_MESSAGE = 'You cannot set work-order status — remove the status column, or clear it on these rows';
const ROUTING_MESSAGE =
  'You cannot route work orders to a home list — remove the home list column, or clear it on these rows';

describe('importRefusal (W4-4 / D7)', () => {
  it('lets a clean file through', () => {
    expect(importRefusal(clean)).toBeNull();
  });

  it('never refuses a super admin, whatever the file holds', () => {
    expect(
      importRefusal({
        outsideScope: ['WO-9'],
        statusRows: ['WO-9', 'row 2'],
        routingRows: ['row 2'],
        canSetStatus: false,
        isSuperAdmin: true,
      }),
    ).toBeNull();
  });

  it('refuses the whole file with IMPORT_SCOPE when a matched row is outside the scope', () => {
    const err = importRefusal({ ...clean, outsideScope: ['WO-41017', 'WO-41020'] });
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.statusCode).toBe(403);
    expect(err?.message).toBe('Some rows in this file are work orders that are not assigned to you');
    expect(err?.details).toEqual({
      code: 'IMPORT_SCOPE',
      wo_numbers: ['WO-41017', 'WO-41020'],
      required_permission: 'work_orders/scope:view',
    });
  });

  it('refuses with IMPORT_STATUS_PERMISSION when a row names a status the actor may not set', () => {
    const err = importRefusal({ ...clean, canSetStatus: false, statusRows: ['WO-1', 'row 3'] });
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.statusCode).toBe(403);
    expect(err?.message).toBe(STATUS_MESSAGE);
    expect(err?.details).toEqual({
      code: 'IMPORT_STATUS_PERMISSION',
      wo_numbers: ['WO-1', 'row 3'],
      required_permission: 'work_orders/status:edit',
    });
  });

  it('does not refuse a status column the actor may set, nor a file whose status cells are blank', () => {
    expect(importRefusal({ ...clean, canSetStatus: true, statusRows: ['WO-1'] })).toBeNull();
    expect(importRefusal({ ...clean, canSetStatus: false, statusRows: [] })).toBeNull();
  });

  it('scope wins over status when both apply', () => {
    const err = importRefusal({
      outsideScope: ['WO-7'],
      statusRows: ['WO-7', 'row 2'],
      canSetStatus: false,
      isSuperAdmin: false,
    });
    expect((err?.details as { code: string }).code).toBe('IMPORT_SCOPE');
  });

  it('refuses a home-list cell on a create under the same grant, with its own sentence', () => {
    const err = importRefusal({ ...clean, canSetStatus: false, routingRows: ['row 2', 'WO-9'] });
    expect(err).toBeInstanceOf(ApiError);
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.statusCode).toBe(403);
    expect(err?.message).toBe(ROUTING_MESSAGE);
    expect(err?.details).toEqual({
      code: 'IMPORT_STATUS_PERMISSION',
      wo_numbers: ['row 2', 'WO-9'],
      required_permission: 'work_orders/status:edit',
    });
  });

  it('names the status rows first when a file has both, and routing is fine for whoever may set a status', () => {
    const both = importRefusal({ ...clean, canSetStatus: false, statusRows: ['WO-1'], routingRows: ['row 2'] });
    expect(both?.message).toBe(STATUS_MESSAGE);
    expect((both?.details as { wo_numbers: string[] }).wo_numbers).toEqual(['WO-1']);
    expect(importRefusal({ ...clean, canSetStatus: true, routingRows: ['row 2'] })).toBeNull();
    expect(importRefusal({ ...clean, canSetStatus: false, routingRows: [] })).toBeNull();
  });
});

describe('importStatusRows', () => {
  it('names a row by its WO number, or `row N` for a create, and skips blank status cells', () => {
    const rows: ImportRow[] = [
      { wo_number: 'WO-1', status: 'Open' },
      { wo_number: '', status: 'Done' }, // a create with a status → row 2
      { wo_number: 'WO-3', status: '   ' }, // blank cell → not listed
      { wo_number: 'WO-4' }, // no status column at all
      { status: 'Open' }, // no number → row 5
      { wo_number: '  WO-6 ', status: 'Open' }, // trimmed
    ];
    expect(importStatusRows(rows)).toEqual(['WO-1', 'row 2', 'row 5', 'WO-6']);
  });
});

describe('importRoutingRows', () => {
  it('lists only the creates that carry a home-list cell — an update keeps the list it has', () => {
    const rows: ImportRow[] = [
      { wo_number: 'WO-1', home_list: 'Incoming WOs' }, // on file → an update → ignored
      { wo_number: '', home_list: 'Incoming WOs' }, // a create → row 2
      { wo_number: 'WO-3', home_list: '   ' }, // blank cell → not listed
      { home_list: 'Incoming WOs' }, // no number → row 4
      { wo_number: ' WO-5 ', home_list: 'Incoming WOs' }, // not on file → a create, trimmed
      { wo_number: 'WO-6' }, // no home-list column
    ];
    expect(importRoutingRows(rows, new Set(['WO-1']))).toEqual(['row 2', 'row 4', 'WO-5']);
    expect(importRoutingRows(rows, new Set())).toEqual(['WO-1', 'row 2', 'row 4', 'WO-5']);
  });
});

describe('importWorkOrders takes the acting principal and refuses before anything runs (W4-4)', () => {
  const body = fnBody(woBulkSrc, 'importWorkOrders');
  const header = body.slice(0, body.indexOf('): Promise<ImportResult>'));

  it('is handed the ActingPrincipal, not an id', () => {
    expect(header).toMatch(/actor: ActingPrincipal/);
    expect(header).not.toMatch(/actorId: string/);
  });

  it('projects the scope as in_scope on the lookup, bound through one Params', () => {
    expect(body).toContain("${scope ?? 'TRUE'} AS in_scope");
    expect(body).toContain('woScopeSql(actor, p)');
    expect(body).toContain('p.values');
    // The numbers are bound through the same Params, never inlined.
    expect(body).toContain('numbers.map((n) => p.add(n))');
  });

  it('refuses before the plan loop and before the dry-run return, in both modes', () => {
    const refuse = body.indexOf('importRefusal(');
    const plan = body.indexOf('rows.forEach(');
    const dry = body.indexOf('if (opts.dry_run) return summary;');
    expect(refuse).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(-1);
    expect(dry).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(plan);
    expect(refuse).toBeLessThan(dry);
    // Nothing between the lookup and the refusal reads the mode: the check is
    // the same for create and upsert.
    expect(body.slice(body.indexOf('AS in_scope'), refuse)).not.toContain('opts.mode');
  });

  it('asks the same status permission the bulk route asks, for status cells and for routing', () => {
    expect(body).toContain("permAllows(actor.perms, 'work_orders/status', 'edit', actor.isSuperAdmin)");
    expect(body).toContain('statusRows: importStatusRows(rows)');
    // Routing rows are the creates only, told apart by the numbers the lookup matched.
    expect(body).toContain('routingRows: importRoutingRows(rows, new Set(existingByNumber.keys()))');
  });
});

describe('the import route hands the principal down (W4-4)', () => {
  it('passes `p` from acting(req), not an id', () => {
    expect(routeSrc).toMatch(/importWorkOrders\(rows, \{ mode, dry_run \}, p\)/);
    expect(routeSrc).not.toMatch(/importWorkOrders\(rows, \{ mode, dry_run \}, actorIdFromRequest\(req\)\)/);
  });
});

/** The per-row lock bulk edit takes: the SQL itself, not the comment above it. */
const BULK_LOCK = /SELECT fields FROM task WHERE id = \$1 AND deleted_at IS NULL FOR NO KEY UPDATE/;

describe('bag writes lock the row (W3-3 / D4)', () => {
  it('bulkUpdate reads task.fields FOR NO KEY UPDATE inside its transaction, per row, and merges over that read', () => {
    const body = fnBody(woBulkSrc, 'bulkUpdate');
    const tx = body.indexOf('withTransaction(');
    const lock = body.search(BULK_LOCK);
    expect(tx).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(tx);
    expect(body.slice(tx, lock)).toContain('for (const row of rows.rows)');
    // Plain FOR UPDATE is gone from the whole function (F3): a child INSERT's KEY SHARE no longer waits on it.
    expect(body).not.toMatch(/(?<!NO KEY )\bFOR UPDATE\b/);
    expect(body.slice(lock)).toContain('{ ...rowFields }');
    expect(body.slice(lock)).not.toContain('row.fields?.[c.key]');
  });

  it('bulkUpdate takes its rows ORDER BY id, so the locks are taken in one order', () => {
    const body = fnBody(woBulkSrc, 'bulkUpdate');
    const tx = body.indexOf('withTransaction(');
    expect(body.slice(0, tx)).toMatch(/AND t\.deleted_at IS NULL\s+ORDER BY t\.id`/);
  });

  describe("the import's update branch", () => {
    const body = fnBody(woBulkSrc, 'importWorkOrders');
    const tx = body.indexOf('withTransaction(');
    // The SQL itself, not the comment above it that says the same thing.
    const lock = body.indexOf('AND deleted_at IS NULL FOR NO KEY UPDATE', tx);
    const after = body.slice(lock);

    it('locks the bag, the status and every column the file may set, on the transaction, live rows only', () => {
      expect(tx).toBeGreaterThan(-1);
      expect(lock).toBeGreaterThan(tx);
      expect(body).toMatch(
        /SELECT fields, status_id, ext_name, title, description, client, city, state, trade,\s+billing_entity, nte::text AS nte, priority, date_received::text AS date_received\s+FROM task WHERE id = \$1 AND deleted_at IS NULL FOR NO KEY UPDATE/,
      );
      expect(body.slice(tx, lock)).toContain('tx.query<LockedRow>');
      expect(body).not.toMatch(/(?<!NO KEY )\bFOR UPDATE\b/);
    });

    it('may take FOR NO KEY UPDATE because the SET never names wo_number: it is the match key, not an IMPORTABLE column (F3)', () => {
      const start = woBulkSrc.indexOf('const IMPORTABLE = new Set([');
      expect(start).toBeGreaterThan(-1);
      const importable = woBulkSrc.slice(start, woBulkSrc.indexOf(']);', start));
      expect(importable).toContain("'ext_name'");
      expect(importable).not.toContain("'wo_number'");
      expect(importable).not.toContain("'id'");
      // Every column an update SETs comes from plan.cols, which is filtered through IMPORTABLE.
      expect(body).toContain('if (!IMPORTABLE.has(key)) continue;');
      expect(after).toContain('for (const [col, value] of Object.entries(plan.cols))');
    });

    it("merges the file's keys over the locked bag and diffs columns against the locked row, never the pool read", () => {
      expect(after).toContain('applyFieldPatch(curFields, plan.fieldPatch)');
      expect(after).not.toContain('JSON.stringify(plan.fields));');
      expect(after).toContain('live[col as keyof LockedRow]');
      expect(after).not.toContain('cur[col as keyof ExistingRow]');
      expect(after).not.toContain('cur.status_id');
      // Only the columns the diff names are SET.
      expect(after).toMatch(/if \(!changed\(before, value\)\) continue;\s+changes\.push\(\{ field: col, before, after: value \}\);\s+params\.push\(value\);/);
    });

    it('moves the status only when the file named one, against the status the row holds now', () => {
      const guard = after.indexOf('if (plan.status_named && plan.status_id !== live.status_id)');
      const push = after.indexOf('params.push(plan.status_id)');
      expect(guard).toBeGreaterThan(-1);
      expect(push).toBeGreaterThan(guard);
      expect(after).toContain('before: { status_id: live.status_id, status_name: statusById.get(live.status_id)?.name ?? null }');
      // The plan remembers whether the cell chose the status.
      expect(body).toContain("status_named: statusName !== ''");
    });

    it('skips a row trashed since the preview, and the plan never writes a row already in Trash', () => {
      expect(after).toContain("r.message = 'Deleted meanwhile'");
      expect(body).toContain('(t.deleted_at IS NOT NULL) AS trashed');
      const trash = body.indexOf('if (match?.trashed)');
      expect(trash).toBeGreaterThan(body.indexOf('rows.forEach('));
      expect(trash).toBeLessThan(body.indexOf("message: 'Already exists'"));
      expect(body.slice(trash, trash + 400)).toContain("message: 'In trash'");
      // The counts are recounted after the write, so a late skip is reported.
      expect(body.slice(tx)).toContain("return { ...summary, updated: tally('update'), skipped: tally('skip') };");
    });

    it('locks the updates in id order, before the creates', () => {
      const order = body.indexOf(".filter((pl) => pl.action === 'update').sort(byId)");
      expect(order).toBeGreaterThan(-1);
      expect(order).toBeLessThan(tx);
      expect(body.slice(tx)).toContain('for (const plan of ordered)');
      expect(body.slice(tx)).not.toContain('for (const plan of plans)');
    });
  });

  it('the PGlite single-connection rationale is gone', () => {
    expect(woBulkSrc).not.toContain('PGlite');
  });
});

// 0058 · Importing vendors or technicians from a CSV.
//
// The browser reads the file and sends rows, not bytes; the wizard holds them
// and this service is stateless until the run starts:
//
//   analyzeImport   what the rows would do — how many are ready, have no
//                   name, carry cells we cannot read, match a record on file,
//                   or lack a required field. Nothing is written.
//   startImport     records the run (who, file, choices) → an id
//   importRows      one chunk of rows against that run; the wizard sends the
//                   file in chunks so a 2,000-row file is not one long request
//                   and the screen can show progress
//
// What happens to a row:
//   no name                         skipped (invalid)
//   unreadable cells                the cell is left out, the row still goes in
//   matches a record on file        by the chosen strategy — skip, skip and
//     (same name, or any phone;       report, add anyway (flagged, no review
//      a technician by phone only)    task), or fill in the record on file
//                                     (only cells that have something; phones
//                                     are added, never replaced)
//   lacks a required field          add (flagged, review task) or skip
//   otherwise                       created — the importer owns a VR vendor
//
// Rows are processed in file order, so two rows of the same file that share
// a phone behave like any other duplicate: the second meets the first.
// No welcome email is sent for an imported vendor (nothing sends email here).

import {
  IMPORT_MAX_ROWS,
  VENDOR_IMPORT_PERM_KEY,
  buildImportRow,
  missingFields,
  phoneDigits,
} from '@theone/shared';
import type {
  ImportAnalysis,
  ImportDuplicateStrategy,
  ImportMissingStrategy,
  ImportSummary,
  VendorImportRecord,
  VendorInput,
  VendorKind,
} from '@theone/shared';
import { query } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { requirePerm } from './permissions.js';
import { findDuplicates, getVendor, insertVendor, listBrandSources, listStatuses, requireVendorsView, updateVendor } from './vendors.js';
import { requiredKeys } from './vendorTasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CsvRow = Record<string, string>;

function gate(actor: ActingPrincipal): void {
  requireVendorsView(actor);
  requirePerm(actor, VENDOR_IMPORT_PERM_KEY, 'create', 'You cannot import vendors');
}

async function lists() {
  const [statuses, brand_sources] = await Promise.all([listStatuses(), listBrandSources()]);
  return { statuses, brand_sources };
}

const digitsOf = (input: VendorInput): string[] =>
  (input.phones ?? []).map((p) => phoneDigits(p.phone)).filter((d): d is string => d !== null);

/** The required fields a row would lack once saved (the importer is its owner). */
function rowMissing(input: VendorInput, required: string[], actorId: string): string[] {
  if (input.kind === 'tech') return [];
  const subject = { ...input, owner_id: actorId, phones: (input.phones ?? []).map((p) => p.phone) };
  return missingFields(subject as never, required).filter((p) => p.problem === 'missing').map((p) => p.label);
}

export async function analyzeImport(
  input: { rows: CsvRow[]; mapping: Record<string, string>; kind: VendorKind },
  actor: ActingPrincipal,
): Promise<ImportAnalysis> {
  gate(actor);
  if (input.rows.length > IMPORT_MAX_ROWS) throw badRequest(`A file may hold at most ${IMPORT_MAX_ROWS} rows`);
  const l = await lists();
  const required = await requiredKeys();
  const out: ImportAnalysis = { total: input.rows.length, ready: 0, no_name: 0, with_errors: 0, duplicates: 0, missing_required: 0, samples: [] };

  // One pass to build every row, then two set lookups for what is on file.
  const built = input.rows.map((r) => buildImportRow(r, input.mapping, l, input.kind));
  const allDigits = [...new Set(built.flatMap((b) => digitsOf(b.input)))];
  const allNames = input.kind === 'tech' ? [] : [...new Set(built.map((b) => (b.input.name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean))];
  const [phoneHits, nameHits] = await Promise.all([
    allDigits.length === 0
      ? Promise.resolve(new Set<string>())
      : query<{ digits: string }>(
          `SELECT DISTINCT ph.digits FROM vendor_phone ph JOIN vendor v ON v.id = ph.vendor_id
            WHERE v.deleted_at IS NULL AND ph.digits = ANY($1::text[])`,
          [allDigits],
        ).then((r) => new Set(r.rows.map((x) => x.digits))),
    allNames.length === 0
      ? Promise.resolve(new Set<string>())
      : query<{ k: string }>(
          `SELECT DISTINCT lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) AS k FROM vendor
            WHERE deleted_at IS NULL AND lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = ANY($1::text[])`,
          [allNames],
        ).then((r) => new Set(r.rows.map((x) => x.k))),
  ]);

  const seenDigits = new Set<string>();
  built.forEach((b, i) => {
    const name = (b.input.name ?? '').trim();
    const problems: string[] = [...b.errors];
    if (name === '') {
      out.no_name += 1;
      problems.unshift('No name');
    } else {
      const digits = digitsOf(b.input);
      const nameKey = name.toLowerCase().replace(/\s+/g, ' ');
      const dup = digits.some((d) => phoneHits.has(d) || seenDigits.has(d)) || (input.kind !== 'tech' && nameHits.has(nameKey));
      digits.forEach((d) => seenDigits.add(d));
      if (dup) {
        out.duplicates += 1;
        problems.push('Matches a record on file');
      }
      const missing = rowMissing(b.input, required, actor.id);
      if (missing.length > 0) {
        out.missing_required += 1;
        problems.push(`Missing: ${missing.join(', ')}`);
      }
      if (b.errors.length > 0) out.with_errors += 1;
      if (!dup && missing.length === 0 && b.errors.length === 0) out.ready += 1;
    }
    if (problems.length > 0 && out.samples.length < 40) out.samples.push({ row: i + 2, name, problems });
  });
  return out;
}

const EMPTY_SUMMARY: ImportSummary = {
  created: 0,
  enriched: 0,
  skipped_duplicates: 0,
  skipped_missing: 0,
  skipped_invalid: 0,
  flagged_duplicates: 0,
  flagged_missing: 0,
  not_on_map: 0,
  report: [],
};

export interface StartImportInput {
  file_name: string;
  kind: VendorKind;
  total_rows: number;
  mapping: Record<string, string>;
  duplicate_strategy: ImportDuplicateStrategy;
  missing_strategy: ImportMissingStrategy;
}

export async function startImport(input: StartImportInput, actor: ActingPrincipal): Promise<{ id: string }> {
  gate(actor);
  if (input.total_rows > IMPORT_MAX_ROWS) throw badRequest(`A file may hold at most ${IMPORT_MAX_ROWS} rows`);
  if (!Object.values(input.mapping).includes('name')) throw badRequest('Map a column to Name');
  const res = await query<{ id: string }>(
    `INSERT INTO vendor_import (file_name, uploaded_by, kind, total_rows, column_mapping, duplicate_strategy, missing_strategy, summary)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb) RETURNING id::text AS id`,
    [
      input.file_name.slice(0, 200),
      actor.id,
      input.kind,
      input.total_rows,
      JSON.stringify(input.mapping),
      input.duplicate_strategy,
      input.missing_strategy,
      JSON.stringify(EMPTY_SUMMARY),
    ],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: res.rows[0].id,
    action: 'vendors_import_started',
    after: { name: input.file_name, rows: input.total_rows, kind: input.kind, duplicates: input.duplicate_strategy, missing: input.missing_strategy },
  });
  return res.rows[0];
}

/** The fields of an ENRICH: only what the row actually carries. */
function enrichPatch(input: VendorInput): VendorInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (k === 'kind' || k === 'phones' || k === 'name') continue;
    if (v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v;
  }
  return out as VendorInput;
}

export async function importRows(
  importId: string,
  input: { offset: number; rows: CsvRow[]; brand_source?: string | null },
  actor: ActingPrincipal,
): Promise<ImportSummary> {
  gate(actor);
  if (!UUID_RE.test(importId)) throw notFound('Import not found');
  const run = await query<{ kind: VendorKind; column_mapping: Record<string, string>; duplicate_strategy: ImportDuplicateStrategy; missing_strategy: ImportMissingStrategy; summary: ImportSummary; uploaded_by: string | null }>(
    `SELECT kind, column_mapping, duplicate_strategy, missing_strategy, summary, uploaded_by::text AS uploaded_by
       FROM vendor_import WHERE id = $1`,
    [importId],
  );
  const r = run.rows[0];
  if (!r || r.uploaded_by !== actor.id) throw notFound('Import not found');
  if (input.rows.length > 250) throw badRequest('Send at most 250 rows at a time');

  const l = await lists();
  const required = await requiredKeys();
  const s: ImportSummary = { ...EMPTY_SUMMARY, ...r.summary, report: [...(r.summary.report ?? [])] };

  for (let i = 0; i < input.rows.length; i++) {
    const rowNo = input.offset + i + 2; // 1-based, after the header line
    const built = buildImportRow(input.rows[i], r.column_mapping, l, r.kind);
    const row = built.input;
    const name = (row.name ?? '').trim();
    if (name === '') {
      s.skipped_invalid += 1;
      continue;
    }
    if (!row.brand_source && input.brand_source && r.kind === 'vendor') row.brand_source = input.brand_source;
    if (r.kind === 'tech' && !row.status) row.status = 'ACTIVE';

    const matches = await findDuplicates(r.kind === 'tech' ? '' : name, digitsOf(row));
    if (matches.length > 0) {
      const hit = matches[0];
      if (r.duplicate_strategy === 'SKIP' || r.duplicate_strategy === 'FLAG') {
        s.skipped_duplicates += 1;
        if (r.duplicate_strategy === 'FLAG' && s.report.length < 2000) {
          s.report.push({ row: rowNo, name, phone: row.phones?.[0]?.phone ?? null, existing_id: hit.id, existing_name: hit.name });
        }
        continue;
      }
      if (r.duplicate_strategy === 'ENRICH') {
        try {
          const current = await getVendor(hit.id, actor);
          const have = new Set(current.phones.map((p) => p.digits));
          const extra = (row.phones ?? []).filter((p) => {
            const d = phoneDigits(p.phone);
            return d !== null && !have.has(d);
          });
          const patch = enrichPatch(row);
          if (extra.length > 0) patch.phones = [...current.phones.map((p) => ({ phone: p.display, label: p.label })), ...extra];
          await updateVendor(hit.id, patch, actor);
          s.enriched += 1;
        } catch {
          // Outside the importer's scope, or no edit grant: left as it is.
          s.skipped_duplicates += 1;
        }
        continue;
      }
      // ADD_ANYWAY falls through, flagged.
    }

    const missing = rowMissing(row, required, actor.id);
    if (missing.length > 0 && r.missing_strategy === 'SKIP') {
      s.skipped_missing += 1;
      continue;
    }
    try {
      const id = await insertVendor({ ...row, override_duplicate: true }, actor, { duplicateTask: false });
      s.created += 1;
      if (matches.length > 0) s.flagged_duplicates += 1;
      if (missing.length > 0) s.flagged_missing += 1;
      const placed = await query<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM vendor_location WHERE vendor_id = $1 AND lat IS NOT NULL) AS ok`,
        [id],
      );
      if (!placed.rows[0]?.ok) s.not_on_map += 1;
    } catch {
      s.skipped_invalid += 1;
    }
  }

  await query(`UPDATE vendor_import SET summary = $2::jsonb WHERE id = $1`, [importId, JSON.stringify(s)]);
  return s;
}

export async function listImports(actor: ActingPrincipal): Promise<VendorImportRecord[]> {
  gate(actor);
  const res = await query<{ id: string; file_name: string; u_id: string | null; u_name: string | null; u_kind: 'human' | 'service' | null; kind: VendorKind; total_rows: number; duplicate_strategy: ImportDuplicateStrategy; missing_strategy: ImportMissingStrategy; summary: ImportSummary; created_at: Date }>(
    `SELECT i.id::text AS id, i.file_name, p.id::text AS u_id, p.display_name AS u_name, p.kind AS u_kind, i.kind,
            i.total_rows, i.duplicate_strategy, i.missing_strategy, i.summary, i.created_at
       FROM vendor_import i LEFT JOIN principal p ON p.id = i.uploaded_by
      ORDER BY i.created_at DESC LIMIT 30`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    file_name: r.file_name,
    uploaded_by: r.u_id ? { id: r.u_id, name: r.u_name ?? 'Unknown', kind: r.u_kind ?? 'human' } : null,
    kind: r.kind,
    total_rows: r.total_rows,
    duplicate_strategy: r.duplicate_strategy,
    missing_strategy: r.missing_strategy,
    summary: { ...EMPTY_SUMMARY, ...r.summary },
    created_at: new Date(r.created_at).toISOString(),
  }));
}

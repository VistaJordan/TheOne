// Export the vendors of VR - CRM and the technicians of Tech Locator to CSV
// files that The One's own import wizard (/vendors/import) reads.
//
//   VR_CRM_DATABASE_URL=postgres://… TECH_LOCATOR_DATABASE_URL=postgres://… \
//     node scripts/export-vr-crm.mjs [--out <folder>]
//
// VR_CRM_DATABASE_URL is VR - CRM's database (its DATABASE_URL / DIRECT_URL).
// TECH_LOCATOR_DATABASE_URL is the one Tech Locator keeps its technicians in
// (its CSV_DATABASE_URL). Either can be left out.
//
// What this is, and what it is not:
//   · READ ONLY. Each session is opened with default_transaction_read_only =
//     on and the export runs inside a READ ONLY transaction, so the database
//     itself refuses any write — this script cannot change VR - CRM or Tech
//     Locator even by accident. It contains SELECT statements and nothing else.
//   · It writes nothing to The One. It produces files; a person then loads
//     them at /vendors/import, where the wizard shows a dry run (how many are
//     new, how many match a record on file, how many lack a required field)
//     before a single row is written, and lets them choose what happens to
//     the duplicates.
//   · The connection strings are read from the environment and never printed.
//   · The files hold names, phones and emails: the default output folder is
//     outside the repository, and nothing here is committed.
//
// Files (at most 2,000 rows each — the wizard's limit):
//   vr-crm-vendors-<n>.csv        import as "Vendors"
//   tech-locator-techs-<n>.csv    import as "Technicians"
// The column names are the ones the wizard recognises by itself.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const pg = require('pg');

const url = process.env.VR_CRM_DATABASE_URL;
const techUrl = process.env.TECH_LOCATOR_DATABASE_URL;
if (!url && !techUrl) {
  console.error('Set VR_CRM_DATABASE_URL (the vendors) and / or TECH_LOCATOR_DATABASE_URL (the technicians).');
  process.exit(1);
}
const outArg = process.argv.indexOf('--out');
const outDir = outArg > 0 ? path.resolve(process.argv[outArg + 1]) : path.join(os.homedir(), 'the-one-transfer');
const CHUNK = 2000;

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.filter((x) => x !== null && String(x).trim() !== '').join('; ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const tri = (v) => (v === 'YES' ? 'Yes' : v === 'NO' ? 'No' : v === 'PENDING' ? 'Pending' : '');

function writeChunks(prefix, headers, rows) {
  const files = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const file = path.join(outDir, `${prefix}-${Math.floor(i / CHUNK) + 1}.csv`);
    const body = [headers.join(','), ...rows.slice(i, i + CHUNK).map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n');
    fs.writeFileSync(file, `﻿${body}\r\n`);
    files.push(file);
  }
  return files;
}

/** Run `fn` inside a READ ONLY transaction on a read-only session. */
async function readOnly(dbUrl, fn) {
  const local = /sslmode=disable|localhost|127\.0\.0\.1/.test(dbUrl);
  const client = new pg.Client({ connectionString: dbUrl, options: '-c default_transaction_read_only=on', ssl: local ? undefined : { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    await client.end();
  }
}

try {
  // ── VR - CRM vendors ───────────────────────────────────────────────────────
  const vendorRows = !url
    ? []
    : await readOnly(url, async (client) => {
        const vendors = await client.query(`
          SELECT v.*,
                 (SELECT array_agg(p."phoneNumber" ORDER BY p."createdAt") FROM "VendorPhone" p WHERE p."vendorId" = v.id) AS phone_list
            FROM "Vendor" v
           ORDER BY v."createdAt"`);
        return vendors.rows.map((v) => ({
          Name: v.name,
          Phone: [...new Set([...(v.phone_list ?? []), ...(v.dispatchPhones ?? []), ...(v.contactPhones ?? []), v.contactPhone].filter(Boolean))],
          Email: v.email ?? (v.companyEmails ?? [])[0] ?? v.contactEmail ?? '',
          City: v.city ?? v.hqCity,
          State: v.state ?? v.hqState,
          'Primary trade': v.primaryTrade,
          'Secondary trades': v.secondaryTrades,
          Status: v.status,
          'Brand source': v.brandSource,
          Priority: v.priority,
          'Legal business name': v.legalBusinessName,
          DBA: v.dbaName,
          Statewide: v.stateWide,
          Nationwide: v.nationWide,
          'Coverage states': v.coverageStates,
          'Max travel radius': v.maxTravelRadius,
          'Emergency same day': v.emergencySameDay,
          'After hours': v.afterHours,
          Weekends: v.weekends,
          'Holiday emergency': v.holidayEmergency,
          'Estimated response time': v.estimatedResponseTime,
          'Regular hourly rate': v.regularHourlyRate,
          'After hours rate': v.afterHoursRate,
          'Weekend emergency rate': v.weekendEmergencyRate,
          'Trip charge': v.tripCharge,
          'Diagnostic fee': v.diagnosticFee,
          'Minimum charge': v.minimumCharge,
          'Payment methods': v.paymentMethods,
          'Accepts payment after 30 days': v.acceptsPaymentAfter30Days,
          'Primary contact name': v.primaryContactName,
          'Primary contact role': v.primaryContactRole,
          'Dispatch phone': v.dispatchPhone,
          'Billing email': v.billingEmail,
          'W9 received': tri(v.w9Received),
          'MSA signed': tri(v.msaSigned),
          'COI received': tri(v.coiReceived),
          Notes: v.notes,
          'Coverage cities': v.coverageCities,
          'Coverage area': v.coverageArea,
          'Zip codes': v.zipCodes,
          'Commercial experience': v.commercialExperience,
          'License number': v.licenseNumber ?? v.plumbingLicenseNumber ?? v.hvacLicenseNumber ?? v.electricalLicenseNumber,
          'Folder link': v.folderLink,
        }));
      });

  // ── Tech Locator technicians ───────────────────────────────────────────────
  const techRows = !techUrl
    ? []
    : await readOnly(techUrl, async (client) => {
        const has = await client.query(`SELECT to_regclass('public.csv_tech') IS NOT NULL AS yes`);
        if (!has.rows[0].yes) return [];
        const techs = await client.query(`
          SELECT t.id, t.name, t.phone_number, t.is_subcontractor,
                 (SELECT array_agg(DISTINCT tr.trade) FROM csv_tech_trade tr WHERE tr.tech_id = t.id) AS trades,
                 (SELECT l.city FROM csv_tech_location l WHERE l.tech_id = t.id ORDER BY l.id LIMIT 1) AS city,
                 (SELECT l.state FROM csv_tech_location l WHERE l.tech_id = t.id ORDER BY l.id LIMIT 1) AS state,
                 (SELECT array_agg(DISTINCT d.dispatcher_name) FROM csv_tech_dispatcher d WHERE d.tech_id = t.id) AS dispatchers
            FROM csv_tech t
           ORDER BY t.id`);
        return techs.rows.map((t) => ({
          Name: t.name,
          Phone: t.phone_number,
          City: t.city,
          State: t.state,
          'Primary trade': (t.trades ?? [])[0] ?? '',
          'Secondary trades': (t.trades ?? []).slice(1),
          Subcontractor: t.is_subcontractor,
          Notes: (t.dispatchers ?? []).length ? `Tech Locator dispatchers: ${(t.dispatchers ?? []).join(', ')}` : '',
        }));
      });

  fs.mkdirSync(outDir, { recursive: true });
  const vFiles = vendorRows.length ? writeChunks('vr-crm-vendors', Object.keys(vendorRows[0]), vendorRows) : [];
  const tFiles = techRows.length ? writeChunks('tech-locator-techs', Object.keys(techRows[0]), techRows) : [];

  const noPhone = (rows) => rows.filter((r) => !(Array.isArray(r.Phone) ? r.Phone.length : r.Phone)).length;
  console.log(`Folder: ${outDir}`);
  console.log(`VR - CRM vendors:         ${vendorRows.length} rows in ${vFiles.length} file(s) (${noPhone(vendorRows)} without a phone)`);
  console.log(`Tech Locator technicians: ${techRows.length} rows in ${tFiles.length} file(s) (${noPhone(techRows)} without a phone)`);
  console.log('Nothing was written to either database. Load the files at /vendors/import: vendors as "Vendors", technicians as "Technicians".');
} catch (err) {
  // Never echo a connection string: print the message only.
  console.error('Export failed:', err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/gi, '<database>') : 'unknown error');
  process.exitCode = 1;
}

/* UAT round 1, Wave D (migration 0086) — data quality and UI.
 *
 * Hermetic: pure functions from packages/shared and source-text pins on the
 * API and web files that enforce them. No database, no network. The decisions
 * are #11, #22, M2, M10, M11, M14–M17, M21, M23, M25–M27, M30, M32, #9,
 * L1–L6 in docs/specs/uat-round-1.md. */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_NOT_ON_FILE_CODE,
  HISTORY_FIELD_KEYS,
  NO_VISIT_EXCLUDED_STATUSES,
  NO_VISIT_STATUS_GROUPS,
  PM_ALREADY_RAISED_CODE,
  addedAssignees,
  assigneeNames,
  auditTimeET,
  auditTimestampET,
  clientKey,
  dateFloorProblem,
  dateOrderProblem,
  enrolmentSentence,
  integrationState,
  matchClientRecord,
  matchOption,
  mayRestoreFromTrash,
  normalizeUsState,
  quoteTermsFromTotals,
  quoteTotalTerms,
  reportedSentence,
  superAdminAskSentence,
  woNumberProblem,
} from '../packages/shared/src/dataQuality';
import { contractsOverlap, rateVersionAsOf, type ContractScope } from '../packages/shared/src/contracts';
import { INTAKE_FORM_FIELDS, intakeDraftMissing } from '../packages/shared/src/intakeDrafts';
import { DISPATCHER_ROLE_CODES } from '../packages/shared/src/access';
import { docsContent } from '../packages/shared/src/docs';

const APP = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(APP, ...p), 'utf8').replace(/\r\n/g, '\n');

// ── #11 · one client list ─────────────────────────────────────────────────────

describe('#11 — the Client is a client record', () => {
  const records = [
    { name: 'Walmart', is_active: true },
    { name: '7-Eleven', is_active: true },
    { name: 'Old Co', is_active: false },
  ];
  it('matches case and outer spaces and returns the record’s spelling', () => {
    expect(matchClientRecord('  walMART ', records)).toBe('Walmart');
    expect(clientKey(' 7-ELEVEN ')).toBe('7-eleven');
  });
  it('refuses free text and inactive records', () => {
    expect(matchClientRecord('Wal-Mart', records)).toBeNull();
    expect(matchClientRecord('Old Co', records)).toBeNull();
    expect(matchClientRecord('', records)).toBeNull();
  });
  it('is checked on every write path (field editor, bulk, create, intake, PM, import)', () => {
    const rules = read('apps', 'api', 'src', 'services', 'dataRules.ts');
    expect(rules).toContain('CLIENT_NOT_ON_FILE_CODE');
    expect(rules).toContain('export async function canonicalClient');
    expect(read('apps', 'api', 'src', 'services', 'woFieldValues.ts')).toContain('await checkFieldValue(f, coerceValue(f, raw))');
    const bulk = read('apps', 'api', 'src', 'services', 'woBulk.ts');
    expect(bulk).toContain("canonicalClient(patch.client, 'client')");
    expect(bulk).toContain('IMPORT_UNKNOWN_CLIENT_CODE');
    expect(read('apps', 'api', 'src', 'services', 'woCreate.ts')).toContain('validateBagValues(bag)');
    expect(read('apps', 'api', 'src', 'services', 'intake.ts')).toContain('validateBagValues(typed)');
    expect(read('apps', 'api', 'src', 'services', 'plannedMaintenance.ts')).toContain("canonicalClient(input.client ?? null, 'client')");
    expect(CLIENT_NOT_ON_FILE_CODE).toBe('CLIENT_NOT_ON_FILE');
  });
  it('the dropdowns read the client records', () => {
    expect(read('apps', 'api', 'src', 'services', 'woFields.ts')).toContain('FROM client WHERE deleted_at IS NULL AND is_active');
    expect(read('apps', 'api', 'src', 'services', 'woCreate.ts')).toContain('FROM client WHERE deleted_at IS NULL AND is_active');
  });
  it('0086 and the seed adopt every client name the same way, and the ingest adopts new ones', () => {
    const mig = read('packages', 'db', 'migrations', '0086_uat_data.sql');
    const seed = read('packages', 'db', 'src', 'seed.ts');
    for (const src of [mig, seed]) {
      expect(src).toContain('INSERT INTO client (name)');
      expect(src).toContain('SELECT client FROM pm_schedule');
    }
    expect(mig).not.toMatch(/^\s*(BEGIN|COMMIT)\b/im);
    expect(mig).not.toMatch(/CONCURRENTLY/i);
    const ingest = read('apps', 'api', 'src', 'modules', 'integrations', 'ecotrak', 'ingest.ts');
    expect(ingest).toContain('await adoptClientsFromRecords()');
  });
});

// ── #22 / M22 · dispatchers only ──────────────────────────────────────────────

describe('#22 / M22 — assignees are dispatchers', () => {
  it('a draft needs its Client', () => {
    expect(INTAKE_FORM_FIELDS.find((f) => f.key === 'Client')?.required).toBe(true);
    expect(intakeDraftMissing({ wo_number: 'WO-1', fields: {} })).toContain('Client');
  });
  it('only names being ADDED to the seat are checked', () => {
    expect(addedAssignees('Ana, Bo', 'bo, Cy')).toEqual(['Cy']);
    expect(addedAssignees(null, 'Ana')).toEqual(['Ana']);
    expect(assigneeNames(' Ana ,, Bo ')).toEqual(['Ana', 'Bo']);
  });
  it('the API asks for a dispatcher role on every assignment path', () => {
    const rules = read('apps', 'api', 'src', 'services', 'dataRules.ts');
    expect(rules).toContain('role = ANY($1::text[])');
    expect(rules).toContain('DISPATCHER_ROLE_CODES');
    for (const f of ['intake.ts', 'approvals.ts', 'woCreate.ts', 'woBulk.ts', 'plannedMaintenance.ts', 'maintenance.ts', 'woFieldValues.ts']) {
      expect(read('apps', 'api', 'src', 'services', f), f).toContain('assertDispatchers');
    }
    expect(DISPATCHER_ROLE_CODES).toEqual(['om_probation', 'om', 'senior_om']);
  });
  it('the pickers and the availability list offer dispatchers only', () => {
    expect(read('apps', 'api', 'src', 'services', 'principals.ts')).toContain('AND p.role = ANY($2::text[])');
    expect(read('apps', 'web', 'src', 'pages', 'IntakePage.tsx')).toContain("p.kind === 'human' && isDispatcherRole(p.role)");
    expect(read('apps', 'web', 'src', 'components', 'wo', 'list', 'CreateWorkOrderDialog.tsx')).toContain("p.kind === 'human' && isDispatcherRole(p.role)");
    expect(read('apps', 'web', 'src', 'pages', 'ApprovalsPage.tsx')).not.toContain("'Everyone else'");
  });
});

// ── M2 · field values ─────────────────────────────────────────────────────────

describe('M2 — values are checked for their type', () => {
  it('WO # is letters, digits and dashes, 3 to 40', () => {
    expect(woNumberProblem('WO-1234')).toBeNull();
    expect(woNumberProblem('ab')).not.toBeNull();
    expect(woNumberProblem('WO 1234')).not.toBeNull();
    expect(woNumberProblem('x'.repeat(41))).not.toBeNull();
    expect(woNumberProblem('')).toBe('A work order needs its WO #');
  });
  it('a State is a US code, stored upper-case', () => {
    expect(normalizeUsState(' tx ')).toBe('TX');
    expect(normalizeUsState('DC')).toBe('DC');
    expect(normalizeUsState('Texas')).toBeNull();
    expect(normalizeUsState('ZZ')).toBeNull();
  });
  it('no date before 2000, and Received on ≤ Due date', () => {
    expect(dateFloorProblem('Due Date', '1999-12-31')).not.toBeNull();
    expect(dateFloorProblem('Due Date', '2026-01-01T09:00')).toBeNull();
    expect(dateOrderProblem('2026-10-10T09:00', '2026-10-09T09:00')).not.toBeNull();
    expect(dateOrderProblem('2026-10-10T09:00', '2026-10-10T09:00')).toBeNull();
    expect(dateOrderProblem('2026-10-10', null)).toBeNull();
  });
  it('a dropdown value is one of its options, in the option’s spelling', () => {
    expect(matchOption(['HVAC', 'Plumbing'], ' hvac ')).toBe('HVAC');
    expect(matchOption(['HVAC'], 'Roofing')).toBeNull();
  });
  it('the API refuses negative money and unknown options with 400 VALIDATION naming the field', () => {
    const rules = read('apps', 'api', 'src', 'services', 'dataRules.ts');
    expect(rules).toContain('cannot be negative');
    expect(rules).toContain("f.subtype === 'dropdown'");
    expect(rules).toContain("{ code: VALIDATION_CODE, field: field.key");
    // Only what is being written: the date order is asked when a date is in the patch.
    expect(rules).toContain('if (!touched.includes(RECEIVED_ON_KEY) && !touched.includes(DUE_DATE_KEY)) return;');
    expect(read('apps', 'api', 'src', 'services', 'woCreate.ts')).toContain('woNumberProblem(woNumber)');
  });
});

// ── M10 · Raise now ───────────────────────────────────────────────────────────

describe('M10 — Raise now raises the upcoming occurrence once', () => {
  it('refuses while an occurrence on or after today already has its work order', () => {
    const pm = read('apps', 'api', 'src', 'services', 'plannedMaintenance.ts');
    expect(pm).toContain("o.status = 'raised' AND o.due_on >= $2::date");
    expect(pm).toContain('code: PM_ALREADY_RAISED_CODE');
    expect(PM_ALREADY_RAISED_CODE).toBe('PM_ALREADY_RAISED');
  });
});

// ── M11 · No visit logged ─────────────────────────────────────────────────────

describe('M11 — "No visit logged" counts live work only', () => {
  it('excludes done / closed groups and the billing status filed as active (T9: future work by Scheduled Date, tests/uat-followups.test.ts)', () => {
    expect(NO_VISIT_STATUS_GROUPS).toEqual(['open', 'active', 'pending']);
    expect(NO_VISIT_EXCLUDED_STATUSES).toContain('Invoiced Not Paid');
    const dash = read('apps', 'web', 'src', 'pages', 'DashboardPage.tsx');
    expect(dash).toContain('noVisitLoggedFilter()');
  });
});

// ── M14 · photo approval in the viewer ────────────────────────────────────────

describe('M14 — Approve / Decline only in the full-size viewer', () => {
  it('the API asks for viewed: true and has no maker ≠ checker on photos', () => {
    const svc = read('apps', 'api', 'src', 'services', 'attachments.ts');
    expect(svc).toContain('if (input.viewed !== true)');
    expect(svc).toContain('ATTACHMENT_NOT_VIEWED_CODE');
    expect(svc).not.toContain('SELF_APPROVAL');
  });
  it('the card opens the viewer; the viewer steps with the arrow keys and sends viewed', () => {
    const card = read('apps', 'web', 'src', 'components', 'wo', 'PhotosCard.tsx');
    expect(card).toContain('<PhotoReviewViewer');
    expect(card).not.toContain("onDecide({ decision: 'approve'");
    const viewer = read('apps', 'web', 'src', 'components', 'wo', 'PhotoReviewViewer.tsx');
    expect(viewer).toContain("e.key === 'ArrowRight'");
    expect(viewer).toContain("e.key === 'ArrowLeft'");
    expect(viewer).toContain('viewed: true');
    expect(read('apps', 'web', 'src', 'components', 'wo', 'InvoiceCard.tsx')).toContain('<ApprovedPhotosStrip');
  });
});

// ── M15 / M16 / M17 ───────────────────────────────────────────────────────────

describe('M15 — integrations say their connection state', () => {
  it('On · set up, On · not set up, Off', () => {
    expect(integrationState({ enabled: true, configured: true }).label).toBe('On · set up');
    expect(integrationState({ enabled: true, configured: false }).label).toBe('On · not set up');
    expect(integrationState({ enabled: false, configured: true }).label).toBe('Off');
  });
});

describe('M16 — the Access row says what sign-in does', () => {
  it('names the domain and the auto-enrol role', () => {
    expect(enrolmentSentence(['byblosvista.com'], 'OM Under Probation')).toBe(
      '@byblosvista.com accounts enrol themselves as OM Under Probation on first sign-in; anyone else by invitation (Admin › Users)',
    );
    expect(enrolmentSentence([], 'x')).toContain('Invitation only');
    expect(read('apps', 'api', 'src', 'services', 'adminMeta.ts')).toContain('config.signIn.allowedDomains');
  });
});

describe('M17 — Restore needs the delete right (or Trash edit)', () => {
  it('reads both grants', () => {
    const set = (role: Record<string, Record<string, boolean>>) => ({ role, overrides: {} });
    expect(mayRestoreFromTrash(set({ work_orders: { delete: true } }), false)).toBe(true);
    expect(mayRestoreFromTrash(set({ 'admin/trash': { edit: true } }), false)).toBe(true);
    expect(mayRestoreFromTrash(set({ work_orders: { view: true } }), false)).toBe(false);
    expect(mayRestoreFromTrash(set({}), true)).toBe(true);
    expect(read('apps', 'api', 'src', 'routes', 'admin.ts')).toContain('mayRestoreFromTrash(subject.perms, subject.isSuperAdmin)');
    expect(read('apps', 'web', 'src', 'pages', 'admin', 'AdminSections.tsx')).not.toContain('The app has no delete action yet');
  });
});

// ── M21 / M23 / M25 / M26 / M27 ───────────────────────────────────────────────

describe('UI pins', () => {
  it('M21 — header chips follow the viewer’s rights', () => {
    const h = read('apps', 'web', 'src', 'components', 'wo', 'WoHeader.tsx');
    expect(h).toContain('{seesCost && <WorthCell label="Cost" value={m.cost} />}');
    expect(h).toContain('{ecotrakLabel && movesStatus && (');
  });
  it('M23 — the Receivables Audit tab is hidden and the Elise column gone', () => {
    const r = read('apps', 'web', 'src', 'pages', 'ReceivablesPage.tsx');
    expect(r).toContain('const AUDIT_TAB_ENABLED = false;');
    expect(r).not.toContain('<th className="rcv-ck-th">Elise</th>');
  });
  it('M25 — two NTE lanes in Approvals', () => {
    const a = read('apps', 'web', 'src', 'pages', 'ApprovalsPage.tsx');
    expect(a).toContain("nte: 'NTE override (cost over NTE)'");
    expect(a).toContain('NTE increase requests');
    expect(read('apps', 'api', 'src', 'routes', 'woRecord.ts')).toContain("app.get('/nte-requests'");
  });
  it('M26 — Generate sheet is gated on CICO edit', () => {
    const s = read('apps', 'api', 'src', 'services', 'signoff.ts');
    expect(s).toContain("const CICO_SECTION_KEY = 'work_orders/fields/cico';");
    expect(s).toContain('can: { generate: canGenerate(actor), share: writable }');
  });
  it('M27 — no Markup column on the printed quote', () => {
    const q = read('apps', 'web', 'src', 'pages', 'QuotePrintPage.tsx');
    expect(q).not.toContain('<th className="num">Markup</th>');
  });
});

// ── M30 / M32 · rate cards ────────────────────────────────────────────────────

describe('M30 — rates as they stood when the work order was received', () => {
  const v1 = { effective_from: null, rates: [{ id: 'a', rate_type: 'standard' as const, trade: null, amount: 90, position: 0 }] };
  const v2 = { effective_from: '2026-10-01', rates: [{ id: 'b', rate_type: 'standard' as const, trade: null, amount: 120, position: 0 }] };
  it('an older work order keeps the old version; a newer one takes the edit', () => {
    expect(rateVersionAsOf([v1, v2], '2026-09-15')?.rates[0].amount).toBe(90);
    expect(rateVersionAsOf([v1, v2], '2026-10-01')?.rates[0].amount).toBe(120);
    expect(rateVersionAsOf([], '2026-10-01')).toBeNull();
  });
  it('the API picks by date received and versions every rate edit', () => {
    const c = read('apps', 'api', 'src', 'services', 'contracts.ts');
    expect(c).toContain('pickContract(candidates, subject, asOf)');
    expect(c).not.toContain('pickContract(candidates, subject, today())');
    expect(c).toContain('INSERT INTO contract_rate_version');
    expect(read('apps', 'api', 'src', 'services', 'quotes.ts')).toContain('contractForTask(taskId, { contractId: q.contract_id })');
    expect(read('packages', 'db', 'migrations', '0086_uat_data.sql')).toContain('CREATE TABLE IF NOT EXISTS contract_rate_version');
  });
});

describe('M32 — overlapping rate cards are refused', () => {
  const base: ContractScope = {
    party: 'client', vendor_name: null, client: 'Walmart', billing_entity: null,
    sites_covered: [], trades_covered: ['HVAC'], starts_on: '2026-01-01', ends_on: null, active: true,
  };
  it('same scope and overlapping dates clash', () => {
    expect(contractsOverlap(base, { ...base, starts_on: '2026-06-01' })).toBe(true);
    expect(contractsOverlap(base, { ...base, trades_covered: ['hvac', 'Plumbing'] })).toBe(true);
  });
  it('a different specificity, client, window or an inactive card does not', () => {
    expect(contractsOverlap(base, { ...base, trades_covered: [] })).toBe(false);
    expect(contractsOverlap(base, { ...base, client: 'Target' })).toBe(false);
    expect(contractsOverlap({ ...base, ends_on: '2026-05-31' }, { ...base, starts_on: '2026-06-01' })).toBe(false);
    expect(contractsOverlap(base, { ...base, active: false })).toBe(false);
    expect(contractsOverlap(base, { ...base, party: 'vendor', vendor_name: 'X' })).toBe(false);
  });
  it('the API refuses with 409 CONTRACT_OVERLAP on create and edit', () => {
    const c = read('apps', 'api', 'src', 'services', 'contracts.ts');
    expect(c).toContain('code: CONTRACT_OVERLAP_CODE');
    expect(c.match(/await assertNoOverlap\(/g)?.length).toBe(2);
  });
});

// ── #9 · the quote total adds up ──────────────────────────────────────────────

describe('#9 — every term of the Grand Total is on screen', () => {
  it('Yoda: incurred + the priced option + sales tax + line tax = Grand Total', () => {
    const r = quoteTotalTerms({
      rule: 'incurred_plus_option',
      incurred: 100,
      options: [{ id: 'a', label: 'Option A', total: 400, included: true }],
      priced_id: 'a',
      sales_tax: 41.25,
      sales_tax_pct: 8.25,
      line_tax: 5,
      grand_total: 546.25,
    });
    expect(r.terms.map((t) => t.label)).toEqual(['Incurred work', 'Option A lines', 'Sales tax 8.25%', 'Line tax']);
    expect(r.sum).toBe(546.25);
    expect(r.adds_up).toBe(true);
  });
  it('RULE B: the included options + line tax', () => {
    const r = quoteTotalTerms(
      quoteTermsFromTotals({
        total_rule: 'options_only',
        incurred_subtotal: 99,
        option_totals: [
          { section_id: 'a', label: 'Option A', total: 200, include_in_summary: true },
          { section_id: 'b', label: 'Option B', total: 50, include_in_summary: false },
        ],
        priced_section_id: null,
        sales_tax: 0,
        sales_tax_pct: 0,
        line_tax: 0,
        grand_total: 200,
      }),
    );
    expect(r.terms).toEqual([{ label: 'Option A lines', amount: 200 }]);
    expect(r.adds_up).toBe(true);
  });
  it('the rail and the Client quote card draw it', () => {
    expect(read('apps', 'web', 'src', 'components', 'quote', 'MoneyRail.tsx')).toContain('<QuoteTerms');
    expect(read('apps', 'web', 'src', 'components', 'wo', 'ClientQuoteCard.tsx')).toContain('<QuoteTerms input={quoteTermsFromTotals(quote.totals)}');
  });
});

// ── L1–L6 ─────────────────────────────────────────────────────────────────────

describe('L1 — "Tech reported that Tech found…"', () => {
  it('prefixes only a narrative that does not already say who reported it', () => {
    expect(reportedSentence('the freezer was stuck in defrost')).toBe('Tech reported that the freezer was stuck in defrost');
    expect(reportedSentence('Tech found a failed compressor')).toBe('Tech found a failed compressor');
    expect(reportedSentence('tech reported that the door sticks')).toBe('Tech reported that the door sticks');
    expect(reportedSentence('The technician noted rust')).toBe('The technician noted rust');
    expect(read('apps', 'api', 'src', 'services', 'quotes.ts')).toContain('reportedSentence(section.narrative_reported)');
  });
});

describe('L2 — audit times in Eastern time, labelled ET', () => {
  it('formats in America/New_York whatever the machine zone', () => {
    expect(auditTimeET('2026-10-15T18:05:09Z')).toBe('Oct 15 · 14:05 ET');
    expect(auditTimeET('2026-01-15T05:30:00Z')).toBe('Jan 15 · 00:30 ET');
    expect(auditTimestampET('2026-10-15T18:05:09Z')).toBe('2026-10-15 14:05:09 ET');
    expect(read('apps', 'api', 'src', 'services', 'auditLog.ts')).toContain("'Time (ET)'");
  });
});

describe('L3 — history fields are the system’s', () => {
  it('Previous Assignees is refused on every hand write, and drawn read-only', () => {
    expect(HISTORY_FIELD_KEYS).toContain('Previous Assignees');
    expect(read('apps', 'api', 'src', 'services', 'woFieldValues.ts')).toContain('assertNotHistoryField(');
    expect(read('apps', 'api', 'src', 'services', 'woBulk.ts')).toContain('assertNotHistoryField(customPatch.map((c) => c.key))');
    expect(read('apps', 'web', 'src', 'components', 'wo', 'fieldEdit.tsx')).toContain('...HISTORY_FIELD_KEYS');
  });
});

describe('L4 — the lock message names the super admins on file', () => {
  it('reads them from the API, not a list in the code', () => {
    expect(superAdminAskSentence(['Ana', 'Bo', 'Cy'])).toBe('Ask a super admin — Ana, Bo or Cy — if you need access.');
    expect(superAdminAskSentence([])).toBe('Ask a super admin if you need access.');
    const shell = read('apps', 'web', 'src', 'pages', 'admin', 'AdminShell.tsx');
    expect(shell).not.toContain('Elise, Jordan, Jeff or Jack');
    expect(read('apps', 'api', 'src', 'routes', 'principals.ts')).toContain("'/principals/super-admins'");
  });
  it('the documentation registry no longer hard-codes the names', () => {
    const text = JSON.stringify(docsContent());
    expect(text).not.toContain('Elise, Jordan, Jeff or Jack');
    expect(text).not.toContain('Elise, Jordan Brown, Jeff S, Jack');
  });
});

describe('L5 — the BRD / SOP registry is served, not bundled', () => {
  const webSrc = join(APP, 'apps', 'web', 'src');
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) files.push(p);
    }
  };
  walk(webSrc);
  it('no web file imports a registry value from shared', () => {
    const banned = /\b(BRD_PARTS|BRD_MODULES|BUSINESS_RULES|DOCS_REVIEWED_ON|brdMarkdown|sopMarkdown|lifecycleMarkdown|docsVersionLine|docsContent)\b/;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const imports = src.match(/import\s+(?!type\b)[^;]*?from\s+'@theone\/shared'/gs) ?? [];
      for (const imp of imports) {
        expect(banned.test(imp) || /\b(SOP|LIFECYCLE)\b/.test(imp), `${f}: ${imp}`).toBe(false);
      }
    }
  });
  it('the API serves it behind admin/docs and the page is lazy-loaded', () => {
    const r = read('apps', 'api', 'src', 'routes', 'adminDocs.ts');
    expect(r).toContain("app.get('/admin/docs/content'");
    expect(r).toContain('realUser(req);');
    expect(read('apps', 'web', 'src', 'App.tsx')).toContain("lazy(() => import('./pages/admin/AdminDocsPage')");
    expect(JSON.parse(read('packages', 'shared', 'package.json')).sideEffects).toBe(false);
  });
  it('when a build exists, the main chunk does not carry the BRD prose', () => {
    const dist = join(APP, 'apps', 'web', 'dist', 'assets');
    if (!existsSync(dist)) return;
    const main = readdirSync(dist).filter((n) => /^index-.*\.js$/.test(n));
    // A sentence that lives only in the registry (docs/brd/insight.ts).
    const sentence = 'whose Visit Type is not set and whose Scheduled Date is empty';
    expect(JSON.stringify(docsContent())).toContain(sentence);
    for (const n of main) expect(readFileSync(join(dist, n), 'utf8').includes(sentence), n).toBe(false);
  });
});

describe('L6 — one label set for the quote acts', () => {
  it('Send to client · Record client decision', () => {
    const b = read('apps', 'web', 'src', 'pages', 'QuoteBuilderPage.tsx');
    expect(b).toContain("const CLIENT_DECISION_LABEL = 'Record client decision';");
    expect(b).toContain("gated('Send to client'");
    // 2026-10-27: the manager's Approve became the one-click Send to client.
    expect(b).not.toContain("gated('Approve'");
    expect(b).not.toContain("'Client chose this'");
  });
});

describe('the list margin follows the record', () => {
  it('margin_pct on the list is the record’s figure', () => {
    expect(read('apps', 'api', 'src', 'services', 'workOrders.ts')).toContain('recordMarginPct(items.map((i) => i.id), actor)');
    expect(read('apps', 'api', 'src', 'services', 'woRecord.ts')).toContain('export async function recordMarginPct');
  });
});

/* UAT round 1 follow-up tickets T1, T4, T5, T6, T9 (docs/specs/uat-round-1.md,
 * "Follow-up tickets").
 *
 * Hermetic: pure functions from packages/shared and apps/api/src/lib, the
 * audit WHERE builder (pure), the test sign-in service driven against a
 * scripted `query` (no pool is ever created), and source-text pins on the
 * API and web files that enforce them. No database, no network. */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NO_VISIT_EXCLUDED_STATUSES,
  NO_VISIT_STATUS_GROUPS,
  noVisitLoggedFilter,
} from '../packages/shared/src/dataQuality';
import {
  OVER_QUOTE_CODE,
  paymentLockReason,
  quoteSelfApprovalLock,
} from '../packages/shared/src/moneyGuards';
import { orderByMargin, recordMarginFrom } from '../packages/shared/src/woRecord';
import {
  TEST_ACCOUNT_ADMIN_CODE,
  TEST_ACCOUNT_EMAIL_DOMAIN,
  TEST_LOGIN_MAX_FAILURES,
  TEST_LOGIN_WINDOW_MS,
  isTestAccountEmail,
  testAccountDisplayName,
  testAccountEmail,
  testAccountRoleAllowed,
} from '../packages/shared/src/testAccounts';
import {
  AttemptLimiter,
  testPasswordFingerprint,
  testPasswordMatches,
  testSessionAllowed,
} from '../apps/api/src/lib/testAccountAuth';
import { testAccountsFromEnv } from '../apps/api/src/config';
import { buildAuditWhere, visibleAuditFields } from '../apps/api/src/services/auditLog';
import { testAccountAdminWriteBlocked } from '../apps/api/src/plugins/authGuard';

const ROOT = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

vi.mock('../apps/api/src/db', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  exec: vi.fn(),
  getPool: () => {
    throw new Error('no database in tests');
  },
  closePool: vi.fn(),
}));

// ── T4 · Margin % sorts on the figure it shows ───────────────────────────────

describe('T4 — Margin % sorts by the record’s own figure', () => {
  const rows = [
    { id: 'a', rank: 1, margin: 10 },
    { id: 'b', rank: 1, margin: null },
    { id: 'c', rank: 1, margin: 35.5 },
    { id: 'd', rank: 1, margin: -4 },
    { id: 'e', rank: 1, margin: 10 },
  ];

  it('orders by the margin, empty cells last in both directions, ties keep their order', () => {
    expect(orderByMargin(rows, 'desc')).toEqual(['c', 'a', 'e', 'd', 'b']);
    expect(orderByMargin(rows, 'asc')).toEqual(['d', 'a', 'e', 'c', 'b']);
  });

  it('keeps the group / breach rank ahead of the margin', () => {
    const grouped = [
      { id: 'x', rank: 2, margin: 90 },
      { id: 'y', rank: 1, margin: 5 },
      { id: 'z', rank: 1, margin: 50 },
    ];
    expect(orderByMargin(grouped, 'desc')).toEqual(['z', 'y', 'x']);
  });

  it('one formula: revenue = invoices sent, else the quote; cost = Cost, else bills, else payment requests', () => {
    expect(recordMarginFrom({ invoiced: 1000, quoteTotal: 5000, cost: 600, billsTotal: 900, paymentsRequested: 50 })).toEqual({
      revenue: 1000,
      jobCost: 600,
      profit: 400,
      margin_pct: 40,
    });
    expect(recordMarginFrom({ invoiced: null, quoteTotal: 800, cost: null, billsTotal: 200, paymentsRequested: 50 }).margin_pct).toBe(75);
    expect(recordMarginFrom({ invoiced: null, quoteTotal: 800, cost: null, billsTotal: null, paymentsRequested: 200 }).margin_pct).toBe(75);
    expect(recordMarginFrom({ invoiced: null, quoteTotal: 800, cost: null, billsTotal: null, paymentsRequested: 0 }).margin_pct).toBeNull();
    expect(recordMarginFrom({ invoiced: null, quoteTotal: null, cost: 10, billsTotal: null, paymentsRequested: 0 }).margin_pct).toBeNull();
    // A zero revenue has no margin (not a division by zero).
    expect(recordMarginFrom({ invoiced: 0, quoteTotal: 800, cost: 10, billsTotal: null, paymentsRequested: 0 }).margin_pct).toBeNull();
  });

  it('the record and the list read that one formula', () => {
    const rec = read('apps', 'api', 'src', 'services', 'woRecord.ts');
    expect(rec.match(/recordMarginFrom\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(rec).toContain('export async function recordMarginPct(');
    // Batched: one read per kind of money record, not loadTask + loadMoney per row.
    expect(rec).toContain('WHERE pr.task_id = ANY($1::uuid[])');
    expect(rec).toContain('quoteTotalsFor(');
  });

  it('the list sorts margin_pct with it up to MARGIN_SORT_MAX rows, and says when it fell back to the SQL figure', () => {
    const wo = read('apps', 'api', 'src', 'services', 'workOrders.ts');
    expect(wo).toContain("f.sort?.field === 'margin_pct'");
    expect(wo).toContain('orderByMargin(');
    expect(wo).toContain('export const MARGIN_SORT_MAX = 500;');
    expect(wo).not.toContain('MARGIN_SORT_TOO_LARGE');
    expect(wo).toContain("margin_sort: 'sql'");
    expect(wo).toContain("margin_sort: 'record'");
    // "Select all" (and so bulk edit / export by ids) orders as the list does.
    expect(wo).toMatch(/export async function listMatchingIds[\s\S]*?marginOrderedIds\(/);
    expect(read('apps', 'web', 'src', 'pages', 'WorkOrdersPage.tsx')).toContain("margin_sort === 'sql'");
  });
});

// ── T5 · lock before the click ───────────────────────────────────────────────

describe('T5a — a payment that would pass the approved quote is drawn locked', () => {
  const base = {
    status: 'requested' as const,
    overQuoteOpen: false,
    nteOverrideOpen: false,
    cost: 400,
    amount: 300,
    nte: 2000,
    nteCovers: null,
    quote: { total: 1000, cost: 600 },
    quoteCovers: null,
  };

  it('names the over-quote hold the click would raise', () => {
    expect(paymentLockReason(base)).toMatch(/approved quote's cost of \$600\.00/);
    expect(paymentLockReason({ ...base, amount: 700 })).toMatch(/negative margin/);
  });

  it('is silent under the quote, when a manager already covered it, or with no approved quote', () => {
    expect(paymentLockReason({ ...base, amount: 100 })).toBeNull();
    expect(paymentLockReason({ ...base, quoteCovers: 700 })).toBeNull();
    expect(paymentLockReason({ ...base, quote: null })).toBeNull();
  });

  it('an open hold wins, and only a waiting request is ever locked', () => {
    expect(paymentLockReason({ ...base, overQuoteOpen: true, amount: 1 })).toMatch(/On hold/);
    expect(paymentLockReason({ ...base, status: 'paid' })).toBeNull();
    expect(paymentLockReason({ ...base, status: 'rejected' })).toBeNull();
  });

  it('keeps the NTE projection it had before', () => {
    expect(paymentLockReason({ ...base, quote: null, nte: 500 })).toMatch(/over the client NTE/);
    expect(paymentLockReason({ ...base, quote: null, nte: 500, nteOverrideOpen: true })).toBeNull();
    expect(paymentLockReason({ ...base, quote: null, nte: 500, nteCovers: 800 })).toBeNull();
  });

  it('the queue reads every approved quote in one batch, the API refusal stays OVER_QUOTE', () => {
    const pay = read('apps', 'api', 'src', 'services', 'payments.ts');
    expect(pay).toContain('bindableQuoteFiguresFor(');
    expect(pay).toContain('AS quote_covers');
    expect(pay).toContain('paymentLockReason(');
    const quotes = read('apps', 'api', 'src', 'services', 'quotes.ts');
    expect(quotes).toContain('export function bindableQuoteFiguresFor(');
    expect(quotes).toContain('WHERE s.quote_id = ANY($1::uuid[])');
    expect(OVER_QUOTE_CODE).toBe('OVER_QUOTE');
  });

  it('a single request read or returned by a move carries the same lock (one batched read for its work order)', () => {
    const pay = read('apps', 'api', 'src', 'services', 'payments.ts');
    expect(pay).toContain('async function mapOne(');
    // The one `return mapPayment(` left is mapOne's own.
    expect(pay.match(/return mapPayment\(/g)).toHaveLength(1);
    expect(pay).toMatch(/async function mapOne[^\n]*\n\s*return mapPayment\(r, opts, await quoteFiguresFor\(\[r\]\)\)/);
    expect(pay).not.toMatch(/mapPayment\(await loadRow/);
    expect(pay).toMatch(/export async function getPaymentRequest[\s\S]*?return mapOne\(/);
  });
});

describe('T5 — the quote SELECT is one base plus a WHERE, never string surgery', () => {
  it('quoteSql builds base + WHERE + tail', async () => {
    const { quoteSql, QUOTE_BASE_SQL } = await import('../apps/api/src/services/quotes');
    const one = quoteSql('q.task_id = $1', 'LIMIT 1');
    expect(one.startsWith(QUOTE_BASE_SQL)).toBe(true);
    expect(one.trim().endsWith('WHERE q.task_id = $1\n   LIMIT 1')).toBe(true);
    expect(quoteSql('q.task_id = ANY($1::uuid[])')).toMatch(/WHERE q\.task_id = ANY\(\$1::uuid\[\]\)\s*$/);
    expect(QUOTE_BASE_SQL).not.toMatch(/\bWHERE\b/);
  });

  it('no caller rewrites the SQL text', () => {
    const quotes = read('apps', 'api', 'src', 'services', 'quotes.ts');
    expect(quotes).not.toContain('QUOTE_SQL.replace(');
    expect(quotes).not.toMatch(/\bQUOTE_SQL\b/);
    expect(quotes.match(/quoteSql\(/g)?.length).toBeGreaterThanOrEqual(5);
  });
});

describe('T5b — the submitter sees Approve locked on a Quotes list row', () => {
  it('locks for the maker, not for someone else, never for a super admin', () => {
    expect(quoteSelfApprovalLock('u1', 'u1', false)).toMatch(/maker ≠ checker/);
    expect(quoteSelfApprovalLock('u1', 'u2', false)).toBeNull();
    expect(quoteSelfApprovalLock('u1', 'u1', true)).toBeNull();
    expect(quoteSelfApprovalLock(null, 'u1', false)).toBeNull();
  });

  it('the list row carries submitted_by and both pages lock with it', () => {
    expect(read('apps', 'api', 'src', 'services', 'quotes.ts')).toContain('submitted_by: r.maker_id');
    expect(read('apps', 'web', 'src', 'api', 'client.ts')).toMatch(/submitted_by: string \| null;/);
    const page = read('apps', 'web', 'src', 'pages', 'QuotesPage.tsx');
    expect(page).toContain('quoteSelfApprovalLock(q.submitted_by');
    expect(page).toContain('lockReason={');
    expect(read('apps', 'web', 'src', 'pages', 'ApprovalsPage.tsx')).toContain('own(d.item.submitted_by)');
  });
});

// ── T6 · the audit search never matches a value the reader cannot see ───────

describe('T6 — audit free-text search matches values only on fields the reader may see', () => {
  it('the allow-list: catalogue fields the reader may see; a fields.* key with no field_def is never on it', () => {
    const visible = (k: string) => k !== 'fields.34. Cost' && k !== 'client';
    expect(visibleAuditFields(['fields.34. Cost', 'fields.Store', 'client', 'city'], visible)).toEqual([
      'fields.Store',
      'city',
    ]);
  });

  it('matches before / after only on a row with no field, a non-catalogue field, or a field on the allow-list', () => {
    const { sql, params } = buildAuditWhere({ q: '1250' }, ['fields.Store']);
    expect(sql).toContain(
      "(a.field IS NULL OR a.field = ANY($2::text[]) OR (a.field NOT LIKE 'fields.%' AND NOT (a.field = ANY($3::text[]))))",
    );
    expect(sql).toMatch(/a\.before::text, ''\) ILIKE \$1/);
    expect(params[0]).toBe('%1250%');
    expect(params[1]).toEqual(['fields.Store']);
    expect(params[2]).toEqual(expect.arrayContaining(['client', 'city', 'description']));
  });

  it('WO #, field name and entity still match; no search = no clause', () => {
    const { sql } = buildAuditWhere({ q: 'x' }, []);
    expect(sql).toContain('t.wo_number ILIKE $1');
    expect(sql).toContain("COALESCE(a.field, '') ILIKE $1");
    expect(buildAuditWhere({ action: 'field_updated' }, []).sql).not.toContain('ANY(');
  });

  it('listAuditLog builds the allow-list from the reader’s grants', () => {
    const src = read('apps', 'api', 'src', 'services', 'auditLog.ts');
    expect(src).toContain('visibleAuditFields(');
    expect(src).toContain('activityValuesVisible(allow, k)');
    expect(src).not.toContain('hiddenAuditFields');
  });
});

// ── T9 · No visit logged counts future work by its Scheduled Date ────────────

describe('T9 — No visit logged reads the Scheduled Date', () => {
  const set = noVisitLoggedFilter();

  it('is two AND groups joined by OR: no Scheduled Date, or one on / before today', () => {
    expect(set.rules.filter((r) => r.join === 'or')).toHaveLength(1);
    const split = set.rules.findIndex((r) => r.join === 'or');
    const groups = [set.rules.slice(0, split), set.rules.slice(split)];
    for (const g of groups) {
      expect(g).toContainEqual(expect.objectContaining({ field: 'fields.Visit Type', op: 'is_not_set' }));
      expect(g).toContainEqual(expect.objectContaining({ field: 'status_group', op: 'in', value: [...NO_VISIT_STATUS_GROUPS] }));
      expect(g).toContainEqual(expect.objectContaining({ field: 'status', op: 'not_in', value: [...NO_VISIT_EXCLUDED_STATUSES] }));
    }
    expect(groups[0]).toContainEqual(expect.objectContaining({ field: 'fields.Scheduled Date', op: 'is_not_set' }));
    expect(groups[1]).toContainEqual(expect.objectContaining({ field: 'fields.Scheduled Date', op: 'lte', value: 'today' }));
  });

  it('no longer drops the Sched statuses wholesale — a past booking with no visit is owed one', () => {
    expect(NO_VISIT_EXCLUDED_STATUSES).toEqual(['Invoiced Not Paid']);
  });

  it('the dashboard card and its drill-through use the one filter', () => {
    const dash = read('apps', 'web', 'src', 'pages', 'DashboardPage.tsx');
    expect(dash).toContain('const VISIT_TYPE_UNSET: WoFilterSet = noVisitLoggedFilter();');
  });
});

// ── T1 · test sign-in accounts ───────────────────────────────────────────────

describe('T1 — test accounts: configuration', () => {
  it('is on only with TEST_ACCOUNTS_ENABLED=true AND a password', () => {
    expect(testAccountsFromEnv({})).toBeNull();
    expect(testAccountsFromEnv({ TEST_ACCOUNTS_ENABLED: 'true' })).toBeNull();
    expect(testAccountsFromEnv({ TEST_ACCOUNTS_ENABLED: 'true', TEST_ACCOUNTS_PASSWORD: '  ' })).toBeNull();
    expect(testAccountsFromEnv({ TEST_ACCOUNTS_PASSWORD: 'testing' })).toBeNull();
    expect(testAccountsFromEnv({ TEST_ACCOUNTS_ENABLED: 'false', TEST_ACCOUNTS_PASSWORD: 'testing' })).toBeNull();
    expect(testAccountsFromEnv({ TEST_ACCOUNTS_ENABLED: 'TRUE', TEST_ACCOUNTS_PASSWORD: 'testing' })).toEqual({
      password: 'testing',
      includeAdmin: false,
    });
    expect(
      testAccountsFromEnv({ TEST_ACCOUNTS_ENABLED: 'true', TEST_ACCOUNTS_PASSWORD: 'x', TEST_ACCOUNTS_INCLUDE_ADMIN: 'true' }),
    ).toEqual({ password: 'x', includeAdmin: true });
  });

  it('the password is not in the repo: config reads it from the environment only', () => {
    const cfg = read('apps', 'api', 'src', 'config.ts');
    expect(cfg).toContain("TEST_ACCOUNTS_PASSWORD");
    expect(cfg).not.toMatch(/TEST_ACCOUNTS_PASSWORD['"]\s*\)\s*\?\?\s*['"]/);
  });
});

describe('T1 — test accounts: who they are', () => {
  it('one per role code, on a domain nobody can sign in from with Microsoft', () => {
    expect(testAccountEmail('om')).toBe(`test+om@${TEST_ACCOUNT_EMAIL_DOMAIN}`);
    expect(TEST_ACCOUNT_EMAIL_DOMAIN).toBe('test.theone.local');
    expect(isTestAccountEmail('test+om@test.theone.local')).toBe(true);
    expect(isTestAccountEmail('TEST+OM@Test.TheOne.Local')).toBe(true);
    expect(isTestAccountEmail('om@test.theone.local')).toBe(false);
    expect(isTestAccountEmail('jordan@seamlessfm.com')).toBe(false);
    expect(isTestAccountEmail(null)).toBe(false);
    expect(testAccountDisplayName('Assistant TL', 'atl')).toBe('Test Assistant TL');
    expect(testAccountDisplayName(null, 'atl')).toBe('Test ATL');
  });

  it('never admin unless asked, never the service role, only plain role codes', () => {
    expect(TEST_ACCOUNT_ADMIN_CODE).toBe('admin');
    expect(testAccountRoleAllowed('om', false)).toBe(true);
    expect(testAccountRoleAllowed('admin', false)).toBe(false);
    expect(testAccountRoleAllowed('admin', true)).toBe(true);
    expect(testAccountRoleAllowed('service', true)).toBe(false);
    expect(testAccountRoleAllowed('om; drop', false)).toBe(false);
    expect(testAccountRoleAllowed('', false)).toBe(false);
  });
});

describe('T1 — test accounts: password and attempts', () => {
  it('compares in constant time over a hash of each side', () => {
    expect(testPasswordMatches('testing', 'testing')).toBe(true);
    expect(testPasswordMatches('Testing', 'testing')).toBe(false);
    expect(testPasswordMatches('', 'testing')).toBe(false);
    expect(testPasswordMatches('a much longer guess than the password', 'testing')).toBe(false);
    const src = read('apps', 'api', 'src', 'lib', 'testAccountAuth.ts');
    expect(src).toContain('timingSafeEqual');
    expect(src).toContain("createHash('sha256')");
  });

  it('a session is bound to a short fingerprint of the password it was issued under', () => {
    const fp = testPasswordFingerprint('testing');
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(testPasswordFingerprint('testing')).toBe(fp);
    expect(testPasswordFingerprint('testing2')).not.toBe(fp);
    // Not a test account: never asked.
    expect(testSessionAllowed(false, null, null)).toBe(true);
    // A test account: only while the feature is on and the password is the one it signed in with.
    expect(testSessionAllowed(true, fp, 'testing')).toBe(true);
    expect(testSessionAllowed(true, fp, null)).toBe(false);
    expect(testSessionAllowed(true, fp, 'rotated')).toBe(false);
    expect(testSessionAllowed(true, null, 'testing')).toBe(false);
  });

  it('five failures a minute per IP, then refused until the minute is up', () => {
    expect(TEST_LOGIN_MAX_FAILURES).toBe(5);
    expect(TEST_LOGIN_WINDOW_MS).toBe(60_000);
    const lim = new AttemptLimiter(5, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(lim.blocked('1.2.3.4', t0 + i)).toBe(false);
      lim.fail('1.2.3.4', t0 + i);
    }
    expect(lim.blocked('1.2.3.4', t0 + 10)).toBe(true);
    expect(lim.blocked('5.6.7.8', t0 + 10)).toBe(false);
    expect(lim.blocked('1.2.3.4', t0 + 60_005)).toBe(false);
  });
});

describe('T1 — test accounts: guards in the API', () => {
  it('the endpoint is public, and 404s while the feature is off', () => {
    expect(read('apps', 'api', 'src', 'plugins', 'authGuard.ts')).toContain("'/api/auth/test-login'");
    const routes = read('apps', 'api', 'src', 'routes', 'auth.ts');
    expect(routes).toContain("app.post('/auth/test-login'");
    expect(read('apps', 'api', 'src', 'services', 'testAccounts.ts')).toContain(
      "if (!cfg) throw new ApiError('NOT_FOUND', 'Route not found')",
    );
  });

  it('a test account cannot change users or roles', () => {
    expect(testAccountAdminWriteBlocked('POST', '/api/admin/users')).toBe(true);
    expect(testAccountAdminWriteBlocked('PATCH', '/api/admin/users/abc')).toBe(true);
    expect(testAccountAdminWriteBlocked('PUT', '/api/admin/users/abc/permissions')).toBe(true);
    expect(testAccountAdminWriteBlocked('POST', '/api/admin/roles')).toBe(true);
    expect(testAccountAdminWriteBlocked('DELETE', '/api/admin/roles/abc')).toBe(true);
    expect(testAccountAdminWriteBlocked('PUT', '/api/admin/portfolio/site-access/abc')).toBe(true);
    expect(testAccountAdminWriteBlocked('GET', '/api/admin/users')).toBe(false);
    expect(testAccountAdminWriteBlocked('POST', '/api/work-orders')).toBe(false);
    expect(testAccountAdminWriteBlocked('POST', '/api/admin/usersettings')).toBe(false);
    const guard = read('apps', 'api', 'src', 'plugins', 'authGuard.ts');
    expect(guard).toContain('throw testAccountAdminRefusal()');
    expect(guard).not.toContain("'TEST_ACCOUNT_READ_ONLY_ADMIN'");
    expect(read('apps', 'api', 'src', 'services', 'testAccounts.ts')).toContain('code: TEST_ACCOUNT_READ_ONLY_ADMIN_CODE');
    // The Share dialog writes role grants and per-person overrides too.
    expect(read('apps', 'api', 'src', 'services', 'dashboards.ts')).toContain('if (viewer.isTestAccount) throw testAccountAdminRefusal()');
  });

  it('a test account is never a super admin, whatever the row says', () => {
    const auth = read('apps', 'api', 'src', 'services', 'auth.ts');
    expect(auth).toContain('const isTest = isTestAccountEmail(r.email)');
    expect(auth).toContain('isSuperAdmin: r.is_super_admin && !isTest');
  });

  it('/auth/me carries is_test_account and whether the form is on; viewing as still runs in the audit context', () => {
    const routes = read('apps', 'api', 'src', 'routes', 'auth.ts');
    expect(routes).toContain('is_test_account: p.isTestAccount');
    expect(routes).toContain('test_accounts: testAccountsEnabled()');
    const guard = read('apps', 'api', 'src', 'plugins', 'authGuard.ts');
    expect(guard).toContain('runWithAuditContext');
  });
});

describe('T1 — test sign-in against a scripted database', () => {
  // The service reads config at call time; set it on the live config object
  // for these cases only.
  let db: typeof import('../apps/api/src/db');
  let cfg: typeof import('../apps/api/src/config');
  let svc: typeof import('../apps/api/src/services/testAccounts');
  let auth: typeof import('../apps/api/src/services/auth');

  beforeEach(async () => {
    db = await import('../apps/api/src/db');
    cfg = await import('../apps/api/src/config');
    svc = await import('../apps/api/src/services/testAccounts');
    auth = await import('../apps/api/src/services/auth');
    vi.mocked(db.query).mockReset();
    svc.resetTestLoginLimiter();
    (cfg.config as { testAccounts: unknown }).testAccounts = { password: 'testing', includeAdmin: false };
    (cfg.config as { demoMode: boolean }).demoMode = false;
  });

  const principalRow = {
    id: '11111111-1111-1111-1111-111111111111',
    display_name: 'Test OM (dispatcher)',
    email: 'test+om@test.theone.local',
    role: 'om',
    role_label: 'OM (dispatcher)',
    kind: 'human',
    is_super_admin: false,
    status: 'active',
    role_permissions: {},
    permission_overrides: {},
    site_restricted: false,
    client_names: [],
  };

  /** Answers by what the SQL says, so the order of reads does not matter. */
  function route(handlers: [RegExp, (params: unknown[]) => unknown[]][]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    vi.mocked(db.query).mockImplementation((async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const h = handlers.find(([re]) => re.test(sql));
      return { rows: h ? h[1](params) : [], rowCount: 0 };
    }) as never);
    return calls;
  }
  const ROLE: [RegExp, () => unknown[]] = [/FROM role WHERE code/, () => [{ code: 'om', label: 'OM (dispatcher)' }]];
  const SVC: [RegExp, () => unknown[]] = [/kind = 'service'|FROM principal WHERE id = \$1$/, () => [{ id: 'svc' }]];
  const REREAD: [RegExp, () => unknown[]] = [/LEFT JOIN role r ON r\.code = p\.role WHERE p\.id/, () => [principalRow]];

  it('404s while the feature is off', async () => {
    (cfg.config as { testAccounts: unknown }).testAccounts = null;
    await expect(svc.testAccountSignIn({ username: 'om', password: 'testing', ip: '1.1.1.1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a first sign-in creates the row (never a super admin), audits it, and logs test_sign_in without the password', async () => {
    const calls = route([
      ROLE,
      [/SELECT id::text AS id, status FROM principal WHERE lower\(email\)/, () => []],
      [/INSERT INTO principal/, () => [{ id: principalRow.id }]],
      REREAD,
    ]);
    const p = await svc.testAccountSignIn({ username: ' OM ', password: 'testing', ip: '1.1.1.1' });
    expect(p.role).toBe('om');
    expect(p.isSuperAdmin).toBe(false);
    expect(p.isTestAccount).toBe(true);
    const ins = calls.find((c) => c.sql.includes('INSERT INTO principal'))!;
    expect(ins.sql).toContain('ON CONFLICT (lower(email)) WHERE email IS NOT NULL DO NOTHING');
    expect(ins.sql).not.toContain('DO UPDATE');
    expect(ins.sql).toMatch(/'active', false, now\(\)/);
    expect(ins.params).toContain('test+om@test.theone.local');
    expect(ins.params).toContain('Test OM (dispatcher)');
    const logs = calls.filter((c) => c.sql.includes('INSERT INTO activity_log'));
    expect(logs.map((l) => l.params[3] ?? l.params[2])).toEqual(expect.arrayContaining(['test_account_created']));
    expect(logs.some((l) => l.params.includes('test_sign_in'))).toBe(true);
    expect(JSON.stringify(logs.map((l) => l.params))).not.toContain('testing');
  });

  it('an existing row keeps its role and status: only last_login_at is touched', async () => {
    const calls = route([
      ROLE,
      [/SELECT id::text AS id, status FROM principal WHERE lower\(email\)/, () => [{ id: principalRow.id, status: 'active' }]],
      [/LEFT JOIN role r ON r\.code = p\.role WHERE p\.id/, () => [{ ...principalRow, role: 'tl', role_label: 'Team Lead' }]],
    ]);
    const p = await svc.testAccountSignIn({ username: 'om', password: 'testing', ip: '1.1.1.1' });
    expect(p.role).toBe('tl');
    expect(calls.some((c) => c.sql.includes('INSERT INTO principal'))).toBe(false);
    const upd = calls.filter((c) => /UPDATE principal/.test(c.sql));
    expect(upd).toHaveLength(1);
    expect(upd[0].sql).toContain('SET last_login_at = now()');
    expect(upd[0].sql).not.toMatch(/role\s*=|status\s*=|is_super_admin\s*=/);
  });

  it('a disabled test account is refused like any wrong part, logged with reason disabled', async () => {
    const calls = route([
      ROLE,
      SVC,
      [/SELECT id::text AS id, status FROM principal WHERE lower\(email\)/, () => [{ id: principalRow.id, status: 'disabled' }]],
    ]);
    await expect(svc.testAccountSignIn({ username: 'om', password: 'testing', ip: '1.1.1.1' })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'Wrong test username or password',
    });
    expect(calls.some((c) => /UPDATE principal|INSERT INTO principal/.test(c.sql))).toBe(false);
    const log = calls.find((c) => c.sql.includes('INSERT INTO activity_log'))!;
    expect(log.params).toContain('test_sign_in_failed');
    expect(String(log.params[3])).toContain('"reason":"disabled"');
  });

  it('DEMO_MODE on an unseeded database: refused before any principal is touched', async () => {
    (cfg.config as { demoMode: boolean }).demoMode = true;
    const calls = route([ROLE, [/FROM app_meta/, () => []]]);
    await expect(svc.testAccountSignIn({ username: 'om', password: 'testing', ip: '1.1.1.1' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { code: 'DEMO_NOT_SEEDED' },
    });
    expect(calls.some((c) => /principal/.test(c.sql) && /INSERT|UPDATE|SELECT id::text AS id, status/.test(c.sql))).toBe(false);
  });

  it('a wrong password, an unknown role or admin is one refusal, logged test_sign_in_failed', async () => {
    for (const [username, password] of [
      ['om', 'n0pe-guess'],
      ['admin', 'testing'],
      ['nosuchrole', 'testing'],
    ]) {
      vi.mocked(db.query).mockReset();
      const calls = route([[/FROM role WHERE code/, () => []], SVC]);
      await expect(svc.testAccountSignIn({ username, password, ip: '2.2.2.2' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'Wrong test username or password',
      });
      const log = calls.find((c) => c.sql.includes('INSERT INTO activity_log'));
      expect(log?.params).toContain('test_sign_in_failed');
      expect(JSON.stringify(log?.params)).not.toContain(password);
    }
  });

  it('the sixth failure in a minute is refused before the password is read', async () => {
    route([SVC]);
    for (let i = 0; i < 5; i++) {
      await expect(svc.testAccountSignIn({ username: 'om', password: 'nope', ip: '3.3.3.3' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    }
    await expect(svc.testAccountSignIn({ username: 'om', password: 'testing', ip: '3.3.3.3' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });

  describe('a test session ends when the feature is switched off or the password rotates', () => {
    const fp = testPasswordFingerprint('testing');
    const sessionRow = (over: Record<string, unknown>) => ({ session_id: 'sid', impersonating_id: null, test_password_fp: fp, ...principalRow, ...over });
    const load = (row: Record<string, unknown>) => {
      route([[/FROM session s/, () => [row]]]);
      return auth.loadSession('sid');
    };

    it('kept while on and the password is the one it was issued under', async () => {
      const ctx = await load(sessionRow({}));
      expect(ctx?.user.isTestAccount).toBe(true);
    });
    it('signed out when the feature is off', async () => {
      (cfg.config as { testAccounts: unknown }).testAccounts = null;
      expect(await load(sessionRow({}))).toBeNull();
    });
    it('signed out after a password rotation', async () => {
      (cfg.config as { testAccounts: unknown }).testAccounts = { password: 'rotated', includeAdmin: false };
      expect(await load(sessionRow({}))).toBeNull();
    });
    it('signed out when it carries no fingerprint (a test account reached any other way)', async () => {
      expect(await load(sessionRow({ test_password_fp: null }))).toBeNull();
    });
    it('a real person’s session is untouched', async () => {
      (cfg.config as { testAccounts: unknown }).testAccounts = null;
      const ctx = await load(sessionRow({ email: 'jordan@seamlessfm.com', test_password_fp: null }));
      expect(ctx?.user.isTestAccount).toBe(false);
    });
    it('the route stores the fingerprint on the session it creates; migration 0087 adds the column', () => {
      expect(read('apps', 'api', 'src', 'routes', 'auth.ts')).toContain('testPasswordFp: testSessionFingerprint()');
      expect(read('apps', 'api', 'src', 'services', 'auth.ts')).toContain('s.test_password_fp');
      expect(read('packages', 'db', 'migrations', '0087_test_session_fp.sql')).toMatch(
        /ALTER TABLE session ADD COLUMN IF NOT EXISTS test_password_fp text/,
      );
    });
  });
});

describe('T1 — test accounts: the web', () => {
  it('the sign-in page draws the form only when /auth/me says so', () => {
    const page = read('apps', 'web', 'src', 'pages', 'SignInPage.tsx');
    expect(page).toContain('testAccounts &&');
    expect(page).toContain('Test account');
    expect(page).toContain('testSignIn(');
  });

  it('the header shows an amber "Test account" chip from the session', () => {
    const shell = read('apps', 'web', 'src', 'components', 'AppShell.tsx');
    expect(shell).toContain('user?.is_test_account');
    const css = read('apps', 'web', 'src', 'styles', 'app.css');
    expect(css).toMatch(/\.chip-test-account\s*\{[^}]*var\(--warn/);
  });
});

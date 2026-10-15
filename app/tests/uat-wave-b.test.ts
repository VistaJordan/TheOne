/* UAT round 1, Wave B — access and scope (migration 0084, docs/specs/uat-round-1.md).
 *
 * The house pattern: the pure vocabulary in packages/shared/src/access.ts is
 * exercised directly, the small API decisions that need no database
 * (services/users.ts, services/permissions.ts) are called, and the wiring is
 * pinned as source text. No database is opened. A reformat of a pinned
 * fragment turns a test red without a behaviour change: update the fragment
 * the failing assertion names.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_UNSAFE_COLUMNS_CODE,
  DISPATCHER_ROLE_CODES,
  GRANT_EXCEEDS_OWN_CODE,
  MARGIN_PCT_KEY,
  MONEY_HIDDEN_FIELD_KEYS,
  MONEY_ROLE_CODES,
  ROLE_EDIT_RESTRICTED_CODE,
  SELF_EDIT_CODE,
  activityFieldKey,
  clientUnsafeDefaultBagKeys,
  defaultClientSafe,
  dispatcherTier,
  grantsExceeding,
  isDispatcherRole,
  mayEditRoleDefinitions,
  moneyHiddenPermKeys,
  permAllows,
  seesMoneyRole,
  widgetNamedFields,
  type PermissionSet,
} from '@theone/shared';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';
import { ApiError } from '../apps/api/src/errors';
import {
  activityValuesVisible,
  allowFor,
  redactActivityValues,
  redactWorkOrder,
} from '../apps/api/src/services/permissions';
import { assertGrantWithinOwn, assertNoSelfRightsChange, assertNotSelfEdit } from '../apps/api/src/services/users';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = src('packages/db/migrations/0084_uat_access.sql');

function refusal(fn: () => void): ApiError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    return e as ApiError;
  }
  throw new Error('expected a refusal');
}

/** One route registration in a routes file: from its marker to the next `app.`. */
function routeBlock(file: string, marker: string): string {
  const start = file.indexOf(marker);
  expect(start, `route ${marker} is registered`).toBeGreaterThan(-1);
  const next = file.indexOf('\n  app.', start + marker.length);
  return file.slice(start, next === -1 ? undefined : next);
}

// ── D3 · dispatchers ─────────────────────────────────────────────────────────

describe('D3 · one list of dispatchers', () => {
  it('is the four role codes, with their tiers', () => {
    expect([...DISPATCHER_ROLE_CODES].sort()).toEqual(['om', 'om_probation', 'ops_coord', 'senior_om']);
    expect(dispatcherTier('ops_coord')).toBe('probation');
    expect(dispatcherTier('om_probation')).toBe('probation');
    expect(dispatcherTier('om')).toBe('dispatcher');
    expect(dispatcherTier('senior_om')).toBe('senior');
    expect(isDispatcherRole('tl')).toBe(false);
    expect(isDispatcherRole(null)).toBe(false);
    expect(dispatcherTier('admin')).toBeNull();
  });

  it('assigneeAvailability no longer keeps a second copy', () => {
    const avail = src('packages/shared/src/assigneeAvailability.ts');
    expect(avail).not.toMatch(/export const DISPATCHER_ROLE_CODES/);
    expect(avail).not.toMatch(/export function isDispatcherRole/);
  });
});

// ── 0084 · the migration ─────────────────────────────────────────────────────

describe('migration 0084 (D4: the role matrix lives here)', () => {
  it('manages no transaction of its own and says no CONCURRENTLY', () => {
    expect(migrationFileProblems(MIGRATION)).toEqual([]);
  });

  it('adds field_def.client_safe and flags exactly the shared list off (seed.ts in step)', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE field_def ADD COLUMN IF NOT EXISTS client_safe boolean NOT NULL DEFAULT true/);
    const list = MIGRATION.match(/UPDATE field_def SET client_safe = false\s+WHERE key = ANY \(ARRAY\[([\s\S]*?)\]::text\[\]\)/);
    expect(list).not.toBeNull();
    const keys = [...list![1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(clientUnsafeDefaultBagKeys());
    const seed = src('packages/db/src/seed.ts');
    expect(seed).toMatch(/UPDATE field_def SET client_safe = false WHERE key = ANY\(\$1::text\[\]\)`, \[clientUnsafeDefaultBagKeys\(\)\]/);
  });

  it('adds principal.site_restricted and backfills it from principal_site (M29)', () => {
    expect(MIGRATION).toMatch(/ALTER TABLE principal ADD COLUMN IF NOT EXISTS site_restricted boolean NOT NULL DEFAULT false/);
    expect(MIGRATION).toMatch(/UPDATE principal p SET site_restricted = true[\s\S]*EXISTS \(SELECT 1 FROM principal_site ps WHERE ps\.principal_id = p\.id\)/);
  });

  it('#12 · invoicing in full to admin and ar, view to tl / atl / am', () => {
    expect(MIGRATION).toMatch(/wb_grant\(c, 'invoicing', '\{"view": true, "create": true, "edit": true, "approve": true\}'\)\s+FROM unnest\(ARRAY\['admin', 'ar'\]\)/);
    expect(MIGRATION).toMatch(/wb_grant\(c, 'invoicing', '\{"view": true\}'\)\s+FROM unnest\(ARRAY\['tl', 'atl', 'am'\]\)/);
  });

  it('M13 · hides the shared money keys on every system role but the money roles', () => {
    for (const k of moneyHiddenPermKeys()) expect(MIGRATION).toContain(`'${k}'`);
    const notIn = [...MIGRATION.matchAll(/r\.code NOT IN \(([^)]*)\)/g)].map((m) => m[1]);
    expect(notIn.length).toBeGreaterThanOrEqual(2);
    for (const clause of notIn) {
      const codes = [...clause.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      expect(codes).toEqual([...MONEY_ROLE_CODES, 'service'].sort());
    }
  });

  it('#14 / M20 · exec_guest and ops_coord copy om_probation; ops_coord loses five things', () => {
    expect(MIGRATION).toMatch(/WHERE g\.code = 'exec_guest' AND p\.code = 'om_probation'/);
    expect(MIGRATION).toMatch(/WHERE g\.code = 'ops_coord' AND p\.code = 'om_probation'/);
    // The copies come AFTER the M13 pass, so they carry its hiding.
    expect(MIGRATION.indexOf("g.code = 'exec_guest'")).toBeGreaterThan(MIGRATION.indexOf("'work_orders/fields/finances/fields.34. Cost'"));
    for (const [path, grant] of [
      ['vendors', '"view": false'],
      ['vendor_map', '"view": false'],
      ['clients', '"view": false'],
      ['contracts', '"view": false'],
      ['work_orders/scope', '"view": false'],
      ['work_orders/status', '"edit": false, "create": true'],
    ]) {
      expect(MIGRATION).toMatch(new RegExp(`wb_grant\\('ops_coord', '${path.replace('/', '\\/')}', '\\{${grant}`));
    }
  });

  it('#14 · vr_officer and oa request status changes and see every work order; hr is new', () => {
    expect(MIGRATION).toMatch(/wb_grant\(c, 'work_orders\/status', '\{"edit": false, "create": true\}'\)\s+FROM unnest\(ARRAY\['vr_officer', 'oa'\]\)/);
    expect(MIGRATION).toMatch(/wb_grant\(c, 'work_orders\/scope', '\{"view": true\}'\)\s+FROM unnest\(ARRAY\['vr_officer', 'oa'\]\)/);
    expect(MIGRATION).toMatch(/wb_grant\('oa', 'intake'/);
    expect(MIGRATION).toMatch(/INSERT INTO role \(code, label, description, is_system, position, permissions\)[\s\S]*'hr',[\s\S]*true,[\s\S]*'\{"admin\/users": \{"view": true, "edit": true\}, "admin\/roles": \{"view": true, "edit": true\}\}'::jsonb[\s\S]*ON CONFLICT \(code\) DO NOTHING/);
  });
});

// ── M13 · money below TL ─────────────────────────────────────────────────────

describe('M13 · who sees money', () => {
  it('is TL and above plus the finance desks', () => {
    for (const c of ['admin', 'tl', 'atl', 'am', 'ar', 'ap']) expect(seesMoneyRole(c)).toBe(true);
    for (const c of ['om', 'senior_om', 'om_probation', 'ops_coord', 'oa', 'vr_officer', 'exec_guest', 'sales', 'hr']) {
      expect(seesMoneyRole(c)).toBe(false);
    }
    expect(MONEY_HIDDEN_FIELD_KEYS).toContain('fields.34. Cost');
    expect(MONEY_HIDDEN_FIELD_KEYS).toContain('fields.Profit');
    expect(MONEY_HIDDEN_FIELD_KEYS).not.toContain('fields.16. Client NTE 🔴');
  });

  const dispatcher: PermissionSet = {
    role: Object.fromEntries([
      ['work_orders', { view: true, edit: true }],
      ...moneyHiddenPermKeys().map((k) => [k, { view: false, edit: false }]),
    ]),
    overrides: {},
  };

  it('a role without Cost keeps the Margin % and loses Cost / Invoiced / Profit on the money block', () => {
    const allow = allowFor({ isSuperAdmin: false, perms: dispatcher });
    const wo = redactWorkOrder(allow, {
      fields: { '34. Cost': 100, Profit: 50, 'Total Invoiced': 150, Store: '12' },
      money: { nte: 200, quote: 150, cost: 100, invoiced: 150, profit: 50, marginPct: 33.3 },
    });
    expect(wo.fields).toEqual({ Store: '12' });
    expect(wo.money).toEqual({ nte: 200, quote: 150, cost: null, invoiced: null, profit: null, marginPct: 33.3 });
    expect(allow(`work_orders/fields/header/${MARGIN_PCT_KEY}`, 'view')).toBe(true);
  });

  it('the margin_pct column is computed in woFields and counted as a computed column', () => {
    expect(src('apps/api/src/services/woFields.ts')).toMatch(/key: 'margin_pct',[^\n]*sql: MARGIN_PCT_SQL,[^\n]*computed: true/);
    expect(src('packages/shared/src/clientUpdates.ts')).toMatch(/'margin_pct',\n\] as const;/);
  });

  it('the record rail and the Cost breakdown follow it', () => {
    const rec = src('apps/api/src/services/woRecord.ts');
    expect(rec).toMatch(/if \(seeMoney && !canViewField\(allowFor\(actor\), 'fields\.34\. Cost'\)\) redactRecordMoney\(money\);/);
  });
});

// ── #17 · client-safe ────────────────────────────────────────────────────────

describe('#17 · client-safe columns', () => {
  it('defaults: the four money sections and the money figures are off, the rest on', () => {
    expect(defaultClientSafe('fields.34. Cost')).toBe(false);
    expect(defaultClientSafe('fields.Invoice #')).toBe(false);
    expect(defaultClientSafe('fields.Admin Comment')).toBe(false);
    expect(defaultClientSafe('fields.26. PPR Link')).toBe(false);
    expect(defaultClientSafe('fields.Store')).toBe(true);
    expect(defaultClientSafe('fields.35. WO Description')).toBe(true);
    expect(defaultClientSafe('nte')).toBe(true);
    expect(defaultClientSafe(MARGIN_PCT_KEY)).toBe(false);
    expect(defaultClientSafe('fields.A field nobody filed')).toBe(true);
  });

  const cu = src('apps/api/src/services/clientUpdates.ts');

  it('the shared view is built as the tracker owner: their scope, their visible client-safe columns', () => {
    const at = cu.indexOf('async function buildView(');
    const body = cu.slice(at, cu.indexOf('\nfunction publicOf', at));
    expect(body).toMatch(/const owner = await trackerOwner\(r\);/);
    expect(body).toMatch(/f\.client_safe && canViewField\(ownerAllow, key\)/);
    expect(body).toMatch(/\}, owner\);/);
    expect(body).toMatch(/summarize\(filters, owner\)/);
    expect(body).toMatch(/chartsFor\(sharedCharts, filters, owner\)/);
    expect(body).toMatch(/const filters = trackerFilters\(t\);/);
    expect(cu).toMatch(/async function trackerOwner\(r: Row\)[\s\S]*loadPrincipalById\(r\.created_by_id\)/);
  });

  it('saving a tracker with a shared non-client-safe column is a 400 naming the fields', () => {
    expect(cu).toMatch(/if \(c\.shared && !f\.client_safe\) unsafe\.push\(f\.label\);/);
    expect(cu).toMatch(/code: CLIENT_UNSAFE_COLUMNS_CODE, fields: \[\.\.\.new Set\(unsafe\)\]/);
    expect(CLIENT_UNSAFE_COLUMNS_CODE).toBe('CLIENT_UNSAFE_COLUMNS');
  });

  it('Admin › Custom fields carries and writes the flag (audited in the snapshot)', () => {
    const defs = src('apps/api/src/services/fieldDefs.ts');
    expect(defs).toMatch(/client_safe: f\.client_safe \}/);
    expect(defs).toMatch(/client_safe = \$6/);
    expect(src('apps/api/src/routes/admin.ts')).toMatch(/client_safe: z\.boolean\(\)\.optional\(\)/);
    expect(src('apps/web/src/pages/admin/AdminSections.tsx')).toContain('<th>Client-safe</th>');
  });
});

// ── #18 · nobody raises their own rights ─────────────────────────────────────

describe('#18 · self-edit and grants beyond one’s own', () => {
  it('SELF_EDIT on one’s own row, for everyone', () => {
    const err = refusal(() => assertNotSelfEdit('a', 'a', 'role'));
    expect(err.statusCode).toBe(403);
    expect((err.details as { code: string }).code).toBe(SELF_EDIT_CODE);
    expect(() => assertNotSelfEdit('a', 'b', 'role')).not.toThrow();
  });

  it('only a CHANGE to role / status / super admin counts; a name change passes', () => {
    const row = { role: 'om', status: 'active', is_super_admin: true };
    expect(() => assertNoSelfRightsChange('a', 'a', { name: 'New name', role: 'om', status: 'active' }, row)).not.toThrow();
    expect(() => assertNoSelfRightsChange('a', 'a', { role: 'admin' }, row)).toThrow(ApiError);
    expect(() => assertNoSelfRightsChange('a', 'a', { status: 'disabled' }, row)).toThrow(ApiError);
    expect(() => assertNoSelfRightsChange('a', 'a', { is_super_admin: false }, row)).toThrow(ApiError);
    expect(() => assertNoSelfRightsChange('a', 'b', { role: 'admin' }, row)).not.toThrow();
  });

  const hr: PermissionSet = { role: { 'admin/users': { view: true, edit: true }, 'admin/roles': { view: true, edit: true } }, overrides: {} };
  const tl: PermissionSet = {
    role: { work_orders: { view: true, edit: true }, 'work_orders/fields/finances': { view: false } },
    overrides: {},
  };

  it('grantsExceeding: a true the actor lacks, or a true above the actor’s own refusal', () => {
    expect(grantsExceeding(hr, false, { work_orders: { view: true } })).toEqual(['work_orders:view']);
    expect(grantsExceeding(hr, false, { 'admin/users': { view: true } })).toEqual([]);
    expect(grantsExceeding(hr, true, { work_orders: { view: true } })).toEqual([]);
    expect(grantsExceeding(tl, false, { work_orders: { view: true } })).toEqual(['work_orders/fields/finances:view']);
    expect(grantsExceeding(tl, false, { work_orders: { view: true }, 'work_orders/fields/finances': { view: false } })).toEqual([]);
    expect(grantsExceeding(hr, false, { quotes: { view: false } })).toEqual([]);
    // Editing a role keeps what it already granted.
    expect(grantsExceeding(hr, false, { work_orders: { view: true } }, { work_orders: { view: true } })).toEqual([]);
  });

  it('assertGrantWithinOwn answers 403 GRANT_EXCEEDS_OWN with the list', () => {
    const err = refusal(() => assertGrantWithinOwn(hr, false, { invoicing: { approve: true } }));
    expect(err.statusCode).toBe(403);
    expect(err.details).toMatchObject({ code: GRANT_EXCEEDS_OWN_CODE, exceeds: ['invoicing:approve'] });
  });

  it('role definitions: super admins and the Admin role only', () => {
    expect(mayEditRoleDefinitions({ isSuperAdmin: true, role: 'om' })).toBe(true);
    expect(mayEditRoleDefinitions({ isSuperAdmin: false, role: 'admin' })).toBe(true);
    expect(mayEditRoleDefinitions({ isSuperAdmin: false, role: 'hr' })).toBe(false);
    expect(mayEditRoleDefinitions({ isSuperAdmin: false, role: 'tl' })).toBe(false);
  });

  const users = src('apps/api/src/services/users.ts');
  const admin = src('apps/api/src/routes/admin.ts');

  it('users.ts wires the checks into every writer of rights', () => {
    const fn = (name: string) => {
      const s = users.indexOf(`export async function ${name}(`);
      return users.slice(s, users.indexOf('\nexport ', s + 1));
    };
    expect(fn('inviteUser')).toMatch(/assertGrantWithinOwn\(actorPerms, actorIsSuperAdmin, await getRolePermissionsByCode\(input\.role\)\)/);
    expect(fn('updateUser')).toMatch(/assertNoSelfRightsChange\(id, actorId, input, current\)/);
    expect(fn('updateUser')).toMatch(/assertNoSelfRightsChange\(id, actorId, input, locked\.rows\[0\]\)/);
    expect(fn('updateUser')).toMatch(/assertGrantWithinOwn\(actorPerms, actorIsSuperAdmin, await getRolePermissionsByCode\(input\.role\)\)/);
    expect(fn('setUserPermissions')).toMatch(/assertNotSelfEdit\(id, actorId, 'permission_overrides'\)/);
    expect(fn('setUserOverrideView')).toMatch(/assertNotSelfEdit\(id, actorId, 'permission_overrides'\)/);
    expect(fn('setUserClients')).toMatch(/assertNotSelfEdit\(id, actorId, 'clients'\)/);
  });

  it('routes/admin.ts: role writes need a role editor and pass the editor’s tree', () => {
    for (const marker of ["app.post('/admin/roles'", "app.patch('/admin/roles/:id'", "app.delete('/admin/roles/:id'"]) {
      expect(routeBlock(admin, marker)).toContain('requireRoleEditor(req);');
    }
    expect(routeBlock(admin, "app.post('/admin/roles'")).toMatch(/createRole\([^)]*\), actorId, writer\(req\)\)/);
    expect(routeBlock(admin, "app.patch('/admin/roles/:id'")).toMatch(/updateRole\(id, [^;]*, actorId, writer\(req\)\)/);
    expect(admin).toMatch(/code: ROLE_EDIT_RESTRICTED_CODE/);
    expect(ROLE_EDIT_RESTRICTED_CODE).toBe('ROLE_EDIT_RESTRICTED');
    const roles = src('apps/api/src/services/roles.ts');
    expect(roles).toMatch(/assertRoleGrantWithinOwn\(editor, permissions\);/);
    expect(roles).toMatch(/assertRoleGrantWithinOwn\(editor, permissions, current\.permissions\);/);
  });
});

// ── D6 · viewing as = that person, everywhere ────────────────────────────────

describe('D6 · the admin gates read the person being viewed', () => {
  const admin = src('apps/api/src/routes/admin.ts');

  it('requireAdmin and requireSuperAdmin check permissionSubject; the logged id is the real user', () => {
    const ra = admin.slice(admin.indexOf('function requireAdmin('), admin.indexOf('\n}', admin.indexOf('function requireAdmin(')));
    expect(ra).toMatch(/requirePerm\(\s*permissionSubject\(req\),/);
    expect(ra).toMatch(/return req\.auth\.user\.id;/);
    const rs = admin.slice(admin.indexOf('function requireSuperAdmin('), admin.indexOf('\n}', admin.indexOf('function requireSuperAdmin(')));
    expect(rs).toMatch(/permissionSubject\(req\)\.isSuperAdmin/);
    expect(routeBlock(admin, "app.get('/admin/roles'")).toMatch(/const u = permissionSubject\(req\);/);
    expect(routeBlock(admin, "app.get('/admin/permission-fields'")).toMatch(/permissionSubject\(req\)\.isSuperAdmin/);
  });

  it('the other admin route files answer from actingAs', () => {
    for (const f of ['routes/adminDocs.ts', 'routes/adminIntegrations.ts', 'routes/integrations.ts']) {
      const s = src(`apps/api/src/${f}`);
      expect(s, f).toMatch(/return req\.auth\.actingAs;/);
      expect(s, f).not.toMatch(/return req\.auth\.user;/);
    }
    expect(src('apps/api/src/routes/adminDocs.ts')).toMatch(/requirePerm\(req\.auth\.actingAs, DOCS_PERM_KEY/);
  });

  it('starting and stopping a view still reads the real user, so a super admin can always stop', () => {
    const auth = src('apps/api/src/routes/auth.ts');
    const imp = routeBlock(auth, "app.post('/auth/impersonate'");
    expect(imp).toMatch(/if \(!req\.auth\.user\.isSuperAdmin\)/);
    expect(routeBlock(auth, "app.delete('/auth/impersonate'")).toMatch(/setImpersonation\(req\.auth\.sessionId, null\)/);
    expect(src('apps/web/src/components/ActorSwitcher.tsx')).toMatch(/if \(!user\?\.is_super_admin\) return null;/);
  });

  it('the Users page reads the acting principal for the super-admin ring', () => {
    const page = src('apps/web/src/pages/admin/AdminUsersPage.tsx');
    expect(page).toMatch(/const editorIsSuperAdmin = Boolean\(actingAs\?\.is_super_admin\);/);
    expect(page).not.toMatch(/Boolean\(user\?\.is_super_admin\)/);
  });
});

// ── #13 · records by link follow their work order ────────────────────────────

describe('#13 · every per-record route checks the work order’s scope', () => {
  const rs = src('apps/api/src/services/recordScope.ts');

  it('recordScope knows each table, and checks trashed work orders too', () => {
    for (const t of ['payment_request', 'invoice', 'vendor_bill', 'billing_proposal', 'vendor_credit_note', 'approval_task', 'wo_visit']) {
      expect(rs).toMatch(new RegExp(`${t}: \`SELECT task_id::text AS task_id FROM ${t} WHERE id = \\$1\``));
    }
    expect(rs).toMatch(/FROM task t WHERE t\.id = \$\{hole\}`/);
    expect(rs).not.toMatch(/deleted_at IS NULL/);
  });

  const PINNED: [string, string, string[]][] = [
    ['routes/payments.ts', 'payment_request', [
      "app.get('/payment-requests/:pid'", "app.patch('/payment-requests/:pid'", "app.post('/payment-requests/:pid/approve'",
      "app.post('/payment-requests/:pid/pay'", "app.post('/payment-requests/:pid/mark-paid'", "app.post('/payment-requests/:pid/reject'",
      "app.post('/payment-requests/:pid/convert-method'", "app.post('/payment-requests/:pid/delete'",
      "app.post('/payment-requests/:pid/confirm-delete'", "app.post('/payment-requests/:pid/reject-delete'",
    ]],
    ['routes/invoices.ts', 'invoice', [
      "app.get('/invoices/:id'", "app.patch('/invoices/:id'", "app.post('/invoices/:id/send'",
      "app.post('/invoices/:id/paid'", "app.post('/invoices/:id/void'", "app.post('/invoices/:id/reopen'",
    ]],
    ['routes/vendorBills.ts', 'vendor_bill', [
      "app.get('/vendor-bills/:id'", "app.patch('/vendor-bills/:id'", "app.post('/vendor-bills/:id/approve'",
      "app.post('/vendor-bills/:id/paid'", "app.post('/vendor-bills/:id/dispute'", "app.post('/vendor-bills/:id/resolve'",
      "app.post('/vendor-bills/:id/void'",
    ]],
    ['routes/billingProposals.ts', 'billing_proposal', ["app.post('/billing-proposals/:id/confirm'", "app.post('/billing-proposals/:id/dismiss'"]],
    ['routes/approvals.ts', 'approval_task', ["app.post('/approval-tasks/:id/approve'", "app.post('/approval-tasks/:id/reject'", "app.post('/approval-tasks/:id/claim'"]],
    ['routes/visits.ts', 'wo_visit', ["app.patch('/visits/:id'", "app.delete('/visits/:id'", "app.get('/visits/:id/history'"]],
    ['routes/vendorExtras.ts', 'vendor_bill', ["app.post('/vendor-bills/:id/credit-notes'"]],
    ['routes/vendorExtras.ts', 'vendor_credit_note', ["app.post('/vendor-credit-notes/:id'"]],
  ];

  for (const [file, kind, markers] of PINNED) {
    it(`${file}: ${kind}`, () => {
      const s = src(`apps/api/src/${file}`);
      for (const m of markers) expect(routeBlock(s, m), m).toContain(`assertRecordInScope('${kind}', `);
    });
  }

  it('every /:pid and /invoices|vendor-bills/:id route in those files is on the list', () => {
    for (const [file, re] of [
      ['routes/payments.ts', /app\.\w+\('\/payment-requests\/:pid[^']*'/g],
      ['routes/invoices.ts', /app\.\w+\('\/invoices\/:id[^']*'/g],
      ['routes/vendorBills.ts', /app\.\w+\('\/vendor-bills\/:id[^']*'/g],
    ] as const) {
      const s = src(`apps/api/src/${file}`);
      const found = [...s.matchAll(re)].map((m) => m[0]);
      const pinned = PINNED.filter(([f]) => f === file).flatMap(([, , m]) => m);
      expect(found.sort(), file).toEqual(pinned.sort());
    }
  });

  it('creating an invoice or a vendor bill checks the work order named in the body', () => {
    expect(routeBlock(src('apps/api/src/routes/invoices.ts'), "app.post('/invoices'")).toContain('await assertTaskInScope(task_id, actor);');
    expect(routeBlock(src('apps/api/src/routes/vendorBills.ts'), "app.post('/vendor-bills'")).toContain('await assertTaskInScope(body.task_id,');
  });

  it('the rest already resolve through their work order: quote (and its print page), attachments, calls, AI drafts, purchasing', () => {
    const quotes = src('apps/api/src/routes/quotes.ts');
    expect(routeBlock(quotes, "app.get('/work-orders/:id/quote'")).toContain('await taskIdOf(req)');
    expect(quotes).toMatch(/async function taskIdOf\(req: FastifyRequest\)[\s\S]*resolveTaskId\(/);
    const att = src('apps/api/src/services/attachments.ts');
    expect(att.match(/WHERE a\.id = \$1 AND a\.task_id = \$2/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(src('apps/api/src/services/woCalls.ts')).toMatch(/WHERE c\.id = \$1 AND c\.task_id = \$2/);
    const purch = src('apps/api/src/services/purchasing.ts');
    expect(purch.match(/scopeOr\(actor, p, '(r|q|po)\.task_id'\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

// ── M28 · hidden fields stay hidden ──────────────────────────────────────────

describe('M28 · audit rows and dashboard cards', () => {
  const noCost: PermissionSet = {
    role: { work_orders: { view: true }, 'work_orders/fields/finances/fields.34. Cost': { view: false } },
    overrides: {},
  };
  const allow = allowFor({ isSuperAdmin: false, perms: noCost });

  it('activityFieldKey names catalogue fields only', () => {
    expect(activityFieldKey('fields.34. Cost')).toBe('fields.34. Cost');
    expect(activityFieldKey('nte')).toBe('nte');
    expect(activityFieldKey('status_id')).toBeNull();
    expect(activityFieldKey('visit:abc')).toBeNull();
    expect(activityFieldKey(null)).toBeNull();
  });

  it('a row on a hidden field keeps its who / when but loses its values', () => {
    expect(activityValuesVisible(allow, 'fields.34. Cost')).toBe(false);
    expect(activityValuesVisible(allow, 'fields.Store')).toBe(true);
    expect(activityValuesVisible(allow, 'status_id')).toBe(true);
    const row = redactActivityValues(allow, { field: 'fields.34. Cost', before: { value: 1 }, after: { value: 2 } } as {
      field: string;
      before: unknown;
      after: unknown;
      redacted?: boolean;
    });
    expect(row).toEqual({ field: 'fields.34. Cost', before: null, after: null, redacted: true });
  });

  it('the detail’s recent activity drops those rows', () => {
    const wo = redactWorkOrder(allow, {
      fields: {},
      recent_activity: [{ field: 'fields.34. Cost' }, { field: 'status_id' }, { field: null }],
    } as { fields: Record<string, unknown>; recent_activity: { field: string | null }[] });
    expect(wo.recent_activity).toEqual([{ field: 'status_id' }, { field: null }]);
  });

  it('wiring: Admin › Audit, its export and the /activity feed', () => {
    const log = src('apps/api/src/services/auditLog.ts');
    expect(log).toMatch(/items: rows\.rows\.map\(mapRow\)\.map\(\(e\) => redactActivityValues\(allow, e\)\)/);
    expect(src('apps/api/src/routes/admin.ts')).toMatch(/listAuditLog\(parse\(auditQuerySchema, req\.query\), allowFor\(permissionSubject\(req\)\)\)/);
    expect(src('apps/api/src/routes/admin.ts')).toMatch(/exportAuditCsv\(filters, allowFor\(permissionSubject\(req\)\)\)/);
    expect(src('apps/api/src/routes/activity.ts')).toMatch(/filter\(\(e\) => activityValuesVisible\(allow, e\.field\)\)/);
  });

  it('widgetNamedFields lists every field a card reads', () => {
    expect(
      widgetNamedFields({
        value_field: 'fields.34. Cost',
        group_field: 'trade',
        time_field: 'date_received',
        filters: { rules: [{ field: 'fields.Store' }] },
        from: { kind: 'event', field: 'status' },
        to: { kind: 'date', field: 'span_end' },
      }).sort(),
    ).toEqual(['date_received', 'fields.34. Cost', 'fields.Store', 'status', 'trade']);
    expect(widgetNamedFields({ source: 'invoices', value_field: 'total' })).toEqual([]);
  });

  it('a card on a hidden field answers "not available", in the board and in the preview', () => {
    const dash = src('apps/api/src/services/dashboards.ts');
    expect(dash).toMatch(/if \(!widgetFieldsVisible\(widget\.config, viewer\)\) \{\s*return \{ widget_id: widget\.id, total: 0, buckets: \[\], other: 0, error: WIDGET_NOT_AVAILABLE \};/);
    expect(dash).toMatch(/if \(!widgetFieldsVisible\(config, viewer\)\) \{\s*return \{ widget_id: 'preview'/);
    // The VIEWER's grants decide, not the board's widened scope.
    expect(dash).toMatch(/const allow = allowFor\(viewer\);\s*return widgetNamedFields\(config\)\.every\(\(k\) => canViewField\(allow, k\)\);/);
  });
});

// ── M29 · the site restriction is a flag ─────────────────────────────────────

describe('M29 · principal.site_restricted', () => {
  it('the session reads the flag, not "has rows"', () => {
    const auth = src('apps/api/src/services/auth.ts');
    expect(auth).toMatch(/p\.site_restricted AS site_restricted,/);
    expect(auth).not.toMatch(/EXISTS \(SELECT 1 FROM principal_site ps WHERE ps\.principal_id = p\.id\) AS site_restricted/);
  });

  it('the scope still ANDs the list, so flag on + empty list = no work orders', () => {
    const scope = src('apps/api/src/services/woScope.ts');
    expect(scope).toMatch(/actor\.siteRestricted && !actor\.isSuperAdmin\s*\?\s*`\$\{alias\}\.site_id IN \(SELECT ps\.site_id FROM principal_site ps WHERE ps\.principal_id = /);
  });

  it('setSiteAccess writes the flag under the person’s row lock; the route takes `restricted`', () => {
    const svc = src('apps/api/src/services/portfolioExtras.ts');
    expect(svc).toMatch(/SELECT is_super_admin FROM principal WHERE id = \$1 FOR NO KEY UPDATE/);
    expect(svc).toMatch(/UPDATE principal SET site_restricted = \$2 WHERE id = \$1/);
    expect(src('apps/api/src/routes/portfolio.ts')).toMatch(/restricted: z\.boolean\(\)\.optional\(\)/);
    expect(src('apps/web/src/pages/admin/AdminPortfolioPage.tsx')).toContain('Restrict to sites');
  });
});

// ── the permission resolver itself is untouched ─────────────────────────────

describe('sanity', () => {
  it('permAllows still treats a super admin as holding everything', () => {
    expect(permAllows({ role: {}, overrides: {} }, 'invoicing', 'approve', true)).toBe(true);
  });
});

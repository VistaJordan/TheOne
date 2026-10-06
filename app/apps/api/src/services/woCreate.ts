// "Add work order" — raising a work order by hand (0041).
//
// Three jobs live here:
//
//   the form        which fields the browser draws, read from
//                   field_def.create_mode (Admin › Custom fields), so adding
//                   a field to intake is configuration, not a deploy.
//   the duplicate   WO # is the work order's identity. A repeat is REFUSED,
//                   trash included — task.wo_number is UNIQUE, and this check
//                   is what turns that constraint into a sentence a person can
//                   act on, with a link to the work order already holding the
//                   number. Matching ignores case and punctuation, so
//                   "wo 12345", "WO-12345" and "12345" are one number.
//                   A near-match (same store + trade, still open) only warns:
//                   a store really can break twice in a month.
//   the write       the same INSERT the intake draft's Submit runs, so a work
//                   order raised here is indistinguishable from one raised
//                   there — same start status, same profit formula, same
//                   'created' activity row, same automations, and the
//                   assignment written through the ordinary field path so it
//                   is audited and mirrored.
//
// Creation is lighter than assignment on purpose: rule 11.1.1 still demands
// its 13 fields before this work order can be assigned or accepted, so a
// coordinator can raise one from a phone call with nothing but the number.

import {
  WO_CREATE_MISSING_CODE,
  WO_CREATE_SECTIONS,
  WO_NEAR_DUPLICATE_DAYS,
  WO_NUMBER_TAKEN_CODE,
  describeMissing,
  isWoCreateMode,
  normalizeWoNumber,
  woCreateMissing,
  type WoCreateField,
  type WoCreateForm,
  applyFormLayout,
  permAllows,
  pickFormLayout,
  type WoCreateInput,
  type WoCreateMode,
  type WoFormLayout,
  type WoFormLayoutInput,
  type WoCreateTemplate,
  type WoCreateTemplateInput,
  type WoDuplicateHit,
  type WoNumberCheck,
  type WoSubcategoryRow,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { requirePerm } from './permissions.js';
import { storageReady } from './attachments.js';
import { logAdminEvent } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';
import { applyProfitFormula } from './money.js';
import { stampDateCreated } from './dateCreated.js';
import { INTAKE_START_STATUS_NAME } from './intake.js';
import { dispatchAutomations } from './automations.js';

const PERM_KEY = 'work_orders';

export function requireWoCreate(p: ActingPrincipal): void {
  requirePerm(p, PERM_KEY, 'view', 'You cannot view work orders');
  requirePerm(p, PERM_KEY, 'create', 'You cannot create work orders');
}

/** Which section of the form a key belongs under; anything an admin switched
    on that the sections do not name lands in "More details". */
const SECTION_BY_KEY = new Map<string, string>();
for (const s of WO_CREATE_SECTIONS) for (const k of s.keys) SECTION_BY_KEY.set(k, s.id);

interface FormRow {
  key: string;
  label: string;
  type: string;
  create_mode: string;
  options: unknown;
}

/** The form as configured: every field that is not 'off', in admin order. */
export async function getCreateForm(): Promise<WoCreateForm> {
  const res = await query<FormRow>(
    `SELECT f.key, f.label, f.type::text AS type, f.create_mode,
            CASE WHEN jsonb_typeof(f.type_config->'options') = 'array'
                 THEN f.type_config->'options' ELSE '[]'::jsonb END AS options
       FROM field_def f
      WHERE f.create_mode <> 'off'
      ORDER BY f.position NULLS LAST, f.key ASC`,
  );

  const fields: WoCreateField[] = res.rows.map((r) => ({
    key: r.key,
    label: r.label,
    type: r.type,
    options: Array.isArray(r.options)
      ? (r.options as unknown[])
          .map((o) =>
            typeof o === 'string'
              ? o
              : String((o as Record<string, unknown>)?.name ?? (o as Record<string, unknown>)?.label ?? ''),
          )
          .filter((s) => s.length > 0)
      : [],
    mode: r.create_mode === 'required' ? 'required' : 'optional',
    section: SECTION_BY_KEY.get(r.key) ?? 'more',
  }));

  // 0063 · the sub-categories each trade offers (Admin › Settings).
  const subs = await query<{ trade: string; name: string }>(
    `SELECT trade, name FROM wo_subcategory WHERE is_active ORDER BY lower(trade), position, lower(name)`,
  );
  const subcategories: Record<string, string[]> = {};
  for (const r of subs.rows) (subcategories[r.trade.trim().toLowerCase()] ??= []).push(r.name);

  // 0064 · the layouts the browser lays over the form once the client and
  // the trade are known; createWorkOrder picks the same one again.
  return { fields, subcategories, layouts: await loadFormLayouts(true), storage_ready: storageReady() };
}

// ── Form layouts (0064) ──────────────────────────────────────────────────────

async function loadFormLayouts(activeOnly: boolean): Promise<WoFormLayout[]> {
  const res = await query<{ id: string; name: string; client: string | null; trade: string | null; fields: Record<string, unknown> | null; is_active: boolean }>(
    `SELECT id::text AS id, name, client, trade, fields, is_active FROM wo_form_layout
      ${activeOnly ? 'WHERE is_active' : ''} ORDER BY lower(name)`,
  );
  return res.rows.map((r) => {
    const fields: Record<string, WoCreateMode> = {};
    for (const [k, v] of Object.entries(r.fields ?? {})) if (isWoCreateMode(v)) fields[k] = v;
    return { id: r.id, name: r.name, client: r.client, trade: r.trade, fields, is_active: r.is_active };
  });
}

const LAYOUT_KEY = 'admin/settings';

export async function listFormLayoutsAdmin(actor: ActingPrincipal): Promise<{ layouts: WoFormLayout[]; form: WoCreateForm; clients: string[] }> {
  requirePerm(actor, LAYOUT_KEY, 'view', 'You cannot open Admin › Settings');
  const [layouts, form, clients] = await Promise.all([
    loadFormLayouts(false),
    getCreateForm(),
    query<{ v: string }>(`SELECT DISTINCT btrim(client) AS v FROM task WHERE deleted_at IS NULL AND btrim(COALESCE(client, '')) <> '' ORDER BY 1`),
  ]);
  return { layouts, form: { fields: form.fields }, clients: clients.rows.map((r) => r.v) };
}

export async function saveFormLayout(id: string | null, input: WoFormLayoutInput, actor: ActingPrincipal): Promise<{ layouts: WoFormLayout[]; form: WoCreateForm; clients: string[] }> {
  requirePerm(actor, LAYOUT_KEY, 'edit', 'You cannot edit Admin › Settings');
  const name = String(input.name ?? '').trim();
  if (name === '') throw badRequest('The layout needs a name', { field: 'name' });
  const client = str(input.client);
  const trade = str(input.trade);
  if (!client && !trade) throw badRequest('A layout applies to a client, a trade, or both — pick at least one');
  const fields: Record<string, WoCreateMode> = {};
  for (const [k, v] of Object.entries(input.fields ?? {})) if (isWoCreateMode(v)) fields[k] = v;
  if (id) {
    if (!UUID_RE.test(id)) throw badRequest('That layout does not exist');
    const res = await query<{ id: string }>(
      `UPDATE wo_form_layout SET name = $2, client = $3, trade = $4, fields = $5::jsonb, is_active = COALESCE($6, is_active) WHERE id = $1 RETURNING id`,
      [id, name.slice(0, 120), client, trade, JSON.stringify(fields), input.is_active ?? null],
    );
    if (!res.rows[0]) throw badRequest('That layout does not exist');
    await logAdminEvent({ actorId: actor.id, entity: 'wo_form_layout', entityId: id, action: 'wo_form_layout_updated', after: { name, client, trade, fields } });
  } else {
    const ins = await query<{ id: string }>(
      `INSERT INTO wo_form_layout (name, client, trade, fields, created_by) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id::text AS id`,
      [name.slice(0, 120), client, trade, JSON.stringify(fields), actor.id],
    );
    await logAdminEvent({ actorId: actor.id, entity: 'wo_form_layout', entityId: ins.rows[0].id, action: 'wo_form_layout_added', after: { name, client, trade, fields } });
  }
  return listFormLayoutsAdmin(actor);
}

export async function deleteFormLayout(id: string, actor: ActingPrincipal): Promise<{ layouts: WoFormLayout[]; form: WoCreateForm; clients: string[] }> {
  requirePerm(actor, LAYOUT_KEY, 'edit', 'You cannot edit Admin › Settings');
  if (!UUID_RE.test(id)) throw badRequest('That layout does not exist');
  const res = await query<{ name: string }>(`DELETE FROM wo_form_layout WHERE id = $1 RETURNING name`, [id]);
  if (!res.rows[0]) throw badRequest('That layout does not exist');
  await logAdminEvent({ actorId: actor.id, entity: 'wo_form_layout', entityId: id, action: 'wo_form_layout_deleted', before: { name: res.rows[0].name } });
  return listFormLayoutsAdmin(actor);
}

// ── The duplicate check ──────────────────────────────────────────────────────

/** `task.wo_number` reduced the way `normalizeWoNumber` reduces what was
    typed — punctuation gone, upper case, a leading "WO" dropped. */
const NORMALIZED_WO = `regexp_replace(regexp_replace(upper(t.wo_number), '[^A-Z0-9]', '', 'g'), '^WO', '')`;

const HIT_SQL = `
  SELECT t.wo_number,
         t.title,
         t.client,
         t.fields->>'Store' AS store,
         t.trade,
         s.name AS status,
         (t.deleted_at IS NOT NULL) AS deleted,
         to_char((t.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM task t
    JOIN status s ON s.id = t.status_id`;

interface HitRow extends Omit<WoDuplicateHit, 'deleted'> {
  deleted: boolean;
}

/**
 * Is this number free, and is something like it already open? Runs on every
 * keystroke of the WO # box (debounced) and again inside create.
 */
export async function checkWoNumber(
  raw: string,
  context: { store?: string | null; trade?: string | null; site_id?: string | null; asset_id?: string | null } = {},
): Promise<WoNumberCheck> {
  const woNumber = raw.trim();
  const normalized = normalizeWoNumber(woNumber);

  let existing: WoDuplicateHit | null = null;
  if (normalized.length > 0) {
    // Trash included: the number stays taken, because restoring the row would
    // otherwise collide with whatever took its place.
    const dup = await query<HitRow>(`${HIT_SQL} WHERE ${NORMALIZED_WO} = $1 LIMIT 1`, [normalized]);
    existing = dup.rows[0] ?? null;
  }

  const store = (context.store ?? '').trim();
  const trade = (context.trade ?? '').trim();
  let near: WoDuplicateHit[] = [];
  if (store.length > 0 && trade.length > 0) {
    // Warning only: same store, same trade, still open, raised inside the
    // window. Never blocks — the second cooler failure of the month is real.
    const res = await query<HitRow>(
      `${HIT_SQL}
        WHERE t.deleted_at IS NULL
          AND t.status_group IN ('open', 'active')
          AND t.fields->>'Store' = $1
          AND t.trade = $2
          AND t.created_at >= now() - ($3 || ' days')::interval
          AND ($4 = '' OR ${NORMALIZED_WO} <> $4)
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [store, trade, String(WO_NEAR_DUPLICATE_DAYS), normalized],
    );
    near = res.rows.map((r) => ({ ...r, why: 'store_trade' as const }));
  }

  // 0063 · the same asset, or the same site record: open work already there.
  // On the asset, any trade and any age — one machine, one fault at a time.
  // At the site, the same trade inside the window (every trade when none is
  // picked yet). Warnings, like the rule above; the asset's come first.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const seen = new Set(near.map((n) => n.wo_number));
  const add = (rows: HitRow[], why: 'site' | 'asset', first: boolean) => {
    const fresh = rows.filter((r) => !seen.has(r.wo_number)).map((r) => ({ ...r, why }));
    for (const r of fresh) seen.add(r.wo_number);
    near = first ? [...fresh, ...near] : [...near, ...fresh];
  };
  if (context.site_id && UUID.test(context.site_id)) {
    const res = await query<HitRow>(
      `${HIT_SQL}
        WHERE t.deleted_at IS NULL
          AND t.status_group::text NOT IN ('done', 'closed')
          AND t.site_id = $1
          AND ($2 = '' OR lower(t.trade) = lower($2))
          AND t.created_at >= now() - ($3 || ' days')::interval
          AND ($4 = '' OR ${NORMALIZED_WO} <> $4)
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [context.site_id, trade, String(WO_NEAR_DUPLICATE_DAYS), normalized],
    );
    add(res.rows, 'site', false);
  }
  if (context.asset_id && UUID.test(context.asset_id)) {
    const res = await query<HitRow>(
      `${HIT_SQL}
        WHERE t.deleted_at IS NULL
          AND t.status_group::text NOT IN ('done', 'closed')
          AND t.asset_id = $1
          AND ($2 = '' OR ${NORMALIZED_WO} <> $2)
        ORDER BY t.created_at DESC
        LIMIT 5`,
      [context.asset_id, normalized],
    );
    add(res.rows, 'asset', true);
  }
  near = near.slice(0, 8);

  return { wo_number: woNumber, taken: existing !== null, existing, near };
}

// ── The write ────────────────────────────────────────────────────────────────

/** First meaningful line of the description, the way the import and the
    intake draft title a work order; the WO # when there is none. */
function titleOf(description: string | null, woNumber: string): string {
  const line = (description ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return woNumber;
  return line.length > 120 ? line.slice(0, 120) : line;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** "$1,610.00" → 1610; anything that is not a number → null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const digits = String(v).replace(/[^0-9.-]/g, '');
  if (!/^-?\d*\.?\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD…' → the day; anything else → null (the column is a date). */
function day(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The bag key of the Assignee seat — written after the insert, through the
    ordinary field path, so it is audited and scope-mirrored like any other
    assignment (the same thing the intake draft's Submit does). */
const ASSIGNEE_KEY = 'Assignee';

export interface WoCreateResult {
  task_id: string;
  wo_number: string;
}

export async function createWorkOrder(
  input: WoCreateInput,
  actor: ActingPrincipal,
): Promise<WoCreateResult> {
  requireWoCreate(actor);

  const woNumber = String(input.wo_number ?? '').trim();
  if (woNumber.length === 0) throw badRequest('A work order needs its WO #');
  if (woNumber.length > 60) throw badRequest('That WO # is too long');

  // Only keys the form offers are accepted: a field an admin switched off is
  // not quietly written by a stale browser tab.
  const configured = await getCreateForm();
  // 0064 · the layout for this client and trade is laid over the form, the
  // same way the browser did it, so "required" and "off" mean one thing.
  const form = applyFormLayout(
    configured,
    pickFormLayout(configured.layouts ?? [], str(input.fields?.['Client']), str(input.fields?.['Trade'])),
  );
  const offered = new Map(form.fields.map((f) => [f.key, f]));
  const bag: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.fields ?? {})) {
    if (!offered.has(key)) continue;
    if (value === null || value === undefined) continue;
    const s = typeof value === 'string' ? value.trim() : value;
    if (typeof s === 'string' && s.length === 0) continue;
    bag[key] = s;
  }

  const missing = woCreateMissing(form, bag, woNumber);
  if (missing.length > 0) {
    throw conflict(`This work order still needs ${describeMissing(missing)}`, {
      code: WO_CREATE_MISSING_CODE,
      missing,
    });
  }

  const check = await checkWoNumber(woNumber);
  if (check.existing) {
    const where = check.existing.deleted ? ' (in the trash)' : '';
    throw conflict(`A work order numbered ${check.existing.wo_number} already exists${where}`, {
      code: WO_NUMBER_TAKEN_CODE,
      wo_number: check.existing.wo_number,
      existing: check.existing,
    });
  }

  // 0063 · the site record and one of its assets, when the form named them.
  const place = await resolveCreatePlace(input, actor);

  const start = await query<{ id: string; status_group: string }>(
    `SELECT id::text AS id, status_group::text AS status_group FROM status WHERE lower(name) = lower($1) LIMIT 1`,
    [INTAKE_START_STATUS_NAME],
  );
  if (!start.rows[0]) {
    throw conflict(
      `There is no "${INTAKE_START_STATUS_NAME}" status to start the work order in. Add it under Admin › Statuses first.`,
      { status_name: INTAKE_START_STATUS_NAME },
    );
  }

  // The assignment is written after the insert, not inside the bag.
  const assignee = str(bag[ASSIGNEE_KEY]);
  delete bag[ASSIGNEE_KEY];
  applyProfitFormula(bag);
  // The moment of creation, so nobody types it in later.
  stampDateCreated(bag);

  const description = str(bag['35. WO Description']);
  let taskId = '';
  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO task
         (wo_number, ext_name, title, description, client, city, state, trade,
          billing_entity, nte, priority, date_received, home_list_id,
          status_id, status_group, fields)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11, $12::date, $13, $14, $15, $16::jsonb)
       RETURNING id::text AS id`,
      [
        woNumber,
        null,
        titleOf(description, woNumber),
        description,
        str(bag['Client']),
        str(bag['City']),
        str(bag['State']),
        str(bag['Trade']),
        str(bag['21. Comp']),
        num(bag['16. Client NTE 🔴']),
        null,
        day(bag['Date-Time Received']),
        null,
        start.rows[0].id,
        start.rows[0].status_group,
        JSON.stringify(bag),
      ],
    );
    taskId = ins.rows[0].id;
    if (place.siteId) {
      await tx.query(`UPDATE task SET site_id = $2, asset_id = $3 WHERE id = $1`, [taskId, place.siteId, place.assetId]);
    }
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
      [actor.id, taskId, JSON.stringify({ wo_number: woNumber, source: 'manual', ...(place.siteName ? { site: place.siteName } : {}), ...(place.assetName ? { asset: place.assetName } : {}) })],
    );
  });

  // After the commit, exactly as the intake draft does it: the create rules
  // first, then the assignment as this person's ordinary field edit.
  await dispatchAutomations({ taskId, kind: 'created' });
  // 0066 · the dispatch cascade, when it is switched on AND set to start by
  // itself (both are off by default): offer the job to the first preferred
  // vendor. A no-op otherwise.
  {
    const { maybeAutoStartDispatch } = await import('./vendorExtras.js');
    await maybeAutoStartDispatch(taskId, actor.id);
  }
  if (assignee) {
    const { updateWorkOrderFields } = await import('./woFieldValues.js');
    await updateWorkOrderFields(taskId, { [`fields.${ASSIGNEE_KEY}`]: assignee }, actor.id);
  }

  return { task_id: taskId, wo_number: woNumber };
}

// ── The site and the asset (0063) ────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Checks what the form named: the site exists and is one the person may
 *  see; the asset exists and stands at that site. An asset alone names its
 *  own site. Nothing named = nothing linked, exactly as before 0063. */
async function resolveCreatePlace(
  input: WoCreateInput,
  actor: ActingPrincipal,
): Promise<{ siteId: string | null; assetId: string | null; siteName: string | null; assetName: string | null }> {
  let siteId = input.site_id ?? null;
  const assetId = input.asset_id ?? null;
  let assetName: string | null = null;
  if (assetId) {
    if (!UUID_RE.test(assetId)) throw badRequest('That asset does not exist', { field: 'asset_id' });
    const a = await query<{ name: string; site_id: string | null }>(
      `SELECT name, site_id::text AS site_id FROM asset WHERE id = $1 AND deleted_at IS NULL`,
      [assetId],
    );
    if (!a.rows[0]) throw badRequest('That asset does not exist', { field: 'asset_id' });
    if (!siteId) siteId = a.rows[0].site_id;
    if (a.rows[0].site_id !== siteId) throw badRequest('That asset is at a different site', { field: 'asset_id' });
    assetName = a.rows[0].name;
  }
  if (!siteId) return { siteId: null, assetId: null, siteName: null, assetName: null };
  if (!UUID_RE.test(siteId)) throw badRequest('That site does not exist', { field: 'site_id' });
  const s = await query<{ name: string | null }>(`SELECT COALESCE(name, client) AS name FROM site WHERE id = $1 AND deleted_at IS NULL`, [siteId]);
  if (!s.rows[0]) throw badRequest('That site does not exist', { field: 'site_id' });
  const { assertSiteAccess } = await import('./portfolio.js');
  await assertSiteAccess(actor, siteId);
  return { siteId, assetId, siteName: s.rows[0].name, assetName };
}

// ── Form templates (0063) ────────────────────────────────────────────────────

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  fields: Record<string, unknown> | null;
  s_id: string | null;
  s_name: string | null;
  shared: boolean;
  created_by: string | null;
  owner: string | null;
};

/** The viewer's own templates and every shared one. */
export async function listCreateTemplates(actor: ActingPrincipal): Promise<WoCreateTemplate[]> {
  requireWoCreate(actor);
  const res = await query<TemplateRow>(
    `SELECT t.id::text AS id, t.name, t.description, t.fields, s.id::text AS s_id, COALESCE(s.name, s.client) AS s_name,
            t.shared, t.created_by::text AS created_by, p.display_name AS owner
       FROM wo_create_template t
       LEFT JOIN site s ON s.id = t.site_id AND s.deleted_at IS NULL
       LEFT JOIN principal p ON p.id = t.created_by
      WHERE t.shared OR t.created_by = $1
      ORDER BY t.shared DESC, lower(t.name)`,
    [actor.id],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    fields: r.fields ?? {},
    site: r.s_id ? { id: r.s_id, name: r.s_name ?? 'Site' } : null,
    shared: r.shared,
    mine: r.created_by === actor.id,
    owner: r.owner,
  }));
}

/** Sharing a template with everyone is for whoever may arrange the form
 *  itself (Admin › Custom fields). */
const canShareTemplates = (a: ActingPrincipal): boolean => a.isSuperAdmin || permAllows(a.perms, 'admin/fields', 'edit', a.isSuperAdmin);

export async function saveCreateTemplate(input: WoCreateTemplateInput, actor: ActingPrincipal): Promise<WoCreateTemplate[]> {
  requireWoCreate(actor);
  const name = String(input.name ?? '').trim();
  if (name === '') throw badRequest('The template needs a name', { field: 'name' });
  if (input.shared && !canShareTemplates(actor)) throw badRequest('Only an admin can share a template with everyone');
  // Only what the form offers today, and never the identity of one job.
  const form = await getCreateForm();
  const offered = new Set(form.fields.map((f) => f.key));
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input.fields ?? {})) {
    if (!offered.has(k) || v === null || v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    fields[k] = typeof v === 'string' ? v.trim().slice(0, 4000) : v;
  }
  let siteId: string | null = null;
  if (input.site_id) {
    if (!UUID_RE.test(input.site_id)) throw badRequest('That site does not exist', { field: 'site_id' });
    const s = await query<{ id: string }>(`SELECT id FROM site WHERE id = $1 AND deleted_at IS NULL`, [input.site_id]);
    if (!s.rows[0]) throw badRequest('That site does not exist', { field: 'site_id' });
    siteId = input.site_id;
  }
  if (Object.keys(fields).length === 0 && !siteId) throw badRequest('Fill in at least one field before saving a template');
  const ins = await query<{ id: string }>(
    `INSERT INTO wo_create_template (name, description, fields, site_id, shared, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6) RETURNING id::text AS id`,
    [name.slice(0, 120), str(input.description), JSON.stringify(fields), siteId, Boolean(input.shared), actor.id],
  );
  await logAdminEvent({ actorId: actor.id, entity: 'wo_template', entityId: ins.rows[0].id, action: 'wo_template_saved', after: { name, shared: Boolean(input.shared), fields: Object.keys(fields) } });
  return listCreateTemplates(actor);
}

export async function deleteCreateTemplate(id: string, actor: ActingPrincipal): Promise<WoCreateTemplate[]> {
  requireWoCreate(actor);
  if (!UUID_RE.test(id)) throw badRequest('That template does not exist');
  const cur = await query<{ name: string; created_by: string | null; shared: boolean }>(
    `SELECT name, created_by::text AS created_by, shared FROM wo_create_template WHERE id = $1`,
    [id],
  );
  if (!cur.rows[0]) throw badRequest('That template does not exist');
  // Your own, or a shared one if you may share.
  if (cur.rows[0].created_by !== actor.id && !(cur.rows[0].shared && canShareTemplates(actor))) {
    throw badRequest('That template belongs to someone else');
  }
  await query(`DELETE FROM wo_create_template WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'wo_template', entityId: id, action: 'wo_template_deleted', before: { name: cur.rows[0].name } });
  return listCreateTemplates(actor);
}

// ── Sub-categories (0063, Admin › Settings) ──────────────────────────────────

const SETTINGS_KEY = 'admin/settings';

export async function listSubcategories(actor: ActingPrincipal): Promise<{ items: WoSubcategoryRow[]; trades: string[] }> {
  requirePerm(actor, SETTINGS_KEY, 'view', 'You cannot open Admin › Settings');
  const [rows, trades] = await Promise.all([
    query<WoSubcategoryRow>(`SELECT id::text AS id, trade, name, position, is_active FROM wo_subcategory ORDER BY lower(trade), position, lower(name)`),
    query<{ options: unknown }>(`SELECT type_config->'options' AS options FROM field_def WHERE key = 'Trade' LIMIT 1`),
  ]);
  const opts = Array.isArray(trades.rows[0]?.options) ? (trades.rows[0]!.options as unknown[]) : [];
  return {
    items: rows.rows,
    trades: opts.map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)?.name ?? (o as Record<string, unknown>)?.label ?? ''))).filter(Boolean),
  };
}

export async function addSubcategory(input: { trade: string; name: string }, actor: ActingPrincipal): Promise<{ items: WoSubcategoryRow[]; trades: string[] }> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  const trade = String(input.trade ?? '').trim();
  const name = String(input.name ?? '').trim();
  if (trade === '' || name === '') throw badRequest('Pick the trade and name the sub-category');
  const dup = await query<{ id: string }>(`SELECT id FROM wo_subcategory WHERE lower(trade) = lower($1) AND lower(name) = lower($2)`, [trade, name]);
  if (dup.rows[0]) throw conflict(`${name} is already a sub-category of ${trade}`);
  await query(
    `INSERT INTO wo_subcategory (trade, name, position)
     VALUES ($1, $2, (SELECT COALESCE(max(position), -1) + 1 FROM wo_subcategory WHERE lower(trade) = lower($1)))`,
    [trade.slice(0, 80), name.slice(0, 80)],
  );
  await logAdminEvent({ actorId: actor.id, entity: 'wo_subcategory', entityId: `${trade}:${name}`, action: 'wo_subcategory_added', after: { name, trade } });
  return listSubcategories(actor);
}

export async function updateSubcategory(id: string, patch: { name?: string; is_active?: boolean }, actor: ActingPrincipal): Promise<{ items: WoSubcategoryRow[]; trades: string[] }> {
  requirePerm(actor, SETTINGS_KEY, 'edit', 'You cannot edit Admin › Settings');
  if (!UUID_RE.test(id)) throw badRequest('That sub-category does not exist');
  const cur = await query<{ trade: string; name: string; is_active: boolean }>(`SELECT trade, name, is_active FROM wo_subcategory WHERE id = $1`, [id]);
  if (!cur.rows[0]) throw badRequest('That sub-category does not exist');
  const name = patch.name !== undefined ? patch.name.trim() : cur.rows[0].name;
  if (name === '') throw badRequest('It needs a name');
  if (name.toLowerCase() !== cur.rows[0].name.toLowerCase()) {
    const dup = await query<{ id: string }>(`SELECT id FROM wo_subcategory WHERE lower(trade) = lower($1) AND lower(name) = lower($2)`, [cur.rows[0].trade, name]);
    if (dup.rows[0]) throw conflict(`${name} is already a sub-category of ${cur.rows[0].trade}`);
  }
  await query(`UPDATE wo_subcategory SET name = $2, is_active = $3 WHERE id = $1`, [id, name.slice(0, 80), patch.is_active ?? cur.rows[0].is_active]);
  await logAdminEvent({
    actorId: actor.id,
    entity: 'wo_subcategory',
    entityId: `${cur.rows[0].trade}:${name}`,
    action: 'wo_subcategory_updated',
    before: { name: cur.rows[0].name, trade: cur.rows[0].trade, is_active: cur.rows[0].is_active },
    after: { name, trade: cur.rows[0].trade, is_active: patch.is_active ?? cur.rows[0].is_active },
  });
  return listSubcategories(actor);
}

// ── Admin › Custom fields: the per-field setting ─────────────────────────────

export function parseCreateMode(raw: unknown): string {
  if (!isWoCreateMode(raw)) throw badRequest('Unknown create-form setting');
  return raw;
}

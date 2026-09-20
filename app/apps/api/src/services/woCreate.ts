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
  type WoCreateInput,
  type WoDuplicateHit,
  type WoNumberCheck,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { requirePerm } from './permissions.js';
import type { ActingPrincipal } from './activity.js';
import { applyProfitFormula } from './money.js';
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

  return { fields };
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
  context: { store?: string | null; trade?: string | null } = {},
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
    near = res.rows;
  }

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
  const form = await getCreateForm();
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
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'created', NULL, NULL, $3::jsonb)`,
      [actor.id, taskId, JSON.stringify({ wo_number: woNumber, source: 'manual' })],
    );
  });

  // After the commit, exactly as the intake draft does it: the create rules
  // first, then the assignment as this person's ordinary field edit.
  await dispatchAutomations({ taskId, kind: 'created' });
  if (assignee) {
    const { updateWorkOrderFields } = await import('./woFieldValues.js');
    await updateWorkOrderFields(taskId, { [`fields.${ASSIGNEE_KEY}`]: assignee }, actor.id);
  }

  return { task_id: taskId, wo_number: woNumber };
}

// ── Admin › Custom fields: the per-field setting ─────────────────────────────

export function parseCreateMode(raw: unknown): string {
  if (!isWoCreateMode(raw)) throw badRequest('Unknown create-form setting');
  return raw;
}

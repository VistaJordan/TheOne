// 0078 · ClickUp sync: every new work order becomes a ClickUp task in the
// configured List, and every change made in The One follows it there.
//
// ONE-WAY on purpose: The One is the source of truth (Elise, 2026-10-13).
// Nothing is read back from ClickUp but the List's own vocabulary (fields,
// options, statuses, members); an edit made in ClickUp is overwritten by the
// next change here.
//
// The queue is the activity log. Every write to a work order already lands in
// activity_log (woAudit.ts), so the runner does not hook any write path:
//   1. MARK  — links work orders created since `sync_from` (the first run
//      with the switch on, so today's mock data never goes) and marks dirty
//      every linked one with a log row past the cursor. A 10-minute look-back
//      covers transactions that committed after a higher id was read.
//   2. PUSH  — per dirty link: no ClickUp id yet → create the task in the
//      List with everything mapped; otherwise compute every mapped value,
//      compare with what was last pushed (`pushed`), and send only what
//      differs: one PUT for the task's own fields, one call per custom field.
// A value ClickUp cannot take (an option its dropdown lacks, a person with no
// ClickUp account) is remembered against that value, shown in Admin ›
// Integrations, and retried only when the value changes. Network / 5xx /
// rate-limit failures back off and retry. ClickUp's own automations move the
// task out of the Incoming List on assignment — the task id does not change,
// so updates follow it (fields must live at Space or Folder level to exist
// in the List it moves to).
//
// It runs straight after every write request (app.ts, kept alive past the
// response with Vercel's waitUntil) and from a once-a-minute cron; a lease
// on clickup_config keeps two runs from pushing the same task twice.

import {
  CLICKUP_NATIVE_TARGETS,
  INTEGRATIONS_PERM_KEY,
  type ClickUpFieldDef,
  type ClickUpMapRow,
  type ClickUpOverview,
  type ClickUpTarget,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest } from '../errors.js';
import {
  ClickUpError,
  ClickUpRateLimited,
  callCounter,
  clearField,
  clickUpToken,
  createTask,
  getList,
  getListFields,
  getMembers,
  parseListId,
  setField,
  updateTask,
  type CuMember,
  type CuStatus,
  type CuTaskBody,
} from '../lib/clickupApi.js';
import {
  fits,
  isBlank,
  bareName,
  findOption,
  matchName,
  personKey,
  sig,
  toCuDate,
  toCuFieldValue,
  toCuPriority,
  toCuStatus,
  userIds,
  WRITABLE_CU_TYPES,
} from '../lib/clickupValues.js';
import { logAdminEvent } from './adminAudit.js';
import { integrationOn } from './integrations.js';
import { allowFor, requirePerm, type PermissionBearer } from './permissions.js';
import { listCustomFields } from './woFields.js';

// ── Configuration ────────────────────────────────────────────────────────────

interface ConfigRow {
  list_id: string | null;
  list_name: string | null;
  list_url: string | null;
  cu_fields: ClickUpFieldDef[];
  cu_statuses: CuStatus[];
  cu_members: CuMember[];
  fetched_at: Date | string | null;
  sync_from: Date | string | null;
  cursor_log_id: string | number;
  last_run_at: Date | string | null;
  last_run_note: string | null;
}

async function getConfig(): Promise<ConfigRow> {
  const r = await query<ConfigRow>(`SELECT * FROM clickup_config WHERE id = 1`);
  const row = r.rows[0];
  if (!row) throw new ApiError('CONFLICT', 'ClickUp is not set up on this database (migration 0078)');
  return row;
}

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

/** The switch, read from the table. Not integrationOn(): its cache answers
    "on" until its first refresh, and ClickUp ships OFF — a cold instance must
    not push in that window. No row = off here, for the same reason. */
async function switchedOn(): Promise<boolean> {
  try {
    const r = await query<{ enabled: boolean }>(`SELECT enabled FROM integration_setting WHERE key = 'clickup'`);
    return r.rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

/** Token on the server and a List chosen: the runner has somewhere to write. */
export async function clickUpReady(): Promise<boolean> {
  if (!clickUpToken()) return false;
  try {
    return Boolean((await getConfig()).list_id);
  } catch {
    return false;
  }
}

// ── What can be sent: our side ───────────────────────────────────────────────

export interface Source {
  source: string;
  label: string;
  /** text | number | money | date | datetime | select | boolean | users */
  type: string;
  /** For select fields with a declared vocabulary. */
  options?: string[];
}

const CORE_SOURCES: Source[] = [
  { source: 'title', label: 'Title', type: 'text' },
  { source: 'wo_number', label: 'WO #', type: 'text' },
  { source: 'ext_name', label: 'Client WO #', type: 'text' },
  { source: 'description', label: 'Description', type: 'text' },
  { source: 'status', label: 'Status', type: 'select' },
  { source: 'priority', label: 'Priority', type: 'select' },
];

async function listSources(): Promise<Source[]> {
  const custom = await listCustomFields();
  return [
    ...CORE_SOURCES,
    ...custom
      .filter((f) => !f.computed && f.subtype !== 'attachment' && f.subtype !== 'formula')
      .map((f) => ({
        source: f.key,
        label: f.label,
        type: f.subtype === 'users' ? 'users' : f.type,
        options: f.options?.map((o) => o.label || o.value),
      })),
  ];
}

// ── The map ──────────────────────────────────────────────────────────────────

interface Mapping {
  target: ClickUpTarget;
  cu_field_id: string | null;
}

// In the team's ClickUp the task NAME is the client's WO number
// ("1084067-00000011"); "WO-41017" there is ClickUp's own custom task id,
// which only ClickUp can assign. So Client WO # names the task (the title,
// then our WO #, when it is blank) and the title is not sent by default.
const NATIVE_AUTO: Record<string, ClickUpTarget> = {
  ext_name: 'name',
  title: 'none',
  description: 'description',
  status: 'status',
  priority: 'priority',
  'fields.Assignee': 'assignees',
};

/** The match by name for a source nobody has chosen for. */
export function autoMapping(s: Source, cuFields: ClickUpFieldDef[], taken: Set<string>): Mapping {
  const native = NATIVE_AUTO[s.source];
  if (native) return { target: native, cu_field_id: null };
  // In order of trust: our key (the old ClickUp name, verbatim), our label,
  // then the aliases; each exactly first, then without ClickUp's "32." prefix.
  const names = [matchName(s.source.replace(/^fields\./, '')), matchName(s.label)];
  if (s.source === 'wo_number') names.push('wo', 'wo number', 'work order number', 'wo no');
  const free = cuFields.filter((f) => !taken.has(f.id) && fits(s.type, f.type));
  const hit =
    names.map((n) => free.find((f) => matchName(f.name) === n)).find(Boolean) ??
    names.map((n) => free.find((f) => bareName(f.name) === n.replace(/^\d+ /, ''))).find(Boolean);
  if (hit) return { target: 'custom', cu_field_id: hit.id };
  // Our due date with no custom field of that name: ClickUp's own due date.
  if (names.includes('due date') && (s.type === 'date' || s.type === 'datetime')) return { target: 'due_date', cu_field_id: null };
  return { target: 'none', cu_field_id: null };
}

async function savedMap(): Promise<Map<string, Mapping>> {
  const r = await query<{ source: string; target: ClickUpTarget; cu_field_id: string | null }>(
    `SELECT source, target, cu_field_id FROM clickup_field_map`,
  );
  return new Map(r.rows.map((x) => [x.source, { target: x.target, cu_field_id: x.cu_field_id }]));
}

interface Resolved extends Source, Mapping {
  automatic: boolean;
}

async function resolveMap(cfg: ConfigRow): Promise<Resolved[]> {
  const [sources, saved] = await Promise.all([listSources(), savedMap()]);
  // Chosen custom fields are not offered to the automatic match again.
  const taken = new Set([...saved.values()].map((m) => m.cu_field_id).filter((x): x is string => Boolean(x)));
  const fieldIds = new Set(cfg.cu_fields.map((f) => f.id));
  return sources.map((s) => {
    const chosen = saved.get(s.source);
    if (chosen && (chosen.target !== 'custom' || (chosen.cu_field_id && fieldIds.has(chosen.cu_field_id)))) {
      return { ...s, ...chosen, automatic: false };
    }
    const auto = autoMapping(s, cfg.cu_fields, taken);
    if (auto.cu_field_id) taken.add(auto.cu_field_id);
    return { ...s, ...auto, automatic: true };
  });
}

// ── People ───────────────────────────────────────────────────────────────────

/** Our display name (lower-case) → ClickUp user id, matched by email. */
/** Our display name (lower-case) → ClickUp user id. By email first; then by
    full name, because the team's ClickUp emails are often the short form
    (matt@ where we hold matt.hammond@). A name two members share is not used. */
async function peopleMap(members: CuMember[]): Promise<{ idByName: Map<string, number>; unmatched: string[] }> {
  const byEmail = new Map(members.filter((m) => m.email).map((m) => [m.email!.toLowerCase(), m.id]));
  const byPerson = new Map<string, number | null>();
  for (const m of members) {
    const k = personKey(m.username);
    if (k) byPerson.set(k, byPerson.has(k) ? null : m.id);
  }
  const r = await query<{ display_name: string; email: string | null }>(
    // Invited people count: most are assigned work before they first sign in.
    `SELECT display_name, email FROM principal WHERE kind = 'human' AND status <> 'disabled' ORDER BY display_name`,
  );
  const idByName = new Map<string, number>();
  const unmatched: string[] = [];
  for (const p of r.rows) {
    const id = (p.email ? byEmail.get(p.email.toLowerCase()) : undefined) ?? byPerson.get(personKey(p.display_name)) ?? undefined;
    if (id === undefined) unmatched.push(p.display_name);
    else idByName.set(p.display_name.toLowerCase(), id);
  }
  return { idByName, unmatched };
}

// ── Admin › Integrations: the panel ──────────────────────────────────────────

type Admin = PermissionBearer & { id: string };

function missingStatuses(cfg: ConfigRow, ours: string[]): string[] {
  const cu = cfg.cu_statuses.map((s) => s.status);
  return cu.length ? ours.filter((s) => toCuStatus(s, cu) === null) : [];
}

function warningFor(m: Resolved, cfg: ConfigRow, ourStatuses: string[]): string | null {
  if (m.target === 'status') {
    const missing = missingStatuses(cfg, ourStatuses);
    return missing.length ? `${missing.length} of our statuses are not in the ClickUp List` : null;
  }
  if (m.target === 'custom' && m.cu_field_id) {
    const f = cfg.cu_fields.find((x) => x.id === m.cu_field_id);
    if (f && (f.type === 'drop_down' || f.type === 'labels') && m.options?.length) {
      const missing = m.options.filter((o) => !findOption(f.options ?? [], o));
      if (missing.length) return `Not options in ClickUp: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ` +${missing.length - 4}` : ''}`;
    }
  }
  return null;
}

export async function clickUpOverview(user: Admin): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'view', 'Admin › Integrations is not available to you');
  const cfg = await getConfig();
  const [map, counts, problems, statuses, people] = await Promise.all([
    resolveMap(cfg),
    query<{ linked: string; waiting: string; failing: string }>(
      `SELECT count(*) FILTER (WHERE clickup_task_id IS NOT NULL) AS linked,
              count(*) FILTER (WHERE dirty) AS waiting,
              count(*) FILTER (WHERE last_error IS NOT NULL) AS failing
         FROM clickup_link`,
    ),
    query<{ task_id: string; wo_number: string; last_error: string; last_error_at: Date | null; attempts: number }>(
      `SELECT l.task_id, t.wo_number, l.last_error, l.last_error_at, l.attempts
         FROM clickup_link l JOIN task t ON t.id = l.task_id
        WHERE l.last_error IS NOT NULL
        ORDER BY l.last_error_at DESC NULLS LAST LIMIT 25`,
    ),
    query<{ name: string }>(`SELECT DISTINCT name FROM status ORDER BY name`),
    peopleMap(cfg.cu_members),
  ]);
  const ourStatuses = statuses.rows.map((s) => s.name);
  const c = counts.rows[0];
  const rows: ClickUpMapRow[] = map.map((m) => ({
    source: m.source,
    label: m.label,
    type: m.type,
    target: m.target,
    cu_field_id: m.cu_field_id,
    automatic: m.automatic,
    warning: warningFor(m, cfg, ourStatuses),
  }));
  return {
    enabled: await switchedOn(),
    token_set: Boolean(clickUpToken()),
    list: cfg.list_id ? { id: cfg.list_id, name: cfg.list_name, url: cfg.list_url } : null,
    fetched_at: iso(cfg.fetched_at),
    sync_from: iso(cfg.sync_from),
    last_run_at: iso(cfg.last_run_at),
    last_run_note: cfg.last_run_note,
    counts: { linked: Number(c?.linked ?? 0), waiting: Number(c?.waiting ?? 0), failing: Number(c?.failing ?? 0) },
    problems: problems.rows.map((p) => ({
      task_id: p.task_id,
      wo_number: p.wo_number,
      error: p.last_error,
      at: iso(p.last_error_at),
      attempts: p.attempts,
    })),
    cu_fields: cfg.cu_fields.filter((f) => WRITABLE_CU_TYPES.has(f.type)),
    missing_statuses: missingStatuses(cfg, ourStatuses),
    unmatched_people: cfg.cu_members.length ? people.unmatched : [],
    map: rows,
    can: { edit: allowFor(user)(INTEGRATIONS_PERM_KEY, 'edit') },
  };
}

function needToken(): void {
  if (!clickUpToken()) {
    throw new ApiError('CONFLICT', 'CLICKUP_API_TOKEN is not set on the server yet', { code: 'CLICKUP_NO_TOKEN' });
  }
}

function wrapCu(e: unknown): never {
  if (e instanceof ClickUpError) {
    const msg = e.status === 401 ? 'ClickUp refused the API token' : e.status === 404 ? 'ClickUp has no List with that id (or the token cannot see it)' : e.message;
    throw new ApiError('CONFLICT', msg, { code: 'CLICKUP_ERROR' });
  }
  throw e;
}

/** Read the List's fields, statuses and the workspace members again. */
async function fetchStructure(listId: string): Promise<{ name: string; fields: ClickUpFieldDef[]; statuses: CuStatus[]; members: CuMember[] }> {
  try {
    const [list, raw, members] = await Promise.all([getList(listId), getListFields(listId), getMembers()]);
    const fields: ClickUpFieldDef[] = raw.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      options: f.type_config?.options?.map((o) => ({ id: String(o.id), name: (o.name ?? o.label ?? '').trim() })),
    }));
    return { name: list.name, fields, statuses: list.statuses ?? [], members };
  } catch (e) {
    wrapCu(e);
  }
}

export async function setClickUpList(user: Admin, raw: string): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  needToken();
  const listId = parseListId(raw);
  if (!listId) throw badRequest('Paste the List link from ClickUp (or its number)');
  const before = await getConfig();
  const s = await fetchStructure(listId);
  const url = /^https?:\/\//.test(raw.trim()) ? raw.trim() : null;
  await query(
    `UPDATE clickup_config
        SET list_id = $1, list_name = $2, list_url = $3, cu_fields = $4::jsonb, cu_statuses = $5::jsonb,
            cu_members = $6::jsonb, fetched_at = now(), updated_by = $7, updated_at = now()
      WHERE id = 1`,
    [listId, s.name, url, JSON.stringify(s.fields), JSON.stringify(s.statuses), JSON.stringify(s.members), user.id],
  );
  if (before.list_id !== listId) {
    await logAdminEvent({
      actorId: user.id,
      entity: 'integration',
      entityId: 'clickup',
      action: 'clickup_list_set',
      before: { name: 'ClickUp', list_id: before.list_id, list_name: before.list_name },
      after: { name: 'ClickUp', list_id: listId, list_name: s.name },
    });
  }
  return clickUpOverview(user);
}

export async function refreshClickUp(user: Admin): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  needToken();
  const cfg = await getConfig();
  if (!cfg.list_id) throw badRequest('Choose the ClickUp List first');
  const s = await fetchStructure(cfg.list_id);
  await query(
    `UPDATE clickup_config SET list_name = $1, cu_fields = $2::jsonb, cu_statuses = $3::jsonb, cu_members = $4::jsonb, fetched_at = now() WHERE id = 1`,
    [s.name, JSON.stringify(s.fields), JSON.stringify(s.statuses), JSON.stringify(s.members)],
  );
  return clickUpOverview(user);
}

const TARGETS = new Set<string>(['none', 'custom', ...CLICKUP_NATIVE_TARGETS.map((t) => t.value)]);

export async function saveClickUpMap(
  user: Admin,
  rows: { source: string; target: string; cu_field_id: string | null }[],
): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  const cfg = await getConfig();
  const sources = new Set((await listSources()).map((s) => s.source));
  const fieldIds = new Set(cfg.cu_fields.map((f) => f.id));
  const before = await resolveMap(cfg);
  for (const r of rows) {
    if (!sources.has(r.source)) throw badRequest(`Unknown field "${r.source}"`);
    if (!TARGETS.has(r.target)) throw badRequest(`Unknown ClickUp target "${r.target}"`);
    if (r.target === 'custom' && (!r.cu_field_id || !fieldIds.has(r.cu_field_id))) {
      throw badRequest(`Pick a ClickUp field for "${r.source}"`);
    }
  }
  for (const r of rows) {
    await query(
      `INSERT INTO clickup_field_map (source, target, cu_field_id, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (source) DO UPDATE SET target = EXCLUDED.target, cu_field_id = EXCLUDED.cu_field_id,
              updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [r.source, r.target, r.target === 'custom' ? r.cu_field_id : null, user.id],
    );
  }
  const after = await resolveMap(cfg);
  const pick = (m: Resolved[]) => Object.fromEntries(m.filter((x) => x.target !== 'none').map((x) => [x.source, x.cu_field_id ?? x.target]));
  await logAdminEvent({
    actorId: user.id,
    entity: 'integration',
    entityId: 'clickup',
    action: 'clickup_map_updated',
    before: { name: 'ClickUp field map', map: pick(before) },
    after: { name: 'ClickUp field map', map: pick(after) },
  });
  // A newly mapped field is owed on every linked work order.
  await query(`UPDATE clickup_link SET dirty = true, dirty_since = now() WHERE clickup_task_id IS NOT NULL AND NOT dirty`);
  return clickUpOverview(user);
}

export async function retryClickUpTask(user: Admin, taskId: string): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  // Forget the remembered failures so every value is tried again.
  await query(
    `UPDATE clickup_link SET dirty = true, dirty_since = now(), attempts = 0, next_try_at = NULL,
            pushed = pushed - '__errors' WHERE task_id = $1`,
    [taskId],
  );
  await runClickUpSync('retry').catch(() => undefined);
  return clickUpOverview(user);
}

export async function syncClickUpNow(user: Admin): Promise<ClickUpOverview> {
  requirePerm(user, INTEGRATIONS_PERM_KEY, 'edit', 'You cannot change Admin › Integrations');
  needToken();
  if (!(await switchedOn())) throw new ApiError('CONFLICT', 'ClickUp is switched off — turn it on first');
  await runClickUpSync('manual');
  return clickUpOverview(user);
}

// ── The runner ───────────────────────────────────────────────────────────────

const CALL_BUDGET = 80; // of ClickUp's 100 a minute
const TIME_BUDGET_MS = 45_000;
const BACKOFF_MIN = [1, 2, 5, 15, 60];

interface TaskRow {
  id: string;
  wo_number: string;
  ext_name: string | null;
  title: string;
  description: string | null;
  priority: string | null;
  fields: Record<string, unknown>;
  status_name: string;
  deleted_at: Date | null;
}

interface LinkRow {
  task_id: string;
  clickup_task_id: string | null;
  pushed: Record<string, unknown>;
  attempts: number;
}

function rawValue(t: TaskRow, source: string): unknown {
  switch (source) {
    case 'title':
      return t.title;
    case 'wo_number':
      return t.wo_number;
    case 'ext_name':
      return t.ext_name;
    case 'description':
      return t.description;
    case 'status':
      return t.status_name;
    case 'priority':
      return t.priority;
    default:
      return source.startsWith('fields.') ? t.fields?.[source.slice('fields.'.length)] : null;
  }
}

/** One wanted value on the ClickUp task, keyed by where it goes. */
interface Want {
  key: string; // 'name' | 'status' | … | 'cf:<id>'
  target: ClickUpTarget;
  field?: ClickUpFieldDef;
  value: unknown; // what ClickUp is sent (null = clear)
  time?: boolean;
  error?: string;
}

function wants(t: TaskRow, map: Resolved[], cfg: ConfigRow, idByName: Map<string, number>): Want[] {
  const out = new Map<string, Want>();
  for (const m of map) {
    if (m.target === 'none') continue;
    const raw = rawValue(t, m.source);
    switch (m.target) {
      case 'name':
        out.set('name', { key: 'name', target: 'name', value: String(!isBlank(raw) ? raw : !isBlank(t.title) ? t.title : t.wo_number).slice(0, 1000) });
        break;
      case 'description':
        out.set('description', { key: 'description', target: 'description', value: isBlank(raw) ? '' : String(raw) });
        break;
      case 'status': {
        if (isBlank(raw)) break;
        const cu = toCuStatus(String(raw), cfg.cu_statuses.map((s) => s.status));
        out.set(
          'status',
          cu === null
            ? { key: 'status', target: 'status', value: undefined, error: `Status "${String(raw)}" has no match in the ClickUp List` }
            : { key: 'status', target: 'status', value: cu },
        );
        break;
      }
      case 'priority':
        out.set('priority', { key: 'priority', target: 'priority', value: toCuPriority(raw) });
        break;
      case 'assignees': {
        const { ids, missing } = userIds(raw, idByName);
        out.set('assignees', {
          key: 'assignees',
          target: 'assignees',
          value: ids.sort((a, b) => a - b),
          error: missing.length ? `No ClickUp member for ${missing.join(', ')} (matched by email or name)` : undefined,
        });
        break;
      }
      case 'due_date':
      case 'start_date': {
        const d = toCuDate(raw);
        out.set(m.target, { key: m.target, target: m.target, value: d?.ms ?? null, time: d?.time ?? false });
        break;
      }
      case 'custom': {
        const field = cfg.cu_fields.find((f) => f.id === m.cu_field_id);
        if (!field) break;
        const v = toCuFieldValue(field, raw, idByName);
        const key = `cf:${field.id}`;
        if (v.kind === 'error') out.set(key, { key, target: 'custom', field, value: undefined, error: `${m.label}: ${v.message}` });
        else if (v.kind === 'clear') out.set(key, { key, target: 'custom', field, value: null });
        else {
          const value = field.type === 'users' && Array.isArray(v.value) ? [...(v.value as number[])].sort((a, b) => a - b) : v.value;
          out.set(key, { key, target: 'custom', field, value, time: v.options?.time });
        }
        break;
      }
    }
  }
  return [...out.values()];
}

const wantSig = (w: Want) => sig(w.time === undefined ? w.value : [w.value, w.time]);

class TaskGone extends Error {}

/** ClickUp's reply to a value it would not take is final until the value
    changes; anything else (network, 5xx, rate limit, auth) is the run's
    problem, not the value's. */
const valueRefused = (e: unknown): e is ClickUpError =>
  e instanceof ClickUpError && e.status >= 400 && e.status < 500 && ![401, 403, 404, 429].includes(e.status);

async function pushOne(link: LinkRow, t: TaskRow, map: Resolved[], cfg: ConfigRow, idByName: Map<string, number>): Promise<{ errors: string[]; pushed: Record<string, unknown>; id: string; url: string | null }> {
  const all = wants(t, map, cfg, idByName);
  const pushed: Record<string, unknown> = { ...link.pushed };
  const remembered = (pushed.__errors ?? {}) as Record<string, { sig: string; msg: string }>;
  const errors: Record<string, { sig: string; msg: string }> = {};
  const fail = (w: Want, msg: string) => (errors[w.key] = { sig: wantSig(w), msg });

  // Assignees with someone unmatched: push the matched ones, still say who.
  const warnings: string[] = [];
  // Values we already know ClickUp will not take — skip until they change.
  const live = all.filter((w) => {
    if (w.value === undefined) {
      fail(w, w.error ?? `${w.key}: cannot be sent`);
      return false;
    }
    const r = remembered[w.key];
    if (r && r.sig === wantSig(w)) {
      errors[w.key] = r;
      return false;
    }
    if (w.error) warnings.push(w.error);
    return true;
  });

  let id = link.clickup_task_id;
  let url: string | null = null;

  if (!id) {
    const body: CuTaskBody = { name: String(live.find((w) => w.key === 'name')?.value ?? t.wo_number) };
    const statusOk = new Set(cfg.cu_statuses.map((s) => s.status.toLowerCase()));
    const custom: NonNullable<CuTaskBody['custom_fields']> = [];
    for (const w of live) {
      if (w.value === null || w.value === undefined) continue;
      if (w.target === 'description') body.description = String(w.value);
      else if (w.target === 'status') {
        // An unknown status would refuse the whole create: leave the List's
        // default and say so.
        if (statusOk.size === 0 || statusOk.has(String(w.value).toLowerCase())) body.status = String(w.value);
        else fail(w, `Status "${String(w.value)}" is not in the ClickUp List`);
      } else if (w.target === 'priority') body.priority = w.value as number;
      else if (w.target === 'assignees') body.assignees = w.value as number[];
      else if (w.target === 'due_date') Object.assign(body, { due_date: w.value as number, due_date_time: Boolean(w.time) });
      else if (w.target === 'start_date') Object.assign(body, { start_date: w.value as number, start_date_time: Boolean(w.time) });
      else if (w.target === 'custom' && w.field && w.field.type !== 'users') {
        custom.push({ id: w.field.id, value: w.value, ...(w.time !== undefined ? { value_options: { time: w.time } } : {}) });
      }
    }
    let created: { id: string; url?: string };
    let withCustom = true;
    try {
      created = await createTask(cfg.list_id!, { ...body, custom_fields: custom });
    } catch (e) {
      if (!valueRefused(e) || custom.length === 0) throw e;
      // One bad custom value refuses the whole create: make the task bare and
      // let the field-by-field pass below find the culprit.
      created = await createTask(cfg.list_id!, body);
      withCustom = false;
    }
    id = created.id;
    url = created.url ?? `https://app.clickup.com/t/${created.id}`;
    // Record what went in with the create; the rest falls to the update pass.
    for (const w of live) {
      if (errors[w.key]) continue;
      const sent =
        w.value === null ||
        w.target === 'name' ||
        (w.target === 'custom' ? withCustom && w.field?.type !== 'users' : true);
      if (sent) pushed[w.key] = wantSig(w);
    }
    // Persist the id before anything else can fail.
    await query(`UPDATE clickup_link SET clickup_task_id = $2, clickup_url = $3, pushed = $4::jsonb WHERE task_id = $1`, [
      t.id,
      id,
      url,
      JSON.stringify({ ...pushed, __errors: errors }),
    ]);
  }

  // ── Update: only what differs from the last push ──
  const due = live.filter((w) => !errors[w.key] && pushed[w.key] !== wantSig(w));
  const native = due.filter((w) => w.target !== 'custom');
  if (native.length) {
    const body: CuTaskBody = {};
    for (const w of native) {
      if (w.target === 'name') body.name = String(w.value);
      else if (w.target === 'description') body.description = String(w.value ?? '');
      else if (w.target === 'status' && w.value) body.status = String(w.value);
      else if (w.target === 'priority') body.priority = w.value as number | null;
      else if (w.target === 'due_date') Object.assign(body, { due_date: w.value, due_date_time: Boolean(w.time) });
      else if (w.target === 'start_date') Object.assign(body, { start_date: w.value, start_date_time: Boolean(w.time) });
      else if (w.target === 'assignees') {
        const before = (() => {
          try {
            return JSON.parse(String(pushed.assignees ?? '[]')) as number[];
          } catch {
            return [];
          }
        })();
        const now = w.value as number[];
        body.assignees = { add: now.filter((x) => !before.includes(x)), rem: before.filter((x) => !now.includes(x)) };
      }
    }
    try {
      await updateTask(id, body);
      for (const w of native) pushed[w.key] = wantSig(w);
    } catch (e) {
      if (e instanceof ClickUpError && e.status === 404) throw new TaskGone();
      if (!valueRefused(e)) throw e;
      // Tell the bad one apart: send each on its own.
      for (const w of native) {
        const single: CuTaskBody = {};
        for (const k of Object.keys(body) as (keyof CuTaskBody)[]) {
          if (k === w.target || (w.target === 'due_date' && k === 'due_date_time') || (w.target === 'start_date' && k === 'start_date_time')) {
            (single as Record<string, unknown>)[k] = body[k];
          }
        }
        try {
          await updateTask(id, single);
          pushed[w.key] = wantSig(w);
        } catch (e2) {
          if (!valueRefused(e2)) throw e2;
          fail(w, `${w.target}: ${e2.message}`);
        }
      }
    }
  }
  for (const w of due.filter((x) => x.target === 'custom' && x.field)) {
    try {
      if (w.value === null) await clearField(id, w.field!.id);
      else if (w.field!.type === 'users') {
        let before: number[] = [];
        try {
          before = JSON.parse(String(pushed[w.key] ?? '[]')) as number[];
        } catch {
          /* first push */
        }
        const now = w.value as number[];
        await setField(id, w.field!.id, { add: now.filter((x) => !before.includes(x)), rem: before.filter((x) => !now.includes(x)) });
      } else await setField(id, w.field!.id, w.value, w.time !== undefined ? { time: w.time } : undefined);
      pushed[w.key] = wantSig(w);
    } catch (e) {
      // A 404 here is the FIELD missing from the List the task now sits in
      // (moved by a ClickUp automation), not the task: remembered like a
      // refused value.
      if (!valueRefused(e) && !(e instanceof ClickUpError && e.status === 404)) throw e;
      fail(w, `${w.field!.name}: ${(e as Error).message}`);
    }
  }
  pushed.__errors = errors;
  return { errors: [...Object.values(errors).map((x) => x.msg), ...warnings], pushed, id, url };
}

/** Phase 1: link new work orders, mark changed ones. */
async function markDirty(cfg: ConfigRow): Promise<void> {
  if (!cfg.sync_from) {
    // First run with the switch on: from now on, and nothing before.
    await query(
      `UPDATE clickup_config SET sync_from = now(), cursor_log_id = COALESCE((SELECT max(id) FROM activity_log), 0) WHERE id = 1`,
    );
    return;
  }
  const max = Number((await query<{ m: string | null }>(`SELECT max(id)::text AS m FROM activity_log`)).rows[0]?.m ?? 0);
  // A re-seed restarts the ids under the cursor.
  const cursor = max < Number(cfg.cursor_log_id) ? 0 : Number(cfg.cursor_log_id);
  await query(
    `INSERT INTO clickup_link (task_id)
     SELECT t.id FROM task t
      WHERE t.created_at >= $1 AND t.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM clickup_link l WHERE l.task_id = t.id)
     ON CONFLICT (task_id) DO NOTHING`,
    [cfg.sync_from],
  );
  await query(
    `UPDATE clickup_link l
        SET dirty = true,
            dirty_since = CASE WHEN l.dirty THEN l.dirty_since ELSE now() END
      WHERE l.task_id::text IN (
              SELECT a.entity_id FROM activity_log a
               WHERE a.entity_type = 'task'
                 AND (a.id > $1 OR a.created_at > now() - interval '10 minutes'))
        AND NOT l.dirty`,
    [cursor],
  );
  await query(`UPDATE clickup_config SET cursor_log_id = $1 WHERE id = 1`, [max]);
}

let running: Promise<{ pushed: number; note: string }> | null = null;

/** One run: mark, then push until the queue is empty or the budget is spent. */
export function runClickUpSync(reason: string): Promise<{ pushed: number; note: string }> {
  running ??= runOnce(reason).finally(() => {
    running = null;
  });
  return running;
}

async function runOnce(reason: string): Promise<{ pushed: number; note: string }> {
  if (!clickUpToken() || !(await switchedOn())) return { pushed: 0, note: 'off or no token' };
  const lease = await query(
    `UPDATE clickup_config SET lease_until = now() + interval '2 minutes'
      WHERE id = 1 AND list_id IS NOT NULL AND (lease_until IS NULL OR lease_until < now())
      RETURNING id`,
  );
  if (lease.rows.length === 0) return { pushed: 0, note: 'busy or no List' };
  const started = Date.now();
  callCounter.n = 0;
  let done = 0;
  let failed = 0;
  let note = '';
  try {
    for (let pass = 0; pass < 3; pass++) {
      const cfg = await getConfig();
      await markDirty(cfg);
      const fresh = await getConfig();
      if (!fresh.sync_from) break;
      const [map, people] = await Promise.all([resolveMap(fresh), peopleMap(fresh.cu_members)]);
      const links = await query<LinkRow>(
        `SELECT task_id, clickup_task_id, pushed, attempts FROM clickup_link
          WHERE dirty AND (next_try_at IS NULL OR next_try_at <= now())
          ORDER BY dirty_since LIMIT 60`,
      );
      if (links.rows.length === 0) break;
      for (const link of links.rows) {
        if (callCounter.n >= CALL_BUDGET || Date.now() - started > TIME_BUDGET_MS) {
          note = 'budget spent; the rest goes on the next run';
          break;
        }
        const tr = await query<TaskRow>(
          `SELECT t.id, t.wo_number, t.ext_name, t.title, t.description, t.priority, t.fields, s.name AS status_name, t.deleted_at
             FROM task t JOIN status s ON s.id = t.status_id WHERE t.id = $1`,
          [link.task_id],
        );
        const t = tr.rows[0];
        if (!t || t.deleted_at) {
          // In the Trash: leave the ClickUp task alone; a restore marks it again.
          await query(`UPDATE clickup_link SET dirty = false WHERE task_id = $1`, [link.task_id]);
          continue;
        }
        try {
          const r = await pushOne(link, t, map, fresh, people.idByName);
          await query(
            `UPDATE clickup_link
                SET clickup_task_id = $2, clickup_url = COALESCE($3, clickup_url), pushed = $4::jsonb,
                    dirty = false, attempts = 0, next_try_at = NULL, synced_at = now(),
                    last_error = $5, last_error_at = CASE WHEN $5::text IS NULL THEN NULL ELSE now() END
              WHERE task_id = $1`,
            [t.id, r.id, r.url, JSON.stringify(r.pushed), r.errors.length ? r.errors.join(' · ') : null],
          );
          done++;
        } catch (e) {
          if (e instanceof TaskGone) {
            // Deleted on the ClickUp side: The One is the source of truth, so
            // the next run creates it again.
            await query(
              `UPDATE clickup_link SET clickup_task_id = NULL, clickup_url = NULL, pushed = '{}'::jsonb,
                      last_error = 'The ClickUp task was deleted; it will be created again', last_error_at = now()
                WHERE task_id = $1`,
              [t.id],
            );
            continue;
          }
          if (e instanceof ClickUpRateLimited) {
            note = e.message;
            break;
          }
          failed++;
          const attempts = link.attempts + 1;
          const wait = BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)];
          await query(
            `UPDATE clickup_link SET attempts = $2, next_try_at = now() + ($3 || ' minutes')::interval,
                    last_error = $4, last_error_at = now() WHERE task_id = $1`,
            [t.id, attempts, String(wait), (e as Error).message.slice(0, 500)],
          );
          if (e instanceof ClickUpError && (e.status === 401 || e.status === 403)) {
            // 403: a view-only token reads the List but may not write tasks.
            note = e.status === 401 ? 'ClickUp refused the API token' : 'The API token can read ClickUp but not write to it';
            break;
          }
        }
      }
      if (note) break;
    }
  } finally {
    const summary = [`${done} pushed`, failed ? `${failed} failed` : '', note, `(${reason})`].filter(Boolean).join(' · ');
    await query(`UPDATE clickup_config SET lease_until = NULL, last_run_at = now(), last_run_note = $1 WHERE id = 1`, [summary]).catch(() => undefined);
    note = summary;
  }
  return { pushed: done, note };
}

/** After a write request: push now, kept alive past the response on Vercel.
    The cached switch is only a cheap filter; runOnce reads the table. */
export function kickClickUp(): void {
  if (!clickUpToken() || !integrationOn('clickup')) return;
  const p = runClickUpSync('after write').catch((e: unknown) => {
    console.warn('[clickup] run failed:', e instanceof Error ? e.message : e);
  });
  const ctx = (globalThis as Record<symbol, { get?: () => { waitUntil?: (p: Promise<unknown>) => void } | undefined } | undefined>)[
    Symbol.for('@vercel/request-context')
  ]?.get?.();
  ctx?.waitUntil?.(p);
}

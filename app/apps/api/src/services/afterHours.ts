// On call and After hours (Elise, 2026-11-16; in the header since 2026-11-17).
//
// Notifications and approvals about a work order show only to the people
// assigned to it, and a person on "Only theirs" sees only their own work
// orders. The AM / TL / ATL / OP Admin ON CALL sees everything they may open:
//
//   · Who is on call is a Google Sheet (Admin › Settings › On call), read into
//     `on_call_shift` (0155) every ON_CALL_SYNC_MINUTES when somebody asks,
//     hourly by the client-updates cron, and on Sync now.
//   · A shift on day D runs start_hour → end_hour Chicago (12 AM → 3 PM by
//     default, `onCallShiftNow` in shared). While it runs the header shows the
//     After hours button and the wide view is ON by default.
//   · A press switches between the wide view and their own jobs. Each press is
//     an audit row (`after_hours_opened` / `after_hours_closed`, entity
//     'after_hours', entity_id = the person, after = {name, page: 'all',
//     shift}); only presses made during the running shift count, so every
//     shift starts wide again.
//
// The wide view is decided HERE, on the server, for every request: the session
// loader stamps `afterHoursWide` on the acting principal (`afterHoursWideFor`,
// memoised for a few seconds), and `woScopeSql`, the approvals inbox and the
// notifications inbox read it. So the work-order lists, the approval queues,
// the counts and the per-work-order routes all widen together, and nothing a
// browser sends can widen them. What a person may DO is still their role's:
// the wide view opens rows, never grants.

import {
  AFTER_HOURS_OFF,
  ON_CALL_DEFAULT_SETTINGS,
  ON_CALL_ROLE_CODES,
  ON_CALL_SYNC_MINUTES,
  afterHoursWide,
  chicagoWall,
  isOnCallRole,
  onCallShiftNow,
  parseOnCallSheet,
  parseSheetRef,
  type AfterHoursState,
  type OnCallSettings,
} from '@theone/shared';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict } from '../errors.js';
import { readSheetRows } from '../lib/googleSheets.js';
import { logAdminEvent } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';

const ENTITY = 'after_hours';

// ── Settings ────────────────────────────────────────────────────────────────

export async function getOnCallSettings(): Promise<OnCallSettings> {
  try {
    const res = await query<{ value: Partial<OnCallSettings> }>(`SELECT value FROM on_call_setting WHERE key = 'config'`);
    return { ...ON_CALL_DEFAULT_SETTINGS, ...(res.rows[0]?.value ?? {}) };
  } catch {
    return { ...ON_CALL_DEFAULT_SETTINGS };
  }
}

export interface OnCallSettingsInput {
  sheet: string | null;
  tab: string | null;
  start_hour: number;
  end_hour: number;
}

export async function saveOnCallSettings(actor: ActingPrincipal, input: OnCallSettingsInput): Promise<OnCallSettings> {
  const before = await getOnCallSettings();
  const ref = input.sheet?.trim() ? parseSheetRef(input.sheet) : { sheet_id: null, gid: null };
  if (input.sheet?.trim() && !ref.sheet_id) throw badRequest('Paste the Google Sheet’s link (or its id).', { field: 'sheet' });
  const start = Math.trunc(input.start_hour);
  const end = Math.trunc(input.end_hour);
  if (!(start >= 0 && start <= 23) || !(end >= 1 && end <= 24) || start === end) {
    throw badRequest('The shift needs a start hour (0–23) and a different end hour (1–24).', { field: 'end_hour' });
  }
  const next: OnCallSettings = {
    sheet_id: ref.sheet_id,
    // A pasted link names its tab by gid; keep the old gid when the same sheet
    // is saved again from its bare id.
    gid: ref.gid ?? (ref.sheet_id === before.sheet_id ? before.gid : null),
    tab: input.tab?.trim() || null,
    start_hour: start,
    end_hour: end,
  };
  await query(
    `INSERT INTO on_call_setting (key, value, updated_by, updated_at) VALUES ('config', $1::jsonb, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), actor.id],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'on_call',
    entityId: 'config',
    action: 'on_call_settings_updated',
    before: { name: 'On call', ...before },
    after: { name: 'On call', ...next },
  });
  forgetWide();
  return next;
}

// ── Reading the sheet ───────────────────────────────────────────────────────

export interface OnCallSyncResult {
  ok: boolean;
  at: string;
  error: string | null;
  shifts: number;
  unmatched: { row: number; text: string }[];
}

let running: Promise<OnCallSyncResult> | null = null;

async function lastSync(): Promise<OnCallSyncResult | null> {
  try {
    const res = await query<{ value: OnCallSyncResult }>(`SELECT value FROM on_call_setting WHERE key = 'last_sync'`);
    return res.rows[0]?.value ?? null;
  } catch {
    return null;
  }
}

async function storeSync(r: OnCallSyncResult): Promise<void> {
  await query(
    `INSERT INTO on_call_setting (key, value, updated_at) VALUES ('last_sync', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(r)],
  );
}

/**
 * Reads the sheet and replaces the roster from yesterday on (older days are
 * kept as the record of who covered). Never throws: a failure is stored as the
 * last sync's error and the roster on file stays as it was. `actor` = a
 * person's Sync now (logged); null = the cron or a lazy re-read.
 */
export function syncOnCall(actor: ActingPrincipal | null): Promise<OnCallSyncResult> {
  if (running) return running;
  running = doSync(actor).finally(() => {
    running = null;
  });
  return running;
}

async function doSync(actor: ActingPrincipal | null): Promise<OnCallSyncResult> {
  const at = new Date().toISOString();
  const settings = await getOnCallSettings();
  let result: OnCallSyncResult;
  try {
    if (!settings.sheet_id) throw new Error('No on-call sheet is set yet.');
    const creds = config.mail.gmail;
    if (!creds) throw new Error('The Google service account is not set up on the server (GMAIL_SERVICE_ACCOUNT_JSON).');
    const rows = await readSheetRows(creds, settings.sheet_id, { tab: settings.tab, gid: settings.gid });
    const people = await query<{ id: string; name: string; email: string | null; role: string | null }>(
      `SELECT id::text AS id, display_name AS name, email, role FROM principal
        WHERE kind = 'human' AND status <> 'disabled' AND role = ANY($1::text[])`,
      [[...ON_CALL_ROLE_CODES]],
    );
    const today = chicagoWall(new Date()).day;
    const parsed = parseOnCallSheet(rows, people.rows, Number(today.slice(0, 4)));
    const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const keep = parsed.shifts.filter((s) => s.day >= yesterday);
    await withTransaction(async (tx) => {
      await tx.query(`DELETE FROM on_call_shift WHERE day >= $1::date`, [yesterday]);
      for (const s of keep) {
        await tx.query(
          `INSERT INTO on_call_shift (day, principal_id, name, sheet_row, synced_at) VALUES ($1::date, $2, $3, $4, now())
           ON CONFLICT (day, principal_id) DO UPDATE SET name = EXCLUDED.name, sheet_row = EXCLUDED.sheet_row, synced_at = now()`,
          [s.day, s.principal_id, s.name, s.row],
        );
      }
    });
    result = { ok: true, at, error: null, shifts: keep.length, unmatched: parsed.unmatched.slice(0, 50) };
  } catch (err) {
    result = { ok: false, at, error: err instanceof Error ? err.message : String(err), shifts: 0, unmatched: [] };
  }
  try {
    await storeSync(result);
    if (actor) {
      await logAdminEvent({
        actorId: actor.id,
        entity: 'on_call',
        entityId: 'sync',
        action: 'on_call_synced',
        after: { name: 'On call', ok: result.ok, error: result.error, shifts: result.shifts },
      });
    }
  } catch {
    /* the table may not exist before 0155 */
  }
  forgetWide();
  return result;
}

/** Re-read the sheet when the last read is older than ON_CALL_SYNC_MINUTES. */
async function syncIfStale(): Promise<void> {
  const last = await lastSync();
  const age = last ? Date.now() - Date.parse(last.at) : Infinity;
  if (age < ON_CALL_SYNC_MINUTES * 60_000) return;
  const settings = await getOnCallSettings();
  if (!settings.sheet_id) return;
  await syncOnCall(null);
}

export interface OnCallOverview {
  settings: OnCallSettings;
  service_account: string | null;
  last_sync: OnCallSyncResult | null;
  /** Today and the next 13 days, by day. */
  upcoming: { day: string; people: { id: string; name: string; role: string | null }[] }[];
}

export async function onCallOverview(): Promise<OnCallOverview> {
  const today = chicagoWall(new Date()).day;
  const res = await query<{ day: string; id: string; name: string; role: string | null }>(
    `SELECT to_char(s.day, 'YYYY-MM-DD') AS day, s.principal_id::text AS id, COALESCE(p.display_name, s.name) AS name, p.role
       FROM on_call_shift s LEFT JOIN principal p ON p.id = s.principal_id
      WHERE s.day >= $1::date AND s.day < $1::date + 14
      ORDER BY s.day, name`,
    [today],
  );
  const byDay = new Map<string, OnCallOverview['upcoming'][number]['people']>();
  for (const r of res.rows) {
    const list = byDay.get(r.day) ?? [];
    list.push({ id: r.id, name: r.name, role: r.role });
    byDay.set(r.day, list);
  }
  return {
    settings: await getOnCallSettings(),
    service_account: config.mail.gmail?.clientEmail ?? null,
    last_sync: await lastSync(),
    upcoming: [...byDay.entries()].map(([day, people]) => ({ day, people })),
  };
}

// ── The person's state ──────────────────────────────────────────────────────

interface Who {
  id: string;
  role: string | null;
  kind?: string;
}

/** The person's state now: on call, the shift, and whether the view is wide. */
export async function afterHoursState(who: Who, opts: { sync?: boolean } = {}): Promise<AfterHoursState> {
  if (who.kind === 'service' || !isOnCallRole(who.role)) return AFTER_HOURS_OFF;
  try {
    if (opts.sync) await syncIfStale().catch(() => undefined);
    const settings = await getOnCallSettings();
    const today = chicagoWall(new Date()).day;
    const days = await query<{ day: string }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM on_call_shift
        WHERE principal_id = $1 AND day BETWEEN $2::date - 1 AND $2::date`,
      [who.id, today],
    );
    const shift = onCallShiftNow(days.rows.map((r) => r.day), new Date(), settings);
    if (!shift.day) return AFTER_HOURS_OFF;
    const press = await query<{ action: string }>(
      `SELECT action FROM activity_log
        WHERE entity_type = '${ENTITY}' AND entity_id = $1
          AND after ->> 'shift' = $2 AND created_at >= $3::timestamptz
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [who.id, shift.day, shift.starts_at],
    );
    const last = press.rows[0]?.action;
    return {
      on_call: true,
      shift_day: shift.day,
      ends_at: shift.ends_at,
      wide: afterHoursWide(true, last === 'after_hours_closed' ? 'closed' : last === 'after_hours_opened' ? 'opened' : null),
    };
  } catch {
    // Before 0155, or the database hiccuped: the narrow view is the safe one.
    return AFTER_HOURS_OFF;
  }
}

// Every request asks (the session loader); a few seconds' memo keeps that to
// one small read per person per window. A press or a sync forgets it.
const WIDE_TTL_MS = 15_000;
const wideMemo = new Map<string, { at: number; wide: boolean }>();

function forgetWide(id?: string): void {
  if (id) wideMemo.delete(id);
  else wideMemo.clear();
}

/** Is the wide view on for this person right now? (session loader) */
export async function afterHoursWideFor(who: Who): Promise<boolean> {
  if (who.kind === 'service' || !isOnCallRole(who.role)) return false;
  const hit = wideMemo.get(who.id);
  if (hit && Date.now() - hit.at < WIDE_TTL_MS) return hit.wide;
  const wide = (await afterHoursState(who)).wide;
  wideMemo.set(who.id, { at: Date.now(), wide });
  return wide;
}

/** A press of the header button. Only during a shift; 409 otherwise. */
export async function setAfterHours(actor: ActingPrincipal, on: boolean): Promise<AfterHoursState> {
  const now = await afterHoursState(actor);
  if (!now.on_call) {
    throw conflict('After hours is only for the person on call, during their shift.', { code: 'NOT_ON_CALL' });
  }
  if (now.wide !== on) {
    await logAdminEvent({
      actorId: actor.id,
      entity: ENTITY,
      entityId: actor.id,
      action: on ? 'after_hours_opened' : 'after_hours_closed',
      after: { name: actor.name, page: 'all', shift: now.shift_day },
    });
  }
  forgetWide(actor.id);
  return { ...now, wide: on };
}

export interface AfterHoursLogRow {
  at: string;
  action: 'after_hours_opened' | 'after_hours_closed';
  page: string;
  shift: string | null;
  person: { id: string; name: string };
  /** Who actually pressed it when it differs (viewing as). */
  by: { id: string; name: string } | null;
}

/** Everyone's presses, newest first (Admin › Settings › On call). */
export async function afterHoursLog(limit = 200): Promise<AfterHoursLogRow[]> {
  const res = await query<{
    at: Date;
    action: AfterHoursLogRow['action'];
    page: string | null;
    shift: string | null;
    person_id: string;
    person_name: string | null;
    by_id: string | null;
    by_name: string | null;
  }>(
    `SELECT a.created_at AS at, a.action, a.after ->> 'page' AS page, a.after ->> 'shift' AS shift,
            a.entity_id AS person_id, COALESCE(p.display_name, a.after ->> 'name') AS person_name,
            r.id::text AS by_id, r.display_name AS by_name
       FROM activity_log a
       LEFT JOIN principal p ON p.id::text = a.entity_id
       LEFT JOIN principal r ON r.id = a.actor_principal_id
      WHERE a.entity_type = '${ENTITY}'
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    at: r.at.toISOString(),
    action: r.action,
    page: r.page ?? '',
    shift: r.shift,
    person: { id: r.person_id, name: r.person_name ?? 'Unknown' },
    by: r.by_id && r.by_id !== r.person_id ? { id: r.by_id, name: r.by_name ?? 'Unknown' } : null,
  }));
}

/** The Approvals page reads the quotes, payments, purchase and NTE-increase
    queues with `?assigned=1` — the work orders the person is on (an assigned
    seat). The routes copy the actor with `assignedOnly`, which `woScopeSql`
    reads — and ignores while the person's After hours view is wide. */
export function withAssignedOnly(actor: ActingPrincipal, rawQuery: unknown): ActingPrincipal {
  const q = (rawQuery ?? {}) as Record<string, unknown>;
  return q.assigned === '1' ? { ...actor, assignedOnly: true } : actor;
}

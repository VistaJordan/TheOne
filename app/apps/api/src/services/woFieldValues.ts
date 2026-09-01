// Single-work-order field VALUES: the inline editor on the detail page's
// "All fields" tab writes here, and the per-field history panel reads here.
//
// This is deliberately not bulkUpdate() with one id. The bulk path treats every
// value as a string and never returns the row; the inline editor needs typed
// coercion (a checkbox stores a real boolean, a currency a real number), the
// promoted-column mirrors kept in step, and the fresh detail back in one round
// trip. The audit contract is the same one woBulk uses: one activity_log row
// per changed field via logTaskChanges().

import { withTransaction, query } from '../db.js';
import { ApiError } from '../errors.js';
import { resolveField, type ResolvedField } from './woFields.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';
import { dispatchAutomations, type AutoCtx } from './automations.js';
import { applyProfitFormula } from './money.js';
import { getWorkOrderDetail } from './workOrders.js';
import { CREATED_AT_SQL } from './activity.js';
import type { ActivityEntry } from '@theone/shared';

// ── Promoted-column mirrors ──────────────────────────────────────────────────
// The map moved to woMirrors.ts (the automations engine reads it too). The
// activity log records the FIELD change only — the mirror is derived, and two
// rows for one edit would read as two edits.
import { MIRROR_BY_JSON_KEY } from './woMirrors.js';

/** Coerce an inline-editor value to what the bag should hold for this field's
    type. `null` means "clear the key". Throws on a value that would corrupt a
    typed comparison later (letters in a currency, a non-date in a date). */
function coerceValue(f: ResolvedField, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (f.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const s = String(raw).toLowerCase();
      if (['true', 'yes', '1'].includes(s)) return true;
      if (['false', 'no', '0'].includes(s)) return false;
      throw new ApiError('BAD_REQUEST', `"${f.label}" is a checkbox — send true or false`);
    }
    case 'number':
    case 'money': {
      const digits = typeof raw === 'number' ? String(raw) : String(raw).replace(/[^0-9.-]/g, '');
      if (!/^-?\d*\.?\d+$/.test(digits) || !Number.isFinite(Number(digits))) {
        throw new ApiError('BAD_REQUEST', `"${f.label}" needs a number`);
      }
      return Number(digits);
    }
    case 'date': {
      const s = String(raw).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw new ApiError('BAD_REQUEST', `"${f.label}" needs a date (YYYY-MM-DD)`);
      }
      return s;
    }
    case 'datetime': {
      // The editor sends datetime-local's 'YYYY-MM-DDTHH:MM'; a bare date is
      // fine too (an operator may only know the day). Normalized to minutes.
      const s = String(raw).trim().replace(' ', 'T').slice(0, 16);
      if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(s)) {
        throw new ApiError(
          'BAD_REQUEST',
          `"${f.label}" needs a date and time (YYYY-MM-DDTHH:MM)`,
        );
      }
      return s;
    }
    default: {
      const s = String(raw).trim();
      return s === '' ? null : s;
    }
  }
}

/** For the mirror column: the value cast the column expects, from the coerced
    bag value. Bag `null` clears the column too. */
function mirrorValue(cast: 'text' | 'numeric' | 'date', v: unknown): unknown {
  if (v === null) return null;
  if (cast === 'numeric') return typeof v === 'number' ? v : Number(v);
  return String(v);
}

export async function updateWorkOrderFields(
  idOrWo: string,
  values: Record<string, unknown>,
  actorId: string,
  auto?: AutoCtx,
) {
  const entries = Object.entries(values);
  if (entries.length === 0) throw new ApiError('BAD_REQUEST', 'Nothing to change');

  // Resolve every key + value BEFORE the transaction (PGlite is single-connection).
  const patch: { jsonKey: string; value: unknown; resolved: ResolvedField }[] = [];
  for (const [key, raw] of entries) {
    const f = await resolveField(key);
    if (!f.custom) {
      throw new ApiError('BAD_REQUEST', `"${f.label}" is not an editable custom field`);
    }
    const subtype = await subtypeOf(f.key);
    if (subtype === 'formula') {
      throw new ApiError('BAD_REQUEST', `"${f.label}" is computed — it cannot be edited directly`);
    }
    if (subtype === 'attachment') {
      throw new ApiError('BAD_REQUEST', `"${f.label}" holds a file — attachments are not edited here yet`);
    }
    patch.push({ jsonKey: f.jsonKey as string, value: coerceValue(f, raw), resolved: f });
  }

  const row = await query<{ id: string; fields: Record<string, unknown> }>(
    `SELECT t.id, t.fields FROM task t
      WHERE (t.id::text = $1 OR t.wo_number = $1) AND t.deleted_at IS NULL LIMIT 1`,
    [idOrWo],
  );
  if (!row.rows[0]) throw new ApiError('NOT_FOUND', 'Work order not found');
  const task = row.rows[0];

  const log: TaskChange[] = [];
  const merged: Record<string, unknown> = { ...(task.fields ?? {}) };
  const mirrorSets: { column: string; cast: string; value: unknown }[] = [];

  for (const p of patch) {
    const before = task.fields?.[p.jsonKey] ?? null;
    if (!changed(before, p.value)) continue;
    if (p.value === null) delete merged[p.jsonKey];
    else merged[p.jsonKey] = p.value;
    log.push({ field: `fields.${p.jsonKey}`, before, after: p.value });

    const mirror = MIRROR_BY_JSON_KEY[p.jsonKey];
    if (mirror) mirrorSets.push({ ...mirror, value: mirrorValue(mirror.cast, p.value) });
  }

  if (log.length > 0) {
    // Profit = Total Invoiced − Cost, recomputed on every write. Derived, so
    // no activity row of its own (the mirror-column rule) — the trail shows
    // the input that moved.
    applyProfitFormula(merged);
      await withTransaction(async (tx) => {
      const sets = [`fields = $1::jsonb`];
      const params: unknown[] = [JSON.stringify(merged)];
      for (const m of mirrorSets) {
        params.push(m.value);
        sets.push(`${m.column} = $${params.length}::${m.cast}`);
      }
      params.push(task.id);
      await tx.query(
        `UPDATE task SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`,
        params,
      );
      await logTaskChanges(tx, actorId, task.id, log, auto?.by);
    });
    // Automations react after the commit, before the fresh detail is read.
    await dispatchAutomations({ taskId: task.id, kind: 'changed', changes: log }, auto);
  }

  // The fresh detail, whether or not anything changed — saving the value a
  // field already had is a no-op, not an error (unlike bulk, where "nothing to
  // change" means the operator picked nothing in the dialog).
  return { changed: log.length, detail: await getWorkOrderDetail(task.id) };
}

/** The field_def subtype for a catalogue key, for the formula write-guard. */
async function subtypeOf(catalogueKey: string): Promise<string | null> {
  const jsonKey = catalogueKey.startsWith('fields.')
    ? catalogueKey.slice('fields.'.length)
    : catalogueKey;
  const res = await query<{ type: string }>(
    `SELECT type::text AS type FROM field_def WHERE key = $1 LIMIT 1`,
    [jsonKey],
  );
  return res.rows[0]?.type ?? null;
}

// ── Per-field history ────────────────────────────────────────────────────────

/**
 * Every change ever recorded for ONE field of ONE work order, newest first.
 * For a mirrored field the trail also includes writes that went through the
 * promoted column (a bulk edit of `billing_entity` IS a Comp change).
 */
export async function getFieldHistory(
  taskId: string,
  catalogueKey: string,
  limit: number,
): Promise<ActivityEntry[]> {
  const f = await resolveField(catalogueKey); // throws on unknown keys
  const fieldKeys = [f.custom ? `fields.${f.jsonKey}` : f.key];
  if (f.custom && f.jsonKey && MIRROR_BY_JSON_KEY[f.jsonKey]) {
    fieldKeys.push(MIRROR_BY_JSON_KEY[f.jsonKey].column);
  }

  const holes = fieldKeys.map((_, i) => `$${i + 2}`).join(', ');
  const res = await query<{
    id: number | string;
    action: string;
    field: string | null;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    actor_id: string;
    actor_name: string;
    actor_kind: 'human' | 'service';
    created_at: string;
  }>(
    `SELECT a.id, a.action, a.field, a.before, a.after,
            p.id AS actor_id, p.display_name AS actor_name, p.kind AS actor_kind,
            ${CREATED_AT_SQL} AS created_at
       FROM activity_log a
       JOIN principal p ON p.id = a.actor_principal_id
      WHERE a.entity_type = 'task' AND a.entity_id = $1 AND a.field IN (${holes})
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${fieldKeys.length + 2}`,
    [taskId, ...fieldKeys, limit],
  );

  return res.rows.map((r) => ({
    id: Number(r.id),
    action: r.action,
    field: r.field,
    before: r.before,
    after: r.after,
    actor: { id: r.actor_id, display_name: r.actor_name, kind: r.actor_kind },
    created_at: r.created_at,
  }));
}

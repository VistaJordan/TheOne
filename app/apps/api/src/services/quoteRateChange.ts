/* A rate change request on a quote (Elise, 2026-11-19, UAT #23 follow-up).
 *
 * A dispatcher cannot type another rate on a Labor or Trip line the client's
 * price list prices (cardRatesLockedFor, 2026-11-16). When the list's figure
 * is wrong for the job they ASK: a `rate_change` approval task in Approvals ›
 * Manager reviews (section `approvals/reviews`), carrying the lines, the rate
 * each one has, the rate asked for and the reason. Approving it writes the
 * asked rates onto those lines (after the decision commits, as the manager's
 * act, logged `quote_rate_changed`) and bumps the quote's revision so an open
 * builder reloads instead of saving the old figure back. Only while the quote
 * is still being written (draft, pending correction): a quote that moved on is
 * refused at request time and again before the approval commits.
 *
 * The price card itself is not changed here — a wrong card is fixed in Prices. */

import {
  OVERAGE_REASON_MIN,
  MONEY_MAX,
  RATE_CHANGE_STALE_CODE,
  type RateChangeLine,
  type RateChangeRequestDetail,
} from '@theone/shared';
import { query, withTransaction } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { requirePerm } from './permissions.js';

const WRITABLE = ['draft', 'pending_correction'];

const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

interface LineOnFile {
  id: string;
  line_type: string;
  description: string;
  rate: number;
  section_kind: string;
  section_round: number;
  section_position: number;
}

async function quoteOf(taskId: string): Promise<{ id: string; number: string | null; status: string } | null> {
  const r = await query<{ id: string; number: string | null; status: string }>(
    `SELECT id::text AS id, number, status FROM quote WHERE task_id = $1 LIMIT 1`,
    [taskId],
  );
  return r.rows[0] ?? null;
}

async function linesOf(quoteId: string, ids: string[]): Promise<Map<string, LineOnFile>> {
  const r = await query<{ id: string; line_type: string; description: string | null; rate: string | number; kind: string; round: number; position: number }>(
    `SELECT l.id::text AS id, l.line_type, l.description, l.rate, s.kind, s.round, s.position
       FROM quote_line l JOIN quote_section s ON s.id = l.section_id
      WHERE s.quote_id = $1 AND s.deleted_at IS NULL AND l.id::text = ANY($2::text[])`,
    [quoteId, ids],
  );
  return new Map(
    r.rows.map((x) => [
      x.id,
      {
        id: x.id,
        line_type: x.line_type,
        description: x.description ?? '',
        rate: Number(x.rate),
        section_kind: x.kind,
        section_round: Number(x.round),
        section_position: Number(x.position),
      },
    ]),
  );
}

/** POST /work-orders/:id/quote/rate-change — raise (or replace) the request. */
export async function requestRateChange(
  taskId: string,
  input: { lines: Array<{ line_id: string; requested_rate: number }>; reason: string },
  actor: ActingPrincipal,
): Promise<{ approval_task_id: string; created: boolean }> {
  requirePerm(actor, 'quotes', 'edit', 'You cannot edit quotes');
  const q = await quoteOf(taskId);
  if (!q) throw notFound('No quote on this work order');
  if (!WRITABLE.includes(q.status)) {
    throw conflict('A rate can only be changed while the quote is still being written (draft or with a manager for correction).', {
      code: RATE_CHANGE_STALE_CODE,
    });
  }
  const reason = (input.reason ?? '').trim();
  if (reason.length < OVERAGE_REASON_MIN) {
    throw badRequest(`Say why the rate should change (at least ${OVERAGE_REASON_MIN} characters)`, { field: 'reason' });
  }
  const asked = (input.lines ?? []).filter((l) => l && typeof l.line_id === 'string');
  if (asked.length === 0) throw badRequest('Pick at least one line and the rate it should have', { field: 'lines' });
  const onFile = await linesOf(q.id, asked.map((l) => l.line_id));
  const lines: RateChangeLine[] = [];
  for (const a of asked) {
    const l = onFile.get(a.line_id);
    if (!l) throw badRequest('A line in the request is no longer on the quote — reload it', { field: 'lines' });
    const rate = Number(a.requested_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > MONEY_MAX) {
      throw badRequest(`Give a rate between $0 and ${money(MONEY_MAX)} for “${l.description || 'this line'}”`, { field: 'lines' });
    }
    const rounded = Math.round(rate * 100) / 100;
    if (Math.round(rounded * 100) === Math.round(l.rate * 100)) continue; // unchanged: nothing to ask
    lines.push({
      line_id: l.id,
      line_type: l.line_type,
      description: l.description,
      section: l.section_kind === 'incurred' ? 'Incurred' : 'Proposed',
      current_rate: l.rate,
      requested_rate: rounded,
    });
  }
  if (lines.length === 0) throw badRequest('Every rate asked for is the one the line already has', { field: 'lines' });

  const detail: RateChangeRequestDetail = { quote_id: q.id, quote_number: q.number, lines, reason };
  const first = lines[0];
  const more = lines.length > 1 ? ` (+${lines.length - 1} more)` : '';
  const { createApprovalTask } = await import('./approvals.js');
  const { item, created } = await createApprovalTask({
    taskId,
    type: 'rate_change',
    actorId: actor.id,
    preset: {
      title: `Rate change${q.number ? ` on ${q.number}` : ''}: ${first.description || first.line_type} ${money(first.current_rate)} → ${money(first.requested_rate)}${more}`,
      detail: { ...detail },
    },
  });
  return { approval_task_id: item.id, created };
}

/** Why an open rate change can no longer be applied, or null while it can.
    Asked before an approval commits (409), so an approval never promises a
    change it cannot make. */
export async function rateChangeStale(taskId: string, detail: Partial<RateChangeRequestDetail>): Promise<string | null> {
  const q = await quoteOf(taskId);
  if (!q || q.id !== detail.quote_id) return 'The quote is no longer on the work order';
  if (!WRITABLE.includes(q.status)) return 'The quote has moved on (submitted for approval or sent)';
  const ids = (detail.lines ?? []).map((l) => l.line_id);
  const onFile = await linesOf(q.id, ids);
  if (ids.some((id) => !onFile.has(id))) return 'A line in the request was removed from the quote';
  return null;
}

/** The approval's half: write the asked rates, as the approver, after the
    decision committed. */
export async function applyRateChange(
  taskId: string,
  detail: Partial<RateChangeRequestDetail>,
  approvalTaskId: string,
  approverId: string,
  requesterName: string | null,
): Promise<void> {
  const lines = detail.lines ?? [];
  if (!detail.quote_id || lines.length === 0) return;
  await withTransaction(async (tx) => {
    // The work order first, then the quote (the bag-write order elsewhere).
    await tx.query(`SELECT id FROM task WHERE id = $1 FOR NO KEY UPDATE`, [taskId]);
    const q = await tx.query<{ status: string; rev: number }>(
      `SELECT status, rev FROM quote WHERE id = $1 AND task_id = $2 FOR UPDATE`,
      [detail.quote_id, taskId],
    );
    if (!q.rows[0] || !WRITABLE.includes(q.rows[0].status)) {
      throw conflict('The quote moved on while the request was being approved — nothing was changed.', { code: RATE_CHANGE_STALE_CODE });
    }
    const before: Array<{ description: string; rate: number }> = [];
    for (const l of lines) {
      const r = await tx.query<{ rate: string | number; description: string | null }>(
        `UPDATE quote_line l SET rate = $1
           FROM quote_section s, quote_line old
          WHERE l.id = $2::uuid AND old.id = l.id AND s.id = l.section_id AND s.quote_id = $3
          RETURNING old.rate AS rate, l.description`,
        [l.requested_rate, l.line_id, detail.quote_id],
      );
      if (r.rows[0]) before.push({ description: r.rows[0].description ?? '', rate: Number(r.rows[0].rate) });
    }
    // A new revision: an open builder reloads rather than saving the old rate back.
    await tx.query(`UPDATE quote SET rev = rev + 1, updated_at = now() WHERE id = $1`, [detail.quote_id]);
    await tx.query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'quote_rate_changed', 'quote.rate', $3::jsonb, $4::jsonb)`,
      [
        approverId,
        taskId,
        JSON.stringify({ lines: before }),
        JSON.stringify({
          quote_id: detail.quote_id,
          via: 'approval_task',
          approval_task_id: approvalTaskId,
          requested_by: requesterName,
          reason: detail.reason ?? null,
          lines: lines.map((l) => ({ description: l.description, from: l.current_rate, to: l.requested_rate })),
        }),
      ],
    );
  });
}

/** The open request on this work order's quote, for the builder's chip. */
export async function openRateChange(taskId: string): Promise<{ id: string; created_at: string; lines: number } | null> {
  const r = await query<{ id: string; created_at: string; detail: Partial<RateChangeRequestDetail> }>(
    `SELECT id::text AS id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at, detail
       FROM approval_task WHERE task_id = $1 AND type = 'rate_change' AND status = 'open'
      ORDER BY created_at DESC LIMIT 1`,
    [taskId],
  );
  const row = r.rows[0];
  return row ? { id: row.id, created_at: row.created_at, lines: (row.detail.lines ?? []).length } : null;
}

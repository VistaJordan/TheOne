// Late Quote ticks itself (Elise, 2026-11-16) — the database half of
// packages/shared/src/lateQuote.ts, which has the rule and why.
//
// `sweepLateQuotes()` runs on the hourly cron (/webhooks/client-updates-run).
// It reads the candidates in one statement — Quote Due Date passed, Late
// Quote not ticked, the field never written before, no quote past draft —
// then asks the pure rule per row (the phase test lives in shared) and writes
// through `updateWorkOrderFields` as the "Late quotes" service principal, so
// the audit row, the mirrors and the automations see it like any edit. One
// work order failing never stops the rest; it never throws.

import {
  LATE_QUOTE_ACTOR_NAME,
  LATE_QUOTE_KEY,
  PENALTY_DESCRIPTION_KEY,
  PHASE_BY_STATUS_NAME,
  QUOTE_DUE_KEY,
  isQuoteOwed,
  lateQuoteDescription,
  shouldMarkLateQuote,
} from '@theone/shared';
import { query } from '../db.js';
import { serviceActorId } from './serviceActors.js';
import { updateWorkOrderFields } from './woFieldValues.js';

interface Candidate {
  id: string;
  status_name: string | null;
  quote_due: string | null;
  quote_status: string | null;
  description: string | null;
}

export async function sweepLateQuotes(now: Date = new Date()): Promise<{ marked: number; errors: number }> {
  let marked = 0;
  let errors = 0;
  try {
    const res = await query<Candidate>(
      `SELECT t.id::text AS id, s.name AS status_name,
              t.fields->>$1 AS quote_due,
              q.status AS quote_status,
              t.fields->>$3 AS description
         FROM task t
         LEFT JOIN status s ON s.id = t.status_id
         LEFT JOIN quote q ON q.task_id = t.id
        WHERE t.deleted_at IS NULL
          AND COALESCE(t.fields->>$1, '') <> ''
          AND COALESCE(t.fields->$2 = 'true'::jsonb, false) = false
          AND (q.id IS NULL OR q.status = 'draft')
          AND NOT EXISTS (
                SELECT 1 FROM activity_log a
                 WHERE a.entity_type = 'task' AND a.entity_id = t.id::text
                   AND a.field = 'fields.' || $2)
        LIMIT 500`,
      [QUOTE_DUE_KEY, LATE_QUOTE_KEY, PENALTY_DESCRIPTION_KEY],
    );
    if (res.rows.length === 0) return { marked, errors };
    const actorId = await serviceActorId(LATE_QUOTE_ACTOR_NAME, 'LQ');
    for (const r of res.rows) {
      const owed = isQuoteOwed(r.status_name, r.status_name ? PHASE_BY_STATUS_NAME[r.status_name] ?? null : null);
      const go = shouldMarkLateQuote(
        { quoteDueAt: r.quote_due, quoteStatus: r.quote_status, quoteOwed: owed, ticked: false, touchedBefore: false },
        now,
      );
      if (!go || !r.quote_due) continue;
      const values: Record<string, unknown> = { [`fields.${LATE_QUOTE_KEY}`]: true };
      if (!r.description || r.description.trim() === '') {
        values[`fields.${PENALTY_DESCRIPTION_KEY}`] = lateQuoteDescription(r.quote_due);
      }
      try {
        await updateWorkOrderFields(r.id, values, actorId, undefined, { system: true });
        marked += 1;
      } catch (e) {
        errors += 1;
        console.error('[late-quote] could not mark', r.id, e instanceof Error ? e.message : e);
      }
    }
  } catch (e) {
    errors += 1;
    console.error('[late-quote] sweep failed', e instanceof Error ? e.message : e);
  }
  return { marked, errors };
}

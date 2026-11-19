// Late Quote ticks itself (Elise, 2026-11-16; clock changed 2026-11-19) —
// the database half of packages/shared/src/lateQuote.ts, which has the rule
// and why.
//
// `sweepLateQuotes()` runs on the hourly cron (/webhooks/client-updates-run).
// It reads the candidates in one statement — in Waiting for Quote, Late Quote
// not ticked, the field not written since the work order entered the status,
// no quote submitted — works out when each one was due (entry into the status
// + 48 working hours, the "Quote due" notices' clock), asks the pure rule, and
// writes through `updateWorkOrderFields` as the "Late quotes" service
// principal, so the audit row, the mirrors and the automations see it like
// any edit. One work order failing never stops the rest; it never throws.

import {
  LATE_QUOTE_ACTOR_NAME,
  LATE_QUOTE_KEY,
  PENALTY_DESCRIPTION_KEY,
  QUOTE_DUE_AFTER_HOURS,
  QUOTE_DUE_STATUS_NAME,
  QUOTE_ON_ITS_WAY_STATUSES,
  lateQuoteDescription,
  shouldMarkLateQuote,
} from '@theone/shared';
import { query } from '../db.js';
import { addWorkingHours } from '../lib/businessDays.js';
import { holidayDays } from './holidays.js';
import { STATUS_SINCE_SQL } from './obligations.js';
import { serviceActorId } from './serviceActors.js';
import { updateWorkOrderFields } from './woFieldValues.js';

interface Candidate {
  id: string;
  entered_at: Date;
  quote_status: string | null;
  description: string | null;
}

export async function sweepLateQuotes(now: Date = new Date()): Promise<{ marked: number; errors: number }> {
  let marked = 0;
  let errors = 0;
  try {
    const res = await query<Candidate>(
      `SELECT x.id, x.entered_at, x.quote_status, x.description
         FROM (
           SELECT t.id::text AS id,
                  ${STATUS_SINCE_SQL} AS entered_at,
                  (SELECT q.status FROM quote q WHERE q.task_id = t.id ORDER BY q.updated_at DESC LIMIT 1) AS quote_status,
                  t.fields->>$3 AS description,
                  t.id AS tid
             FROM task t
             JOIN status s ON s.id = t.status_id
            WHERE t.deleted_at IS NULL
              AND s.name = $1
              AND COALESCE(t.fields->$2 = 'true'::jsonb, false) = false
              AND NOT EXISTS (SELECT 1 FROM quote q WHERE q.task_id = t.id AND q.status = ANY($4::text[]))
         ) x
        WHERE NOT EXISTS (
                SELECT 1 FROM activity_log a
                 WHERE a.entity_type = 'task' AND a.entity_id = x.id
                   AND a.field = 'fields.' || $2
                   AND a.created_at >= x.entered_at)
        LIMIT 500`,
      [QUOTE_DUE_STATUS_NAME, LATE_QUOTE_KEY, PENALTY_DESCRIPTION_KEY, [...QUOTE_ON_ITS_WAY_STATUSES]],
    );
    if (res.rows.length === 0) return { marked, errors };
    const holidays = await holidayDays();
    const actorId = await serviceActorId(LATE_QUOTE_ACTOR_NAME, 'LQ');
    for (const r of res.rows) {
      const dueAt = addWorkingHours(new Date(r.entered_at), QUOTE_DUE_AFTER_HOURS, holidays).toISOString();
      const go = shouldMarkLateQuote(
        { dueAt, waitingForQuote: true, quoteStatus: r.quote_status, ticked: false, touchedSinceEntered: false },
        now,
      );
      if (!go) continue;
      const values: Record<string, unknown> = { [`fields.${LATE_QUOTE_KEY}`]: true };
      if (!r.description || r.description.trim() === '') {
        values[`fields.${PENALTY_DESCRIPTION_KEY}`] = lateQuoteDescription(dueAt);
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

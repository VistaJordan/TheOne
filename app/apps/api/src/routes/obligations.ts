// Routes: the obligation engine's read surface + its one human lever (S5).
//
//   GET  /pulse                      the three columns, for the acting principal
//   GET  /obligations?wo=&state=     live obligations (feeds the clock chips)
//   GET  /notifications              my bell, newest first
//   POST /notifications/:id/read     one entry
//   POST /notifications/read-all     the dropdown's footer action
//   POST /obligations/:id/snooze     {hours<=72, reason} — reason MANDATORY
//
// THE LAZY EVALUATOR. There is no cron in the prototype: the two READ endpoints
// nudge the evaluator (debounced to once per 30s) before answering, which is
// what keeps the Pulse honest without a scheduler. The nudge is awaited so the
// response reflects it, and it can never fail the request — evaluateDebounced()
// swallows its own errors.
//
// Every handler answers a well-formed EMPTY payload when migration 0004 has not
// been applied yet, so the running app degrades to "no clocks" instead of 500s.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  evaluateDebounced,
  evaluateNow,
  getPulse,
  listObligations,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  snoozeObligation,
  SNOOZE_MAX_HOURS,
} from '../services/obligations.js';

const obligationQuerySchema = z.object({
  /** Work-order uuid or WO number. */
  wo: z.string().trim().min(1).optional(),
  /** `open` = not resolved; a snoozed clock is still a clock the board shows. */
  state: z.enum(['open', 'snoozed', 'resolved']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Obligation and notification ids are always uuids (unlike a work order, which
// is addressable by its WO number too). Validating that here turns a malformed
// id into a clean 400 instead of a uuid-cast 500 from Postgres.
const idParamsSchema = z.object({ id: z.string().uuid() });

// The reason is the whole point: `min(3)` after trimming, so " " and "x" are
// both rejected. A snooze with no reason is a dismissal, and this engine has no
// dismiss.
const snoozeSchema = z
  .object({
    hours: z.coerce.number().positive().max(SNOOZE_MAX_HOURS),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export default async function obligationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * GET /api/pulse — needs_me_now / due_soon / watching for the acting
   * principal. `needs_me` is the same array under the brief's name for it.
   */
  app.get('/pulse', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    await evaluateDebounced();
    const board = await getPulse(actor);
    return {
      actor: { id: actor.id, display_name: actor.name, role: actor.role },
      needs_me_now: board.needs_me_now,
      needs_me: board.needs_me_now,
      due_soon: board.due_soon,
      watching: board.watching,
      counts: board.counts,
      generated_at: new Date().toISOString(),
    };
  });

  /** GET /api/obligations — the clock chips' source, worst-first. */
  app.get('/obligations', async (req) => {
    const q = parse(obligationQuerySchema, req.query);
    const actor = actingPrincipalFromRequest(req);
    await evaluateDebounced();
    const items = await listObligations(q, actor);
    return { items, total: items.length };
  });

  /** GET /api/notifications — mine only, newest first. */
  app.get('/notifications', async (req) => {
    const { limit } = parse(notificationsQuerySchema, req.query);
    const actor = actingPrincipalFromRequest(req);
    await evaluateDebounced();
    const { items, unread } = await listNotifications(actor.id, limit);
    // `unread` and `unread_count` carry the same number: apps/web's reader
    // accepts either name, and sending both removes a coin-flip from the seam.
    return { items, total: items.length, unread, unread_count: unread };
  });

  app.post('/notifications/:id/read', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    await markNotificationRead(id, actor.id);
    return { ok: true };
  });

  app.post('/notifications/read-all', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    const marked = await markAllNotificationsRead(actor.id);
    return { ok: true, marked };
  });

  /**
   * POST /api/obligations/:id/snooze — the only way a human moves a clock.
   * 400 without a reason or beyond 72h; 403 when someone below ATL tries to
   * snooze a tier-3 obligation; 404 when the obligation is already resolved.
   */
  app.post('/obligations/:id/snooze', async (req) => {
    const { id } = parse(idParamsSchema, req.params);
    const { hours, reason } = parse(snoozeSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    const obligation = await snoozeObligation(id, hours, reason, actor);
    // The snooze changed the world the evaluator reads; re-run so the very next
    // read (the web invalidates immediately) already agrees with it.
    await evaluateNow();
    return { obligation };
  });
}

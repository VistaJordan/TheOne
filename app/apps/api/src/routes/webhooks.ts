// Machine-to-machine receivers. No session: the auth guard allowlists each
// path here by name and the route checks a shared secret instead
// (lib/webhookAuth.ts). Everything under /api/webhooks that is NOT allowlisted
// still 401s like the rest of the API.
//
// POST /api/webhooks/email-escalation — rule 7.3.2. The external email tool
// posts one call per email it judges an escalation:
//
//   headers  x-webhook-secret: <ESCALATION_WEBHOOK_SECRET>   (or Authorization: Bearer …)
//   body     { "wo_number": "WO-39422",            required
//              "reason": "Client says 3rd no-show", optional
//              "source_email": "fm@client.com",     optional
//              "subject": "RE: WO-39422 …",         optional
//              "message_id": "<…@mail>" }           optional
//   200      { ok: true, wo_number, task_id, changed }   — flag raised (changed=false: it already was)
//   400      body fails validation
//   401      secret missing or wrong
//   403      receiver not configured (no secret in the environment), or DEMO_MODE
//   404      no live work order has that number (the attempt is still logged)
//
// The tool is standalone today; the shape above is the contract to align it
// to. What each call does is in services/escalations.ts.
//
// POST /api/webhooks/quo — 0054. Quo (Settings › Webhooks) posts call events
// for the monitored lines: call.completed, call.transcript.completed,
// call.summary.completed. Signed with the webhook's key (QUO_WEBHOOK_SECRET),
// verified in lib/quoSignature.ts. Every well-signed event gets a 200 — one
// that matches no call placed from a work order is acknowledged and dropped,
// so Quo never retries it. 401 bad signature, 403 unconfigured / DEMO_MODE.
// What each event does is in services/woCalls.ts.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError, parse } from '../errors.js';
import { checkWebhookSecret, presentedSecret } from '../lib/webhookAuth.js';
import { verifyQuoSignature } from '../lib/quoSignature.js';
import { escalateFromEmail } from '../services/escalations.js';
import { raiseDueWorkOrders } from '../services/plannedMaintenance.js';
import { handleQuoEvent } from '../services/woCalls.js';
import type { QuoEvent } from '../services/woCalls.js';
import { runDueClientUpdates } from '../services/clientUpdates.js';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const emailEscalationSchema = z.object({
  wo_number: z.string().trim().min(1, 'wo_number is required').max(64),
  reason: optionalText(4000),
  source_email: optionalText(320),
  subject: optionalText(1000),
  message_id: optionalText(512),
});

export default async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // 0051 · the clock. Vercel's cron (vercel.json) GETs this once a day with
  // `Authorization: Bearer <CRON_SECRET>`; a POST with the same secret works
  // for a hand run. Raises every planned-maintenance work order that is due.
  const cronRun = async (req: { headers: Record<string, unknown> }) => {
    if (config.demoMode) throw new ApiError('FORBIDDEN', 'Webhooks are disabled in the public demo.');
    const outcome = checkWebhookSecret(presentedSecret(req.headers), config.cronSecret);
    if (outcome === 'unconfigured') {
      throw new ApiError('FORBIDDEN', 'The cron is not configured (CRON_SECRET is unset).');
    }
    if (outcome !== 'ok') throw new ApiError('UNAUTHORIZED', 'Cron secret missing or invalid');
    const { raised } = await raiseDueWorkOrders();
    return { ok: true, raised };
  };
  app.get('/webhooks/planned-maintenance-run', async (req) => cronRun(req));
  app.post('/webhooks/planned-maintenance-run', async (req) => cronRun(req));

  // 0055 · the client-update schedule. Vercel's cron calls it hourly (same
  // CRON_SECRET); each call sends every tracker whose next_run_at has come.
  const clientUpdatesRun = async (req: { headers: Record<string, unknown> }) => {
    if (config.demoMode) throw new ApiError('FORBIDDEN', 'Webhooks are disabled in the public demo.');
    const outcome = checkWebhookSecret(presentedSecret(req.headers), config.cronSecret);
    if (outcome === 'unconfigured') {
      throw new ApiError('FORBIDDEN', 'The cron is not configured (CRON_SECRET is unset).');
    }
    if (outcome !== 'ok') throw new ApiError('UNAUTHORIZED', 'Cron secret missing or invalid');
    // 0066 · the same hourly tick moves dispatch offers along (a no-op while
    // the cascade is switched off).
    const { sweepDispatchOffers } = await import('../services/vendorExtras.js');
    const dispatch = await sweepDispatchOffers().catch(() => ({ advanced: 0 }));
    // 0071 � and files what SharePoint still owes: failed folders retried,
    // work orders created by any path (the Ecotrak sync included) filed.
    const { sweepSharePoint } = await import('../services/sharepoint.js');
    const sharepoint = await sweepSharePoint().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    return { ok: true, ...(await runDueClientUpdates()), dispatch_advanced: dispatch.advanced, sharepoint };
  };
  app.get('/webhooks/client-updates-run', async (req) => clientUpdatesRun(req));
  app.post('/webhooks/client-updates-run', async (req) => clientUpdatesRun(req));

  app.post('/webhooks/email-escalation', async (req) => {
    // The public demo runs on seed data with the dev bypass; a reachable
    // receiver there would let anyone flag demo rows from the internet.
    if (config.demoMode) throw new ApiError('FORBIDDEN', 'Webhooks are disabled in the public demo.');

    const outcome = checkWebhookSecret(presentedSecret(req.headers), config.escalationWebhookSecret);
    if (outcome === 'unconfigured') {
      throw new ApiError('FORBIDDEN', 'The escalation webhook is not configured (ESCALATION_WEBHOOK_SECRET is unset).');
    }
    if (outcome !== 'ok') {
      throw new ApiError('UNAUTHORIZED', 'Webhook secret missing or invalid');
    }

    const body = parse(emailEscalationSchema, req.body);
    const result = await escalateFromEmail(body);
    return { ok: true, ...result };
  });

  app.post('/webhooks/quo', async (req) => {
    if (config.demoMode) throw new ApiError('FORBIDDEN', 'Webhooks are disabled in the public demo.');
    const outcome = verifyQuoSignature(req.headers, req.rawBody ?? '', config.quoWebhookSecret);
    if (outcome === 'unconfigured') {
      throw new ApiError('FORBIDDEN', 'The Quo webhook is not configured (QUO_WEBHOOK_SECRET is unset).');
    }
    if (outcome !== 'ok') throw new ApiError('UNAUTHORIZED', `Quo signature ${outcome}`);
    const event = (req.body ?? {}) as QuoEvent;
    const result = await handleQuoEvent(event);
    return { ok: true, event: event.id ?? null, ...result };
  });
}

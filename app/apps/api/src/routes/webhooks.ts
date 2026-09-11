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

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { ApiError, parse } from '../errors.js';
import { checkWebhookSecret, presentedSecret } from '../lib/webhookAuth.js';
import { escalateFromEmail } from '../services/escalations.js';

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
}

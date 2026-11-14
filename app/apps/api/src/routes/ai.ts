// Routes: AI usage, models and limits (migration 0138).
//
//   GET  /ai/status                  per feature: may I use it now, how much of today is left
//   GET  /ai/usage?period=           Dashboard › AI usage: cost per feature and per person, the settings
//   PUT  /ai/settings/:feature       { model, daily_limit, monthly_budget_usd }
//
// The two page routes answer super admins only (the person whose rights
// count: the viewed person while viewing as them, D6). A person's allowance and spend are the
// signed-in user's (`req.auth.user`): viewing as someone never spends their
// allowance.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AI_FEATURES, AI_MODEL_IDS, AI_USAGE_PERIODS, AI_DAILY_LIMIT_MAX, AI_MONTHLY_BUDGET_MAX } from '@theone/shared';
import { ApiError, parse } from '../errors.js';
import { aiStatus, aiUsageReport, saveAiSetting } from '../services/aiUsage.js';

const featureParams = z.object({ feature: z.enum(AI_FEATURES) });
const periodQuery = z.object({ period: z.enum(AI_USAGE_PERIODS).default('month') });
const settingBody = z
  .object({
    model: z.string().refine((m) => AI_MODEL_IDS.includes(m), 'Unknown model'),
    daily_limit: z.number().int().min(0).max(AI_DAILY_LIMIT_MAX).nullable(),
    monthly_budget_usd: z.number().min(0).max(AI_MONTHLY_BUDGET_MAX).nullable(),
  })
  .strict();

function auth(req: FastifyRequest) {
  if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
  return req.auth;
}

export default async function aiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ai/status', async (req) => aiStatus(auth(req).user.id));

  app.get('/ai/usage', async (req) => {
    const { period } = parse(periodQuery, req.query);
    return aiUsageReport(auth(req).actingAs, period);
  });

  app.put('/ai/settings/:feature', async (req) => {
    const { feature } = parse(featureParams, req.params);
    const input = parse(settingBody, req.body);
    return { settings: await saveAiSetting(auth(req).actingAs, feature, input) };
  });
}

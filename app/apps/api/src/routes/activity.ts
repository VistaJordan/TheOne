// Routes: GET /activity?wo=:id — a WO's activity newest-first (§5);
// GET /activity/latest?wo=:id — its newest change, polled by an open work order;
// GET /activity/since?after=:id — the newest change anywhere, polled by every screen.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, getActivityForTask, getRecentChangeHeads, getAppLatestChange, actingPrincipalFromRequest } from '../services/activity.js';
import type { AppLatestChange, WoLatestChange } from '@theone/shared';
import { activityValuesVisible, allowFor, requirePerm } from '../services/permissions.js';
import { liveChangeTab } from '../plugins/liveChange.js';

const latestQuerySchema = z.object({ wo: z.string().min(1) });

// How far back /activity/latest looks for a row the viewer may see. Past it
// (a burst of changes all on hidden fields) the newest row still moves the
// version, without a name, so the page reloads what it can see.
const LATEST_LOOKBACK = 25;

const sinceQuerySchema = z.object({ after: z.string().max(50).optional() });

const activityQuerySchema = z.object({
  wo: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export default async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get('/activity', async (req) => {
    const { wo, limit } = parse(activityQuerySchema, req.query);
    // The same gate the work order itself has (view + row scope, 0026).
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'work_orders', 'view', 'You cannot view work orders');
    const taskId = await resolveTaskId(wo, viewer);
    if (!taskId) throw notFound('Work order not found');
    // M28 · rows on a field this viewer cannot see are left out.
    const allow = allowFor(viewer);
    return (await getActivityForTask(taskId, limit)).filter((e) => activityValuesVisible(allow, e.field));
  });

  // Live updates: an open work order asks every few seconds and reloads when
  // the id moves. Same gate and scope as /activity; a row on a field the
  // viewer cannot see never names who changed it (M28).
  app.get('/activity/latest', async (req): Promise<WoLatestChange> => {
    const { wo } = parse(latestQuerySchema, req.query);
    const viewer = actingPrincipalFromRequest(req);
    requirePerm(viewer, 'work_orders', 'view', 'You cannot view work orders');
    const taskId = await resolveTaskId(wo, viewer);
    if (!taskId) throw notFound('Work order not found');
    const allow = allowFor(viewer);
    const heads = await getRecentChangeHeads(taskId, LATEST_LOOKBACK);
    const seen = heads.find((h) => activityValuesVisible(allow, h.field));
    if (seen) return { id: seen.id, actor: seen.actor, created_at: seen.created_at };
    return { id: heads[0]?.id ?? null, actor: null, created_at: heads[0]?.created_at ?? null };
  });

  // Live sync between accounts (0126): every signed-in screen asks whether
  // anything changed since it last looked that its own tab did not do, and
  // re-reads what it shows when so. Only a cursor and a yes / no come back —
  // no names, no records — so it needs no permission beyond being signed in.
  app.get('/activity/since', async (req): Promise<AppLatestChange> => {
    const { after } = parse(sinceQuerySchema, req.query);
    return getAppLatestChange(after ?? null, liveChangeTab(req.headers['x-obi-tab']));
  });
}

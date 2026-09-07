// Routes: approval tasks (0026) — the manager's inbox.
//   GET  /approvals                            (the inbox — approvals:view)
//   GET  /work-orders/:id/approval-tasks       (tasks on one WO — approvals:view)
//   POST /approval-tasks/:id/approve           (open → approved — approvals:approve)
//   POST /approval-tasks/:id/reject            (open → rejected + internal note — approvals:approve)
//   POST /approval-tasks/:id/claim             (take it into your lane — approvals:approve)
//
// Tasks are RAISED by the rules engine (an 'approval_task' action), never by
// hand from here. The acting principal is resolved once, up front, and the
// permission checks for the decisions live in the service so no route can
// forget one.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APPROVALS_PERM_KEY } from '@theone/shared';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import {
  approveApprovalTask,
  claimApprovalTask,
  listApprovalTasks,
  listApprovalTasksForWorkOrder,
  rejectApprovalTask,
} from '../services/approvals.js';
import { requirePerm } from '../services/permissions.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const uuidParamsSchema = z.object({ id: z.string().uuid() });
const approveSchema = z.object({ note: z.string().trim().max(2000).nullable().optional() });
const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id);
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/approvals', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), APPROVALS_PERM_KEY, 'view', 'You cannot view approvals');
    return listApprovalTasks();
  });

  app.get('/work-orders/:id/approval-tasks', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), APPROVALS_PERM_KEY, 'view', 'You cannot view approvals');
    const taskId = await taskIdOf(req);
    return listApprovalTasksForWorkOrder(taskId);
  });

  app.post('/approval-tasks/:id/approve', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const { note } = parse(approveSchema, req.body ?? {});
    const actor = actingPrincipalFromRequest(req);
    return { item: await approveApprovalTask(id, note?.trim() || null, actor) };
  });

  app.post('/approval-tasks/:id/reject', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const { note } = parse(rejectSchema, req.body);
    const actor = actingPrincipalFromRequest(req);
    return { item: await rejectApprovalTask(id, note, actor) };
  });

  app.post('/approval-tasks/:id/claim', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    return { item: await claimApprovalTask(id, actor) };
  });
}

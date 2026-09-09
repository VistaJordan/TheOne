// Routes: approval tasks (0020) — the manager's inbox.
//   GET  /approvals                            (the inbox — approvals:view, trimmed to the
//                                               sections the viewer may see + their own requests)
//   GET  /approvals/counts                     (the sidebar badge — what waits on the viewer)
//   GET  /work-orders/:id/approval-tasks       (tasks on one WO — approvals:view)
//   POST /approval-tasks/:id/approve           (open → approved — approvals/<section>:approve)
//   POST /approval-tasks/:id/reject            (open → rejected + internal note — same)
//   POST /approval-tasks/:id/claim             (take it into your lane — same)
//   POST /approval-tasks/:id/acknowledge       (0025: the requester saw the decision)
//   POST /approval-tasks/:id/withdraw          (0025: the requester takes an open request back)
//
// Tasks are RAISED by the rules engine (an 'approval_task' action) — and,
// since 0025, by a person asking for a status change (POST /work-orders/:id/
// status-request, in workOrders.ts). The acting principal is resolved once,
// up front, and the permission checks for the decisions live in the service
// so no route can forget one.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { APPROVALS_PERM_KEY } from '@theone/shared';
import { parse, notFound } from '../errors.js';
import { resolveTaskId, actingPrincipalFromRequest } from '../services/activity.js';
import {
  acknowledgeApprovalTask,
  approvalCounts,
  approveApprovalTask,
  claimApprovalTask,
  listApprovalTasks,
  listApprovalTasksForWorkOrder,
  rejectApprovalTask,
  withdrawApprovalTask,
} from '../services/approvals.js';
import { requirePerm } from '../services/permissions.js';

const idParamsSchema = z.object({ id: z.string().min(1) });
const uuidParamsSchema = z.object({ id: z.string().uuid() });
const approveSchema = z.object({ note: z.string().trim().max(2000).nullable().optional() });
const rejectSchema = z.object({ note: z.string().trim().min(1).max(2000) });

async function taskIdOf(req: FastifyRequest): Promise<string> {
  const { id } = parse(idParamsSchema, req.params);
  const taskId = await resolveTaskId(id, actingPrincipalFromRequest(req));
  if (!taskId) throw notFound('Work order not found');
  return taskId;
}

export default async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/approvals', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, APPROVALS_PERM_KEY, 'view', 'You cannot view approvals');
    return listApprovalTasks(actor);
  });

  // No permission gate: a zero is the honest answer for someone who may do
  // nothing here, and the sidebar asks for every signed-in person.
  app.get('/approvals/counts', async (req) => approvalCounts(actingPrincipalFromRequest(req)));

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

  app.post('/approval-tasks/:id/acknowledge', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    return { item: await acknowledgeApprovalTask(id, actor) };
  });

  app.post('/approval-tasks/:id/withdraw', async (req) => {
    const { id } = parse(uuidParamsSchema, req.params);
    const actor = actingPrincipalFromRequest(req);
    return { item: await withdrawApprovalTask(id, actor) };
  });
}

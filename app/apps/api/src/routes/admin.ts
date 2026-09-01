// Routes: Admin Studio. Everything here requires the manage-users capability
// (which every super admin has, and any role can be granted — see 0005).
//
//   Users     GET/POST  /admin/users · PATCH /admin/users/:id
//   Roles     GET/POST  /admin/roles · PATCH/DELETE /admin/roles/:id
//   Fields    GET       /admin/fields
//   Workflow  GET       /admin/workflow · POST/PATCH/DELETE /admin/workflow/statuses[/:id]
//                       POST/PATCH/DELETE /admin/workflow/groups[/:code]
//   Trash     GET       /admin/trash · POST /admin/trash/:id/restore
//   Settings  GET       /admin/settings
//
// The gate is applied per-route rather than at registration so each 403 can say
// which privilege was missing.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError, parse } from '../errors.js';
import { unauthorized } from '../services/auth.js';
import { disableUser, inviteUser, listUsers, updateUser } from '../services/users.js';
import { createRole, deleteRole, listRoles, updateRole } from '../services/roles.js';
import { listFieldDefs, listWorkflow, listTrash, restoreTask, getSettings } from '../services/adminMeta.js';
import { createFieldDef, updateFieldDef, reorderFieldDefs, FIELD_DEF_TYPES } from '../services/fieldDefs.js';
import {
  createStatus,
  createStatusGroup,
  deleteStatus,
  deleteStatusGroup,
  listStatusGroups,
  renameStatusGroup,
  updateStatus,
} from '../services/statusAdmin.js';
import { listAuditLog, exportAuditCsv } from '../services/auditLog.js';
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  listRuns,
  updateAutomation,
} from '../services/automations.js';
import { filterSetSchema } from './views.js';

function requireAdmin(req: FastifyRequest): string {
  if (!req.auth) throw unauthorized();
  // The REAL user, never `actingAs`: impersonating an admin must not hand the
  // impersonator the ability to edit users and roles as them.
  if (!req.auth.user.can.manageUsers) {
    throw new ApiError('FORBIDDEN', 'The admin console is restricted to super admins', {
      required_capability: 'can_manage_users',
    });
  }
  return req.auth.user.id;
}

const idParams = z.object({ id: z.string().uuid() });

// ── Users ────────────────────────────────────────────────────────────────────

const inviteSchema = z
  .object({
    email: z.string().trim().email().max(254),
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().min(1),
    is_super_admin: z.boolean().optional(),
  })
  .strict();

const updateUserSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().min(1).optional(),
    is_super_admin: z.boolean().optional(),
    status: z.enum(['invited', 'active', 'disabled']).optional(),
  })
  .strict();

// ── Roles ────────────────────────────────────────────────────────────────────

const createRoleSchema = z
  .object({
    code: z.string().trim().max(40).optional(),
    label: z.string().trim().min(2).max(60),
    description: z.string().trim().max(500).nullable().optional(),
    can_edit_quote: z.boolean().optional(),
    can_approve_quote: z.boolean().optional(),
    can_manage_users: z.boolean().optional(),
    can_edit_wo_fields: z.boolean().optional(),
    can_view_field_history: z.boolean().optional(),
  })
  .strict();

const updateRoleSchema = createRoleSchema.partial().strict();

export default async function adminRoutes(app: FastifyInstance): Promise<void> {
  // ── Users ──────────────────────────────────────────────────────────────────
  app.get('/admin/users', async (req) => {
    requireAdmin(req);
    return { items: await listUsers() };
  });

  app.post('/admin/users', async (req, reply) => {
    requireAdmin(req);
    const user = await inviteUser(parse(inviteSchema, req.body));
    return reply.status(201).send({ user });
  });

  app.patch('/admin/users/:id', async (req) => {
    const actorId = requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { user: await updateUser(id, parse(updateUserSchema, req.body), actorId) };
  });

  app.post('/admin/users/:id/disable', async (req) => {
    const actorId = requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { user: await disableUser(id, actorId) };
  });

  // ── Roles ──────────────────────────────────────────────────────────────────
  app.get('/admin/roles', async (req) => {
    requireAdmin(req);
    return { items: await listRoles() };
  });

  app.post('/admin/roles', async (req, reply) => {
    requireAdmin(req);
    const role = await createRole(parse(createRoleSchema, req.body));
    return reply.status(201).send({ role });
  });

  app.patch('/admin/roles/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { role: await updateRole(id, parse(updateRoleSchema, req.body)) };
  });

  app.delete('/admin/roles/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    await deleteRole(id);
    return { ok: true };
  });

  // ── Custom fields (S7: read + the field engine's writes) ───────────────────
  const fieldTypeSchema = z.enum(FIELD_DEF_TYPES);
  const createFieldSchema = z
    .object({
      label: z.string().trim().min(1).max(120),
      type: fieldTypeSchema,
      options: z.array(z.string().trim().min(1).max(120)).max(500).optional(),
    })
    .strict();
  const updateFieldSchema = createFieldSchema.partial().strict();
  const reorderFieldsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

  app.get('/admin/fields', async (req) => {
    requireAdmin(req);
    return { items: await listFieldDefs() };
  });

  app.post('/admin/fields', async (req, reply) => {
    requireAdmin(req);
    const body = parse(createFieldSchema, req.body);
    return reply.status(201).send({ field: await createFieldDef(body) });
  });

  app.patch('/admin/fields/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { field: await updateFieldDef(id, parse(updateFieldSchema, req.body)) };
  });

  app.put('/admin/fields/order', async (req) => {
    requireAdmin(req);
    const { ids } = parse(reorderFieldsSchema, req.body);
    return { items: await reorderFieldDefs(ids) };
  });

  // ── Statuses & workflow (the status engine's writes) ───────────────────────
  const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a #rrggbb hex color');
  const createStatusSchema = z
    .object({
      name: z.string().trim().min(1).max(80),
      group: z.string().trim().min(1).max(60),
      color: colorSchema.optional(),
    })
    .strict();
  const updateStatusSchema = z
    .object({ name: z.string().trim().min(1).max(80).optional(), color: colorSchema.optional() })
    .strict();
  const groupLabelSchema = z.object({ label: z.string().trim().min(1).max(60) }).strict();
  const groupParams = z.object({ code: z.string().trim().min(1).max(60) });

  app.get('/admin/workflow', async (req) => {
    requireAdmin(req);
    return { items: await listWorkflow(), groups: await listStatusGroups() };
  });

  app.post('/admin/workflow/statuses', async (req, reply) => {
    requireAdmin(req);
    const item = await createStatus(parse(createStatusSchema, req.body));
    return reply.status(201).send({ item });
  });

  app.patch('/admin/workflow/statuses/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { item: await updateStatus(id, parse(updateStatusSchema, req.body)) };
  });

  app.delete('/admin/workflow/statuses/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    await deleteStatus(id);
    return { ok: true };
  });

  app.post('/admin/workflow/groups', async (req, reply) => {
    requireAdmin(req);
    const { label } = parse(groupLabelSchema, req.body);
    return reply.status(201).send({ item: await createStatusGroup(label) });
  });

  app.patch('/admin/workflow/groups/:code', async (req) => {
    requireAdmin(req);
    const { code } = parse(groupParams, req.params);
    const { label } = parse(groupLabelSchema, req.body);
    return { item: await renameStatusGroup(code, label) };
  });

  app.delete('/admin/workflow/groups/:code', async (req) => {
    requireAdmin(req);
    const { code } = parse(groupParams, req.params);
    await deleteStatusGroup(code);
    return { ok: true };
  });

  // ── Automations (the rules engine) ─────────────────────────────────────────
  // GET/POST /admin/automations · PATCH/DELETE /admin/automations/:id
  // GET      /admin/automations/:id/runs
  // Field keys, operators and action targets are validated in the service
  // against the live field catalogue — the schemas here only shape the JSON.

  const triggerSchema = z
    .object({
      // 'manual' = enrolled from the work-orders list only, never event-fired.
      kind: z.enum(['created', 'changed', 'manual']),
      field: z.string().trim().min(1).max(200).nullish(),
      to: z.string().trim().min(1).max(400).nullish(),
      // How the new value is tested against `to` — the comparisons are for
      // money/number fields ("changed to more than 500"); eq/absent = exact.
      to_op: z.enum(['eq', 'gt', 'gte', 'lt', 'lte']).nullish(),
      // Wait N minutes after the trigger; conditions run when the wait ends.
      delay_minutes: z.number().int().min(0).max(43200).nullish(),
    })
    .strict();

  const actionSchema = z
    .object({
      field: z.string().trim().min(1).max(200),
      value: z.string().max(4000).nullable(),
    })
    .strict();

  const createAutomationSchema = z
    .object({
      name: z.string().trim().min(1).max(120),
      enabled: z.boolean().optional(),
      // All four are schema-valid; the service rejects the not-yet-live ones
      // with a message the builder shows verbatim.
      entity: z.enum(['work_order', 'vendor', 'quote', 'invoice']).optional(),
      trigger: triggerSchema,
      conditions: filterSetSchema.optional(),
      actions: z.array(actionSchema).min(1).max(10),
    })
    .strict();

  const updateAutomationSchema = createAutomationSchema.partial().strict();

  const runsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  });

  app.get('/admin/automations', async (req) => {
    requireAdmin(req);
    return { items: await listAutomations() };
  });

  app.post('/admin/automations', async (req, reply) => {
    const actorId = requireAdmin(req);
    const body = parse(createAutomationSchema, req.body);
    return reply.status(201).send({ item: await createAutomation(body, actorId) });
  });

  app.patch('/admin/automations/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { item: await updateAutomation(id, parse(updateAutomationSchema, req.body)) };
  });

  app.delete('/admin/automations/:id', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    await deleteAutomation(id);
    return { ok: true };
  });

  app.get('/admin/automations/:id/runs', async (req) => {
    requireAdmin(req);
    const { id } = parse(idParams, req.params);
    const { limit } = parse(runsQuerySchema, req.query);
    return { items: await listRuns(id, limit) };
  });

  // ── Trash ──────────────────────────────────────────────────────────────────
  app.get('/admin/trash', async (req) => {
    requireAdmin(req);
    return { items: await listTrash() };
  });

  app.post('/admin/trash/:id/restore', async (req) => {
    const actorId = requireAdmin(req);
    const { id } = parse(idParams, req.params);
    return { item: await restoreTask(id, actorId) };
  });

  // ── Settings ───────────────────────────────────────────────────────────────
  // ── Audit log ──────────────────────────────────────────────────────────────
  // GET /admin/audit          the whole activity_log, filtered and paged
  // GET /admin/audit/export   the same rows as CSV

  const auditQuerySchema = z.object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    actor_id: z.string().uuid().optional(),
    action: z.string().trim().min(1).max(60).optional(),
    field: z.string().trim().min(1).max(200).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });

  app.get('/admin/audit', async (req) => {
    requireAdmin(req);
    return listAuditLog(parse(auditQuerySchema, req.query));
  });

  app.get('/admin/audit/export', async (req, reply) => {
    requireAdmin(req);
    const { limit: _l, offset: _o, ...filters } = parse(auditQuerySchema, req.query);
    const csv = await exportAuditCsv(filters);
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="audit-log-${stamp}.csv"`)
      .send(csv);
  });

  app.get('/admin/settings', async (req) => {
    requireAdmin(req);
    return getSettings();
  });
}

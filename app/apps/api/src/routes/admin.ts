// Routes: Admin Studio. Everything here requires the manage-users capability
// (which every super admin has, and any role can be granted — see 0005).
//
//   Users     GET/POST  /admin/users · PATCH /admin/users/:id
//   Roles     GET/POST  /admin/roles · PATCH/DELETE /admin/roles/:id
//   Fields    GET       /admin/fields
//   Workflow  GET       /admin/workflow
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

  // ── Custom fields ──────────────────────────────────────────────────────────
  app.get('/admin/fields', async (req) => {
    requireAdmin(req);
    return { items: await listFieldDefs() };
  });

  // ── Statuses & workflow ────────────────────────────────────────────────────
  app.get('/admin/workflow', async (req) => {
    requireAdmin(req);
    return { items: await listWorkflow() };
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
  app.get('/admin/settings', async (req) => {
    requireAdmin(req);
    return getSettings();
  });
}

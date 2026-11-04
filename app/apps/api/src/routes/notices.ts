// Routes: in-app notifications (0059), read on the Notifications page
// (2026-11-04; the bell in the top bar is gone).
//
//   GET  /notices/inbox      → NoticeInboxResponse   the page: filters, types, a page
//   GET  /notices/count      → { unread }          what the sidebar badge polls
//   POST /notices/mark       → { changed, unread }  read or unread: rows, a type, or all
//   GET  /notices            → { items, unread }   newest unread first (0059)
//   POST /notices/:id/read   → { unread }
//   POST /notices/read-all   → { unread }
//
// A person's notifications are their own: every route reads the ACTING
// principal's rows and no route takes a principal id. A super admin viewing
// as someone else sees (and may clear) that person's inbox, like every other
// page they look at through that person's eyes. The Pulse's pings join the
// inbox only for someone who holds the Pulse (`work_orders/pulse` view).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NOTICE_PAGE_SIZE, PULSE_PERM_KEY, permAllows } from '@theone/shared';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  inboxUnread,
  listInbox,
  listNotifications,
  markAllRead,
  markInbox,
  markRead,
  pruneNotifications,
  unreadCount,
} from '../services/notices.js';
import { evaluateDebounced, obligationsReady } from '../services/obligations.js';

const kindRe = /^[a-z0-9_.]{1,64}$/;

const inboxQuerySchema = z.object({
  show: z.enum(['all', 'unread', 'read']).default('all'),
  /** Comma-joined kinds; blank = every type. */
  kinds: z.string().max(2000).optional(),
  q: z.string().max(200).optional(),
  before: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(NOTICE_PAGE_SIZE),
});

const markSchema = z.object({
  read: z.boolean(),
  items: z
    .array(z.object({ source: z.enum(['notice', 'pulse']), id: z.string().min(1).max(64) }))
    .max(500)
    .optional(),
  kinds: z.array(z.string().regex(kindRe)).max(100).nullable().optional(),
});

function parseKinds(raw: string | undefined): string[] | null {
  const kinds = (raw ?? '').split(',').map((k) => k.trim()).filter((k) => kindRe.test(k));
  return kinds.length ? [...new Set(kinds)] : null;
}

async function withPulse(req: FastifyRequest): Promise<boolean> {
  const me = actingPrincipalFromRequest(req);
  return permAllows(me.perms, PULSE_PERM_KEY, 'view', me.isSuperAdmin) && (await obligationsReady());
}

export default async function noticeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notices/inbox', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const q = parse(inboxQuerySchema, req.query);
    const pulse = await withPulse(req);
    await pruneNotifications(me.id);
    if (pulse) await evaluateDebounced();
    return listInbox(me.id, {
      read: q.show,
      kinds: parseKinds(q.kinds),
      q: q.q?.trim() || null,
      before: q.before ?? null,
      limit: q.limit,
      withPulse: pulse,
    });
  });

  app.get('/notices/count', async (req) => ({
    unread: await inboxUnread(actingPrincipalFromRequest(req).id, await withPulse(req)),
  }));

  app.post('/notices/mark', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const body = parse(markSchema, req.body);
    const pulse = await withPulse(req);
    const changed = await markInbox(me.id, pulse, body);
    return { changed, unread: await inboxUnread(me.id, pulse) };
  });

  app.get('/notices', async (req) => {
    const me = actingPrincipalFromRequest(req);
    await pruneNotifications(me.id);
    return listNotifications(me.id);
  });

  app.post('/notices/read-all', async (req) => {
    const me = actingPrincipalFromRequest(req);
    await markAllRead(me.id);
    return { unread: 0 };
  });

  app.post('/notices/:id/read', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const { id } = parse(z.object({ id: z.string().min(1).max(64) }), req.params);
    await markRead(me.id, id);
    return { unread: await unreadCount(me.id, true) };
  });
}

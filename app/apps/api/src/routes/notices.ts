// Routes: in-app notifications (0059) — the bell in the top bar.
//
//   GET  /notices            → { items, unread }   newest unread first
//   GET  /notices/count      → { unread }          what the badge polls
//   POST /notices/:id/read   → { unread }
//   POST /notices/read-all   → { unread }
//
// A person's notifications are their own: every route reads the ACTING
// principal's rows and no route takes a principal id. A super admin viewing
// as someone else sees (and may clear) that person's bell, like every other
// page they look at through that person's eyes.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { listNotifications, markAllRead, markRead, pruneNotifications, unreadCount } from '../services/notices.js';

export default async function noticeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/notices', async (req) => {
    const me = actingPrincipalFromRequest(req);
    await pruneNotifications(me.id);
    return listNotifications(me.id);
  });

  app.get('/notices/count', async (req) => ({ unread: await unreadCount(actingPrincipalFromRequest(req).id) }));

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

// Routes: in-app notifications (0059), read on the Notifications page
// (2026-11-04; the bell in the top bar is gone).
//
//   GET  /notices/inbox      → NoticeInboxResponse   the page: filters, types, a page
//   GET  /notices/count      → { unread }          what the sidebar badge polls
//   POST /notices/mark       → { changed, unread }  read or unread: rows, a type, or all
//   GET  /notices            → { items, unread }   newest unread first (0059)
//   POST /notices/:id/read   → { unread }
//   POST /notices/read-all   → { unread }
//   POST /notices/seen-messages → { changed, unread }  the Messages tab showed these messages
//   GET  /after-hours        → AfterHoursState       is the wide view on, per page
//   POST /after-hours        → AfterHoursState       a press of the switch (logged)
//   GET  /after-hours/log    → { items }             every press (admin/audit view)
//
// Elise 2026-11-16 · a notice about a work order shows only to the people on
// that job (an assigned seat); `?after_hours=1` shows the rest while After
// hours is on for the person.
//
// A person's notifications are their own: every route reads the ACTING
// principal's rows and no route takes a principal id. A super admin viewing
// as someone else sees (and may clear) that person's inbox, like every other
// page they look at through that person's eyes. The Pulse's pings join the
// inbox only for someone who holds the Pulse (`work_orders/pulse` view).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NOTICE_PAGE_SIZE, PULSE_PERM_KEY, adminPermKey, permAllows } from '@theone/shared';
import { parse } from '../errors.js';
import { afterHoursLog, afterHoursOn, afterHoursState, setAfterHours } from '../services/afterHours.js';
import { requirePerm } from '../services/permissions.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import {
  inboxUnread,
  listInbox,
  listNotifications,
  markAllRead,
  markInbox,
  markMessageNoticesSeen,
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
  /** Elise 2026-11-16 · every work order, not only the person's jobs —
      honoured only while After hours is on for this page (a logged press). */
  after_hours: z.enum(['0', '1']).optional(),
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
    const all = q.after_hours === '1' && (await afterHoursOn(me.id, 'notifications'));
    return listInbox(me.id, {
      read: q.show,
      kinds: parseKinds(q.kinds),
      q: q.q?.trim() || null,
      before: q.before ?? null,
      limit: q.limit,
      withPulse: pulse,
      name: me.name,
      allWorkOrders: all,
    });
  });

  app.get('/notices/count', async (req) => ({
    unread: await inboxUnread(actingPrincipalFromRequest(req).id, await withPulse(req), actingPrincipalFromRequest(req).name),
  }));

  app.post('/notices/mark', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const body = parse(markSchema, req.body);
    const pulse = await withPulse(req);
    const changed = await markInbox(me.id, pulse, body);
    return { changed, unread: await inboxUnread(me.id, pulse, me.name) };
  });

  // Elise 2026-11-14: the Messages tab calls this with the messages it shows,
  // so a notice about one of them is read once the message has been seen.
  app.post('/notices/seen-messages', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const body = parse(
      z.object({ wo_number: z.string().min(1).max(120), message_ids: z.array(z.string().max(64)).max(1000) }),
      req.body,
    );
    const changed = await markMessageNoticesSeen(me.id, body.wo_number, body.message_ids);
    return { changed, unread: await inboxUnread(me.id, await withPulse(req), me.name) };
  });

  // ── After hours (Elise, 2026-11-16) ──────────────────────────────────────
  // The switch on Notifications and Approvals: shows every work order the
  // person may open, not only their own jobs. Each press is an audit row
  // (services/afterHours.ts); the log is for whoever reads Admin › Audit.
  app.get('/after-hours', async (req) => afterHoursState(actingPrincipalFromRequest(req).id));

  app.post('/after-hours', async (req) => {
    const body = parse(z.object({ page: z.enum(['notifications', 'approvals']), on: z.boolean() }), req.body);
    return setAfterHours(actingPrincipalFromRequest(req), body.page, body.on);
  });

  app.get('/after-hours/log', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), adminPermKey('audit'), 'view', 'The After hours log is not available to you');
    return { items: await afterHoursLog() };
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

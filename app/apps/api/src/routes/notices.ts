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
import {
  afterHoursLog,
  afterHoursState,
  onCallOverview,
  saveOnCallSettings,
  setAfterHours,
  syncOnCall,
} from '../services/afterHours.js';
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
  /** Kept for old tabs; ignored. Since 2026-11-17 the server decides: the
      person on call with After hours on sees every work order's notices. */
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
    const all = me.afterHoursWide === true;
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

  app.get('/notices/count', async (req) => {
    const me = actingPrincipalFromRequest(req);
    return { unread: await inboxUnread(me.id, await withPulse(req), me.name, me.afterHoursWide === true) };
  });

  app.post('/notices/mark', async (req) => {
    const me = actingPrincipalFromRequest(req);
    const body = parse(markSchema, req.body);
    const pulse = await withPulse(req);
    const changed = await markInbox(me.id, pulse, body);
    return { changed, unread: await inboxUnread(me.id, pulse, me.name, me.afterHoursWide === true) };
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
    return { changed, unread: await inboxUnread(me.id, await withPulse(req), me.name, me.afterHoursWide === true) };
  });

  // ── After hours (Elise, 2026-11-16; the header button since 2026-11-17) ──
  // Shown only to the AM / TL / ATL / OP Admin whose on-call shift is running
  // (services/afterHours.ts). GET re-reads the on-call sheet when it is stale.
  app.get('/after-hours', async (req) => afterHoursState(actingPrincipalFromRequest(req), { sync: true }));

  app.post('/after-hours', async (req) => {
    const body = parse(z.object({ on: z.boolean(), page: z.string().max(40).optional() }), req.body);
    return setAfterHours(actingPrincipalFromRequest(req), body.on);
  });

  app.get('/after-hours/log', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), adminPermKey('audit'), 'view', 'The After hours log is not available to you');
    return { items: await afterHoursLog() };
  });

  // Admin › Settings › On call: the sheet, the shift's hours, the roster read
  // from it and Sync now (grant admin/settings, as the other Settings cards).
  app.get('/admin/on-call', async (req) => {
    requirePerm(actingPrincipalFromRequest(req), adminPermKey('settings'), 'view', 'Admin › settings is not available to you');
    return onCallOverview();
  });

  app.put('/admin/on-call', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, adminPermKey('settings'), 'edit', 'You cannot make changes in Admin › settings');
    const body = parse(
      z.object({
        sheet: z.string().max(500).nullable(),
        tab: z.string().max(100).nullable(),
        start_hour: z.number().int().min(0).max(23),
        end_hour: z.number().int().min(1).max(24),
      }),
      req.body,
    );
    await saveOnCallSettings(actor, body);
    if (body.sheet?.trim()) await syncOnCall(actor);
    return onCallOverview();
  });

  app.post('/admin/on-call/sync', async (req) => {
    const actor = actingPrincipalFromRequest(req);
    requirePerm(actor, adminPermKey('settings'), 'edit', 'You cannot make changes in Admin › settings');
    await syncOnCall(actor);
    return onCallOverview();
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

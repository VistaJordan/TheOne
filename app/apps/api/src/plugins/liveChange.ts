// Live sync between accounts (migration 0126, Elise 2026-11-05).
//
// Every successful write request rings the doorbell: one `live_change` row
// with the browser tab that made it (x-obi-tab, sent by apps/web's request();
// NULL for a webhook). GET /activity/since tells every other open screen that
// something changed, and it re-reads what it shows through its own routes.
// This does not depend on the write logging an audit row, so a write that
// logs none still reaches the other screens.
//
// onSend, not onResponse: the handler (and its transaction) has finished, and
// the row is in before the reply leaves, so a frozen Vercel lambda cannot drop
// it. Never fails the request.

import type { FastifyInstance } from 'fastify';
import { query } from '../db.js';

/** Writes that change nothing anybody else is looking at. */
const QUIET_PREFIXES = [
  '/api/auth/',
  '/api/prefs/',
  '/api/notices/',
  '/api/assistant/',
  '/api/activity/',
  '/api/webhooks/clickup-sync',
];

const TAB_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Rows older than this are pruned now and then; a screen that slept longer
    re-reads on focus anyway. */
const KEEP = '1 hour';

export function liveChangeTab(header: unknown): string | null {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && TAB_RE.test(v) ? v : null;
}

export function isLiveWrite(method: string, url: string, status: number): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  if (status >= 400 || !url.startsWith('/api/')) return false;
  return !QUIET_PREFIXES.some((p) => url.startsWith(p));
}

export function installLiveChange(app: FastifyInstance): void {
  app.addHook('onSend', async (req, reply, payload) => {
    if (!isLiveWrite(req.method, req.url, reply.statusCode)) return payload;
    try {
      const r = await query<{ id: string }>(
        `INSERT INTO live_change (tab_id) VALUES ($1) RETURNING id`,
        [liveChangeTab(req.headers['x-obi-tab'])],
      );
      if (Number(r.rows[0]?.id) % 500 === 0) {
        await query(`DELETE FROM live_change WHERE created_at < now() - interval '${KEEP}'`);
      }
    } catch (err) {
      req.log.warn({ err }, 'live_change insert failed');
    }
    return payload;
  });
}

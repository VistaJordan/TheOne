// 0059 · In-app notifications: the rows behind the bell in the top bar.
//
// `notify` is called AFTER the act it reports has committed and never throws:
// a notice that fails to write must not undo, or fail, the thing it is about.
// The person who did the thing is never told about it.
//
// Nothing here sends an email (held on purpose).

import { VENDOR_REVIEW_PERM_KEY } from '@theone/shared';
import type { AppNotification, AppNotificationsResponse } from '@theone/shared';
import { query } from '../db.js';
import { notFound } from '../errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface NotifyInput {
  kind: string;
  title: string;
  body?: string | null;
  /** An in-app path, e.g. /vendors/<id>. */
  link?: string | null;
  /** Who did it — they are skipped if they are among the recipients. */
  actorId?: string | null;
}

export async function notify(principalIds: (string | null | undefined)[], n: NotifyInput): Promise<void> {
  const to = [...new Set(principalIds.filter((id): id is string => Boolean(id) && UUID_RE.test(id!) && id !== n.actorId))];
  if (to.length === 0) return;
  try {
    await query(
      `INSERT INTO app_notice (principal_id, kind, title, body, link, actor_id)
       SELECT p.id, $2, $3, $4, $5, $6
         FROM principal p
        WHERE p.id = ANY($1::uuid[]) AND p.kind = 'human' AND p.status <> 'disabled'`,
      [to, n.kind, n.title.slice(0, 300), n.body ? n.body.slice(0, 1000) : null, n.link ?? null, n.actorId ?? null],
    );
  } catch (err) {
    console.error('[notices] could not write a notification', err);
  }
}

/** Everyone who decides the vendor review queue: super admins, and people
 *  whose ROLE grants `vendors/review` approve. A per-person override is not
 *  read here — a notice going to one person too many or too few is harmless,
 *  and the queue itself is still gated properly. */
export async function vendorReviewerIds(): Promise<string[]> {
  const res = await query<{ id: string }>(
    `SELECT p.id::text AS id
       FROM principal p LEFT JOIN role r ON r.code = p.role
      WHERE p.kind = 'human' AND p.status <> 'disabled'
        AND (p.is_super_admin OR (r.permissions -> $1 ->> 'approve') = 'true')`,
    [VENDOR_REVIEW_PERM_KEY],
  );
  return res.rows.map((r) => r.id);
}

// ── Insurance dates ──────────────────────────────────────────────────────────
//
// There is no clock: the bell's own read raises these, at most once every few
// minutes per process. Each (date, band) is raised once per owner — the
// dedupe key makes every later run a no-op — so an owner hears about a date
// when it comes within 30 days, again within 14, and once more when it passes.

let lastExpirySweep = 0;
const EXPIRY_SWEEP_EVERY_MS = 10 * 60 * 1000;

export async function raiseExpiryNotifications(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastExpirySweep < EXPIRY_SWEEP_EVERY_MS) return;
  lastExpirySweep = now;
  try {
    await query(
      `WITH cur AS (
         SELECT DISTINCT ON (e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)))
                e.id, e.vendor_id, e.insurance_type, e.expires_on
           FROM vendor_expiry e
          ORDER BY e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)), e.expires_on DESC
       )
       INSERT INTO app_notice (principal_id, kind, title, link, dedupe_key)
       SELECT v.owner_id, 'vendor_expiry',
              v.name || ': ' || btrim(cur.insurance_type) ||
                CASE WHEN cur.expires_on < CURRENT_DATE THEN ' expired on ' ELSE ' expires on ' END ||
                to_char(cur.expires_on, 'Mon FMDD, YYYY'),
              '/vendors/' || v.id::text,
              'expiry:' || cur.id::text || ':' ||
                CASE WHEN cur.expires_on < CURRENT_DATE THEN 'expired'
                     WHEN cur.expires_on <= CURRENT_DATE + 14 THEN 'two_weeks'
                     ELSE 'month' END
         FROM cur
         JOIN vendor v ON v.id = cur.vendor_id
         JOIN principal p ON p.id = v.owner_id
        WHERE v.deleted_at IS NULL AND p.kind = 'human' AND p.status <> 'disabled'
          AND cur.expires_on <= CURRENT_DATE + 30
       ON CONFLICT (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    );
  } catch (err) {
    console.error('[notices] expiry sweep failed', err);
  }
}

// ── The bell ─────────────────────────────────────────────────────────────────

type Row = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  a_id: string | null;
  a_name: string | null;
  a_kind: 'human' | 'service' | null;
  read_at: Date | null;
  created_at: Date;
};

export async function listNotifications(principalId: string): Promise<AppNotificationsResponse> {
  await raiseExpiryNotifications();
  const [rows, unread] = await Promise.all([
    query<Row>(
      `SELECT n.id::text AS id, n.kind, n.title, n.body, n.link,
              a.id::text AS a_id, a.display_name AS a_name, a.kind AS a_kind, n.read_at, n.created_at
         FROM app_notice n LEFT JOIN principal a ON a.id = n.actor_id
        WHERE n.principal_id = $1
        ORDER BY (n.read_at IS NOT NULL), n.created_at DESC
        LIMIT 60`,
      [principalId],
    ),
    unreadCount(principalId, true),
  ]);
  const items: AppNotification[] = rows.rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.link,
    actor: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Unknown', kind: r.a_kind ?? 'human' } : null,
    read: r.read_at !== null,
    created_at: r.created_at.toISOString(),
  }));
  return { items, unread };
}

export async function unreadCount(principalId: string, skipSweep = false): Promise<number> {
  if (!skipSweep) await raiseExpiryNotifications();
  const res = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM app_notice WHERE principal_id = $1 AND read_at IS NULL`,
    [principalId],
  );
  return res.rows[0]?.n ?? 0;
}

export async function markRead(principalId: string, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw notFound('Notification not found');
  await query(`UPDATE app_notice SET read_at = now() WHERE id = $1 AND principal_id = $2 AND read_at IS NULL`, [id, principalId]);
}

export async function markAllRead(principalId: string): Promise<void> {
  await query(`UPDATE app_notice SET read_at = now() WHERE principal_id = $1 AND read_at IS NULL`, [principalId]);
}

/** Read notices older than 60 days go; unread ones stay until they are read. */
export async function pruneNotifications(principalId: string): Promise<void> {
  await query(
    `DELETE FROM app_notice WHERE principal_id = $1 AND read_at IS NOT NULL AND created_at < now() - interval '60 days'`,
    [principalId],
  );
}

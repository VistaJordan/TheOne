// 0059 · In-app notifications: the rows behind the bell in the top bar.
//
// `notify` is called AFTER the act it reports has committed and never throws:
// a notice that fails to write must not undo, or fail, the thing it is about.
// The person who did the thing is never told about it.
//
// Nothing here sends an email (held on purpose).

import { PULSE_NOTICE_PREFIX, VENDOR_REVIEW_PERM_KEY, parseNoticeCursor } from '@theone/shared';
import type {
  AppNotification,
  AppNotificationsResponse,
  NoticeInboxItem,
  NoticeInboxResponse,
  NoticeReadFilter,
  NoticeSource,
  WoNotification,
  WoNotificationsResponse,
} from '@theone/shared';
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
  /** One notice per person per key (0059's unique index): a second call
      with the same key writes nothing. */
  dedupeKey?: string | null;
}

export async function notify(principalIds: (string | null | undefined)[], n: NotifyInput): Promise<void> {
  const to = [...new Set(principalIds.filter((id): id is string => Boolean(id) && UUID_RE.test(id!) && id !== n.actorId))];
  if (to.length === 0) return;
  try {
    await query(
      `INSERT INTO app_notice (principal_id, kind, title, body, link, actor_id, dedupe_key)
       SELECT p.id, $2, $3, $4, $5, $6, $7
         FROM principal p
        WHERE p.id = ANY($1::uuid[]) AND p.kind = 'human' AND p.status <> 'disabled'
       ON CONFLICT (principal_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [to, n.kind, n.title.slice(0, 300), n.body ? n.body.slice(0, 1000) : null, n.link ?? null, n.actorId ?? null, n.dedupeKey ?? null],
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

// ── The Notifications page (2026-11-04) ─────────────────────────────────────
//
// One inbox over two tables: the person's `app_notice` rows and, when they
// hold the Pulse (the route decides `withPulse`), the Pulse's pings
// (`notification`), whose kind is `pulse.<rule_key>`. Both are the person's
// own rows; nothing here takes another principal's id. Read and unread are
// both settable: unread is `read_at` back to NULL.

const INBOX_CTE = `WITH inbox AS (
  SELECT 'notice'::text AS source, n.id::text AS id, n.kind, n.title, n.body, n.link,
         n.actor_id, NULL::text AS wo_number, NULL::int AS tier, n.read_at, n.created_at
    FROM app_notice n
   WHERE n.principal_id = $1
  UNION ALL
  SELECT 'pulse', n.id::text, '${PULSE_NOTICE_PREFIX}' || o.rule_key, n.title, n.body, NULL,
         NULL, n.wo_number, n.tier, n.read_at, n.created_at
    FROM notification n JOIN obligation o ON o.id = n.obligation_id
   WHERE $2::boolean AND n.principal_id = $1
)`;

export interface InboxOptions {
  read: NoticeReadFilter;
  /** null = every type. */
  kinds: string[] | null;
  q: string | null;
  before: string | null;
  limit: number;
  withPulse: boolean;
}

type InboxRow = {
  source: NoticeSource;
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  wo_number: string | null;
  tier: number | null;
  a_id: string | null;
  a_name: string | null;
  a_kind: 'human' | 'service' | null;
  read_at: Date | null;
  created_at: Date;
  at_us: string;
};

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The filter half every inbox query shares, from parameter `$3` on. */
function inboxFilter(o: Pick<InboxOptions, 'read' | 'kinds' | 'q'>, params: unknown[]): string {
  const where: string[] = [];
  if (o.read === 'unread') where.push('read_at IS NULL');
  if (o.read === 'read') where.push('read_at IS NOT NULL');
  if (o.kinds) {
    params.push(o.kinds);
    where.push(`kind = ANY($${params.length}::text[])`);
  }
  if (o.q) {
    params.push(likePattern(o.q));
    const p = `$${params.length}`;
    where.push(`(title ILIKE ${p} OR COALESCE(body, '') ILIKE ${p} OR COALESCE(wo_number, '') ILIKE ${p})`);
  }
  return where.length ? `WHERE ${where.join(' AND ')}` : '';
}

export async function listInbox(principalId: string, o: InboxOptions): Promise<NoticeInboxResponse> {
  await raiseExpiryNotifications();
  const base: unknown[] = [principalId, o.withPulse];

  const listParams = [...base];
  let where = inboxFilter(o, listParams);
  const cursor = parseNoticeCursor(o.before);
  if (cursor) {
    listParams.push(cursor.at, cursor.key);
    const c = `(created_at, source || ':' || id) < ($${listParams.length - 1}::timestamptz, $${listParams.length})`;
    where = where ? `${where} AND ${c}` : `WHERE ${c}`;
  }
  listParams.push(o.limit + 1);

  const countParams = [...base];
  const countWhere = inboxFilter(o, countParams);

  const [rows, matching, types] = await Promise.all([
    query<InboxRow>(
      `${INBOX_CTE}, page AS (
         SELECT * FROM inbox
         ${where}
         ORDER BY created_at DESC, source || ':' || id DESC
         LIMIT $${listParams.length}
       )
       SELECT x.source, x.id, x.kind, x.title, x.body, x.link, x.wo_number, x.tier,
              a.id::text AS a_id, a.display_name AS a_name, a.kind AS a_kind, x.read_at, x.created_at,
              to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at_us
         FROM page x LEFT JOIN principal a ON a.id = x.actor_id
        ORDER BY x.created_at DESC, x.source || ':' || x.id DESC`,
      listParams,
    ),
    query<{ n: number }>(`${INBOX_CTE} SELECT count(*)::int AS n FROM inbox ${countWhere}`, countParams),
    query<{ kind: string; total: number; unread: number }>(
      `${INBOX_CTE}
       SELECT kind, count(*)::int AS total, count(*) FILTER (WHERE read_at IS NULL)::int AS unread
         FROM inbox GROUP BY kind ORDER BY kind`,
      base,
    ),
  ]);

  const more = rows.rows.length > o.limit;
  const page = more ? rows.rows.slice(0, o.limit) : rows.rows;
  const items: NoticeInboxItem[] = page.map((r) => ({
    source: r.source,
    id: r.id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    link: r.source === 'pulse' ? (r.wo_number ? `/work-orders/${encodeURIComponent(r.wo_number)}` : '/pulse') : r.link,
    actor: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Unknown', kind: r.a_kind ?? 'human' } : null,
    wo_number: r.wo_number,
    tier: r.tier,
    read: r.read_at !== null,
    created_at: r.created_at.toISOString(),
  }));
  const last = page[page.length - 1];
  return {
    items,
    matching: matching.rows[0]?.n ?? 0,
    unread: types.rows.reduce((n, t) => n + t.unread, 0),
    total: types.rows.reduce((n, t) => n + t.total, 0),
    types: types.rows,
    next_before: more && last ? `${last.at_us}|${last.source}:${last.id}` : null,
    includes_pulse: o.withPulse,
  };
}

/** The sidebar badge: every unread row of the inbox. */
export async function inboxUnread(principalId: string, withPulse: boolean): Promise<number> {
  await raiseExpiryNotifications();
  const res = await query<{ n: number }>(
    `SELECT ((SELECT count(*) FROM app_notice WHERE principal_id = $1 AND read_at IS NULL)
           + (CASE WHEN $2::boolean
                   THEN (SELECT count(*) FROM notification WHERE principal_id = $1 AND read_at IS NULL)
                   ELSE 0 END))::int AS n`,
    [principalId, withPulse],
  );
  return res.rows[0]?.n ?? 0;
}

export interface MarkInboxInput {
  read: boolean;
  /** These rows; absent = every row of `kinds` (absent too = everything). */
  items?: { source: NoticeSource; id: string }[];
  kinds?: string[] | null;
}

/** Marks rows read or unread; answers how many changed. Only rows whose state
    differs are touched, so a row read last week keeps its read time. */
export async function markInbox(principalId: string, withPulse: boolean, input: MarkInboxInput): Promise<number> {
  const set = input.read ? 'now()' : 'NULL';
  const differs = input.read ? 'read_at IS NULL' : 'read_at IS NOT NULL';
  let changed = 0;
  if (input.items) {
    const ids = (source: NoticeSource) => input.items!.filter((i) => i.source === source && UUID_RE.test(i.id)).map((i) => i.id);
    const notices = ids('notice');
    const pings = withPulse ? ids('pulse') : [];
    if (notices.length) {
      const r = await query(`UPDATE app_notice SET read_at = ${set} WHERE principal_id = $1 AND id = ANY($2::uuid[]) AND ${differs}`, [principalId, notices]);
      changed += r.rowCount ?? 0;
    }
    if (pings.length) {
      const r = await query(`UPDATE notification SET read_at = ${set} WHERE principal_id = $1 AND id = ANY($2::uuid[]) AND ${differs}`, [principalId, pings]);
      changed += r.rowCount ?? 0;
    }
    return changed;
  }
  const kinds = input.kinds ?? null;
  const noticeKinds = kinds?.filter((k) => !k.startsWith(PULSE_NOTICE_PREFIX)) ?? null;
  const rules = kinds?.filter((k) => k.startsWith(PULSE_NOTICE_PREFIX)).map((k) => k.slice(PULSE_NOTICE_PREFIX.length)) ?? null;
  if (noticeKinds === null || noticeKinds.length > 0) {
    const r = await query(
      `UPDATE app_notice SET read_at = ${set}
        WHERE principal_id = $1 AND ${differs} AND ($2::text[] IS NULL OR kind = ANY($2::text[]))`,
      [principalId, noticeKinds],
    );
    changed += r.rowCount ?? 0;
  }
  if (withPulse && (rules === null || rules.length > 0)) {
    const r = await query(
      `UPDATE notification n SET read_at = ${set}
         FROM obligation o
        WHERE o.id = n.obligation_id AND n.principal_id = $1 AND n.${differs}
          AND ($2::text[] IS NULL OR o.rule_key = ANY($2::text[]))`,
      [principalId, rules],
    );
    changed += r.rowCount ?? 0;
  }
  return changed;
}

// ── A message seen is a notice read (Elise, 2026-11-14) ─────────────────────
//
// Opening the Messages tab on a work order marks read the person's own notices
// that point at a message it is showing (a mention, a message on a work order
// they hold — every such link is `/work-orders/<WO #>?tab=messages&msg=<id>`),
// so they leave the Unread view of Notifications without a second click.

/** Marks read the unread notices of `principalId` whose link names one of
    these messages on this work order. Returns how many changed. */
export async function markMessageNoticesSeen(principalId: string, woNumber: string, messageIds: readonly string[]): Promise<number> {
  const ids = messageIds.filter((id) => UUID_RE.test(id));
  if (ids.length === 0) return 0;
  const links = ids.map((id) => `/work-orders/${encodeURIComponent(woNumber)}?tab=messages&msg=${id}`);
  const r = await query(
    `UPDATE app_notice SET read_at = now()
      WHERE principal_id = $1 AND read_at IS NULL AND link = ANY($2::text[])`,
    [principalId, links],
  );
  return r.rowCount ?? 0;
}

// ── One work order's notifications (2026-11-02) ─────────────────────────────
//
// The work order's Notifications tab: every notice raised ABOUT it, to
// whoever got it — the bell's own rows (`app_notice`, matched by their link,
// which every work-order notice points at `/work-orders/<WO #>`, with or
// without `?tab=…`) and the Pulse's escalation pings (`notification`, through
// their obligation's work order). The route has already resolved the work
// order through the viewer's scope; a notice that points at a tab the viewer
// may not open is left out by the caller (`canOpenLink`).

const WO_NOTICE_LIMIT = 300;

type WoNoticeRow = {
  id: string;
  source: 'notice' | 'pulse';
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  r_id: string;
  r_name: string | null;
  a_id: string | null;
  a_name: string | null;
  read_at: Date | null;
  created_at: Date;
};

export async function listWorkOrderNotices(
  taskId: string,
  woNumber: string,
  canOpenLink: (link: string | null) => boolean,
): Promise<WoNotificationsResponse> {
  const base = `/work-orders/${encodeURIComponent(woNumber)}`;
  const res = await query<WoNoticeRow>(
    `SELECT * FROM (
       SELECT n.id::text AS id, 'notice' AS source, n.kind, n.title, n.body, n.link,
              r.id::text AS r_id, r.display_name AS r_name,
              a.id::text AS a_id, a.display_name AS a_name, n.read_at, n.created_at
         FROM app_notice n
         JOIN principal r ON r.id = n.principal_id
         LEFT JOIN principal a ON a.id = n.actor_id
        WHERE n.link = $1 OR left(n.link, length($1) + 1) IN ($1 || '?', $1 || '#')
       UNION ALL
       SELECT n.id::text, 'pulse', o.rule_key, n.title, n.body, $1,
              r.id::text, r.display_name, NULL, NULL, n.read_at, n.created_at
         FROM notification n
         JOIN obligation o ON o.id = n.obligation_id
         JOIN principal r ON r.id = n.principal_id
        WHERE o.task_id = $2
     ) x
     ORDER BY created_at DESC
     LIMIT ${WO_NOTICE_LIMIT}`,
    [base, taskId],
  );
  const items: WoNotification[] = res.rows
    .filter((r) => canOpenLink(r.link))
    .map((r) => ({
      id: r.id,
      source: r.source,
      kind: r.kind,
      title: r.title,
      body: r.body,
      link: r.link,
      recipient: { id: r.r_id, name: r.r_name ?? 'Unknown' },
      actor: r.a_id ? { id: r.a_id, name: r.a_name ?? 'Unknown' } : null,
      read: r.read_at !== null,
      read_at: r.read_at ? r.read_at.toISOString() : null,
      created_at: r.created_at.toISOString(),
    }));
  return { items };
}

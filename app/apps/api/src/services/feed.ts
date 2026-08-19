// Feed service (S2 contract items 1 & 2).
//
// The feed is ONE newest-first stream merged from two tables:
//   comment                          → { type:'comment' }
//   activity_log action='status_changed' → { type:'status_changed' }
//   activity_log action='created'        → { type:'created' }  (seeded per WO)
// The merge is done SQL-side with a UNION ALL so ordering and paging are the
// database's job, not JavaScript's. Other activity actions (e.g. the
// 'comment_added' audit row written alongside every comment) are deliberately
// NOT surfaced — the comment itself is the feed item; the log row is audit.

import { query, withTransaction } from '../db.js';
import type { FeedItem, FeedComment, FeedResponse, FeedActor } from '@theone/shared';
import { ApiError } from '../errors.js';

// Same ISO-8601 UTC rendering the S1 activity endpoint uses, so every timestamp
// the API emits is byte-identical in shape regardless of PGlite's date parsing.
const ISO = (col: string) =>
  `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

interface FeedRow {
  type: 'comment' | 'status_changed' | 'created';
  id: string;
  body: string | null;
  client_visible: boolean | null;
  actor_id: string;
  actor_name: string;
  actor_kind: 'human' | 'service';
  before_status: string | null;
  after_status: string | null;
  via: string | null;
  created_at: string;
}

function mapFeedRow(r: FeedRow): FeedItem {
  const actor: FeedActor = { id: r.actor_id, name: r.actor_name, kind: r.actor_kind };
  if (r.type === 'comment') {
    return {
      type: 'comment',
      id: r.id,
      author: actor,
      client_visible: r.client_visible === true,
      body: r.body ?? '',
      created_at: r.created_at,
    };
  }
  if (r.type === 'status_changed') {
    return {
      type: 'status_changed',
      id: r.id,
      actor,
      before: { status_name: r.before_status },
      after: { status_name: r.after_status },
      created_at: r.created_at,
    };
  }
  return { type: 'created', id: r.id, actor, via: r.via, created_at: r.created_at };
}

// `sort_key` is the tiebreaker within an identical timestamp: activity rows use
// their monotonic bigint id, comments sort after any activity row stamped at the
// same instant (a comment's own 'comment_added' audit row shares its timestamp,
// but that row is filtered out anyway).
const FEED_SQL = `
  SELECT * FROM (
    SELECT 'comment'::text                AS type,
           c.id::text                     AS id,
           c.body                         AS body,
           c.client_visible               AS client_visible,
           p.id                           AS actor_id,
           p.display_name                 AS actor_name,
           p.kind::text                   AS actor_kind,
           NULL::text                     AS before_status,
           NULL::text                     AS after_status,
           NULL::text                     AS via,
           c.created_at                   AS created_ts,
           0::bigint                      AS sort_key,
           ${ISO('c.created_at')}         AS created_at
      FROM comment c
      JOIN principal p ON p.id = c.author_principal_id
     WHERE c.task_id = $1
    UNION ALL
    SELECT a.action::text,
           a.id::text,
           NULL::text,
           NULL::boolean,
           p.id,
           p.display_name,
           p.kind::text,
           a.before ->> 'status_name',
           a.after  ->> 'status_name',
           COALESCE(a.after ->> 'via', a.after ->> 'source'),
           a.created_at,
           a.id,
           ${ISO('a.created_at')}
      FROM activity_log a
      JOIN principal p ON p.id = a.actor_principal_id
     WHERE a.entity_type = 'task'
       AND a.entity_id = $1
       AND a.action IN ('status_changed', 'created')
  ) f
  ORDER BY f.created_ts DESC, f.sort_key DESC
`;

/** A work order's merged feed, newest-first. */
export async function getFeed(taskId: string): Promise<FeedResponse> {
  const res = await query<FeedRow>(FEED_SQL, [taskId]);
  const items = res.rows.map(mapFeedRow);
  return { items, total: items.length };
}

/**
 * Post a comment (S2 contract item 2). In ONE transaction: insert the comment
 * and an `activity_log` row `action='comment_added'` with
 * `after = {comment_id, client_visible}` — the audit trail never misses a write.
 * Returns the created feed item.
 *
 * The actor MUST be resolved before the transaction opens: PGlite is
 * single-connection, so a non-transactional query() issued inside
 * db.transaction() queues behind it and self-deadlocks (same note as S1's
 * changeStatus).
 */
export async function addComment(
  taskId: string,
  body: string,
  clientVisible: boolean,
  actor: FeedActor,
): Promise<FeedComment> {
  let created: { id: string; created_at: string } | null = null;

  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string; created_at: string }>(
      `INSERT INTO comment (task_id, author_principal_id, body, client_visible)
       VALUES ($1, $2, $3, $4)
       RETURNING id::text AS id, ${ISO('created_at')} AS created_at`,
      [taskId, actor.id, body, clientVisible],
    );
    const row = ins.rows[0];

    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
      [
        actor.id,
        taskId,
        JSON.stringify({ comment_id: row.id, client_visible: clientVisible }),
      ],
    );

    created = row;
  });

  if (!created) throw new ApiError('INTERNAL', 'Comment insert produced no row');
  const row = created as { id: string; created_at: string };

  return {
    type: 'comment',
    id: row.id,
    author: actor,
    client_visible: clientVisible,
    body,
    created_at: row.created_at,
  };
}

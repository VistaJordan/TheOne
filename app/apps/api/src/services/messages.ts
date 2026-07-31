// Messages service (S3) — the Quo (OpenPhone) conversation mirror.
//
// A work order reaches its conversation through the VENDOR it is linked to:
//     task → payable.vendor_id → vendor → quo_conversation.vendor_id
// That is the prototype's correlation rule (product/quotes-payments.md §5: the
// real pipe correlates on the tech's phone number; the payable link is how the
// seed expresses "this tech is on this WO" until vendors are a first-class
// module). Only WO-39403 is seeded with a tech payable pointing at a
// conversation, so every other WO resolves `conversation: null`.
//
// The thread is ONE oldest-first stream merged from three tables (calls,
// messages, job segments) with a UNION ALL, so ordering is the database's job.
// Oldest-first — unlike the feed — because a chat log reads DOWN the page.

import { query, getDb } from '../db.js';
import type {
  Conversation,
  MessagesResponse,
  ThreadItem,
  ThreadMessage,
  QuoDirection,
  QuoMedia,
  QuoTranscriptLine,
  FeedActor,
} from '@theone/shared';
import { ApiError } from '../errors.js';

// Same ISO-8601 UTC rendering every other endpoint uses (§5 / feed.ts).
const ISO = (col: string) =>
  `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ── Conversation ─────────────────────────────────────────────────────────────

interface ConversationRow {
  id: string;
  quo_line_label: string | null;
  claimed_by: string | null;
  vendor_id: string;
  vendor_name: string;
  vendor_phone: string | null;
  vendor_trades: string[] | string | null;
}

/** text[] comes back as a JS array from PGlite; tolerate the `{a,b}` literal too. */
function toTrades(v: string[] | string | null): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    const inner = v.replace(/^\{|\}$/g, '');
    return inner.length === 0 ? [] : inner.split(',').map((s) => s.replace(/^"|"$/g, ''));
  }
  return [];
}

const CONVERSATION_SQL = `
  SELECT c.id::text        AS id,
         c.quo_line_label  AS quo_line_label,
         c.claimed_by      AS claimed_by,
         v.id::text        AS vendor_id,
         v.name            AS vendor_name,
         v.phone           AS vendor_phone,
         v.trades          AS vendor_trades
    FROM quo_conversation c
    JOIN vendor v ON v.id = c.vendor_id
   WHERE c.vendor_id IN (
           SELECT p.vendor_id FROM payable p
            WHERE p.task_id = $1 AND p.vendor_id IS NOT NULL
         )
   ORDER BY c.created_at ASC
   LIMIT 1
`;

interface StatsRow {
  calls: number | string;
  texts: number | string;
  photos: number | string;
  first_contact: string | null;
  last_activity: string | null;
}

// `texts` counts every message row and `photos` every media attachment — the
// arithmetic the approved comp's right rail uses (an MMS is a text that carries
// photos, not a separate species).
const STATS_SQL = `
  SELECT (SELECT count(*) FROM quo_call    WHERE conversation_id = $1)                       AS calls,
         (SELECT count(*) FROM quo_message WHERE conversation_id = $1)                       AS texts,
         (SELECT COALESCE(sum(jsonb_array_length(media)), 0)
            FROM quo_message WHERE conversation_id = $1)                                     AS photos,
         ${ISO('t.first_contact')} AS first_contact,
         ${ISO('t.last_activity')} AS last_activity
    FROM (
      SELECT min(occurred_at) AS first_contact, max(occurred_at) AS last_activity
        FROM (
          SELECT occurred_at FROM quo_call    WHERE conversation_id = $1
          UNION ALL
          SELECT occurred_at FROM quo_message WHERE conversation_id = $1
        ) e
    ) t
`;

/** The conversation linked to a task, or null when no Quo line is correlated. */
async function loadConversation(taskId: string): Promise<Conversation | null> {
  const res = await query<ConversationRow>(CONVERSATION_SQL, [taskId]);
  if (res.rows.length === 0) return null;
  const c = res.rows[0];

  const stats = (await query<StatsRow>(STATS_SQL, [c.id])).rows[0];

  return {
    id: c.id,
    vendor: {
      id: c.vendor_id,
      name: c.vendor_name,
      phone: c.vendor_phone,
      trades: toTrades(c.vendor_trades),
    },
    quo_line_label: c.quo_line_label,
    claimed_by: c.claimed_by,
    counts: {
      calls: Number(stats?.calls ?? 0),
      texts: Number(stats?.texts ?? 0),
      photos: Number(stats?.photos ?? 0),
    },
    first_contact: stats?.first_contact ?? null,
    last_activity: stats?.last_activity ?? null,
  };
}

// ── Thread ───────────────────────────────────────────────────────────────────

interface ThreadRow {
  type: 'segment' | 'call' | 'message';
  id: string;
  direction: QuoDirection | null;
  duration_seconds: number | string | null;
  ai_summary: string | null;
  transcript: QuoTranscriptLine[] | null;
  body: string | null;
  media: QuoMedia[] | null;
  delivered: boolean | null;
  pending_sync: boolean | null;
  label: string | null;
  occurred_at: string;
}

// `rank` only breaks ties at an identical instant: a segment marker opens the
// span it labels, so it sorts ahead of the call/message stamped with it.
const THREAD_SQL = `
  SELECT * FROM (
    SELECT 'segment'::text   AS type,
           s.id::text        AS id,
           NULL::text        AS direction,
           NULL::int         AS duration_seconds,
           NULL::text        AS ai_summary,
           NULL::jsonb       AS transcript,
           NULL::text        AS body,
           NULL::jsonb       AS media,
           NULL::boolean     AS delivered,
           NULL::boolean     AS pending_sync,
           s.label           AS label,
           s.started_at      AS occurred_ts,
           0                 AS rank,
           ${ISO('s.started_at')} AS occurred_at
      FROM quo_job_segment s
     WHERE s.conversation_id = $1
    UNION ALL
    SELECT 'call', c.id::text, c.direction, c.duration_seconds, c.ai_summary, c.transcript,
           NULL, NULL, NULL, NULL, NULL,
           c.occurred_at, 1, ${ISO('c.occurred_at')}
      FROM quo_call c
     WHERE c.conversation_id = $1
    UNION ALL
    SELECT 'message', m.id::text, m.direction, NULL, NULL, NULL,
           m.body, m.media, m.delivered, m.pending_sync, NULL,
           m.occurred_at, 2, ${ISO('m.occurred_at')}
      FROM quo_message m
     WHERE m.conversation_id = $1
  ) t
  ORDER BY t.occurred_ts ASC, t.rank ASC, t.id ASC
`;

function mapThreadRow(r: ThreadRow): ThreadItem {
  if (r.type === 'segment') {
    return {
      type: 'segment',
      id: r.id,
      label: r.label ?? '',
      started_at: r.occurred_at,
      occurred_at: r.occurred_at,
    };
  }
  if (r.type === 'call') {
    return {
      type: 'call',
      id: r.id,
      direction: r.direction === 'out' ? 'out' : 'in',
      duration_seconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
      ai_summary: r.ai_summary,
      transcript: Array.isArray(r.transcript) ? r.transcript : [],
      occurred_at: r.occurred_at,
    };
  }
  return {
    type: 'message',
    id: r.id,
    direction: r.direction === 'out' ? 'out' : 'in',
    body: r.body ?? '',
    media: Array.isArray(r.media) ? r.media : [],
    delivered: r.delivered === true,
    pending_sync: r.pending_sync === true,
    occurred_at: r.occurred_at,
  };
}

/** GET /api/work-orders/:id/messages — conversation + oldest-first thread. */
export async function getMessages(taskId: string): Promise<MessagesResponse> {
  const conversation = await loadConversation(taskId);
  if (!conversation) return { conversation: null, items: [] };
  const res = await query<ThreadRow>(THREAD_SQL, [conversation.id]);
  return { conversation, items: res.rows.map(mapThreadRow) };
}

/** The conversation id linked to a task, or null. Used by the POST path. */
export async function resolveConversationId(taskId: string): Promise<string | null> {
  const res = await query<{ id: string }>(CONVERSATION_SQL, [taskId]);
  return res.rows.length > 0 ? res.rows[0].id : null;
}

// ── Local send (S3 write path) ───────────────────────────────────────────────

/**
 * Send a text from The One. In ONE transaction: insert an outbound quo_message
 * (`pending_sync=true`, `delivered=false` — nothing is on the wire until the
 * real Quo pipe takes over) and an `activity_log` row
 * `action='tech_message_sent'`, so the audit trail never misses a write.
 *
 * The actor MUST be resolved before the transaction opens: PGlite is
 * single-connection, so a non-transactional query() issued inside
 * db.transaction() queues behind it and self-deadlocks (same note as S1's
 * changeStatus and S2's addComment).
 */
export async function sendMessage(
  taskId: string,
  conversationId: string,
  body: string,
  actor: FeedActor,
): Promise<ThreadMessage> {
  const db = getDb();
  let created: { id: string; occurred_at: string } | null = null;

  await db.transaction(async (tx) => {
    const ins = await tx.query<{ id: string; occurred_at: string }>(
      `INSERT INTO quo_message
         (conversation_id, direction, body, media, delivered, pending_sync)
       VALUES ($1, 'out', $2, '[]'::jsonb, false, true)
       RETURNING id::text AS id, ${ISO('occurred_at')} AS occurred_at`,
      [conversationId, body],
    );
    const row = ins.rows[0];

    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'tech_message_sent', NULL, NULL, $3::jsonb)`,
      [
        actor.id,
        taskId,
        JSON.stringify({ message_id: row.id, conversation_id: conversationId, body }),
      ],
    );

    created = row;
  });

  if (!created) throw new ApiError('INTERNAL', 'Message insert produced no row');
  const row = created as { id: string; occurred_at: string };

  return {
    type: 'message',
    id: row.id,
    direction: 'out',
    body,
    media: [],
    delivered: false,
    pending_sync: true,
    occurred_at: row.occurred_at,
  };
}

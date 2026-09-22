// Messages on a work order (migration 0052) — the Messages tab's own thread.
//
// A message is a `comment` row: internal (the team) or client-visible. A
// client-visible one on a work order linked to a client CMMS (`Client Portal
// Type`) gets one pending `comment_delivery` row for that system — the outbox
// the integration adapters flip to sent. Nothing sends today (no adapter is
// registered, see modules/integrations/clientMessages.ts), so every delivery
// sits at pending and the tab says so honestly.
//
// Rules: a message may be edited by its author only while no client system
// has accepted it (any `sent` delivery locks it, for good); a client-sourced
// message (source = 'client', written on their side) is never editable here.
//
// Every write lands in activity_log: comment_added (the post, as before),
// message_edited (before/after body and visibility), client_message_sent /
// client_message_failed (a delivery flipping), client_message_received (an
// inbound note). The actor is resolved BEFORE any transaction opens —
// PGlite is single-connection (see feed.ts / messages.ts).

import { query, withTransaction } from '../db.js';
import { ApiError } from '../errors.js';
import {
  CLIENT_MESSAGE_TARGET_LABELS,
  CLIENT_PORTAL_TYPE_KEY,
  ECOTRAK_ID_KEY,
  MESSAGE_PERM_KEY,
  clientMessageTarget,
  messageEditableBy,
  messageIsSent,
} from '@theone/shared';
import type {
  ClientMessageTarget,
  ClientSystem,
  FeedActor,
  MessageDelivery,
  WoMessage,
  WoMessagesResponse,
} from '@theone/shared';
import type { ActingPrincipal } from './activity.js';
import type { Allow } from './permissions.js';
import { getMessages as getQuoMessages } from './messages.js';
import { clientMessageAdapter, clientWriteEnabled } from '../modules/integrations/clientMessages.js';
import { serviceActorId } from './serviceActors.js';

const ISO = (col: string) =>
  `to_char((${col} AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// ── The client system a work order is linked to ─────────────────────────────

interface LinkRow {
  wo_number: string;
  portal: string | null;
  ecotrak_id: string | null;
}

async function loadLink(taskId: string): Promise<{ target: ClientMessageTarget | null; row: LinkRow } | null> {
  const res = await query<LinkRow>(
    `SELECT t.wo_number            AS wo_number,
            t.fields ->> $2        AS portal,
            t.fields ->> $3        AS ecotrak_id
       FROM task t
      WHERE t.id = $1`,
    [taskId, CLIENT_PORTAL_TYPE_KEY, ECOTRAK_ID_KEY],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { target: clientMessageTarget(row.portal), row };
}

function describeSystem(target: ClientMessageTarget | null): ClientSystem | null {
  if (!target) return null;
  return { target, label: CLIENT_MESSAGE_TARGET_LABELS[target], write_enabled: clientWriteEnabled(target) };
}

// ── Reading the thread ───────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  source: 'staff' | 'client';
  body: string;
  client_visible: boolean;
  external_author: string | null;
  author_id: string | null;
  author_name: string | null;
  author_kind: 'human' | 'service' | null;
  edited_at: string | null;
  created_at: string;
  deliveries: MessageDelivery[] | string | null;
}

const MESSAGE_SELECT = `
  SELECT c.id::text                AS id,
         c.source                  AS source,
         c.body                    AS body,
         c.client_visible          AS client_visible,
         c.external_author         AS external_author,
         p.id::text                AS author_id,
         p.display_name            AS author_name,
         p.kind::text              AS author_kind,
         ${ISO('c.edited_at')}     AS edited_at,
         ${ISO('c.created_at')}    AS created_at,
         COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
                    'target',      d.target,
                    'status',      d.status,
                    'external_id', d.external_id,
                    'error',       d.error,
                    'attempts',    d.attempts,
                    'sent_at',     ${ISO('d.sent_at')},
                    'updated_at',  ${ISO('d.updated_at')}
                  ) ORDER BY d.created_at)
             FROM comment_delivery d
            WHERE d.comment_id = c.id
         ), '[]'::jsonb)           AS deliveries
    FROM comment c
    LEFT JOIN principal p ON p.id = c.author_principal_id
`;

function toDeliveries(v: MessageRow['deliveries']): MessageDelivery[] {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { return JSON.parse(v) as MessageDelivery[]; } catch { return []; }
  }
  return [];
}

function mapRow(r: MessageRow, actor: ActingPrincipal, mayEdit: boolean): WoMessage {
  const author: FeedActor | null =
    r.author_id && r.author_name
      ? { id: r.author_id, name: r.author_name, kind: r.author_kind ?? 'human' }
      : null;
  const deliveries = toDeliveries(r.deliveries);
  const base = {
    id: r.id,
    source: r.source,
    author,
    external_author: r.external_author,
    client_visible: r.client_visible === true,
    body: r.body ?? '',
    created_at: r.created_at,
    edited_at: r.edited_at,
    deliveries,
  };
  return {
    ...base,
    sent: messageIsSent(deliveries),
    editable: messageEditableBy(base, actor.id, mayEdit),
  };
}

/** GET /work-orders/:id/messages — oldest-first thread, the client system,
 *  and the Quo technician thread the tab also draws. */
export async function listMessages(
  taskId: string,
  actor: ActingPrincipal,
  allow: Allow,
): Promise<WoMessagesResponse> {
  const mayEdit = allow(MESSAGE_PERM_KEY, 'edit');
  const res = await query<MessageRow>(
    `${MESSAGE_SELECT} WHERE c.task_id = $1 ORDER BY c.created_at ASC, c.id ASC`,
    [taskId],
  );
  const link = await loadLink(taskId);
  const quo = await getQuoMessages(taskId);
  return {
    items: res.rows.map((r) => mapRow(r, actor, mayEdit)),
    client_system: describeSystem(link?.target ?? null),
    quo,
  };
}

async function loadMessage(
  taskId: string,
  messageId: string,
  actor: ActingPrincipal,
  allow: Allow,
): Promise<WoMessage | null> {
  const res = await query<MessageRow>(
    `${MESSAGE_SELECT} WHERE c.task_id = $1 AND c.id = $2`,
    [taskId, messageId],
  );
  const r = res.rows[0];
  return r ? mapRow(r, actor, allow(MESSAGE_PERM_KEY, 'edit')) : null;
}

// ── Posting ──────────────────────────────────────────────────────────────────

export interface PostMessageInput {
  body: string;
  client_visible: boolean;
}

/** Post a message. One transaction: the comment row, its pending delivery
 *  when it is client-visible and the work order names a client system, and
 *  the `comment_added` audit row. Then the outbox is tried (a no-op until an
 *  adapter exists). */
export async function postMessage(
  taskId: string,
  input: PostMessageInput,
  actor: ActingPrincipal,
  allow: Allow,
): Promise<WoMessage> {
  const link = await loadLink(taskId);
  const target = input.client_visible ? (link?.target ?? null) : null;
  let commentId: string | null = null;

  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO comment (task_id, author_principal_id, body, client_visible, source)
       VALUES ($1, $2, $3, $4, 'staff')
       RETURNING id::text AS id`,
      [taskId, actor.id, input.body, input.client_visible],
    );
    commentId = ins.rows[0].id;

    if (target) {
      await tx.query(
        `INSERT INTO comment_delivery (comment_id, target) VALUES ($1, $2)`,
        [commentId, target],
      );
    }

    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
      [
        actor.id,
        taskId,
        JSON.stringify({
          comment_id: commentId,
          client_visible: input.client_visible,
          source: 'staff',
          ...(target ? { delivery: target } : {}),
        }),
      ],
    );
  });

  if (!commentId) throw new ApiError('INTERNAL', 'Message insert produced no row');
  await deliverPendingMessage(commentId);

  const item = await loadMessage(taskId, commentId, actor, allow);
  if (!item) throw new ApiError('INTERNAL', 'Message vanished after insert');
  return item;
}

// ── Editing ──────────────────────────────────────────────────────────────────

export interface EditMessageInput {
  body?: string;
  client_visible?: boolean;
}

/** Change one's own unsent message. 403 unless the actor wrote it, 409
 *  `MESSAGE_SENT` once any client system accepted it. Turning it
 *  client-visible queues the delivery; turning it internal drops the pending
 *  row (nothing was sent, by the rule above). */
export async function editMessage(
  taskId: string,
  messageId: string,
  input: EditMessageInput,
  actor: ActingPrincipal,
  allow: Allow,
): Promise<WoMessage> {
  const current = await loadMessage(taskId, messageId, actor, allow);
  if (!current) throw new ApiError('NOT_FOUND', 'Message not found');
  if (current.source !== 'staff' || !current.author || current.author.id !== actor.id) {
    throw new ApiError('FORBIDDEN', 'Only the person who wrote a message can edit it');
  }
  if (current.sent) {
    throw new ApiError('CONFLICT', 'This message has been sent to the client and can no longer be edited', {
      code: 'MESSAGE_SENT',
    });
  }
  if (!allow(MESSAGE_PERM_KEY, 'edit')) {
    throw new ApiError('FORBIDDEN', 'You cannot edit messages', {
      required_permission: `${MESSAGE_PERM_KEY}:edit`,
    });
  }

  const body = input.body ?? current.body;
  const clientVisible = input.client_visible ?? current.client_visible;
  if (body === current.body && clientVisible === current.client_visible) return current;

  const link = clientVisible && !current.client_visible ? await loadLink(taskId) : null;
  const newTarget = link?.target ?? null;

  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE comment SET body = $2, client_visible = $3, edited_at = now() WHERE id = $1`,
      [messageId, body, clientVisible],
    );
    if (clientVisible && !current.client_visible && newTarget) {
      await tx.query(
        `INSERT INTO comment_delivery (comment_id, target) VALUES ($1, $2)
         ON CONFLICT (comment_id, target) DO NOTHING`,
        [messageId, newTarget],
      );
    }
    if (!clientVisible && current.client_visible) {
      await tx.query(`DELETE FROM comment_delivery WHERE comment_id = $1 AND status <> 'sent'`, [messageId]);
    }
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'message_edited', NULL, $3::jsonb, $4::jsonb)`,
      [
        actor.id,
        taskId,
        JSON.stringify({ comment_id: messageId, body: current.body, client_visible: current.client_visible }),
        JSON.stringify({ comment_id: messageId, body, client_visible: clientVisible }),
      ],
    );
  });

  await deliverPendingMessage(messageId);

  const item = await loadMessage(taskId, messageId, actor, allow);
  if (!item) throw new ApiError('INTERNAL', 'Message vanished after edit');
  return item;
}

// ── The outbox ───────────────────────────────────────────────────────────────

interface PendingRow {
  id: string;
  target: ClientMessageTarget;
  task_id: string;
  wo_number: string;
  body: string;
  author_name: string | null;
  posted_at: string;
  ecotrak_id: string | null;
}

function messagingActorId(): Promise<string> {
  return serviceActorId('Client messaging', 'CM');
}

/** Try every pending delivery of one message against its adapter. With no
 *  adapter registered for the target the row is left pending — the honest
 *  state until the integration exists. */
export async function deliverPendingMessage(commentId: string): Promise<void> {
  const res = await query<PendingRow>(
    `SELECT d.id::text            AS id,
            d.target              AS target,
            c.task_id::text       AS task_id,
            t.wo_number           AS wo_number,
            c.body                AS body,
            p.display_name        AS author_name,
            ${ISO('c.created_at')} AS posted_at,
            t.fields ->> $2       AS ecotrak_id
       FROM comment_delivery d
       JOIN comment c ON c.id = d.comment_id
       JOIN task t ON t.id = c.task_id
       LEFT JOIN principal p ON p.id = c.author_principal_id
      WHERE d.comment_id = $1 AND d.status = 'pending'`,
    [commentId, ECOTRAK_ID_KEY],
  );
  const pending = res.rows.filter((r) => clientMessageAdapter(r.target) !== null);
  if (pending.length === 0) return;

  const actorId = await messagingActorId();
  for (const row of pending) {
    const adapter = clientMessageAdapter(row.target);
    if (!adapter) continue;
    let externalId: string | null = null;
    let error: string | null = null;
    try {
      const out = await adapter.send({
        message_id: commentId,
        task_id: row.task_id,
        wo_number: row.wo_number,
        client_ref: row.target === 'ecotrak' ? row.ecotrak_id : null,
        body: row.body,
        author_name: row.author_name ?? 'The One',
        posted_at: row.posted_at,
      });
      externalId = out.external_id;
    } catch (e) {
      error = (e as Error).message || 'The client system refused the message';
    }
    await recordDelivery(row.id, commentId, row.task_id, row.target, externalId, error, actorId);
  }
}

async function recordDelivery(
  deliveryId: string,
  commentId: string,
  taskId: string,
  target: ClientMessageTarget,
  externalId: string | null,
  error: string | null,
  actorId: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    if (error === null) {
      await tx.query(
        `UPDATE comment_delivery
            SET status = 'sent', external_id = $2, error = NULL, attempts = attempts + 1, sent_at = now()
          WHERE id = $1`,
        [deliveryId, externalId],
      );
    } else {
      await tx.query(
        `UPDATE comment_delivery
            SET status = 'failed', error = $2, attempts = attempts + 1
          WHERE id = $1`,
        [deliveryId, error],
      );
    }
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, $3, NULL, NULL, $4::jsonb)`,
      [
        actorId,
        taskId,
        error === null ? 'client_message_sent' : 'client_message_failed',
        JSON.stringify({ comment_id: commentId, target, external_id: externalId, error }),
      ],
    );
  });
}

// ── Inbound ──────────────────────────────────────────────────────────────────

export interface InboundClientMessage {
  task_id: string;
  target: ClientMessageTarget;
  /** The client system's id for the note — the dedupe key across re-syncs. */
  external_id: string;
  external_author: string | null;
  body: string;
  /** When it was written on their side; now() when the system does not say. */
  occurred_at?: string | null;
}

/** A note the client wrote in their CMMS, landing in the thread as a
 *  client-sourced, client-visible message. Idempotent on (target, external_id):
 *  a second sync of the same note returns the existing id and writes nothing. */
export async function receiveClientMessage(input: InboundClientMessage): Promise<{ id: string; created: boolean }> {
  const existing = await query<{ id: string }>(
    `SELECT id::text AS id FROM comment WHERE external_target = $1 AND external_id = $2`,
    [input.target, input.external_id],
  );
  if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

  const actorId = await messagingActorId();
  let id: string | null = null;
  await withTransaction(async (tx) => {
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO comment
         (task_id, author_principal_id, body, client_visible, source, external_author, external_target, external_id, created_at)
       VALUES ($1, NULL, $2, true, 'client', $3, $4, $5, COALESCE($6::timestamptz, now()))
       RETURNING id::text AS id`,
      [input.task_id, input.body, input.external_author, input.target, input.external_id, input.occurred_at ?? null],
    );
    id = ins.rows[0].id;
    await tx.query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'task', $2, 'client_message_received', NULL, NULL, $3::jsonb)`,
      [
        actorId,
        input.task_id,
        JSON.stringify({
          comment_id: id,
          target: input.target,
          external_id: input.external_id,
          external_author: input.external_author,
        }),
      ],
    );
  });
  if (!id) throw new ApiError('INTERNAL', 'Inbound message insert produced no row');
  return { id, created: true };
}

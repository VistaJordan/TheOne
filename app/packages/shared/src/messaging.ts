// Messages on a work order (migration 0052).
//
// A message is internal (the team) or client-visible (goes to the client's
// CMMS). The client systems are the three a work order can name in its
// `Client Portal Type` field; a client-visible message gets ONE delivery row
// per system the work order is linked to, and that row is what an adapter
// (Corrigo, ServiceChannel, Ecotrak after go-live) flips from pending to sent.
// Pure vocabulary and rules live here so the API and the browser agree; the
// SQL and the adapters live under apps/api.

import type { FeedActor } from './index';

export type ClientMessageTarget = 'ecotrak' | 'corrigo' | 'servicechannel';

export const CLIENT_MESSAGE_TARGETS: readonly ClientMessageTarget[] = ['ecotrak', 'corrigo', 'servicechannel'];

export const CLIENT_MESSAGE_TARGET_LABELS: Record<ClientMessageTarget, string> = {
  ecotrak: 'Ecotrak',
  corrigo: 'Corrigo',
  servicechannel: 'ServiceChannel',
};

/** The bag key that says which client CMMS a work order came from (0033). */
export const CLIENT_PORTAL_TYPE_KEY = 'Client Portal Type';

/** Which client system a `Client Portal Type` value names, or null when the
 *  field is empty or names something we do not know. Tolerant of case and of
 *  "Service Channel" written as two words. */
export function clientMessageTarget(portalType: string | null | undefined): ClientMessageTarget | null {
  if (!portalType) return null;
  const v = portalType.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (v === 'ecotrak' || v === 'ecotrack') return 'ecotrak';
  if (v === 'corrigo') return 'corrigo';
  if (v === 'servicechannel') return 'servicechannel';
  return null;
}

export type MessageDeliveryStatus = 'pending' | 'sent' | 'failed';

export interface MessageDelivery {
  target: ClientMessageTarget;
  status: MessageDeliveryStatus;
  /** The client system's own id for the note, once it accepted it. */
  external_id: string | null;
  error: string | null;
  attempts: number;
  sent_at: string | null;
  updated_at: string;
}

export type MessageSource = 'staff' | 'client';

export interface WoMessage {
  id: string;
  /** 'staff' = one of us wrote it here; 'client' = it came in from their CMMS. */
  source: MessageSource;
  /** Null on a client-sourced message (no principal wrote it). */
  author: FeedActor | null;
  /** Who wrote it on the client's side, when the source is 'client'. */
  external_author: string | null;
  client_visible: boolean;
  body: string;
  created_at: string;
  edited_at: string | null;
  deliveries: MessageDelivery[];
  /** True once any client system has accepted it — edits are locked from then on. */
  sent: boolean;
  /** May the ACTING principal edit it right now (their own, unsent, permitted). */
  editable: boolean;
}

/** The client system a work order is linked to, as the Messages tab draws it. */
export interface ClientSystem {
  target: ClientMessageTarget;
  label: string;
  /** False until that system's adapter exists and is allowed to write. A
   *  client-visible message still queues; it just stays pending. */
  write_enabled: boolean;
}

/** A message is sent once ANY client system accepted it. */
export function messageIsSent(deliveries: readonly Pick<MessageDelivery, 'status'>[]): boolean {
  return deliveries.some((d) => d.status === 'sent');
}

/** The edit rule (0052): our own message, not yet sent anywhere, by its author. */
export function messageEditableBy(
  m: Pick<WoMessage, 'source' | 'author' | 'deliveries'>,
  actorId: string,
  mayEdit: boolean,
): boolean {
  if (!mayEdit) return false;
  if (m.source !== 'staff' || !m.author) return false;
  if (m.author.id !== actorId) return false;
  return !messageIsSent(m.deliveries);
}

/** Longest message body the API accepts (same bound the Updates composer had). */
export const WO_MESSAGE_MAX = 4000;

/** Permission paths. `create` on the first is posting at all; `edit` is
 *  changing one's own unsent message; `create` on the second is posting
 *  client-visible (unset inherits the first). */
export const MESSAGE_PERM_KEY = 'work_orders/comments';
export const CLIENT_MESSAGE_PERM_KEY = 'work_orders/comments/client';

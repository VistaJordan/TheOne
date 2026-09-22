// Client-message adapters — the port a client CMMS integration implements to
// carry a client-visible message across (migration 0052).
//
// NOTHING IS REGISTERED YET. A client-visible message on a work order linked
// to Corrigo / ServiceChannel / Ecotrak gets a pending `comment_delivery` row
// and stays pending: the outbox is the contract, the adapters come with the
// integrations. Ecotrak in particular stays unregistered until go-live — the
// standing rule is that nothing writes to Ecotrak (ecotrak/client.ts is
// read-only by construction), and registering an adapter here is the one
// deliberate act that would change that.
//
// When an adapter lands it calls `registerClientMessageAdapter` at boot and
// `deliverPendingMessage` (services/woMessages.ts) does the rest: flips the
// row, stamps the external id, writes the audit row. Inbound notes from the
// client go the other way through `receiveClientMessage` in the same service.

import type { ClientMessageTarget } from '@theone/shared';

export interface OutboundClientMessage {
  message_id: string;
  task_id: string;
  wo_number: string;
  /** The client's own id for the work order (Ecotrak ID, …) when we hold one. */
  client_ref: string | null;
  body: string;
  author_name: string;
  posted_at: string;
}

export interface ClientMessageAdapter {
  /** Post the note on the client's side; resolve with their id for it (or
   *  null when the system returns none). Throw to mark the delivery failed —
   *  the error message is what the Messages tab shows. */
  send(message: OutboundClientMessage): Promise<{ external_id: string | null }>;
}

const adapters = new Map<ClientMessageTarget, ClientMessageAdapter>();

export function registerClientMessageAdapter(target: ClientMessageTarget, adapter: ClientMessageAdapter): void {
  adapters.set(target, adapter);
}

export function clientMessageAdapter(target: ClientMessageTarget): ClientMessageAdapter | null {
  return adapters.get(target) ?? null;
}

/** Whether a client-visible message can actually leave for this system today. */
export function clientWriteEnabled(target: ClientMessageTarget): boolean {
  return adapters.has(target);
}

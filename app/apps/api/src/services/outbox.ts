// Integration outbox (gap analysis D11 / G-X02).
//
// Every quote / payment event that Yoda pushes to ClickUp or Teams (ClientQuote
// field, approval comments, per-company payment posts, ✅ / ❌ / 👍 reactions) is
// written here INSIDE the business transaction. Nothing leaves the process yet:
// the row IS the record that the push is owed. The S6 adapters drain
// `status = 'pending'` rows; until then the feature is fully functional offline
// and the audit of what WOULD have been posted is already in the database.

interface Queryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type OutboxKind =
  | 'quote.sent'
  | 'quote.cancelled'
  | 'quote.client_approved'
  | 'quote.client_declined'
  | 'payment.requested'
  | 'payment.approved'
  | 'payment.paid'
  | 'payment.rejected'
  | 'payment.deleted'
  | 'payment.delete_requested';

export async function enqueueOutbox(
  tx: Queryable,
  kind: OutboxKind,
  entityType: 'quote' | 'payment_request',
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox (kind, entity_type, entity_id, payload) VALUES ($1, $2, $3, $4::jsonb)`,
    [kind, entityType, entityId, JSON.stringify(payload)],
  );
}

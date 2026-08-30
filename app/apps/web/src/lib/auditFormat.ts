/* Shared rendering vocabulary for activity_log entries — used by the per-WO
   Audit trail tab and by Admin › Audit log, so the same change reads the same
   in both places. Row shapes are documented in api/services/woAudit.ts. */

import type { WoFieldDescriptor } from '@theone/shared';
import { DASH, fieldValueToString, money } from './fields';

/** New rows carry `{ value }`; rows written before woAudit.ts hold the bare
    scalar. Both read the same. */
export function unwrap(blob: unknown): unknown {
  if (blob && typeof blob === 'object' && !Array.isArray(blob) && 'value' in blob) {
    return (blob as { value: unknown }).value;
  }
  return blob;
}

export function nameOf(blob: unknown, key: string): string {
  const v =
    blob && typeof blob === 'object' ? (blob as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() ? v : DASH;
}

/** Where a change came from, when not typed by hand ('bulk' | 'import'). */
export function viaLabel(after: unknown): string | null {
  const via =
    after && typeof after === 'object' ? (after as Record<string, unknown>).via : undefined;
  return typeof via === 'string' ? via : null;
}

const CORE_LABELS: Record<string, string> = {
  status_id: 'Status',
  home_list_id: 'Home list',
  ext_name: 'Client WO #',
  date_received: 'Date received',
  billing_entity: 'Billing entity',
  nte: 'NTE',
};

export function labelOf(key: string, byKey: Map<string, WoFieldDescriptor>): string {
  const f = byKey.get(key);
  if (f) return f.label;
  if (CORE_LABELS[key]) return CORE_LABELS[key];
  const bare = key.startsWith('fields.') ? key.slice('fields.'.length) : key;
  // ClickUp-era names carry a numbering prefix ("16. Client NTE"); drop it.
  return bare.replace(/^\d+\.\s*/, '').replace(/_/g, ' ');
}

export function formatValue(v: unknown, f: WoFieldDescriptor | undefined): string {
  if (v === null || v === undefined || v === '') return DASH;
  switch (f?.type) {
    case 'money': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? money(n) : String(v);
    }
    case 'date': {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime())
        ? String(v)
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    case 'boolean':
      return v === true || v === 'true' ? 'checked' : 'unchecked';
    default:
      return fieldValueToString(v);
  }
}

/** Short human labels for the action vocabulary; fallback humanises the code. */
export const ACTION_LABELS: Record<string, string> = {
  created: 'Created',
  status_changed: 'Status changed',
  field_updated: 'Field updated',
  routed: 'Routed',
  deleted: 'Moved to Trash',
  restored: 'Restored',
  comment_added: 'Update posted',
  tech_message_sent: 'Message sent',
  quote_created: 'Quote created',
  quote_updated: 'Quote revised',
  quote_submitted: 'Quote submitted',
  quote_sent: 'Quote sent',
  quote_approved: 'Quote approved',
  quote_rejected: 'Quote rejected',
  payment_requested: 'Payment requested',
  signed_in: 'Signed in',
  signed_out: 'Signed out',
  impersonation_started: 'Viewing as started',
  impersonation_ended: 'Viewing as ended',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

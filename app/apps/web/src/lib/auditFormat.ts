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

/** Where a change came from, when not typed by hand ('bulk' | 'import' |
    'automation'). For an automation prefer automationRef(), which also carries
    the rule's name. */
export function viaLabel(after: unknown): string | null {
  const via =
    after && typeof after === 'object' ? (after as Record<string, unknown>).via : undefined;
  if (typeof via !== 'string') return null;
  // The mirror rows the visit log writes (0021) say where they came from.
  return via === 'visit' ? 'the visit log' : via;
}

// ── Visits (0021) ────────────────────────────────────────────────────────────
// visit_created / visit_updated / visit_deleted rows carry whole snapshots
// (see api/services/visits.ts) — this turns a pair into one sentence, used by
// the per-WO audit trail, the visit's own history drawer and Admin › Audit log.

type VisitSnap = Record<string, unknown> & { name?: string };

function snapOf(blob: unknown): VisitSnap | null {
  return blob && typeof blob === 'object' && !Array.isArray(blob) ? (blob as VisitSnap) : null;
}

/** '07:04:12 on Jul 15' — a stamp inside a sentence, in the viewer's local time. */
export function visitStampText(v: unknown): string {
  if (typeof v !== 'string' || !v) return DASH;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${time} on ${day}`;
}

const VISIT_KEY_LABELS: Record<string, string> = {
  visit_type: 'type',
  tech_name: 'tech',
  tech_phone: 'tech phone',
  method: 'method',
  checked_in_at: 'check-in time',
  checked_out_at: 'check-out time',
  return_trip_needed: 'return trip needed',
};

function visitValueText(key: string, v: unknown): string {
  if (key === 'checked_in_at' || key === 'checked_out_at') return visitStampText(v);
  if (key === 'return_trip_needed') return v ? 'yes' : 'no';
  return v === null || v === undefined || v === '' ? DASH : String(v);
}

/** The sentence after the actor's name: "logged Visit 2 · Job for R. Delgado",
    "checked in Visit 2 · Job at 07:04:12 on Sep 3", "updated Visit 1 ·
    Assessment: tech — → K. Okafor". */
export function describeVisitChange(before: unknown, after: unknown): string {
  const b = snapOf(before);
  const a = snapOf(after);
  const name = a?.name ?? b?.name ?? 'a visit';
  if (!b && a) {
    const who = typeof a.tech_name === 'string' && a.tech_name ? ` for ${a.tech_name}` : '';
    const state =
      a.status === 'checked_in' ? ` — checked in at ${visitStampText(a.checked_in_at)}`
      : a.status === 'checked_out' ? ` — checked out at ${visitStampText(a.checked_out_at)}`
      : '';
    return `logged ${name}${who}${state}`;
  }
  if (b && !a) return `deleted ${name}`;
  if (!b || !a) return `changed ${name}`;

  if (b.status !== a.status) {
    if (a.status === 'checked_in') return `checked in ${name} at ${visitStampText(a.checked_in_at)}`;
    if (a.status === 'checked_out') {
      return `checked out ${name} at ${visitStampText(a.checked_out_at)}${a.return_trip_needed ? ' — return trip needed' : ''}`;
    }
    return `reset ${name} to not checked in`;
  }
  const diffs = Object.keys(VISIT_KEY_LABELS)
    .filter((k) => String(b[k] ?? '') !== String(a[k] ?? ''))
    .map((k) => `${VISIT_KEY_LABELS[k]} ${visitValueText(k, b[k])} → ${visitValueText(k, a[k])}`);
  return diffs.length ? `updated ${name}: ${diffs.join(', ')}` : `touched ${name}`;
}

/** The automation that made the change, for rows written by the engine. The id
    and name are copied into the row at write time, so a rule that was since
    renamed or deleted still reads as it did then (the link may then find
    nothing, which is honest). Rows written before this was stamped say only
    'automation' — the name comes back null and the trail falls back to that. */
export function automationRef(after: unknown): { id: string | null; name: string | null } | null {
  if (viaLabel(after) !== 'automation') return null;
  const a = after as Record<string, unknown>;
  return {
    id: typeof a.automation_id === 'string' ? a.automation_id : null,
    name: typeof a.automation_name === 'string' && a.automation_name.trim()
      ? a.automation_name
      : null,
  };
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
    case 'datetime': {
      // 'Sep 7, 2026, 8:02:43 AM' — the check-in/out stamps are to the second,
      // and a history row is exactly where the second matters.
      const s = String(v).replace(' ', 'T');
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return String(v);
      const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      if (!/T\d{2}:\d{2}/.test(s)) return day;
      const secs = /T\d{2}:\d{2}:\d{2}/.test(s);
      return `${day}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', ...(secs ? { second: '2-digit' } : {}) })}`;
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
  payment_approved: 'Payment approved',
  payment_rejected: 'Payment rejected',
  payment_sent_to_yoda: 'Payment sent to Yoda',
  payment_paid: 'Payment paid',
  // Approval tasks (0020) — the manager's inbox.
  approval_task_created: 'Approval task raised',
  approval_task_claimed: 'Approval task claimed',
  approval_task_approved: 'Approval task approved',
  approval_task_rejected: 'Approval task rejected',
  approval_task_cancelled: 'Approval task cancelled',
  // Visits (0021) — the check-in / check-out log.
  visit_created: 'Visit logged',
  visit_updated: 'Visit updated',
  visit_deleted: 'Visit deleted',
  cico_method_created: 'Check-in method added',
  cico_method_changed: 'Check-in method changed',
  cico_method_deleted: 'Check-in method removed',
  signed_in: 'Signed in',
  signed_out: 'Signed out',
  impersonation_started: 'Viewing as started',
  impersonation_ended: 'Viewing as ended',
  // Admin changes (api/services/adminAudit.ts).
  field_def_created: 'Custom field created',
  field_def_updated: 'Custom field changed',
  field_defs_reordered: 'Custom fields reordered',
  status_created: 'Status created',
  status_updated: 'Status changed',
  status_deleted: 'Status deleted',
  status_group_created: 'Phase created',
  status_group_renamed: 'Phase renamed',
  status_group_deleted: 'Phase deleted',
  role_created: 'Role created',
  role_updated: 'Role changed',
  role_deleted: 'Role deleted',
  user_invited: 'User invited',
  user_updated: 'User changed',
  user_disabled: 'User disabled',
  user_permissions_set: 'User permissions adjusted',
  automation_created: 'Automation created',
  automation_updated: 'Automation changed',
  automation_deleted: 'Automation deleted',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, ' ');
}

/** What kind of thing a non-work-order row points at. */
export const ENTITY_LABELS: Record<string, string> = {
  task: 'Work order',
  principal: 'User',
  field_def: 'Custom field',
  status: 'Status',
  status_group: 'Phase',
  role: 'Role',
  automation: 'Automation',
  fm_cico_method: 'Check-in method',
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType.replace(/_/g, ' ');
}

/** Human labels for the keys inside an admin snapshot. */
const SNAPSHOT_KEYS: Record<string, string> = {
  name: 'Name',
  key: 'Key',
  type: 'Type',
  options: 'Options',
  order: 'Order',
  group: 'Phase',
  color: 'Color',
  code: 'Code',
  description: 'Description',
  permissions: 'Permissions',
  overrides: 'Overrides',
  email: 'Email',
  role: 'Role',
  status: 'Status',
  is_super_admin: 'Super admin',
  enabled: 'Enabled',
  entity: 'Applies to',
  trigger: 'Trigger',
  conditions: 'Conditions',
  actions: 'Actions',
};

export interface SnapshotChange {
  key: string;
  label: string;
  from: string;
  to: string;
}

/** One compact string for a snapshot value: scalars as-is, lists as a count
    (or the items when short), trees as "N entries". */
export function snapshotValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return DASH;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    if (v.every((x) => typeof x === 'string') && v.length <= 6) return (v as string[]).join(', ');
    return `${v.length} item${v.length === 1 ? '' : 's'}`;
  }
  if (typeof v === 'object') {
    const n = Object.keys(v as object).length;
    return `${n} entr${n === 1 ? 'y' : 'ies'}`;
  }
  return String(v);
}

/** The keys that differ between two admin snapshots, in snapshot order. */
export function snapshotChanges(before: unknown, after: unknown): SnapshotChange[] {
  const b = (before && typeof before === 'object' ? before : {}) as Record<string, unknown>;
  const a = (after && typeof after === 'object' ? after : {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
  const out: SnapshotChange[] = [];
  for (const key of keys) {
    if (JSON.stringify(b[key]) === JSON.stringify(a[key])) continue;
    out.push({
      key,
      label: SNAPSHOT_KEYS[key] ?? key.replace(/_/g, ' '),
      from: snapshotValue(b[key]),
      to: snapshotValue(a[key]),
    });
  }
  return out;
}

/** A created row has no `before`: list what it was created with, minus the
    name (that is the row's title already). */
export function snapshotSummary(snap: unknown): SnapshotChange[] {
  const s = (snap && typeof snap === 'object' ? snap : {}) as Record<string, unknown>;
  return Object.keys(s)
    .filter((k) => k !== 'name' && s[k] !== null && s[k] !== undefined && s[k] !== '')
    .map((key) => ({
      key,
      label: SNAPSHOT_KEYS[key] ?? key.replace(/_/g, ' '),
      from: '',
      to: snapshotValue(s[key]),
    }));
}

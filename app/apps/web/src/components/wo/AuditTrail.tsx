import type { ActivityEntry } from '@theone/shared';
import { feedTime } from '../../lib/fields';
import { Icon } from '../Icon';

interface AuditTrailProps {
  entries: ActivityEntry[];
  loading?: boolean;
  error?: boolean;
}

const ACTION_LABEL: Record<string, string> = {
  created: 'Created',
  status_changed: 'Status changed',
  field_updated: 'Field updated',
  routed: 'Routed',
  comment_added: 'Comment added',
};

/** "Audit trail" tab — the raw activity_log for this WO from GET /api/activity. */
export function AuditTrail({ entries, loading, error }: AuditTrailProps) {
  if (loading) return <div className="tab-empty"><span>Loading audit trail…</span></div>;

  if (error) {
    return (
      <div className="tab-empty">
        <Icon name="alert" size={22} />
        <b>Audit trail unavailable</b>
        <span>GET /api/activity did not respond.</span>
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="tab-empty">
        <Icon name="list" size={22} />
        <b>Nothing logged yet</b>
        <span>Every write to this work order is appended here.</span>
      </div>
    );
  }

  return (
    <ol className="audit">
      {entries.map((e) => (
        <li className="audit-row" key={e.id}>
          <strong>{ACTION_LABEL[e.action] ?? e.action}</strong>
          {e.field && <span className="chip chip-sm">{e.field}</span>}
          <span>{summarize(e)}</span>
          <span>by {e.actor?.display_name ?? 'system'}</span>
          <time className="audit-time">{feedTime(e.created_at)}</time>
        </li>
      ))}
    </ol>
  );
}

function summarize(e: ActivityEntry): string {
  const before = pick(e.before);
  const after = pick(e.after);
  if (before && after) return `${before} → ${after}`;
  if (after) return after;
  if (before) return before;
  return '';
}

/** Pull the most human value out of an activity before/after blob. */
function pick(blob: Record<string, unknown> | null): string | null {
  if (!blob) return null;
  const preferred = ['status_name', 'name', 'value', 'client_visible'];
  for (const k of preferred) {
    const v = blob[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'boolean') return k === 'client_visible' ? (v ? 'client-visible' : 'internal') : String(v);
  }
  return null;
}

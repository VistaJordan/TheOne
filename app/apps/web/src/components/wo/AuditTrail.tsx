import { useMemo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ActivityEntry, WoFieldDescriptor } from '@theone/shared';
import { getWoFields } from '../../api/client';
import { DASH, feedTime, initials } from '../../lib/fields';
import { automationRef, formatValue, labelOf, nameOf, unwrap, viaLabel } from '../../lib/auditFormat';
import { Icon } from '../Icon';
import { useAuth } from '../../auth/AuthProvider';

interface AuditTrailProps {
  entries: ActivityEntry[];
  loading?: boolean;
  error?: boolean;
}

/**
 * "Audit trail" tab — every write to this work order, as sentences:
 * who did what, from which value to which, and when. Field names come from
 * the same catalogue the Columns and Filter menus use, so renaming a field in
 * Admin renames it here too, on old entries as well as new. Admin › Audit log
 * is the same data across every work order.
 */
export function AuditTrail({ entries, loading, error }: AuditTrailProps) {
  const { user } = useAuth();
  const isAdmin = Boolean(user?.is_super_admin);
  const catalogue = useQuery({
    queryKey: ['wo-fields'],
    queryFn: getWoFields,
    staleTime: 5 * 60 * 1000,
  });
  const byKey = useMemo(
    () => new Map((catalogue.data?.fields ?? []).map((f) => [f.key, f])),
    [catalogue.data],
  );

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
        <span>Every change to this work order is recorded here.</span>
      </div>
    );
  }

  return (
    <ol className="audit">
      {entries.map((e) => {
        const who = e.actor?.display_name ?? 'System';
        return (
          <li className="audit-row" key={e.id}>
            <span className={`audit-av${e.actor?.kind === 'service' ? ' is-service' : ''}`} aria-hidden="true">
              {initials(who)}
            </span>
            <p className="audit-text">
              <b>{who}</b> {describe(e, byKey, isAdmin)}
            </p>
            <time className="audit-time" dateTime={e.created_at}>{feedTime(e.created_at)}</time>
          </li>
        );
      })}
    </ol>
  );
}

// ── Sentences ────────────────────────────────────────────────────────────────

function describe(e: ActivityEntry, byKey: Map<string, WoFieldDescriptor>, isAdmin: boolean): ReactNode {
  const via = viaOf(e.after, isAdmin);

  switch (e.action) {
    case 'status_changed':
      return (
        <>
          changed <b>Status</b> from <Val>{nameOf(e.before, 'status_name')}</Val> to{' '}
          <Val>{nameOf(e.after, 'status_name')}</Val>
          {via}
        </>
      );

    case 'routed':
      return (
        <>
          moved this work order to the <Val>{nameOf(e.after, 'list_name')}</Val> list
          {nameOf(e.before, 'list_name') !== DASH && (
            <> (from <Val>{nameOf(e.before, 'list_name')}</Val>)</>
          )}
          {via}
        </>
      );

    case 'field_updated': {
      // Pre-diff imports logged one row per file with the column names only.
      if (e.field === 'import') {
        const cols = (e.after?.columns as string[] | undefined) ?? [];
        return (
          <>
            updated {cols.length} field{cols.length === 1 ? '' : 's'} via import
            {cols.length > 0 && <>: {cols.map((c) => labelOf(c, byKey)).join(', ')}</>}
          </>
        );
      }
      const f = e.field ? byKey.get(e.field) : undefined;
      const label = e.field ? labelOf(e.field, byKey) : 'a field';
      const before = formatValue(unwrap(e.before), f);
      const after = formatValue(unwrap(e.after), f);
      if (before === DASH && after !== DASH) {
        return (<>set <b>{label}</b> to <Val>{after}</Val>{via}</>);
      }
      if (after === DASH && before !== DASH) {
        return (<>cleared <b>{label}</b> (was <Val>{before}</Val>){via}</>);
      }
      return (
        <>
          changed <b>{label}</b> from <Val>{before}</Val> to <Val>{after}</Val>
          {via}
        </>
      );
    }

    case 'created':
      return (
        <>
          created this work order
          {e.after?.source === 'import' && <span className="audit-via">via import</span>}
        </>
      );
    case 'deleted':
      return <>moved this work order to Trash</>;
    case 'restored':
      return <>restored this work order from Trash</>;
    case 'comment_added':
      return <>posted {e.after?.client_visible ? 'a client-visible' : 'an internal'} update</>;
    case 'tech_message_sent':
      return <>sent a message to the technician</>;
    case 'quote_created':
      return <>created the quote</>;
    case 'quote_updated':
      return <>revised the quote</>;
    case 'quote_submitted':
      return <>submitted the quote for approval</>;
    case 'quote_sent':
      return <>sent the quote to the client</>;
    case 'quote_approved':
      return <>approved the quote</>;
    case 'quote_rejected':
      return <>rejected the quote</>;
    case 'payment_requested':
      return <>requested a technician payment</>;
    default:
      return <>{e.action.replace(/_/g, ' ')}</>;
  }
}

function Val({ children }: { children: ReactNode }) {
  return <span className="audit-val">{children}</span>;
}

/**
 * "via import" / "via bulk", and for the automations engine the rule's own
 * name, linked to it in Admin › Automations so a reader can see the trigger
 * and conditions that produced the change. Only super admins get the link —
 * everyone else meets the console's lock screen — but everyone sees the name.
 */
function viaOf(after: ActivityEntry['after'], isAdmin: boolean): ReactNode {
  const auto = automationRef(after);
  if (auto) {
    if (!auto.name) return <span className="audit-via">via an automation</span>;
    return (
      <span className="audit-via">
        via{' '}
        {isAdmin && auto.id
          ? (
            <Link className="audit-via-link" to={`/admin/automations?rule=${encodeURIComponent(auto.id)}`}>
              {auto.name}
            </Link>
          )
          : auto.name}
      </span>
    );
  }
  const via = viaLabel(after);
  return via ? <span className="audit-via">via {via}</span> : null;
}

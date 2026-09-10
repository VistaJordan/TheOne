/* Admin › Audit log — the whole activity_log, across every work order and
   every kind of write, filterable and exportable. The per-WO Audit trail tab
   shows the same rows scoped to one work order; the WO # column here links
   straight to it.

   Admin changes sit in the same list: a custom field created or renamed, a
   status or phase edited, a role, a user or an automation rule. Those rows
   carry whole before/after snapshots, and the last column lists only the keys
   that changed. */

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  describeEcotrakRefusal,
  ecotrakTransitionRefused,
  type EcotrakTransitionVerdict,
  type WoFieldDescriptor,
} from '@theone/shared';
import { AdminShell, AdminEmpty } from './AdminShell';
import { Icon } from '../../components/Icon';
import {
  auditLogExportUrl,
  getWoFields,
  listAuditLog,
  type AuditLogEntry,
  type AuditLogFilters,
} from '../../api/client';
import { useDebounced } from '../../hooks/useDebounced';
import { DASH, feedTime, initials } from '../../lib/fields';
import {
  actionLabel,
  approvalAskText,
  approvalRef,
  automationRef,
  describeVisitChange,
  entityLabel,
  formatValue,
  labelOf,
  nameOf,
  quoteChanges,
  snapshotChanges,
  snapshotSummary,
  unwrap,
  viaLabel,
  type SnapshotChange,
} from '../../lib/auditFormat';

const PAGE = 100;

export function AdminAuditPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actorId, setActorId] = useState('');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [offset, setOffset] = useState(0);
  const debouncedQ = useDebounced(q, 300);

  const filters: AuditLogFilters = useMemo(
    () => ({
      from: from || undefined,
      to: to || undefined,
      actor_id: actorId || undefined,
      action: action || undefined,
      q: debouncedQ || undefined,
    }),
    [from, to, actorId, action, debouncedQ],
  );

  const logQuery = useQuery({
    queryKey: ['admin-audit', filters, offset],
    queryFn: () => listAuditLog({ ...filters, limit: PAGE, offset }),
    retry: 0,
    placeholderData: (prev) => prev,
  });

  const fieldsQuery = useQuery({
    queryKey: ['wo-fields'],
    queryFn: getWoFields,
    staleTime: 5 * 60 * 1000,
  });
  const byKey = useMemo(
    () => new Map((fieldsQuery.data?.fields ?? []).map((f) => [f.key, f])),
    [fieldsQuery.data],
  );

  const page = logQuery.data;
  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const anyFilter = Boolean(filters.from || filters.to || filters.actor_id || filters.action || filters.q);

  // Any filter change starts from the first page again.
  const setFilter = (fn: () => void) => {
    fn();
    setOffset(0);
  };

  return (
    <AdminShell
      title="Audit log"
      actions={
        <a className="tool-btn" href={auditLogExportUrl(filters)} title="Download the filtered rows as CSV">
          <Icon name="download" size={14} />
          Export CSV
        </a>
      }
    >
      <div className="audit-filters">
        <label className="af">
          <span>From</span>
          <input type="date" value={from} onChange={(e) => setFilter(() => setFrom(e.target.value))} />
        </label>
        <label className="af">
          <span>To</span>
          <input type="date" value={to} onChange={(e) => setFilter(() => setTo(e.target.value))} />
        </label>
        <label className="af">
          <span>User</span>
          <select value={actorId} onChange={(e) => setFilter(() => setActorId(e.target.value))}>
            <option value="">Everyone</option>
            {(page?.facets.actors ?? []).map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>
        <label className="af">
          <span>Change</span>
          <select value={action} onChange={(e) => setFilter(() => setAction(e.target.value))}>
            <option value="">All kinds</option>
            {(page?.facets.actions ?? []).map((a) => (
              <option key={a} value={a}>{actionLabel(a)}</option>
            ))}
          </select>
        </label>
        <label className="af af-grow">
          <span>Search</span>
          <input
            type="search"
            placeholder="WO #, ext ref, field, name, or value…"
            value={q}
            onChange={(e) => setFilter(() => setQ(e.target.value))}
          />
        </label>
        {anyFilter && (
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              setFilter(() => {
                setFrom(''); setTo(''); setActorId(''); setAction(''); setQ('');
              })
            }
          >
            Clear
          </button>
        )}
      </div>

      {logQuery.isLoading && <AdminEmpty icon="history" title="Loading the audit log…" />}
      {logQuery.isError && (
        <AdminEmpty icon="alert" title="Could not load the audit log">
          GET /api/admin/audit did not respond, or you are not a super admin.
        </AdminEmpty>
      )}
      {page && items.length === 0 && (
        <AdminEmpty icon="history" title="No entries match">
          {anyFilter ? 'Loosen the filters to see more.' : 'Nothing has been logged yet.'}
        </AdminEmpty>
      )}

      {items.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="ct audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>User</th>
                  <th>Change</th>
                  <th>Item</th>
                  <th>Field</th>
                  <th>From → to</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <AuditRow key={e.id} e={e} byKey={byKey} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="audit-pager">
            <span>
              {(offset + 1).toLocaleString()}–{Math.min(offset + PAGE, total).toLocaleString()} of{' '}
              {total.toLocaleString()} entr{total === 1 ? 'y' : 'ies'}
            </span>
            <button
              type="button"
              className="tool-btn"
              disabled={offset === 0 || logQuery.isFetching}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >
              Newer
            </button>
            <button
              type="button"
              className="tool-btn"
              disabled={offset + PAGE >= total || logQuery.isFetching}
              onClick={() => setOffset(offset + PAGE)}
            >
              Older
            </button>
          </div>
        </>
      )}
    </AdminShell>
  );
}

function AuditRow({ e, byKey }: { e: AuditLogEntry; byKey: Map<string, WoFieldDescriptor> }) {
  const change = changeOf(e, byKey);
  const auto = automationRef(e.after);
  const via = auto ? null : viaLabel(e.after);
  return (
    <tr>
      <td className="audit-t">{feedTime(e.created_at)}</td>
      <td>
        <span className="audit-who">
          <span className={`audit-av${e.actor.kind === 'service' ? ' is-service' : ''}`} aria-hidden="true">
            {initials(e.actor.display_name)}
          </span>
          {e.actor.display_name}
        </span>
      </td>
      <td>
        <span className="audit-kind">{actionLabel(e.action)}</span>
        {via && <span className="audit-via">via {via}</span>}
        {auto && (
          <span className="audit-via">
            via{' '}
            {auto.id && auto.name
              ? (
                <Link
                  className="audit-via-link"
                  to={`/admin/automations?rule=${encodeURIComponent(auto.id)}`}
                >
                  {auto.name}
                </Link>
              )
              : auto.name ?? 'an automation'}
          </span>
        )}
      </td>
      <td>
        <ItemCell e={e} />
      </td>
      <td>{change.field}</td>
      <td className="audit-change">{change.value}</td>
    </tr>
  );
}

/** Where to look at the thing a non-work-order row touched. A deleted item
    still links to its admin page — that is where its absence shows. */
function adminHref(e: AuditLogEntry): string | null {
  switch (e.entity_type) {
    case 'field_def':
    case 'status':
    case 'status_group':
      return '/admin/fields';
    case 'role':
      return '/admin/roles';
    case 'principal':
      return '/admin/users';
    case 'automation':
      return `/admin/automations?rule=${encodeURIComponent(e.entity_id)}`;
    case 'fm_cico_method':
      return '/admin/fields';
    case 'saved_view':
      return '/work-orders';
    default:
      return null;
  }
}

function ItemCell({ e }: { e: AuditLogEntry }) {
  if (e.entity_type === 'task') {
    if (!e.wo_number) return <span className="audit-ext">{DASH}</span>;
    return (
      <Link className="audit-wo" to={`/work-orders/${e.wo_number}`}>
        <b>{e.wo_number}</b>
        {e.ext_name && <span className="audit-ext">{e.ext_name}</span>}
      </Link>
    );
  }
  const kind = entityLabel(e.entity_type);
  const href = adminHref(e);
  const body = (
    <>
      <b>{e.entity_name ?? kind}</b>
      <span className="audit-ext">{kind}</span>
    </>
  );
  return href ? (
    <Link className="audit-wo" to={href}>{body}</Link>
  ) : (
    <span className="audit-wo">{body}</span>
  );
}

/** Admin rows: the snapshot keys that changed, one per line. */
function ChangeList({ items, created }: { items: SnapshotChange[]; created?: boolean }) {
  if (items.length === 0) return <>{DASH}</>;
  return (
    <ul className="audit-diff">
      {items.map((c) => (
        <li key={c.key}>
          <span className="audit-diff-k">{c.label}</span>{' '}
          {created ? (
            <span className="audit-val">{c.to}</span>
          ) : (
            <>
              <span className="audit-val">{c.from}</span> →{' '}
              <span className="audit-val">{c.to}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function changeOf(
  e: AuditLogEntry,
  byKey: Map<string, WoFieldDescriptor>,
): { field: string; value: ReactNode } {
  switch (e.action) {
    case 'status_changed': {
      // Rules 2.6.3 / 2.7: a move Ecotrak would have refused says so here.
      const v = e.after?.ecotrak as EcotrakTransitionVerdict | undefined;
      const refused = v && ecotrakTransitionRefused(v) ? describeEcotrakRefusal(v) : null;
      return {
        field: 'Status',
        value: (
          <>
            <span className="audit-val">{nameOf(e.before, 'status_name')}</span> →{' '}
            <span className="audit-val">{nameOf(e.after, 'status_name')}</span>
            {refused && <span className="audit-ecotrak"> · {refused}</span>}
          </>
        ),
      };
    }
    case 'routed':
      return {
        field: 'Home list',
        value: (
          <>
            <span className="audit-val">{nameOf(e.before, 'list_name')}</span> →{' '}
            <span className="audit-val">{nameOf(e.after, 'list_name')}</span>
          </>
        ),
      };
    case 'field_updated': {
      if (e.field === 'import') {
        const cols = (e.after?.columns as string[] | undefined) ?? [];
        return { field: DASH, value: <>{cols.length} field{cols.length === 1 ? '' : 's'} (legacy import row)</> };
      }
      const f = e.field ? byKey.get(e.field) : undefined;
      return {
        field: e.field ? labelOf(e.field, byKey) : DASH,
        value: (
          <>
            <span className="audit-val">{formatValue(unwrap(e.before), f)}</span> →{' '}
            <span className="audit-val">{formatValue(unwrap(e.after), f)}</span>
          </>
        ),
      };
    }
    case 'created':
      return { field: DASH, value: e.after?.source === 'import' ? 'via import' : DASH };
    case 'comment_added': {
      // A decision's comment (0020 / 0025) says what it decided.
      const ref = approvalRef(e.after);
      const kind = e.after?.client_visible ? 'client-visible' : 'internal';
      if (!ref) return { field: DASH, value: kind };
      return {
        field: kind,
        value: (
          <>
            {ref.status === 'rejected' ? 'rejected' : 'approved'} {approvalAskText(ref)}
            {ref.note ? <> — {ref.note}</> : null}
          </>
        ),
      };
    }
    // Approval tasks (0020 / 0025): what was asked — a status change reads
    // From → To like a status row; the other kinds show their title.
    case 'approval_task_created':
    case 'approval_task_updated':
    case 'approval_task_claimed':
    case 'approval_task_approved':
    case 'approval_task_rejected':
    case 'approval_task_cancelled':
    case 'approval_task_acknowledged': {
      const ref = approvalRef(e.after) ?? approvalRef(e.before);
      if (!ref) break;
      if (ref.type === 'status_change') {
        return {
          field: 'Status change request',
          value: (
            <>
              <span className="audit-val">{ref.from ?? DASH}</span> →{' '}
              <span className="audit-val">{ref.to ?? DASH}</span>
              {ref.note ? <> — {ref.note}</> : null}
            </>
          ),
        };
      }
      return {
        field: ref.type === 'nte_override' ? 'NTE override' : 'Manager review',
        value: (
          <>
            {ref.title ?? DASH}
            {ref.note ? <> — {ref.note}</> : null}
          </>
        ),
      };
    }
    // Visits (0021): whole-visit snapshots on a work-order row.
    case 'visit_created':
    case 'visit_updated':
    case 'visit_deleted': {
      const snap = (e.after ?? e.before) as Record<string, unknown> | null;
      return {
        field: typeof snap?.name === 'string' ? snap.name : 'Visit',
        value: describeVisitChange(e.before, e.after),
      };
    }
    // Quote revisions: whole-quote snapshots on a work-order row.
    case 'quote_updated': {
      const items = quoteChanges(e.before, e.after);
      return { field: 'Quote', value: items.length ? <ChangeList items={items} /> : DASH };
    }
    default:
      break;
  }

  // Admin rows (entity_type other than task): before/after are snapshots.
  if (e.entity_type !== 'task' && (e.before || e.after)) {
    const field = e.field ? labelOf(e.field, byKey) : DASH;
    if (
      e.action.endsWith('_created') ||
      e.action.endsWith('_exported') ||
      e.action === 'user_invited' ||
      e.action === 'user_auto_enrolled'
    ) {
      return { field, value: <ChangeList items={snapshotSummary(e.after)} created /> };
    }
    if (e.action.endsWith('_deleted')) {
      return { field, value: <ChangeList items={snapshotSummary(e.before)} created /> };
    }
    if (e.action === 'field_defs_reordered') {
      const n = snapshotChanges(e.before, e.after).length;
      return { field: DASH, value: n ? 'admin default order changed' : DASH };
    }
    if (e.before && e.after) {
      return { field, value: <ChangeList items={snapshotChanges(e.before, e.after)} /> };
    }
  }
  return { field: DASH, value: DASH };
}

/* /approvals — the manager's inbox (0020).

   Every approval task across every live work order. Rule 1.5.2 raises the
   first kind (cost over NTE → an NTE override approval); the rules engine can
   raise any kind. Three lanes: For me (open tasks in my role's lane or
   claimed by me), Open (everything waiting) and Done. The filter row narrows
   by task type, billing entity, client, trade and who the task is for — each
   built from the rows themselves, so a filter never offers a value that
   matches nothing.

   One permission drives the decisions (approvals:approve); a verb the viewer
   may not use stays VISIBLE and locked with the reason — the same rule the
   Payments tab follows. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { APPROVALS_PERM_KEY, APPROVAL_TASK_TYPES } from '@theone/shared';
import type { ApprovalListItem, ApprovalTaskStatus, ApprovalTaskType } from '../api/client';
import {
  ApiRequestError,
  approveApprovalTask,
  claimApprovalTask,
  listApprovals,
  rejectApprovalTask,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { useAuth } from '../auth/AuthProvider';
import { usd } from '../lib/quoteTotals';
import { numericDate } from '../lib/fields';

type Lane = 'mine' | 'open' | 'done';

const LANE_LABEL: Record<Lane, string> = {
  mine: 'For me',
  open: 'Open',
  done: 'Done',
};

export const APPROVAL_STATUS_LABEL: Record<ApprovalTaskStatus, string> = {
  open: 'Open',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_CHIP: Record<ApprovalTaskStatus, string> = {
  open: 'chip-outline',
  approved: 'chip-accent',
  rejected: 'chip-danger',
  cancelled: '',
};

export const TYPE_LABEL: Record<ApprovalTaskType, string> = Object.fromEntries(
  APPROVAL_TASK_TYPES.map((t) => [t.code, t.label]),
) as Record<ApprovalTaskType, string>;

type DecisionKind = 'approve' | 'reject';

interface Pending {
  kind: DecisionKind;
  item: ApprovalListItem;
}

/** The five filters, '' = any. */
interface Filters {
  type: string;
  entity: string;
  client: string;
  trade: string;
  owner: string;
}

const NO_FILTERS: Filters = { type: '', entity: '', client: '', trade: '', owner: '' };

/** "For" column and filter value: whoever claimed it, else the role's lane. */
function ownerOf(i: ApprovalListItem): string {
  if (i.assigned_to) return i.assigned_to.display_name;
  return i.assigned_role_label ?? i.assigned_role ?? 'Any approver';
}

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const { can, actingAs } = useAuth();
  const canApprove = can(APPROVALS_PERM_KEY, 'approve');
  const myId = actingAs?.id ?? null;
  const myRole = actingAs?.role ?? null;

  const [lane, setLane] = useState<Lane>(canApprove ? 'mine' : 'open');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approvalsQuery = useQuery({ queryKey: ['approvals'], queryFn: listApprovals, retry: 0 });
  const items = approvalsQuery.data?.items ?? [];

  // "For me": open, and either claimed by me, or unclaimed and in my role's
  // lane (or in nobody's lane in particular).
  const isMine = (i: ApprovalListItem) =>
    i.status === 'open' &&
    (i.assigned_to
      ? i.assigned_to.id === myId
      : i.assigned_role === null || i.assigned_role === myRole);

  const inLane = (i: ApprovalListItem, l: Lane) =>
    l === 'mine' ? isMine(i) : l === 'open' ? i.status === 'open' : i.status !== 'open';

  const laneItems = useMemo(() => items.filter((i) => inLane(i, lane)), [items, lane, myId, myRole]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = useMemo(() => {
    const pick = (f: (i: ApprovalListItem) => string | null) =>
      [...new Set(laneItems.map(f).filter((v): v is string => !!v))].sort((a, b) =>
        a.localeCompare(b),
      );
    return {
      type: pick((i) => i.type),
      entity: pick((i) => i.billing_entity),
      client: pick((i) => i.client),
      trade: pick((i) => i.trade),
      owner: pick(ownerOf),
    };
  }, [laneItems]);

  const filtered = useMemo(
    () =>
      laneItems.filter(
        (i) =>
          (!filters.type || i.type === filters.type) &&
          (!filters.entity || i.billing_entity === filters.entity) &&
          (!filters.client || i.client === filters.client) &&
          (!filters.trade || i.trade === filters.trade) &&
          (!filters.owner || ownerOf(i) === filters.owner),
      ),
    [laneItems, filters],
  );

  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);
  const pageItems = filtered.slice(offset, offset + pageSize);

  const laneCount = (l: Lane): number | undefined =>
    approvalsQuery.data ? items.filter((i) => inLane(i, l)).length : undefined;

  const anyFilter = Object.values(filters).some(Boolean);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    // The Finances card and the audit trail on the work order show the same row.
    void queryClient.invalidateQueries({ queryKey: ['wo-approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-activity'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-feed'] });
  };

  const decide = useMutation({
    mutationFn: async ({ kind, item, text }: Pending & { text: string | null }) =>
      kind === 'approve' ? approveApprovalTask(item.id, text) : rejectApprovalTask(item.id, text ?? ''),
    onSuccess: () => {
      setPending(null);
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setPending(null);
      setError(err instanceof ApiRequestError ? err.message : 'The decision could not be saved.');
    },
  });

  const claim = useMutation({
    mutationFn: (item: ApprovalListItem) => claimApprovalTask(item.id),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setError(err instanceof ApiRequestError ? err.message : 'The task could not be claimed.');
    },
  });

  const notServed =
    approvalsQuery.error instanceof ApiRequestError && approvalsQuery.error.status === 404;

  const switchLane = (l: Lane) => {
    setLane(l);
    setFilters(NO_FILTERS);
    setOffset(0);
  };

  const setFilter = (k: keyof Filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const busy = decide.isPending || claim.isPending;

  return (
    <AppShell active="Approvals">
      <div className="page-head">
        <p className="page-sub">
          {approvalsQuery.isLoading
            ? 'Loading…'
            : `${filtered.length} task${filtered.length === 1 ? '' : 's'} · ${LANE_LABEL[lane].toLowerCase()}`}
        </p>
      </div>

      <div className="payq-head">
        <div className="seg payq-lanes" role="group" aria-label="Approval lanes">
          {(['mine', 'open', 'done'] as const).map((l) => {
            const n = laneCount(l);
            return (
              <button
                key={l}
                type="button"
                className={`seg-btn${lane === l ? ' is-on' : ''}`}
                aria-pressed={lane === l}
                onClick={() => switchLane(l)}
              >
                {LANE_LABEL[l]}
                {n !== undefined && (
                  <span className={`payq-count${l !== 'done' && n > 0 ? ' is-hot' : ''}`}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {!approvalsQuery.isError && (
        <div className="apq-filters" role="group" aria-label="Filter tasks">
          <FilterSelect
            label="Type"
            value={filters.type}
            options={options.type.map((t) => ({ value: t, label: TYPE_LABEL[t as ApprovalTaskType] ?? t }))}
            onChange={(v) => setFilter('type', v)}
          />
          <FilterSelect label="Entity" value={filters.entity} options={options.entity} onChange={(v) => setFilter('entity', v)} />
          <FilterSelect label="Client" value={filters.client} options={options.client} onChange={(v) => setFilter('client', v)} />
          <FilterSelect label="Trade" value={filters.trade} options={options.trade} onChange={(v) => setFilter('trade', v)} />
          <FilterSelect label="For" value={filters.owner} options={options.owner} onChange={(v) => setFilter('owner', v)} />
          {anyFilter && (
            <button type="button" className="linkbtn" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="payq-err" role="alert">
          <Icon name="alert-circle" size={14} />
          {error}
        </p>
      )}

      {approvalsQuery.isError && (
        <div className="quotes-empty">
          <Icon name="inbox" size={22} />
          <b>{notServed ? 'No approval tasks to list yet' : 'Could not load approval tasks'}</b>
          <span>
            {notServed
              ? 'Tasks are raised by automations — Admin › Automations is where the rules live.'
              : 'Is the API running on :5174?'}
          </span>
        </div>
      )}

      {!approvalsQuery.isError && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr>
                <th className="col-wo">WO #</th>
                <th className="col-client">Client / Title</th>
                <th>Task</th>
                <th>For</th>
                <th className="col-list">Raised</th>
                <th className="col-status">Status</th>
                <th className="payq-actions">Decision</th>
              </tr>
            </thead>
            <tbody>
              {approvalsQuery.isLoading && (
                <tr className="ct-empty"><td colSpan={7}>Loading approval tasks…</td></tr>
              )}
              {!approvalsQuery.isLoading && filtered.length === 0 && (
                <tr className="ct-empty">
                  <td colSpan={7}>
                    {anyFilter
                      ? 'Nothing matches these filters.'
                      : lane === 'mine'
                        ? 'Nothing is waiting on you.'
                        : lane === 'open'
                          ? 'Nothing is waiting for a decision.'
                          : 'No task has been decided yet.'}
                  </td>
                </tr>
              )}
              {pageItems.map((t) => (
                <TaskRow
                  key={t.id}
                  item={t}
                  myId={myId}
                  canApprove={canApprove}
                  busy={busy}
                  onDecide={(kind) => {
                    setError(null);
                    setPending({ kind, item: t });
                  }}
                  onClaim={() => {
                    setError(null);
                    claim.mutate(t);
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!approvalsQuery.isError && (
        <ListPagination
          total={approvalsQuery.isLoading ? undefined : filtered.length}
          offset={offset}
          limit={pageSize}
          noun="tasks"
          onOffsetChange={setOffset}
          onLimitChange={(n) => {
            setPageSize(n);
            setOffset(0);
          }}
        />
      )}

      {pending?.kind === 'approve' && (
        <TextDialog
          title={pending.item.type === 'nte_override' ? 'Approve this NTE override?' : 'Approve this task?'}
          item={pending.item}
          label="Note"
          hint={`Optional — posted as an internal update on ${pending.item.wo_number} so whoever is running the job sees the decision.`}
          multiline
          confirmLabel="Approve"
          busy={decide.isPending}
          onConfirm={(text) => decide.mutate({ ...pending, text: text.trim() || null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reject' && (
        <TextDialog
          title={pending.item.type === 'nte_override' ? 'Reject this NTE override' : 'Reject this task'}
          item={pending.item}
          label="Why is it being rejected?"
          hint={`Posted as an internal update on ${pending.item.wo_number} — feedback for whoever is running the job, never for the client.`}
          required
          multiline
          confirmLabel="Reject with note"
          danger
          busy={decide.isPending}
          onConfirm={(text) => decide.mutate({ ...pending, text })}
          onCancel={() => setPending(null)}
        />
      )}
    </AppShell>
  );
}

// ── One filter ───────────────────────────────────────────────────────────────

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: (string | { value: string; label: string })[];
  onChange: (v: string) => void;
}) {
  const rows = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <label className="apq-filter">
      <span>{label}</span>
      <select
        className="fld fld-sm"
        value={value}
        aria-label={`Filter by ${label.toLowerCase()}`}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Any</option>
        {rows.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

interface RowProps {
  item: ApprovalListItem;
  myId: string | null;
  canApprove: boolean;
  busy: boolean;
  onDecide: (kind: DecisionKind) => void;
  onClaim: () => void;
}

/** The numbers behind an NTE override, as a second line under the title. */
function detailLine(item: ApprovalListItem): string | null {
  if (item.type !== 'nte_override') return null;
  const d = item.detail as { cost?: number | null; nte?: number | null };
  if (typeof d.cost !== 'number' || typeof d.nte !== 'number') return null;
  return `Cost ${usd(d.cost)} · NTE ${usd(d.nte)}`;
}

function TaskRow({ item, myId, canApprove, busy, onDecide, onClaim }: RowProps) {
  const woHref = `/work-orders/${encodeURIComponent(item.wo_number)}`;
  const when = numericDate(item.created_at) ?? '—';
  const raisedBy = item.source?.name ?? item.created_by?.display_name ?? null;
  const numbers = detailLine(item);

  const trail =
    item.status === 'open'
      ? null
      : [
          item.decided_by ? `by ${item.decided_by.display_name}` : null,
          item.decided_at ? numericDate(item.decided_at) : null,
        ]
          .filter(Boolean)
          .join(' · ') || null;

  return (
    <tr>
      <td className="col-wo">
        <Link className="wo-num wo-num-link" to={woHref}>
          {item.wo_number}
        </Link>
      </td>
      <td className="col-client">
        <div className="site">
          <strong>{item.client ?? '—'}</strong>
          <small>{item.wo_title ?? '—'}</small>
        </div>
      </td>
      <td>
        <div className="site payq-who">
          <strong>
            <span className="chip chip-sm chip-outline apq-type">{TYPE_LABEL[item.type] ?? item.type}</span>
            {item.title}
          </strong>
          <small>{[numbers, item.billing_entity, item.trade].filter(Boolean).join(' · ')}</small>
        </div>
      </td>
      <td>
        <span className="payq-status">
          <span>{ownerOf(item)}</span>
          {item.assigned_to && item.assigned_role_label && <small>{item.assigned_role_label} lane</small>}
        </span>
      </td>
      <td className="col-list">
        <span className="payq-status">
          <span>{when}</span>
          {raisedBy && <small>{raisedBy}</small>}
        </span>
      </td>
      <td className="col-status">
        <span className="payq-status">
          <span className={`chip chip-sm ${STATUS_CHIP[item.status]}`.trim()}>
            {APPROVAL_STATUS_LABEL[item.status]}
          </span>
          {trail && <small title={item.decision_note ?? trail}>{trail}</small>}
          {item.status !== 'open' && item.decision_note && (
            <small className="apq-note" title={item.decision_note}>{item.decision_note}</small>
          )}
        </span>
      </td>
      <td className="payq-actions">
        <Decisions
          item={item}
          myId={myId}
          canApprove={canApprove}
          busy={busy}
          onDecide={onDecide}
          onClaim={onClaim}
        />
      </td>
    </tr>
  );
}

/** The verbs a row offers at its status. A verb the viewer may not use is
    drawn locked with the reason — the rule is "visible, never hidden". */
function Decisions({ item, myId, canApprove, busy, onDecide, onClaim }: RowProps) {
  const verb = (
    label: string,
    icon: 'check' | 'x' | 'user',
    allowed: boolean,
    reason: string,
    onClick: () => void,
    tone: 'primary' | 'danger' | 'plain' = 'plain',
    id = label.toLowerCase(),
  ) =>
    allowed ? (
      <button
        type="button"
        className={`btn-sm${tone === 'danger' ? ' is-danger' : tone === 'plain' ? ' is-ghost' : ''}`}
        aria-disabled={busy ? true : undefined}
        onClick={() => !busy && onClick()}
      >
        <Icon name={icon} size={12} />
        {label}
      </button>
    ) : (
      <span className="tipwrap">
        <button
          type="button"
          className="btn-sm is-ghost btn-locked"
          tabIndex={0}
          aria-disabled="true"
          aria-describedby={`lock-${id}-${item.id}`}
        >
          <Icon name="lock" size={12} />
          {label}
        </button>
        <span className="tip" id={`lock-${id}-${item.id}`} role="tooltip">
          <Icon name="lock" size={12} />
          {reason}
        </span>
      </span>
    );

  if (item.status !== 'open') {
    return <span className="payq-done">{APPROVAL_STATUS_LABEL[item.status]}</span>;
  }
  const claimedByMe = item.assigned_to?.id === myId;
  return (
    <>
      {!claimedByMe &&
        verb('Claim', 'user', canApprove, 'Requires approval rights', onClaim, 'plain')}
      {verb('Reject', 'x', canApprove, 'Requires approval rights', () => onDecide('reject'), 'danger')}
      {verb('Approve', 'check', canApprove, 'Requires approval rights', () => onDecide('approve'), 'primary')}
    </>
  );
}

// ── A one-field decision dialog (approval note, rejection reason) ────────────

interface TextDialogProps {
  title: string;
  item: ApprovalListItem;
  label: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  confirmLabel: string;
  danger?: boolean;
  busy: boolean;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

function TextDialog({
  title,
  item,
  label,
  hint,
  required,
  multiline,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: TextDialogProps) {
  const [text, setText] = useState('');
  const ok = !required || text.trim().length > 0;
  const fieldId = `apq-text-${item.id}`;
  const numbers = detailLine(item);

  return (
    <div className="modal-scrim" onClick={busy ? undefined : onCancel} role="presentation">
      <div
        className={`modal is-narrow confirm payq-dialog is-${danger ? 'danger' : 'info'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="apq-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head confirm-head">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name={danger ? 'x' : 'check-circle'} size={18} />
          </span>
          <h2 id="apq-dialog-title">{title}</h2>
        </div>
        <div className="modal-body">
          <dl className="kv">
            <dt>Task</dt>
            <dd>{item.title}</dd>
            {numbers && (
              <>
                <dt>Numbers</dt>
                <dd>{numbers}</dd>
              </>
            )}
            <dt>Work order</dt>
            <dd>{item.wo_number}{item.client ? ` · ${item.client}` : ''}</dd>
          </dl>
          <div className="field">
            <label className="lbl" htmlFor={fieldId}>
              {label}
              {required && <span className="req" aria-hidden="true"> *</span>}
            </label>
            {multiline ? (
              <textarea
                className="fld"
                id={fieldId}
                rows={3}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
            ) : (
              <input
                className="fld"
                id={fieldId}
                type="text"
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && ok && !busy) onConfirm(text);
                }}
              />
            )}
            {hint && <span className="hint">{hint}</span>}
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-sm is-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn-sm${danger ? ' is-danger' : ''}`}
            onClick={() => ok && onConfirm(text)}
            disabled={busy || !ok}
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

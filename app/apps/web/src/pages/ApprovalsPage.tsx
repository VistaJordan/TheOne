/* /approvals — the manager's inbox (0020), in sections.

   Everything that waits on somebody with authority, across every live work
   order, in one list with one row shape (rule 7.2.1):

     NTE increases     approval tasks of type nte_override — rule 1.5.2 raises
                       one when the cost passes the client NTE
     Manager reviews   approval tasks of type manager_review (any rule can raise
                       one); the section only shows once one exists
     Quotes            quotes sitting in "pending approval"
     Payments          technician payment requests sitting in "requested"

   The section switcher narrows the list; "All" is the unified queue. Three
   lanes cut across the sections: For me (open, and mine to decide), Open
   (everything waiting) and Done. Open rows sort OLDEST first (rule 7.2.2 —
   the escalation flag that would pin rows to the top does not exist yet);
   decided rows newest first. Every decision is taken one row at a time
   (rule 7.2.3: no bulk actions).

   The second half of rule 1.5.2 shows here too: while an NTE override is open
   on a work order, the quote and payment rows of that work order draw their
   Approve verb locked — the API refuses the move with a 409 regardless, this
   just says so before the click. A verb the viewer may not use stays VISIBLE
   and locked with the reason — the same rule the Payments tab follows. */

import { Fragment, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { APPROVALS_PERM_KEY, APPROVAL_TASK_TYPES } from '@theone/shared';
import type {
  ApprovalListItem,
  ApprovalTaskStatus,
  ApprovalTaskType,
  PaymentListItem,
  QuoteListItem,
} from '../api/client';
import {
  ApiRequestError,
  approveApprovalTask,
  approvePayment,
  approveQuote,
  claimApprovalTask,
  listApprovals,
  listPayments,
  listQuotes,
  rejectApprovalTask,
  rejectPayment,
  rejectQuote,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { ColumnsMenu, type ColumnChoice } from '../components/wo/list/ColumnsMenu';
import { PAYMENT_STATUS_LABEL, payeeLabel } from '../components/payments/PaymentsTable';
import { QUOTE_STATUS } from '../components/quote/QuoteStatusPill';
import { useAuth } from '../auth/AuthProvider';
import { usd } from '../lib/quoteTotals';
import { isCostOverNte, numericDate } from '../lib/fields';

// ── Vocabulary ───────────────────────────────────────────────────────────────

type Lane = 'mine' | 'open' | 'done';

const LANE_LABEL: Record<Lane, string> = {
  mine: 'For me',
  open: 'Open',
  done: 'Done',
};

/** The sections. 'all' is the unified queue; the rest are one kind each. */
type Section = 'all' | 'nte' | 'review' | 'quotes' | 'payments';
type Kind = Exclude<Section, 'all'>;

const SECTION_LABEL: Record<Section, string> = {
  all: 'All',
  nte: 'NTE increases',
  review: 'Manager reviews',
  quotes: 'Quotes',
  payments: 'Payments',
};

/** The chip in the task cell — what kind of thing the row is. */
const KIND_CHIP: Record<Kind, string> = {
  nte: 'NTE increase',
  review: 'Review',
  quotes: 'Quote',
  payments: 'Payment',
};

export const APPROVAL_STATUS_LABEL: Record<ApprovalTaskStatus, string> = {
  open: 'Open',
  approved: 'Approved',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

export const TYPE_LABEL: Record<ApprovalTaskType, string> = Object.fromEntries(
  APPROVAL_TASK_TYPES.map((t) => [t.code, t.label]),
) as Record<ApprovalTaskType, string>;

/** Rule 1.5.2's hold, as the locked verb explains it. */
const NTE_HOLD = 'On hold — the NTE override on this work order has to be decided first (rule 1.5.2)';

// ── Columns ──────────────────────────────────────────────────────────────────
// WO # opens the row and Decision acts on it, so those two are always there,
// first and last. Everything between is chosen from the Columns menu, in the
// order chosen, and remembered per browser like the header fold.

type ColumnKey = 'client' | 'ask' | 'nte' | 'cost' | 'due' | 'owner' | 'raised' | 'status';

const COLUMN_CHOICES: (ColumnChoice & { key: ColumnKey })[] = [
  { key: 'client', label: 'Client' },
  { key: 'ask', label: 'Waiting for' },
  { key: 'nte', label: 'NTE' },
  { key: 'cost', label: 'Cost' },
  { key: 'due', label: 'WO Due Date' },
  { key: 'owner', label: 'For' },
  { key: 'raised', label: 'Raised' },
  { key: 'status', label: 'Status' },
];

const DEFAULT_COLUMNS: ColumnKey[] = ['client', 'ask', 'nte', 'cost', 'due', 'owner', 'raised', 'status'];

const COLUMNS_KEY = 'theone.approvals.columns';

function loadColumns(): ColumnKey[] {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    if (!raw) return DEFAULT_COLUMNS;
    const known = new Set<string>(COLUMN_CHOICES.map((c) => c.key));
    const parsed = (JSON.parse(raw) as unknown[]).filter(
      (k): k is ColumnKey => typeof k === 'string' && known.has(k),
    );
    return parsed.length > 0 ? parsed : DEFAULT_COLUMNS;
  } catch {
    return DEFAULT_COLUMNS;
  }
}

function saveColumns(cols: ColumnKey[]): void {
  try {
    localStorage.setItem(COLUMNS_KEY, JSON.stringify(cols));
  } catch {
    /* storage disabled — the choice simply does not survive the reload */
  }
}

/** Header cell class per column: money right-aligned, dates narrow. */
const COLUMN_CLASS: Partial<Record<ColumnKey, string>> = {
  client: 'col-client',
  nte: 'num',
  cost: 'num',
  due: 'col-date',
  raised: 'col-date',
  status: 'col-status',
};

// ── One row shape for three kinds of thing ───────────────────────────────────

type RowData =
  | { kind: 'task'; item: ApprovalListItem }
  | { kind: 'quote'; item: QuoteListItem }
  | { kind: 'payment'; item: PaymentListItem };

interface Row {
  key: string;
  section: Kind;
  task_id: string;
  wo_number: string;
  wo_title: string | null;
  client: string | null;
  billing_entity: string | null;
  trade: string | null;
  /** The work order's own numbers, as they stand now. */
  due: string | null;
  nte: number | null;
  cost: number | null;
  /** When it started waiting — ISO, for the sort and the Raised column. */
  raised_at: string;
  /** Still waiting for a decision. */
  open: boolean;
  /** Open AND in my lane: claimed by me, or unclaimed and mine to decide. */
  mine: boolean;
  /** "For" column and filter value. */
  owner: string;
  /** Status chip + the line under it. */
  status: { label: string; chip: string; trail: string | null; note: string | null };
  /** Rule 1.5.2: an open NTE override on this work order holds the money moves. */
  held: boolean;
  data: RowData;
}

const TASK_CHIP: Record<ApprovalTaskStatus, string> = {
  open: 'chip-outline',
  approved: 'chip-accent',
  rejected: 'chip-danger',
  cancelled: '',
};

/** The numbers behind an NTE override, as a second line under the title. */
function nteNumbers(item: ApprovalListItem): string | null {
  if (item.type !== 'nte_override') return null;
  const d = item.detail as { cost?: number | null; nte?: number | null };
  if (typeof d.cost !== 'number' || typeof d.nte !== 'number') return null;
  return `Cost ${usd(d.cost)} · NTE ${usd(d.nte)}`;
}

function taskRow(
  item: ApprovalListItem,
  myId: string | null,
  myRole: string | null,
  held: Set<string>,
): Row {
  const open = item.status === 'open';
  const mine =
    open &&
    (item.assigned_to
      ? item.assigned_to.id === myId
      : item.assigned_role === null || item.assigned_role === myRole);
  const trail = open
    ? null
    : [
        item.decided_by ? `by ${item.decided_by.display_name}` : null,
        item.decided_at ? numericDate(item.decided_at) : null,
      ]
        .filter(Boolean)
        .join(' · ') || null;
  return {
    key: `task:${item.id}`,
    section: item.type === 'nte_override' ? 'nte' : 'review',
    task_id: item.task_id,
    wo_number: item.wo_number,
    wo_title: item.wo_title,
    client: item.client,
    billing_entity: item.billing_entity,
    trade: item.trade,
    due: item.wo_due,
    nte: item.wo_nte,
    cost: item.wo_cost,
    raised_at: item.created_at,
    open,
    mine,
    owner: item.assigned_to
      ? item.assigned_to.display_name
      : (item.assigned_role_label ?? item.assigned_role ?? 'Any approver'),
    status: {
      label: APPROVAL_STATUS_LABEL[item.status],
      chip: TASK_CHIP[item.status],
      trail,
      note: open ? null : item.decision_note,
    },
    // The NTE task IS the hold; it is never held by itself.
    held: item.type !== 'nte_override' && held.has(item.task_id),
    data: { kind: 'task', item },
  };
}

function quoteRow(item: QuoteListItem, canDecide: boolean, held: Set<string>): Row {
  const open = item.status === 'pending_approval';
  return {
    key: `quote:${item.id}`,
    section: 'quotes',
    task_id: item.task_id,
    wo_number: item.wo_number,
    wo_title: item.title,
    client: item.client,
    billing_entity: null,
    trade: null,
    due: item.wo_due,
    nte: item.wo_nte,
    cost: item.wo_cost,
    raised_at: item.updated_at ?? '',
    open,
    mine: open && canDecide,
    owner: 'Quote approvers',
    status: {
      label: QUOTE_STATUS[item.status]?.label ?? item.status,
      chip: open ? 'chip-outline' : 'chip-accent',
      trail: open ? null : numericDate(item.updated_at),
      note: null,
    },
    held: held.has(item.task_id),
    data: { kind: 'quote', item },
  };
}

const PAYMENT_CHIP: Record<PaymentListItem['status'], string> = {
  requested: 'chip-outline',
  approved: '',
  sent_to_yoda: '',
  paid: 'chip-accent',
  rejected: 'chip-danger',
};

function paymentRow(item: PaymentListItem, canDecide: boolean, held: Set<string>): Row {
  const open = item.status === 'requested';
  const by =
    item.status === 'rejected'
      ? item.rejected_by
      : item.status === 'paid'
        ? item.paid_by
        : item.status === 'sent_to_yoda'
          ? item.sent_to_yoda_by
          : item.status === 'approved'
            ? item.approved_by
            : null;
  const when =
    item.status === 'rejected'
      ? item.rejected_at
      : item.status === 'paid'
        ? item.paid_at
        : item.status === 'sent_to_yoda'
          ? item.sent_to_yoda_at
          : item.status === 'approved'
            ? item.approved_at
            : null;
  return {
    key: `payment:${item.id}`,
    section: 'payments',
    task_id: item.task_id,
    wo_number: item.wo_number,
    wo_title: item.title,
    client: item.client,
    billing_entity: null,
    trade: null,
    due: item.wo_due,
    nte: item.wo_nte,
    cost: item.wo_cost,
    raised_at: item.created_at,
    open,
    mine: open && canDecide,
    owner: 'Payment approvers',
    status: {
      label: PAYMENT_STATUS_LABEL[item.status],
      chip: PAYMENT_CHIP[item.status],
      trail: open
        ? null
        : [by ? `by ${by.display_name}` : null, when ? numericDate(when) : null]
            .filter(Boolean)
            .join(' · ') || null,
      note: item.status === 'rejected' ? item.rejection_note : null,
    },
    held: item.nte_override_open || held.has(item.task_id),
    data: { kind: 'payment', item },
  };
}

// ── Decisions ────────────────────────────────────────────────────────────────

type DecisionKind = 'approve' | 'reject' | 'claim';

interface Pending {
  kind: DecisionKind;
  row: Row;
}

/** The four filters, '' = any. Sections replaced the old Type filter. */
interface Filters {
  entity: string;
  client: string;
  trade: string;
  owner: string;
}

const NO_FILTERS: Filters = { entity: '', client: '', trade: '', owner: '' };

export function ApprovalsPage() {
  const queryClient = useQueryClient();
  const { can, actingAs } = useAuth();
  const canApproveTasks = can(APPROVALS_PERM_KEY, 'approve');
  const canSeeQuotes = can('quotes', 'view');
  const canApproveQuotes = can('quotes', 'approve');
  const canSeePayments = can('payments', 'view');
  const canApprovePayments = can('payments', 'approve');
  const canDecideAnything = canApproveTasks || canApproveQuotes || canApprovePayments;
  const myId = actingAs?.id ?? null;
  const myRole = actingAs?.role ?? null;

  const [section, setSection] = useState<Section>('all');
  const [columns, setColumns] = useState<ColumnKey[]>(loadColumns);
  const changeColumns = (next: string[]) => {
    const known = new Set<string>(COLUMN_CHOICES.map((c) => c.key));
    const cols = next.filter((k): k is ColumnKey => known.has(k));
    setColumns(cols);
    saveColumns(cols);
  };
  const [lane, setLane] = useState<Lane>(canDecideAnything ? 'mine' : 'open');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approvalsQuery = useQuery({ queryKey: ['approvals'], queryFn: listApprovals, retry: 0 });
  // The two other sources are read only when the viewer may see them; a section
  // the viewer cannot see simply is not offered.
  const quotesQuery = useQuery({
    queryKey: ['quotes'],
    queryFn: listQuotes,
    retry: 0,
    enabled: canSeeQuotes,
  });
  const paymentsQuery = useQuery({
    queryKey: ['payments'],
    queryFn: listPayments,
    retry: 0,
    enabled: canSeePayments,
  });

  const rows = useMemo<Row[]>(() => {
    const tasks = approvalsQuery.data?.items ?? [];
    const held = new Set(
      tasks.filter((t) => t.type === 'nte_override' && t.status === 'open').map((t) => t.task_id),
    );
    const out: Row[] = tasks.map((t) => taskRow(t, myId, myRole, held));
    for (const q of quotesQuery.data?.items ?? []) {
      // A draft is nobody's to approve yet; it enters the inbox on submit.
      if (q.status === 'draft') continue;
      out.push(quoteRow(q, canApproveQuotes, held));
    }
    for (const p of paymentsQuery.data?.items ?? []) out.push(paymentRow(p, canApprovePayments, held));
    return out;
  }, [approvalsQuery.data, quotesQuery.data, paymentsQuery.data, myId, myRole, canApproveQuotes, canApprovePayments]);

  const inLane = (r: Row, l: Lane) => (l === 'mine' ? r.mine : l === 'open' ? r.open : !r.open);
  const inSection = (r: Row, s: Section) => s === 'all' || r.section === s;

  const laneRows = useMemo(() => rows.filter((r) => inLane(r, lane)), [rows, lane]);
  const sectionRows = useMemo(
    () => laneRows.filter((r) => inSection(r, section)),
    [laneRows, section],
  );

  const options = useMemo(() => {
    const pick = (f: (r: Row) => string | null) =>
      [...new Set(sectionRows.map(f).filter((v): v is string => !!v))].sort((a, b) =>
        a.localeCompare(b),
      );
    return {
      entity: pick((r) => r.billing_entity),
      client: pick((r) => r.client),
      trade: pick((r) => r.trade),
      owner: pick((r) => r.owner),
    };
  }, [sectionRows]);

  const filtered = useMemo(() => {
    const hit = sectionRows.filter(
      (r) =>
        (!filters.entity || r.billing_entity === filters.entity) &&
        (!filters.client || r.client === filters.client) &&
        (!filters.trade || r.trade === filters.trade) &&
        (!filters.owner || r.owner === filters.owner),
    );
    // Rule 7.2.2: what waits sorts oldest first; what is done, newest first.
    const dir = lane === 'done' ? -1 : 1;
    return hit.sort((a, b) => dir * a.raised_at.localeCompare(b.raised_at));
  }, [sectionRows, filters, lane]);

  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);
  const pageRows = filtered.slice(offset, offset + pageSize);

  const loaded = approvalsQuery.data !== undefined;
  const laneCount = (l: Lane): number | undefined =>
    loaded ? rows.filter((r) => inLane(r, l) && inSection(r, section)).length : undefined;
  const sectionCount = (s: Section): number | undefined =>
    loaded ? laneRows.filter((r) => inSection(r, s)).length : undefined;

  // Which sections to offer: the two task kinds always (reviews only once one
  // exists), quotes and payments when the viewer may see them.
  const sections: Section[] = [
    'all',
    'nte',
    ...(rows.some((r) => r.section === 'review') ? (['review'] as Section[]) : []),
    ...(canSeeQuotes ? (['quotes'] as Section[]) : []),
    ...(canSeePayments ? (['payments'] as Section[]) : []),
  ];

  const anyFilter = Object.values(filters).some(Boolean);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['quotes'] });
    void queryClient.invalidateQueries({ queryKey: ['payments'] });
    // The work order's cards and audit trail show the same rows.
    void queryClient.invalidateQueries({ queryKey: ['wo-approvals'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-payments'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-quote'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-activity'] });
    void queryClient.invalidateQueries({ queryKey: ['wo-feed'] });
  };

  const decide = useMutation({
    mutationFn: async ({ kind, row, text }: Pending & { text: string | null }) => {
      const d = row.data;
      if (kind === 'claim') {
        if (d.kind !== 'task') throw new Error('Only tasks can be claimed');
        return claimApprovalTask(d.item.id);
      }
      switch (d.kind) {
        case 'task':
          return kind === 'approve'
            ? approveApprovalTask(d.item.id, text)
            : rejectApprovalTask(d.item.id, text ?? '');
        case 'quote':
          return kind === 'approve'
            ? approveQuote(d.item.wo_number)
            : rejectQuote(d.item.wo_number, text ?? '');
        case 'payment':
          return kind === 'approve' ? approvePayment(d.item.id) : rejectPayment(d.item.id, text ?? '');
      }
    },
    onSuccess: () => {
      setPending(null);
      setError(null);
      invalidate();
    },
    onError: (err) => {
      setPending(null);
      setError(err instanceof ApiRequestError ? err.message : 'The decision could not be saved.');
      // A 409 means the numbers moved under us — reload so the hold shows.
      if (err instanceof ApiRequestError && err.status === 409) invalidate();
    },
  });

  const notServed =
    approvalsQuery.error instanceof ApiRequestError && approvalsQuery.error.status === 404;

  const switchLane = (l: Lane) => {
    setLane(l);
    setFilters(NO_FILTERS);
    setOffset(0);
  };

  const switchSection = (s: Section) => {
    setSection(s);
    setFilters(NO_FILTERS);
    setOffset(0);
  };

  const setFilter = (k: keyof Filters, v: string) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setOffset(0);
  };

  const busy = decide.isPending;
  const loading = approvalsQuery.isLoading || quotesQuery.isLoading || paymentsQuery.isLoading;

  const emptyText = anyFilter
    ? 'Nothing matches these filters.'
    : lane === 'mine'
      ? 'Nothing is waiting on you.'
      : lane === 'open'
        ? section === 'all'
          ? 'Nothing is waiting for a decision.'
          : `No ${SECTION_LABEL[section].toLowerCase()} are waiting for a decision.`
        : 'Nothing has been decided yet.';

  return (
    <AppShell active="Approvals">
      <div className="page-head">
        <p className="page-sub">
          {loading
            ? 'Loading…'
            : `${filtered.length} item${filtered.length === 1 ? '' : 's'} · ${
                section === 'all' ? 'all sections' : SECTION_LABEL[section].toLowerCase()
              } · ${LANE_LABEL[lane].toLowerCase()}`}
        </p>
      </div>

      <div className="payq-head">
        <div className="seg payq-lanes apq-sections" role="group" aria-label="Approval sections">
          {sections.map((s) => {
            const n = sectionCount(s);
            return (
              <button
                key={s}
                type="button"
                className={`seg-btn${section === s ? ' is-on' : ''}`}
                aria-pressed={section === s}
                onClick={() => switchSection(s)}
              >
                {SECTION_LABEL[s]}
                {n !== undefined && (
                  <span className={`payq-count${lane !== 'done' && n > 0 ? ' is-hot' : ''}`}>{n}</span>
                )}
              </button>
            );
          })}
        </div>
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
        <div className="apq-filters" role="group" aria-label="Filter the list">
          <FilterSelect label="Entity" value={filters.entity} options={options.entity} onChange={(v) => setFilter('entity', v)} />
          <FilterSelect label="Client" value={filters.client} options={options.client} onChange={(v) => setFilter('client', v)} />
          <FilterSelect label="Trade" value={filters.trade} options={options.trade} onChange={(v) => setFilter('trade', v)} />
          <FilterSelect label="For" value={filters.owner} options={options.owner} onChange={(v) => setFilter('owner', v)} />
          {anyFilter && (
            <button type="button" className="linkbtn" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </button>
          )}
          <div className="apq-columns">
            <ColumnsMenu
              fields={COLUMN_CHOICES}
              columns={columns}
              defaults={DEFAULT_COLUMNS}
              onChange={changeColumns}
            />
          </div>
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
                {columns.map((k) => (
                  <th key={k} className={COLUMN_CLASS[k]}>
                    {COLUMN_CHOICES.find((c) => c.key === k)?.label}
                  </th>
                ))}
                <th className="payq-actions">Decision</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr className="ct-empty"><td colSpan={columns.length + 2}>Loading the inbox…</td></tr>
              )}
              {!loading && filtered.length === 0 && (
                <tr className="ct-empty"><td colSpan={columns.length + 2}>{emptyText}</td></tr>
              )}
              {pageRows.map((r) => (
                <InboxRow
                  key={r.key}
                  row={r}
                  columns={columns}
                  myId={myId}
                  canApproveTasks={canApproveTasks}
                  canApproveQuotes={canApproveQuotes}
                  canApprovePayments={canApprovePayments}
                  busy={busy}
                  onDecide={(kind) => {
                    setError(null);
                    if (kind === 'claim') decide.mutate({ kind, row: r, text: null });
                    else setPending({ kind, row: r });
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!approvalsQuery.isError && (
        <ListPagination
          total={loading ? undefined : filtered.length}
          offset={offset}
          limit={pageSize}
          noun="items"
          onOffsetChange={setOffset}
          onLimitChange={(n) => {
            setPageSize(n);
            setOffset(0);
          }}
        />
      )}

      {pending?.kind === 'approve' && pending.row.data.kind === 'task' && (
        <TextDialog
          title={
            pending.row.data.item.type === 'nte_override'
              ? 'Approve this NTE increase?'
              : 'Approve this task?'
          }
          facts={facts(pending.row)}
          idKey={pending.row.key}
          label="Note"
          hint={`Optional — posted as an internal update on ${pending.row.wo_number} so whoever is running the job sees the decision.`}
          multiline
          confirmLabel="Approve"
          busy={busy}
          onConfirm={(text) => decide.mutate({ ...pending, text: text.trim() || null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'approve' && pending.row.data.kind === 'quote' && (
        <ConfirmDialog
          title="Approve this quote?"
          icon="check-circle"
          message={
            <>
              Quote for <b>{usd(pending.row.data.item.grand_total)}</b> on {pending.row.wo_number}
              {pending.row.client ? ` · ${pending.row.client}` : ''}.
            </>
          }
          note="Approving fills the work order's quote amount. Sending it to the client's CMMS is a separate step in the quote builder."
          noteTone="info"
          confirmLabel="Approve quote"
          busy={busy}
          busyLabel="Approving…"
          onConfirm={() => decide.mutate({ ...pending, text: null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'approve' && pending.row.data.kind === 'payment' && (
        <ConfirmDialog
          title="Approve this payment?"
          icon="check-circle"
          message={
            <>
              {usd(pending.row.data.item.amount)} to <b>{payeeLabel(pending.row.data.item)}</b> for{' '}
              {pending.row.data.item.purpose} on {pending.row.wo_number}.
            </>
          }
          note="Approving clears it for AP to send to Yoda. Nothing is paid until AP does."
          noteTone="info"
          confirmLabel="Approve payment"
          busy={busy}
          busyLabel="Approving…"
          onConfirm={() => decide.mutate({ ...pending, text: null })}
          onCancel={() => setPending(null)}
        />
      )}

      {pending?.kind === 'reject' && (
        <TextDialog
          title={
            pending.row.data.kind === 'quote'
              ? 'Return this quote to draft'
              : pending.row.data.kind === 'payment'
                ? 'Reject this payment'
                : pending.row.data.item.type === 'nte_override'
                  ? 'Reject this NTE increase'
                  : 'Reject this task'
          }
          facts={facts(pending.row)}
          idKey={pending.row.key}
          label="Why is it being rejected?"
          hint={`Posted as an internal update on ${pending.row.wo_number} — feedback for whoever is running the job, never for the client.`}
          required
          multiline
          confirmLabel="Reject with note"
          danger
          busy={busy}
          onConfirm={(text) => decide.mutate({ ...pending, text })}
          onCancel={() => setPending(null)}
        />
      )}
    </AppShell>
  );
}

/** The key/value block at the top of a decision dialog, per row kind. */
function facts(row: Row): { k: string; v: string }[] {
  const wo = `${row.wo_number}${row.client ? ` · ${row.client}` : ''}`;
  switch (row.data.kind) {
    case 'task': {
      const numbers = nteNumbers(row.data.item);
      return [
        { k: 'Task', v: row.data.item.title },
        ...(numbers ? [{ k: 'Numbers', v: numbers }] : []),
        { k: 'Work order', v: wo },
      ];
    }
    case 'quote':
      return [
        { k: 'Quote', v: `${usd(row.data.item.grand_total)} · ${QUOTE_STATUS[row.data.item.status]?.label ?? row.data.item.status}` },
        { k: 'Work order', v: wo },
      ];
    case 'payment':
      return [
        { k: 'Payment', v: `${usd(row.data.item.amount)} to ${payeeLabel(row.data.item)}` },
        { k: 'Purpose', v: row.data.item.purpose },
        { k: 'Work order', v: wo },
      ];
  }
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
  options: string[];
  onChange: (v: string) => void;
}) {
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
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

// ── One row ──────────────────────────────────────────────────────────────────

interface RowProps {
  row: Row;
  columns: ColumnKey[];
  myId: string | null;
  canApproveTasks: boolean;
  canApproveQuotes: boolean;
  canApprovePayments: boolean;
  busy: boolean;
  onDecide: (kind: DecisionKind) => void;
}

/** The "Waiting for" cell: what the row asks, one strong line and one small. */
function Ask({ row }: { row: Row }) {
  const chip = <span className="chip chip-sm chip-outline apq-type">{KIND_CHIP[row.section]}</span>;
  const d = row.data;
  switch (d.kind) {
    case 'task': {
      // NTE increase: the NTE and Cost columns carry the numbers; the cell
      // says only how far over. Other task kinds keep their title.
      const over =
        d.item.type === 'nte_override' && row.cost != null && row.nte != null
          ? row.cost - row.nte
          : null;
      return (
        <div className="site payq-who">
          <strong>
            {chip}
            {over != null ? (
              <span className="apq-over">{usd(over)} over</span>
            ) : d.item.type === 'nte_override' ? (
              'Cost is over the client NTE'
            ) : (
              d.item.title
            )}
          </strong>
        </div>
      );
    }
    case 'quote': {
      const href = `/work-orders/${encodeURIComponent(d.item.wo_number)}/quote`;
      return (
        <div className="site payq-who">
          <strong>
            {chip}
            {`Quote ${usd(d.item.grand_total)}`}
          </strong>
          <small>
            <Link to={href}>Open the quote</Link>
            {row.held && ` · ${NTE_HOLD}`}
          </small>
        </div>
      );
    }
    case 'payment':
      return (
        <div className="site payq-who">
          <strong>
            {chip}
            {usd(d.item.amount)} to {payeeLabel(d.item)}
          </strong>
          <small>
            {[d.item.purpose, d.item.method].filter(Boolean).join(' · ')}
            {row.held && ` · ${NTE_HOLD}`}
          </small>
        </div>
      );
  }
}

function InboxRow(props: RowProps) {
  const { row } = props;
  const woHref = `/work-orders/${encodeURIComponent(row.wo_number)}`;
  const when = numericDate(row.raised_at) ?? '—';
  // Who raised it — a person's name only. A rule-raised task says nothing
  // here: the kind chip already says what it is.
  const raisedBy =
    row.data.kind === 'task'
      ? (row.data.item.source ? null : (row.data.item.created_by?.display_name ?? null))
      : row.data.kind === 'payment'
        ? (row.data.item.requested_by?.display_name ?? null)
        : null;
  const overNte = isCostOverNte(row.cost, row.nte);
  const lane =
    row.data.kind === 'task' && row.data.item.assigned_to && row.data.item.assigned_role_label
      ? `${row.data.item.assigned_role_label} lane`
      : null;

  /** One cell per chosen column, in the chosen order. */
  const cell = (k: ColumnKey) => {
    switch (k) {
      case 'client':
        return (
          <td key={k} className="col-client">
            {/* The work-order title is one click away on the WO number; here it
                only pushed the money off to the right. It stays as hover text. */}
            <strong title={row.wo_title ?? undefined}>{row.client ?? '—'}</strong>
          </td>
        );
      case 'ask':
        return (
          <td key={k}>
            <Ask row={row} />
          </td>
        );
      case 'nte':
        return <td key={k} className="num">{row.nte == null ? '—' : usd(row.nte)}</td>;
      case 'cost':
        return (
          <td
            key={k}
            className={`num${overNte ? ' is-over-nte' : ''}`}
            title={overNte ? 'Cost is above the client NTE' : undefined}
          >
            {row.cost == null ? '—' : usd(row.cost)}
          </td>
        );
      case 'due':
        return <td key={k} className="col-date">{numericDate(row.due) ?? '—'}</td>;
      case 'owner':
        return (
          <td key={k}>
            <span className="payq-status">
              <span>{row.owner}</span>
              {lane && <small>{lane}</small>}
            </span>
          </td>
        );
      case 'raised':
        return (
          <td key={k} className="col-date">
            <span className="payq-status">
              <span>{when}</span>
              {raisedBy && <small>{raisedBy}</small>}
            </span>
          </td>
        );
      case 'status':
        return (
          <td key={k} className="col-status">
            <span className="payq-status">
              <span className={`chip chip-sm ${row.status.chip}`.trim()}>{row.status.label}</span>
              {row.status.trail && (
                <small title={row.status.note ?? row.status.trail}>{row.status.trail}</small>
              )}
              {row.status.note && (
                <small className="apq-note" title={row.status.note}>{row.status.note}</small>
              )}
            </span>
          </td>
        );
    }
  };

  return (
    <tr className={row.held && row.open ? 'apq-held' : undefined}>
      <td className="col-wo">
        <Link className="wo-num wo-num-link" to={woHref}>
          {row.wo_number}
        </Link>
      </td>
      {props.columns.map(cell)}
      <td className="payq-actions">
        <Decisions {...props} />
      </td>
    </tr>
  );
}

/** The verbs a row offers at its status. A verb the viewer may not use is
    drawn locked with the reason — the rule is "visible, never hidden". */
function Decisions({ row, myId, canApproveTasks, canApproveQuotes, canApprovePayments, busy, onDecide }: RowProps) {
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
          aria-describedby={`lock-${id}-${row.key}`}
        >
          <Icon name="lock" size={12} />
          {label}
        </button>
        <span className="tip" id={`lock-${id}-${row.key}`} role="tooltip">
          <Icon name="lock" size={12} />
          {reason}
        </span>
      </span>
    );

  if (!row.open) return <span className="payq-done">{row.status.label}</span>;

  const d = row.data;
  switch (d.kind) {
    case 'task': {
      const claimedByMe = d.item.assigned_to?.id === myId;
      return (
        <>
          {!claimedByMe &&
            verb('Claim', 'user', canApproveTasks, 'Requires approval rights', () => onDecide('claim'), 'plain')}
          {verb('Reject', 'x', canApproveTasks, 'Requires approval rights', () => onDecide('reject'), 'danger')}
          {verb('Approve', 'check', canApproveTasks, 'Requires approval rights', () => onDecide('approve'), 'primary')}
        </>
      );
    }
    case 'quote':
      return (
        <>
          {verb('Reject', 'x', canApproveQuotes, 'Requires quote approval rights', () => onDecide('reject'), 'danger')}
          {verb(
            'Approve',
            'check',
            canApproveQuotes && !row.held,
            canApproveQuotes ? NTE_HOLD : 'Requires quote approval rights',
            () => onDecide('approve'),
            'primary',
          )}
        </>
      );
    case 'payment':
      return (
        <>
          {verb('Reject', 'x', canApprovePayments, 'Requires payment approval rights', () => onDecide('reject'), 'danger')}
          {verb(
            'Approve',
            'check',
            canApprovePayments && !row.held,
            canApprovePayments ? NTE_HOLD : 'Requires payment approval rights',
            () => onDecide('approve'),
            'primary',
          )}
        </>
      );
  }
}

// ── A one-field decision dialog (approval note, rejection reason) ────────────

interface TextDialogProps {
  title: string;
  facts: { k: string; v: string }[];
  /** Stable per row — the field id and label pairing. */
  idKey: string;
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
  facts,
  idKey,
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
  const fieldId = `apq-text-${idKey}`;

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
            {facts.map((f) => (
              <Fragment key={f.k}>
                <dt>{f.k}</dt>
                <dd>{f.v}</dd>
              </Fragment>
            ))}
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

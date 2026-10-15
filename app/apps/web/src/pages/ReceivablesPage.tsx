import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
// 0045 · the invoicing lane moved into its own file when invoices became
// records. The stat cards and the money formatting are shared, so the two
// subtabs still read as one page rather than two that drifted apart.
import { InvoicingTab } from '../components/rcv/InvoicingTab';
import { StatCard } from '../components/rcv/bits';
import {
  ApiRequestError,
  listInvoices,
  listQuotes,
  listWorkOrders,
  type WorkOrderListResponseV2,
} from '../api/client';
import {
  AUDIT_COLUMNS,
  INVOICES_LIST_CAP,
  QUOTES_LIST_CAP,
  WO_LIST_CAP,
  buildCheckLines,
  computeAuditIssues,
  deriveReceivables,
  isReadyToInvoice,
  listCapped,
  overallStatus,
  quotesByTask,
  readyAmount,
  summarizeIssues,
} from '../lib/receivables';
import type {
  AuditChecks,
  AuditIssue,
  AuditRow,
  AuditStatus,
  AuditSummary,
  CheckOutcome,
  Fact,
} from '../lib/receivables';

/**
 * Receivables — the AR tab. Two subtabs:
 *
 *   Audit      the Grey Flag queue (ported from the Support Automation shadow
 *              audit assistant): every done-group WO, the rules engine's
 *              findings over the facts the list payload carries, and the four
 *              release checkboxes. A BROWSER-SIDE PROTOTYPE (W2-1): a fact The
 *              One does not track yet is a dash, never a guess, and the ticks
 *              are page state — nothing is saved. The banner says so.
 *   Invoicing  Ready = Done + an approved quote + no invoice yet (real facts
 *              only, `isReadyToInvoice`); everything past Ready is an invoice
 *              record (0045).
 *
 * The lists are windows (QUOTES_LIST_CAP / INVOICES_LIST_CAP / WO_LIST_CAP):
 * when one comes back full the page says so in a notice rather than letting
 * a row past the window read as "missing" or "ready".
 */

type SubTab = 'audit' | 'invoicing';
/** M23 (UAT Wave D): the Audit prototype stays in the code, hidden. */
const AUDIT_TAB_ENABLED = false;

/** The Done group alone, as many as the list route allows. */
const AUDIT_LIST = { status_group: 'done', limit: WO_LIST_CAP } as const;

type AuditList = WorkOrderListResponseV2 & {
  /** The list refused the three audit columns, so they read as not tracked. */
  columns_refused: boolean;
};

/** The list carries the three facts the audit can read (Assignee, the visit
    mirror's CICO status, the BFI checkbox) — projected only when asked, and
    only for a viewer who may see them; a key that does not come back is
    "not tracked yet", never a guess. A `fields.*` key with no field
    definition is a 400 for the whole request: a definition someone deleted
    must not take the queue down, so the page asks again without the columns
    and the three facts read as not tracked. */
async function loadAuditList(): Promise<AuditList> {
  try {
    const page = await listWorkOrders({ ...AUDIT_LIST, columns: [...AUDIT_COLUMNS] });
    return { ...page, columns_refused: false };
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 400) {
      const page = await listWorkOrders(AUDIT_LIST);
      return { ...page, columns_refused: true };
    }
    throw err;
  }
}

export function ReceivablesPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  // M23 (UAT Wave D): the Audit tab is a prototype and is hidden until it is
  // finished — Receivables opens on Invoicing. Flip AUDIT_TAB_ENABLED to bring it back.
  const activeTab: SubTab = AUDIT_TAB_ENABLED && tab !== 'invoicing' ? 'audit' : 'invoicing';

  const woQuery = useQuery({
    queryKey: ['work-orders', { ...AUDIT_LIST, columns: [...AUDIT_COLUMNS] }],
    queryFn: loadAuditList,
  });
  const items = useMemo(() => woQuery.data?.items ?? [], [woQuery.data]);
  // Sidebar badge parity with the other pages (same cache key family as the
  // Pulse): the audit list is the Done group only, not the count of everything.
  const totalQuery = useQuery({
    queryKey: ['work-orders', { limit: 1 }],
    queryFn: () => listWorkOrders({ limit: 1 }),
  });

  // The Client Quote check and the Ready lane read the quotes list — the only
  // place a quote's status is. Until it comes back (loading, failed, or the
  // viewer may not read quotes) it is null: no row can then say whether its
  // quote exists, and nothing can be marked ready.
  const quotesQuery = useQuery({ queryKey: ['quotes'], queryFn: listQuotes, retry: 0 });
  const quotes = useMemo(() => quotesQuery.data?.items ?? null, [quotesQuery.data]);
  const quoteByTask = useMemo(() => quotesByTask(quotes ?? []), [quotes]);
  const quotesProblem: string | null = quotesQuery.isError
    ? quotesQuery.error instanceof ApiRequestError && quotesQuery.error.status === 403
      ? 'Your role cannot view quotes, so the Client Quote check and the Ready lane are off.'
      : 'The quotes list did not load, so the Client Quote check and the Ready lane are off.'
    : null;

  // The release ticks are page state only — nothing is seeded, nothing is
  // saved. Kept at page level so a tick survives switching subtabs.
  const [checkOverrides, setCheckOverrides] = useState<Record<string, Partial<AuditChecks>>>({});
  // 0045 · invoices are records now. What was page state — "Generate invoice"
  // then "Mark paid", both lost on reload — is a row with a number on it.
  const invoiceQuery = useQuery({ queryKey: ['invoices'], queryFn: listInvoices, retry: 0 });
  const invoices = invoiceQuery.data?.items ?? [];
  const invoicedTaskIds = useMemo(
    () => new Set(invoices.map((i) => i.task_id)),
    [invoices],
  );

  const { queue } = useMemo(() => deriveReceivables(items, quotes), [items, quotes]);

  const audited: AuditedRow[] = useMemo(
    () =>
      queue.map((row) => {
        const checks = { ...row.checks, ...checkOverrides[row.wo.id] };
        const issues = computeAuditIssues(row, checks);
        return { row, checks, issues, summary: summarizeIssues(issues), status: overallStatus(issues) };
      }),
    [queue, checkOverrides],
  );

  // Ready = Done + a quote the client can be billed on (approved / sent /
  // client-approved) + no invoice yet — real facts only; the audit ticks
  // above decide nothing here. Everything past Ready is a real invoice, so the
  // two lanes come from different places on purpose: one is a judgement about
  // a work order, the other is a document that exists.
  const readyRows = useMemo(
    () =>
      items
        .filter((wo) => isReadyToInvoice(wo, quoteByTask, invoicedTaskIds))
        .map((wo) => ({ wo, amount: readyAmount(quoteByTask.get(wo.id)) })),
    [items, quoteByTask, invoicedTaskIds],
  );

  // Done, but neither ready nor invoiced: waiting on an approved quote. Not a
  // figure worth printing while the quotes list is missing.
  const blockedCount = useMemo(() => {
    if (quotes === null) return 0;
    const ready = new Set(readyRows.map((r) => r.wo.id));
    return queue.filter((r) => !ready.has(r.wo.id) && !invoicedTaskIds.has(r.wo.id)).length;
  }, [queue, readyRows, invoicedTaskIds, quotes]);

  // Where a window may have cut the answer short, say so — once, in words.
  const notices: string[] = [];
  if (woQuery.data && woQuery.data.total > items.length) {
    notices.push(
      `The audit shows the ${WO_LIST_CAP} most recent of ${woQuery.data.total} Done work orders.`,
    );
  }
  if (woQuery.data?.columns_refused) {
    notices.push(
      'The list refused the audit columns (a field definition is missing), so Assignee, CICO and BFI read as not tracked.',
    );
  }
  if (quotes !== null && listCapped(quotes.length, QUOTES_LIST_CAP)) {
    notices.push(
      `The quotes list stops at its ${QUOTES_LIST_CAP} most recently updated quotes, so a Done work order with an older quote reads "not checked" here and does not reach the Ready lane.`,
    );
  }
  if (listCapped(invoices.length, INVOICES_LIST_CAP)) {
    notices.push(
      `The invoices list stops at its ${INVOICES_LIST_CAP} newest invoices, so a work order invoiced earlier than that may reappear as ready.`,
    );
  }

  function setCheck(id: string, key: keyof AuditChecks, value: boolean) {
    setCheckOverrides((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }

  return (
    <AppShell total={totalQuery.data?.total} active="Receivables">
      <div className="page-head">
        <h1 className="page-title">Receivables</h1>
        <p className="page-sub">
          Accounts receivable — completion audit and client invoicing, one pipeline.
        </p>
      </div>

      {AUDIT_TAB_ENABLED && activeTab === 'audit' && <div className="rcv-proto-banner" role="note">
        Prototype — this tab is worked out in your browser from the work-order and quote lists. A
        dash means The One does not track that fact yet (SharePoint folder contents, closeout
        numbers, days on Grey); the release ticks are not saved.
      </div>}

      <div className="seg rcv-subtabs" role="tablist" aria-label="Receivables sections">
        {AUDIT_TAB_ENABLED && <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'audit'}
          className={`seg-btn${activeTab === 'audit' ? ' is-on' : ''}`}
          onClick={() => navigate('/receivables')}
        >
          <Icon name="flag" size={12} />
          Audit
          <span className="rcv-tab-count">{woQuery.isLoading ? '—' : audited.length}</span>
        </button>}
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'invoicing'}
          className={`seg-btn${activeTab === 'invoicing' ? ' is-on' : ''}`}
          onClick={() => navigate('/receivables/invoicing')}
        >
          <Icon name="dollar" size={12} />
          Invoicing
          <span className="rcv-tab-count">
            {woQuery.isLoading || quotesQuery.isLoading
              ? '—'
              : readyRows.length + invoices.filter((i) => i.status === 'draft' || i.status === 'sent').length}
          </span>
        </button>
      </div>

      {activeTab === 'audit' ? (
        <AuditTab
          rows={audited}
          loading={woQuery.isLoading || quotesQuery.isLoading}
          error={woQuery.isError ? 'Failed to load work orders. Is the API running on :5174?' : null}
          notices={quotesProblem ? [quotesProblem, ...notices] : notices}
          onCheck={setCheck}
        />
      ) : (
        <InvoicingTab
          ready={readyRows}
          readyUnavailable={quotesProblem}
          notices={notices}
          invoices={invoices}
          totals={invoiceQuery.data?.totals}
          blockedCount={blockedCount}
          loading={woQuery.isLoading || invoiceQuery.isLoading || quotesQuery.isLoading}
          error={woQuery.isError}
        />
      )}
    </AppShell>
  );
}

interface AuditedRow {
  row: AuditRow;
  checks: AuditChecks;
  issues: AuditIssue[];
  summary: AuditSummary;
  status: AuditStatus;
}

// ═══ Audit subtab — the Grey Flag queue ═════════════════════════════════════

type StatusFilter = 'all' | AuditStatus;

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'major', label: 'Major' },
  { key: 'minor', label: 'Minor' },
  { key: 'clean', label: 'Clean' },
];

function AuditTab({
  rows,
  loading,
  error,
  notices,
  onCheck,
}: {
  rows: AuditedRow[];
  loading: boolean;
  /** Why the queue cannot be shown (the work-order list failed), or null. */
  error: string | null;
  /** What the queue cannot say — a list that failed or came back full. */
  notices: string[];
  onCheck: (id: string, key: keyof AuditChecks, value: boolean) => void;
}) {
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const totals = {
    all: rows.length,
    major: rows.filter((r) => r.status === 'major').length,
    minor: rows.filter((r) => r.status === 'minor').length,
    clean: rows.filter((r) => r.status === 'clean').length,
  };

  const visible = rows.filter((r) => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      return (
        r.row.wo.wo_number.toLowerCase().includes(q) ||
        (r.row.wo.client ?? '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const COLS = 13;

  return (
    <>
      <p className="rcv-lede">
        Work orders in the Done group — finished in the field, pending completion audit. The checks
        run in your browser over what the lists carry; click a row to see which facts were
        available and which are not tracked yet.
      </p>

      {!loading &&
        notices.map((n) => (
          <div key={n} className="rcv-blocked" role="note">
            <Icon name="info" size={12} />
            {n}
          </div>
        ))}

      <div className="rcv-stats">
        <StatCard label="Total in queue" value={loading ? '—' : totals.all} tone="neutral" />
        <StatCard label="Major issues" value={loading ? '—' : totals.major} tone="major" />
        <StatCard label="Minor issues" value={loading ? '—' : totals.minor} tone="minor" />
        <StatCard label="Clean" value={loading ? '—' : totals.clean} tone="clean" />
      </div>

      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Filter by audit status">
          {STATUS_FILTERS.map((f) => (
            <button
              type="button"
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              className={`seg-btn${filter === f.key ? ' is-on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="rcv-tab-count">{totals[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="rcv-search">
          <Icon name="search" size={12} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search WO # or client…"
            aria-label="Search the audit queue"
          />
        </div>
      </div>

      <div className="table-wrap">
        <table className="ct rcv-table">
          <thead>
            <tr>
              <th className="col-wo">WO #</th>
              <th>Audit</th>
              <th className="rcv-ck-th">GTG</th>
              <th className="rcv-ck-th">Admin</th>
              <th className="rcv-ck-th">Quote</th>
              <th>CICO</th>
              <th className="num">Done</th>
              <th className="num">Grey</th>
              <th>FM</th>
              <th>Comp</th>
              <th>CO#</th>
              <th>Assignee</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>Loading the audit queue…</td>
              </tr>
            )}
            {error && !loading && (
              <tr className="ct-empty">
                <td colSpan={COLS}>{error}</td>
              </tr>
            )}
            {!loading && !error && visible.length === 0 && (
              <tr className="ct-empty">
                <td colSpan={COLS}>
                  {rows.length === 0 ? 'No work order is in the Done group.' : 'No work orders match.'}
                </td>
              </tr>
            )}
            {!loading &&
              !error &&
              visible.map((r) => (
                <AuditRowPair
                  key={r.row.wo.id}
                  r={r}
                  cols={COLS}
                  open={openId === r.row.wo.id}
                  onToggleOpen={() =>
                    setOpenId((cur) => (cur === r.row.wo.id ? null : r.row.wo.id))
                  }
                  onCheck={onCheck}
                />
              ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function AuditRowPair({
  r,
  cols,
  open,
  onToggleOpen,
  onCheck,
}: {
  r: AuditedRow;
  cols: number;
  open: boolean;
  onToggleOpen: () => void;
  onCheck: (id: string, key: keyof AuditChecks, value: boolean) => void;
}) {
  const { row, checks, summary, status } = r;
  const wo = row.wo;
  return (
    <>
      <tr
        className={`is-clickable rcv-row${open ? ' is-open' : ''}`}
        onClick={onToggleOpen}
        aria-expanded={open}
      >
        <td className="col-wo">
          <div className="rcv-wo-cell">
            <Link
              className="wo-num wo-num-link"
              to={`/work-orders/${encodeURIComponent(wo.wo_number)}`}
              onClick={(e) => e.stopPropagation()}
              title="Open the work order"
            >
              {wo.wo_number}
            </Link>
            {row.bfi === true && <span className="rcv-bfi" title="Bill For Incurred">BFI</span>}
          </div>
          <small className="rcv-wo-client">{wo.client ?? '—'}</small>
        </td>
        <td>
          <AuditStatusChip status={status} summary={summary} />
        </td>
        {/* M23: the stray per-person "Elise" tick is gone. */}
        {(['gtg', 'admin', 'quote'] as const).map((key) => (
          <td key={key} className="rcv-ck-td" onClick={(e) => e.stopPropagation()}>
            <CheckToggle
              on={checks[key]}
              label={`${key} check for ${wo.wo_number}`}
              onToggle={() => onCheck(wo.id, key, !checks[key])}
            />
          </td>
        ))}
        <td className="rcv-trunc">
          <TextFact value={row.cico} empty="no visit recorded" />
        </td>
        <td className={`num rcv-days${row.daysDone !== null && row.daysDone >= 3 ? ' is-hot' : ''}`}>
          {row.daysDone !== null ? `${row.daysDone}d` : <Dash />}
        </td>
        <td className={`num rcv-days${row.daysGrey !== null && row.daysGrey >= 1 ? ' is-hot' : ''}`}>
          {row.daysGrey !== null ? `${row.daysGrey}d` : <Dash />}
        </td>
        <td className="rcv-trunc">{row.fm}</td>
        <td>
          <span className="rcv-pill">{row.comp}</span>
        </td>
        <td className="rcv-co">{row.coNumber ?? <Dash />}</td>
        <td className="rcv-trunc">
          <TextFact value={row.assignee} empty="unassigned" />
        </td>
      </tr>
      {open && (
        <tr className="rcv-detail-tr">
          <td colSpan={cols}>
            <AuditDetail r={r} />
          </td>
        </tr>
      )}
    </>
  );
}

/** The per-WO evidence panel — auto-check read-out, findings, recommendation. */
function AuditDetail({ r }: { r: AuditedRow }) {
  const lines = buildCheckLines(r.row, r.checks);
  const rec =
    r.summary.major > 0
      ? { cls: 'is-major', text: `Suggested QC: Major — ${r.summary.major} blocking issue${r.summary.major > 1 ? 's' : ''}` }
      : r.summary.minor > 0
        ? { cls: 'is-minor', text: `Suggested QC: Minor — ${r.summary.minor} flag${r.summary.minor > 1 ? 's' : ''} to tidy` }
        : r.checks.admin && r.checks.quote
          ? { cls: 'is-clean', text: 'Clean on what The One tracks — release ticked here (not saved); Invoicing › Ready follows the quote' }
          : { cls: 'is-clean', text: 'Clean on what The One tracks — tick Admin + Quote to mark the release (not saved); Invoicing › Ready follows the quote' };

  const findings = r.issues.filter((i) => i.severity !== 'info');

  return (
    <div className="rcv-detail">
      <section className="rcv-checklist" aria-label="Auto-check results">
        <h3 className="rcv-detail-h">Auto-check results</h3>
        <ul>
          {lines.map((line) => (
            <li key={line.label} className={`rcv-check-line is-${line.outcome}`}>
              <OutcomeMark outcome={line.outcome} />
              <span className="rcv-check-label">{line.label}</span>
              <span className="rcv-check-detail">{line.detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="rcv-findings" aria-label="Findings">
        <h3 className="rcv-detail-h">
          Findings
          <span className="rcv-detail-hn">{findings.length}</span>
        </h3>
        {findings.length === 0 ? (
          <div className="rcv-nofinding">
            <Icon name="check-circle" size={14} />
            Nothing unresolved — every check The One can run passed.
          </div>
        ) : (
          findings.map((issue) => <IssueCard key={issue.id} issue={issue} woNumber={r.row.wo.wo_number} />)
        )}
        <div className={`rcv-rec ${rec.cls}`}>
          <Icon name={r.summary.major > 0 ? 'alert' : r.summary.minor > 0 ? 'info' : 'check-circle'} size={14} />
          {rec.text}
        </div>
      </section>
    </div>
  );
}

function IssueCard({ issue, woNumber }: { issue: AuditIssue; woNumber: string }) {
  return (
    <article className={`rcv-issue is-${issue.severity}`}>
      <div className="rcv-issue-top">
        <span className={`rcv-sev is-${issue.severity}`}>{issue.severity}</span>
        <h4>{issue.title}</h4>
      </div>
      <p>{issue.description}</p>
      {issue.resolve.length > 0 && (
        <div className="rcv-resolve">
          <span className="rcv-resolve-lbl">Resolve via</span>
          {issue.resolve.map((l) =>
            l.kind === 'wo' ? (
              <Link
                key={l.label}
                className="rcv-chip is-wo"
                to={`/work-orders/${encodeURIComponent(woNumber)}`}
              >
                <Icon name="clipboard" size={12} />
                {l.label}
              </Link>
            ) : (
              <span
                key={l.label}
                className={`rcv-chip is-${l.kind}`}
                title="External systems are stubbed in this prototype"
              >
                <Icon name={l.kind === 'sharepoint' ? 'clip' : 'ext'} size={12} />
                {l.label}
              </span>
            ),
          )}
        </div>
      )}
    </article>
  );
}

/** A fact The One does not track yet (or the list did not carry for you). */
function Dash({ title = 'not tracked yet' }: { title?: string }) {
  return (
    <span className="rcv-none" title={title}>
      —
    </span>
  );
}

/** A text fact: null = not tracked (or not visible to you), '' = tracked but
    empty on the record — two different dashes, so the tooltip never claims
    more than the payload said. */
function TextFact({ value, empty }: { value: Fact<string>; empty: string }) {
  if (value === null) return <Dash />;
  if (value === '') return <Dash title={empty} />;
  return <>{value}</>;
}

function OutcomeMark({ outcome }: { outcome: CheckOutcome }) {
  if (outcome === 'pass') return <Icon name="check" size={12} className="rcv-mark" />;
  if (outcome === 'major') return <Icon name="x" size={12} className="rcv-mark" />;
  if (outcome === 'minor' || outcome === 'info')
    return <Icon name="alert" size={12} className="rcv-mark" />;
  return <span className="rcv-mark rcv-mark-dash" aria-hidden="true">—</span>;
}

function AuditStatusChip({ status, summary }: { status: AuditStatus; summary: AuditSummary }) {
  const label =
    status === 'clean'
      ? 'Clean'
      : status === 'minor'
        ? `${summary.minor} minor`
        : `${summary.major} major`;
  const extra =
    status === 'major' && summary.minor > 0
      ? ` · ${summary.minor} minor`
      : summary.offline > 0
        ? ' · offline'
        : '';
  return (
    <span className={`rcv-status is-${status}`}>
      <span className="rcv-status-dot" aria-hidden="true" />
      {label}
      {extra && <span className="rcv-status-extra">{extra}</span>}
    </span>
  );
}

/** The green audit checkbox — filled when ticked, hollow when not. */
function CheckToggle({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      className={`rcv-ck${on ? ' is-on' : ''}`}
      onClick={onToggle}
    >
      {on && <Icon name="check" size={12} />}
    </button>
  );
}

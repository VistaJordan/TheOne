/* /quotes — the sidebar's "Quotes" destination. Deliberately thin: WO, quote
   number, status, grand total, last touched, and a way into the builder. It
   reuses the S1 work-orders table (.ct) rather than inventing a second table
   treatment.

   0048 · the list carries the document number, and the status segment
   (Facilio's "Approved" / "Pending" views) is the same list narrowed, never a
   second query: the counts on the tabs and the rows under them cannot
   disagree. */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { QuoteStatus } from '@theone/shared';
import { ApiRequestError, listQuotes } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { ListPagination, PAGE_SIZES } from '../components/ListPagination';
import { QUOTE_STATUS } from '../components/quote/QuoteStatusPill';
import { usd } from '../lib/quoteTotals';
import { numericDate } from '../lib/fields';
import { EmergencyBadge } from '../components/EmergencyBadge';
import { EscalatedBadge } from '../components/EscalatedBadge';

type Lane = 'all' | QuoteStatus;

const LANES: { key: Lane; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'pending_approval', label: 'Pending approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'sent', label: 'Sent' },
];

export function QuotesPage() {
  const navigate = useNavigate();
  const quotesQuery = useQuery({ queryKey: ['quotes'], queryFn: listQuotes, retry: 0 });

  const items = useMemo(() => quotesQuery.data?.items ?? [], [quotesQuery.data]);
  const [lane, setLane] = useState<Lane>('all');
  const laneItems = useMemo(
    () => (lane === 'all' ? items : items.filter((q) => q.status === lane)),
    [items, lane],
  );
  const total = laneItems.length;
  const countFor = (key: Lane) => (key === 'all' ? items.length : items.filter((q) => q.status === key).length);

  // The quotes endpoint returns the whole set, so the footer pages a client
  // slice — same bar as the work-orders list, which pages on the server.
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [offset, setOffset] = useState(0);
  const pageItems = laneItems.slice(offset, offset + pageSize);
  // A 404 means the list route is not served yet — that is an empty shelf, not a
  // broken page, and it should read that way.
  const notServed =
    quotesQuery.error instanceof ApiRequestError && quotesQuery.error.status === 404;

  const switchLane = (l: Lane) => {
    setLane(l);
    setOffset(0);
  };

  return (
    <AppShell active="Quotes">
      <div className="page-head">
        <p className="page-sub">
          {quotesQuery.isLoading
            ? 'Loading…'
            : `${total} quote${total === 1 ? '' : 's'} · newest updated first`}
        </p>
      </div>

      {!quotesQuery.isError && (
        <div className="payq-head">
          <div className="seg payq-lanes" role="group" aria-label="Quote status">
            {LANES.map((l) => (
              <button
                key={l.key}
                type="button"
                className={`seg-btn${lane === l.key ? ' is-on' : ''}`}
                aria-pressed={lane === l.key}
                onClick={() => switchLane(l.key)}
              >
                {l.label}
                {!quotesQuery.isLoading && (
                  <span className={`payq-count${l.key === 'pending_approval' && countFor(l.key) > 0 ? ' is-hot' : ''}`}>
                    {countFor(l.key)}
                  </span>
                )}
              </button>
            ))}
          </div>
          {!quotesQuery.isLoading && (
            <div className="payq-sum">
              <span>
                Awaiting approval{' '}
                <b>{usd(items.filter((q) => q.status === 'pending_approval').reduce((s, q) => s + (q.grand_total ?? 0), 0))}</b>
              </span>
              <span>
                Approved or sent{' '}
                <b>{usd(items.filter((q) => q.status === 'approved' || q.status === 'sent').reduce((s, q) => s + (q.grand_total ?? 0), 0))}</b>
              </span>
            </div>
          )}
        </div>
      )}

      {quotesQuery.isError && (
        <div className="quotes-empty">
          <Icon name="file" size={22} />
          <b>{notServed ? 'No quotes to list yet' : 'Could not load quotes'}</b>
          <span>
            {notServed
              ? 'Quotes are built from a work order — open one and use “Create quote”.'
              : 'Is the API running on :5174?'}
          </span>
        </div>
      )}

      {!quotesQuery.isError && (
        <div className="table-wrap">
          <table className="ct">
            <thead>
              <tr>
                <th className="col-wo">Quote #</th>
                <th className="col-wo">WO #</th>
                <th className="col-client">Client / Title</th>
                <th className="col-status">Quote status</th>
                <th className="col-nte num">Grand total</th>
                <th className="col-date">Updated</th>
                <th className="rcv-action-th">Document</th>
              </tr>
            </thead>
            <tbody>
              {quotesQuery.isLoading && (
                <tr className="ct-empty"><td colSpan={7}>Loading quotes…</td></tr>
              )}
              {!quotesQuery.isLoading && laneItems.length === 0 && (
                <tr className="ct-empty">
                  <td colSpan={7}>
                    {lane === 'all' ? 'No quotes have been built yet.' : 'Nothing in this stage.'}
                  </td>
                </tr>
              )}
              {pageItems.map((q) => {
                const href = `/work-orders/${encodeURIComponent(q.wo_number)}/quote`;
                return (
                  <tr
                    key={q.id}
                    className={`is-clickable${q.wo_emergency ? ' is-emergency' : ''}${q.wo_escalated ? ' is-escalated' : ''}`}
                    onClick={() => navigate(href)}
                  >
                    <td className="col-wo mono">{q.number ?? '—'}</td>
                    <td className="col-wo">
                      <Link
                        className="wo-num wo-num-link"
                        to={href}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {q.wo_number}
                      </Link>
                      {q.wo_emergency && <EmergencyBadge compact />}
                      {q.wo_escalated && <EscalatedBadge compact />}
                    </td>
                    <td className="col-client">
                      <div className="site">
                        <strong>{q.client ?? '—'}</strong>
                        <small>{q.title ?? '—'}</small>
                      </div>
                    </td>
                    <td className="col-status">
                      <span className="chip chip-sm">{QUOTE_STATUS[q.status]?.label ?? q.status}</span>
                    </td>
                    <td className="col-nte num">{q.grand_total == null ? '—' : usd(q.grand_total)}</td>
                    <td className="col-date">{numericDate(q.updated_at) ?? '—'}</td>
                    <td className="rcv-action-td">
                      <Link
                        className="rcv-btn"
                        to={`${href}/print`}
                        onClick={(e) => e.stopPropagation()}
                        title="Open the printable document (save as PDF from the print dialog)"
                      >
                        <Icon name="file" size={12} />
                        Print / PDF
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!quotesQuery.isError && (
        <ListPagination
          total={quotesQuery.isLoading ? undefined : total}
          offset={offset}
          limit={pageSize}
          noun="quotes"
          onOffsetChange={setOffset}
          onLimitChange={(n) => {
            setPageSize(n);
            setOffset(0);
          }}
        />
      )}
    </AppShell>
  );
}

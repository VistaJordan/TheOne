/* /quotes — the sidebar's "Quotes" destination. Deliberately thin: WO, status,
   grand total, last touched, and a way into the builder. It reuses the S1 work-
   orders table (.ct) rather than inventing a second table treatment. */

import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ApiRequestError, listQuotes } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { QUOTE_STATUS } from '../components/quote/QuoteStatusPill';
import { usd } from '../lib/quoteTotals';
import { numericDate } from '../lib/fields';

export function QuotesPage() {
  const navigate = useNavigate();
  const quotesQuery = useQuery({ queryKey: ['quotes'], queryFn: listQuotes, retry: 0 });

  const items = quotesQuery.data?.items ?? [];
  const total = quotesQuery.data?.total ?? items.length;
  // A 404 means the list route is not served yet — that is an empty shelf, not a
  // broken page, and it should read that way.
  const notServed =
    quotesQuery.error instanceof ApiRequestError && quotesQuery.error.status === 404;

  return (
    <AppShell active="Quotes">
      <div className="page-head">
        <p className="page-sub">
          {quotesQuery.isLoading
            ? 'Loading…'
            : `${total} quote${total === 1 ? '' : 's'} · newest updated first`}
        </p>
      </div>

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
                <th className="col-wo">WO #</th>
                <th className="col-client">Client / Title</th>
                <th className="col-status">Quote status</th>
                <th className="col-nte num">Grand total</th>
                <th className="col-list">Updated</th>
              </tr>
            </thead>
            <tbody>
              {quotesQuery.isLoading && (
                <tr className="ct-empty"><td colSpan={5}>Loading quotes…</td></tr>
              )}
              {!quotesQuery.isLoading && items.length === 0 && (
                <tr className="ct-empty">
                  <td colSpan={5}>No quotes have been built yet.</td>
                </tr>
              )}
              {items.map((q) => {
                const href = `/work-orders/${encodeURIComponent(q.wo_number)}/quote`;
                return (
                  <tr key={q.id} className="is-clickable" onClick={() => navigate(href)}>
                    <td className="col-wo">
                      <Link
                        className="wo-num wo-num-link"
                        to={href}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {q.wo_number}
                      </Link>
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
                    <td className="col-list">{numericDate(q.updated_at) ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}

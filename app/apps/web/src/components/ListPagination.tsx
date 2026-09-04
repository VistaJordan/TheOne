/* The footer under every list page: "Showing 1 to 25 of 128 work orders", the
   pager, and the rows-per-page picker. Purely presentational — the page owns
   offset/limit and hands them down (the work-orders list passes them to the
   server; quotes slices its loaded rows; vendors will pick one when it lands).
   Wheel/keyboard scrolling is untouched: this pages the DATA, not the view. */

import { Icon } from './Icon';

/** The picker's options. The first is the default page size everywhere. */
export const PAGE_SIZES = [25, 50, 100, 200];

interface ListPaginationProps {
  /** Total matching rows — undefined while the first page is still loading. */
  total: number | undefined;
  offset: number;
  limit: number;
  /** Plural noun for the summary: "work orders", "quotes", "vendors". */
  noun: string;
  onOffsetChange: (offset: number) => void;
  /** A new size always lands back on page 1 — the caller resets its offset. */
  onLimitChange: (limit: number) => void;
}

/** The numbers to draw: all of them up to 7 pages, then 1 … current±1 … last.
    The two gap markers need distinct keys, hence the l/r variants. */
function pageList(pages: number, page: number): (number | 'gap-l' | 'gap-r')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const around = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const out: (number | 'gap-l' | 'gap-r')[] = [1];
  if ((around[0] ?? pages) > 2) out.push('gap-l');
  out.push(...around);
  if ((around[around.length - 1] ?? 1) < pages - 1) out.push('gap-r');
  out.push(pages);
  return out;
}

export function ListPagination({
  total,
  offset,
  limit,
  noun,
  onOffsetChange,
  onLimitChange,
}: ListPaginationProps) {
  const pages = total == null ? null : Math.max(1, Math.ceil(total / limit));
  const page = Math.floor(offset / limit) + 1;
  const from = offset + 1;
  const to = total == null ? 0 : Math.min(offset + limit, total);

  return (
    <nav className="list-pgn" aria-label="Pagination">
      <span className="pgn-sum">
        {total == null
          ? 'Loading…'
          : total === 0
            ? `No ${noun}`
            : `Showing ${from.toLocaleString('en-US')} to ${to.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} ${noun}`}
      </span>

      {pages != null && pages > 1 && (
        <span className="pgn-pages">
          <button
            type="button"
            className="pgn-btn"
            disabled={page <= 1}
            aria-label="Previous page"
            onClick={() => onOffsetChange((page - 2) * limit)}
          >
            <Icon name="chev-l" size={14} />
          </button>
          {pageList(pages, page).map((p) =>
            typeof p === 'number' ? (
              <button
                type="button"
                key={p}
                className={`pgn-btn${p === page ? ' is-on' : ''}`}
                aria-current={p === page ? 'page' : undefined}
                aria-label={`Page ${p}`}
                onClick={() => onOffsetChange((p - 1) * limit)}
              >
                {p}
              </button>
            ) : (
              <span key={p} className="pgn-gap" aria-hidden="true">
                …
              </span>
            ),
          )}
          <button
            type="button"
            className="pgn-btn"
            disabled={page >= pages}
            aria-label="Next page"
            onClick={() => onOffsetChange(page * limit)}
          >
            <Icon name="chev-r" size={14} />
          </button>
        </span>
      )}

      <label className="pgn-size">
        Rows per page
        <select value={limit} onChange={(e) => onLimitChange(Number(e.target.value))}>
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
    </nav>
  );
}

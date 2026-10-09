/* The quote's own status pill + the 4-step pipeline above it.

   The quote lifecycle is NOT a work-order status, so it cannot borrow the seeded
   status colours from /api/statuses — these four are the comp's. Both greens
   carry the SPRINT1-SPEC §6 day-theme ink override, the same exception table the
   WO pills use, so the label clears AA on the day tint too. */

import { Fragment } from 'react';
import type { CSSProperties } from 'react';
import type { QuoteStatus } from '../../api/client';
import { Icon } from '../Icon';

interface PillVars extends CSSProperties {
  '--pill': string;
  '--pill-ink-day'?: string;
}

interface StatusMeta {
  label: string;
  color: string;
  inkDay?: string;
}

export const QUOTE_STATUS: Record<QuoteStatus, StatusMeta> = {
  draft: { label: 'Draft', color: '#4466ff' },
  pending_approval: { label: 'Pending approval', color: '#0f9d9f' },
  approved: { label: 'Approved', color: '#6bed5e', inkDay: '#36772f' },
  sent: { label: 'Sent to client', color: '#64c6a2', inkDay: '#326351' },
  client_approved: { label: 'Client approved', color: '#2ecc71', inkDay: '#1e7a46' },
  client_declined: { label: 'Client declined', color: '#e05a5a' },
};

/** Left-to-right order of the pipeline — also the index used to mark done/current.
    The client decision is the fifth step; its label follows the outcome. */
export const QUOTE_PIPELINE: QuoteStatus[] = ['draft', 'pending_approval', 'approved', 'sent', 'client_approved'];

function pillVars(meta: StatusMeta): PillVars {
  const style: PillVars = { '--pill': meta.color };
  if (meta.inkDay) style['--pill-ink-day'] = meta.inkDay;
  return style;
}

export function QuoteStatusPill({ status }: { status: QuoteStatus }) {
  const meta = QUOTE_STATUS[status];
  return (
    <span className="pill pill-lg" style={pillVars(meta)}>
      <span className="pill-dot" aria-hidden="true" />
      <span className="pill-label">{meta.label}</span>
    </span>
  );
}

export function QuotePipeline({ status, round = 1 }: { status: QuoteStatus; round?: number }) {
  const declined = status === 'client_declined';
  const current = declined ? QUOTE_PIPELINE.length - 1 : QUOTE_PIPELINE.indexOf(status);
  return (
    <ol className="pipe" aria-label={`Quote status${round > 1 ? ` — round ${round}` : ''}`}>
      {QUOTE_PIPELINE.map((step, i) => {
        const done = i < current || (i === current && (status === 'client_approved'));
        const isCurrent = i === current && !done;
        const cls = `pstep${done ? ' is-done' : ''}${isCurrent ? ' is-current' : ''}${declined && i === current ? ' is-declined' : ''}`;
        const label =
          step === 'client_approved'
            ? declined ? 'Client declined' : 'Client decision'
            : QUOTE_STATUS[step].label;
        // The connector is a SIBLING <li>, as in the comp — .pipe is the flex
        // row and .pipe-link is one of its items, not part of a step.
        return (
          <Fragment key={step}>
            <li className={cls} aria-current={isCurrent ? 'step' : undefined}>
              <span className="pstep-mark">
                {done ? <Icon name="check" size={12} /> : declined && i === current ? <Icon name="x" size={12} /> : isCurrent ? <span className="pstep-pulse" /> : i + 1}
              </span>
              {label}
            </li>
            {i < QUOTE_PIPELINE.length - 1 && <li className="pipe-link" aria-hidden="true" />}
          </Fragment>
        );
      })}
    </ol>
  );
}

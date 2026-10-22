/* The tab strip of Incoming Work Orders (/incoming) — one door for every
   work order on its way in, whichever way it arrives:

     To accept   rule 7.1.1 (0036): work orders the system or a client
                 created that wait for a manager to accept and assign, or
                 reject. Shown to `approvals/intake` view.
     Unassigned  2026-10-22: every live work order nobody carries — whether
                 an acceptance is open on it or it was unassigned from the
                 header — with an Assign button per row. Same grant as
                 To accept.
     Drafts      section 14 (0040): work orders typed in by hand that wait
                 as drafts until every intake field and an assignee are in.
                 Shown to `intake` view.

   Each person sees the tabs their permissions grant. With only one of them,
   there is nothing to switch between and the strip stays away — the page
   simply IS that queue. The counts come from the same queries the pages
   themselves run (shared keys), so a tab never costs a second call. */

import { useLinkNav } from '../lib/linkNav';
import { useQuery } from '@tanstack/react-query';
import { INTAKE_PERM_KEY, approvalSectionPermKey } from '@theone/shared';
import { getApprovalCounts, listIntakeDrafts } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { UNASSIGNED_QUERY_KEY, fetchUnassigned } from '../lib/unassigned';
import { Icon } from './Icon';

export type IncomingTab = 'accept' | 'unassigned' | 'drafts';

export const INCOMING_ACCEPT_PERM = approvalSectionPermKey('intake');

export function IncomingTabs({ tab }: { tab: IncomingTab }) {
  const { linkTo } = useLinkNav();
  const { can, actingAs } = useAuth();
  const showAccept = can(INCOMING_ACCEPT_PERM, 'view');
  const showDrafts = can(INTAKE_PERM_KEY, 'view');
  const tabs = (showAccept ? 2 : 0) + (showDrafts ? 1 : 0);
  const strip = tabs > 1;

  const counts = useQuery({
    queryKey: ['approval-counts', actingAs?.id ?? null],
    queryFn: getApprovalCounts,
    enabled: strip && showAccept,
    staleTime: 30 * 1000,
    retry: 0,
  });
  const unassigned = useQuery({
    queryKey: UNASSIGNED_QUERY_KEY,
    queryFn: fetchUnassigned,
    enabled: strip && showAccept,
    staleTime: 30 * 1000,
    retry: 0,
  });
  const drafts = useQuery({
    queryKey: ['intake-drafts'],
    queryFn: listIntakeDrafts,
    enabled: strip && showDrafts,
    staleTime: 30 * 1000,
    retry: 0,
  });

  if (!strip) return null;

  const toAccept = counts.data?.to_accept;
  const unassignedCount = unassigned.data?.total;
  const draftCount = drafts.data?.items.length;

  return (
    <div className="seg incoming-tabs" role="tablist" aria-label="Incoming work orders">
      {showAccept && (
        <>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'accept'}
            className={`seg-btn${tab === 'accept' ? ' is-on' : ''}`}
            {...linkTo('/incoming')}
          >
            <Icon name="download" size={12} />
            To accept
            {toAccept !== undefined && (
              <span className={`payq-count${toAccept > 0 ? ' is-hot' : ''}`}>{toAccept}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'unassigned'}
            className={`seg-btn${tab === 'unassigned' ? ' is-on' : ''}`}
            {...linkTo('/incoming/unassigned')}
          >
            <Icon name="user" size={12} />
            Unassigned
            {unassignedCount !== undefined && (
              <span className={`payq-count${unassignedCount > 0 ? ' is-hot' : ''}`}>{unassignedCount}</span>
            )}
          </button>
        </>
      )}
      {showDrafts && (
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'drafts'}
          className={`seg-btn${tab === 'drafts' ? ' is-on' : ''}`}
          {...linkTo('/incoming/drafts')}
        >
          <Icon name="pencil" size={12} />
          Drafts
          {draftCount !== undefined && <span className="payq-count">{draftCount}</span>}
        </button>
      )}
    </div>
  );
}

/* The tab strip of Incoming Work Orders (/incoming) — one door for every
   work order on its way in, whichever way it arrives:

     To accept   rule 7.1.1 (0036): work orders the system or a client
                 created that wait for a manager to accept and assign, or
                 reject. Shown to `approvals/intake` view.
     Drafts      section 14 (0040): work orders typed in by hand that wait
                 as drafts until every intake field and an assignee are in.
                 Shown to `intake` view.

   Each person sees the tabs their permissions grant. With only one of the
   two, there is nothing to switch between and the strip stays away — the
   page simply IS that queue. The counts come from the same queries the
   pages themselves run (shared keys), so a tab never costs a second call. */

import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { INTAKE_PERM_KEY, approvalSectionPermKey } from '@theone/shared';
import { getApprovalCounts, listIntakeDrafts } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from './Icon';

export type IncomingTab = 'accept' | 'drafts';

export const INCOMING_ACCEPT_PERM = approvalSectionPermKey('intake');

export function IncomingTabs({ tab }: { tab: IncomingTab }) {
  const navigate = useNavigate();
  const { can, actingAs } = useAuth();
  const showAccept = can(INCOMING_ACCEPT_PERM, 'view');
  const showDrafts = can(INTAKE_PERM_KEY, 'view');

  const counts = useQuery({
    queryKey: ['approval-counts', actingAs?.id ?? null],
    queryFn: getApprovalCounts,
    enabled: showAccept && showDrafts,
    staleTime: 30 * 1000,
    retry: 0,
  });
  const drafts = useQuery({
    queryKey: ['intake-drafts'],
    queryFn: listIntakeDrafts,
    enabled: showAccept && showDrafts,
    staleTime: 30 * 1000,
    retry: 0,
  });

  if (!(showAccept && showDrafts)) return null;

  const toAccept = counts.data?.to_accept;
  const draftCount = drafts.data?.items.length;

  return (
    <div className="seg incoming-tabs" role="tablist" aria-label="Incoming work orders">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'accept'}
        className={`seg-btn${tab === 'accept' ? ' is-on' : ''}`}
        onClick={() => navigate('/incoming')}
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
        aria-selected={tab === 'drafts'}
        className={`seg-btn${tab === 'drafts' ? ' is-on' : ''}`}
        onClick={() => navigate('/incoming/drafts')}
      >
        <Icon name="pencil" size={12} />
        Drafts
        {draftCount !== undefined && <span className="payq-count">{draftCount}</span>}
      </button>
    </div>
  );
}

import { useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  getActivity,
  getPaymentRequests,
  getStatuses,
  getWorkOrder,
  getWorkOrderFeed,
  getWorkOrderMessages,
  getWorkOrderQuote,
  listWorkOrders,
} from '../api/client';
import { ApiRequestError } from '../api/client';
import { AppShell } from '../components/AppShell';
import { Icon } from '../components/Icon';
import { WoHeader } from '../components/wo/WoHeader';
import { UpdatesFeed } from '../components/wo/UpdatesFeed';
import { UpdateComposer } from '../components/wo/UpdateComposer';
import { PhotosCard } from '../components/wo/PhotosCard';
import { SoftCloseChecklist } from '../components/wo/SoftCloseChecklist';
import { MoneyCard } from '../components/wo/MoneyCard';
import { PayablesCard } from '../components/wo/PayablesCard';
import { PeopleCard } from '../components/wo/PeopleCard';
import { SiteCard } from '../components/wo/SiteCard';
import { DatesCard } from '../components/wo/DatesCard';
import { PartsCard } from '../components/wo/PartsCard';
import { FlagsRow } from '../components/wo/FlagsRow';
import { AllFieldsRow } from '../components/wo/AllFieldsRow';
import { AllFieldsList } from '../components/wo/AllFieldsList';
import { AuditTrail } from '../components/wo/AuditTrail';
import { MessagesPanel } from '../components/wo/messages/MessagesPanel';
import { MessagesRail } from '../components/wo/messages/MessagesRail';
import { ObligationsCard, OBLIGATIONS_CARD_ID } from '../components/obligations/ObligationsCard';
import { useWoObligations } from '../hooks/useObligations';
import { FIELD, daysSince, field, str } from '../lib/fields';
import { plainStatus } from '../lib/quo';
import { phaseForStatus } from '../lib/phases';

type Tab = 'overview' | 'messages' | 'audit' | 'fields';

/** Turn literal "\n"/"\r\n" escape sequences from the intake export into real breaks. */
function unescapeBreaks(text: string | null): string | null {
  return text == null ? text : text.replace(/\\r\\n|\\n|\\r/g, '\n');
}

export function WorkOrderDetailPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');
  const tabsRef = useRef<HTMLDivElement>(null);

  const woQuery = useQuery({
    queryKey: ['work-orders', 'detail', woNumber],
    queryFn: () => getWorkOrder(woNumber),
    enabled: woNumber.length > 0,
  });

  const wo = woQuery.data;

  const feedQuery = useQuery({
    queryKey: ['wo-feed', wo?.id ?? woNumber],
    queryFn: () => getWorkOrderFeed(wo?.id ?? woNumber),
    enabled: Boolean(wo),
  });

  // Fetched as soon as the WO resolves (not gated on the tab) because the tab
  // strip carries the thread-count badge.
  const messagesKey = ['wo-messages', wo?.id ?? woNumber] as const;
  const messagesQuery = useQuery({
    queryKey: messagesKey,
    queryFn: () => getWorkOrderMessages(wo?.id ?? woNumber),
    enabled: Boolean(wo),
  });

  const activityQuery = useQuery({
    queryKey: ['wo-activity', wo?.id ?? woNumber],
    queryFn: () => getActivity(wo?.id ?? woNumber),
    enabled: Boolean(wo) && tab === 'audit',
  });

  const statusesQuery = useQuery({
    queryKey: ['statuses'],
    queryFn: getStatuses,
    staleTime: 5 * 60 * 1000,
  });

  // S4 entry points. Both are rail-card decorations, so a failure degrades to
  // "no badge" rather than taking the page down — hence retry: 0 and the ?? null.
  const quoteQuery = useQuery({
    queryKey: ['wo-quote', woNumber],
    queryFn: () => getWorkOrderQuote(woNumber),
    enabled: Boolean(wo),
    retry: 0,
  });

  const paymentsQuery = useQuery({
    queryKey: ['wo-payments', woNumber],
    queryFn: () => getPaymentRequests(woNumber),
    enabled: Boolean(wo),
    retry: 0,
  });

  // S5 — what this work order owes. Addressed by wo_number (the API resolves a
  // uuid or a number), decoration-grade like the S4 cards: a failure degrades to
  // "no clocks", never to a broken page.
  const obligationsQuery = useWoObligations(wo ? (wo.id ?? woNumber) : undefined);

  // Sidebar badge parity with the list page (cached under the same key family).
  const totalQuery = useQuery({
    queryKey: ['work-orders', { limit: 1 }],
    queryFn: () => listWorkOrders({ limit: 1 }),
  });

  const statuses = statusesQuery.data ?? [];
  const feedItems = feedQuery.data?.items ?? [];

  const phase = useMemo(() => {
    if (!wo) return null;
    const apiStatus = statuses.find((s) => s.id === wo.status.id) ?? null;
    return phaseForStatus(wo.status.name, apiStatus);
  }, [wo, statuses]);

  // Days in the current status = age of the newest status_changed event; falls
  // back to WO age when the WO has never moved.
  const inStatusDays = useMemo(() => {
    if (!wo) return null;
    const lastChange = feedItems.find((i) => i.type === 'status_changed');
    if (lastChange) return daysSince(lastChange.created_at);
    if (feedQuery.isSuccess) return daysSince(wo.date_received);
    return null;
  }, [wo, feedItems, feedQuery.isSuccess]);

  const breadcrumb = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button
        type="button"
        className="crumb-back"
        aria-label="Back to Work Orders"
        onClick={() => navigate('/')}
      >
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/">Work Orders</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">{wo?.wo_number ?? woNumber}</span>
    </nav>
  );

  const shell = (children: ReactNode) => (
    <AppShell total={totalQuery.data?.total} breadcrumb={breadcrumb}>
      <div className="canvas-inner">{children}</div>
    </AppShell>
  );

  if (woQuery.isLoading) {
    return shell(<div className="wo-state"><b>Loading {woNumber}…</b></div>);
  }

  if (woQuery.isError || !wo) {
    const notFound = woQuery.error instanceof ApiRequestError && woQuery.error.status === 404;
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>{notFound ? `${woNumber} not found` : 'Could not load this work order'}</b>
        <span>
          {notFound
            ? 'It may have been deleted, or the number is wrong.'
            : 'Is the API running on :5174?'}
        </span>
        <Link className="btn" to="/">Back to Work Orders</Link>
      </div>,
    );
  }

  const fields = wo.fields ?? {};
  const fieldCount = Object.keys(fields).length;
  // The intake export carries LITERAL two-character "\n" escapes inside the
  // free-text fields (27 of 28 seeded WOs). `.desc` is already `pre-wrap`, so
  // real newlines lay out correctly — only these escapes leak through as text.
  const description = unescapeBreaks(wo.description ?? str(field(fields, FIELD.description)));
  const lastUpdate = unescapeBreaks(str(field(fields, '20. Last Update')));

  const conversation = messagesQuery.data?.conversation ?? null;
  // The comp's badge counts logged calls + texts (segments are dividers).
  const threadCount = conversation
    ? conversation.counts.calls + conversation.counts.texts
    : null;

  const openFieldsTab = () => {
    setTab('fields');
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const obligations = obligationsQuery.data ?? [];

  // A header clock chip points at the rail card that owns the action. The
  // Messages tab replaces the rail wholesale, so step back to Overview first.
  const revealObligations = () => {
    setTab('overview');
    window.requestAnimationFrame(() => {
      document
        .getElementById(OBLIGATIONS_CARD_ID)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  return shell(
    <>
      <WoHeader
        wo={wo}
        phase={phase}
        inStatusDays={inStatusDays}
        obligations={obligations}
        onClockClick={revealObligations}
      />

      <div className={`wo-grid${tab === 'messages' ? ' is-messages' : ''}`}>
        <div className="col-main">
          <section className="card card-pad">
            <div className="overline">35. WO Description</div>
            {description ? (
              <p className="desc">{description}</p>
            ) : (
              <p className="desc is-none">No description was supplied with this work order.</p>
            )}
            {lastUpdate && <p className="desc">{lastUpdate}</p>}
          </section>

          <div className="seg tabs" role="tablist" aria-label="Work order sections" ref={tabsRef}>
            <TabButton id="overview" tab={tab} onSelect={setTab}>Overview</TabButton>
            <TabButton id="messages" tab={tab} onSelect={setTab}>
              <Icon name="msg" size={12} />
              Messages
              {threadCount !== null && <span className="seg-count">{threadCount}</span>}
            </TabButton>
            <TabButton id="audit" tab={tab} onSelect={setTab}>Audit trail</TabButton>
            <TabButton id="fields" tab={tab} onSelect={setTab}>
              All fields <span className="seg-count">{fieldCount}</span>
            </TabButton>
          </div>

          {tab === 'overview' && (
            <div role="tabpanel" aria-label="Overview">
              <section className="card">
                <div className="card-head">
                  <h2 className="card-title">Updates &amp; activity</h2>
                  <span className="card-meta">
                    {feedQuery.isSuccess
                      ? `${feedQuery.data.total} event${feedQuery.data.total === 1 ? '' : 's'} · newest first`
                      : '—'}
                  </span>
                </div>
                <UpdatesFeed
                  items={feedItems}
                  statuses={statuses}
                  loading={feedQuery.isLoading}
                  error={feedQuery.isError}
                />
                <UpdateComposer woId={wo.id} woNumber={wo.wo_number} />
              </section>

              <PhotosCard wo={wo} />
              <SoftCloseChecklist wo={wo} />
            </div>
          )}

          {tab === 'messages' && (
            <MessagesPanel
              woId={wo.id}
              data={messagesQuery.data}
              loading={messagesQuery.isLoading}
              error={messagesQuery.isError}
              waitingOn={plainStatus(wo.status.name)}
              queryKey={messagesKey}
            />
          )}

          {tab === 'audit' && (
            <div className="card" role="tabpanel" aria-label="Audit trail">
              <AuditTrail
                entries={activityQuery.data ?? wo.recent_activity ?? []}
                loading={activityQuery.isLoading}
                error={activityQuery.isError}
              />
            </div>
          )}

          {tab === 'fields' && (
            <div className="card" role="tabpanel" aria-label="All fields">
              <div className="card-head">
                <h2 className="card-title">All fields</h2>
                <span className="card-meta">{fieldCount} recorded</span>
              </div>
              <AllFieldsList fields={fields} />
            </div>
          )}
        </div>

        <aside className="rail">
          {tab === 'messages' && conversation ? (
            <MessagesRail conversation={conversation} items={messagesQuery.data?.items ?? []} />
          ) : (
            <>
              {/* S5 — what is owed leads the rail: money is context, a running
                  clock is an action. */}
              <ObligationsCard
                items={obligations}
                loading={obligationsQuery.isLoading}
                error={obligationsQuery.isError}
              />
              <MoneyCard
                wo={wo}
                quoteStatus={
                  quoteQuery.isSuccess ? (quoteQuery.data.quote?.status ?? null) : undefined
                }
              />
              <PayablesCard
                woNumber={wo.wo_number}
                items={paymentsQuery.data?.items ?? []}
                totalPaid={paymentsQuery.data?.total_paid ?? null}
                loading={paymentsQuery.isLoading}
              />
              <PeopleCard wo={wo} />
              <SiteCard wo={wo} />
              <DatesCard wo={wo} />
              <PartsCard wo={wo} />
              <FlagsRow wo={wo} />
              <AllFieldsRow count={fieldCount} onOpen={openFieldsTab} />
            </>
          )}
        </aside>
      </div>
    </>,
  );
}

interface TabButtonProps {
  id: Tab;
  tab: Tab;
  onSelect: (t: Tab) => void;
  children: ReactNode;
}

function TabButton({ id, tab, onSelect, children }: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={`seg-btn${tab === id ? ' is-on' : ''}`}
      onClick={() => onSelect(id)}
    >
      {children}
    </button>
  );
}

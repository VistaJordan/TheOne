import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
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
import { ClientQuoteCard } from '../components/wo/ClientQuoteCard';
import { PayablesFieldsCard, PaymentHistoryCard } from '../components/wo/PayablesCard';
import { PeopleCard } from '../components/wo/PeopleCard';
import { SiteCard } from '../components/wo/SiteCard';
import { DatesCard } from '../components/wo/DatesCard';
import { CicoCard } from '../components/wo/CicoCard';
import { PartsCard } from '../components/wo/PartsCard';
import { FlagsRow } from '../components/wo/FlagsRow';
import { AllFieldsPanel } from '../components/wo/AllFieldsPanel';
import { AuditTrail } from '../components/wo/AuditTrail';
import { MessagesPanel } from '../components/wo/messages/MessagesPanel';
import { MessagesRail } from '../components/wo/messages/MessagesRail';
import { ObligationsCard, OBLIGATIONS_CARD_ID } from '../components/obligations/ObligationsCard';
import { useWoObligations } from '../hooks/useObligations';
import { daysSince } from '../lib/fields';
import { plainStatus } from '../lib/quo';
import { phaseForStatus } from '../lib/phases';
import { deriveHeaderMeta } from '../lib/woDerive';
import { tradeIcon } from '../lib/tradeIcon';
import { useAuth } from '../auth/AuthProvider';
import { tabPermKey } from '@theone/shared';

const TAB_IDS = [
  'fields', 'money', 'payables', 'people', 'site', 'dates', 'cico', 'parts',
  'flags', 'overview', 'messages', 'audit',
] as const;

type Tab = (typeof TAB_IDS)[number];

const isTab = (v: string | null): v is Tab => TAB_IDS.includes(v as Tab);

export function WorkOrderDetailPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const navigate = useNavigate();
  // The active tab lives in the URL (?tab=…) so a refresh reloads the data but
  // stays on the same tab — and a pasted link opens where the sender was.
  // "All fields" is the landing tab (the record itself before the commentary)
  // and keeps a bare URL. `replace` keeps tab hops out of the back button.
  const [searchParams, setSearchParams] = useSearchParams();
  // 0015 · each tab is its own permission; a tab the acting principal may not
  // view is not drawn, and a link to it lands on the first one they may.
  const { can } = useAuth();
  const visibleTabs = TAB_IDS.filter((t) => can(tabPermKey(t), 'view'));
  const show = (t: Tab) => visibleTabs.includes(t);
  const rawTab = searchParams.get('tab');
  const wanted: Tab = isTab(rawTab) ? rawTab : 'fields';
  const tab: Tab = show(wanted) ? wanted : (visibleTabs[0] ?? 'fields');
  const setTab = (t: Tab) =>
    setSearchParams(t === 'fields' ? {} : { tab: t }, { replace: true });

  const woQuery = useQuery({
    queryKey: ['work-orders', 'detail', woNumber],
    queryFn: () => getWorkOrder(woNumber),
    enabled: woNumber.length > 0,
  });

  const wo = woQuery.data;

  const feedQuery = useQuery({
    queryKey: ['wo-feed', wo?.id ?? woNumber],
    queryFn: () => getWorkOrderFeed(wo?.id ?? woNumber),
    enabled: Boolean(wo) && show('overview'),
  });

  // Fetched as soon as the WO resolves (not gated on the tab) because the tab
  // strip carries the thread-count badge.
  const messagesKey = ['wo-messages', wo?.id ?? woNumber] as const;
  const messagesQuery = useQuery({
    queryKey: messagesKey,
    queryFn: () => getWorkOrderMessages(wo?.id ?? woNumber),
    enabled: Boolean(wo) && show('messages'),
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
    enabled: Boolean(wo) && can('quotes', 'view'),
    retry: 0,
  });

  const paymentsQuery = useQuery({
    queryKey: ['wo-payments', woNumber],
    queryFn: () => getPaymentRequests(woNumber),
    enabled: Boolean(wo) && can('payments', 'view'),
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

  // The All-fields toolbar pins itself directly under the .wo-pin block
  // (wo-detail.css reads --wo-pin-h); the height is live-measured because the
  // header card collapses and reflows. The tab strip's width goes out the same
  // way (--wo-tabs-w): it is the audit card's minimum width, so that card can
  // shrink to its content but never ends short of the strip.
  const pinRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pinRef.current;
    const host = el?.parentElement;
    if (!el || !host) return;
    const tabs = el.querySelector<HTMLElement>('.tabs');
    const ro = new ResizeObserver(() => {
      host.style.setProperty('--wo-pin-h', `${el.offsetHeight}px`);
      if (tabs) host.style.setProperty('--wo-tabs-w', `${tabs.offsetWidth}px`);
    });
    ro.observe(el);
    if (tabs) ro.observe(tabs);
    return () => ro.disconnect();
  }, [wo?.id]);

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

  // The canvas knob wears this WO's trade glyph (the same one the list's trade
  // cell shows); with no trade — or before the WO loads — it stays the O.
  const trade = wo ? deriveHeaderMeta(wo).trade : null;

  const shell = (children: ReactNode) => (
    <AppShell
      total={totalQuery.data?.total}
      breadcrumb={breadcrumb}
      knobIcon={trade ? tradeIcon(trade) : undefined}
    >
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

  const conversation = messagesQuery.data?.conversation ?? null;
  // The comp's badge counts logged calls + texts (segments are dividers).
  const threadCount = conversation
    ? conversation.counts.calls + conversation.counts.texts
    : null;

  const obligations = obligationsQuery.data ?? [];

  // A header clock chip points at the card that owns the action. The card
  // lives on the Overview tab, so step there first, then scroll it into view.
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
      {/* The pinned block: header card + tab strip stick as ONE opaque unit
          (.wo-pin) while the panels scroll underneath and re-emerge below it. */}
      <div className="wo-pin" ref={pinRef}>
        <WoHeader
          wo={wo}
          phase={phase}
          inStatusDays={inStatusDays}
          obligations={obligations}
          onClockClick={revealObligations}
        />

        <div className="seg tabs" role="tablist" aria-label="Work order sections">
          {show('fields') && <TabButton id="fields" tab={tab} onSelect={setTab}>All fields</TabButton>}
          {show('money') && <TabButton id="money" tab={tab} onSelect={setTab}>Finances</TabButton>}
          {show('dates') && <TabButton id="dates" tab={tab} onSelect={setTab}>Dates</TabButton>}
          {show('cico') && <TabButton id="cico" tab={tab} onSelect={setTab}>CICO</TabButton>}
          {show('people') && <TabButton id="people" tab={tab} onSelect={setTab}>People</TabButton>}
          {show('payables') && <TabButton id="payables" tab={tab} onSelect={setTab}>Payables</TabButton>}
          {show('site') && <TabButton id="site" tab={tab} onSelect={setTab}>Site</TabButton>}
          {show('parts') && <TabButton id="parts" tab={tab} onSelect={setTab}>Parts</TabButton>}
          {show('flags') && <TabButton id="flags" tab={tab} onSelect={setTab}>Flags</TabButton>}
          {show('overview') && <TabButton id="overview" tab={tab} onSelect={setTab}>Overview</TabButton>}
          {show('messages') && (
            <TabButton id="messages" tab={tab} onSelect={setTab}>
              <Icon name="msg" size={12} />
              Messages
              {threadCount !== null && <span className="seg-count">{threadCount}</span>}
            </TabButton>
          )}
          {show('audit') && <TabButton id="audit" tab={tab} onSelect={setTab}>Audit trail</TabButton>}
        </div>
      </div>

      <div
        className={`wo-grid${tab === 'messages' ? ' is-messages' : ''}${
          tab === 'messages' && conversation ? '' : ' no-rail'
        }`}
      >
        <div className="col-main">
          {tab === 'overview' && (
            <div role="tabpanel" aria-label="Overview">
              {/* S5 — what is owed leads the panel: activity is context, a
                  running clock is an action. */}
              <ObligationsCard
                items={obligations}
                loading={obligationsQuery.isLoading}
                error={obligationsQuery.isError}
              />
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
            <div className="card audit-card" role="tabpanel" aria-label="Audit trail">
              <AuditTrail
                entries={activityQuery.data ?? wo.recent_activity ?? []}
                loading={activityQuery.isLoading}
                error={activityQuery.isError}
              />
            </div>
          )}

          {tab === 'fields' && (
            // No outer card: the toolbar and each section are cards of their
            // own, sitting on the canvas like the rest of the tab panels.
            <div role="tabpanel" aria-label="All fields">
              <AllFieldsPanel wo={wo} detailKey={['work-orders', 'detail', woNumber]} />
            </div>
          )}

          {tab === 'money' && (
            <div role="tabpanel" aria-label="Finances" className="fin-grid">
              <MoneyCard wo={wo} />
              <ClientQuoteCard
                wo={wo}
                quoteStatus={
                  quoteQuery.isSuccess ? (quoteQuery.data.quote?.status ?? null) : undefined
                }
              />
            </div>
          )}

          {tab === 'payables' && (
            <div role="tabpanel" aria-label="Payables" className="pay-grid">
              <PayablesFieldsCard wo={wo} />
              <PaymentHistoryCard
                woNumber={wo.wo_number}
                items={paymentsQuery.data?.items ?? []}
                totalPaid={paymentsQuery.data?.total_paid ?? null}
                loading={paymentsQuery.isLoading}
              />
            </div>
          )}

          {tab === 'people' && (
            <div role="tabpanel" aria-label="People"><PeopleCard wo={wo} /></div>
          )}

          {tab === 'site' && (
            <div role="tabpanel" aria-label="Site"><SiteCard wo={wo} /></div>
          )}

          {tab === 'dates' && (
            <div role="tabpanel" aria-label="Dates"><DatesCard wo={wo} /></div>
          )}

          {tab === 'cico' && (
            <div role="tabpanel" aria-label="Check-in / check-out"><CicoCard wo={wo} /></div>
          )}

          {tab === 'parts' && (
            <div role="tabpanel" aria-label="Parts"><PartsCard wo={wo} /></div>
          )}

          {tab === 'flags' && (
            <div role="tabpanel" aria-label="Flags"><FlagsRow wo={wo} /></div>
          )}
        </div>

        {tab === 'messages' && conversation && (
          <aside className="rail">
            <MessagesRail conversation={conversation} items={messagesQuery.data?.items ?? []} />
          </aside>
        )}
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

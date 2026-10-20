import { useEffect, useMemo, useRef, useState } from 'react';
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
import { PhotosCard } from '../components/wo/PhotosCard';
import { SoftCloseChecklist } from '../components/wo/SoftCloseChecklist';
import { MoneyCard } from '../components/wo/MoneyCard';
import { ClientQuoteCard } from '../components/wo/ClientQuoteCard';
import { InvoiceCard } from '../components/wo/InvoiceCard';
import { VendorBillsCard } from '../components/wo/VendorBillsCard';
import { PayablesFieldsCard, PaymentHistoryCard } from '../components/wo/PayablesCard';
import { AssignmentHistoryCard, PeopleCard } from '../components/wo/PeopleCard';
import { SuggestedVendorsCard } from '../components/wo/tech/SuggestedVendorsCard';
import { TechniciansCard } from '../components/wo/tech/TechniciansCard';
import { SiteCard } from '../components/wo/SiteCard';
import { DatesCard } from '../components/wo/DatesCard';
import { CicoCard } from '../components/wo/CicoCard';
import { PartsCard } from '../components/wo/PartsCard';
import { AllFieldsPanel } from '../components/wo/AllFieldsPanel';
import { AuditTrail } from '../components/wo/AuditTrail';
import { MessagesPanel } from '../components/wo/messages/MessagesPanel';
import { CallsCard } from '../components/wo/calls/CallsCard';
import { EtaCard, RecordActions, RecordBar, RecordRail, ResponsibleVendorCard, useWoRecord } from '../components/wo/record/RecordParts';
import { ChecklistTab, CostBreakdownTab, RelatedTab, TimelogTab } from '../components/wo/record/RecordTabs';
import { JobPlanServicesCard, PermitsCard, TimeCard } from '../components/wo/maint/WoMaintCards';
import { ConsumablesCard, DispatchCard } from '../components/wo/maint/WoVendorCards';
import { WoPurchasingCard } from './PurchasingPage';
import { MessagesRail } from '../components/wo/messages/MessagesRail';
import { ObligationsCard, OBLIGATIONS_CARD_ID } from '../components/obligations/ObligationsCard';
import { useWoObligations } from '../hooks/useObligations';
import { daysSince } from '../lib/fields';
import { plainStatus } from '../lib/quo';
import { phaseForStatus } from '../lib/phases';
import { deriveHeaderMeta } from '../lib/woDerive';
import { tradeIcon } from '../lib/tradeIcon';
import { useAuth } from '../auth/AuthProvider';
import { quoteSectionsHaveData, tabPermKey } from '@theone/shared';

const TAB_IDS = [
  'fields', 'money', 'payables', 'people', 'technicians', 'site', 'dates', 'cico', 'parts',
  'overview', 'messages', 'audit',
  // 0064 · the record's own tabs. Checklist (tasks) and Related have no button
  // on the strip since 2026-10-20; a link to them (Maintenance › Work permits,
  // a vendor's consumables) still opens them.
  'tasks', 'costs', 'timelog', 'related',
] as const;

/** 0064 · the tabs that carry the right rail (Responsibility · Location ·
    Time · Cost). The wide ones — All fields, the audit trail — and the tabs
    that are one card of their own keep the full width they had. */
const RAIL_TABS: readonly string[] = ['overview', 'tasks', 'costs', 'timelog', 'related'];

type Tab = (typeof TAB_IDS)[number];

/** 2026-10-20 · strip buttons that stand for a group of sub-tabs: Finances =
    Finances · Payables · Cost breakdown, People = Our team · Technicians. Each
    sub-tab keeps its own id, so ?tab= links and each tab's permission stay as
    they were. */
const TAB_GROUPS: { id: string; label: string; tabs: { id: Tab; label: string }[] }[] = [
  { id: 'money', label: 'Finances', tabs: [
    { id: 'money', label: 'Finances' },
    { id: 'payables', label: 'Payables' },
    { id: 'costs', label: 'Cost breakdown' },
  ] },
  { id: 'people', label: 'People', tabs: [
    { id: 'people', label: 'Our team' },
    { id: 'technicians', label: 'Technicians' },
  ] },
];

/** The permission a tab is shown under: Technicians was part of People and
    keeps People's grant. */
const tabPerm = (t: Tab): string => tabPermKey(t === 'technicians' ? 'people' : t);

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
  const visibleTabs = TAB_IDS.filter((t) => can(tabPerm(t), 'view'));
  const show = (t: Tab) => visibleTabs.includes(t);
  const rawTab = searchParams.get('tab');
  // 2026-10-20 · Timelog lives on CICO now: an old ?tab=timelog link opens
  // CICO (the Timelog view itself only for someone who cannot see CICO).
  const wanted: Tab = rawTab === 'timelog' && show('cico') ? 'cico' : isTab(rawTab) ? rawTab : 'fields';
  const tab: Tab = show(wanted) ? wanted : (visibleTabs[0] ?? 'fields');
  const setTab = (t: Tab) =>
    setSearchParams(t === 'fields' ? {} : { tab: t }, { replace: true });
  // A group's button lands on the first sub-tab the person may see, and reads
  // as on while any of its sub-tabs is open.
  const groupTabs = (id: string) => (TAB_GROUPS.find((g) => g.id === id)?.tabs ?? []).filter((x) => show(x.id));
  const activeGroup = TAB_GROUPS.find((g) => g.tabs.some((x) => x.id === tab)) ?? null;
  // What Cancel / Reopen / Resume could not do, said under the header.
  const [recordNote, setRecordNote] = useState<string | null>(null);

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

  // 0064 · the record: state, rail, checklist, timelog, costs, related. One
  // read; decoration-grade like the cards above (a failure hides the bar and
  // the rail, never the page).
  const recordQuery = useWoRecord(wo?.id);

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
    // 0026: the row scope — the work order exists, it just is not theirs.
    const outOfScope = woQuery.error instanceof ApiRequestError && woQuery.error.status === 403;
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>
          {notFound
            ? `${woNumber} not found`
            : outOfScope
              ? `${woNumber} is not assigned to you`
              : 'Could not load this work order'}
        </b>
        <span>
          {notFound
            ? 'It may have been deleted, or the number is wrong.'
            : outOfScope
              ? 'You see the work orders assigned to you. Ask a manager if you need this one.'
              : 'Is the API running on :5174?'}
        </span>
        <Link className="btn" to="/">Back to Work Orders</Link>
      </div>,
    );
  }

  const conversation = messagesQuery.data?.quo.conversation ?? null;
  // 0052 · the badge counts the work order's own messages; the Quo thread
  // keeps its own counts in the rail.
  const threadCount = messagesQuery.data ? messagesQuery.data.items.length : null;

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
          quoteFilled={quoteQuery.data ? quoteSectionsHaveData(quoteQuery.data.quote?.sections) : null}
          actions={<RecordActions woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} onNote={setRecordNote} />}
        />

        {/* 0064 · what state the job is in. */}
        <RecordBar woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} note={recordNote} />

        <div className="seg tabs" role="tablist" aria-label="Work order sections">
          {show('fields') && <TabButton id="fields" tab={tab} onSelect={setTab}>All fields</TabButton>}
          {groupTabs('money').length > 0 && (
            <GroupButton on={activeGroup?.id === 'money'} onSelect={() => setTab(groupTabs('money')[0].id)}>Finances</GroupButton>
          )}
          {show('dates') && <TabButton id="dates" tab={tab} onSelect={setTab}>Dates</TabButton>}
          {show('cico') && <TabButton id="cico" tab={tab} onSelect={setTab}>CICO</TabButton>}
          {groupTabs('people').length > 0 && (
            <GroupButton on={activeGroup?.id === 'people'} onSelect={() => setTab(groupTabs('people')[0].id)}>People</GroupButton>
          )}
          {show('site') && <TabButton id="site" tab={tab} onSelect={setTab}>Site</TabButton>}
          {show('parts') && <TabButton id="parts" tab={tab} onSelect={setTab}>Parts</TabButton>}
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
          tab === 'messages' && conversation ? '' : RAIL_TABS.includes(tab) ? ' has-record-rail' : ' no-rail'
        }`}
      >
        <div className="col-main">
          {activeGroup && groupTabs(activeGroup.id).length > 1 && (
            <div className="seg tabs wo-subtabs" role="tablist" aria-label={`${activeGroup.label} sections`}>
              {groupTabs(activeGroup.id).map((x) => (
                <TabButton key={x.id} id={x.id} tab={tab} onSelect={setTab}>{x.label}</TabButton>
              ))}
            </div>
          )}

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
                {/* 0052 · posting moved to the Messages tab; the feed is the read. */}
                {show('messages') && (
                  <div className="feed-to-messages">
                    <button type="button" className="btn btn-sm" onClick={() => setTab('messages')}>
                      <Icon name="msg" size={12} />
                      Write a message
                    </button>
                  </div>
                )}
              </section>

              <PhotosCard wo={wo} />
              <SoftCloseChecklist wo={wo} />
            </div>
          )}

          {/* 0054 · calls placed through Quo from this work order, and the
              way into the AI quote draft — above the written thread. */}
          {tab === 'messages' && <CallsCard woId={wo.id} woNumber={wo.wo_number} />}
          {tab === 'messages' && (
            <MessagesPanel
              woId={wo.id}
              woNumber={wo.wo_number}
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
                quote={quoteQuery.isSuccess ? quoteQuery.data.quote : null}
              />
              {/* 0045 · what the client was actually billed. This tab used to
                  stop at the quote, which is only what we proposed. */}
              <InvoiceCard wo={wo} />
            </div>
          )}

          {tab === 'payables' && (
            <div role="tabpanel" aria-label="Payables" className="pay-grid">
              <PayablesFieldsCard wo={wo} />
              {/* 0047 · the vendor's own invoice — the document the payment
                  request should be settling. */}
              <VendorBillsCard wo={wo} />
              {/* 0067 · what was requested, quoted and ordered for this job. */}
              <WoPurchasingCard woId={wo.id} woNumber={wo.wo_number} />
              <PaymentHistoryCard
                woNumber={wo.wo_number}
                items={paymentsQuery.data?.items ?? []}
                totalPaid={paymentsQuery.data?.total_paid ?? null}
                loading={paymentsQuery.isLoading}
                requestAction={wo.actions?.['payment.request'] ?? null}
              />
            </div>
          )}

          {tab === 'people' && (
            <div role="tabpanel" aria-label="Our team">
              <PeopleCard wo={wo} />
              {/* Every change of the Assignee: who made it and when. */}
              <AssignmentHistoryCard wo={wo} />
            </div>
          )}

          {tab === 'technicians' && (
            <div role="tabpanel" aria-label="Technicians">
              {/* 0064 · the one vendor answering for the job (was Assign vendor on the bar). */}
              <ResponsibleVendorCard woId={wo.id} woNumber={wo.wo_number} />
              {/* 0057 · who has been hired onto the work order, and the map. */}
              <TechniciansCard wo={wo} />
              {/* 0069 · the top few vendors for this trade, location and client. */}
              <SuggestedVendorsCard wo={wo} />
              {/* 0066 · offering the job to the preferred vendors in turn (hidden while switched off). */}
              <DispatchCard woId={wo.id} />
            </div>
          )}

          {tab === 'site' && (
            <div role="tabpanel" aria-label="Site"><SiteCard wo={wo} /></div>
          )}

          {tab === 'dates' && (
            <div role="tabpanel" aria-label="Dates"><DatesCard wo={wo} /></div>
          )}

          {tab === 'cico' && (
            <div role="tabpanel" aria-label="Check-in / check-out">
              {/* 0064 · when the technician is expected (was Add ETA on the bar). */}
              <EtaCard woId={wo.id} woNumber={wo.wo_number} />
              <CicoCard wo={wo} />
              {/* 2026-10-20 · the Timelog tab, merged in under the visits; still
                  behind the Timelog tab's own permission. */}
              {show('timelog') && (
                <div className="cico-timelog">
                  {/* 0065 · who worked on it, from when to when. */}
                  <TimeCard woId={wo.id} />
                  {recordQuery.data && <TimelogTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />}
                </div>
              )}
            </div>
          )}

          {tab === 'parts' && (
            <div role="tabpanel" aria-label="Parts"><PartsCard wo={wo} /></div>
          )}

          {/* 0064 · the four tabs that read the record. */}
          {(tab === 'tasks' || tab === 'costs' || tab === 'timelog' || tab === 'related') && (
            <div role="tabpanel" aria-label={tab === 'tasks' ? 'Checklist' : tab === 'costs' ? 'Cost breakdown' : tab === 'timelog' ? 'Timelog and metrics' : 'Related'}>
              {!recordQuery.data ? (
                <section className="card"><div className="empty-flat">{recordQuery.isLoading ? 'Loading…' : 'Could not load this part of the work order.'}</div></section>
              ) : tab === 'tasks' ? (
                <>
                  <ChecklistTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />
                  {/* 0065 · a job plan to lay over it, and the services done. */}
                  <JobPlanServicesCard woId={wo.id} />
                  {/* 0066 · the stock the job used up. */}
                  <ConsumablesCard woId={wo.id} />
                </>
              ) : tab === 'costs' ? (
                <CostBreakdownTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />
              ) : tab === 'timelog' ? (
                <>
                  {/* 0065 · who worked on it, from when to when. */}
                  <TimeCard woId={wo.id} />
                  <TimelogTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />
                </>
              ) : (
                <>
                  {/* 0065 · the work permits of this job. */}
                  <PermitsCard woId={wo.id} />
                  <RelatedTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />
                </>
              )}
            </div>
          )}
        </div>

        {RAIL_TABS.includes(tab) && <RecordRail woId={wo.id} record={recordQuery.data} loading={recordQuery.isLoading} />}

        {tab === 'messages' && conversation && (
          <aside className="rail">
            <MessagesRail conversation={conversation} items={messagesQuery.data?.quo.items ?? []} />
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

/** A strip button that stands for a group of sub-tabs. */
function GroupButton({ on, onSelect, children }: { on: boolean; onSelect: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={on} className={`seg-btn${on ? ' is-on' : ''}`} onClick={onSelect}>
      {children}
    </button>
  );
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

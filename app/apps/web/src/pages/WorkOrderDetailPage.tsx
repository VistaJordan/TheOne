import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useLinkNav } from '../lib/linkNav';
import { useQuery } from '@tanstack/react-query';
import {
  getActivity,
  getPaymentRequests,
  getStatuses,
  getWorkOrder,
  getWorkOrderFeed,
  getWorkOrderMessages,
  getWorkOrderQuoMessages,
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
import { PenaltiesCard } from '../components/wo/ManagerFlags';
import { MoneyCard } from '../components/wo/MoneyCard';
import { QuoteBuilder } from './QuoteBuilderPage';
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
import { TechTextsCard } from '../components/wo/tech/TechTextsCard';
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
import { TECH_HUB_TAB, quoteSectionsHaveData, tabPermKey } from '@theone/shared';

const TAB_IDS = [
  'overview', 'fields', 'money', 'quotes', 'payables', 'people', 'technicians', 'site', 'dates', 'cico', 'parts',
  // 2026-10-22 · Drive: the work order's files (the Photos card, moved off
  // Overview). Overview leads the strip and is the landing tab.
  'drive', 'messages', 'penalties', 'audit',
  // 0064 · the record's own tabs. Checklist (tasks) and Related have no button
  // on the strip since 2026-10-20; a link to them (Maintenance › Work permits,
  // a vendor's consumables) still opens them.
  'tasks', 'costs', 'timelog', 'related',
] as const;

/** 0064 · the tabs that carry the right rail (Responsibility · Location ·
    Time · Cost). The wide ones — All fields, the audit trail — and the tabs
    that are one card of their own keep the full width they had. */
const RAIL_TABS: readonly string[] = ['overview', 'tasks', 'timelog', 'related'];

type Tab = (typeof TAB_IDS)[number];

/** 2026-10-27 (later) · Finances is ONE panel again: the money and invoice
    cards, then Payables, then the Cost breakdown, each part still behind its
    own tab permission. ?tab=payables and ?tab=costs open Finances scrolled to
    that part. The client quote stays on its own Quotes tab. */
const FINANCE_TABS: readonly Tab[] = ['money', 'payables', 'costs'];

/** 0095 · People › Technicians became the Tech Hub tab, with its own
    permission row (it rode on People's until then); People is one tab again.
    The id stays `technicians` (TECH_HUB_TAB) so old ?tab= links still open it. */
const tabPerm = (t: Tab): string => tabPermKey(t);

const isTab = (v: string | null): v is Tab => TAB_IDS.includes(v as Tab);

export function WorkOrderDetailPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const { linkTo } = useLinkNav();
  // The active tab lives in the URL (?tab=…) so a refresh reloads the data but
  // stays on the same tab — and a pasted link opens where the sender was.
  // Overview is the landing tab since 2026-10-22 (All fields was) and keeps a
  // bare URL. `replace` keeps tab hops out of the back button.
  const [searchParams, setSearchParams] = useSearchParams();
  // 0015 · each tab is its own permission; a tab the acting principal may not
  // view is not drawn, and a link to it lands on the first one they may.
  const { can } = useAuth();
  // The Quotes tab also needs the quotes section itself: without it the tab
  // would hold nothing.
  // Penalties likewise needs its field section (0094).
  const visibleTabs = TAB_IDS.filter(
    (t) =>
      can(tabPerm(t), 'view') &&
      (t !== 'quotes' || can('quotes', 'view')) &&
      (t !== 'penalties' || can('work_orders/fields/penalties', 'view')),
  );
  const show = (t: Tab) => visibleTabs.includes(t);
  const rawTab = searchParams.get('tab');
  // 2026-10-20 · Timelog lives on CICO now: an old ?tab=timelog link opens
  // CICO (the Timelog view itself only for someone who cannot see CICO).
  const asked: Tab = rawTab === 'timelog' && show('cico') ? 'cico' : isTab(rawTab) ? rawTab : 'overview';
  // The Finances panel opens for anyone who may see any of its three parts.
  const financeParts = FINANCE_TABS.filter(show);
  const toPanel = (t: Tab): Tab => (FINANCE_TABS.includes(t) ? 'money' : t);
  const canOpen = (t: Tab) => (t === 'money' ? financeParts.length > 0 : show(t));
  const wanted = toPanel(asked);
  const tab: Tab = canOpen(wanted) ? wanted : toPanel(visibleTabs[0] ?? 'overview');
  // Which part of Finances a ?tab=payables / ?tab=costs link pointed at.
  const financeFocus = tab === 'money' && (asked === 'payables' || asked === 'costs') && show(asked) ? asked : null;
  const setTab = (t: Tab) =>
    setSearchParams(t === 'overview' ? {} : { tab: t }, { replace: true });
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

  // 0095 · the Quo technician thread, drawn on Tech Hub (and its rail).
  const quoKey = ['wo-quo', wo?.id ?? woNumber] as const;
  const quoQuery = useQuery({
    queryKey: quoKey,
    queryFn: () => getWorkOrderQuoMessages(wo?.id ?? woNumber),
    enabled: Boolean(wo) && show(TECH_HUB_TAB),
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

  // A link to Payables or the Cost breakdown lands on that part of Finances,
  // once per link (the record loading later does not pull the page back).
  const focusedRef = useRef<string | null>(null);
  const costsReady = Boolean(recordQuery.data);
  useEffect(() => {
    if (!financeFocus || !wo) return;
    const key = `${wo.id}:${financeFocus}`;
    if (focusedRef.current === key) return;
    if (financeFocus === 'costs' && !costsReady) return;
    const el = document.getElementById(`fin-${financeFocus}`);
    if (!el) return;
    focusedRef.current = key;
    el.scrollIntoView({ block: 'start' });
  }, [financeFocus, wo?.id, costsReady]);

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
        {...linkTo('/')}
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

  const conversation = quoQuery.data?.conversation ?? null;
  // 0052 · the badge counts the work order's own messages; the Quo thread
  // keeps its own counts in Tech Hub's rail.
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
          quoteStatus={quoteQuery.data ? (quoteQuery.data.quote?.status ?? null) : undefined}
          actions={<RecordActions woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} onNote={setRecordNote} />}
        />

        {/* 0064 · what state the job is in. */}
        <RecordBar woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} note={recordNote} />

        <div className="seg tabs" role="tablist" aria-label="Work order sections">
          {show('overview') && <TabButton id="overview" tab={tab} onSelect={setTab}>Overview</TabButton>}
          {show('fields') && <TabButton id="fields" tab={tab} onSelect={setTab}>All fields</TabButton>}
          {canOpen('money') && <TabButton id="money" tab={tab} onSelect={setTab}>Finances</TabButton>}
          {show('quotes') && <TabButton id="quotes" tab={tab} onSelect={setTab}>Quotes</TabButton>}
          {show('dates') && <TabButton id="dates" tab={tab} onSelect={setTab}>Dates</TabButton>}
          {show('cico') && <TabButton id="cico" tab={tab} onSelect={setTab}>CICO</TabButton>}
          {show('people') && <TabButton id="people" tab={tab} onSelect={setTab}>People</TabButton>}
          {show('site') && <TabButton id="site" tab={tab} onSelect={setTab}>Site</TabButton>}
          {show('parts') && <TabButton id="parts" tab={tab} onSelect={setTab}>Parts</TabButton>}
          {show('drive') && <TabButton id="drive" tab={tab} onSelect={setTab}>Drive</TabButton>}
          {show('messages') && (
            <TabButton id="messages" tab={tab} onSelect={setTab}>
              <Icon name="msg" size={12} />
              Messages
              {threadCount !== null && <span className="seg-count">{threadCount}</span>}
            </TabButton>
          )}
          {show(TECH_HUB_TAB) && <TabButton id={TECH_HUB_TAB} tab={tab} onSelect={setTab}>Tech Hub</TabButton>}
          {show('penalties') && <TabButton id="penalties" tab={tab} onSelect={setTab}>Penalties</TabButton>}
          {show('audit') && <TabButton id="audit" tab={tab} onSelect={setTab}>Audit trail</TabButton>}
        </div>
      </div>

      <div
        className={`wo-grid${tab === TECH_HUB_TAB && conversation ? ' is-messages' : ''}${
          tab === TECH_HUB_TAB && conversation ? '' : RAIL_TABS.includes(tab) ? ' has-record-rail' : ' no-rail'
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

              <SoftCloseChecklist wo={wo} />
            </div>
          )}

          {/* 2026-10-22 · Drive: the work order's photos and files, on a tab
              of their own (they used to close the Overview tab). */}
          {tab === 'drive' && (
            <div role="tabpanel" aria-label="Drive">
              <PhotosCard wo={wo} />
            </div>
          )}

          {/* 0095 · Messages is the conversation with the team and the client:
              the calls to the client above the written thread. Technician
              calls, texts and the AI quote draft are on Tech Hub. */}
          {tab === 'messages' && <CallsCard wo={wo} side="client" />}
          {tab === 'messages' && (
            <MessagesPanel
              woId={wo.id}
              woNumber={wo.wo_number}
              data={messagesQuery.data}
              loading={messagesQuery.isLoading}
              error={messagesQuery.isError}
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

          {/* 2026-10-27 · the Quotes tab IS the quote: the builder opens
              right here (Create quote when there is none), no "Open quote". */}
          {tab === 'quotes' && (
            <div role="tabpanel" aria-label="Quotes" className="quote-tab">
              <QuoteBuilder woNumber={wo.wo_number} embedded />
            </div>
          )}

          {/* 2026-10-27 · Finances, Payables and Cost breakdown on one panel,
              each part behind its own tab permission. */}
          {tab === 'money' && (
            <div role="tabpanel" aria-label="Finances" className="fin-stack">
              {show('money') && (
                <div className="fin-grid">
                  {/* The money card (Profitability exception + Manager notes inside it). */}
                  <MoneyCard wo={wo} />
                  {/* 0045 · what the client was actually billed. */}
                  <InvoiceCard wo={wo} />
                </div>
              )}

              {show('payables') && (
                <section id="fin-payables" className="fin-part" aria-label="Payables">
                  <h2 className="fin-part-title">Payables</h2>
                  <div className="pay-grid">
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
                </section>
              )}

              {show('costs') && (
                <section id="fin-costs" className="fin-part" aria-label="Cost breakdown">
                  <h2 className="fin-part-title">Cost breakdown</h2>
                  {recordQuery.data ? (
                    <CostBreakdownTab woId={wo.id} woNumber={wo.wo_number} record={recordQuery.data} />
                  ) : (
                    <section className="card">
                      <div className="empty-flat">{recordQuery.isLoading ? 'Loading…' : 'Could not load the cost breakdown.'}</div>
                    </section>
                  )}
                </section>
              )}
            </div>
          )}

          {/* 2026-10-27 · Penalties, a tab of its own after Tech Hub: Bad
              quote, Penalty, Late quote, Missed ETA, Recall and the manager's
              description (also a section of All fields). */}
          {tab === 'penalties' && (
            <div role="tabpanel" aria-label="Penalties" className="penalties-tab">
              <PenaltiesCard wo={wo} />
            </div>
          )}

          {tab === 'people' && (
            <div role="tabpanel" aria-label="Our team">
              <PeopleCard wo={wo} />
              {/* Every change of the Assignee: who made it and when. */}
              <AssignmentHistoryCard wo={wo} />
            </div>
          )}

          {/* 0095 · Tech Hub (was People › Technicians): finding, hiring and
              talking to the technician — calls (with the AI quote draft) and
              the Quo texts sit here, away from the client conversation. */}
          {tab === TECH_HUB_TAB && (
            <div role="tabpanel" aria-label="Tech Hub">
              {/* 0064 · the one vendor answering for the job (was Assign vendor on the bar). */}
              <ResponsibleVendorCard woId={wo.id} woNumber={wo.wo_number} />
              {/* 0069 · the top few vendors for this trade, location and client. */}
              <SuggestedVendorsCard wo={wo} />
              {/* 0057 · who has been hired onto the work order, and the map. */}
              <TechniciansCard wo={wo} />
              {/* 0054 · calls to technicians and vendors, and the AI quote draft. */}
              <CallsCard wo={wo} side="tech" />
              {/* S3 · the Quo technician texts (moved off Messages). */}
              <TechTextsCard
                woId={wo.id}
                data={quoQuery.data}
                queryKey={quoKey}
                waitingOn={plainStatus(wo.status.name)}
              />
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

          {/* 0064 · the tabs that read the record (Cost breakdown is on Finances). */}
          {(tab === 'tasks' || tab === 'timelog' || tab === 'related') && (
            <div role="tabpanel" aria-label={tab === 'tasks' ? 'Checklist' : tab === 'timelog' ? 'Timelog and metrics' : 'Related'}>
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

        {tab === TECH_HUB_TAB && conversation && (
          <aside className="rail">
            <MessagesRail conversation={conversation} items={quoQuery.data?.items ?? []} />
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

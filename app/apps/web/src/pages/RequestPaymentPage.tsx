/* /work-orders/:woNumber/request-payment — the technician payment request,
   at Yoda parity (PaymentEngine / payment-form).

   Hardened rules:

   · AMOUNT IS VALIDATED AS A RAW STRING. Sanitising before parseFloat approved
     "-500" as $500, "5e3" as $53 and "12.34.56" as $12.34. parseMoney() strips
     only currency chrome and then demands a full-string plain decimal — this is
     a money-releasing form, so anything else is an error, not a coercion.
   · THE WO STATUS GATES THE REQUEST (G-W01). A finished / canceled work order
     renders the submit control locked with the reason, never hidden.
   · W9 THRESHOLD (Yoda): a non-credit payment that takes the technician past
     $599 this year flags the W9 requirement live, before submit.
*/

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiRequestError,
  PAYMENT_METHODS,
  getPaymentRequests,
  getVendorYtd,
  getWorkOrder,
  getWorkOrderMessages,
  postPaymentRequest,
} from '../api/client';
import type { PaymentMethod, PaymentRequest, Vendor } from '../api/client';
import { AppShell } from '../components/AppShell';
import { CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { PaymentsTable } from '../components/payments/PaymentsTable';
import {
  PaymentAddressFields,
  addressErrors,
  blankAddress,
  toPaymentAddress,
} from '../components/payments/PaymentAddressFields';
import type { AddressDraft } from '../components/payments/PaymentAddressFields';
import { VendorPicker } from '../components/payments/VendorPicker';
import { parseMoney, usd } from '../lib/quoteTotals';
import { deriveSite } from '../lib/woDerive';

interface Payee {
  vendor_id: string | null;
  name: string;
  phone: string | null;
  is_w9_present: boolean | null;
  is_blacklisted: boolean | null;
  source: 'quo' | 'prior' | 'picked';
}

/** Yoda: a running total above $599 per technician + company + year needs a W9. */
const W9_THRESHOLD = 599;

export function RequestPaymentPage() {
  const { woNumber = '' } = useParams<{ woNumber: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const woQuery = useQuery({
    queryKey: ['work-orders', 'detail', woNumber],
    queryFn: () => getWorkOrder(woNumber),
    enabled: woNumber.length > 0,
  });

  const paymentsKey = ['wo-payments', woNumber] as const;
  const paymentsQuery = useQuery({
    queryKey: paymentsKey,
    queryFn: () => getPaymentRequests(woNumber),
    enabled: woNumber.length > 0,
  });

  // The WO's linked technician: the vendor on its Quo conversation, falling back
  // to whoever an earlier payable on this WO was paid to.
  const messagesQuery = useQuery({
    queryKey: ['wo-messages', woNumber],
    queryFn: () => getWorkOrderMessages(woNumber),
    enabled: woNumber.length > 0,
  });

  const items = useMemo(() => paymentsQuery.data?.items ?? [], [paymentsQuery.data]);

  const linkedPayee: Payee | null = useMemo(() => {
    const vendor = messagesQuery.data?.conversation?.vendor;
    if (vendor) {
      return { vendor_id: vendor.id, name: vendor.name, phone: vendor.phone, is_w9_present: null, is_blacklisted: null, source: 'quo' };
    }
    const prior = items.find((p) => p.payee.vendor_id || p.payee.name);
    if (prior) {
      return {
        vendor_id: prior.payee.vendor_id,
        name: prior.payee.name ?? 'Vendor on this work order',
        phone: prior.payee.phone,
        is_w9_present: prior.payee.is_w9_present,
        is_blacklisted: prior.payee.is_blacklisted,
        source: 'prior',
      };
    }
    return null;
  }, [messagesQuery.data, items]);

  // ── Form state ─────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<'linked' | 'search' | 'manual'>('linked');
  const [picked, setPicked] = useState<Vendor | null>(null);
  const [manualName, setManualName] = useState('');
  const [manualPhone, setManualPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('zelle');
  const [address, setAddress] = useState<AddressDraft>(blankAddress);
  const [addressTouched, setAddressTouched] = useState(false);
  const [note, setNote] = useState('');
  const [recipientOpen, setRecipientOpen] = useState(false);
  const [recipientName, setRecipientName] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [recipientIsStore, setRecipientIsStore] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<PaymentRequest | null>(null);

  // No linked technician → open straight on the search.
  useEffect(() => {
    if (!messagesQuery.isLoading && !paymentsQuery.isLoading && linkedPayee === null && mode === 'linked') setMode('search');
  }, [messagesQuery.isLoading, paymentsQuery.isLoading, linkedPayee, mode]);

  const payee: Payee | null =
    mode === 'manual'
      ? null
      : mode === 'search'
        ? picked
          ? { vendor_id: picked.id, name: picked.name, phone: picked.phone, is_w9_present: picked.is_w9_present, is_blacklisted: picked.is_blacklisted, source: 'picked' }
          : null
        : linkedPayee;

  const wo = woQuery.data;
  const actionState = wo?.actions?.['payment.request'] ?? null;
  const woBlocked = actionState ? !actionState.allowed : false;

  // Yoda GetReciepientTotal — this year's non-credit payments to the technician.
  const ytdQuery = useQuery({
    queryKey: ['vendor-ytd', payee?.vendor_id, wo?.billing_entity],
    queryFn: () => getVendorYtd(payee?.vendor_id as string, wo?.billing_entity ?? null),
    enabled: !!payee?.vendor_id,
    staleTime: 30_000,
  });

  const parsedAmount = parseMoney(amount);
  const amountValid = !Number.isNaN(parsedAmount);
  const amountError = amountTouched && !amountValid;
  const purposeValid = purpose.trim().length > 0;
  const duplicatePurpose = items.some(
    (p) => p.status !== 'rejected' && p.purpose.trim().toLowerCase() === purpose.trim().toLowerCase(),
  );
  const payeeValid =
    mode === 'manual'
      ? manualName.trim().length > 0 && manualPhone.trim().length > 0
      : payee !== null;
  const addrErrs = addressErrors(method, address);
  const addressValid = Object.keys(addrErrs).length === 0;
  const blacklisted = payee?.is_blacklisted === true;
  const valid = amountValid && purposeValid && !duplicatePurpose && payeeValid && addressValid && !blacklisted && !woBlocked;

  const ytdTotal = ytdQuery.data?.total ?? 0;
  const projected = ytdTotal + (amountValid && method !== 'credit' ? parsedAmount : 0);
  const needsW9 = payee !== null && payee.is_w9_present !== true && method !== 'credit' && projected > W9_THRESHOLD;

  const helpText = woBlocked
    ? (actionState?.reason ?? 'Not allowed in this work-order status')
    : blacklisted
      ? 'This technician is blacklisted — AP cannot pay them'
      : !payeeValid
        ? mode === 'manual' && manualName.trim().length > 0
          ? 'Add the technician’s phone to submit'
          : 'Name the technician to submit'
        : !purposeValid
          ? 'Add a purpose to submit'
          : duplicatePurpose
            ? 'A payment with this purpose already exists on this WO'
            : !amountValid
              ? 'Enter an amount to submit'
              : 'Complete the payout details to submit';

  const submitMutation = useMutation({
    mutationFn: () =>
      postPaymentRequest(woNumber, {
        ...(mode === 'manual'
          ? { vendor_id: null, payee_name: manualName.trim(), payee_phone: manualPhone.trim() }
          : {
              vendor_id: payee?.vendor_id ?? null,
              // Falls back to the manual pair when the linked technician came
              // from a prior payable that had no vendor record behind it.
              payee_name: payee?.vendor_id ? null : (payee?.name ?? null),
              payee_phone: payee?.vendor_id ? null : (payee?.phone ?? null),
            }),
        purpose: purpose.trim(),
        amount: parsedAmount,
        method,
        payment_address: toPaymentAddress(method, address),
        note: note.trim() === '' ? null : note.trim(),
        recipient_name: recipientOpen && recipientName.trim() !== '' ? recipientName.trim() : null,
        recipient_phone: recipientOpen && recipientPhone.trim() !== '' ? recipientPhone.trim() : null,
        recipient_is_store: recipientOpen && recipientIsStore,
      }),
    onSuccess: (res) => {
      setSubmitted(res.item);
      setSubmitError(null);
      void queryClient.invalidateQueries({ queryKey: paymentsKey });
      void queryClient.invalidateQueries({ queryKey: ['work-orders', 'detail', woNumber] });
      void queryClient.invalidateQueries({ queryKey: ['vendor-ytd'] });
    },
    onError: (err) =>
      setSubmitError(
        err instanceof ApiRequestError ? err.message : 'The payment request could not be submitted.',
      ),
  });

  const resetForAnother = () => {
    setSubmitted(null);
    setPurpose('');
    setAmount('');
    setAmountTouched(false);
    setAddressTouched(false);
    setNote('');
  };

  // ── Chrome ─────────────────────────────────────────────────────────────────
  const woHref = `/work-orders/${encodeURIComponent(woNumber)}`;
  const breadcrumb = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label={`Back to ${woNumber}`} onClick={() => navigate(woHref)}>
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/">Work Orders</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <Link className="crumb is-id" to={woHref}>{woNumber}</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">Request payment</span>
    </nav>
  );

  const shell = (children: ReactNode) => (
    <AppShell active="Work Orders" breadcrumb={breadcrumb}>
      <div className="canvas-inner pay">{children}</div>
    </AppShell>
  );

  if (woQuery.isLoading) {
    return shell(<div className="wo-state"><b>Loading {woNumber}…</b></div>);
  }

  const site = wo ? deriveSite(wo) : null;
  const totalPaid = paymentsQuery.data?.total_paid ?? 0;
  const totalRequested = paymentsQuery.data?.total_requested ?? 0;
  const thisAmount = amountValid ? parsedAmount : null;
  const status = submitted?.status ?? null;

  return shell(
    <>
      {/* ══ Context header (read-only, from the WO) ══════════════════════ */}
      <section className="card pghead">
        <div className="pghead-top">
          <div className="pghead-idline">
            <h1 className="pg-title">Request payment</h1>
            <span className="extref">
              <span className="extref-k">Work order</span>
              <span className="extref-v">{woNumber}</span>
              <CopyButton value={woNumber} label="Copy work order number" size={12} />
            </span>
            <span className="chip chip-accent">
              <Icon name="dollar" size={12} />
              Technician payment
            </span>
            {wo && (
              <span className="chip chip-sm chip-outline" title="Work-order status">
                <span className="pill-dot" aria-hidden="true" style={{ background: wo.status.color }} />
                {wo.status.name}
              </span>
            )}
          </div>
          <div className="pghead-actions">
            <Link className="btn" to={woHref}>
              <Icon name="arrow-l" size={14} />
              Back to work order
            </Link>
          </div>
        </div>

        <dl className="ctx">
          <div className="ctx-cell">
            <dt className="ctx-k"><Icon name="store" size={12} />Work order</dt>
            <dd className="ctx-v">
              {woNumber}
              {site && <span className="ctx-sub">{site.name}</span>}
            </dd>
          </div>
          <div className="ctx-cell">
            <dt className="ctx-k"><Icon name="user" size={12} />Trade</dt>
            <dd className="ctx-v">{wo?.trade ?? '—'}</dd>
          </div>
          <div className="ctx-cell">
            <dt className="ctx-k">Company</dt>
            <dd className="ctx-v">
              {wo?.billing_entity ?? '—'} <span className="ctx-sub">billing entity</span>
            </dd>
          </div>
          <div className="ctx-cell">
            <dt className="ctx-k">FM company</dt>
            <dd className="ctx-v">
              {wo?.client ?? '—'}
              {wo?.ext_name && <span className="ctx-sub">ext ref {wo.ext_name}</span>}
            </dd>
          </div>
        </dl>
        <span className="ro-cap">
          <Icon name="lock" size={12} />
          Read-only — pulled from the work order. Edit it on {woNumber}.
        </span>
        {woBlocked && (
          <div className="callout callout-lock" style={{ marginTop: 12 }}>
            <Icon name="lock" size={14} />
            <span>
              <b>Payment requests are closed on this work order.</b> {actionState?.reason}. Existing
              requests can still be processed by AP below.
            </span>
          </div>
        )}
      </section>

      <div className="pay-grid">
        {/* ══ Main column — the request form ═══════════════════════════ */}
        <div className="col-main">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Payment request</h2>
              <span className="card-meta"><span className="req" aria-hidden="true">*</span> required</span>
            </div>

            {/* (1) Technician */}
            <section className="fsec">
              <div className="fsec-head">
                <span className="fsec-n" aria-hidden="true">1</span>
                <h3 className="fsec-title">Technician</h3>
                <span className="fsec-note">Who performed the work</span>
              </div>
              <div className="fsec-body">
                <div className="field">
                  <span className="flabel" id="lbl-vendor">
                    Vendor record <span className="req" aria-hidden="true">*</span>
                    <span className="sr">(required)</span>
                  </span>

                  {mode === 'manual' ? (
                    <div className="frow">
                      <div className="field">
                        <label className="flabel" htmlFor="payee-name">
                          Technician name <span className="req" aria-hidden="true">*</span>
                        </label>
                        <input
                          className="finput"
                          id="payee-name"
                          type="text"
                          placeholder="e.g. Gulf Coast Refrigeration LLC"
                          value={manualName}
                          onChange={(e) => setManualName(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="flabel" htmlFor="payee-phone">
                          Phone <span className="req" aria-hidden="true">*</span>
                          <span className="sr">(required)</span>
                        </label>
                        <input
                          className="finput"
                          id="payee-phone"
                          type="tel"
                          placeholder="(409) 555-0143"
                          value={manualPhone}
                          onChange={(e) => setManualPhone(e.target.value)}
                        />
                        <p className="fhelp">
                          <Icon name="info" size={12} />
                          A matching phone links the existing vendor; otherwise a vendor record is created.
                        </p>
                      </div>
                    </div>
                  ) : payee ? (
                    <div className={`vpick${blacklisted ? ' is-blocked' : ''}`} role="group" aria-labelledby="lbl-vendor">
                      <div className="vpick-top">
                        <span className="chip chip-outline">
                          <Icon name="truck" size={12} />
                          External vendor
                        </span>
                        <span className="chip chip-accent chip-sm">
                          <Icon name="check" size={12} />
                          Selected
                        </span>
                        {payee.is_w9_present === false && (
                          <span className="chip chip-sm chip-outline" title="No W9 on file for this vendor">No W9 on file</span>
                        )}
                        {blacklisted && (
                          <span className="chip chip-sm chip-danger"><Icon name="alert" size={12} />Blacklisted</span>
                        )}
                      </div>
                      <div className="vpick-name">{payee.name}</div>
                      <div className="vpick-sub">
                        {[wo?.trade, site?.addressLines[site.addressLines.length - 1]]
                          .filter(Boolean)
                          .join(' · ') || 'Linked to this work order'}
                      </div>
                      <div className="vpick-foot">
                        <span className="vpick-phone">
                          <Icon name="phone" size={14} />
                          <span className="mono">{payee.phone ?? 'No number on file'}</span>
                        </span>
                        <span className="ro-chip">
                          <Icon name="lock" size={12} />
                          {payee.source === 'quo'
                            ? 'Auto-filled from the work order’s technician'
                            : payee.source === 'prior'
                              ? 'From an earlier payment on this WO'
                              : 'Picked from the vendor list'}
                        </span>
                        {ytdQuery.data && (
                          <span className="ro-chip" title="Non-credit payments to this technician this calendar year">
                            <Icon name="history" size={12} />
                            YTD {usd(ytdQuery.data.total)}{wo?.billing_entity ? ` · ${wo.billing_entity}` : ''}
                          </span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <VendorPicker
                      trade={wo?.trade ?? null}
                      onPick={(v) => {
                        setPicked(v);
                        setMode('search');
                      }}
                      onManual={() => setMode('manual')}
                    />
                  )}

                  {(payee || mode === 'manual') && (
                    <div className="fallback">
                      <Icon name="user-plus" size={14} />
                      {mode !== 'manual' && (
                        <button type="button" className="linkbtn" onClick={() => { setPicked(null); setMode('search'); }}>
                          Pay a different technician
                        </button>
                      )}
                      {mode !== 'manual' && <span aria-hidden="true"> · </span>}
                      <button type="button" className="linkbtn" onClick={() => setMode(mode === 'manual' ? (linkedPayee ? 'linked' : 'search') : 'manual')}>
                        {mode === 'manual'
                          ? linkedPayee ? `Pay ${linkedPayee.name} — the technician linked to this work order` : 'Search the vendor list instead'
                          : 'Technician not in the vendor list? Enter a name and phone manually'}
                      </button>
                    </div>
                  )}
                </div>

                <div className="frow">
                  <div className={`field${purposeValid && duplicatePurpose ? ' is-error' : ''}`}>
                    <label className="flabel" htmlFor="purpose">
                      Purpose <span className="req" aria-hidden="true">*</span>
                      <span className="sr">(required)</span>
                    </label>
                    <input
                      className="finput"
                      id="purpose"
                      type="text"
                      placeholder="e.g. Assessment trip charge"
                      value={purpose}
                      aria-invalid={purposeValid && duplicatePurpose ? true : undefined}
                      onChange={(e) => setPurpose(e.target.value)}
                    />
                    {purposeValid && duplicatePurpose ? (
                      <p className="ferr">
                        <Icon name="alert-circle" size={12} />
                        A payment with this purpose already exists on {woNumber} — make it specific.
                      </p>
                    ) : (
                      <p className="fhelp">
                        <Icon name="info" size={12} />
                        Shown to AP and on this work order&rsquo;s payment ledger. One purpose per payment.
                      </p>
                    )}
                  </div>
                  <div className={`field${amountError ? ' is-error' : ''}`}>
                    <label className="flabel" htmlFor="amount">
                      Amount <span className="req" aria-hidden="true">*</span>
                      <span className="sr">(required)</span>
                    </label>
                    <div className="amtwrap">
                      <span className="amt-cur" aria-hidden="true">$</span>
                      <input
                        className="amt-in"
                        id="amount"
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={amount}
                        aria-invalid={amountError ? true : undefined}
                        aria-describedby={amountError ? 'amount-err' : undefined}
                        onChange={(e) => setAmount(e.target.value)}
                        onBlur={() => setAmountTouched(true)}
                      />
                    </div>
                    {amountError && (
                      <p className="ferr" id="amount-err">
                        <Icon name="alert-circle" size={12} />
                        Enter an amount greater than $0
                      </p>
                    )}
                  </div>
                </div>

                {needsW9 && (
                  <div className="callout w9-alert" role="status">
                    <Icon name="alert" size={14} />
                    <span>
                      <b>W9 needed.</b>{' '}
                      {amountValid
                        ? `This payment takes ${payee?.name ?? 'the technician'} to ${usd(projected)} this year`
                        : `${payee?.name ?? 'The technician'} is already at ${usd(ytdTotal)} this year`}
                      {wo?.billing_entity ? ` with ${wo.billing_entity}` : ''} — past the ${W9_THRESHOLD} threshold
                      with no W9 on file. AP will hold it until the W9 lands; credit-card payments don&rsquo;t count.
                    </span>
                  </div>
                )}
              </div>
            </section>

            {/* (2) Payment method */}
            <section className="fsec">
              <div className="fsec-head">
                <span className="fsec-n" aria-hidden="true">2</span>
                <h3 className="fsec-title">Payment method</h3>
                <span className="fsec-note">How AP sends the money</span>
              </div>
              <div className="fsec-body">
                <div className="frow">
                  <div className="field">
                    <label className="flabel" htmlFor="method">
                      Method <span className="req" aria-hidden="true">*</span>
                      <span className="sr">(required)</span>
                    </label>
                    <div className="selwrap">
                      <select
                        className="fselect"
                        id="method"
                        aria-describedby="method-help"
                        value={method}
                        onChange={(e) => {
                          setMethod(e.target.value as PaymentMethod);
                          setAddressTouched(false);
                        }}
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                      <span className="sel-chev" aria-hidden="true">
                        <Icon name="chev-d" size={14} />
                      </span>
                    </div>
                    <p className="fhelp" id="method-help">
                      <Icon name="info" size={12} />
                      {PAYMENT_METHODS.find((m) => m.value === method)?.hint}
                    </p>
                  </div>
                  <div className="field">
                    <span className="flabel" id="lbl-sendsto">
                      Sends to <span className="opt">(read-only)</span>
                    </span>
                    <div className="ro" role="group" aria-labelledby="lbl-sendsto">
                      <Icon name="card" size={14} />
                      <span className="ro-v">
                        {payeeValid
                          ? `${PAYMENT_METHODS.find((m) => m.value === method)?.label} · ${recipientOpen && recipientName.trim() ? recipientName.trim() : (mode === 'manual' ? manualName.trim() : payee?.name)}`
                          : 'Name the technician first'}
                      </span>
                    </div>
                    <p className="fhelp">
                      <Icon name="lock" size={12} />
                      {recipientOpen && recipientName.trim() ? 'The alternate recipient below.' : 'The technician on this request.'}
                    </p>
                  </div>
                </div>

                <div onBlur={() => setAddressTouched(true)}>
                  <PaymentAddressFields method={method} value={address} showErrors={addressTouched} onChange={setAddress} />
                </div>
              </div>
            </section>

            {/* (3) Attachments & notes */}
            <section className="fsec">
              <div className="fsec-head">
                <span className="fsec-n" aria-hidden="true">3</span>
                <h3 className="fsec-title">Attachments &amp; notes</h3>
                <span className="fsec-note">Receipt or invoice image</span>
              </div>
              <div className="fsec-body">
                <div className="field">
                  <span className="flabel" id="lbl-drop">
                    Attachments <span className="opt">(optional, but AP approves faster with a receipt)</span>
                  </span>
                  {/* File storage lands in a later sprint — the dropzone ships
                      visibly disabled rather than accepting a file it would drop
                      on the floor. */}
                  <button
                    type="button"
                    className="drop"
                    disabled
                    aria-labelledby="lbl-drop"
                    title="Coming in a later sprint"
                  >
                    <Icon name="upload" size={22} />
                    <span className="drop-t">Drop a receipt or invoice here, or browse files</span>
                    <span className="drop-s">JPG, PNG or PDF · up to 10 MB each — coming in a later sprint</span>
                  </button>
                </div>
                <div className="field">
                  <label className="flabel" htmlFor="ap-note">
                    Note for AP <span className="opt">(optional)</span>
                  </label>
                  <textarea
                    className="ftext"
                    id="ap-note"
                    placeholder="Anything AP needs to know before releasing this payment…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <p className="fhelp">
                    <Icon name="lock" size={12} />
                    Internal — never synced to the client CMMS.
                  </p>
                </div>
              </div>
            </section>

            {/* (4) Recipient (optional) */}
            <section className="fsec">
              <div className="fsec-head">
                <span className="fsec-n" aria-hidden="true">4</span>
                <h3 className="fsec-title">Recipient</h3>
                <span className="chip chip-outline chip-sm" style={{ marginLeft: 6 }}>Optional</span>
                <span className="fsec-note">Defaults to the technician above</span>
              </div>
              <div className="fsec-body">
                {recipientOpen ? (
                  <>
                    <div className="frow">
                      <div className="field">
                        <label className="flabel" htmlFor="recipient">
                          Send payment to <span className="opt">(instead of the technician)</span>
                        </label>
                        <input
                          className="finput"
                          id="recipient"
                          type="text"
                          placeholder="Name of the alternate payee"
                          value={recipientName}
                          onChange={(e) => setRecipientName(e.target.value)}
                        />
                      </div>
                      <div className="field">
                        <label className="flabel" htmlFor="recipient-phone">
                          Recipient phone <span className="opt">{recipientIsStore ? '(not needed for a store)' : '(optional)'}</span>
                        </label>
                        <input
                          className="finput"
                          id="recipient-phone"
                          type="tel"
                          placeholder="(409) 555-0100"
                          value={recipientPhone}
                          disabled={recipientIsStore}
                          onChange={(e) => setRecipientPhone(e.target.value)}
                        />
                      </div>
                    </div>
                    <label className="ck">
                      <input type="checkbox" checked={recipientIsStore} onChange={(e) => setRecipientIsStore(e.target.checked)} />
                      <span>This is a store / business, not a person (Yoda IsStore)</span>
                    </label>
                    <p className="fhelp">
                      <Icon name="info" size={12} />
                      Payments to an alternate recipient do not count toward the technician&rsquo;s W9 threshold.{' '}
                      <button
                        type="button"
                        className="linkbtn"
                        onClick={() => {
                          setRecipientOpen(false);
                          setRecipientName('');
                          setRecipientPhone('');
                          setRecipientIsStore(false);
                        }}
                      >
                        Pay the technician instead
                      </button>
                    </p>
                  </>
                ) : (
                  <button type="button" className="addrow" onClick={() => setRecipientOpen(true)}>
                    <Icon name="user-plus" />
                    <span>
                      Add recipient
                      <span className="addrow-sub">Send payment to someone other than the technician</span>
                    </span>
                    <span style={{ marginLeft: 'auto', display: 'inline-flex', color: 'var(--ink-3)' }}>
                      <Icon name="plus" size={14} />
                    </span>
                  </button>
                )}
              </div>
            </section>

            {/* Submit bar */}
            <div className="submitbar">
              <span className="autosave">
                {submitted ? (
                  <>
                    <Icon name="check-circle" size={12} />
                    Submitted · in the AP queue{submitted.needs_w9 ? ' · W9 needed' : ''}
                  </>
                ) : (
                  <>
                    <Icon name="info" size={12} />
                    Nothing is sent until you submit.
                  </>
                )}
              </span>
              <div className="submit-right">
                {/* §3.5 — the decision lives elsewhere and says so: the
                    Payments tab is where this request gets approved and paid. */}
                <span className="locked">
                  <Link className="btn" to="/payments">
                    <Icon name="card" size={14} />
                    Open Payments
                  </Link>
                  <span className="locked-cap">
                    <Icon name="info" size={12} />
                    Approved and paid from the Payments tab
                  </span>
                </span>

                {!valid && !submitted && (
                  <span className="submit-help" id="submit-help">
                    <Icon name={woBlocked || blacklisted ? 'lock' : 'alert'} size={14} />
                    {helpText}
                  </span>
                )}

                {submitted ? (
                  <button type="button" className="btn btn-lg" onClick={resetForAnother}>
                    <Icon name="plus" size={14} />
                    Request another
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn btn-lg ${woBlocked || blacklisted ? 'btn-locked' : 'btn-primary'}${submitMutation.isPending ? ' is-busy' : ''}`}
                    aria-disabled={!valid || submitMutation.isPending ? true : undefined}
                    aria-describedby={!valid ? 'submit-help' : undefined}
                    onClick={() => {
                      setAmountTouched(true);
                      setAddressTouched(true);
                      if (valid) submitMutation.mutate();
                    }}
                  >
                    <Icon name={woBlocked || blacklisted ? 'lock' : 'send'} size={14} className="btn-ic" />
                    <span className="spin" aria-hidden="true" />
                    <span className="btn-txt">Submit payment request</span>
                  </button>
                )}
              </div>
              {submitError && (
                <p className="ferr" style={{ flexBasis: '100%' }}>
                  <Icon name="alert-circle" size={12} />
                  {submitError}
                </p>
              )}
            </div>
          </section>

          {/* ══ Previous payments ════════════════════════════════════ */}
          <PaymentsTable
            items={items}
            loading={paymentsQuery.isLoading}
            error={paymentsQuery.isError}
            woNumber={woNumber}
            totalPaid={totalPaid}
          />
        </div>

        {/* ══ Right rail ═══════════════════════════════════════════════ */}
        <aside className="rail">
          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Request status</h2>
              <span
                className="pill pill-sm"
                style={{ ['--pill' as string]: submitted ? '#0f9d9f' : '#4466ff' }}
              >
                <span className="pill-dot" aria-hidden="true" />
                <span className="pill-label">{submitted ? 'Requested' : 'Draft'}</span>
              </span>
            </div>
            {/* Requested → Approved → Paid (requirements §2). Nothing on the
                timeline is reached until submit succeeds, so a pre-submit draft
                shows all three greyed. */}
            <ol className="lifebar" aria-label="Payment request lifecycle">
              {(['requested', 'approved', 'paid'] as const).map((step) => {
                const reached = status !== null && lifeIndex(status) >= lifeIndex(step);
                const current = status === step;
                return (
                  <li
                    key={step}
                    className={`life${current ? ' is-current' : reached ? ' is-done' : ''}`}
                    aria-current={current ? 'step' : undefined}
                  >
                    <span className="life-track" />
                    <span className="life-lbl">
                      <span className="life-mark">
                        {current ? <span className="life-pulse" /> : reached ? <Icon name="check" size={12} /> : null}
                      </span>
                      <span className="life-name">{LIFE_LABEL[step]}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="life-when">
              {submitted
                ? 'Requested just now. A rejected request comes back here as a draft with AP’s reason attached.'
                : 'Not yet submitted. Submitting adds it to the AP queue. A rejected request comes back here as a draft with AP’s reason attached.'}
            </p>
          </section>

          <section className="card">
            <div className="apnote">
              <span className="apnote-ic"><Icon name="inbox" size={14} /></span>
              <span>
                <span className="apnote-t">Payment requests are processed by the AP team</span>
                <span className="apnote-s">
                  Submitting adds this request to the AP queue — nothing is sent to the technician
                  until AP releases it.
                </span>
                <span className="apnote-chips">
                  <span className="chip chip-sm">
                    <Icon name="history" size={12} />
                    Typically paid in 1–2 days
                  </span>
                </span>
              </span>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h2 className="card-title">Money on this WO</h2>
              {wo?.billing_entity && <span className="card-meta">{wo.billing_entity}</span>}
            </div>
            <dl className="kvlist">
              <div className="kvrow">
                <dt>Client NTE</dt>
                <dd>{wo?.nte == null ? '—' : usd(wo.nte)}</dd>
              </div>
              <div className="kvrow">
                <dt>Paid to technician</dt>
                <dd>{usd(totalPaid)}</dd>
              </div>
              <div className="kvrow">
                <dt>This request</dt>
                <dd className={thisAmount == null ? 'is-none' : undefined}>
                  {thisAmount == null ? 'No amount entered' : usd(thisAmount)}
                </dd>
              </div>
              <div className="kvrow is-total">
                <dt>Payables total</dt>
                <dd>{usd(totalRequested + (submitted ? 0 : (thisAmount ?? 0)))}</dd>
              </div>
            </dl>
          </section>
        </aside>
      </div>
    </>,
  );
}

const LIFE_LABEL = { requested: 'Requested', approved: 'Approved', paid: 'Paid' } as const;

function lifeIndex(status: string): number {
  return ['requested', 'approved', 'paid'].indexOf(status);
}

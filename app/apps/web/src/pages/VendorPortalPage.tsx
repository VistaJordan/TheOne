/* The vendor portal (0066) — what a VENDOR opens: /vendor-portal/:token.
 *
 * No sign-in and no app chrome: the token in the address is the whole
 * credential, and the API sends only that vendor's own jobs, without money or
 * internal notes. Two kinds of link:
 *
 *   onboarding   a form about the vendor's own business; what they send waits
 *                for one of us to accept it
 *   portal       the jobs they hold: answer an offer, give an ETA, leave a note
 */

import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OnboardingPayload, PortalJob, PortalView } from '@theone/shared';
import { ApiRequestError, addPortalNote, answerPortalOffer, getVendorPortal, setPortalEta, submitVendorOnboarding } from '../api/client';
import { Icon, IconSprite } from '../components/Icon';
import { LOGO } from '../lib/brand';

const WHEN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const when = (iso: string | null) => (iso ? WHEN.format(new Date(iso)) : '—');
const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);

function Frame({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="cu-pub vp">
      <IconSprite />
      <header className="cu-pub-bar">
        <img className="cu-pub-logo" src={LOGO} alt="" />
        <span className="cu-pub-brand">Seamless FM · {title}</span>
      </header>
      <main className="cu-pub-main">{children}</main>
      <footer className="cu-pub-foot">This page is private to your company. Do not forward the link. Questions: call your Seamless FM contact.</footer>
    </div>
  );
}

export function VendorPortalPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['vendor-portal-public', token], queryFn: () => getVendorPortal(token), retry: false, refetchInterval: (x) => (x.state.data?.purpose === 'portal' ? 120_000 : false) });
  if (q.isLoading) return <Frame title="Vendor portal"><p className="cu-pub-state">Loading…</p></Frame>;
  if (q.isError || !q.data) {
    return (
      <Frame title="Vendor portal">
        <div className="cu-pub-state">
          <h1>This link is not valid any more</h1>
          <p>{errText(q.error, 'Ask your Seamless FM contact for a new one.')}</p>
        </div>
      </Frame>
    );
  }
  return q.data.purpose === 'onboarding' ? <Onboarding token={token} view={q.data} /> : <Jobs token={token} view={q.data} />;
}

// ═══ The jobs of a vendor ════════════════════════════════════════════════════

const place = (j: PortalJob) => [j.client, j.store ? `#${j.store.replace(/^#/, '')}` : null].filter(Boolean).join(' ');
const where = (j: PortalJob) => [j.address, [j.city, j.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');

function Jobs({ token, view }: { token: string; view: PortalView }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const done = (res: PortalView) => { qc.setQueryData(['vendor-portal-public', token], res); setError(null); };
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const answer = useMutation({ mutationFn: (x: { id: string; answer: 'accept' | 'decline'; note?: string }) => answerPortalOffer(token, x.id, x.answer, x.note), onSuccess: done, onError: fail('Could not record your answer.') });
  const offers = view.offers ?? [];
  const jobs = view.jobs ?? [];
  const open = jobs.filter((j) => j.open);
  const closed = jobs.filter((j) => !j.open);
  const expired = (view.compliance ?? []).filter((c) => c.expired);

  return (
    <Frame title="Vendor portal">
      <div className="cu-pub-head">
        <div>
          <h1 className="cu-pub-title">{view.vendor.name}</h1>
          <p className="cu-meta">{[view.vendor.primary_trade, [view.vendor.city, view.vendor.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      {error && <p className="vp-err" role="alert"><Icon name="alert-circle" size={14} /> {error}</p>}
      {expired.length > 0 && (
        <p className="vp-note is-warn"><Icon name="alert" size={14} /> On our file, your {expired.map((c) => c.label).join(' and ')} {expired.length === 1 ? 'has' : 'have'} expired. Please send the renewed certificate to your contact.</p>
      )}

      {offers.length > 0 && (
        <section className="vp-block">
          <h2>Jobs offered to you</h2>
          {offers.map((o) => (
            <article key={o.id} className="vp-job is-offer">
              <JobFacts job={o.job} />
              <p className="vp-deadline">{o.expires_at ? `Please answer by ${when(o.expires_at)}. After that it is offered to another company.` : 'Please answer as soon as you can.'}</p>
              <div className="vp-actions">
                <button type="button" className="btn btn-primary" disabled={answer.isPending} onClick={() => answer.mutate({ id: o.id, answer: 'accept' })}>Accept this job</button>
                <button type="button" className="btn" disabled={answer.isPending} onClick={() => { const note = window.prompt('Why not? (optional)') ?? undefined; answer.mutate({ id: o.id, answer: 'decline', note: note?.trim() || undefined }); }}>Decline</button>
              </div>
            </article>
          ))}
        </section>
      )}

      <section className="vp-block">
        <h2>Your open jobs <span>{open.length}</span></h2>
        {open.length === 0 ? <p className="vp-empty">You have no open jobs with us right now.</p> : open.map((j) => <Job key={j.ref} token={token} job={j} onDone={done} />)}
      </section>

      {closed.length > 0 && (
        <section className="vp-block">
          <h2>Finished in the last 30 days <span>{closed.length}</span></h2>
          {closed.map((j) => <article key={j.ref} className="vp-job is-closed"><JobFacts job={j} /></article>)}
        </section>
      )}
    </Frame>
  );
}

function JobFacts({ job }: { job: PortalJob }) {
  return (
    <>
      <header>
        <span className="mono">{job.wo_number}</span>
        <b>{place(job) || 'Job'}</b>
        {job.emergency && <span className="chip chip-sm chip-danger">Emergency</span>}
        <span className="chip chip-sm">{job.status}</span>
      </header>
      {where(job) && <p className="vp-where"><Icon name="pin" size={12} /> {where(job)}</p>}
      {job.trade && <p className="vp-trade">{job.trade}</p>}
      {job.description && <p className="vp-desc">{job.description}</p>}
    </>
  );
}

function Job({ token, job, onDone }: { token: string; job: PortalJob; onDone: (v: PortalView) => void }) {
  const [eta, setEta] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const saveEta = useMutation({ mutationFn: () => setPortalEta(token, job.ref, new Date(eta).toISOString()), onSuccess: (res) => { onDone(res); setEta(''); setError(null); }, onError: fail('Could not save the ETA.') });
  const saveNote = useMutation({ mutationFn: () => addPortalNote(token, job.ref, note.trim()), onSuccess: (res) => { onDone(res); setNote(''); setError(null); }, onError: fail('Could not send the note.') });
  return (
    <article className="vp-job">
      <JobFacts job={job} />
      <dl className="vp-facts">
        <div><dt>Your part</dt><dd>{job.role === 'responsible' ? 'Responsible vendor' : 'Technician on the job'}</dd></div>
        <div><dt>Scheduled</dt><dd>{job.scheduled_at ? when(job.scheduled_at) : 'Not scheduled'}</dd></div>
        <div><dt>Your ETA</dt><dd>{job.eta_at ? when(job.eta_at) : 'Not given'}</dd></div>
      </dl>
      {error && <p className="vp-err" role="alert"><Icon name="alert-circle" size={14} /> {error}</p>}
      <form className="vp-row" onSubmit={(e) => { e.preventDefault(); if (eta) saveEta.mutate(); }}>
        <label>When will you be there?<input className="fld" type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} /></label>
        <button type="submit" className="btn" disabled={!eta || saveEta.isPending}>{job.eta_at ? 'Change ETA' : 'Give ETA'}</button>
      </form>
      {job.notes.length > 0 && (
        <ul className="vp-notes">{job.notes.map((n, i) => <li key={i}><small>{when(n.created_at)}</small>{n.body}</li>)}</ul>
      )}
      <form className="vp-row" onSubmit={(e) => { e.preventDefault(); if (note.trim()) saveNote.mutate(); }}>
        <label>Note for the dispatcher<textarea className="fld" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Part ordered, back on Thursday" /></label>
        <button type="submit" className="btn" disabled={!note.trim() || saveNote.isPending}>Send note</button>
      </form>
    </article>
  );
}

// ═══ The onboarding form ═════════════════════════════════════════════════════

const STATES = 'AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' ');
type YesNo = '' | 'yes' | 'no';
const yn = (v: boolean | null | undefined): YesNo => (v === true ? 'yes' : v === false ? 'no' : '');
const bool = (v: YesNo): boolean | null => (v === 'yes' ? true : v === 'no' ? false : null);
const numStr = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));
const numOrNull = (s: string): number | null => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));

function Onboarding({ token, view }: { token: string; view: PortalView }) {
  const qc = useQueryClient();
  const o = view.onboarding!;
  const c = o.current;
  const [d, setD] = useState({
    legal_name: c.legal_name ?? view.vendor.name, dba_name: c.dba_name ?? '', email: c.email ?? '', phones: (c.phones ?? []).join(', '),
    city: c.city ?? '', state: c.state ?? '', zip: c.zip ?? '', primary_trade: c.primary_trade ?? '', secondary_trades: (c.secondary_trades ?? []).join(', '),
    coverage_states: c.coverage_states ?? [], max_travel_radius: c.max_travel_radius ?? '',
    emergency_same_day: yn(c.emergency_same_day), after_hours: yn(c.after_hours), weekends: yn(c.weekends),
    regular_hourly_rate: numStr(c.regular_hourly_rate), after_hours_rate: numStr(c.after_hours_rate), trip_charge: numStr(c.trip_charge),
    primary_contact_name: c.primary_contact_name ?? '', primary_contact_role: c.primary_contact_role ?? '', dispatch_phone: c.dispatch_phone ?? '', billing_email: c.billing_email ?? '',
    has_general_liability: '' as YesNo, has_workers_comp: '' as YesNo, notes: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const set = <K extends keyof typeof d>(k: K, v: (typeof d)[K]) => setD((cur) => ({ ...cur, [k]: v }));
  const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const send = useMutation({
    mutationFn: () => {
      const payload: OnboardingPayload = {
        legal_name: d.legal_name.trim() || null, dba_name: d.dba_name.trim() || null, email: d.email.trim() || null, phones: list(d.phones),
        city: d.city.trim() || null, state: d.state || null, zip: d.zip.trim() || null, primary_trade: d.primary_trade.trim() || null, secondary_trades: list(d.secondary_trades),
        coverage_states: d.coverage_states, max_travel_radius: d.max_travel_radius.trim() || null,
        emergency_same_day: bool(d.emergency_same_day), after_hours: bool(d.after_hours), weekends: bool(d.weekends),
        regular_hourly_rate: numOrNull(d.regular_hourly_rate), after_hours_rate: numOrNull(d.after_hours_rate), trip_charge: numOrNull(d.trip_charge),
        primary_contact_name: d.primary_contact_name.trim() || null, primary_contact_role: d.primary_contact_role.trim() || null, dispatch_phone: d.dispatch_phone.trim() || null, billing_email: d.billing_email.trim() || null,
        has_general_liability: bool(d.has_general_liability), has_workers_comp: bool(d.has_workers_comp), notes: d.notes.trim() || null,
      };
      return submitVendorOnboarding(token, payload);
    },
    onSuccess: (res) => { qc.setQueryData(['vendor-portal-public', token], res); setError(null); setSent(true); window.scrollTo({ top: 0 }); },
    onError: (e) => setError(errText(e, 'Could not send the form.')),
  });
  const f = (label: string, node: ReactNode, wide = false) => <label className={`vp-field${wide ? ' is-wide' : ''}`}><span>{label}</span>{node}</label>;
  const text = (k: 'legal_name' | 'dba_name' | 'email' | 'phones' | 'city' | 'zip' | 'secondary_trades' | 'max_travel_radius' | 'primary_contact_name' | 'primary_contact_role' | 'dispatch_phone' | 'billing_email', ph?: string, type = 'text') =>
    <input className="fld" type={type} value={d[k]} placeholder={ph} onChange={(e) => set(k, e.target.value)} />;
  const money = (k: 'regular_hourly_rate' | 'after_hours_rate' | 'trip_charge') => <input className="fld" type="number" min="0" step="0.01" value={d[k]} onChange={(e) => set(k, e.target.value)} />;
  const yesNo = (k: 'emergency_same_day' | 'after_hours' | 'weekends' | 'has_general_liability' | 'has_workers_comp') => (
    <select className="fld" value={d[k]} onChange={(e) => set(k, e.target.value as YesNo)}><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>
  );

  return (
    <Frame title="Vendor onboarding">
      <div className="cu-pub-head">
        <div>
          <h1 className="cu-pub-title">Tell us about {view.vendor.name}</h1>
          <p className="cu-meta">What you fill in here goes to our vendor team, who check it before it is put on your record.</p>
        </div>
      </div>
      {(sent || o.status === 'submitted') && <p className="vp-note"><Icon name="check-circle" size={14} /> We have your form{o.submitted_at ? `, sent ${when(o.submitted_at)}` : ''}. You can correct it and send it again.</p>}
      {o.status === 'accepted' && !sent && <p className="vp-note"><Icon name="check-circle" size={14} /> Your details are on file. Send the form again if something changed.</p>}
      {o.status === 'rejected' && !sent && <p className="vp-note is-warn"><Icon name="alert" size={14} /> We sent your form back{o.decision_note ? `: ${o.decision_note}` : '.'} Please correct it and send it again.</p>}
      {error && <p className="vp-err" role="alert"><Icon name="alert-circle" size={14} /> {error}</p>}

      <form className="vp-form" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <fieldset><legend>Your business</legend>
          {f('Legal business name', text('legal_name'))}
          {f('Doing business as', text('dba_name'))}
          {f('Company email', text('email', undefined, 'email'))}
          {f('Phone numbers', text('phones', 'Separate several with a comma'))}
          {f('City', text('city'))}
          {f('State', <select className="fld" value={d.state} onChange={(e) => set('state', e.target.value)}><option value="">—</option>{STATES.map((s) => <option key={s} value={s}>{s}</option>)}</select>)}
          {f('ZIP', text('zip'))}
        </fieldset>
        <fieldset><legend>What you do</legend>
          {f('Primary trade', (
            <>
              <input className="fld" list="vp-trades" value={d.primary_trade} onChange={(e) => set('primary_trade', e.target.value)} />
              <datalist id="vp-trades">{o.trades.map((t) => <option key={t} value={t} />)}</datalist>
            </>
          ))}
          {f('Other trades', text('secondary_trades', 'Separate several with a comma'))}
          {f('How far you travel', text('max_travel_radius', 'e.g. 50 miles'))}
          {f('Same-day emergencies', yesNo('emergency_same_day'))}
          {f('After hours', yesNo('after_hours'))}
          {f('Weekends', yesNo('weekends'))}
          <div className="vp-field is-wide">
            <span>States you cover</span>
            <div className="vp-states">
              {STATES.map((s) => (
                <label key={s}><input type="checkbox" checked={d.coverage_states.includes(s)} onChange={(e) => set('coverage_states', e.target.checked ? [...d.coverage_states, s] : d.coverage_states.filter((x) => x !== s))} />{s}</label>
              ))}
            </div>
          </div>
        </fieldset>
        <fieldset><legend>Rates</legend>
          {f('Regular hourly rate ($)', money('regular_hourly_rate'))}
          {f('After-hours rate ($)', money('after_hours_rate'))}
          {f('Trip charge ($)', money('trip_charge'))}
        </fieldset>
        <fieldset><legend>Who we talk to</legend>
          {f('Contact name', text('primary_contact_name'))}
          {f('Contact role', text('primary_contact_role'))}
          {f('Dispatch phone', text('dispatch_phone'))}
          {f('Billing email', text('billing_email', undefined, 'email'))}
        </fieldset>
        <fieldset><legend>Insurance</legend>
          {f('General liability insurance', yesNo('has_general_liability'))}
          {f('Workers’ compensation insurance', yesNo('has_workers_comp'))}
          {f('Anything else we should know', <textarea className="fld" rows={3} value={d.notes} onChange={(e) => set('notes', e.target.value)} />, true)}
        </fieldset>
        <p className="vp-fine">Please send your W-9 and certificate of insurance to your contact; documents cannot be uploaded here yet.</p>
        <div className="vp-actions"><button type="submit" className="btn btn-primary" disabled={send.isPending}>{send.isPending ? 'Sending…' : 'Send to Seamless FM'}</button></div>
      </form>
    </Frame>
  );
}

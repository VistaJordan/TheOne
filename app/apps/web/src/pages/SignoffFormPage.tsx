/* The sign-off form (0156, Elise 2026-11-17) — what the technician's "Form
 * link" opens: /signoff/:token.
 *
 * No sign-in and no app chrome: the token in the address is the whole
 * credential (it names one sheet), and the API sends only that sheet's work
 * order number and address. The page wears the billing entity's design — the
 * same two the signed PDF is drawn in (lib/signoffPdf.ts on the API): Seamless
 * "the seam" and BKR's field service ticket. The manager on site types their
 * name (and, on an EMCOR sheet, the closeout number), signs in the box and
 * presses Submit; the API draws the signed PDF and files it on the work order
 * (Drive) and in its SharePoint folder. A sheet takes one signature.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SIGNOFF_CLOSEOUT_MAX, SIGNOFF_NAME_MAX, SIGNOFF_RATING_MAX, signoffFormProblem, type SignoffFormView } from '@theone/shared';
import { ApiRequestError, getSignoffForm, submitSignoffForm } from '../api/client';
import { SignaturePad, type SignaturePadHandle } from '../components/SignaturePad';
import '../styles/signoff-form.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);
const SIGNED_AT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

type Brand = 'sfm' | 'bkr';
const brandOf = (v: SignoffFormView | undefined): Brand => (v && v.layout !== 'sfm' ? 'bkr' : 'sfm');

function Frame({ brand, view, children }: { brand: Brand; view?: SignoffFormView; children: ReactNode }) {
  return (
    <div className={`sof sof-${brand}`}>
      {brand === 'sfm' ? (
        <header className="sof-head">
          <img className="sof-logo" src="/brand/sheets/sfm-header.png" alt="Seamless Facility Management" />
          <div className="sof-head-side">
            <span className="sof-kicker">Job completion record</span>
            {view && <span className="sof-head-ref">{view.wo_ref}</span>}
          </div>
        </header>
      ) : (
        <header className="sof-head">
          <img className="sof-logo" src="/brand/sheets/bkr-logo.png" alt="BKR National Facility Services" />
          <div className="sof-head-side">
            <span className="sof-kicker">Field service ticket</span>
            <span className="sof-head-title">Sign-off sheet</span>
          </div>
        </header>
      )}
      <div className="sof-rule" aria-hidden="true"><span /><span /></div>
      <main className="sof-main">{children}</main>
      {brand === 'sfm' ? (
        <footer className="sof-foot">
          <b>Seamless Facility Management</b>
          <span className="sof-foot-side">
            <span>+1 (469) 501-1510 · info@seamlessfm.com</span>
            <span>1910 Pacific Ave, Suite 2000 #3299, Dallas, TX 75201</span>
          </span>
        </footer>
      ) : (
        <footer className="sof-foot">
          <b>BKR National Facility Services</b>
          <span>www.bkrnational.com</span>
        </footer>
      )}
    </div>
  );
}

export function SignoffFormPage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['signoff-form', token], queryFn: () => getSignoffForm(token), retry: false });
  const view = q.data;

  useEffect(() => {
    document.title = view ? `Sign-off · ${view.wo_ref}` : 'Sign-off sheet';
  }, [view]);

  if (q.isLoading) return <Frame brand="sfm"><p className="sof-state">Loading…</p></Frame>;
  if (q.isError || !view) {
    const gone = q.error instanceof ApiRequestError && q.error.status === 404;
    return (
      <Frame brand="sfm">
        <div className="sof-state">
          <h1>{gone ? 'This link is not valid any more' : 'The sheet could not be opened'}</h1>
          <p>{gone ? 'A newer sign-off sheet may have been sent for this job. Ask the technician for the latest link.' : errText(q.error, 'Check the connection and try again.')}</p>
        </div>
      </Frame>
    );
  }
  return (
    <Frame brand={brandOf(view)} view={view}>
      {view.signed ? <Signed view={view} /> : <SignForm token={token} view={view} />}
    </Frame>
  );
}

const RATING_WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

/** The manager's 1–5 star rating of the work (Elise, 2026-11-19). */
function StarRating({ value, onChange, missing }: { value: number; onChange: (n: number) => void; missing: boolean }) {
  return (
    <div className={`sof-field${missing ? ' is-missing' : ''}`}>
      <span className="sof-lbl" id="sof-rating-lbl">How was the work?</span>
      <div className="sof-stars" role="radiogroup" aria-labelledby="sof-rating-lbl">
        {Array.from({ length: SIGNOFF_RATING_MAX }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n === 1 ? '' : 's'} — ${RATING_WORDS[n]}`}
            className={`sof-star${n <= value ? ' is-on' : ''}`}
            onClick={() => onChange(n)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.4l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" /></svg>
          </button>
        ))}
        <span className="sof-star-word">{value ? RATING_WORDS[value] : 'Tap a star'}</span>
      </div>
    </div>
  );
}

/** Steps 1 and 2: the job (the PDF's first two numbered steps). */
function FactItems({ view, brand }: { view: SignoffFormView; brand: Brand }) {
  const n = (i: number) => (brand === 'sfm' ? String(i) : String(i).padStart(2, '0'));
  return (
    <>
      <li>
        <span className="sof-n">{n(1)}</span>
        <div>
          <span className="sof-lbl">{brand === 'sfm' ? 'Job work order number' : 'Work order #'}</span>
          <span className="sof-ref">{view.wo_ref}</span>
        </div>
      </li>
      <li>
        <span className="sof-n">{n(2)}</span>
        <div>
          <span className="sof-lbl">{brand === 'sfm' ? 'Location' : 'Service address'}</span>
          <span className="sof-addr">{view.address ?? '—'}</span>
        </div>
      </li>
    </>
  );
}

function SignForm({ token, view }: { token: string; view: SignoffFormView }) {
  const qc = useQueryClient();
  const brand = brandOf(view);
  const pad = useRef<SignaturePadHandle>(null);
  const [name, setName] = useState('');
  const [closeout, setCloseout] = useState('');
  const [rating, setRating] = useState(0);
  const [empty, setEmpty] = useState(true);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = signoffFormProblem({ manager_name: name, closeout_number: closeout, rating, has_signature: !empty }, view.closeout_required);

  const submit = useMutation({
    mutationFn: () => submitSignoffForm(token, {
      manager_name: name.trim(),
      closeout_number: view.closeout_required ? closeout.trim() : null,
      rating,
      signature_png: pad.current?.toPngBase64() ?? '',
    }),
    onSuccess: (next) => { qc.setQueryData(['signoff-form', token], next); window.scrollTo({ top: 0 }); },
    onError: (e) => setError(errText(e, 'The sheet could not be sent. Try again.')),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    setError(null);
    if (problem) return;
    submit.mutate();
  };

  const nameMissing = tried && name.trim().length < 2;
  const closeoutMissing = tried && view.closeout_required && !closeout.trim();
  const sigMissing = tried && empty;
  const ratingMissing = tried && !rating;

  const sfm = brand === 'sfm';
  const stars = <StarRating value={rating} onChange={setRating} missing={ratingMissing} />;
  const nameAndDate = (
    <div className="sof-row">
      <label className={`sof-field${nameMissing ? ' is-missing' : ''}`}>
        <span className="sof-lbl">{sfm ? 'Name of manager on site' : 'Store manager name'}</span>
        <input className="sof-input" value={name} maxLength={SIGNOFF_NAME_MAX} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </label>
      <div className="sof-field sof-field-date">
        <span className="sof-lbl">Date</span>
        <span className="sof-date">{view.date_label}</span>
      </div>
    </div>
  );
  const signature = (
    <div className={`sof-field${sigMissing ? ' is-missing' : ''}`}>
      <span className="sof-lbl-row">
        <span className="sof-lbl">{sfm ? 'Signature of manager on site' : 'Store manager signature'}</span>
        <button type="button" className="sof-clear" onClick={() => pad.current?.clear()} disabled={empty}>Clear</button>
      </span>
      <div className="sof-sig">
        <SignaturePad ref={pad} className="sof-sig-canvas" label="Signature box: sign here" onChange={setEmpty} />
        {empty && <span className="sof-sig-hint" aria-hidden="true">Sign here</span>}
        <span className="sof-sig-line" aria-hidden="true" />
      </div>
      <p className="sof-attest">
        By signing, I confirm the work on this work order was completed {sfm ? 'on site' : 'at my store'}.
      </p>
    </div>
  );

  return (
    <form className="sof-form" onSubmit={onSubmit} noValidate>
      {sfm ? (
        <>
          <div className="sof-title">
            <h1>Sign-off sheet</h1>
            <p>To be signed by the manager on site once the work is complete.</p>
          </div>
          {/* The five numbered steps on the seam, as the PDF draws them. */}
          <ol className="sof-facts sof-steps">
            <FactItems view={view} brand={brand} />
            <li>
              <span className="sof-n">3</span>
              {stars}
            </li>
            <li>
              <span className="sof-n">4</span>
              {nameAndDate}
            </li>
            <li>
              <span className="sof-n is-last">5</span>
              {signature}
            </li>
          </ol>
        </>
      ) : (
        <>
          <ol className="sof-facts"><FactItems view={view} brand={brand} /></ol>
          {view.closeout_required && (
            <label className={`sof-field sof-field-closeout${closeoutMissing ? ' is-missing' : ''}`}>
              <span className="sof-n">03</span>
              <div>
                <span className="sof-lbl">Closeout number</span>
                <input className="sof-input" value={closeout} maxLength={SIGNOFF_CLOSEOUT_MAX} onChange={(e) => setCloseout(e.target.value)} autoComplete="off" />
              </div>
            </label>
          )}
          <section className="sof-stub">
            <h2>Store manager sign-off</h2>
            {stars}
            {nameAndDate}
            {signature}
          </section>
        </>
      )}

      {tried && problem && <p className="sof-error" role="alert">{problem}</p>}
      {error && <p className="sof-error" role="alert">{error}</p>}

      <button type="submit" className="sof-submit" disabled={submit.isPending}>
        {submit.isPending ? 'Sending…' : 'Submit'}
      </button>
      <p className="sof-paper">
        Prefer paper? <a href={view.pdf_url} target="_blank" rel="noreferrer">Download the blank sheet (PDF)</a>
      </p>
    </form>
  );
}

function Signed({ view }: { view: SignoffFormView }) {
  return (
    <div className="sof-done" role="status">
      <span className="sof-done-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="28" height="28"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <h1>Signed — thank you</h1>
      <p>
        The sign-off sheet for work order <b>{view.wo_ref}</b> was signed by <b>{view.signed!.name}</b> on {SIGNED_AT.format(new Date(view.signed!.at))} and sent to {view.entity_name}.
      </p>
      <p className="sof-done-sub">You can close this page.</p>
    </div>
  );
}

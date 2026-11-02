// 0070 · The sign-off sheet, as the Sign-Off Link row of the CICO card.
//
// What the Make + Paperform automation used to do, in the work order itself:
//   · the blank sheet in the billing entity's branding appears as soon as the
//     work order is assigned to a dispatcher (the Assignee field); the
//     Generate button covers the case where Comp was set afterwards, and
//     "New sheet" redraws it once the number or the address changed;
//   · the row shows the PDF itself — a document tile that opens it and a
//     download button — with Send to tech beside it: one
//     technician on file goes straight out, several open a picker, and
//     "another number" is always there;
//   · the signed copy the technician texts back is filed as a sign-off
//     attachment (Photos card, awaiting approval) and linked from the same
//     field — the "Signed copy received" state here; a copy that could belong
//     to several work orders waits in a strip until someone claims or
//     dismisses it.
//
// 0116 (Elise, 2026-11-02): the entity's Paperform, prefilled with the work
// order number and the address — the link the team texted before The One —
// sits under the sheet with Copy link, and needs no drawn sheet. Send to tech
// asks which to send: the form link or the PDF.
//
// Without the Quo API configured on the server, Send opens the Quo app on
// this PC with the text pre-filled (an `sms:` link) and still records the
// share, so the reply can be matched. Who may see / do what is the field's
// own permission (work_orders/fields/cico/fields.24. Sign-Off Link); the API
// answers 403 and the row falls back to the plain link.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizePhone, type SignoffReply, type SignoffShareKind, type SignoffTechnician, type WoSignoffResponse } from '@theone/shared';
import {
  attachmentUrl,
  claimSignoffReply,
  dismissSignoffReply,
  generateWorkOrderSignoff,
  getWorkOrderSignoff,
  shareWorkOrderSignoff,
  signoffFileUrl,
  type WorkOrderDetailV2,
} from '../../api/client';
import { feedTime } from '../../lib/fields';
import { CopyButton } from '../CopyButton';
import { Icon } from '../Icon';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

export function SignoffPanel({ wo, fallback }: { wo: WorkOrderDetailV2; fallback?: ReactNode }) {
  const qc = useQueryClient();
  const key = ['wo-signoff', wo.id];
  const q = useQuery({ queryKey: key, queryFn: () => getWorkOrderSignoff(wo.id), retry: 0 });
  const data = q.data;
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  const settle = (next: WoSignoffResponse) => {
    qc.setQueryData(key, next);
    setError(null);
  };
  // The field and the Photos card change with a drawn or filed sheet.
  const refreshWo = () => {
    void qc.invalidateQueries({ queryKey: ['work-orders'] });
    void qc.invalidateQueries({ queryKey: ['wo-activity'] });
    void qc.invalidateQueries({ queryKey: ['wo-attachments', wo.id] });
    void qc.invalidateQueries({ queryKey: ['wo-signoff', wo.id] });
  };

  const generate = useMutation({
    mutationFn: () => generateWorkOrderSignoff(wo.id),
    onSuccess: (next) => { settle(next); refreshWo(); },
    onError: (e) => setError(errorText(e)),
  });
  const claim = useMutation({
    mutationFn: (replyId: string) => claimSignoffReply(wo.id, replyId),
    onSuccess: (next) => { settle(next); refreshWo(); },
    onError: (e) => setError(errorText(e)),
  });
  const dismiss = useMutation({
    mutationFn: (replyId: string) => dismissSignoffReply(wo.id, replyId),
    onSuccess: settle,
    onError: (e) => setError(errorText(e)),
  });

  if (q.isLoading) return <span className="so-loading">…</span>;
  // 403 / network: the plain link the caller would have drawn anyway.
  if (q.isError || !data) return <>{fallback ?? null}</>;

  const s = data.signoff;
  // M26 (UAT Wave D): the button shows to anyone with CICO edit; when it
  // cannot work yet it says why instead of disappearing.
  const canGenerate = data.can.generate;
  const generateBlocked = !data.storage_ready
    ? 'File storage is not connected on this deployment yet'
    : !data.layout
      ? 'Set the Comp (billing entity) first — the sheet is drawn in its branding'
      : null;
  const busy = generate.isPending || claim.isPending || dismiss.isPending;
  const fileName = s ? `Signoff-${s.wo_ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf` : null;
  const fileUrl = signoffFileUrl(wo.wo_number);
  // PDF shares of the current sheet and every form-link share, newest first.
  const shares = [...(s?.shares ?? []), ...data.link_shares].sort((a, b) => b.sent_at.localeCompare(a.sent_at));

  // Send to tech, (re)draw and the signed copy: beside the sheet, under its chips.
  const actions = (
    <div className="so-actions">
      {(s || data.form_link) && data.can.share && (
        <button type="button" className="btn btn-sm" onClick={() => { setSent(null); setSharing(true); }} disabled={busy}>
          <Icon name="send" size={14} />
          Send to tech
        </button>
      )}
      {!s && canGenerate && (
        <button type="button" className="btn btn-sm" onClick={() => generate.mutate()} disabled={busy || generateBlocked !== null} title={generateBlocked ?? undefined}>
          <Icon name="file" size={14} />
          {generate.isPending ? 'Drawing…' : 'Generate sheet'}
        </button>
      )}
      {s && canGenerate && (
        <button
          type="button"
          className="btn btn-sm is-ghost"
          onClick={() => generate.mutate()}
          disabled={busy || !data.storage_ready}
          title={!data.storage_ready ? 'File storage is not connected on this deployment yet' : s.stale ? 'Redraw the sheet with the current number and address' : 'Redraw the sheet (the old link stops working)'}
        >
          <Icon name="refresh" size={14} />
          {generate.isPending ? 'Drawing…' : s.stale ? 'Redraw with current details' : 'New sheet'}
        </button>
      )}
      {s?.signed_attachment_id && (
        <a className="btn btn-sm is-ghost" href={attachmentUrl(wo.id, s.signed_attachment_id)} target="_blank" rel="noreferrer">
          <Icon name="check-circle" size={14} />
          Open signed copy
        </a>
      )}
    </div>
  );

  return (
    <div className="so-row">
      {data.form_link && (
        <div className="so-link">
          <span className="so-link-lbl">Form link</span>
          <a className="so-link-url" href={data.form_link} target="_blank" rel="noreferrer" title={data.form_link}>{data.form_link}</a>
          <CopyButton value={data.form_link} label="Copy link" />
        </div>
      )}

      <div className="so-tile">
        {s ? (
          <>
            <a className="so-doc" href={fileUrl} target="_blank" rel="noreferrer" title="Open the sheet (PDF)">
              <span className="so-doc-ic" aria-hidden="true">
                <Icon name="file" size={18} />
                <span className="so-doc-ext">PDF</span>
              </span>
              <span className="so-doc-main">
                <b>{fileName}</b>
                <span className="so-doc-sub">
                  {s.entity_name}
                  <span className="sep-dot">·</span>
                  drawn {feedTime(s.created_at)}{s.created_by ? ` by ${s.created_by.name}` : ''}
                </span>
              </span>
            </a>
          </>
        ) : (
          <div className="so-empty">
            {data.layout
              ? 'No sheet drawn yet.'
              : 'Set Comp on the work order to pick the sheet\'s branding.'}
          </div>
        )}
        {/* Beside the sheet: download and the chips on top, the buttons under them. */}
        <div className="so-side">
          {s && (
            <div className="so-side-top">
              <a className="icon-btn so-dl" href={fileUrl} download={fileName ?? undefined} aria-label="Download the sheet" title="Download">
                <Icon name="download" size={14} />
              </a>
              {s.signed_at && <span className="chip chip-ok chip-sm">Signed copy received</span>}
              {!s.signed_at && s.shares.length > 0 && <span className="chip chip-warn chip-sm">Waiting for the signed copy</span>}
              {s.stale && <span className="chip chip-outline chip-sm" title="The work order's number or address changed after this sheet was drawn">Details changed</span>}
            </div>
          )}
          {actions}
        </div>
      </div>

      {!data.storage_ready && (
        <div className="so-error">File storage is not connected on the server (BLOB_READ_WRITE_TOKEN), so no sheet can be drawn or filed. Ask an admin.</div>
      )}
      {sent && <div className="so-note">{sent}</div>}
      {error && <div className="so-error">{error}</div>}

      {data.replies.length > 0 && (
        <div className="so-held" role="status">
          <span>
            <b>A signed sheet came back</b> from a number that holds more than one open sheet. Is it this work order's?
          </span>
          {data.replies.map((r) => (
            <HeldReply key={r.id} reply={r} busy={busy} canDecide={data.can.share}
              onClaim={() => claim.mutate(r.id)} onDismiss={() => dismiss.mutate(r.id)} />
          ))}
        </div>
      )}

      {(s?.signed_at || shares.length > 0) && (
        <ul className="so-shares">
          {s?.signed_at && (
            <li><span>Signed copy received {feedTime(s.signed_at)}</span><span>awaiting approval in Photos &amp; files</span></li>
          )}
          {shares.map((sh) => (
            <li key={sh.id}>
              <span>{sh.kind === 'link' ? 'Form link' : 'PDF'} sent to <b>{sh.tech_name ?? 'Technician'}</b> <span className="mono">{sh.phone}</span></span>
              <span>{feedTime(sh.sent_at)}{sh.sent_by ? ` by ${sh.sent_by.name}` : ''}</span>
              <span>{sh.channel === 'quo_api' ? 'texted from the Quo line' : 'through the Quo app'}</span>
            </li>
          ))}
        </ul>
      )}

      {sharing && data && (
        <ShareSheet
          wo={wo}
          data={data}
          onClose={() => setSharing(false)}
          onSent={(next, note) => { settle(next); setSent(note); setSharing(false); }}
        />
      )}
    </div>
  );
}

function HeldReply({ reply, busy, canDecide, onClaim, onDismiss }: {
  reply: SignoffReply; busy: boolean; canDecide: boolean; onClaim: () => void; onDismiss: () => void;
}) {
  return (
    <div className="so-held-row">
      <span className="so-held-file">{reply.file_name}</span>
      <span>from {reply.tech_name ?? 'a technician'} <span className="mono">{reply.phone}</span> · {feedTime(reply.received_at)}</span>
      {reply.body && <span>“{reply.body}”</span>}
      {canDecide && (
        <span className="so-held-btns">
          <button type="button" className="btn btn-sm" onClick={onClaim} disabled={busy}>Yes, file it here</button>
          <button type="button" className="btn btn-sm is-ghost" onClick={onDismiss} disabled={busy}>Not this one</button>
        </span>
      )}
    </div>
  );
}

// ── The picker ───────────────────────────────────────────────────────────────

function ShareSheet({ wo, data, onClose, onSent }: {
  wo: WorkOrderDetailV2;
  data: WoSignoffResponse;
  onClose: () => void;
  onSent: (next: WoSignoffResponse, note: string) => void;
}) {
  const techs = data.technicians;
  // A PDF share draws the sheet when none exists, which needs storage.
  const pdfPossible = Boolean(data.signoff) || data.storage_ready;
  const [kind, setKind] = useState<SignoffShareKind>(data.form_link ? 'link' : 'pdf');
  const [pick, setPick] = useState<string>(techs[0]?.key ?? 'other');
  const [otherName, setOtherName] = useState('');
  const [otherPhone, setOtherPhone] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const chosen: SignoffTechnician | null = useMemo(
    () => (pick === 'other' ? null : (techs.find((t) => t.key === pick) ?? null)),
    [pick, techs],
  );
  const phone = chosen ? chosen.phone : normalizePhone(otherPhone);
  const name = chosen ? chosen.name : otherName.trim() || null;

  const share = useMutation({
    mutationFn: () => shareWorkOrderSignoff(wo.id, { phone: phone!, kind, tech_name: name, vendor_id: chosen?.vendor_id ?? null }),
    onSuccess: (res) => {
      const what = kind === 'link' ? 'the form link' : 'the sheet';
      if (res.channel === 'quo_app' && res.sms) {
        // No API key on the server: the Quo app on this PC takes the text.
        window.location.href = res.sms;
        onSent(res, `Quo should be opening a text to ${name ?? phone} with ${what}. Press send there.`);
      } else {
        onSent(res, `Texted ${what} to ${name ?? phone} from the Quo line.`);
      }
    },
    onError: (e) => setError(errorText(e)),
  });

  const body = (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="soT">
      <div className="sheet so-sheet">
        <h2 className="sheet-t" id="soT">
          <Icon name="send" size={18} />
          Send the sign-off sheet
        </h2>
        <div className="call-field">
          <span className="overline">What to send</span>
          <div className="seg" role="radiogroup" aria-label="What to send">
            <button type="button" role="radio" aria-checked={kind === 'link'} className={`seg-btn${kind === 'link' ? ' is-on' : ''}`}
              disabled={!data.form_link} title={data.form_link ? undefined : 'This entity has no sign-off form link'} onClick={() => setKind('link')}>
              Form link
            </button>
            <button type="button" role="radio" aria-checked={kind === 'pdf'} className={`seg-btn${kind === 'pdf' ? ' is-on' : ''}`}
              disabled={!pdfPossible} title={pdfPossible ? undefined : 'File storage is not connected, so no PDF can be drawn'} onClick={() => setKind('pdf')}>
              PDF
            </button>
          </div>
        </div>

        <p className="sheet-b">
          {kind === 'link' ? (
            <>The technician gets a text with the sign-off form, already filled in with <b>{data.signoff?.wo_ref ?? wo.wo_number}</b> and
            the address; the manager on site signs it on the form.</>
          ) : (
            <>The technician gets a text with a link to the blank sheet for <b>{data.signoff?.wo_ref ?? wo.wo_number}</b>, and is
            asked to reply with a photo or scan once the manager on site has signed it.</>
          )}
          {!data.quo_api_ready && ' Quo is not connected on the server yet, so the text opens in the Quo app on this PC for you to send.'}
        </p>

        <div className="call-field">
          <span className="overline">Who</span>
          <div className="call-contacts" role="radiogroup" aria-label="Which technician">
            {techs.map((t) => (
              <label key={t.key} className={`call-contact${pick === t.key ? ' is-on' : ''}`}>
                <input type="radio" name="so-who" checked={pick === t.key} onChange={() => setPick(t.key)} />
                <span className="call-contact-main">
                  <b>{t.name}</b>
                  <span className="mono">{t.phone}</span>
                </span>
                <span className="call-contact-src">{t.source}</span>
              </label>
            ))}
            <label className={`call-contact${pick === 'other' ? ' is-on' : ''}`}>
              <input type="radio" name="so-who" checked={pick === 'other'} onChange={() => setPick('other')} />
              <span className="call-contact-main">
                <b>Another number</b>
                <span>{techs.length === 0 ? 'No technician with a phone number on this work order yet' : 'A technician not listed here'}</span>
              </span>
            </label>
          </div>
        </div>

        {pick === 'other' && (
          <div className="so-other">
            <div className="field">
              <label className="lbl" htmlFor="so-name">Name</label>
              <input className="fld" id="so-name" value={otherName} maxLength={200} onChange={(e) => setOtherName(e.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="so-phone">Phone</label>
              <input
                className={`fld mono${otherPhone.trim() !== '' && !normalizePhone(otherPhone) ? ' is-err' : ''}`}
                id="so-phone"
                type="tel"
                value={otherPhone}
                maxLength={40}
                placeholder="(409) 555-0143"
                onChange={(e) => setOtherPhone(e.target.value)}
              />
            </div>
          </div>
        )}

        {error && <div className="modal-error">{error}</div>}

        <div className="sheet-f">
          <button type="button" className="btn" onClick={onClose} disabled={share.isPending}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => share.mutate()} disabled={!phone || share.isPending || (kind === 'pdf' && !pdfPossible) || (kind === 'link' && !data.form_link)}>
            <Icon name="send" size={14} />
            {share.isPending ? 'Sending…' : !data.quo_api_ready ? 'Open in Quo' : kind === 'link' ? 'Text the link' : 'Text the sheet'}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}

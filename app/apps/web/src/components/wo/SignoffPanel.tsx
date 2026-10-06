// 0070 · The sign-off sheet, as the Sign-Off Link row of the CICO card.
//
// What the Make + Paperform automation used to do, in the work order itself:
//   · the blank sheet in the billing entity's branding appears as soon as the
//     work order is assigned to a dispatcher (the Assignee field); the
//     Generate button covers the case where Comp was set afterwards, and
//     "New sheet" redraws it once the number or the address changed;
//   · the row shows the PDF itself — a document tile that opens it, a
//     Download, and a fold-out preview — with Send to tech beside it: one
//     technician on file goes straight out, several open a picker, and
//     "another number" is always there;
//   · the signed copy the technician texts back is filed as a sign-off
//     attachment (Photos card, awaiting approval) and linked from the same
//     field — the "Signed copy received" state here; a copy that could belong
//     to several work orders waits in a strip until someone claims or
//     dismisses it.
//
// Without the Quo API configured on the server, Send opens the Quo app on
// this PC with the text pre-filled (an `sms:` link) and still records the
// share, so the reply can be matched. Who may see / do what is the field's
// own permission (work_orders/fields/cico/fields.24. Sign-Off Link); the API
// answers 403 and the row falls back to the plain link.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { normalizePhone, type SignoffReply, type SignoffTechnician, type WoSignoffResponse } from '@theone/shared';
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
import { Icon } from '../Icon';

const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

export function SignoffPanel({ wo, fallback }: { wo: WorkOrderDetailV2; fallback?: ReactNode }) {
  const qc = useQueryClient();
  const key = ['wo-signoff', wo.id];
  const q = useQuery({ queryKey: key, queryFn: () => getWorkOrderSignoff(wo.id), retry: 0 });
  const data = q.data;
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [preview, setPreview] = useState(false);
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
  const canGenerate = data.can.generate && data.storage_ready;
  const busy = generate.isPending || claim.isPending || dismiss.isPending;
  const fileName = s ? `Signoff-${s.wo_ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf` : null;
  const fileUrl = signoffFileUrl(wo.wo_number);

  return (
    <div className="so-row">
      {s ? (
        <div className="so-tile">
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
          <span className="so-chips">
            {s.signed_at && <span className="chip chip-ok chip-sm">Signed copy received</span>}
            {!s.signed_at && s.shares.length > 0 && <span className="chip chip-warn chip-sm">Waiting for the signed copy</span>}
            {s.stale && <span className="chip chip-outline chip-sm" title="The work order's number or address changed after this sheet was drawn">Details changed</span>}
          </span>
        </div>
      ) : (
        <div className="so-empty">
          {data.layout
            ? 'No sheet drawn yet.'
            : 'Set Comp on the work order to pick the sheet\'s branding.'}
        </div>
      )}

      <div className="so-actions">
        {s && (
          <>
            <a className="btn btn-sm is-ghost" href={fileUrl} target="_blank" rel="noreferrer">
              <Icon name="ext" size={14} />
              Open
            </a>
            <a className="btn btn-sm is-ghost" href={fileUrl} download={fileName ?? undefined}>
              <Icon name="download" size={14} />
              Download
            </a>
            <button type="button" className="btn btn-sm is-ghost" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>
              <Icon name={preview ? 'chev-u' : 'chev-d'} size={14} />
              {preview ? 'Hide preview' : 'Preview'}
            </button>
          </>
        )}
        {s && data.can.share && (
          <button type="button" className="btn btn-sm" onClick={() => { setSent(null); setSharing(true); }} disabled={busy}>
            <Icon name="send" size={14} />
            Send to tech
          </button>
        )}
        {!s && canGenerate && data.layout && (
          <button type="button" className="btn btn-sm" onClick={() => generate.mutate()} disabled={busy}>
            <Icon name="file" size={14} />
            {generate.isPending ? 'Drawing…' : 'Generate sheet'}
          </button>
        )}
        {s && canGenerate && (
          <button
            type="button"
            className="btn btn-sm is-ghost"
            onClick={() => generate.mutate()}
            disabled={busy}
            title={s.stale ? 'Redraw the sheet with the current number and address' : 'Redraw the sheet (the old link stops working)'}
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

      {preview && s && (
        <iframe className="so-preview" src={`${fileUrl}#toolbar=0&navpanes=0`} title={fileName ?? 'Sign-off sheet'} />
      )}

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

      {s && (s.signed_at || s.shares.length > 0) && (
        <ul className="so-shares">
          {s.signed_at && (
            <li><span>Signed copy received {feedTime(s.signed_at)}</span><span>awaiting approval in Photos &amp; files</span></li>
          )}
          {s.shares.map((sh) => (
            <li key={sh.id}>
              <span>Sent to <b>{sh.tech_name ?? 'Technician'}</b> <span className="mono">{sh.phone}</span></span>
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
    mutationFn: () => shareWorkOrderSignoff(wo.id, { phone: phone!, tech_name: name, vendor_id: chosen?.vendor_id ?? null }),
    onSuccess: (res) => {
      if (res.channel === 'quo_app' && res.sms) {
        // No API key on the server: the Quo app on this PC takes the text.
        window.location.href = res.sms;
        onSent(res, `Quo should be opening a text to ${name ?? phone} with the sheet's link. Press send there.`);
      } else {
        onSent(res, `Texted the sheet to ${name ?? phone} from the Quo line.`);
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
        <p className="sheet-b">
          The technician gets a text with a link to the blank sheet for <b>{data.signoff?.wo_ref ?? wo.wo_number}</b>, and is
          asked to reply with a photo or scan once the manager on site has signed it.
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
          <button type="button" className="btn btn-primary" onClick={() => share.mutate()} disabled={!phone || share.isPending}>
            <Icon name="send" size={14} />
            {share.isPending ? 'Sending…' : data.quo_api_ready ? 'Text the sheet' : 'Open in Quo'}
          </button>
        </div>
      </div>
    </div>
  );
  return createPortal(body, document.body);
}

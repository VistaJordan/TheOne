import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  PARTS_REQUIRED_KEY,
  POP_REQUEST_LINES,
  emptyPopRequest,
  formatPopRequest,
  parsePopRequest,
  popCostInputValue,
  popRequestEmpty,
  POP_SCREENSHOT_NEEDS_PICTURE,
  formatUsPhone,
  popRequestMissing,
  popRequestMissingSentence,
  popRequestProblems,
  usPhoneInputValue,
  type PopRequest,
  type PopRequestKey,
} from '@theone/shared';
import type { WorkOrderDetailV2 } from '../../api/client';
import { uploadAttachment } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { prepareFile } from '../../lib/upload';
import { Icon } from '../Icon';
import { useCanEditField, useWoFieldSave } from './fieldEdit';

const FIELD_KEY = `fields.${PARTS_REQUIRED_KEY}`;

/** Lines drawn as a bigger box: free text the team writes long. */
const LONG: ReadonlySet<PopRequestKey> = new Set(['specs', 'delivery_address', 'full_address']);

/** A drag that carries files (not text dragged from the page). */
const hasFiles = (dt: DataTransfer) => Array.from(dt.types).includes('Files');
/** The first picture among pasted or dropped files. */
const imageOf = (files: FileList) => Array.from(files).find((f) => f.type.startsWith('image/'));

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** 2026-11-19 (Elise): a POP request being filled survives a refresh. The
    open form is kept in this browser per work order until it is saved,
    cancelled or reset; storage can be off or full, so every touch is
    guarded and the form works without it. */
interface KeptPop {
  draft: PopRequest;
  shotUploaded: boolean;
}
const keptKey = (woId: string) => `theone.pop.draft.${woId}`;
function readKept(woId: string): KeptPop | null {
  try {
    const raw = localStorage.getItem(keptKey(woId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<KeptPop>;
    if (!v.draft || typeof v.draft !== 'object' || !v.draft.values) return null;
    return { draft: { ...emptyPopRequest(), ...v.draft, values: { ...emptyPopRequest().values, ...v.draft.values } }, shotUploaded: v.shotUploaded === true };
  } catch {
    return null;
  }
}
function writeKept(woId: string, kept: KeptPop | null): void {
  try {
    if (kept) localStorage.setItem(keptKey(woId), JSON.stringify(kept));
    else localStorage.removeItem(keptKey(woId));
  } catch {
    // storage off or full: the form still works, it just is not kept
  }
}

/**
 * The POP Request (Elise, 2026-11-16, UAT #44) over the work order's
 * `Parts Required` field: the ten lines the team asks parts with, read from
 * and saved back to that one text field (shared `popRequest.ts`), so the
 * parts gate of Waiting for Parts / Please Order Parts reads it as before.
 * The screenshot is uploaded to the Drive tab (pending review, like every
 * upload) and its file name written on line 10.
 */
export function PopRequestBlock({ wo }: { wo: WorkOrderDetailV2 }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const canEdit = useCanEditField(FIELD_KEY);
  const canUpload = can('work_orders/attachments', 'create');
  const raw = (wo.fields ?? {})[PARTS_REQUIRED_KEY];
  const saved = parsePopRequest(raw);
  const [draft, setDraft] = useState<PopRequest | null>(() => (canEdit ? (readKept(wo.id)?.draft ?? null) : null));
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Elise, 2026-11-17: every line but Specs is required; the boxes paint red
  // only after a Save attempt, and clear as they are filled.
  const [triedSave, setTriedSave] = useState(false);
  // Elise, 2026-11-17: line 10 needs a picture. Typing on the line is fine,
  // but Save waits for one uploaded with Upload screenshot in this edit — or
  // a screenshot line already saved (it was asked then; the API still checks
  // the work order holds an image).
  const [shotUploaded, setShotUploaded] = useState(() => readKept(wo.id)?.shotUploaded === true);
  const [dragging, setDragging] = useState(false);
  // Keep the open form through a refresh; closing it (Save, Cancel) forgets it.
  useEffect(() => {
    writeKept(wo.id, draft ? { draft, shotUploaded } : null);
  }, [wo.id, draft, shotUploaded]);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useWoFieldSave(wo.id, () => {
    setDraft(null);
    setTriedSave(false);
    setShotUploaded(false);
  });

  const setLine = (key: PopRequestKey, value: string) =>
    setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));
  /** What a box holds after a keystroke: QTY digits only, the cost a number
      (2026-11-19), the phone shaped as a US number as it is typed. */
  const typed = (key: PopRequestKey, value: string) =>
    key === 'qty'
      ? value.replace(/\D/g, '').slice(0, 6)
      : key === 'estimated_total_cost'
        ? popCostInputValue(value)
        : key === 'phone'
          ? usPhoneInputValue(value)
          : value;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const prepared = await prepareFile(file);
      const res = await uploadAttachment(wo.id, {
        file_name: prepared.file_name,
        content_type: prepared.content_type,
        data: prepared.data,
        client_visible: false,
      });
      setDraft((d) => {
        if (!d) return d;
        const note = `${res.item.file_name} (on the Drive tab)`;
        const cur = d.values.screenshot.trim();
        return { ...d, values: { ...d.values, screenshot: cur ? `${cur} · ${note}` : note } };
      });
      setShotUploaded(true);
      void qc.invalidateQueries({ queryKey: ['wo-attachments', wo.id] });
      void qc.invalidateQueries({ queryKey: ['wo-activity', wo.id] });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'That picture did not upload');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  if (draft) {
    const busy = save.isPending || uploading;
    const missing = popRequestMissing(draft);
    const problems = popRequestProblems(draft);
    const shotOk = shotUploaded || saved.values.screenshot.trim() !== '';
    const lineError = (key: PopRequestKey): string | null =>
      problems.find((p) => p.key === key)?.message ??
      (key === 'screenshot' && !shotOk ? POP_SCREENSHOT_NEEDS_PICTURE : null);
    const blocked = missing.length > 0 || problems.length > 0 || !shotOk;
    return (
      <form
        className="pop-form"
        autoComplete="off"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked) {
            setTriedSave(true);
            const first = POP_REQUEST_LINES.find(
              (l) => (l.required && draft.values[l.key].trim() === '') || lineError(l.key) !== null,
            );
            if (first) document.getElementById(`pop-${wo.id}-${first.key}`)?.focus();
            return;
          }
          const phone = formatUsPhone(draft.values.phone) ?? draft.values.phone;
          save.mutate({ key: FIELD_KEY, value: formatPopRequest({ ...draft, values: { ...draft.values, phone } }) });
        }}
      >
        <div className="pop-grid">
          {POP_REQUEST_LINES.map((l, i) => {
            const id = `pop-${wo.id}-${l.key}`;
            const value = draft.values[l.key];
            const blank = l.required && value.trim() === '';
            const err = triedSave && !blank ? lineError(l.key) : null;
            const isMissing = triedSave && (blank || err !== null);
            return (
              <div key={l.key} className={`field${LONG.has(l.key) ? ' is-wide' : ''}${isMissing ? ' is-error' : ''}`}>
                <label className="lbl" htmlFor={id}>
                  {i + 1}- {l.label}
                  {l.required && (
                    <>
                      {' '}<span className="req" aria-hidden="true">*</span>
                      <span className="sr">(required)</span>
                    </>
                  )}
                </label>
                {l.key === 'screenshot' ? (
                  <>
                  <div
                    className={`pop-shot${dragging ? ' is-dragging' : ''}`}
                    // 2026-11-19 (Elise): a picture can also be dropped on the
                    // line, or pasted into its box — same upload as the button.
                    onDragOver={(e) => {
                      if (!canUpload || busy || !hasFiles(e.dataTransfer)) return;
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'copy';
                      setDragging(true);
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
                    }}
                    onDrop={(e) => {
                      if (!canUpload || !hasFiles(e.dataTransfer)) return;
                      e.preventDefault();
                      setDragging(false);
                      const pic = imageOf(e.dataTransfer.files);
                      if (pic) void upload(pic);
                      else setUploadError('Drop a picture (an image file)');
                    }}
                  >
                    <input
                      id={id}
                      className="fld"
                      value={value}
                      onChange={(e) => setLine(l.key, e.target.value)}
                      onPaste={(e) => {
                        if (!canUpload || busy) return;
                        const pic = imageOf(e.clipboardData.files);
                        if (!pic) return; // plain text pastes as text
                        e.preventDefault();
                        void upload(pic);
                      }}
                      disabled={busy}
                    />
                    {canUpload && (
                      <>
                        <button
                          type="button"
                          className={`btn btn-sm${triedSave && !shotOk ? ' btn-primary' : ''}`}
                          onClick={() => fileInput.current?.click()}
                          disabled={busy}
                        >
                          <Icon name="upload" size={12} /> {uploading ? 'Uploading…' : 'Upload screenshot'}
                        </button>
                        <input
                          ref={fileInput}
                          type="file"
                          accept="image/*"
                          hidden
                          onChange={(e) => void upload(e.target.files?.[0])}
                        />
                      </>
                    )}
                  </div>
                  {canUpload && <p className="pop-shot-hint">or paste a picture into the box (Ctrl+V), or drop one here</p>}
                  </>
                ) : LONG.has(l.key) ? (
                  <textarea id={id} className="fld" rows={2} value={value} onChange={(e) => setLine(l.key, e.target.value)} disabled={busy} />
                ) : (
                  <input
                    id={id}
                    className="fld"
                    type={l.key === 'phone' ? 'tel' : l.key === 'link' ? 'url' : 'text'}
                    inputMode={l.key === 'qty' ? 'numeric' : l.key === 'estimated_total_cost' ? 'decimal' : undefined}
                    value={value}
                    onChange={(e) => setLine(l.key, typed(l.key, e.target.value))}
                    disabled={busy}
                  />
                )}
                {err && <span className="pop-err">{err}</span>}
              </div>
            );
          })}
          {draft.notes !== '' && (
            <div className="field is-wide">
              <label className="lbl" htmlFor={`pop-${wo.id}-notes`}>Also on this list</label>
              <textarea
                id={`pop-${wo.id}-notes`}
                className="fld"
                rows={3}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                disabled={busy}
              />
            </div>
          )}
        </div>
        {triedSave && missing.length > 0 && (
          <p className="ife-err" role="alert">{popRequestMissingSentence(missing)}</p>
        )}
        {(save.error || uploadError) && <p className="ife-err" role="alert">{save.error ?? uploadError}</p>}
        <div className="pop-actions">
          {draft && !popRequestEmpty(draft) && (
            <button
              type="button"
              className="btn btn-sm"
              title="Empty every line and fill the request again"
              onClick={() => {
                setDraft(emptyPopRequest());
                setShotUploaded(false);
                setTriedSave(false);
                save.clearError();
                setUploadError(null);
              }}
              disabled={busy}
            >
              Reset
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); setTriedSave(false); setShotUploaded(false); save.clearError(); setUploadError(null); }} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-sm btn-primary" disabled={busy}>
            {save.isPending ? 'Saving…' : 'Save POP request'}
          </button>
        </div>
      </form>
    );
  }

  const empty = popRequestEmpty(saved);
  return (
    <div className="pop-view">
      <div className="pop-head">
        <span>
          <span className="parts-main">{empty ? 'No parts listed' : 'POP request'}</span>
          {empty && (
            <span className="parts-sub">
              Waiting for Parts and Please Order Parts need the POP request filled in first.
            </span>
          )}
        </span>
        {canEdit && (
          <button type="button" className="btn btn-sm" onClick={() => setDraft(parsePopRequest(raw))}>
            <Icon name="pencil" size={12} /> {empty ? 'Fill in the POP request' : 'Edit'}
          </button>
        )}
      </div>
      {!empty && (
        <dl className="pop-lines">
          {POP_REQUEST_LINES.map((l, i) => {
            const v = saved.values[l.key];
            return (
              <div key={l.key} className={`pop-line${v ? '' : ' is-blank'}`}>
                <dt>{i + 1}- {l.label}</dt>
                <dd>
                  {!v ? '—' : isUrl(v) ? <a href={v.trim()} target="_blank" rel="noreferrer">{v}</a> : v}
                </dd>
              </div>
            );
          })}
          {saved.notes && (
            <div className="pop-line is-notes">
              <dt>Also on this list</dt>
              <dd>{saved.notes}</dd>
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

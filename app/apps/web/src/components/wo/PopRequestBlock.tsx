import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  PARTS_REQUIRED_KEY,
  POP_REQUEST_LINES,
  formatPopRequest,
  parsePopRequest,
  popRequestEmpty,
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

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

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
  const [draft, setDraft] = useState<PopRequest | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = useWoFieldSave(wo.id, () => setDraft(null));

  const setLine = (key: PopRequestKey, value: string) =>
    setDraft((d) => (d ? { ...d, values: { ...d.values, [key]: value } } : d));

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
      setLine('screenshot', `${res.item.file_name} (on the Drive tab)`);
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
    return (
      <form
        className="pop-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ key: FIELD_KEY, value: formatPopRequest(draft) });
        }}
      >
        <div className="pop-grid">
          {POP_REQUEST_LINES.map((l, i) => {
            const id = `pop-${wo.id}-${l.key}`;
            const value = draft.values[l.key];
            return (
              <div key={l.key} className={`field${LONG.has(l.key) ? ' is-wide' : ''}`}>
                <label className="lbl" htmlFor={id}>{i + 1}- {l.label}</label>
                {l.key === 'screenshot' ? (
                  <div className="pop-shot">
                    <input id={id} className="fld" value={value} onChange={(e) => setLine(l.key, e.target.value)} disabled={busy} />
                    {canUpload && (
                      <>
                        <button type="button" className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={busy}>
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
                ) : LONG.has(l.key) ? (
                  <textarea id={id} className="fld" rows={2} value={value} onChange={(e) => setLine(l.key, e.target.value)} disabled={busy} />
                ) : (
                  <input
                    id={id}
                    className="fld"
                    type={l.key === 'phone' ? 'tel' : l.key === 'link' ? 'url' : 'text'}
                    inputMode={l.key === 'qty' ? 'numeric' : l.key === 'estimated_total_cost' ? 'decimal' : undefined}
                    value={value}
                    onChange={(e) => setLine(l.key, e.target.value)}
                    disabled={busy}
                  />
                )}
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
        {(save.error || uploadError) && <p className="ife-err" role="alert">{save.error ?? uploadError}</p>}
        <div className="pop-actions">
          <button type="button" className="btn btn-sm" onClick={() => { setDraft(null); save.clearError(); setUploadError(null); }} disabled={busy}>
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

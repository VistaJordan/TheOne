/* 0058 · What hangs on one vendor record beside its form: what is still
 * missing, its open tasks, its documents (with the COI checklist per company),
 * and the log of calls and emails.
 *
 * Every write answers with the whole VendorWorkResponse, which replaces the
 * cached one — the panels never patch themselves. A call that names an
 * outcome, and a document that changes the paperwork, also change the record,
 * so those refresh it too.
 *
 * Emails are a LOG: The One sends none (held on purpose). The form records an
 * email somebody sent from their own mailbox. */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COI_CHECKLIST,
  TRI_STATE_LABELS,
  VENDOR_DOCUMENT_MAX_BYTES,
  VENDOR_DOCUMENT_TYPE_LABELS,
  VENDOR_TASK_ACTIONS,
  VENDOR_REVIEW_TASK_TYPES,
  VENDOR_TASK_TYPE_LABELS,
} from '@theone/shared';
import type {
  CoiChecklistKey,
  CoiRequirement,
  VendorCall,
  VendorDetail,
  VendorDocument,
  VendorDocumentType,
  VendorStatusDef,
  VendorTask,
  VendorTaskAction,
  VendorWorkResponse,
} from '@theone/shared';
import {
  ApiRequestError,
  createVendorTask,
  deleteVendorCall,
  deleteVendorDocument,
  editVendorCall,
  getVendorWork,
  logVendorCall,
  logVendorEmail,
  renameVendorDocument,
  resolveVendorTask,
  saveVendorCoiChecklist,
  uploadVendorDocument,
  vendorDocumentUrl,
} from '../../api/client';
import { feedTime } from '../../lib/fields';
import { Icon } from '../Icon';

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : e instanceof Error ? e.message : fallback);

const ACTION_LABELS: Record<VendorTaskAction, string> = {
  keep: 'Keep both',
  remove: 'Remove this one',
  acknowledge: 'Acknowledge',
  approve: 'Approve',
  send_back: 'Send back',
  fixed: 'Mark fixed',
  done: 'Mark done',
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('That file could not be read'));
    reader.readAsDataURL(file);
  });
}

const kb = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`);

interface Props {
  v: VendorDetail;
  vendorKey: string[];
  statuses: VendorStatusDef[];
  entities: { key: string; label: string }[];
}

export function VendorRecordPanels({ v, vendorKey, statuses, entities }: Props) {
  const qc = useQueryClient();
  const workKey = ['vendor-work', v.id];
  const work = useQuery({ queryKey: workKey, queryFn: () => getVendorWork(v.id) });
  const [error, setError] = useState<string | null>(null);

  /** Every panel's write lands here. */
  const landed = (res: VendorWorkResponse, touchesRecord = false) => {
    qc.setQueryData(workKey, res);
    setError(null);
    void qc.invalidateQueries({ queryKey: ['vendor-tasks'] });
    if (touchesRecord) {
      void qc.invalidateQueries({ queryKey: vendorKey });
      void qc.invalidateQueries({ queryKey: ['vendors'] });
    }
  };
  const failed = (fallback: string) => (e: unknown) => setError(errText(e, fallback));

  const w = work.data;
  if (!w) return work.isError ? <div className="callout"><Icon name="alert" size={14} /><span>Could not load the documents and the log.</span></div> : null;
  const entityLabel = (key: string | null) => (!key || key === '-' ? 'No company named' : (entities.find((e) => e.key === key)?.label ?? key));

  return (
    <>
      {error && (
        <div className="callout" role="alert">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {w.problems.length > 0 && (
        <div className="callout vrec-missing">
          <Icon name="alert" size={14} />
          <span>
            <b>Still needed:</b>{' '}
            {w.problems.map((p) => (p.problem === 'invalid' ? `${p.label} (not usable)` : p.label)).join(', ')}
          </span>
        </div>
      )}

      <TasksPanel v={v} w={w} onChanged={() => { void qc.invalidateQueries({ queryKey: workKey }); void qc.invalidateQueries({ queryKey: vendorKey }); void qc.invalidateQueries({ queryKey: ['vendor-tasks'] }); }} onError={setError} />

      {v.kind === 'vendor' && (
        <DocumentsPanel v={v} w={w} entities={entities} entityLabel={entityLabel} landed={landed} failed={failed} />
      )}

      <CallsPanel v={v} w={w} statuses={statuses} landed={landed} failed={failed} />
      <EmailsPanel v={v} w={w} landed={landed} failed={failed} />
    </>
  );
}

type Landed = (res: VendorWorkResponse, touchesRecord?: boolean) => void;
type Failed = (fallback: string) => (e: unknown) => void;

// ── Tasks ────────────────────────────────────────────────────────────────────

function TasksPanel({ v, w, onChanged, onError }: { v: VendorDetail; w: VendorWorkResponse; onChanged: () => void; onError: (m: string | null) => void }) {
  const [title, setTitle] = useState('');
  const [sendBack, setSendBack] = useState<{ id: string; note: string } | null>(null);
  const open = w.tasks.filter((t) => t.status === 'OPEN');
  const closed = w.tasks.filter((t) => t.status === 'DONE').slice(0, 5);

  const add = useMutation({
    mutationFn: () => createVendorTask({ title: title.trim(), vendor_id: v.id }),
    onSuccess: () => { setTitle(''); onError(null); onChanged(); },
    onError: (e) => onError(errText(e, 'Could not add the task.')),
  });
  const resolve = useMutation({
    mutationFn: (x: { id: string; action: VendorTaskAction; note?: string }) => resolveVendorTask(x.id, x.action, x.note),
    onSuccess: () => { setSendBack(null); onError(null); onChanged(); },
    onError: (e) => onError(errText(e, 'Could not close the task.')),
  });

  const actionsFor = (t: VendorTask): VendorTaskAction[] => {
    const review = (VENDOR_REVIEW_TASK_TYPES as readonly string[]).includes(t.type);
    if (review && !w.can.review) return [];
    // Removing the record you are looking at belongs to the Remove button.
    return VENDOR_TASK_ACTIONS[t.type].filter((a) => a !== 'remove');
  };

  if (open.length === 0 && closed.length === 0 && !w.can.edit) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Tasks</h2>
        {open.length > 0 && <span className="card-meta">{open.length} open</span>}
      </div>
      <ul className="vrec-list">
        {open.length === 0 && <li>Nothing open</li>}
        {open.map((t) => (
          <li key={t.id} className="vrec-task">
            <span className="chip chip-sm">{VENDOR_TASK_TYPE_LABELS[t.type]}</span>
            <span className="vrec-task-t">{t.title}</span>
            <span className="vrec-sub">
              {t.assigned_to ? `For ${t.assigned_to.name}` : 'Review queue'} · {feedTime(t.created_at)}
            </span>
            {sendBack?.id === t.id ? (
              <span className="vrec-inline" style={{ padding: 0, width: '100%' }}>
                <input className="fld" style={{ flex: 1, minWidth: 140 }} autoFocus placeholder="What needs fixing?" value={sendBack.note} onChange={(e) => setSendBack({ id: t.id, note: e.target.value })} />
                <button type="button" className="btn btn-sm is-danger" disabled={sendBack.note.trim() === '' || resolve.isPending} onClick={() => resolve.mutate({ id: t.id, action: 'send_back', note: sendBack.note.trim() })}>Send back</button>
                <button type="button" className="btn btn-sm is-ghost" onClick={() => setSendBack(null)}>Cancel</button>
              </span>
            ) : (
              <span className="vrec-task-a">
                {actionsFor(t).map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`btn btn-sm${a === 'send_back' ? ' is-ghost' : ''}`}
                    disabled={resolve.isPending}
                    onClick={() => (a === 'send_back' ? setSendBack({ id: t.id, note: '' }) : resolve.mutate({ id: t.id, action: a }))}
                  >
                    {ACTION_LABELS[a]}
                  </button>
                ))}
              </span>
            )}
          </li>
        ))}
        {closed.map((t) => (
          <li key={t.id} className="vrec-task is-closed">
            <Icon name="check" size={12} />
            <span className="vrec-task-t">{t.title}</span>
            <span className="vrec-sub">
              {(t.outcome ?? 'done').replace('_', ' ')}{t.completed_by ? ` · ${t.completed_by.name}` : ''}{t.completed_at ? ` · ${feedTime(t.completed_at)}` : ''}
              {t.note ? ` — ${t.note}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {w.can.edit && (
        <form className="vrec-inline" onSubmit={(e) => { e.preventDefault(); if (title.trim()) add.mutate(); }}>
          <input className="fld" style={{ flex: 1, minWidth: 140 }} placeholder="Add a task for yourself…" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New task" />
          <button type="submit" className="btn btn-sm" disabled={title.trim() === '' || add.isPending}>Add</button>
        </form>
      )}
    </section>
  );
}

// ── Documents and the COI checklist ──────────────────────────────────────────

function DocumentsPanel({ v, w, entities, entityLabel, landed, failed }: {
  v: VendorDetail;
  w: VendorWorkResponse;
  entities: { key: string; label: string }[];
  entityLabel: (key: string | null) => string;
  landed: Landed;
  failed: Failed;
}) {
  const companies = entities.filter((e) => e.key !== 'BOTH');
  const [type, setType] = useState<VendorDocumentType>('COI');
  const [entity, setEntity] = useState(companies[0]?.key ?? '');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (file.size > VENDOR_DOCUMENT_MAX_BYTES) throw new Error(`That file is larger than ${Math.round(VENDOR_DOCUMENT_MAX_BYTES / (1024 * 1024))}MB.`);
      return uploadVendorDocument(v.id, {
        type,
        entity: type === 'COI' ? entity || null : null,
        file_name: file.name,
        content_type: file.type || 'application/octet-stream',
        data: await toBase64(file),
      });
    },
    onSuccess: (res) => landed(res, true),
    onError: failed('Could not upload the file.'),
  });
  const rename = useMutation({
    mutationFn: (x: { id: string; name: string }) => renameVendorDocument(v.id, x.id, x.name),
    onSuccess: (res) => { setRenaming(null); landed(res); },
    onError: failed('Could not rename the file.'),
  });
  const remove = useMutation({
    mutationFn: (docId: string) => deleteVendorDocument(v.id, docId),
    onSuccess: (res) => landed(res, true),
    onError: failed('Could not remove the file.'),
  });
  const tick = useMutation({
    mutationFn: (x: { entity: string; checks: Partial<Record<CoiChecklistKey, boolean>> }) => saveVendorCoiChecklist(v.id, x.entity, x.checks),
    onSuccess: (res) => landed(res),
    onError: failed('Could not save the checklist.'),
  });

  // One checklist per company that has a certificate or a review on file.
  const coiEntities = [...new Set([...w.documents.filter((d) => d.type === 'COI').map((d) => d.entity ?? '-'), ...w.coi.map((c) => c.entity)])];
  const reqOf = (key: string): CoiRequirement | undefined => w.coi.find((c) => c.entity === key);

  const docRow = (d: VendorDocument) => (
    <li key={d.id}>
      <span className="chip chip-sm">{d.type === 'COI' ? 'COI' : VENDOR_DOCUMENT_TYPE_LABELS[d.type]}</span>
      {renaming?.id === d.id ? (
        <>
          <input className="fld" style={{ flex: 1, minWidth: 120 }} autoFocus value={renaming.name} onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} aria-label="File name" />
          <button type="button" className="btn btn-sm" disabled={renaming.name.trim() === '' || rename.isPending} onClick={() => rename.mutate({ id: d.id, name: renaming.name.trim() })}>Save</button>
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setRenaming(null)}>Cancel</button>
        </>
      ) : (
        <>
          <a href={vendorDocumentUrl(v.id, d.id)} target="_blank" rel="noreferrer">{d.file_name}</a>
          <span className="vrec-sub">
            {[d.type === 'COI' ? entityLabel(d.entity) : null, kb(d.byte_size), d.uploaded_by?.name, feedTime(d.created_at)].filter(Boolean).join(' · ')}
          </span>
          {w.can.upload && (
            <button type="button" className="icon-btn push" aria-label={`Rename ${d.file_name}`} onClick={() => setRenaming({ id: d.id, name: d.file_name })}><Icon name="pencil" size={12} /></button>
          )}
          {w.can.delete_document && (
            <button type="button" className={`icon-btn${w.can.upload ? '' : ' push'}`} aria-label={`Remove ${d.file_name}`} disabled={remove.isPending} onClick={() => remove.mutate(d.id)}><Icon name="trash" size={12} /></button>
          )}
        </>
      )}
    </li>
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Documents</h2>
        <span className="card-meta">W-9 {TRI_STATE_LABELS[v.w9_received]} · MSA {TRI_STATE_LABELS[v.msa_signed]} · COI {TRI_STATE_LABELS[v.coi_received]}</span>
      </div>
      <ul className="vrec-list">
        {w.documents.length === 0 && <li>No documents on file</li>}
        {w.documents.map(docRow)}
      </ul>

      {w.can.upload && (
        w.storage_ready ? (
          <div className="vrec-inline">
            <select className="fld" value={type} onChange={(e) => setType(e.target.value as VendorDocumentType)} aria-label="Document type">
              {(Object.keys(VENDOR_DOCUMENT_TYPE_LABELS) as VendorDocumentType[]).map((t) => <option key={t} value={t}>{VENDOR_DOCUMENT_TYPE_LABELS[t]}</option>)}
            </select>
            {type === 'COI' && companies.length > 0 && (
              <select className="fld" value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Company the certificate names">
                {companies.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </select>
            )}
            <label className={`btn btn-sm${upload.isPending ? ' is-disabled' : ''}`}>
              <Icon name="upload" size={12} />
              {upload.isPending ? 'Uploading…' : 'Upload'}
              <input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.doc,.docx" disabled={upload.isPending} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload.mutate(f); }} />
            </label>
          </div>
        ) : (
          <p className="vrec-note">File storage is not connected on this server, so uploads are off here. The checklist and the dates still work.</p>
        )
      )}

      {coiEntities.map((key) => {
        const r = reqOf(key);
        return (
          <div className="vrec-coi" key={key}>
            <div className="vrec-coi-h">
              <b>COI · {entityLabel(key)}</b>
              <span className={`chip chip-sm${r?.approved === 'YES' ? ' chip-accent' : r?.approved === 'NO' ? ' chip-danger' : ''}`}>
                {r?.approved === 'YES' ? 'Approved' : r?.approved === 'NO' ? 'Sent back' : 'Waiting for review'}
              </span>
            </div>
            {r?.approved === 'NO' && r.review_note && <p className="vrec-note">Sent back{r.reviewed_by ? ` by ${r.reviewed_by.name}` : ''}: {r.review_note}</p>}
            <div className="vrec-coi-checks">
              {COI_CHECKLIST.map((c) => (
                <label key={c.key} className="tmap-check">
                  <input
                    type="checkbox"
                    checked={Boolean(r?.[c.key])}
                    disabled={!w.can.edit || tick.isPending}
                    onChange={(e) => tick.mutate({
                      entity: key,
                      checks: { ...Object.fromEntries(COI_CHECKLIST.map((x) => [x.key, Boolean(r?.[x.key])])), [c.key]: e.target.checked },
                    })}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ── Calls ────────────────────────────────────────────────────────────────────

const EMPTY_CALL = { notes: '', summary: '', call_link: '', resulting_status: '' };

function CallsPanel({ v, w, statuses, landed, failed }: { v: VendorDetail; w: VendorWorkResponse; statuses: VendorStatusDef[]; landed: Landed; failed: Failed }) {
  const [form, setForm] = useState<typeof EMPTY_CALL | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const statusLabel = (k: string | null) => (k ? (statuses.find((s) => s.key === k)?.label ?? k) : null);

  const body = (f: typeof EMPTY_CALL) => ({
    notes: f.notes.trim() || null,
    summary: f.summary.trim() || null,
    call_link: f.call_link.trim() || null,
    resulting_status: f.resulting_status || null,
  });
  const save = useMutation({
    mutationFn: () => (editing ? editVendorCall(v.id, editing, body(form!)) : logVendorCall(v.id, body(form!))),
    onSuccess: (res) => { setForm(null); setEditing(null); landed(res, true); },
    onError: failed('Could not save the call.'),
  });
  const remove = useMutation({
    mutationFn: (callId: string) => deleteVendorCall(v.id, callId),
    onSuccess: (res) => landed(res),
    onError: failed('Could not remove the call.'),
  });
  const startEdit = (c: VendorCall) => {
    setEditing(c.id);
    setForm({ notes: c.notes ?? '', summary: c.summary ?? '', call_link: c.call_link ?? '', resulting_status: c.resulting_status ?? '' });
  };
  const empty = form !== null && !form.notes.trim() && !form.summary.trim() && !form.call_link.trim() && !form.resulting_status;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Calls</h2>
        {w.can.edit && form === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => { setEditing(null); setForm({ ...EMPTY_CALL }); }}>
            <Icon name="plus" size={12} /> Log a call
          </button>
        )}
      </div>
      {form !== null && (
        <div className="vrec-form">
          <textarea className="fld" rows={3} autoFocus placeholder="What was said" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Call notes" />
          <input className="fld" placeholder="One-line summary (optional)" value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} aria-label="Summary" />
          <input className="fld" placeholder="Link to the recording (optional)" value={form.call_link} onChange={(e) => setForm({ ...form, call_link: e.target.value })} aria-label="Recording link" />
          <select className="fld" value={form.resulting_status} onChange={(e) => setForm({ ...form, resulting_status: e.target.value })} aria-label="Outcome">
            <option value="">Outcome — leave the status as it is</option>
            {statuses.filter((s) => s.is_active).map((s) => <option key={s.key} value={s.key}>Status becomes {s.label}</option>)}
          </select>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={empty || save.isPending} onClick={() => save.mutate()}>{editing ? 'Save changes' : 'Log the call'}</button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => { setForm(null); setEditing(null); }}>Cancel</button>
          </span>
        </div>
      )}
      <ul className="vrec-list vrec-log">
        {w.calls.length === 0 && form === null && <li>No calls logged</li>}
        {w.calls.map((c) => (
          <li key={c.id}>
            <span className="vrec-log-h">
              <Icon name="phone" size={12} />
              <b>{c.logged_by?.name ?? 'Someone'}</b>
              <span className="vrec-sub">{feedTime(c.occurred_at)}{c.edited_at ? ' · edited' : ''}</span>
              {statusLabel(c.resulting_status) && <span className="chip chip-sm">→ {statusLabel(c.resulting_status)}</span>}
              {w.can.edit && (
                <>
                  <button type="button" className="icon-btn push" aria-label="Edit this call" onClick={() => startEdit(c)}><Icon name="pencil" size={12} /></button>
                  <button type="button" className="icon-btn" aria-label="Remove this call" disabled={remove.isPending} onClick={() => remove.mutate(c.id)}><Icon name="trash" size={12} /></button>
                </>
              )}
            </span>
            {c.summary && <span className="vrec-log-s">{c.summary}</span>}
            {c.notes && <span className="vrec-log-n">{c.notes}</span>}
            {c.call_link && /^https?:\/\//i.test(c.call_link) && <a href={c.call_link} target="_blank" rel="noreferrer">Recording</a>}
          </li>
        ))}
      </ul>
    </section>
  );
}

// ── Emails (a log — nothing is sent from here) ───────────────────────────────

function EmailsPanel({ v, w, landed, failed }: { v: VendorDetail; w: VendorWorkResponse; landed: Landed; failed: Failed }) {
  const [form, setForm] = useState<{ subject: string; notes: string } | null>(null);
  const save = useMutation({
    mutationFn: () => logVendorEmail(v.id, { subject: form!.subject.trim() || null, notes: form!.notes.trim() || null }),
    onSuccess: (res) => { setForm(null); landed(res, true); },
    onError: failed('Could not save the email.'),
  });
  if (w.emails.length === 0 && !w.can.edit) return null;
  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Emails</h2>
        {w.can.edit && form === null && (
          <button type="button" className="btn btn-sm is-ghost" onClick={() => setForm({ subject: '', notes: '' })}>
            <Icon name="plus" size={12} /> Log an email
          </button>
        )}
      </div>
      {form !== null && (
        <div className="vrec-form">
          <input className="fld" autoFocus placeholder="Subject" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} aria-label="Subject" />
          <textarea className="fld" rows={2} placeholder="What it said (optional)" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Notes" />
          <p className="vrec-note" style={{ padding: 0 }}>This records an email you sent from your own mailbox. The One does not send it.</p>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="btn btn-sm" disabled={(!form.subject.trim() && !form.notes.trim()) || save.isPending} onClick={() => save.mutate()}>Log the email</button>
            <button type="button" className="btn btn-sm is-ghost" onClick={() => setForm(null)}>Cancel</button>
          </span>
        </div>
      )}
      <ul className="vrec-list vrec-log">
        {w.emails.length === 0 && form === null && <li>No emails logged</li>}
        {w.emails.map((e) => (
          <li key={e.id}>
            <span className="vrec-log-h">
              <Icon name="send" size={12} />
              <b>{e.subject ?? 'No subject'}</b>
              <span className="vrec-sub">{[e.logged_by?.name, feedTime(e.sent_at)].filter(Boolean).join(' · ')}</span>
            </span>
            {e.notes && <span className="vrec-log-n">{e.notes}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* Admin › Settings · Work-order PDFs (0073).
 *
 * "Save as PDF" on a work order draws one of two documents in the billing
 * entity's branding: the FULL work order (the main fields) and the REQUEST
 * (what the client sent). This card is where an administrator picks which
 * fields each one prints and in what order, names the document, decides
 * whether empty fields are left off, and adds a note under the fields.
 *
 * The list offers every field of the catalogue by section. Whatever is
 * listed, a field a person cannot see is never printed — the API trims the
 * document with the same field permissions as the page.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  WO_PDF_DEFAULTS,
  WO_PDF_KIND_HINTS,
  WO_PDF_KIND_LABELS,
  type WoPdfFieldInfo,
  type WoPdfKind,
  type WoPdfLayout,
  type WoPdfLayoutsResponse,
} from '@theone/shared';
import { getPdfLayouts, savePdfLayout } from '../../api/client';
import { Icon } from '../../components/Icon';
import { F, Sheet, dayText, errText } from '../../components/ui/Sheet';

const KEY = ['admin', 'pdf-layouts'];

export function PdfLayoutsCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getPdfLayouts, retry: false });
  const [editing, setEditing] = useState<WoPdfKind | null>(null);
  const d = q.data;
  if (!d) return null;
  const layout = editing ? d.layouts.find((l) => l.kind === editing) ?? null : null;

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Work-order PDFs</h2>
      </div>
      <p className="hint mt-hint">
        "Save as PDF" on a work order draws one of these two documents in the billing entity's branding. Pick the fields each one
        prints and their order. A field a person cannot see on the page is never printed, whatever the list says.
      </p>
      <ul className="vx-list">
        {d.layouts.map((l) => (
          <li key={l.kind}>
            <span className="grow">
              <b>{WO_PDF_KIND_LABELS[l.kind]} · “{l.title}”</b>
              <small>
                {l.items.length} {l.items.length === 1 ? 'field' : 'fields'}
                {l.hide_empty ? ' · empty fields left off' : ''}
                {l.note ? ' · with a note' : ''}
                {l.updated_at ? ` · changed ${dayText(l.updated_at)}` : ' · standard list'}
              </small>
            </span>
            <button type="button" className="link-btn" onClick={() => setEditing(l.kind)}>{d.can.edit ? 'Edit' : 'Open'}</button>
          </li>
        ))}
      </ul>
      {layout && (
        <LayoutDialog
          layout={layout}
          fields={d.fields}
          canEdit={d.can.edit}
          onClose={() => setEditing(null)}
          onSaved={(res) => qc.setQueryData(KEY, res)}
        />
      )}
    </section>
  );
}

function LayoutDialog({ layout, fields, canEdit, onClose, onSaved }: {
  layout: WoPdfLayout;
  fields: WoPdfFieldInfo[];
  canEdit: boolean;
  onClose: () => void;
  onSaved: (r: WoPdfLayoutsResponse) => void;
}) {
  const [title, setTitle] = useState(layout.title);
  const [note, setNote] = useState(layout.note ?? '');
  const [hideEmpty, setHideEmpty] = useState(layout.hide_empty);
  const [items, setItems] = useState<string[]>(layout.items);
  const [problem, setProblem] = useState<string | null>(null);

  const byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  // The picker: every field not yet on the page, grouped by section in the
  // catalogue's order.
  const groups = useMemo(() => {
    const on = new Set(items);
    const out: { section: string; fields: WoPdfFieldInfo[] }[] = [];
    for (const f of fields) {
      if (on.has(f.key)) continue;
      const g = out.find((x) => x.section === f.section);
      if (g) g.fields.push(f);
      else out.push({ section: f.section, fields: [f] });
    }
    return out;
  }, [fields, items]);

  const move = (i: number, to: number) => {
    if (to < 0 || to >= items.length) return;
    setItems((cur) => {
      const next = [...cur];
      const [k] = next.splice(i, 1);
      next.splice(to, 0, k);
      return next;
    });
  };

  const save = useMutation({
    mutationFn: () => {
      if (!title.trim()) throw new Error('Give the document a title.');
      return savePdfLayout(layout.kind, { title: title.trim(), items, hide_empty: hideEmpty, note: note.trim() || null });
    },
    onSuccess: (res) => { onSaved(res); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the layout.')),
  });

  return (
    <Sheet
      title={`${WO_PDF_KIND_LABELS[layout.kind]} PDF`}
      icon="file"
      onClose={onClose}
      problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
        {canEdit && (
          <button type="button" className="btn" onClick={() => { setItems([...WO_PDF_DEFAULTS[layout.kind].items]); setTitle(WO_PDF_DEFAULTS[layout.kind].title); setHideEmpty(WO_PDF_DEFAULTS[layout.kind].hide_empty); }}>
            Standard list
          </button>
        )}
        {canEdit && <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
      </>}
    >
      <p className="hint pdfl-hint">{WO_PDF_KIND_HINTS[layout.kind]}</p>
      <fieldset className="mt-fieldset" disabled={!canEdit}>
        <div className="pf-form">
          <F label="Title on the document"><input className="fld" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} /></F>
          <label className="tmap-check pf-field pdfl-check">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
            <span>Leave a field off the page when the work order has no value for it</span>
          </label>
          <F label="Note under the fields" wide hint="A disclaimer, a contact line, instructions for the reader. Optional.">
            <textarea className="fld" rows={2} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
          </F>
        </div>

        <div className="pdfl-grid">
          <div>
            <div className="pdfl-head">
              <b>On the page</b>
              <small>{items.length} {items.length === 1 ? 'field' : 'fields'}, top to bottom</small>
            </div>
            {items.length === 0 && <div className="empty-flat">Nothing yet — add fields from the list.</div>}
            <ol className="pdfl-list" aria-label="Fields on the page, in order">
              {items.map((k, i) => {
                const f = byKey.get(k);
                return (
                  <li key={k} className={f ? undefined : 'is-off'}>
                    <span className="pdfl-n">{i + 1}</span>
                    <span className="grow">
                      <span className="pdfl-label">{f?.label ?? k}</span>
                      <small>{f ? f.section : 'no longer a field — it will be skipped'}</small>
                    </span>
                    {canEdit && (
                      <span className="pdfl-ctls">
                        <button type="button" className="pdfl-ctl" aria-label="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}><Icon name="chev-u" size={12} /></button>
                        <button type="button" className="pdfl-ctl" aria-label="Move down" disabled={i === items.length - 1} onClick={() => move(i, i + 1)}><Icon name="chev-d" size={12} /></button>
                        <button type="button" className="pdfl-ctl" aria-label={`Remove ${f?.label ?? k}`} onClick={() => setItems((cur) => cur.filter((x) => x !== k))}><Icon name="x" size={12} /></button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          <div>
            <div className="pdfl-head">
              <b>Add a field</b>
              <small>Every field, by section</small>
            </div>
            {canEdit ? (
              <select
                className="fld"
                value=""
                aria-label="Add a field to the page"
                onChange={(e) => { const k = e.target.value; if (k) setItems((cur) => (cur.includes(k) ? cur : [...cur, k])); }}
              >
                <option value="">Pick a field…</option>
                {groups.map((g) => (
                  <optgroup key={g.section} label={g.section}>
                    {g.fields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </optgroup>
                ))}
              </select>
            ) : (
              <p className="hint">Only Admin › Settings editors can change the list.</p>
            )}
            <p className="hint pdfl-note">
              Long text (the description, parts required, notes) runs across the full width; everything else sits two to a row.
              The WO number, the entity's logo and the page footer are always on the document.
            </p>
          </div>
        </div>
      </fieldset>
    </Sheet>
  );
}

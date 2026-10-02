/* Admin › Settings · the tax rate table and the document templates (0067).
 *
 * A tax rate is something to pick: nothing on file is recomputed when one
 * changes. A template dresses the PRINTED quote, invoice and purchase order
 * with a letterhead, terms and a footer; with none set, they print bare.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DOC_TEMPLATE_KINDS, DOC_TEMPLATE_KIND_LABELS, type DocTemplate, type DocTemplateKind, type FinanceSetup } from '@theone/shared';
import { deleteDocTemplate, getFinanceSetup, saveDocTemplate, saveTaxRate } from '../../api/client';
import { Icon } from '../../components/Icon';
import { F, Sheet, errText, numOrNull } from '../../components/ui/Sheet';

const KEY = ['admin', 'finance-setup'];

export function FinanceSetupCards() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: getFinanceSetup, retry: false });
  const [rate, setRate] = useState({ name: '', rate: '', state: '' });
  const [tpl, setTpl] = useState<DocTemplate | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: FinanceSetup) => { qc.setQueryData(KEY, res); setError(null); void qc.invalidateQueries({ queryKey: ['print-template'] }); void qc.invalidateQueries({ queryKey: ['purchasing', 'meta'] }); };
  const fail = (e: unknown) => setError(errText(e, 'Could not save.'));
  const addRate = useMutation({
    mutationFn: () => {
      const n = numOrNull(rate.rate);
      if (!rate.name.trim() || n === null) throw new Error('Give the rate a name and a percent.');
      return saveTaxRate(null, { name: rate.name.trim(), rate: n, state: rate.state.trim() || null });
    },
    onSuccess: (res) => { done(res); setRate({ name: '', rate: '', state: '' }); },
    onError: fail,
  });
  const patchRate = useMutation({ mutationFn: (x: { id: string; is_default?: boolean; is_active?: boolean }) => saveTaxRate(x.id, { is_default: x.is_default, is_active: x.is_active }), onSuccess: done, onError: fail });
  const d = q.data;
  if (!d) return null;
  const edit = d.can.edit;

  return (
    <>
      <section className="card">
        <div className="card-head"><h2 className="card-title grow">Tax rates</h2><span className="card-meta">{d.tax_rates.filter((r) => r.is_active).length}</span></div>
        <p className="hint mt-hint">The rates offered on a purchase order and by “apply a rate” on a quote. Changing one recomputes nothing already on file. The default is pre-picked on a new purchase order.</p>
        {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
        <ul className="vx-list">
          {d.tax_rates.map((r) => (
            <li key={r.id} className={r.is_active ? undefined : 'is-off'}>
              <span className="grow"><b>{r.name}</b><small>{[`${r.rate}%`, r.state].filter(Boolean).join(' · ')}</small></span>
              {r.is_default && <span className="chip chip-sm chip-accent">Default</span>}
              {edit && r.is_active && <button type="button" className="link-btn" disabled={patchRate.isPending} onClick={() => patchRate.mutate({ id: r.id, is_default: !r.is_default })}>{r.is_default ? 'Not the default' : 'Make default'}</button>}
              {edit && <button type="button" className="link-btn" disabled={patchRate.isPending} onClick={() => patchRate.mutate({ id: r.id, is_active: !r.is_active })}>{r.is_active ? 'Switch off' : 'Switch on'}</button>}
            </li>
          ))}
        </ul>
        {d.tax_rates.length === 0 && <div className="empty-flat">No tax rates. Without one, purchase orders carry no tax and quotes keep their hand-typed sales tax.</div>}
        {edit && (
          <form className="rec-add mt-add" onSubmit={(e) => { e.preventDefault(); addRate.mutate(); }}>
            <input className="fld" placeholder="Name, e.g. Texas sales tax" value={rate.name} onChange={(e) => setRate((c) => ({ ...c, name: e.target.value }))} aria-label="Tax rate name" />
            <input className="fld mt-qty" type="number" min="0" max="100" step="0.001" placeholder="%" value={rate.rate} onChange={(e) => setRate((c) => ({ ...c, rate: e.target.value }))} aria-label="Percent" />
            <input className="fld mt-qty" placeholder="State" value={rate.state} onChange={(e) => setRate((c) => ({ ...c, state: e.target.value }))} aria-label="State" />
            <button type="submit" className="btn btn-sm" disabled={addRate.isPending}>Add</button>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Document templates</h2>
          {edit && <button type="button" className="btn btn-sm is-ghost" onClick={() => setTpl('new')}><Icon name="plus" size={12} /> New template</button>}
        </div>
        <p className="hint mt-hint">A template adds a letterhead, terms and a footer to a printed quote, invoice or purchase order. The default of each kind is the one used; with none, the document prints without them.</p>
        <ul className="vx-list">
          {d.templates.map((t) => (
            <li key={t.id} className={t.is_active ? undefined : 'is-off'}>
              <span className="grow"><b>{t.name}</b><small>{DOC_TEMPLATE_KIND_LABELS[t.kind]}{t.company_name ? ` · ${t.company_name}` : ''}</small></span>
              {t.is_default && <span className="chip chip-sm chip-accent">In use</span>}
              <button type="button" className="link-btn" onClick={() => setTpl(t)}>{edit ? 'Edit' : 'Open'}</button>
            </li>
          ))}
        </ul>
        {d.templates.length === 0 && <div className="empty-flat">No templates yet.</div>}
      </section>
      {tpl && <TemplateDialog tpl={tpl === 'new' ? null : tpl} canEdit={edit} onClose={() => setTpl(null)} onSaved={done} />}
    </>
  );
}

function TemplateDialog({ tpl, canEdit, onClose, onSaved }: { tpl: DocTemplate | null; canEdit: boolean; onClose: () => void; onSaved: (r: FinanceSetup) => void }) {
  const [d, setD] = useState({
    kind: (tpl?.kind ?? 'quote') as DocTemplateKind, name: tpl?.name ?? '', company_name: tpl?.company_name ?? '', company_details: tpl?.company_details ?? '',
    terms: tpl?.terms ?? '', footer: tpl?.footer ?? '', is_default: tpl?.is_default ?? true,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!d.name.trim()) throw new Error('Name the template.');
      return saveDocTemplate(tpl?.id ?? null, { ...(tpl ? {} : { kind: d.kind }), name: d.name.trim(), company_name: d.company_name.trim() || null, company_details: d.company_details.trim() || null, terms: d.terms.trim() || null, footer: d.footer.trim() || null, is_default: d.is_default });
    },
    onSuccess: (res) => { onSaved(res); onClose(); },
    onError: (e) => setProblem(errText(e, 'Could not save the template.')),
  });
  const remove = useMutation({ mutationFn: () => deleteDocTemplate(tpl!.id), onSuccess: (res) => { onSaved(res); onClose(); }, onError: (e) => setProblem(errText(e, 'Could not delete the template.')) });
  return (
    <Sheet title={tpl ? tpl.name : 'New document template'} icon="file" onClose={onClose} problem={problem}
      footer={<>
        <button type="button" className="btn" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
        {tpl && canEdit && <button type="button" className="btn is-danger" disabled={remove.isPending} onClick={() => remove.mutate()}>Delete</button>}
        {canEdit && <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save'}</button>}
      </>}>
      <fieldset className="mt-fieldset" disabled={!canEdit}>
        <div className="pf-form">
          <F label="Name"><input className="fld" autoFocus={!tpl} value={d.name} onChange={(e) => setD((c) => ({ ...c, name: e.target.value }))} /></F>
          <F label="Kind of document">
            <select className="fld" value={d.kind} disabled={Boolean(tpl)} onChange={(e) => setD((c) => ({ ...c, kind: e.target.value as DocTemplateKind }))}>
              {DOC_TEMPLATE_KINDS.map((k) => <option key={k} value={k}>{DOC_TEMPLATE_KIND_LABELS[k]}</option>)}
            </select>
          </F>
          <F label="Company name on the document" wide hint="Leave empty to keep the name the document already shows."><input className="fld" value={d.company_name} onChange={(e) => setD((c) => ({ ...c, company_name: e.target.value }))} /></F>
          <F label="Letterhead" wide hint="Address, phone, email, licence numbers — printed under the name."><textarea className="fld" rows={3} value={d.company_details} onChange={(e) => setD((c) => ({ ...c, company_details: e.target.value }))} /></F>
          <F label="Terms" wide hint="Printed after the totals."><textarea className="fld" rows={5} value={d.terms} onChange={(e) => setD((c) => ({ ...c, terms: e.target.value }))} /></F>
          <F label="Footer" wide><input className="fld" value={d.footer} onChange={(e) => setD((c) => ({ ...c, footer: e.target.value }))} /></F>
          <label className="tmap-check pf-field"><input type="checkbox" checked={d.is_default} onChange={(e) => setD((c) => ({ ...c, is_default: e.target.checked }))} /><span>Use it — the one template printed for this kind of document</span></label>
        </div>
      </fieldset>
    </Sheet>
  );
}

/** "Apply a rate" beside a hand-typed tax amount: picks a rate and hands back
 *  the tax on `base`. Renders nothing when no rate exists. */
export function TaxRatePicker({ base, onPick }: { base: number; onPick: (amount: number, label: string) => void }) {
  const q = useQuery({ queryKey: ['tax-rates'], queryFn: async () => (await import('../../api/client')).getTaxRates(), staleTime: 60_000, retry: false });
  const rates = q.data?.tax_rates ?? [];
  if (rates.length === 0) return null;
  return (
    <select className="fld tax-pick" value="" aria-label="Apply a tax rate" title="Works out the tax on the total at a rate from Admin › Settings and writes it in the field"
      onChange={(e) => { const r = rates.find((x) => x.id === e.target.value); if (r) onPick(Math.round(base * r.rate) / 100, `${r.name} · ${r.rate}%`); }}>
      <option value="">Apply a rate…</option>
      {rates.map((r) => <option key={r.id} value={r.id}>{r.name} · {r.rate}%</option>)}
    </select>
  );
}

/* 0066 · Vendors, the rest — the staff-side screens.
 *
 *   VendorQualificationsPanel   on a vendor's record: skills, inductions and
 *                               the consumables they used on jobs
 *   VendorPortalPanel           on a vendor's record: their portal and
 *                               onboarding links, and the form they sent in
 *   VendorPerformanceTab        the Performance view of the Vendors page
 *   VendorCataloguesCards       Admin › Vendors & map: the skill and
 *                               consumable lists, the invoicing rules, and
 *                               the dispatch switch
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BILL_RULE_LABELS,
  ONBOARDING_LABELS,
  PORTAL_PURPOSE_LABELS,
  SKILL_LEVELS,
  SKILL_LEVEL_LABELS,
  slaRate,
  type BillRules,
  type OnboardingPayload,
  type PortalPurpose,
  type SkillLevel,
  type VendorCatalogues,
  type VendorInduction,
  type VendorPortalAdmin,
  type VendorQualifications,
} from '@theone/shared';
import {
  createVendorPortalLink,
  decideVendorOnboarding,
  getVendorCatalogues,
  getVendorPerformance,
  getVendorPortalAdmin,
  getVendorQualifications,
  removeVendorInduction,
  removeVendorSkill,
  revokeVendorPortalLink,
  saveBillRules,
  saveConsumableDef,
  saveDispatchSettings,
  saveSkillDef,
  saveVendorInduction,
  saveVendorSkill,
} from '../../api/client';
import { Icon } from '../Icon';
import { F, Sheet, dayText, errText, numOrNull, stampText, usd } from '../ui/Sheet';

// ═══ Skills, inductions, consumables on a vendor ═════════════════════════════

const INDUCTION_TONE: Record<VendorInduction['state'], string> = { pending: ' chip-warn', current: ' chip-ok', expired: ' chip-danger' };
const INDUCTION_LABEL: Record<VendorInduction['state'], string> = { pending: 'Not done yet', current: 'Current', expired: 'Expired' };

export function VendorQualificationsPanel({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const key = ['vendor-qualifications', vendorId];
  const q = useQuery({ queryKey: key, queryFn: () => getVendorQualifications(vendorId) });
  const [skill, setSkill] = useState({ skill: '', level: 'skilled' as SkillLevel, certified_until: '' });
  const [induction, setInduction] = useState<{ id: string | null; title: string; client: string; completed_on: string; expires_on: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = (res: VendorQualifications) => { qc.setQueryData(key, res); setError(null); };
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const addSkill = useMutation({
    mutationFn: () => saveVendorSkill(vendorId, null, { skill: skill.skill.trim(), level: skill.level, certified_until: skill.certified_until || null }),
    onSuccess: (res) => { done(res); setSkill({ skill: '', level: 'skilled', certified_until: '' }); },
    onError: fail('Could not add the skill.'),
  });
  const dropSkill = useMutation({ mutationFn: (id: string) => removeVendorSkill(vendorId, id), onSuccess: done, onError: fail('Could not remove the skill.') });
  const saveInd = useMutation({
    mutationFn: () => saveVendorInduction(vendorId, induction!.id, { title: induction!.title.trim(), client: induction!.client.trim() || null, completed_on: induction!.completed_on || null, expires_on: induction!.expires_on || null }),
    onSuccess: (res) => { done(res); setInduction(null); },
  });
  const dropInd = useMutation({ mutationFn: (id: string) => removeVendorInduction(vendorId, id), onSuccess: done, onError: fail('Could not remove the induction.') });
  const d = q.data;
  if (!d) return null;
  const edit = d.can.edit;

  return (
    <>
      <section className="card">
        <div className="card-head"><h2 className="card-title grow">Skills</h2><span className="card-meta">{d.skills.length}</span></div>
        {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
        {d.skills.length === 0 ? <div className="empty-flat">No skills recorded.</div> : (
          <ul className="vx-list">
            {d.skills.map((s) => (
              <li key={s.id}>
                <span className="grow"><b>{s.skill}</b><small>{SKILL_LEVEL_LABELS[s.level]}{s.certified_until ? ` · certified until ${dayText(s.certified_until)}` : ''}</small></span>
                {s.expired && <span className="chip chip-sm chip-danger">Certificate expired</span>}
                {edit && <button type="button" className="icon-btn" aria-label={`Remove ${s.skill}`} disabled={dropSkill.isPending} onClick={() => dropSkill.mutate(s.id)}><Icon name="x" size={12} /></button>}
              </li>
            ))}
          </ul>
        )}
        {edit && (
          <form className="rec-add mt-add" onSubmit={(e) => { e.preventDefault(); if (skill.skill.trim()) addSkill.mutate(); }}>
            <input className="fld" list="vx-skills" placeholder="Add a skill" value={skill.skill} onChange={(e) => setSkill((c) => ({ ...c, skill: e.target.value }))} aria-label="Skill" />
            <datalist id="vx-skills">{d.skill_list.map((s) => <option key={s.name} value={s.name}>{s.trade ?? ''}</option>)}</datalist>
            <select className="fld" value={skill.level} onChange={(e) => setSkill((c) => ({ ...c, level: e.target.value as SkillLevel }))} aria-label="Level">
              {SKILL_LEVELS.map((l) => <option key={l} value={l}>{SKILL_LEVEL_LABELS[l]}</option>)}
            </select>
            <input className="fld" type="date" value={skill.certified_until} onChange={(e) => setSkill((c) => ({ ...c, certified_until: e.target.value }))} aria-label="Certified until" title="Certified until (optional)" />
            <button type="submit" className="btn btn-sm" disabled={!skill.skill.trim() || addSkill.isPending}>Add</button>
          </form>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Inductions</h2>
          {edit && <button type="button" className="btn btn-sm is-ghost" onClick={() => setInduction({ id: null, title: '', client: '', completed_on: '', expires_on: '' })}><Icon name="plus" size={12} /> Add</button>}
        </div>
        {d.inductions.length === 0 ? <div className="empty-flat">No inductions recorded. An induction is the safety or site briefing a client asks for before a vendor works for them.</div> : (
          <ul className="vx-list">
            {d.inductions.map((i) => (
              <li key={i.id}>
                <span className="grow">
                  <b>{i.title}</b>
                  <small>{[i.client, i.completed_on ? `done ${dayText(i.completed_on)}` : null, i.expires_on ? `runs out ${dayText(i.expires_on)}` : null].filter(Boolean).join(' · ')}</small>
                </span>
                <span className={`chip chip-sm${INDUCTION_TONE[i.state]}`}>{INDUCTION_LABEL[i.state]}</span>
                {edit && <button type="button" className="icon-btn" aria-label={`Change ${i.title}`} onClick={() => setInduction({ id: i.id, title: i.title, client: i.client ?? '', completed_on: i.completed_on ?? '', expires_on: i.expires_on ?? '' })}><Icon name="pencil" size={12} /></button>}
                {edit && <button type="button" className="icon-btn" aria-label={`Remove ${i.title}`} disabled={dropInd.isPending} onClick={() => dropInd.mutate(i.id)}><Icon name="x" size={12} /></button>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {d.consumables.length > 0 && (
        <section className="card">
          <div className="card-head"><h2 className="card-title grow">Consumables used</h2><span className="card-meta">latest {d.consumables.length}</span></div>
          <ul className="vx-list">
            {d.consumables.map((c, i) => (
              <li key={i}>
                <span className="grow"><b>{c.qty} {c.unit} · {c.name}</b><small><Link to={`/work-orders/${encodeURIComponent(c.wo_number)}?tab=tasks`}>{c.wo_number}</Link> · {dayText(c.added_at)}</small></span>
                {c.unit_cost !== null && <span className="num">{usd(c.qty * c.unit_cost)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {induction && (
        <Sheet title={induction.id ? 'Change an induction' : 'Add an induction'} icon="check-circle" onClose={() => setInduction(null)} problem={saveInd.isError ? errText(saveInd.error, 'Could not save the induction.') : null}
          footer={<>
            <button type="button" className="btn" onClick={() => setInduction(null)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={!induction.title.trim() || saveInd.isPending} onClick={() => saveInd.mutate()}>{saveInd.isPending ? 'Saving…' : 'Save'}</button>
          </>}>
          <div className="pf-form">
            <F label="Induction" wide><input className="fld" autoFocus value={induction.title} placeholder="e.g. Site safety briefing" onChange={(e) => setInduction((c) => c && { ...c, title: e.target.value })} /></F>
            <F label="For client" wide hint="Leave empty when it is not tied to one client.">
              <input className="fld" list="vx-clients" value={induction.client} onChange={(e) => setInduction((c) => c && { ...c, client: e.target.value })} />
              <datalist id="vx-clients">{d.clients.map((c) => <option key={c} value={c} />)}</datalist>
            </F>
            <F label="Completed on" hint="Empty = not done yet."><input className="fld" type="date" value={induction.completed_on} onChange={(e) => setInduction((c) => c && { ...c, completed_on: e.target.value })} /></F>
            <F label="Runs out on"><input className="fld" type="date" value={induction.expires_on} onChange={(e) => setInduction((c) => c && { ...c, expires_on: e.target.value })} /></F>
          </div>
        </Sheet>
      )}
    </>
  );
}

// ═══ Portal links and the onboarding form ════════════════════════════════════

const payloadText = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v));

export function VendorPortalPanel({ vendorId }: { vendorId: string }) {
  const qc = useQueryClient();
  const key = ['vendor-portal', vendorId];
  const q = useQuery({ queryKey: key, queryFn: () => getVendorPortalAdmin(vendorId) });
  const [fresh, setFresh] = useState<{ url: string; purpose: PortalPurpose } | null>(null);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const done = (res: VendorPortalAdmin) => { qc.setQueryData(key, res); setError(null); };
  const fail = (fallback: string) => (e: unknown) => setError(errText(e, fallback));
  const make = useMutation({
    mutationFn: (purpose: PortalPurpose) => createVendorPortalLink(vendorId, purpose),
    onSuccess: (res, purpose) => { const { url, ...rest } = res; done(rest); setFresh({ url, purpose }); setCopied(false); },
    onError: fail('Could not make the link.'),
  });
  const revoke = useMutation({ mutationFn: (id: string) => revokeVendorPortalLink(vendorId, id), onSuccess: (res) => { done(res); setFresh(null); }, onError: fail('Could not revoke the link.') });
  const decide = useMutation({
    mutationFn: (x: { id: string; decision: 'accept' | 'reject' }) => decideVendorOnboarding(vendorId, x.id, x.decision, note.trim() || null),
    onSuccess: (res) => { done(res); setNote(''); void qc.invalidateQueries({ queryKey: ['vendor'] }); void qc.invalidateQueries({ queryKey: ['vendors'] }); },
    onError: fail('Could not decide the form.'),
  });
  const d = q.data;
  if (!d || !d.can.view) return null;
  const waiting = d.submissions.find((s) => s.status === 'submitted');
  const live = d.links.filter((l) => l.live);

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title grow">Portal</h2>
        {d.can.edit && (
          <>
            <button type="button" className="btn btn-sm is-ghost" disabled={make.isPending} onClick={() => make.mutate('onboarding')} title="A link to a form the vendor fills in about themselves">Onboarding link</button>
            <button type="button" className="btn btn-sm is-ghost" disabled={make.isPending} onClick={() => make.mutate('portal')} title="A link where the vendor sees their jobs, answers offers and gives an ETA">Job portal link</button>
          </>
        )}
      </div>
      {error && <p className="snooze-err rec-err" role="alert"><Icon name="alert-circle" size={12} />{error}</p>}
      {fresh && (
        <div className="vx-fresh">
          <p><b>{PORTAL_PURPOSE_LABELS[fresh.purpose]} link.</b> Copy it now and send it to the vendor yourself: it is shown only this once, and nothing is emailed.</p>
          <div className="mt-inline">
            <input className="fld mono" readOnly value={fresh.url} onFocus={(e) => e.target.select()} aria-label="Portal link" />
            <button type="button" className="btn btn-sm" onClick={() => { void navigator.clipboard?.writeText(fresh.url).then(() => setCopied(true)); }}>{copied ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
      )}
      {waiting && (
        <div className="vx-form">
          <h3>Onboarding form sent {stampText(waiting.submitted_at)}</h3>
          <dl>
            {(Object.keys(waiting.payload) as (keyof OnboardingPayload)[]).filter((k) => { const v = waiting.payload[k]; return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0); }).map((k) => (
              <div key={k}><dt>{ONBOARDING_LABELS[k] ?? k}</dt><dd>{payloadText(waiting.payload[k])}</dd></div>
            ))}
          </dl>
          {d.can.edit && (
            <>
              <input className="fld" placeholder="Note (needed to send it back)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" />
              <div className="mt-inline">
                <button type="button" className="btn btn-sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: waiting.id, decision: 'accept' })} title="Writes what they filled in onto this record. Empty answers change nothing.">Accept and fill the record</button>
                <button type="button" className="btn btn-sm is-ghost" disabled={decide.isPending || !note.trim()} onClick={() => decide.mutate({ id: waiting.id, decision: 'reject' })}>Send back</button>
              </div>
            </>
          )}
        </div>
      )}
      {d.links.length === 0 && !waiting ? (
        <div className="empty-flat">No links yet. A link lets this vendor fill in their own details, or see the jobs they hold — without an account.</div>
      ) : (
        <ul className="vx-list">
          {d.links.slice(0, 8).map((l) => (
            <li key={l.id} className={l.live ? undefined : 'is-off'}>
              <span className="grow">
                <b>{PORTAL_PURPOSE_LABELS[l.purpose]}</b>
                <small>
                  made {dayText(l.created_at)}{l.created_by ? ` by ${l.created_by.name}` : ''}
                  {l.revoked_at ? ` · revoked ${dayText(l.revoked_at)}` : l.expires_at ? ` · ${l.live ? 'runs out' : 'ran out'} ${dayText(l.expires_at)}` : ''}
                  {l.use_count > 0 ? ` · opened ${l.use_count}×, last ${stampText(l.last_used_at)}` : ' · never opened'}
                </small>
              </span>
              {l.live ? <span className="chip chip-sm chip-ok">Live</span> : <span className="chip chip-sm chip-outline">Off</span>}
              {l.live && d.can.edit && <button type="button" className="link-btn" disabled={revoke.isPending} onClick={() => revoke.mutate(l.id)}>Revoke</button>}
            </li>
          ))}
        </ul>
      )}
      {live.length > 1 && <p className="hint mt-hint">{live.length} links are live. Revoke the ones no longer needed.</p>}
    </section>
  );
}

// ═══ Performance ═════════════════════════════════════════════════════════════

const isoDay = (d: Date) => d.toLocaleDateString('en-CA');

export function VendorPerformanceTab() {
  const [range, setRange] = useState(() => { const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 89); return { from: isoDay(from), to: isoDay(to) }; });
  const q = useQuery({ queryKey: ['vendor-performance', range], queryFn: () => getVendorPerformance(range), placeholderData: keepPreviousData });
  const d = q.data;
  const rate = d ? slaRate(d.totals.sla_met, d.totals.sla_missed) : null;
  return (
    <>
      <div className="vend-filters">
        <label className="mt-range">Work orders received from <input className="fld" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))} /></label>
        <label className="mt-range">to <input className="fld" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))} /></label>
      </div>
      <div className="rec-sum">
        <div><span>Jobs</span><b>{d?.totals.jobs ?? 0}</b><small>{d?.totals.completed ?? 0} completed</small></div>
        <div className={rate !== null && rate < 80 ? 'is-neg' : undefined}><span>SLA met</span><b>{rate === null ? '—' : `${rate}%`}</b><small>{d ? `${d.totals.sla_met} met · ${d.totals.sla_missed} missed` : ''}</small></div>
        <div className={(d?.totals.recalls ?? 0) > 0 ? 'is-neg' : undefined}><span>Recalls</span><b>{d?.totals.recalls ?? 0}</b><small>Work orders tagged Recall</small></div>
        <div><span>Billed</span><b>{usd(d?.totals.billed ?? 0)}</b><small>Vendor bills on those jobs</small></div>
      </div>
      {q.isError ? <div className="empty-flat">{errText(q.error, 'Could not load the performance figures.')}</div> : (
        <div className="vend-wrap">
          <table className="vend-table mt-table">
            <thead>
              <tr><th>Vendor</th><th>Trade</th><th className="num">Jobs</th><th className="num">Completed</th><th className="num">SLA met</th><th className="num">Missed</th><th className="num">Recalls</th><th className="num">Temp. fixes</th><th className="num">Offers taken</th><th className="num">Response</th><th className="num">Billed</th><th className="num">Bill checks</th></tr>
            </thead>
            <tbody>
              {(d?.rows ?? []).map((r) => {
                const sla = slaRate(r.sla_met, r.sla_missed);
                return (
                  <tr key={r.vendor_id}>
                    <td className="vend-name"><Link to={`/vendors/${r.vendor_id}`}>{r.name}</Link>{r.kind !== 'vendor' && <span><span className="chip chip-sm chip-outline">Technician</span></span>}</td>
                    <td>{r.primary_trade ?? '—'}</td>
                    <td className="num">{r.jobs}</td>
                    <td className="num">{r.completed}</td>
                    <td className="num">{sla === null ? '—' : <b className={sla < 80 ? 'rec-neg' : undefined}>{sla}%</b>}</td>
                    <td className="num">{r.sla_missed || '—'}</td>
                    <td className="num">{r.recalls ? <b className="rec-neg">{r.recalls}</b> : '—'}</td>
                    <td className="num">{r.temporary_fixes || '—'}</td>
                    <td className="num">{r.offers ? `${r.offers_accepted} of ${r.offers}` : '—'}</td>
                    <td className="num">{r.avg_response_hours === null ? '—' : `${r.avg_response_hours}h`}</td>
                    <td className="num">{r.billed ? usd(r.billed) : '—'}</td>
                    <td className="num">{r.bill_warnings || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {d && d.rows.length === 0 && <div className="empty-flat">No vendor was responsible for, or hired onto, a work order received in these days.</div>}
        </div>
      )}
      <p className="hint mt-hint">A job counts for a vendor when they are its responsible vendor or a technician hired onto it. SLA is the completion date against the work order’s SLA due date; response is hire to first check-in.</p>
    </>
  );
}

// ═══ Admin › Vendors & map ═══════════════════════════════════════════════════

export function VendorCataloguesCards({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const key = ['vendor-catalogues'];
  const q = useQuery({ queryKey: key, queryFn: getVendorCatalogues });
  const [error, setError] = useState<string | null>(null);
  const [skill, setSkill] = useState('');
  const [cons, setCons] = useState({ name: '', unit: 'each', cost: '' });
  const done = (res: VendorCatalogues) => { qc.setQueryData(key, res); setError(null); };
  const fail = (e: unknown) => setError(errText(e, 'Could not save.'));
  const rules = useMutation({ mutationFn: (patch: Partial<BillRules>) => saveBillRules(patch), onSuccess: done, onError: fail });
  const dispatch = useMutation({ mutationFn: (patch: { enabled?: boolean; auto_start?: boolean; hours?: number }) => saveDispatchSettings(patch), onSuccess: done, onError: fail });
  const skillDef = useMutation({ mutationFn: (x: { id: string | null; name?: string; is_active?: boolean }) => saveSkillDef(x.id, { name: x.name, is_active: x.is_active }), onSuccess: (res) => { done(res); setSkill(''); }, onError: fail });
  const consDef = useMutation({
    mutationFn: (x: { id: string | null; name?: string; unit?: string; unit_cost?: number | null; is_active?: boolean }) => saveConsumableDef(x.id, { name: x.name, unit: x.unit, unit_cost: x.unit_cost, is_active: x.is_active }),
    onSuccess: (res) => { done(res); setCons({ name: '', unit: 'each', cost: '' }); },
    onError: fail,
  });
  const d = q.data;
  if (!d) return null;
  const edit = canEdit && d.can.edit;

  return (
    <>
      {error && <div className="callout"><Icon name="alert" size={14} /><span>{error}</span></div>}
      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Dispatch offers</h2>
          <span className={`chip chip-sm${d.dispatch.enabled ? ' chip-ok' : ' chip-outline'}`}>{d.dispatch.enabled ? 'Switched on' : 'Switched off'}</span>
        </div>
        <p className="hint mt-hint">When on, a dispatcher can offer a work order to the preferred vendors of its client and trade, one after another. A vendor who declines, or does not answer in time, is passed over for the next. It keeps to the preferred vendors listed above, so a client or trade with none is never touched, unless “Dispatch offers may go to automatic picks” is ticked under Suggested vendors. Off, nothing changes: vendors are assigned by hand as before.</p>
        <div className="vx-settings">
          <label className="tmap-check"><input type="checkbox" checked={d.dispatch.enabled} disabled={!edit || dispatch.isPending} onChange={(e) => dispatch.mutate({ enabled: e.target.checked })} /><span>Allow dispatch offers</span></label>
          <label className="tmap-check"><input type="checkbox" checked={d.dispatch.auto_start} disabled={!edit || !d.dispatch.enabled || dispatch.isPending} onChange={(e) => dispatch.mutate({ auto_start: e.target.checked })} /><span>Start by itself when a work order is added with no vendor</span></label>
          <label className="mt-range">Hours a vendor has to answer
            <input className="fld mt-qty" type="number" min="1" max="168" defaultValue={d.dispatch.hours} disabled={!edit} key={d.dispatch.hours}
              onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n <= 168 && n !== d.dispatch.hours) dispatch.mutate({ hours: n }); else e.target.value = String(d.dispatch.hours); }} />
          </label>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title grow">Vendor invoicing rules</h2></div>
        <p className="hint mt-hint">Each rule that a vendor bill trips shows as a warning on the bill. A warning never blocks approving or paying it.</p>
        <ul className="vx-list">
          {BILL_RULE_LABELS.map((r) => (
            <li key={r.key}>
              <span className="grow"><b>{r.label}</b><small>{r.hint}</small></span>
              {r.kind === 'bool' ? (
                <label className="tmap-check"><input type="checkbox" checked={d.bill_rules[r.key] as boolean} disabled={!edit || rules.isPending} onChange={(e) => rules.mutate({ [r.key]: e.target.checked })} /><span>{d.bill_rules[r.key] ? 'On' : 'Off'}</span></label>
              ) : (
                <label className="mt-range">{r.kind === 'days' ? 'days' : '$'}
                  <input className="fld mt-qty" type="number" min="0" defaultValue={d.bill_rules[r.key] as number} disabled={!edit} key={String(d.bill_rules[r.key])}
                    onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (Number.isFinite(n) && n >= 0 && n !== d.bill_rules[r.key]) rules.mutate({ [r.key]: n }); else e.target.value = String(d.bill_rules[r.key]); }} />
                </label>
              )}
            </li>
          ))}
        </ul>
      </section>

      <div className="vadm-lists">
        <section className="card">
          <div className="card-head"><h2 className="card-title grow">Skills</h2><span className="card-meta">{d.skills.filter((s) => s.is_active).length}</span></div>
          <p className="hint mt-hint">What a vendor’s record offers under Skills.</p>
          <ul className="vx-list">
            {d.skills.map((s) => (
              <li key={s.id} className={s.is_active ? undefined : 'is-off'}>
                <span className="grow"><b>{s.name}</b><small>{[s.trade, s.used ? `${s.used} ${s.used === 1 ? 'vendor' : 'vendors'}` : null].filter(Boolean).join(' · ')}</small></span>
                {edit && <button type="button" className="link-btn" disabled={skillDef.isPending} onClick={() => skillDef.mutate({ id: s.id, is_active: !s.is_active })}>{s.is_active ? 'Switch off' : 'Switch on'}</button>}
              </li>
            ))}
          </ul>
          {edit && (
            <form className="rec-add" onSubmit={(e) => { e.preventDefault(); if (skill.trim()) skillDef.mutate({ id: null, name: skill.trim() }); }}>
              <input className="fld" placeholder="Add a skill" value={skill} onChange={(e) => setSkill(e.target.value)} aria-label="New skill" />
              <button type="submit" className="btn btn-sm" disabled={!skill.trim() || skillDef.isPending}>Add</button>
            </form>
          )}
        </section>
        <section className="card">
          <div className="card-head"><h2 className="card-title grow">Consumables</h2><span className="card-meta">{d.consumables.filter((s) => s.is_active).length}</span></div>
          <p className="hint mt-hint">The stock a job can use up, offered on a work order’s Checklist tab.</p>
          <ul className="vx-list">
            {d.consumables.map((c) => (
              <li key={c.id} className={c.is_active ? undefined : 'is-off'}>
                <span className="grow"><b>{c.name}</b><small>{[c.unit_cost !== null ? `${usd(c.unit_cost)} / ${c.unit}` : c.unit, c.used ? `used ${c.used}×` : null].filter(Boolean).join(' · ')}</small></span>
                {edit && <button type="button" className="link-btn" disabled={consDef.isPending} onClick={() => consDef.mutate({ id: c.id, is_active: !c.is_active })}>{c.is_active ? 'Switch off' : 'Switch on'}</button>}
              </li>
            ))}
          </ul>
          {edit && (
            <form className="rec-add mt-add" onSubmit={(e) => { e.preventDefault(); if (cons.name.trim()) consDef.mutate({ id: null, name: cons.name.trim(), unit: cons.unit.trim() || 'each', unit_cost: numOrNull(cons.cost) }); }}>
              <input className="fld" placeholder="Add a consumable" value={cons.name} onChange={(e) => setCons((c) => ({ ...c, name: e.target.value }))} aria-label="New consumable" />
              <input className="fld mt-qty" placeholder="unit" value={cons.unit} onChange={(e) => setCons((c) => ({ ...c, unit: e.target.value }))} aria-label="Unit" />
              <input className="fld mt-qty" type="number" min="0" step="0.01" placeholder="cost" value={cons.cost} onChange={(e) => setCons((c) => ({ ...c, cost: e.target.value }))} aria-label="Unit cost" />
              <button type="submit" className="btn btn-sm" disabled={!cons.name.trim() || consDef.isPending}>Add</button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

/* "Add work order" — raising one by hand (0041, extended in 0063).
 *
 * The form is not written here. It is read from the API, which reads it from
 * field_def.create_mode, which an admin sets in Admin › Custom fields — so a
 * field added there appears here with no deploy. This file only decides how a
 * field is DRAWN (from the same catalogue the detail page edits with) and what
 * the duplicate check says.
 *
 * Two kinds of duplicate, deliberately different:
 *   the WO #      the work order's identity. Taken = Create is refused, trash
 *                 included, with a link to the one holding it. Matching
 *                 ignores case and punctuation, so "wo 12345" and "WO-12345"
 *                 are one number.
 *   a near match  something already open that looks like this job: the same
 *                 asset, the same site, or the same store and trade inside 30
 *                 days. A warning with links, never a block — a store can
 *                 break twice.
 *
 * 0063 adds three things on top of the configured fields:
 *   the site and the asset   picked from the portfolio. The site fills in
 *                 client, store, address, city, state and ZIP (each only
 *                 while it is empty or still holds what the last site put
 *                 there) and the new work order is linked to both records.
 *   sub-category  narrows the trade; its suggestions follow the trade picked.
 *   templates     a saved set of values that pre-fills the form.
 *
 * Creation stays lighter than assignment: rule 11.1.1's 13 fields are still
 * demanded before this work order can be assigned or accepted, so raising one
 * from a phone call with only the number is allowed and safe.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  WO_CREATE_MORE_SECTION,
  WO_CREATE_SECTIONS,
  WO_NEAR_DUPLICATE_DAYS,
  WO_SITE_AUTOFILL,
  WO_SUBCATEGORY_KEY,
  WO_TRADE_KEY,
  applyFormLayout,
  describeMissing,
  formatBytes,
  pickFormLayout,
  subcategoriesFor,
  woCreateMissing,
  type SiteDetail,
  type WoCreateField,
  type WoCreateTemplate,
  type WoDuplicateHit,
} from '@theone/shared';
import {
  ApiRequestError,
  checkWoNumber,
  createWorkOrder,
  deleteWoCreateTemplate,
  getPrincipals,
  getSite,
  getWoCreateForm,
  getWoCreateTemplates,
  saveWoCreateTemplate,
  uploadAttachment,
  type WoFieldDescriptor,
} from '../../../api/client';
import { useAuth } from '../../../auth/AuthProvider';
import { prepareFile } from '../../../lib/upload';
import { Icon } from '../../Icon';
import { AssetStatusChip, ConditionChip, SitePicker, WarrantyChip } from '../../portfolio/PortfolioParts';
import { useWoCatalogue } from '../fieldEdit';

interface CreateWorkOrderDialogProps {
  onClose: () => void;
}

type Values = Record<string, string>;

/** The bag key of the Assignee seat — drawn as a people picker, like intake. */
const ASSIGNEE_KEY = 'Assignee';

/** A datetime-local input wants 'YYYY-MM-DDTHH:mm'; a date input wants ten
    characters. Anything else goes through as typed. */
function valueForApi(raw: string, d: WoFieldDescriptor | undefined, type?: string): unknown {
  const s = raw.trim();
  if (s === '') return undefined;
  if (type === 'checkbox') return s === 'true' ? true : undefined;
  if (d?.type === 'money' || d?.type === 'number') {
    const n = Number(s.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : s;
  }
  if (d?.type === 'datetime') return new Date(s).toISOString();
  return s;
}

export function CreateWorkOrderDialog({ onClose }: CreateWorkOrderDialogProps) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const catalogue = useWoCatalogue();
  const numberRef = useRef<HTMLInputElement>(null);
  const seesSites = can('sites', 'view');
  const seesAssets = can('assets', 'view');

  const formQuery = useQuery({ queryKey: ['wo-create-form'], queryFn: getWoCreateForm, staleTime: 60_000 });
  const people = useQuery({ queryKey: ['principals'], queryFn: getPrincipals, staleTime: 5 * 60 * 1000 });
  const templates = useQuery({ queryKey: ['wo-create-templates'], queryFn: getWoCreateTemplates, staleTime: 60_000 });

  const [woNumber, setWoNumber] = useState('');
  const [values, setValues] = useState<Values>({});
  const [error, setError] = useState<string | null>(null);
  const [flagged, setFlagged] = useState<Set<string>>(new Set());
  // 0063 · the site and the asset, and what the site last filled in.
  const [site, setSite] = useState<{ id: string; name: string } | null>(null);
  const [assetId, setAssetId] = useState('');
  const filled = useRef<Values>({});
  const [saving, setSaving] = useState<{ name: string; shared: boolean } | null>(null);
  const [templateNote, setTemplateNote] = useState<string | null>(null);

  useEffect(() => {
    numberRef.current?.focus();
  }, []);

  // 0064 · the layout for this client and trade is laid over the configured
  // form (a field it turns off is gone, one it requires is required); the API
  // picks the same layout again when it checks the work order.
  const configured = useMemo(() => formQuery.data ?? { fields: [] as WoCreateField[] }, [formQuery.data]);
  const layout = useMemo(
    () => pickFormLayout(configured.layouts ?? [], values['Client'], values[WO_TRADE_KEY]),
    [configured.layouts, values],
  );
  const form = useMemo(() => applyFormLayout(configured, layout), [configured, layout]);
  // 0064 · photos and files chosen here go up as soon as the work order exists.
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const onForm = useMemo(() => new Set(form.fields.map((f) => f.key)), [form.fields]);

  const set = (key: string, v: string) => {
    setValues((cur) => ({ ...cur, [key]: v }));
    setFlagged((f) => {
      if (!f.has(key)) return f;
      const next = new Set(f);
      next.delete(key);
      return next;
    });
  };

  // ── The site and the asset ─────────────────────────────────────────────────
  const siteQuery = useQuery({ queryKey: ['site', site?.id], queryFn: () => getSite(site!.id), enabled: Boolean(site) });
  const siteDetail: SiteDetail | null = site ? (siteQuery.data?.site ?? null) : null;
  // When a site's details arrive, it fills in what it knows — but never over
  // something a person typed: a field is touched only while it is empty or
  // still holds what the previous site put there.
  useEffect(() => {
    if (!siteDetail) return;
    setValues((cur) => {
      const next = { ...cur };
      for (const { key, from } of WO_SITE_AUTOFILL) {
        if (!onForm.has(key)) continue;
        const incoming = (siteDetail[from] ?? '').toString().trim();
        const current = (cur[key] ?? '').trim();
        if (incoming === '' || (current !== '' && current !== (filled.current[key] ?? ''))) continue;
        next[key] = incoming;
        filled.current[key] = incoming;
      }
      return next;
    });
  }, [siteDetail, onForm]);
  const pickSite = (s: { id: string; name: string } | null) => {
    setSite(s);
    setAssetId('');
    if (!s) {
      // Unpicking takes back only what the site itself had filled in.
      setValues((cur) => {
        const next = { ...cur };
        for (const [k, v] of Object.entries(filled.current)) if ((cur[k] ?? '').trim() === v) next[k] = '';
        return next;
      });
      filled.current = {};
    }
  };
  const assets = siteDetail?.asset_list.filter((a) => a.status !== 'retired') ?? [];
  const asset = assets.find((a) => a.id === assetId) ?? null;

  // ── The duplicate check ────────────────────────────────────────────────────
  // Debounced, and it carries the store, trade, site and asset so the
  // near-match warning appears as soon as there is something to match on.
  const [debounced, setDebounced] = useState({ wo_number: '', store: '', trade: '', site_id: '', asset_id: '' });
  const store = values['Store'] ?? '';
  const trade = values[WO_TRADE_KEY] ?? '';
  const siteId = site?.id ?? '';
  useEffect(() => {
    const t = setTimeout(() => setDebounced({ wo_number: woNumber.trim(), store, trade, site_id: siteId, asset_id: assetId }), 300);
    return () => clearTimeout(t);
  }, [woNumber, store, trade, siteId, assetId]);

  const check = useQuery({
    queryKey: ['wo-number-check', debounced],
    queryFn: () => checkWoNumber(debounced),
    enabled: debounced.wo_number.length > 0 || (debounced.store !== '' && debounced.trade !== '') || debounced.site_id !== '' || debounced.asset_id !== '',
  });

  const taken = check.data?.taken === true && debounced.wo_number === woNumber.trim();
  const near = check.data?.near ?? [];

  // ── What is still missing ──────────────────────────────────────────────────
  const bag = useMemo(() => {
    const out: Record<string, unknown> = {};
    for (const f of form.fields) {
      const v = valueForApi(values[f.key] ?? '', catalogue.get(`fields.${f.key}`), f.type);
      if (v !== undefined) out[f.key] = v;
    }
    return out;
  }, [form.fields, values, catalogue]);

  const missing = useMemo(() => woCreateMissing(form, bag, woNumber), [form, bag, woNumber]);

  const create = useMutation({
    mutationFn: () => createWorkOrder({ wo_number: woNumber.trim(), fields: bag, site_id: site?.id ?? null, asset_id: assetId || null }),
    onSuccess: async (res) => {
      void qc.invalidateQueries({ queryKey: ['work-orders'] });
      void qc.invalidateQueries({ queryKey: ['sites-meta'] });
      // The work order exists now, whatever happens to its files: each one
      // goes up in turn, and one that fails is named on the way out rather
      // than holding the others back.
      const failed: string[] = [];
      for (let i = 0; i < files.length; i++) {
        setUploading(`Uploading ${i + 1} of ${files.length}…`);
        try {
          const prepared = await prepareFile(files[i]);
          await uploadAttachment(res.task_id, { file_name: prepared.file_name, content_type: prepared.content_type, data: prepared.data });
        } catch {
          failed.push(files[i].name);
        }
      }
      setUploading(null);
      const to = `/work-orders/${encodeURIComponent(res.wo_number)}`;
      if (failed.length > 0) {
        window.alert(`${res.wo_number} was created, but ${failed.length === 1 ? 'one file' : `${failed.length} files`} could not be uploaded: ${failed.join(', ')}. Add ${failed.length === 1 ? 'it' : 'them'} from the Overview tab.`);
        navigate(`${to}?tab=overview`);
      } else {
        navigate(files.length > 0 ? `${to}?tab=overview` : to);
      }
    },
    onError: (err: unknown) => {
      if (err instanceof ApiRequestError) {
        setError(err.message);
        const details = (err as { details?: { missing?: unknown } }).details;
        const list = Array.isArray(details?.missing) ? (details?.missing as string[]) : [];
        const keys = new Set<string>();
        for (const f of form.fields) if (list.includes(f.label)) keys.add(f.key);
        setFlagged(keys);
      } else {
        setError('Could not create the work order');
      }
    },
  });

  // ── Templates ──────────────────────────────────────────────────────────────
  const applyTemplate = (t: WoCreateTemplate) => {
    const next: Values = {};
    for (const [k, v] of Object.entries(t.fields)) {
      if (!onForm.has(k) || v === null || v === undefined) continue;
      next[k] = typeof v === 'boolean' ? (v ? 'true' : '') : String(v);
    }
    // A template lays its values over the form; what it does not name stays.
    setValues((cur) => ({ ...cur, ...next }));
    if (t.site && seesSites) {
      setSite(t.site);
      setAssetId('');
    }
    setTemplateNote(`Filled in from “${t.name}”. The WO # is still yours to type.`);
  };
  const saveTemplate = useMutation({
    mutationFn: () => saveWoCreateTemplate({ name: saving!.name.trim(), fields: bag, site_id: site?.id ?? null, shared: saving!.shared }),
    onSuccess: (res) => {
      qc.setQueryData(['wo-create-templates'], res);
      setTemplateNote(`Saved as “${saving!.name.trim()}”.`);
      setSaving(null);
      setError(null);
    },
    onError: (e) => setError(e instanceof ApiRequestError ? e.message : 'Could not save the template'),
  });
  const dropTemplate = useMutation({
    mutationFn: (id: string) => deleteWoCreateTemplate(id),
    onSuccess: (res) => qc.setQueryData(['wo-create-templates'], res),
  });
  const templateList = templates.data?.templates ?? [];

  const busy = create.isPending || uploading !== null;
  const blocked = taken || missing.length > 0 || busy;

  // ── Drawing one field ──────────────────────────────────────────────────────
  const control = (f: WoCreateField) => {
    const d = catalogue.get(`fields.${f.key}`);
    const domId = `new-wo-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const val = values[f.key] ?? '';

    if (f.key === ASSIGNEE_KEY) {
      const humans = (people.data?.items ?? []).filter((p) => p.kind === 'human');
      return (
        <select id={domId} className="fld" value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
          <option value="">Nobody yet</option>
          {humans.map((p) => (
            <option key={p.id} value={p.name}>{p.name}</option>
          ))}
        </select>
      );
    }

    // 0063 · a tick. Unticked sends nothing, so "required" means "must be ticked".
    if (f.type === 'checkbox') {
      return (
        <label className="tmap-check">
          <input id={domId} type="checkbox" checked={val === 'true'} onChange={(e) => set(f.key, e.target.checked ? 'true' : '')} disabled={busy} />
          <span>Yes</span>
        </label>
      );
    }

    // 0063 · the sub-category suggests what the picked trade offers, and still
    // takes anything typed — a list can never foresee every job.
    if (f.key === WO_SUBCATEGORY_KEY) {
      const subs = subcategoriesFor(form.subcategories, trade);
      return (
        <>
          <input id={domId} className="fld" list={`${domId}-list`} value={val} placeholder={trade ? `Within ${trade}` : 'Pick the trade first for suggestions'} onChange={(e) => set(f.key, e.target.value)} disabled={busy} />
          <datalist id={`${domId}-list`}>{subs.map((s) => <option key={s} value={s} />)}</datalist>
        </>
      );
    }

    const options = d?.options ?? f.options.map((o) => ({ value: o, label: o }));
    if ((d?.type === 'select' || f.type === 'dropdown') && options.length > 0) {
      const extra = val && !options.some((o) => o.value === val) ? [{ value: val, label: val }] : [];
      return (
        <select id={domId} className="fld" value={val} onChange={(e) => set(f.key, e.target.value)} disabled={busy}>
          <option value="">—</option>
          {[...extra, ...options].map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
    }

    if (d?.subtype === 'long_text' || f.type === 'long_text') {
      return (
        <textarea
          id={domId}
          className="fld"
          rows={3}
          value={val}
          onChange={(e) => set(f.key, e.target.value)}
          disabled={busy}
        />
      );
    }

    const type =
      d?.type === 'datetime' || f.type === 'datetime' ? 'datetime-local'
      : d?.type === 'date' || f.type === 'date' ? 'date'
      : d?.type === 'money' || d?.type === 'number' || f.type === 'currency' || f.type === 'number' ? 'number'
      : d?.subtype === 'phone' || f.type === 'phone' ? 'tel'
      : 'text';

    return (
      <input
        id={domId}
        className="fld"
        type={type}
        step={d?.type === 'money' || f.type === 'currency' ? '0.01' : undefined}
        value={val}
        onChange={(e) => set(f.key, e.target.value)}
        disabled={busy}
      />
    );
  };

  const sections = [...WO_CREATE_SECTIONS, WO_CREATE_MORE_SECTION].map((s) => ({
    ...s,
    fields: form.fields.filter((f) => f.section === s.id),
  }));
  // The site step sits between the number and the configured sections.
  const stepOffset = seesSites ? 3 : 2;

  return (
    <div className="modal-scrim" onClick={onClose} role="presentation">
      <div
        className="modal is-wide"
        role="dialog"
        aria-modal="true"
        aria-label="Add work order"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2>Add work order</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* 0063 · start from a saved set of values. */}
          {(templateList.length > 0 || templateNote) && (
            <div className="wo-new-templates">
              {templateList.length > 0 && (
                <select
                  className="fld"
                  value=""
                  onChange={(e) => {
                    const t = templateList.find((x) => x.id === e.target.value);
                    if (t) applyTemplate(t);
                  }}
                  disabled={busy}
                  aria-label="Start from a template"
                >
                  <option value="">Start from a template…</option>
                  {templateList.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}{t.shared ? ' · shared' : ''}
                    </option>
                  ))}
                </select>
              )}
              {templateNote && <span className="hint">{templateNote}</span>}
              {templateList.some((t) => t.mine) && (
                <details className="wo-new-mine">
                  <summary>My templates</summary>
                  <ul>
                    {templateList.filter((t) => t.mine).map((t) => (
                      <li key={t.id}>
                        {t.name}
                        <button type="button" className="link-btn" disabled={dropTemplate.isPending} onClick={() => dropTemplate.mutate(t.id)}>Delete</button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {/* WO # leads, always required, and checked as it is typed. */}
          <section className="import-step">
            <h3>
              <span className="step-n">1</span> The number
            </h3>
            <div className={`field${taken ? ' is-missing' : ''}`}>
              <label className="lbl" htmlFor="new-wo-number">
                WO # <span className="req" aria-hidden="true">*</span>
              </label>
              <input
                id="new-wo-number"
                ref={numberRef}
                className="fld mono"
                type="text"
                placeholder="The number the client knows this job by"
                value={woNumber}
                onChange={(e) => {
                  setWoNumber(e.target.value);
                  setError(null);
                }}
                disabled={busy}
              />
            </div>

            {taken && check.data?.existing && <TakenNotice hit={check.data.existing} />}
          </section>

          {/* 0063 · the site and the asset, from the portfolio. */}
          {seesSites && (
            <section className="import-step">
              <h3>
                <span className="step-n">2</span> Site and asset
              </h3>
              <p className="hint">Pick the site to fill in its client, store and address. Leave it empty for a site that is not on file yet.</p>
              <div className="intake-grid">
                <div className="field intake-wide">
                  <span className="lbl">Site</span>
                  <SitePicker value={site} onPick={pickSite} />
                </div>
                {site && seesAssets && (
                  <div className="field intake-wide">
                    <label className="lbl" htmlFor="new-wo-asset">Asset</label>
                    <select id="new-wo-asset" className="fld" value={assetId} onChange={(e) => setAssetId(e.target.value)} disabled={busy || siteQuery.isLoading}>
                      <option value="">{siteQuery.isLoading ? 'Loading the assets…' : assets.length === 0 ? 'No assets on file at this site' : 'Not about one asset'}</option>
                      {assets.map((a) => (
                        <option key={a.id} value={a.id}>{[a.name, a.location].filter(Boolean).join(' — ')}</option>
                      ))}
                    </select>
                    {asset && (
                      <span className="wo-new-asset">
                        <span className="hint">{[asset.category, asset.asset_type, [asset.manufacturer, asset.model_number].filter(Boolean).join(' '), asset.serial_number ? `serial ${asset.serial_number}` : null].filter(Boolean).join(' · ')}</span>
                        <AssetStatusChip status={asset.status} />
                        <ConditionChip condition={asset.condition} />
                        <WarrantyChip state={asset.warranty} expiresOn={asset.warranty_expires_on} />
                        {asset.warranty === 'active' || asset.warranty === 'expiring' ? <span className="hint">Under warranty — check before quoting.</span> : null}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {!taken && near.length > 0 && <NearNotice hits={near} />}
          {layout && (
            <p className="wo-new-layout">
              <Icon name="layers" size={12} /> Using the <b>{layout.name}</b> layout for {[layout.client, layout.trade].filter(Boolean).join(' · ')}: some fields are hidden or required.
            </p>
          )}

          {/* Everything else, in the order the admin arranged it. */}
          {sections
            .filter((s) => s.fields.length > 0)
            .map((s, i) => (
              <section className="import-step" key={s.id}>
                <h3>
                  <span className="step-n">{i + stepOffset}</span> {s.title}
                </h3>
                <p className="hint">{s.hint}</p>
                <div className="intake-grid">
                  {s.fields.map((f) => (
                    <div
                      className={`field${flagged.has(f.key) ? ' is-missing' : ''}${
                        catalogue.get(`fields.${f.key}`)?.subtype === 'long_text' ? ' intake-wide' : ''
                      }`}
                      key={f.key}
                    >
                      <label className="lbl" htmlFor={`new-wo-${f.key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`}>
                        {f.label}
                        {f.mode === 'required' && (
                          <span className="req" aria-hidden="true"> *</span>
                        )}
                      </label>
                      {control(f)}
                    </div>
                  ))}
                </div>
              </section>
            ))}

          {/* 0064 · photos and files, uploaded right after the work order is made. */}
          {formQuery.isSuccess && configured.storage_ready === true && can('work_orders/tabs/overview', 'view') && (
            <section className="import-step">
              <h3>
                <span className="step-n">{sections.filter((s) => s.fields.length > 0).length + stepOffset}</span> Photos and files
              </h3>
              <p className="hint">Optional. They are uploaded as soon as the work order is created, and wait for review like any other upload.</p>
              <div className="wo-new-files">
                <label className="btn-sm is-ghost" style={{ width: 'fit-content', cursor: 'pointer' }}>
                  <Icon name="upload" size={12} /> Choose files
                  <input
                    type="file"
                    multiple
                    hidden
                    disabled={busy}
                    onChange={(e) => {
                      const picked = Array.from(e.target.files ?? []);
                      e.target.value = '';
                      setFiles((cur) => [...cur, ...picked].slice(0, 10));
                    }}
                  />
                </label>
                {files.length > 0 && (
                  <ul>
                    {files.map((f, i) => (
                      <li key={`${f.name}-${i}`}>
                        <Icon name={f.type.startsWith('image/') ? 'image' : 'file'} size={12} />
                        {f.name} <span className="hint">{formatBytes(f.size)}</span>
                        <button type="button" className="link-btn" disabled={busy} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>Remove</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {formQuery.isLoading && <p className="hint">Loading the form…</p>}
          {formQuery.isSuccess && form.fields.length === 0 && (
            <p className="hint">
              No fields are on the create form yet. An admin adds them in Admin › Custom fields.
            </p>
          )}

          {saving && (
            <div className="wo-new-save">
              <label className="lbl" htmlFor="new-wo-template-name">Save what is filled in as a template</label>
              <input id="new-wo-template-name" className="fld" autoFocus value={saving.name} placeholder="e.g. 7-Eleven refrigeration call" maxLength={120} onChange={(e) => setSaving({ ...saving, name: e.target.value })} />
              {can('admin/fields', 'edit') && (
                <label className="tmap-check">
                  <input type="checkbox" checked={saving.shared} onChange={(e) => setSaving({ ...saving, shared: e.target.checked })} />
                  <span>Share it with everyone</span>
                </label>
              )}
              <span className="hint">The WO # and the asset are not saved — they belong to one job.</span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="btn-sm" disabled={saving.name.trim() === '' || saveTemplate.isPending} onClick={() => saveTemplate.mutate()}>Save template</button>
                <button type="button" className="btn-sm is-ghost" onClick={() => setSaving(null)}>Cancel</button>
              </span>
            </div>
          )}
          {error && <p className="modal-error">{error}</p>}
        </div>

        <div className="modal-foot">
          <span className="card-meta">
            {taken ? 'That number is already taken'
            : missing.length > 0 ? `Still needs ${describeMissing(missing)}`
            : 'Ready'}
          </span>
          {!saving && (Object.keys(bag).length > 0 || site) && (
            <button type="button" className="btn-sm is-ghost" onClick={() => setSaving({ name: '', shared: false })} disabled={busy}>
              Save as template
            </button>
          )}
          <button type="button" className="btn-sm is-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-sm is-primary"
            onClick={() => create.mutate()}
            disabled={blocked}
            title={taken ? 'Change the WO # first' : undefined}
          >
            {uploading ?? (busy ? 'Creating…' : files.length > 0 ? `Create and upload ${files.length} ${files.length === 1 ? 'file' : 'files'}` : 'Create work order')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The number is taken: say by what, and link to it. */
function TakenNotice({ hit }: { hit: WoDuplicateHit }) {
  return (
    <p className="modal-error">
      <Icon name="alert" size={14} />{' '}
      <strong>{hit.wo_number}</strong> already exists{hit.deleted ? ' (in the trash)' : ''} —{' '}
      {hit.client ?? 'no client'} · {hit.status}
      {hit.deleted && <> · restoring it would clash, so the number stays taken</>}
      {!hit.deleted && (
        <>
          {' '}
          <a href={`/work-orders/${encodeURIComponent(hit.wo_number)}`}>Open it</a>
        </>
      )}
    </p>
  );
}

const WHY: Record<NonNullable<WoDuplicateHit['why']>, string> = {
  asset: 'same asset',
  site: 'same site',
  store_trade: 'same store and trade',
};

/** Not a block: something already open looks like this job. */
function NearNotice({ hits }: { hits: WoDuplicateHit[] }) {
  return (
    <div className="hint near-box">
      <Icon name="alert" size={14} /> <b>Possible duplicates.</b>{' '}
      {hits.length === 1 ? 'One open work order looks' : `${hits.length} open work orders look`} like this job
      (the same asset, the same site, or the same store and trade in the last {WO_NEAR_DUPLICATE_DAYS} days):
      <ul className="near-dupes">
        {hits.map((h) => (
          <li key={h.wo_number}>
            <a href={`/work-orders/${encodeURIComponent(h.wo_number)}`} target="_blank" rel="noreferrer">{h.wo_number}</a>
            {h.why && <span className="chip chip-sm">{WHY[h.why]}</span>} · {h.status}{h.trade ? ` · ${h.trade}` : ''} · {h.title}
          </li>
        ))}
      </ul>
      Carry on if this is a different job.
    </div>
  );
}

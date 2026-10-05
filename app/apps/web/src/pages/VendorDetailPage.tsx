/* /vendors/:id and /vendors/new — one vendor or technician record (0057).
 *
 * The same page reads and edits: Edit turns every section into inputs, Save
 * sends the whole form (the API logs only what changed). The sections follow
 * the VR CRM's profile — general, trade, coverage, availability and rates,
 * contact, compliance — and the trade-specific ones (plumbing, HVAC,
 * electrical, handyman) appear when the vendor's trades call for them.
 *
 * Beside the form, each with its own save: phones and contacts (part of the
 * form), insurance dates, notes and the blacklist, who has worked with them,
 * where they are preferred, the work orders they were hired on, and the
 * change history. */

import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  COMPLIANCE_STATUS_LABELS,
  TRI_STATES,
  TRI_STATE_LABELS,
  US_STATE_CODES,
  VENDOR_DETAIL_SECTIONS,
  VENDOR_KIND_LABELS,
  VENDOR_PAYMENT_METHODS,
  VENDOR_PRIORITIES,
  preferredRuleText,
} from '@theone/shared';
import type { VendorDetail, VendorInput, VendorsMetaResponse } from '@theone/shared';
import {
  ApiRequestError,
  addVendorExpiry,
  addVendorNote,
  blacklistVendor,
  clearVendorBlacklist,
  createVendor,
  deleteVendor,
  getVendor,
  getVendorHistory,
  getVendorsMeta,
  removeVendorExpiry,
  updateVendor,
} from '../api/client';
import { AppShell } from '../components/AppShell';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Icon } from '../components/Icon';
import { NoteLog } from '../components/wo/tech/TechMapSheet';
import { feedTime } from '../lib/fields';
import { VendorRecordPanels } from '../components/vendors/VendorRecordPanels';
import { VendorPortalPanel, VendorQualificationsPanel } from '../components/vendors/VendorExtras';
import { StatusDot } from './VendorsPage';

type FieldType = 'text' | 'longtext' | 'select' | 'bool' | 'nbool' | 'money' | 'number' | 'multi' | 'tri' | 'date';

interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  wide?: boolean;
  /** Lives in vendor.details rather than a column. */
  detail?: boolean;
  readOnly?: boolean;
}

interface SectionDef {
  slug: string;
  title: string;
  fields: FieldDef[];
}

const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: v }));

function coreSections(meta: VendorsMetaResponse | undefined, kind: string): SectionDef[] {
  const trades = opts(meta?.trades ?? []);
  const sections: SectionDef[] = [
    {
      slug: 'general',
      title: 'General',
      fields: [
        { key: 'name', label: 'Name', type: 'text' },
        { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'vendor', label: 'VR vendor' }, { value: 'tech', label: 'Technician' }] },
        { key: 'status', label: 'Status', type: 'select', options: (meta?.statuses ?? []).filter((s) => s.is_active).map((s) => ({ value: s.key, label: s.label })) },
        { key: 'brand_source', label: 'Brand source', type: 'select', options: (meta?.brand_sources ?? []).filter((s) => s.is_active).map((s) => ({ value: s.key, label: s.label })) },
        { key: 'owner_id', label: 'Owner', type: 'select', options: (meta?.owners ?? []).map((o) => ({ value: o.id, label: o.name })) },
        { key: 'priority', label: 'Priority', type: 'select', options: VENDOR_PRIORITIES.map((p) => ({ value: p, label: p[0] + p.slice(1).toLowerCase() })) },
        { key: 'email', label: 'Email', type: 'text' },
        { key: 'legal_name', label: 'Legal business name', type: 'text' },
        { key: 'dba_name', label: 'DBA', type: 'text' },
      ],
    },
    {
      slug: 'trade',
      title: 'Trade',
      fields: [
        { key: 'primary_trade', label: 'Primary trade', type: 'select', options: trades },
        { key: 'secondary_trades', label: 'Secondary trades', type: 'multi', options: trades, wide: true },
      ],
    },
    {
      slug: 'where',
      title: 'Location and coverage',
      fields: [
        { key: 'city', label: 'City', type: 'text' },
        { key: 'state', label: 'State', type: 'select', options: opts(US_STATE_CODES) },
        { key: 'zip', label: 'ZIP', type: 'text' },
        { key: 'max_travel_radius', label: 'Max travel radius', type: 'text' },
        { key: 'statewide', label: 'Covers the whole state', type: 'bool' },
        { key: 'nationwide', label: 'Covers nationwide', type: 'bool' },
        { key: 'coverage_states', label: 'Other states covered', type: 'multi', options: opts(US_STATE_CODES), wide: true },
      ],
    },
    {
      slug: 'availability',
      title: 'Availability and rates',
      fields: [
        { key: 'emergency_same_day', label: 'Emergency same day', type: 'nbool' },
        { key: 'after_hours', label: 'After hours', type: 'nbool' },
        { key: 'weekends', label: 'Weekends', type: 'nbool' },
        { key: 'holiday_emergency', label: 'Holiday emergency', type: 'nbool' },
        { key: 'estimated_response_time', label: 'Estimated response time', type: 'text' },
        { key: 'regular_hourly_rate', label: 'Regular hourly rate', type: 'money' },
        { key: 'after_hours_rate', label: 'After-hours rate', type: 'money' },
        { key: 'weekend_emergency_rate', label: 'Weekend / emergency rate', type: 'money' },
        { key: 'trip_charge', label: 'Trip charge', type: 'money' },
        { key: 'diagnostic_fee', label: 'Diagnostic fee', type: 'money' },
        { key: 'minimum_charge', label: 'Minimum charge', type: 'money' },
        { key: 'accepts_payment_after_30_days', label: 'Accepts payment after 30 days', type: 'nbool' },
        { key: 'payment_methods', label: 'Payment methods', type: 'multi', options: opts(VENDOR_PAYMENT_METHODS), wide: true },
      ],
    },
    {
      slug: 'contact',
      title: 'Primary contact',
      fields: [
        { key: 'primary_contact_name', label: 'Contact name', type: 'text' },
        { key: 'primary_contact_role', label: 'Role', type: 'text' },
        { key: 'dispatch_phone', label: 'Dispatch phone', type: 'text' },
        { key: 'billing_email', label: 'Billing email', type: 'text' },
      ],
    },
  ];
  if (kind === 'vendor') {
    sections.push({
      slug: 'compliance',
      title: 'Compliance',
      fields: [
        { key: 'w9_received', label: 'W-9 received', type: 'tri' },
        { key: 'msa_signed', label: 'MSA signed', type: 'tri' },
        { key: 'coi_received', label: 'COI received', type: 'tri' },
        { key: 'coi_approved', label: 'COI approved', type: 'tri' },
      ],
    });
  } else {
    sections.push({ slug: 'tech', title: 'Technician', fields: [{ key: 'is_subcontractor', label: 'Subcontractor', type: 'bool' }] });
  }
  sections.push({ slug: 'notes', title: 'Notes', fields: [{ key: 'notes', label: 'Notes', type: 'longtext', wide: true }] });
  return sections;
}

function detailSections(trades: string[]): SectionDef[] {
  const mine = trades.map((t) => t.toLowerCase());
  return VENDOR_DETAIL_SECTIONS.filter((s) => !s.trades || s.trades.some((t) => mine.includes(t.toLowerCase()))).map((s) => ({
    slug: `d-${s.slug}`,
    title: s.title,
    fields: s.fields.map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type === 'multi' ? 'multi' : f.type === 'longtext' ? 'longtext' : f.type === 'bool' ? 'nbool' : f.type === 'tri' ? 'tri' : f.type === 'money' ? 'money' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text',
      options: f.options ? opts(f.options) : undefined,
      wide: f.type === 'longtext' || f.type === 'multi',
      detail: true,
    })),
  }));
}

type Draft = Record<string, unknown>;

function draftOf(v: VendorDetail | null, kind: 'vendor' | 'tech'): Draft {
  if (!v) return { kind, status: kind === 'tech' ? 'ACTIVE' : 'NEW', statewide: false, nationwide: false, secondary_trades: [], coverage_states: [], payment_methods: [], w9_received: 'PENDING', msa_signed: 'PENDING', coi_received: 'PENDING', coi_approved: 'PENDING', is_subcontractor: false };
  const { details, owner, ...rest } = v;
  return { ...details, ...rest, owner_id: owner?.id ?? null };
}

function show(def: FieldDef, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  switch (def.type) {
    case 'bool':
      return value ? 'Yes' : 'No';
    case 'nbool':
      return value === true ? 'Yes' : value === false ? 'No' : null;
    case 'money':
      return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'multi':
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : null;
    case 'tri':
      return TRI_STATE_LABELS[value as keyof typeof TRI_STATE_LABELS] ?? String(value);
    case 'select':
      return def.options?.find((o) => o.value === value)?.label ?? String(value);
    default:
      return String(value);
  }
}

function FieldInput({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const id = `vf-${def.key}`;
  switch (def.type) {
    case 'longtext':
      return <textarea className="fld" id={id} rows={3} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      return (
        <select className="fld" id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {/* A value no longer on the list still shows, so saving does not lose it. */}
          {value && !def.options?.some((o) => o.value === value) ? <option value={String(value)}>{String(value)}</option> : null}
          {(def.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'tri':
      return (
        <select className="fld" id={id} value={(value as string) ?? 'PENDING'} onChange={(e) => onChange(e.target.value)}>
          {TRI_STATES.map((t) => <option key={t} value={t}>{TRI_STATE_LABELS[t]}</option>)}
        </select>
      );
    case 'bool':
      return (
        <label className="tmap-check">
          <input type="checkbox" id={id} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>Yes</span>
        </label>
      );
    case 'nbool':
      return (
        <select className="fld" id={id} value={value === true ? 'yes' : value === false ? 'no' : ''} onChange={(e) => onChange(e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null)}>
          <option value="">Not asked</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      );
    case 'multi':
      return (
        <span className="vrec-multi">
          {(def.options ?? []).map((o) => {
            const list = Array.isArray(value) ? (value as string[]) : [];
            const on = list.includes(o.value);
            return (
              <label className="tmap-check" key={o.value}>
                <input type="checkbox" checked={on} onChange={() => onChange(on ? list.filter((x) => x !== o.value) : [...list, o.value])} />
                <span>{o.label}</span>
              </label>
            );
          })}
        </span>
      );
    case 'money':
    case 'number':
      return <input className="fld mono" id={id} inputMode="decimal" value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input className="fld" id={id} type="date" value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input className="fld" id={id} value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

/** The form → the API body. Numbers are parsed here; an unparseable one is
    reported instead of being sent as 0. */
function toInput(draft: Draft, sections: SectionDef[], phones: PhoneRow[], contacts: ContactRow[]): { input: VendorInput; problem: string | null } {
  const input: Record<string, unknown> = {};
  const details: Record<string, unknown> = {};
  let problem: string | null = null;
  for (const s of sections) {
    for (const f of s.fields) {
      if (f.readOnly) continue;
      let v = draft[f.key];
      if (f.type === 'money' || f.type === 'number') {
        const raw = String(v ?? '').replace(/[$,\s]/g, '');
        if (raw === '') v = null;
        else if (!/^\d+(\.\d+)?$/.test(raw)) {
          problem = problem ?? `“${f.label}” must be a number`;
          continue;
        } else v = Number(raw);
      } else if (f.type === 'text' || f.type === 'longtext' || f.type === 'date') {
        v = typeof v === 'string' && v.trim() !== '' ? v : null;
      } else if (f.type === 'multi') {
        v = Array.isArray(v) ? v : [];
      } else if (f.type === 'select') {
        v = v === '' || v === undefined ? null : v;
      }
      if (f.detail) details[f.key] = v;
      else input[f.key] = v;
    }
  }
  if (!String(input.name ?? '').trim()) problem = problem ?? 'The vendor needs a name';
  if (input.status === null) delete input.status;
  input.details = details;
  input.phones = phones.filter((p) => p.phone.trim() !== '').map((p) => ({ phone: p.phone.trim(), label: p.label.trim() || null }));
  input.contacts = contacts
    .filter((c) => c.name.trim() !== '')
    .map((c) => ({ name: c.name.trim(), role: c.role.trim() || null, phone: c.phone.trim() || null, email: c.email.trim() || null }));
  return { input: input as VendorInput, problem };
}

interface PhoneRow { phone: string; label: string }
interface ContactRow { name: string; role: string; phone: string; email: string }
interface DupMatch { id: string; name: string; phone: string | null }

const errText = (e: unknown, fallback: string) => (e instanceof ApiRequestError ? e.message : fallback);

export function VendorDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const [sp] = useSearchParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const qc = useQueryClient();

  const meta = useQuery({ queryKey: ['vendors-meta'], queryFn: getVendorsMeta });
  const key = ['vendor', id];
  const query = useQuery({ queryKey: key, queryFn: () => getVendor(id), enabled: !isNew });
  const v = query.data?.vendor ?? null;

  const [editing, setEditing] = useState(isNew);
  const [draft, setDraft] = useState<Draft>(() => draftOf(null, sp.get('kind') === 'tech' ? 'tech' : 'vendor'));
  const [phones, setPhones] = useState<PhoneRow[]>([{ phone: '', label: '' }]);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [dups, setDups] = useState<DupMatch[] | null>(null);
  // 0058 — a new record without a required field is refused until somebody
  // says "add anyway"; it is then flagged and waits in the review queue.
  const [missing, setMissing] = useState<{ key: string; label: string }[] | null>(null);
  const [ov, setOv] = useState<{ duplicate: boolean; missing: boolean }>({ duplicate: false, missing: false });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const seed = (rec: VendorDetail) => {
    setDraft(draftOf(rec, rec.kind));
    setPhones(rec.phones.length > 0 ? rec.phones.map((p) => ({ phone: p.display, label: p.label ?? '' })) : [{ phone: '', label: '' }]);
    setContacts(rec.contacts.map((c) => ({ name: c.name, role: c.role ?? '', phone: c.phone ?? '', email: c.email ?? '' })));
  };
  useEffect(() => {
    if (v && !editing) seed(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v?.id, v?.updated_at]);

  const kind = String(draft.kind ?? 'vendor');
  const tradesNow = [draft.primary_trade, ...(Array.isArray(draft.secondary_trades) ? draft.secondary_trades : [])].filter(Boolean) as string[];
  const sections = useMemo(
    () => [...coreSections(meta.data, kind), ...detailSections(tradesNow)],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [meta.data, kind, tradesNow.join('|')],
  );

  const save = useMutation({
    mutationFn: async (o: { duplicate: boolean; missing: boolean }) => {
      const { input, problem: p } = toInput(draft, sections, phones, contacts);
      if (p) throw new Error(p);
      return isNew ? createVendor({ ...input, override_duplicate: o.duplicate, override_missing: o.missing }) : updateVendor(id, input);
    },
    onMutate: () => {
      setProblem(null);
      setDups(null);
      setMissing(null);
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
      qc.setQueryData(['vendor', res.vendor.id], res);
      setEditing(false);
      seed(res.vendor);
      if (isNew) navigate(`/vendors/${res.vendor.id}`, { replace: true });
    },
    onError: (e) => {
      const d = e instanceof ApiRequestError ? (e.details as { code?: string; matches?: DupMatch[]; missing?: { key: string; label: string }[] } | null) : null;
      if (d?.code === 'VENDOR_DUPLICATE') setDups(d.matches ?? []);
      else if (d?.code === 'VENDOR_MISSING_FIELDS') setMissing(d.missing ?? []);
      else setProblem(e instanceof Error ? e.message : 'Could not save.');
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteVendor(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vendors'] });
      void qc.invalidateQueries({ queryKey: ['vendors-meta'] });
      navigate('/vendors');
    },
    onError: (e) => setProblem(errText(e, 'Could not remove the vendor.')),
  });

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <button type="button" className="crumb-back" aria-label="Back to Vendors" onClick={() => navigate('/vendors')}>
        <Icon name="arrow-l" size={14} />
      </button>
      <Link className="crumb" to="/vendors">Vendors</Link>
      <span className="crumb-sep" aria-hidden="true">/</span>
      <span className="crumb-cur" aria-current="page">{isNew ? 'New' : (v?.name ?? '…')}</span>
    </nav>
  );
  const shell = (children: ReactNode) => (
    <AppShell active="Vendors" breadcrumb={crumbs}>
      <div className="canvas-inner">{children}</div>
    </AppShell>
  );

  if (!isNew && query.isLoading) return shell(<div className="wo-state"><b>Loading the vendor…</b></div>);
  if (!isNew && (query.isError || !v)) {
    return shell(
      <div className="wo-state">
        <Icon name="alert" size={22} />
        <b>Could not open this vendor</b>
        <span>{errText(query.error, 'It may have been removed.')}</span>
        <Link className="btn" to="/vendors">Back to Vendors</Link>
      </div>,
    );
  }

  const canEdit = isNew ? Boolean(meta.data?.can.create) : Boolean(v?.can.edit);
  const setField = (k: string, value: unknown) => setDraft((d) => ({ ...d, [k]: value }));

  return shell(
    <>
      <section className="card vrec-head">
        <div className="vrec-title">
          <h1>{isNew ? `New ${kind === 'tech' ? 'technician' : 'vendor'}` : v!.name}</h1>
          {!isNew && v && (
            <div className="vrec-chips">
              <span className="chip chip-sm">{VENDOR_KIND_LABELS[v.kind]}</span>
              <StatusDot status={v.status} defs={meta.data?.statuses ?? []} />
              {v.kind === 'vendor' && <span className="chip chip-sm">{COMPLIANCE_STATUS_LABELS[v.compliance_status]}</span>}
              {v.blacklisted && <span className="chip chip-danger chip-sm">Blacklisted</span>}
              {v.flagged_duplicate && (
                <span className="chip chip-sm">
                  Possible duplicate{v.duplicate_of ? <> of <Link to={`/vendors/${v.duplicate_of.id}`}>{v.duplicate_of.name}</Link></> : null}
                </span>
              )}
              {v.flagged_missing && <span className="chip chip-sm" title="Saved without a required field — see Still needed below">Missing information</span>}
              {!v.on_map && <span className="chip chip-outline chip-sm" title="The city could not be placed — correct the city, state or ZIP">Not on the map</span>}
              {v.owner && <span className="chip chip-sm">Owner · {v.owner.name}</span>}
            </div>
          )}
        </div>
        <div className="vrec-actions">
          {editing ? (
            <>
              {!isNew && (
                <button type="button" className="btn" onClick={() => { setEditing(false); if (v) seed(v); setProblem(null); }}>
                  Cancel
                </button>
              )}
              {isNew && <Link className="btn" to="/vendors">Cancel</Link>}
              <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={() => save.mutate(ov)}>
                <Icon name="check" size={14} />
                {save.isPending ? 'Saving…' : isNew ? 'Add vendor' : 'Save changes'}
              </button>
            </>
          ) : (
            <>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>
                  <Icon name="pencil" size={14} />
                  Edit
                </button>
              )}
              {v?.can.delete && (
                <button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>
                  <Icon name="trash" size={14} />
                  Remove
                </button>
              )}
            </>
          )}
        </div>
      </section>

      {problem && (
        <div className="callout" style={{ marginTop: 12 }}>
          <Icon name="alert" size={14} />
          <span>{problem}</span>
        </div>
      )}
      {dups && (
        <div className="callout vrec-dup" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <span>
            <Icon name="alert" size={14} /> <b>This may already be on file.</b> The name or a phone number matches:
          </span>
          <ul className="vrec-list" style={{ padding: 0 }}>
            {dups.map((d) => (
              <li key={d.id}>
                <Link to={`/vendors/${d.id}`} target="_blank" rel="noreferrer">{d.name}</Link>
                {d.phone && <span className="mono">{d.phone}</span>}
              </li>
            ))}
          </ul>
          <span style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn" onClick={() => setDups(null)}>Go back and check</button>
            <button type="button" className="btn btn-danger" disabled={save.isPending} onClick={() => { const next = { ...ov, duplicate: true }; setOv(next); save.mutate(next); }}>
              Add anyway — flag as a possible duplicate
            </button>
          </span>
        </div>
      )}
      {missing && (
        <div className="callout vrec-dup" style={{ marginTop: 12, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <span>
            <Icon name="alert" size={14} /> <b>Still needed:</b> {missing.map((m) => m.label).join(', ')}.
          </span>
          <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn" onClick={() => setMissing(null)}>Go back and fill them in</button>
            <button type="button" className="btn btn-danger" disabled={save.isPending} onClick={() => { const next = { ...ov, missing: true }; setOv(next); save.mutate(next); }}>
              Add anyway — flag for review
            </button>
          </span>
        </div>
      )}
      {!isNew && v?.compliance_warning && !editing && (
        <div className="callout" style={{ marginTop: 12 }}>
          <Icon name="alert" size={14} />
          <span>{v.compliance_warning}. Hiring this vendor shows a warning.</span>
        </div>
      )}
      {!isNew && v?.blacklisted && (
        <div className="callout" style={{ marginTop: 12 }}>
          <Icon name="flag" size={14} />
          <span>
            <b>Blacklisted</b>
            {v.blacklisted_by ? ` by ${v.blacklisted_by.name}` : ''}
            {v.blacklisted_at ? ` · ${feedTime(v.blacklisted_at)}` : ''} — {v.blacklist_reason}
          </span>
        </div>
      )}

      <div className="vrec-grid">
        <div className="vrec-col">
          {sections.map((s) => {
            const rows = editing ? s.fields : s.fields.filter((f) => show(f, draft[f.key]) !== null || !f.detail);
            if (!editing && s.slug.startsWith('d-') && rows.length === 0) return null;
            return (
              <section className="card" key={s.slug}>
                <div className="card-head"><h2 className="card-title">{s.title}</h2></div>
                <div className="vrec-fields">
                  {rows.map((f) => (
                    <div className={`vrec-field${f.wide ? ' is-wide' : ''}`} key={f.key}>
                      <label className="lbl" htmlFor={`vf-${f.key}`}>{f.label}</label>
                      {editing && !f.readOnly ? (
                        <FieldInput def={f} value={draft[f.key]} onChange={(val) => setField(f.key, val)} />
                      ) : (
                        <span className={`vrec-val${show(f, draft[f.key]) === null ? ' is-none' : ''}`}>{show(f, draft[f.key]) ?? '—'}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        <aside className="vrec-col">
          <section className="card">
            <div className="card-head"><h2 className="card-title">Phones</h2></div>
            {editing ? (
              <div className="vrec-list">
                {phones.map((p, i) => (
                  <div className="vrec-rowedit" key={i}>
                    <input className="fld mono" type="tel" placeholder="(409) 555-0143" value={p.phone} aria-label={`Phone ${i + 1}`} onChange={(e) => setPhones((l) => l.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
                    <input className="fld" placeholder="Label" value={p.label} aria-label={`Phone ${i + 1} label`} onChange={(e) => setPhones((l) => l.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                    <button type="button" className="icon-btn" aria-label="Remove this phone" onClick={() => setPhones((l) => l.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                  </div>
                ))}
                <button type="button" className="link-btn" onClick={() => setPhones((l) => [...l, { phone: '', label: '' }])}>+ Add a phone</button>
              </div>
            ) : (
              <ul className="vrec-list">
                {(v?.phones ?? []).length === 0 && <li>No phone on file</li>}
                {(v?.phones ?? []).map((p) => (
                  <li key={p.digits}>
                    <a className="mono" href={`tel:+${p.digits}`}>{p.display}</a>
                    {p.label && <span>{p.label}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <div className="card-head"><h2 className="card-title">Other contacts</h2></div>
            {editing ? (
              <div className="vrec-list">
                {contacts.map((c, i) => (
                  <div className="vrec-rowedit is-contact" key={i}>
                    {(['name', 'role', 'phone', 'email'] as const).map((k) => (
                      <input key={k} className="fld" placeholder={k[0].toUpperCase() + k.slice(1)} value={c[k]} aria-label={`Contact ${i + 1} ${k}`} onChange={(e) => setContacts((l) => l.map((x, j) => (j === i ? { ...x, [k]: e.target.value } : x)))} />
                    ))}
                    <button type="button" className="icon-btn" aria-label="Remove this contact" onClick={() => setContacts((l) => l.filter((_, j) => j !== i))}><Icon name="x" size={12} /></button>
                  </div>
                ))}
                <button type="button" className="link-btn" onClick={() => setContacts((l) => [...l, { name: '', role: '', phone: '', email: '' }])}>+ Add a contact</button>
              </div>
            ) : (
              <ul className="vrec-list">
                {(v?.contacts ?? []).length === 0 && <li>None</li>}
                {(v?.contacts ?? []).map((c) => (
                  <li key={c.id ?? c.name}>
                    <b>{c.name}</b>
                    {[c.role, c.phone, c.email].filter(Boolean).join(' · ')}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {!isNew && v && !editing && (
            <VendorRecordPanels v={v} vendorKey={key} statuses={meta.data?.statuses ?? []} entities={meta.data?.brand_sources ?? []} />
          )}
          {/* 0066 · skills and inductions, then the vendor's own links. */}
          {!isNew && v && !editing && <VendorQualificationsPanel vendorId={v.id} />}
          {!isNew && v && !editing && <VendorPortalPanel vendorId={v.id} />}
          {!isNew && v && !editing && <SidePanels v={v} vendorKey={key} entities={meta.data?.brand_sources ?? []} />}
        </aside>
      </div>

      {confirmDelete && v && (
        <ConfirmDialog
          title={`Remove ${v.name}?`}
          message={<>It leaves the list and the maps. Its payments, bills and visits keep pointing at it, and the change history stays.</>}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
        />
      )}
    </>,
  );
}

// ── The side panels of a saved record ────────────────────────────────────────

function SidePanels({ v, vendorKey, entities }: { v: VendorDetail; vendorKey: string[]; entities: { key: string; label: string }[] }) {
  const qc = useQueryClient();
  const [noteText, setNoteText] = useState('');
  const [blackMode, setBlackMode] = useState(false);
  const [expiry, setExpiry] = useState({ insurance_type: 'COI', entity: '', expires_on: '' });
  const [showHistory, setShowHistory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: vendorKey });

  const note = useMutation({
    mutationFn: () => (blackMode ? blacklistVendor(v.id, noteText.trim()) : addVendorNote(v.id, noteText.trim())),
    onSuccess: () => { setNoteText(''); setBlackMode(false); setError(null); refresh(); void qc.invalidateQueries({ queryKey: ['vendors-meta'] }); },
    onError: (e) => setError(errText(e, 'Could not save.')),
  });
  const clear = useMutation({
    mutationFn: () => clearVendorBlacklist(v.id),
    onSuccess: () => { setError(null); refresh(); void qc.invalidateQueries({ queryKey: ['vendors-meta'] }); },
    onError: (e) => setError(errText(e, 'Could not clear the blacklist.')),
  });
  const addExp = useMutation({
    mutationFn: () => addVendorExpiry(v.id, { insurance_type: expiry.insurance_type.trim(), entity: expiry.entity || null, expires_on: expiry.expires_on }),
    onSuccess: (res) => { qc.setQueryData(vendorKey, res); setExpiry((e) => ({ ...e, expires_on: '' })); setError(null); },
    onError: (e) => setError(errText(e, 'Could not add the date.')),
  });
  const delExp = useMutation({
    mutationFn: (expiryId: string) => removeVendorExpiry(v.id, expiryId),
    onSuccess: (res) => qc.setQueryData(vendorKey, res),
    onError: (e) => setError(errText(e, 'Could not remove the date.')),
  });
  const history = useQuery({ queryKey: ['vendor-history', v.id, v.updated_at], queryFn: () => getVendorHistory(v.id), enabled: showHistory });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      {error && (
        <div className="callout">
          <Icon name="alert" size={14} />
          <span>{error}</span>
        </div>
      )}

      {v.kind === 'vendor' && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title grow">Insurance dates</h2>
          </div>
          <ul className="vrec-list">
            {v.expiries.length === 0 && <li>No dates on file</li>}
            {v.expiries.map((e) => (
              <li key={e.id} className={e.current ? undefined : 'is-old'} title={e.current ? undefined : 'Replaced by a later date — kept as history, no longer counts'}>
                <b>{e.insurance_type}</b>
                {e.entity ? <span>{entities.find((x) => x.key === e.entity)?.label ?? e.entity}</span> : null}
                <span className={e.current && e.expires_on < today ? 'tech-warn' : undefined}>
                  {e.expires_on}
                  {e.current && e.expires_on < today ? ' · expired' : ''}
                </span>
                {v.can.edit && (
                  <button type="button" className="icon-btn push" aria-label="Remove this date" onClick={() => delExp.mutate(e.id)}><Icon name="x" size={12} /></button>
                )}
              </li>
            ))}
          </ul>
          {v.can.edit && (
            <div className="vrec-inline">
              <input className="fld" style={{ width: 110 }} aria-label="Insurance type" value={expiry.insurance_type} onChange={(e) => setExpiry((x) => ({ ...x, insurance_type: e.target.value }))} />
              <select className="fld" aria-label="Company" value={expiry.entity} onChange={(e) => setExpiry((x) => ({ ...x, entity: e.target.value }))}>
                <option value="">Any company</option>
                {entities.filter((e) => e.key !== 'BOTH').map((e) => <option key={e.key} value={e.key}>{e.label}</option>)}
              </select>
              <input className="fld" type="date" aria-label="Expires on" value={expiry.expires_on} onChange={(e) => setExpiry((x) => ({ ...x, expires_on: e.target.value }))} />
              <button type="button" className="btn btn-sm" disabled={!expiry.expires_on || expiry.insurance_type.trim() === '' || addExp.isPending} onClick={() => addExp.mutate()}>Add</button>
            </div>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Notes</h2>
          {v.blacklisted && v.can.clear_blacklist && (
            <button type="button" className="btn btn-sm is-ghost" disabled={clear.isPending} onClick={() => clear.mutate()}>Clear blacklist</button>
          )}
        </div>
        {v.can.note && (
          <div className="vrec-list">
            <textarea className="fld" rows={2} placeholder={blackMode ? 'Why should nobody use them?' : 'Add a note…'} value={noteText} onChange={(e) => setNoteText(e.target.value)} aria-label="Note" />
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <button type="button" className={`btn btn-sm${blackMode ? ' is-danger' : ''}`} disabled={noteText.trim() === '' || note.isPending} onClick={() => note.mutate()}>
                {blackMode ? 'Mark blacklisted' : 'Save note'}
              </button>
              {!v.blacklisted && (
                <label className="tmap-check">
                  <input type="checkbox" checked={blackMode} onChange={() => setBlackMode((b) => !b)} />
                  <span>Blacklist with this as the reason</span>
                </label>
              )}
            </span>
          </div>
        )}
        <div style={{ padding: '0 14px 12px' }}>
          <NoteLog notes={v.note_log} loading={false} />
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2 className="card-title">Worked with</h2></div>
        <ul className="vrec-list">
          {v.dispatchers.length === 0 && <li>Nobody yet — logging a visit with them, or hiring them, links a dispatcher.</li>}
          {v.dispatchers.map((d) => (
            <li key={d.id}>
              <b>{d.name}</b>
              <span>{d.source === 'visit' ? 'logged a visit' : d.source === 'hire' ? 'hired them' : d.source === 'added' ? 'added them' : d.source}</span>
              <span className="push">{feedTime(d.since)}</span>
            </li>
          ))}
        </ul>
      </section>

      {v.preferred_for.length > 0 && (
        <section className="card">
          <div className="card-head"><h2 className="card-title">Preferred for</h2></div>
          <ul className="vrec-list">
            {v.preferred_for.map((r) => (
              <li key={r.id}>
                <b>{preferredRuleText(r)}</b>
                <span>rank {r.rank}</span>
                {r.note && <span>{r.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Work orders</h2>
          <span className="card-meta">{v.work_orders_count} job{v.work_orders_count === 1 ? '' : 's'}</span>
        </div>
        <ul className="vrec-list">
          {v.work_orders.length === 0 && <li>Not hired on a work order yet</li>}
          {v.work_orders.map((w) => (
            <li key={w.wo_number + w.hired_at}>
              <Link to={`/work-orders/${encodeURIComponent(w.wo_number)}?tab=people`}>{w.wo_number}</Link>
              <span>{w.title}</span>
              <span className="push">{w.released_at ? 'taken off' : feedTime(w.hired_at)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title grow">Change history</h2>
          <button type="button" className="link-btn" onClick={() => setShowHistory((s) => !s)}>{showHistory ? 'Hide' : 'Show'}</button>
        </div>
        {showHistory && (
          <ul className="vrec-hist">
            {history.isLoading && <li>Loading…</li>}
            {(history.data?.items ?? []).map((h) => (
              <li key={h.id}>
                <b>{HISTORY_LABELS[h.action] ?? h.action}</b>
                <small>{h.actor?.name ?? 'System'} · {feedTime(h.created_at)}</small>
                {h.action === 'vendor_updated' && h.after && (
                  <span>
                    {Object.keys(h.after).filter((k) => k !== 'name').map((k) => (
                      <span key={k} style={{ display: 'block' }}>
                        {k.replace(/_/g, ' ')}: {fmt(h.before?.[k])} → {fmt(h.after?.[k])}
                      </span>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

const HISTORY_LABELS: Record<string, string> = {
  vendor_created: 'Added',
  vendor_updated: 'Edited',
  vendor_deleted: 'Removed',
  vendor_note_added: 'Note added',
  vendor_blacklisted: 'Blacklisted',
  vendor_blacklist_cleared: 'Blacklist cleared',
  vendor_expiry_added: 'Insurance date added',
  vendor_expiry_removed: 'Insurance date removed',
};

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length === 0 ? '—' : v.join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return String(v);
}

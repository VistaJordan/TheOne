// 0066 · The vendor portal: a link per vendor, with no account behind it.
//
// SECURITY — read this before changing anything here.
//   · The token is the credential. 32 url-safe characters from the OS random
//     source; only its SHA-256 is stored. It is shown once, to the person who
//     made the link, and never again.
//   · A link belongs to ONE vendor. Every read and every write below starts
//     from `resolve(token)` and filters by THAT vendor's id — a job is only
//     ever shown or touched when the vendor is the work order's responsible
//     vendor, a technician hired onto it, or holds a live offer for it.
//   · What a vendor sees of a job is the fixed list in `PortalJob`: where,
//     what, when. No money, no NTE, no client contact, no internal notes, no
//     other vendor's name.
//   · What a vendor can change: answer an offer made to them, give an ETA on a
//     job they hold, leave a note. A note lands in `vendor_portal_note` and
//     is copied to the work order as an INTERNAL comment that says it came
//     from the portal. Nothing a vendor types moves a status or a number.
//   · An onboarding form changes nothing by itself: it waits in
//     `vendor_onboarding` until one of us accepts it, and only the fields in
//     `OnboardingPayload` are read from it.
//   · A revoked or expired link, a deleted or blacklisted vendor: 404, the
//     same answer as a token that never existed.
//   · No email is sent. A person copies the link and hands it over.

import { createHash, randomBytes } from 'node:crypto';
import { ONBOARDING_LABELS, PORTAL_TOKEN_RE, VENDOR_PORTAL_PERM_KEY, permAllows, portalPath } from '@theone/shared';
import type {
  FeedActor,
  OnboardingPayload,
  PortalJob,
  PortalOffer,
  PortalPurpose,
  PortalView,
  VendorInput,
  VendorOnboardingSubmission,
  VendorPortalAdmin,
  VendorPortalLink,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify, vendorReviewerIds } from './notices.js';
import { requirePerm } from './permissions.js';
import { serviceActorId } from './serviceActors.js';
import { answerOffer, getDispatchSettings } from './vendorExtras.js';
import { assertVendorInScope, requireVendorsView, updateVendor } from './vendors.js';
import { logTaskChanges } from './woAudit.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPANY = 'Seamless FM';
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const clean = (v: unknown, max = 300): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.trim().slice(0, max);
  return s === '' ? null : s;
};
const portalActor = (): Promise<string> => serviceActorId('Vendor portal', 'VP');

// ═══ Staff side: links and onboarding decisions ══════════════════════════════

async function gate(vendorId: string, actor: ActingPrincipal, action: 'view' | 'edit'): Promise<void> {
  if (!UUID_RE.test(vendorId)) throw notFound('No such vendor');
  requireVendorsView(actor);
  requirePerm(actor, VENDOR_PORTAL_PERM_KEY, action, action === 'view' ? 'You cannot see vendor portal links' : 'You cannot manage vendor portal links');
  await assertVendorInScope(actor, vendorId);
}

async function peopleByIds(ids: (string | null | undefined)[]): Promise<Map<string, FeedActor>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x) && UUID_RE.test(x!)))];
  if (want.length === 0) return new Map();
  const res = await query<FeedActor>(`SELECT id::text AS id, display_name AS name, kind FROM principal WHERE id = ANY($1::uuid[])`, [want]);
  return new Map(res.rows.map((r) => [r.id, r]));
}

export async function portalAdmin(vendorId: string, actor: ActingPrincipal): Promise<VendorPortalAdmin> {
  const canView = permAllows(actor.perms, VENDOR_PORTAL_PERM_KEY, 'view', actor.isSuperAdmin);
  if (!canView) return { links: [], submissions: [], can: { view: false, edit: false } };
  await gate(vendorId, actor, 'view');
  const [links, subs] = await Promise.all([
    query<{ id: string; purpose: PortalPurpose; created_at: Date; created_by: string | null; expires_at: Date | null; revoked_at: Date | null; last_used_at: Date | null; use_count: number }>(
      `SELECT id::text AS id, purpose, created_at, created_by::text AS created_by, expires_at, revoked_at, last_used_at, use_count
         FROM vendor_portal_link WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [vendorId],
    ),
    query<{ id: string; payload: OnboardingPayload; status: VendorOnboardingSubmission['status']; submitted_at: Date; decided_by: string | null; decided_at: Date | null; decision_note: string | null }>(
      `SELECT id::text AS id, payload, status, submitted_at, decided_by::text AS decided_by, decided_at, decision_note
         FROM vendor_onboarding WHERE vendor_id = $1 ORDER BY submitted_at DESC LIMIT 20`,
      [vendorId],
    ),
  ]);
  const people = await peopleByIds([...links.rows.map((l) => l.created_by), ...subs.rows.map((s) => s.decided_by)]);
  const now = Date.now();
  return {
    links: links.rows.map((l): VendorPortalLink => ({
      id: l.id,
      purpose: l.purpose,
      created_at: l.created_at.toISOString(),
      created_by: l.created_by ? (people.get(l.created_by) ?? null) : null,
      expires_at: iso(l.expires_at),
      revoked_at: iso(l.revoked_at),
      last_used_at: iso(l.last_used_at),
      use_count: l.use_count,
      live: l.revoked_at === null && (l.expires_at === null || l.expires_at.getTime() > now),
    })),
    submissions: subs.rows.map((s) => ({
      id: s.id,
      payload: s.payload,
      status: s.status,
      submitted_at: s.submitted_at.toISOString(),
      decided_by: s.decided_by ? (people.get(s.decided_by) ?? null) : null,
      decided_at: iso(s.decided_at),
      decision_note: s.decision_note,
    })),
    can: { view: true, edit: permAllows(actor.perms, VENDOR_PORTAL_PERM_KEY, 'edit', actor.isSuperAdmin) },
  };
}

/** Make a link. The answer carries the address ONCE; it cannot be read back. */
export async function createPortalLink(vendorId: string, input: { purpose: PortalPurpose; days?: number | null }, origin: string, actor: ActingPrincipal): Promise<VendorPortalAdmin & { url: string }> {
  await gate(vendorId, actor, 'edit');
  const v = await query<{ name: string; blacklisted: boolean }>(`SELECT name, blacklisted FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [vendorId]);
  if (!v.rows[0]) throw notFound('No such vendor');
  if (v.rows[0].blacklisted) throw conflict(`${v.rows[0].name} is blacklisted: no portal link can be made`);
  const days = input.days === null || input.days === undefined ? (input.purpose === 'onboarding' ? 30 : 180) : Math.max(1, Math.min(730, Math.round(input.days)));
  const token = randomBytes(24).toString('base64url'); // 32 url-safe characters
  await query(
    `INSERT INTO vendor_portal_link (vendor_id, token_hash, purpose, expires_at, created_by) VALUES ($1, $2, $3, now() + make_interval(days => $4), $5)`,
    [vendorId, hash(token), input.purpose, days, actor.id],
  );
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: 'vendor_portal_link_created', after: { name: v.rows[0].name, purpose: input.purpose, days } });
  return { ...(await portalAdmin(vendorId, actor)), url: `${origin.replace(/\/+$/, '')}${portalPath(token)}` };
}

export async function revokePortalLink(vendorId: string, linkId: string, actor: ActingPrincipal): Promise<VendorPortalAdmin> {
  await gate(vendorId, actor, 'edit');
  if (!UUID_RE.test(linkId)) throw notFound('That link does not exist');
  const res = await query<{ purpose: string }>(`UPDATE vendor_portal_link SET revoked_at = now() WHERE id = $1 AND vendor_id = $2 AND revoked_at IS NULL RETURNING purpose`, [linkId, vendorId]);
  if (!res.rows[0]) throw notFound('That link does not exist or is already revoked');
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: 'vendor_portal_link_revoked', after: { name: res.rows[0].purpose } });
  return portalAdmin(vendorId, actor);
}

/** The allowlist: only these keys are ever read from what a vendor sends. */
function cleanPayload(raw: unknown): OnboardingPayload {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown, max: number, each = 80): string[] | undefined =>
    Array.isArray(v) ? [...new Set(v.map((x) => clean(x, each)).filter((x): x is string => x !== null))].slice(0, max) : undefined;
  const bool = (v: unknown): boolean | null | undefined => (typeof v === 'boolean' ? v : v === null ? null : undefined);
  const money = (v: unknown): number | null | undefined => {
    if (v === null) return null;
    const n = typeof v === 'number' ? v : NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100_000 ? Math.round(n * 100) / 100 : undefined;
  };
  const out: OnboardingPayload = {
    legal_name: clean(r.legal_name, 200),
    dba_name: clean(r.dba_name, 200),
    email: clean(r.email, 200),
    phones: list(r.phones, 6, 40),
    city: clean(r.city, 120),
    state: clean(r.state, 40),
    zip: clean(r.zip, 12),
    primary_trade: clean(r.primary_trade, 120),
    secondary_trades: list(r.secondary_trades, 12),
    coverage_states: list(r.coverage_states, 60, 4),
    max_travel_radius: clean(r.max_travel_radius, 60),
    emergency_same_day: bool(r.emergency_same_day),
    after_hours: bool(r.after_hours),
    weekends: bool(r.weekends),
    regular_hourly_rate: money(r.regular_hourly_rate),
    after_hours_rate: money(r.after_hours_rate),
    trip_charge: money(r.trip_charge),
    primary_contact_name: clean(r.primary_contact_name, 160),
    primary_contact_role: clean(r.primary_contact_role, 120),
    dispatch_phone: clean(r.dispatch_phone, 40),
    billing_email: clean(r.billing_email, 200),
    has_general_liability: bool(r.has_general_liability),
    has_workers_comp: bool(r.has_workers_comp),
    notes: clean(r.notes, 2000),
  };
  for (const k of Object.keys(out) as (keyof OnboardingPayload)[]) if (out[k] === undefined || !(k in ONBOARDING_LABELS)) delete out[k];
  return out;
}

export async function decideOnboarding(vendorId: string, submissionId: string, decision: 'accept' | 'reject', note: string | null, actor: ActingPrincipal): Promise<VendorPortalAdmin> {
  await gate(vendorId, actor, 'edit');
  if (!UUID_RE.test(submissionId)) throw notFound('That form does not exist');
  const cur = await query<{ payload: unknown; status: string }>(`SELECT payload, status FROM vendor_onboarding WHERE id = $1 AND vendor_id = $2`, [submissionId, vendorId]);
  if (!cur.rows[0]) throw notFound('That form does not exist');
  if (cur.rows[0].status !== 'submitted') throw conflict('That form was already decided');
  if (decision === 'accept') {
    requirePerm(actor, 'vendors', 'edit', 'You cannot edit vendors');
    const p = cleanPayload(cur.rows[0].payload);
    const input: VendorInput = {};
    // Only what the vendor actually filled in: an empty answer never wipes
    // what is on file.
    const text = ['legal_name', 'dba_name', 'email', 'city', 'state', 'zip', 'primary_trade', 'max_travel_radius', 'primary_contact_name', 'primary_contact_role', 'dispatch_phone', 'billing_email'] as const;
    for (const k of text) if (p[k]) input[k] = p[k];
    for (const k of ['emergency_same_day', 'after_hours', 'weekends'] as const) if (typeof p[k] === 'boolean') input[k] = p[k];
    for (const k of ['regular_hourly_rate', 'after_hours_rate', 'trip_charge'] as const) if (typeof p[k] === 'number') input[k] = p[k];
    if (p.secondary_trades?.length) input.secondary_trades = p.secondary_trades;
    if (p.coverage_states?.length) input.coverage_states = p.coverage_states.map((s) => s.toUpperCase());
    if (p.phones?.length) input.phones = p.phones.map((phone) => ({ phone }));
    const extra = [
      typeof p.has_general_liability === 'boolean' ? `General liability insurance: ${p.has_general_liability ? 'yes' : 'no'}` : null,
      typeof p.has_workers_comp === 'boolean' ? `Workers’ compensation: ${p.has_workers_comp ? 'yes' : 'no'}` : null,
      p.notes ? `From the onboarding form: ${p.notes}` : null,
    ].filter(Boolean);
    if (Object.keys(input).length > 0) await updateVendor(vendorId, input, actor);
    if (extra.length > 0) {
      await query(`INSERT INTO vendor_note (vendor_id, author_id, body) VALUES ($1, $2, $3)`, [vendorId, actor.id, extra.join('\n')]).catch(() => undefined);
    }
  } else if (!clean(note, 500)) {
    throw badRequest('Say why the form is sent back', { field: 'note' });
  }
  await query(`UPDATE vendor_onboarding SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1 AND vendor_id = $2`, [
    submissionId,
    vendorId,
    decision === 'accept' ? 'accepted' : 'rejected',
    actor.id,
    clean(note, 500),
  ]);
  await logAdminEvent({ actorId: actor.id, entity: 'vendor', entityId: vendorId, action: decision === 'accept' ? 'vendor_onboarding_accepted' : 'vendor_onboarding_rejected', after: { name: 'Onboarding form', note: clean(note, 500) } });
  return portalAdmin(vendorId, actor);
}

// ═══ Vendor side: everything below is reached with a token and nothing else ══

interface Resolved {
  link_id: string;
  vendor_id: string;
  purpose: PortalPurpose;
  name: string;
  primary_trade: string | null;
  city: string | null;
  state: string | null;
}

const gone = (): ApiError => notFound('This link is not valid any more. Ask your contact for a new one.');

async function resolve(token: string): Promise<Resolved> {
  if (!PORTAL_TOKEN_RE.test(token)) throw gone();
  const res = await query<Resolved>(
    `SELECT l.id::text AS link_id, v.id::text AS vendor_id, l.purpose, v.name, v.primary_trade, v.city, v.state
       FROM vendor_portal_link l JOIN vendor v ON v.id = l.vendor_id
      WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())
        AND v.deleted_at IS NULL AND NOT v.blacklisted`,
    [hash(token)],
  );
  if (!res.rows[0]) throw gone();
  return res.rows[0];
}

async function touch(linkId: string): Promise<void> {
  await query(`UPDATE vendor_portal_link SET last_used_at = now(), use_count = use_count + 1 WHERE id = $1`, [linkId]).catch(() => undefined);
}

type JobRow = {
  id: string;
  wo_number: string;
  client: string | null;
  store: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  description: string | null;
  status_name: string;
  open: boolean;
  emergency: boolean;
  eta_at: Date | null;
  scheduled: string | null;
  responsible: boolean;
};

/** The columns a vendor may see of a job. Nothing else is selected. */
const JOB_SELECT = `
  SELECT t.id::text AS id, t.wo_number, t.client, t.fields->>'Store' AS store, t.fields->>'17. Address' AS address, t.city, t.state, t.trade,
         COALESCE(NULLIF(t.fields->>'35. WO Description', ''), t.description) AS description, st.name AS status_name,
         (t.status_group::text NOT IN ('done', 'closed') AND t.cancelled_at IS NULL) AS open,
         lower(COALESCE(t.fields->>'Emergency', '')) IN ('true', 'yes') AS emergency,
         t.eta_at, NULLIF(t.fields->>'Scheduled Date', '') AS scheduled`;

/** A status as an outsider reads it: the leading number and the emoji go. */
const plainStatus = (s: string): string => s.replace(/^\s*\d+[.)]?\s*/, '').replace(/[^\x20-\x7E]/g, '').trim() || s;

async function notesFor(vendorId: string, taskIds: string[]): Promise<Map<string, { body: string; created_at: string }[]>> {
  const out = new Map<string, { body: string; created_at: string }[]>();
  if (taskIds.length === 0) return out;
  const res = await query<{ task_id: string; body: string; created_at: Date }>(
    `SELECT task_id::text AS task_id, body, created_at FROM vendor_portal_note WHERE vendor_id = $1 AND task_id = ANY($2::uuid[]) ORDER BY created_at`,
    [vendorId, taskIds],
  );
  for (const r of res.rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), { body: r.body, created_at: r.created_at.toISOString() }]);
  return out;
}

const mapJob = (r: JobRow, notes: Map<string, { body: string; created_at: string }[]>): PortalJob => ({
  ref: r.id,
  wo_number: r.wo_number,
  client: r.client,
  store: r.store,
  address: r.address,
  city: r.city,
  state: r.state,
  trade: r.trade,
  description: r.description ? r.description.slice(0, 2000) : null,
  status: plainStatus(r.status_name),
  emergency: r.emergency,
  role: r.responsible ? 'responsible' : 'technician',
  eta_at: iso(r.eta_at),
  scheduled_at: r.scheduled,
  open: r.open,
  notes: notes.get(r.id) ?? [],
});

/** The jobs this vendor holds: open ones, and those finished in the last 30 days. */
async function jobsOf(vendorId: string): Promise<PortalJob[]> {
  const res = await query<JobRow>(
    `${JOB_SELECT}, (t.vendor_id = $1) AS responsible
       FROM task t JOIN status st ON st.id = t.status_id
      WHERE t.deleted_at IS NULL
        AND (t.vendor_id = $1 OR EXISTS (SELECT 1 FROM wo_technician wt WHERE wt.task_id = t.id AND wt.vendor_id = $1 AND wt.released_at IS NULL))
        AND ((t.status_group::text NOT IN ('done', 'closed') AND t.cancelled_at IS NULL) OR t.updated_at > now() - interval '30 days')
      ORDER BY (t.status_group::text NOT IN ('done', 'closed') AND t.cancelled_at IS NULL) DESC, t.updated_at DESC
      LIMIT 200`,
    [vendorId],
  );
  const notes = await notesFor(vendorId, res.rows.map((r) => r.id));
  return res.rows.map((r) => mapJob(r, notes));
}

async function offersFor(vendorId: string): Promise<PortalOffer[]> {
  const res = await query<JobRow & { offer_id: string; offered_at: Date; expires_at: Date | null }>(
    `${JOB_SELECT}, false AS responsible, o.id::text AS offer_id, o.offered_at, o.expires_at
       FROM wo_dispatch_offer o JOIN task t ON t.id = o.task_id JOIN status st ON st.id = t.status_id
      WHERE o.vendor_id = $1 AND o.status = 'offered' AND (o.expires_at IS NULL OR o.expires_at > now()) AND t.deleted_at IS NULL
      ORDER BY o.offered_at`,
    [vendorId],
  );
  return res.rows.map((r) => ({ id: r.offer_id, job: mapJob(r, new Map()), offered_at: r.offered_at.toISOString(), expires_at: iso(r.expires_at) }));
}

export async function portalView(token: string): Promise<PortalView> {
  const v = await resolve(token);
  await touch(v.link_id);
  const base = { purpose: v.purpose, vendor: { name: v.name, primary_trade: v.primary_trade, city: v.city, state: v.state }, company: COMPANY };
  if (v.purpose === 'onboarding') {
    const [cur, phones, last, trades] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT legal_name, dba_name, email, city, state, zip, primary_trade, secondary_trades, coverage_states, max_travel_radius, emergency_same_day,
                after_hours, weekends, regular_hourly_rate, after_hours_rate, trip_charge, primary_contact_name, primary_contact_role, dispatch_phone, billing_email
           FROM vendor WHERE id = $1`,
        [v.vendor_id],
      ),
      query<{ display: string }>(`SELECT display FROM vendor_phone WHERE vendor_id = $1 ORDER BY position`, [v.vendor_id]),
      query<{ status: 'submitted' | 'accepted' | 'rejected'; submitted_at: Date; decision_note: string | null }>(
        `SELECT status, submitted_at, decision_note FROM vendor_onboarding WHERE vendor_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
        [v.vendor_id],
      ),
      query<{ name: string }>(`SELECT name FROM vendor_trade ORDER BY lower(name)`).catch(() => ({ rows: [] as { name: string }[] })),
    ]);
    const c = cur.rows[0] ?? {};
    const numOr = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));
    return {
      ...base,
      onboarding: {
        current: {
          ...(cleanPayload({ ...c, regular_hourly_rate: numOr(c.regular_hourly_rate), after_hours_rate: numOr(c.after_hours_rate), trip_charge: numOr(c.trip_charge) })),
          phones: phones.rows.map((p) => p.display),
        },
        trades: trades.rows.map((t) => t.name),
        submitted_at: last.rows[0] ? last.rows[0].submitted_at.toISOString() : null,
        status: last.rows[0]?.status ?? null,
        // Only a "sent back" reason goes to the vendor.
        decision_note: last.rows[0]?.status === 'rejected' ? last.rows[0].decision_note : null,
      },
    };
  }
  const settings = await getDispatchSettings();
  // A lapsed offer is not shown; the run itself moves on when one of us (or
  // the daily clock) next looks at the work order.
  const [offers, jobs, expiries] = await Promise.all([
    settings.enabled ? offersFor(v.vendor_id) : Promise.resolve([]),
    jobsOf(v.vendor_id),
    query<{ insurance_type: string; expires_on: string; expired: boolean }>(
      `SELECT DISTINCT ON (insurance_type) insurance_type, to_char(expires_on, 'YYYY-MM-DD') AS expires_on, expires_on < now()::date AS expired
         FROM vendor_expiry WHERE vendor_id = $1 ORDER BY insurance_type, expires_on DESC`,
      [v.vendor_id],
    ),
  ]);
  return { ...base, offers, jobs, compliance: expiries.rows.map((e) => ({ label: e.insurance_type, expires_on: e.expires_on, expired: e.expired })) };
}

export async function portalSubmitOnboarding(token: string, raw: unknown): Promise<PortalView> {
  const v = await resolve(token);
  if (v.purpose !== 'onboarding') throw gone();
  const payload = cleanPayload(raw);
  if (!payload.legal_name && !payload.dba_name) throw badRequest('Give your business name.');
  if (!payload.phones?.length && !payload.email) throw badRequest('Give a phone number or an email we can reach you on.');
  // A form can be corrected and sent again, but not endlessly.
  const recent = await query<{ n: number }>(`SELECT count(*)::int AS n FROM vendor_onboarding WHERE vendor_id = $1 AND submitted_at > now() - interval '1 day'`, [v.vendor_id]);
  if (Number(recent.rows[0]?.n ?? 0) >= 5) throw new ApiError('CONFLICT', 'This form was sent several times today. Please try again tomorrow, or call your contact.');
  // One waiting form at a time: a newer one replaces the one still waiting.
  await query(`DELETE FROM vendor_onboarding WHERE vendor_id = $1 AND status = 'submitted'`, [v.vendor_id]);
  await query(`INSERT INTO vendor_onboarding (vendor_id, link_id, payload) VALUES ($1, $2, $3::jsonb)`, [v.vendor_id, v.link_id, JSON.stringify(payload)]);
  await touch(v.link_id);
  await notify(await vendorReviewerIds(), {
    kind: 'vendor_onboarding',
    title: `${v.name} sent their onboarding form`,
    body: 'Review it on the vendor’s record, under Portal.',
    link: `/vendors/${v.vendor_id}`,
  });
  return portalView(token);
}

/** The job, only if this vendor holds it. */
async function heldJob(vendorId: string, ref: string): Promise<{ id: string; wo_number: string; open: boolean }> {
  if (!UUID_RE.test(ref)) throw notFound('That job is not on your list');
  const res = await query<{ id: string; wo_number: string; open: boolean }>(
    `SELECT t.id::text AS id, t.wo_number, (t.status_group::text NOT IN ('done', 'closed') AND t.cancelled_at IS NULL) AS open
       FROM task t
      WHERE t.id = $2 AND t.deleted_at IS NULL
        AND (t.vendor_id = $1 OR EXISTS (SELECT 1 FROM wo_technician wt WHERE wt.task_id = t.id AND wt.vendor_id = $1 AND wt.released_at IS NULL))`,
    [vendorId, ref],
  );
  if (!res.rows[0]) throw notFound('That job is not on your list');
  return res.rows[0];
}

export async function portalAnswerOffer(token: string, offerId: string, answer: 'accept' | 'decline', note: string | null): Promise<PortalView> {
  const v = await resolve(token);
  if (v.purpose !== 'portal') throw gone();
  if (!UUID_RE.test(offerId)) throw notFound('That offer is not open any more');
  // The offer must be THIS vendor's, still open and still inside its window.
  const own = await query(`SELECT 1 FROM wo_dispatch_offer WHERE id = $1 AND vendor_id = $2 AND status = 'offered' AND (expires_at IS NULL OR expires_at > now())`, [offerId, v.vendor_id]);
  if (!own.rows[0]) throw notFound('That offer is not open any more');
  await answerOffer(offerId, answer, clean(note, 500), 'portal', await portalActor());
  await touch(v.link_id);
  return portalView(token);
}

export async function portalSetEta(token: string, ref: string, etaAt: string): Promise<PortalView> {
  const v = await resolve(token);
  if (v.purpose !== 'portal') throw gone();
  const job = await heldJob(v.vendor_id, ref);
  if (!job.open) throw conflict('That job is closed');
  const at = new Date(etaAt);
  if (Number.isNaN(at.getTime())) throw badRequest('That is not a date and time');
  if (at.getTime() < Date.now() - 3600_000 || at.getTime() > Date.now() + 366 * 86_400_000) throw badRequest('Give a date and time from now on.');
  const actorId = await portalActor();
  const before = await query<{ eta_at: Date | null }>(`SELECT eta_at FROM task WHERE id = $1`, [job.id]);
  await query(`UPDATE task SET eta_at = $2, eta_note = $3, eta_by = $4 WHERE id = $1`, [job.id, at, `Given by ${v.name} on the vendor portal`, actorId]);
  await logTaskChanges({ query: (sql, params) => query(sql, params) }, actorId, job.id, [
    { field: 'ETA', before: iso(before.rows[0]?.eta_at ?? null), after: `${at.toISOString()} (given by ${v.name} on the vendor portal)` },
  ]);
  await touch(v.link_id);
  return portalView(token);
}

export async function portalAddNote(token: string, ref: string, body: string): Promise<PortalView> {
  const v = await resolve(token);
  if (v.purpose !== 'portal') throw gone();
  const job = await heldJob(v.vendor_id, ref);
  const text = clean(body, 2000);
  if (!text) throw badRequest('Write the note first.');
  const recent = await query<{ n: number }>(`SELECT count(*)::int AS n FROM vendor_portal_note WHERE vendor_id = $1 AND created_at > now() - interval '1 hour'`, [v.vendor_id]);
  if (Number(recent.rows[0]?.n ?? 0) >= 30) throw new ApiError('CONFLICT', 'That is a lot of notes in one hour. Please call your contact instead.');
  const actorId = await portalActor();
  await query(`INSERT INTO vendor_portal_note (task_id, vendor_id, body) VALUES ($1, $2, $3)`, [job.id, v.vendor_id, text]);
  // The same words on the work order, as an internal note that says where it
  // came from. Never client-visible.
  const ins = await query<{ id: string }>(
    `INSERT INTO comment (task_id, author_principal_id, body, client_visible) VALUES ($1, $2, $3, false) RETURNING id::text AS id`,
    [job.id, actorId, `From the vendor portal — ${v.name}:\n${text}`],
  );
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, 'comment_added', NULL, NULL, $3::jsonb)`,
    [actorId, job.id, JSON.stringify({ comment_id: ins.rows[0].id, client_visible: false, source: 'vendor_portal', vendor: v.name })],
  );
  const who = await query<{ id: string }>(
    `SELECT p.id::text AS id FROM task t, unnest(string_to_array(COALESCE(NULLIF(t.fields->>'Assignee', ''), ''), ',')) AS a(n)
       JOIN principal p ON lower(p.display_name) = lower(btrim(a.n)) AND p.kind = 'human'
      WHERE t.id = $1`,
    [job.id],
  );
  await notify(who.rows.map((r) => r.id), { kind: 'vendor_portal', title: `${v.name} left a note on ${job.wo_number}`, body: text.slice(0, 200), link: `/work-orders/${encodeURIComponent(job.wo_number)}?tab=messages` });
  await touch(v.link_id);
  return portalView(token);
}

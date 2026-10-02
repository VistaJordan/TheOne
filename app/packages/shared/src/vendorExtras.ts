// 0066 · Vendors, the rest: invoicing rules and credit notes, the dispatch
// cascade, skills / inductions / consumables, performance, and the vendor
// portal. The vocabulary the API and the browser share.

import type { FeedActor } from './index';
import type { PermNode } from './permissions';

export const VENDOR_PORTAL_PERM_KEY = 'vendors/portal';
export const VENDOR_DISPATCH_PERM_KEY = 'vendors/dispatch';

export function vendorExtraPermNodes(): PermNode[] {
  return [
    {
      key: VENDOR_PORTAL_PERM_KEY,
      label: 'Vendor portal',
      actions: ['view', 'edit'],
      note: 'Edit = make and revoke a vendor’s portal or onboarding link, and accept what a vendor sent in.',
    },
    {
      key: VENDOR_DISPATCH_PERM_KEY,
      label: 'Dispatch offers',
      actions: ['view', 'edit'],
      note: 'Edit = offer a work order to the preferred vendors in turn, record an answer, stop the run.',
    },
  ];
}

// ── Invoicing rules ──────────────────────────────────────────────────────────

/** The checks a vendor bill is read against. None of them blocks: each one
 *  that fails is a warning on the bill. */
export interface BillRules {
  /** A bill must carry the vendor's invoice number. */
  bill_number_required: boolean;
  /** The same vendor sent this invoice number before. */
  duplicate_number: boolean;
  /** The vendor's bills on the work order add up to more than its Cost. */
  over_cost: boolean;
  /** The vendor is neither responsible for the work order nor hired onto it. */
  vendor_not_on_wo: boolean;
  /** The bill arrived before the service was completed. */
  before_completion: boolean;
  /** The bill arrived more than this many days after completion; 0 = off. */
  late_days: number;
  /** A credit note above this amount waits for an approver; 0 = every one. */
  credit_approval_over: number;
}

export const BILL_RULE_DEFAULTS: BillRules = {
  bill_number_required: true,
  duplicate_number: true,
  over_cost: true,
  vendor_not_on_wo: true,
  before_completion: true,
  late_days: 30,
  credit_approval_over: 250,
};

export const BILL_RULE_LABELS: { key: keyof BillRules; label: string; hint: string; kind: 'bool' | 'days' | 'amount' }[] = [
  { key: 'bill_number_required', label: 'Invoice number missing', hint: 'Warn when a bill has no vendor invoice number.', kind: 'bool' },
  { key: 'duplicate_number', label: 'Invoice number used before', hint: 'Warn when the same vendor already sent a bill with this number.', kind: 'bool' },
  { key: 'over_cost', label: 'Over the work order’s Cost', hint: 'Warn when a vendor’s bills on a work order add up to more than its Cost.', kind: 'bool' },
  { key: 'vendor_not_on_wo', label: 'Vendor not on the work order', hint: 'Warn when the vendor is neither responsible for the work order nor hired onto it.', kind: 'bool' },
  { key: 'before_completion', label: 'Billed before completion', hint: 'Warn when a bill arrives before the service was completed.', kind: 'bool' },
  { key: 'late_days', label: 'Billed late', hint: 'Warn when a bill arrives more than this many days after completion. 0 switches it off.', kind: 'days' },
  { key: 'credit_approval_over', label: 'Credit notes that need approval', hint: 'A credit note above this amount waits for somebody who approves payments. 0 = every credit note.', kind: 'amount' },
];

export function cleanBillRules(raw: unknown): BillRules {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const bool = (k: keyof BillRules) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (BILL_RULE_DEFAULTS[k] as boolean));
  const numb = (k: keyof BillRules, max: number) => {
    const n = Number(r[k]);
    return Number.isFinite(n) && n >= 0 ? Math.min(max, Math.round(n)) : (BILL_RULE_DEFAULTS[k] as number);
  };
  return {
    bill_number_required: bool('bill_number_required'),
    duplicate_number: bool('duplicate_number'),
    over_cost: bool('over_cost'),
    vendor_not_on_wo: bool('vendor_not_on_wo'),
    before_completion: bool('before_completion'),
    late_days: numb('late_days', 3650),
    credit_approval_over: numb('credit_approval_over', 10_000_000),
  };
}

export interface BillWarning {
  rule: keyof BillRules;
  message: string;
}

/** What one bill is checked with. Everything the rules need, already read. */
export interface BillFacts {
  bill_number: string | null;
  received_on: string;
  /** Other live bills of the same vendor carrying the same number. */
  same_number: number;
  /** This vendor's live bills on the work order, this one included. */
  vendor_total_on_wo: number;
  /** The work order's Cost; null when none is set. */
  wo_cost: number | null;
  /** The bill names a vendor record. */
  has_vendor: boolean;
  /** That vendor is responsible for the work order or hired onto it. */
  vendor_on_wo: boolean;
  /** YYYY-MM-DD the service was completed; null = not yet. */
  completed_on: string | null;
}

const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const money = (n: number): string => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function billWarnings(f: BillFacts, rules: BillRules): BillWarning[] {
  const out: BillWarning[] = [];
  if (rules.bill_number_required && !(f.bill_number ?? '').trim()) out.push({ rule: 'bill_number_required', message: 'No vendor invoice number.' });
  if (rules.duplicate_number && f.same_number > 0) out.push({ rule: 'duplicate_number', message: 'This vendor already sent a bill with this invoice number.' });
  if (rules.over_cost && f.wo_cost !== null && f.vendor_total_on_wo > f.wo_cost + 0.005) {
    out.push({ rule: 'over_cost', message: `This vendor’s bills on the work order come to ${money(f.vendor_total_on_wo)}, over its Cost of ${money(f.wo_cost)}.` });
  }
  if (rules.vendor_not_on_wo && f.has_vendor && !f.vendor_on_wo) out.push({ rule: 'vendor_not_on_wo', message: 'This vendor is neither responsible for the work order nor hired onto it.' });
  if (rules.before_completion && f.completed_on === null) out.push({ rule: 'before_completion', message: 'The service on this work order is not completed yet.' });
  if (rules.before_completion && f.completed_on !== null && f.received_on < f.completed_on) out.push({ rule: 'before_completion', message: 'The bill is dated before the service was completed.' });
  if (rules.late_days > 0 && f.completed_on !== null && daysBetween(f.completed_on, f.received_on) > rules.late_days) {
    out.push({ rule: 'late_days', message: `Received ${daysBetween(f.completed_on, f.received_on)} days after completion (the limit is ${rules.late_days}).` });
  }
  return out;
}

// ── Credit notes ─────────────────────────────────────────────────────────────

export type CreditNoteStatus = 'pending' | 'approved' | 'void';
export const CREDIT_NOTE_STATUS_LABELS: Record<CreditNoteStatus, string> = { pending: 'Waiting for approval', approved: 'Approved', void: 'Void' };

export interface VendorCreditNote {
  id: string;
  credit_number: string;
  bill_id: string;
  amount: number;
  reason: string;
  vendor_ref: string | null;
  status: CreditNoteStatus;
  created_by: FeedActor | null;
  created_at: string;
  decided_by: FeedActor | null;
  decided_at: string | null;
  void_reason: string | null;
}

/** Why a credit note cannot be raised; null when it can. `credited` is what
 *  the bill's live (pending + approved) credit notes already come to. */
export function creditNoteProblem(amount: number, reason: string, billTotal: number, credited: number, billStatus: string): string | null {
  if (billStatus === 'void') return 'A void bill cannot be credited.';
  if (!(Number.isFinite(amount) && amount > 0)) return 'The credit must be more than zero.';
  if (!reason.trim()) return 'Say what the credit is for.';
  if (amount + credited > billTotal + 0.005) return `That is more than is left on the bill (${money(Math.max(0, billTotal - credited))}).`;
  return null;
}

/** Whether a credit note of this amount waits for an approver. */
export function creditNeedsApproval(amount: number, rules: BillRules): boolean {
  return amount > rules.credit_approval_over;
}

/** What a vendor bill carries on top of 0047's fields. */
export interface BillExtras {
  warnings: BillWarning[];
  credit_notes: VendorCreditNote[];
  /** The approved credit notes, summed. */
  credited: number;
  /** total − credited. */
  net_total: number;
}

// ── Dispatch cascade ─────────────────────────────────────────────────────────

export interface DispatchSettings {
  /** Off = no offers at all: the buttons are hidden and nothing runs. */
  enabled: boolean;
  /** Start a run by itself when a work order is created with no vendor. */
  auto_start: boolean;
  /** How long a vendor has to answer before the offer moves on. */
  hours: number;
}
export const DISPATCH_DEFAULTS: DispatchSettings = { enabled: false, auto_start: false, hours: 4 };

export function cleanDispatchSettings(raw: unknown): DispatchSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hours = Number(r.hours);
  return {
    enabled: r.enabled === true,
    auto_start: r.auto_start === true,
    hours: Number.isFinite(hours) && hours >= 1 ? Math.min(168, Math.round(hours)) : DISPATCH_DEFAULTS.hours,
  };
}

export type DispatchOfferStatus = 'offered' | 'accepted' | 'declined' | 'expired' | 'cancelled';
export const DISPATCH_STATUS_LABELS: Record<DispatchOfferStatus, string> = {
  offered: 'Offered',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'No answer',
  cancelled: 'Stopped',
};

export interface DispatchOffer {
  id: string;
  vendor: { id: string; name: string; phone: string | null };
  rank: number;
  status: DispatchOfferStatus;
  offered_at: string;
  expires_at: string | null;
  responded_at: string | null;
  responded_via: string | null;
  note: string | null;
}

export interface DispatchCandidate {
  vendor_id: string;
  name: string;
  rank: number;
  /** Why they are on the list: "7-Eleven · Refrigeration · TX". */
  rule: string;
  blacklisted: boolean;
  /** Already offered in this work order's history. */
  offered: boolean;
}

export interface WoDispatch {
  settings: DispatchSettings;
  offers: DispatchOffer[];
  /** The preferred vendors for this work order's client / trade / state, in order. */
  candidates: DispatchCandidate[];
  live: DispatchOffer | null;
  can: { view: boolean; edit: boolean };
}

/** The next vendor a run should offer the job to: the best-ranked candidate
 *  that is not blacklisted and has not been offered it already. */
export function nextCandidate(candidates: DispatchCandidate[]): DispatchCandidate | null {
  return candidates.filter((c) => !c.blacklisted && !c.offered).sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))[0] ?? null;
}

// ── Skills, inductions, consumables ──────────────────────────────────────────

export const SKILL_LEVELS = ['basic', 'skilled', 'expert'] as const;
export type SkillLevel = (typeof SKILL_LEVELS)[number];
export const SKILL_LEVEL_LABELS: Record<SkillLevel, string> = { basic: 'Basic', skilled: 'Skilled', expert: 'Expert' };

export interface VendorSkill {
  id: string;
  skill: string;
  level: SkillLevel;
  certified_until: string | null;
  note: string | null;
  /** The certificate has run out. */
  expired: boolean;
}

export interface VendorInduction {
  id: string;
  title: string;
  client: string | null;
  completed_on: string | null;
  expires_on: string | null;
  note: string | null;
  /** 'pending' = not done yet; 'expired' = its last day has passed. */
  state: 'pending' | 'current' | 'expired';
}

export function inductionState(completedOn: string | null, expiresOn: string | null, today: string): VendorInduction['state'] {
  if (!completedOn) return 'pending';
  if (expiresOn !== null && today > expiresOn) return 'expired';
  return 'current';
}

export interface ConsumableItem {
  id: string;
  name: string;
  unit: string;
  unit_cost: number | null;
  is_active: boolean;
}

export interface WoConsumable {
  id: string;
  consumable_id: string | null;
  name: string;
  unit: string;
  qty: number;
  unit_cost: number | null;
  vendor: { id: string; name: string } | null;
  note: string | null;
  added_by: FeedActor | null;
  added_at: string;
}

export interface WoConsumablesResponse {
  items: WoConsumable[];
  total_cost: number;
  catalogue: ConsumableItem[];
  technicians: { vendor_id: string; name: string }[];
  can: { edit: boolean };
}

export interface VendorQualifications {
  skills: VendorSkill[];
  inductions: VendorInduction[];
  /** What this vendor used on jobs, most recent first. */
  consumables: { wo_number: string; name: string; qty: number; unit: string; unit_cost: number | null; added_at: string }[];
  skill_list: { name: string; trade: string | null }[];
  clients: string[];
  can: { edit: boolean };
}

export interface VendorCatalogues {
  skills: { id: string; name: string; trade: string | null; is_active: boolean; used: number }[];
  consumables: (ConsumableItem & { used: number })[];
  bill_rules: BillRules;
  dispatch: DispatchSettings;
  can: { edit: boolean };
}

// ── Performance ──────────────────────────────────────────────────────────────

export interface VendorPerformanceRow {
  vendor_id: string;
  name: string;
  kind: string;
  primary_trade: string | null;
  /** Work orders they were responsible for or hired onto, in the range. */
  jobs: number;
  completed: number;
  open: number;
  /** Completed with an SLA date: how many made it, how many did not. */
  sla_met: number;
  sla_missed: number;
  /** Work orders tagged Recall. */
  recalls: number;
  temporary_fixes: number;
  /** Offers answered: accepted against declined / no answer. */
  offers: number;
  offers_accepted: number;
  /** Hours from the first offer or hire to the first check-in, averaged. */
  avg_response_hours: number | null;
  /** Their bills on those work orders. */
  billed: number;
  bill_warnings: number;
}

export interface VendorPerformanceResponse {
  from: string;
  to: string;
  rows: VendorPerformanceRow[];
  totals: { jobs: number; completed: number; sla_met: number; sla_missed: number; recalls: number; billed: number };
}

/** "92%" of the completed jobs that had an SLA date; null when none did. */
export function slaRate(met: number, missed: number): number | null {
  const n = met + missed;
  return n === 0 ? null : Math.round((met / n) * 100);
}

// ── The portal ───────────────────────────────────────────────────────────────

export type PortalPurpose = 'onboarding' | 'portal';
export const PORTAL_PURPOSE_LABELS: Record<PortalPurpose, string> = { onboarding: 'Onboarding form', portal: 'Job portal' };

export const PORTAL_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
export const portalPath = (token: string): string => `/vendor-portal/${token}`;

export interface VendorPortalLink {
  id: string;
  purpose: PortalPurpose;
  created_at: string;
  created_by: FeedActor | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  use_count: number;
  live: boolean;
  /** Present once, in the answer to the call that made the link. */
  url?: string;
}

/** What a vendor may send in on the onboarding form. A fixed list: nothing
 *  else in the body is read. */
export interface OnboardingPayload {
  legal_name?: string | null;
  dba_name?: string | null;
  email?: string | null;
  phones?: string[];
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  primary_trade?: string | null;
  secondary_trades?: string[];
  coverage_states?: string[];
  max_travel_radius?: string | null;
  emergency_same_day?: boolean | null;
  after_hours?: boolean | null;
  weekends?: boolean | null;
  regular_hourly_rate?: number | null;
  after_hours_rate?: number | null;
  trip_charge?: number | null;
  primary_contact_name?: string | null;
  primary_contact_role?: string | null;
  dispatch_phone?: string | null;
  billing_email?: string | null;
  has_general_liability?: boolean | null;
  has_workers_comp?: boolean | null;
  notes?: string | null;
}

export const ONBOARDING_LABELS: Record<keyof OnboardingPayload, string> = {
  legal_name: 'Legal business name',
  dba_name: 'Doing business as',
  email: 'Company email',
  phones: 'Phone numbers',
  city: 'City',
  state: 'State',
  zip: 'ZIP',
  primary_trade: 'Primary trade',
  secondary_trades: 'Other trades',
  coverage_states: 'States covered',
  max_travel_radius: 'How far you travel',
  emergency_same_day: 'Same-day emergencies',
  after_hours: 'After hours',
  weekends: 'Weekends',
  regular_hourly_rate: 'Regular hourly rate',
  after_hours_rate: 'After-hours rate',
  trip_charge: 'Trip charge',
  primary_contact_name: 'Contact name',
  primary_contact_role: 'Contact role',
  dispatch_phone: 'Dispatch phone',
  billing_email: 'Billing email',
  has_general_liability: 'General liability insurance',
  has_workers_comp: 'Workers’ compensation insurance',
  notes: 'Anything else',
};

export interface VendorOnboardingSubmission {
  id: string;
  payload: OnboardingPayload;
  status: 'submitted' | 'accepted' | 'rejected';
  submitted_at: string;
  decided_by: FeedActor | null;
  decided_at: string | null;
  decision_note: string | null;
}

export interface VendorPortalAdmin {
  links: VendorPortalLink[];
  submissions: VendorOnboardingSubmission[];
  can: { view: boolean; edit: boolean };
}

/** A job as the VENDOR sees it: where, what, when. No money, no client
 *  contacts, no internal notes. */
export interface PortalJob {
  ref: string;
  wo_number: string;
  client: string | null;
  store: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  description: string | null;
  status: string;
  emergency: boolean;
  role: 'responsible' | 'technician';
  eta_at: string | null;
  scheduled_at: string | null;
  open: boolean;
  /** What this vendor wrote about it, oldest first. */
  notes: { body: string; created_at: string }[];
}

export interface PortalOffer {
  id: string;
  job: PortalJob;
  offered_at: string;
  expires_at: string | null;
}

export interface PortalView {
  purpose: PortalPurpose;
  vendor: { name: string; primary_trade: string | null; city: string | null; state: string | null };
  company: string;
  /** purpose 'onboarding': what is on file, and whether a form is waiting. */
  onboarding?: { current: OnboardingPayload; trades: string[]; submitted_at: string | null; status: 'submitted' | 'accepted' | 'rejected' | null; decision_note: string | null };
  /** purpose 'portal'. */
  offers?: PortalOffer[];
  jobs?: PortalJob[];
  compliance?: { label: string; expires_on: string; expired: boolean }[];
}

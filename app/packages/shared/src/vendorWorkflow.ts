// The vendor relations workflow (migration 0058): required fields and the
// "missing information" rule, tasks, documents and the COI review, the call
// and email log, CSV import, saved lists, alerts, daily targets. Pure
// vocabulary and rules; the SQL lives in apps/api/src/services/vendorWork.ts
// and vendorImport.ts.

import type { FeedActor } from './index';
import type { PermNode } from './permissions';
import {
  normalizeState,
  phoneDigits,
  type TriState,
  type VendorInput,
  type VendorKind,
  type VendorPriority,
} from './vendors';

// ── Permission paths ─────────────────────────────────────────────────────────

export const VENDOR_REVIEW_PERM_KEY = 'vendors/review';
export const VENDOR_DOCUMENTS_PERM_KEY = 'vendors/documents';
export const VENDOR_IMPORT_PERM_KEY = 'vendors/import';
export const VENDOR_EXPORT_PERM_KEY = 'vendors/export';
export const VENDOR_LISTS_PERM_KEY = 'vendors/lists';

/** The Roles-screen rows 0058 adds under Vendors. */
export function vendorWorkflowPermNodes(): PermNode[] {
  return [
    {
      key: VENDOR_REVIEW_PERM_KEY,
      label: 'Review queue',
      actions: ['approve'],
      note: 'Decide duplicate, missing-information and COI reviews; give tasks to other people; set daily targets.',
    },
    {
      key: VENDOR_DOCUMENTS_PERM_KEY,
      label: 'Documents',
      actions: ['create', 'delete'],
      note: 'Create = upload a W-9, MSA or certificate of insurance; delete = remove one.',
    },
    { key: VENDOR_IMPORT_PERM_KEY, label: 'Import from CSV', actions: ['create'] },
    { key: VENDOR_EXPORT_PERM_KEY, label: 'Export to CSV', actions: ['view'] },
    { key: VENDOR_LISTS_PERM_KEY, label: 'Saved lists', actions: ['create'], note: 'Save the current filters as a named list.' },
  ];
}

// ── Required fields and "missing information" ────────────────────────────────

export interface RequiredFieldDef {
  key: string;
  label: string;
  /** Required unless Admin › Vendors & map says otherwise. */
  defaultRequired: boolean;
  kind: 'text' | 'email' | 'phone' | 'phones' | 'number' | 'owner';
}

/** The fields an admin can require of a VR vendor. Technicians are never
 *  checked: a dispatcher adds them with a name, a phone, a city and a trade. */
export const VENDOR_REQUIRABLE_FIELDS: readonly RequiredFieldDef[] = [
  { key: 'name', label: 'Name', defaultRequired: true, kind: 'text' },
  { key: 'phones', label: 'At least one phone number', defaultRequired: true, kind: 'phones' },
  { key: 'email', label: 'Email', defaultRequired: true, kind: 'email' },
  { key: 'owner_id', label: 'Owner', defaultRequired: true, kind: 'owner' },
  { key: 'city', label: 'City', defaultRequired: true, kind: 'text' },
  { key: 'state', label: 'State', defaultRequired: true, kind: 'text' },
  { key: 'primary_trade', label: 'Primary trade', defaultRequired: false, kind: 'text' },
  { key: 'legal_name', label: 'Legal business name', defaultRequired: false, kind: 'text' },
  { key: 'dba_name', label: 'DBA', defaultRequired: false, kind: 'text' },
  { key: 'primary_contact_name', label: 'Contact name', defaultRequired: false, kind: 'text' },
  { key: 'dispatch_phone', label: 'Dispatch phone', defaultRequired: false, kind: 'phone' },
  { key: 'billing_email', label: 'Billing email', defaultRequired: false, kind: 'email' },
  { key: 'regular_hourly_rate', label: 'Regular hourly rate', defaultRequired: false, kind: 'number' },
  { key: 'after_hours_rate', label: 'After-hours rate', defaultRequired: false, kind: 'number' },
  { key: 'weekend_emergency_rate', label: 'Weekend / emergency rate', defaultRequired: false, kind: 'number' },
  { key: 'trip_charge', label: 'Trip charge', defaultRequired: false, kind: 'number' },
  { key: 'diagnostic_fee', label: 'Diagnostic fee', defaultRequired: false, kind: 'number' },
  { key: 'minimum_charge', label: 'Minimum charge', defaultRequired: false, kind: 'number' },
];

/** The keys required right now: the defaults, with the admin's switches on top. */
export function requiredFieldKeys(overrides: Record<string, boolean>): string[] {
  return VENDOR_REQUIRABLE_FIELDS.filter((f) => overrides[f.key] ?? f.defaultRequired).map((f) => f.key);
}

/** What people type when they have nothing to type. Counts as empty. */
const PLACEHOLDERS = new Set([
  'n/a', 'n\\a', 'na', 'n.a.', 'none', 'no', 'no email', 'noemail', 'no phone', 'nophone', 'unknown', 'unk', 'tbd',
  'tba', 'null', 'undefined', '-', '--', '---', '.', ',', '?', '??', 'x', 'xx', 'xxx',
]);

export function isBlankValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return s === '' || PLACEHOLDERS.has(s);
  }
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

export function looksLikeEmail(v: string): boolean {
  const s = v.trim();
  if (/\s/.test(s)) return false;
  const parts = s.split('@');
  return parts.length === 2 && parts[0].length > 0 && /^[^.].*\.[^.]+$/.test(parts[1]);
}

export interface FieldProblem {
  key: string;
  label: string;
  /** missing = empty or a placeholder; invalid = there, but not usable. */
  problem: 'missing' | 'invalid';
}

/** What `missingFields` reads. `phones` is every phone on the record. */
export type MissingCheckSubject = Record<string, unknown> & { phones?: string[] };

/**
 * The required fields a vendor does not carry, and the ones it carries in a
 * form nobody can use (an email with no @, a phone with four digits). Only
 * `missing` blocks a save; both are shown.
 */
export function missingFields(v: MissingCheckSubject, required: string[]): FieldProblem[] {
  const out: FieldProblem[] = [];
  for (const def of VENDOR_REQUIRABLE_FIELDS) {
    if (!required.includes(def.key)) continue;
    const value = v[def.key];
    if (def.kind === 'phones') {
      const usable = (v.phones ?? []).filter((p) => !isBlankValue(p));
      if (usable.length === 0) out.push({ key: def.key, label: def.label, problem: 'missing' });
      else if (!usable.some((p) => phoneDigits(p) !== null && phoneDigits(p)!.length >= 10)) {
        out.push({ key: def.key, label: def.label, problem: 'invalid' });
      }
      continue;
    }
    if (def.kind === 'number') {
      if (value === null || value === undefined || value === '') out.push({ key: def.key, label: def.label, problem: 'missing' });
      continue;
    }
    if (isBlankValue(value)) {
      out.push({ key: def.key, label: def.label, problem: 'missing' });
      continue;
    }
    if (def.kind === 'email' && typeof value === 'string' && !looksLikeEmail(value)) {
      out.push({ key: def.key, label: def.label, problem: 'invalid' });
    }
    if (def.kind === 'phone' && typeof value === 'string') {
      const d = phoneDigits(value);
      if (!d || d.length < 10) out.push({ key: def.key, label: def.label, problem: 'invalid' });
    }
  }
  return out;
}

// ── Tasks ────────────────────────────────────────────────────────────────────

export type VendorTaskType = 'DUPLICATE_REVIEW' | 'MISSING_INFO_REVIEW' | 'COMPLIANCE_REVIEW' | 'COMPLIANCE_FIX' | 'MANUAL';

export const VENDOR_TASK_TYPE_LABELS: Record<VendorTaskType, string> = {
  DUPLICATE_REVIEW: 'Possible duplicate',
  MISSING_INFO_REVIEW: 'Missing information',
  COMPLIANCE_REVIEW: 'COI review',
  COMPLIANCE_FIX: 'COI fix',
  MANUAL: 'Task',
};

/** The types that sit in the review queue (no assignee; `vendors/review`). */
export const VENDOR_REVIEW_TASK_TYPES: readonly VendorTaskType[] = ['DUPLICATE_REVIEW', 'MISSING_INFO_REVIEW', 'COMPLIANCE_REVIEW'];

export type VendorTaskAction = 'keep' | 'remove' | 'acknowledge' | 'approve' | 'send_back' | 'fixed' | 'done';

/** What may be done to an open task of each type. */
export const VENDOR_TASK_ACTIONS: Record<VendorTaskType, readonly VendorTaskAction[]> = {
  DUPLICATE_REVIEW: ['keep', 'remove'],
  MISSING_INFO_REVIEW: ['acknowledge'],
  COMPLIANCE_REVIEW: ['approve', 'send_back'],
  COMPLIANCE_FIX: ['fixed'],
  MANUAL: ['done'],
};

export interface VendorTask {
  id: string;
  type: VendorTaskType;
  title: string;
  vendor: { id: string; name: string } | null;
  entity: string | null;
  assigned_to: FeedActor | null;
  status: 'OPEN' | 'DONE';
  outcome: string | null;
  note: string | null;
  created_by: FeedActor | null;
  created_at: string;
  completed_by: FeedActor | null;
  completed_at: string | null;
  /** COI review: the certificates to look at, newest first. */
  documents?: VendorDocument[];
}

export interface DailyTarget {
  principal: FeedActor;
  day: string;
  nationwide_target: number;
  statewide_target: number;
  nationwide_added: number;
  statewide_added: number;
}

export interface VendorTasksResponse {
  tasks: VendorTask[];
  /** May decide the review queue, give tasks to others, set targets. */
  can_review: boolean;
  /** The viewer's own target for today, when one is set. */
  my_target: DailyTarget | null;
  /** Reviewers: every rep's target for today. */
  targets: DailyTarget[];
  people: FeedActor[];
}

// ── Documents and the COI review ─────────────────────────────────────────────

export type VendorDocumentType = 'W9' | 'MSA' | 'COI' | 'OTHER';

export const VENDOR_DOCUMENT_TYPE_LABELS: Record<VendorDocumentType, string> = {
  W9: 'W-9',
  MSA: 'MSA',
  COI: 'Certificate of insurance',
  OTHER: 'Other document',
};

export const VENDOR_DOCUMENT_MAX_BYTES = 3 * 1024 * 1024;

export const VENDOR_DOCUMENT_TYPES_ALLOWED: readonly string[] = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

export interface VendorDocument {
  id: string;
  type: VendorDocumentType;
  entity: string | null;
  file_name: string;
  content_type: string | null;
  byte_size: number | null;
  uploaded_by: FeedActor | null;
  created_at: string;
}

export interface VendorDocumentUpload {
  type: VendorDocumentType;
  entity?: string | null;
  file_name: string;
  content_type: string;
  /** base64 */
  data: string;
}

export const COI_CHECKLIST = [
  { key: 'cert_holder_confirmed', label: 'Certificate holder is correct' },
  { key: 'additional_insured_confirmed', label: 'Additional insured is named' },
  { key: 'gl_limit_meets_requirement', label: 'General liability meets $1M / $2M' },
  { key: 'workers_comp', label: 'Workers comp' },
  { key: 'commercial_auto', label: 'Commercial auto' },
  { key: 'waiver_of_subrogation', label: 'Waiver of subrogation' },
] as const;
export type CoiChecklistKey = (typeof COI_CHECKLIST)[number]['key'];

export interface CoiRequirement extends Record<CoiChecklistKey, boolean> {
  entity: string;
  approved: TriState;
  review_note: string | null;
  reviewed_by: FeedActor | null;
  reviewed_at: string | null;
}

/** The vendor-level verdict from its per-company reviews: YES only when every
 *  company with a certificate is approved; NO while any is sent back. */
export function rollUpCoiApproval(reqs: { approved: TriState }[]): TriState {
  if (reqs.length === 0) return 'PENDING';
  if (reqs.some((r) => r.approved === 'NO')) return 'NO';
  return reqs.every((r) => r.approved === 'YES') ? 'YES' : 'PENDING';
}

// ── The log ──────────────────────────────────────────────────────────────────

export interface VendorCall {
  id: string;
  occurred_at: string;
  notes: string | null;
  call_link: string | null;
  transcript: string | null;
  summary: string | null;
  resulting_status: string | null;
  logged_by: FeedActor | null;
  edited_at: string | null;
}

export interface VendorCallInput {
  occurred_at?: string | null;
  notes?: string | null;
  call_link?: string | null;
  transcript?: string | null;
  summary?: string | null;
  resulting_status?: string | null;
}

export interface VendorEmail {
  id: string;
  sent_at: string;
  subject: string | null;
  notes: string | null;
  logged_by: FeedActor | null;
}

/** GET /vendors/:id/work — everything 0058 hangs on a vendor record. */
export interface VendorWorkResponse {
  documents: VendorDocument[];
  coi: CoiRequirement[];
  calls: VendorCall[];
  emails: VendorEmail[];
  tasks: VendorTask[];
  problems: FieldProblem[];
  storage_ready: boolean;
  can: { upload: boolean; delete_document: boolean; review: boolean; edit: boolean };
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export type ExpiryBand = 'expired' | 'two_weeks' | 'month' | 'later';

/** Where a date sits against today: past, within 14 days, within 30, later. */
export function expiryBand(expiresOn: string, today: string): ExpiryBand {
  if (expiresOn < today) return 'expired';
  const days = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days <= 14) return 'two_weeks';
  if (days <= 30) return 'month';
  return 'later';
}

export interface VendorAlert {
  id: string;
  vendor: { id: string; name: string; status: string; owner: string | null };
  entity: string | null;
  insurance_type: string;
  expires_on: string;
  band: ExpiryBand;
}

// ── Data quality ─────────────────────────────────────────────────────────────

export type DuplicateBy = 'phone' | 'name' | 'email';

export interface DuplicateGroup {
  key: string;
  vendors: { id: string; name: string; kind: VendorKind; phone: string | null; email: string | null; city: string | null; state: string | null; owner: string | null; created_at: string }[];
}

export interface DataQualityResponse {
  duplicates: DuplicateGroup[];
  missing: { id: string; name: string; owner: string | null; created_at: string; problems: FieldProblem[] }[];
  not_on_map: { id: string; name: string; kind: VendorKind; city: string | null; state: string | null; zip: string | null }[];
  counts: { duplicates: number; missing: number; not_on_map: number };
}

// ── Bulk edit, saved lists ───────────────────────────────────────────────────

export interface VendorBulkPatch {
  status?: string;
  owner_id?: string | null;
  primary_trade?: string;
  state?: string;
  city?: string;
  brand_source?: string | null;
}

export type SavedViewVisibility = 'PRIVATE' | 'MANAGERS' | 'EVERYONE';

export interface VendorSavedView {
  id: string;
  name: string;
  params: Record<string, string>;
  visibility: SavedViewVisibility;
  owner: FeedActor;
  mine: boolean;
}

/** The query-string keys a saved list may hold. */
export const SAVED_VIEW_KEYS = ['search', 'kind', 'status', 'trade', 'state', 'owner', 'compliance', 'flag', 'filter', 'sort', 'dir'] as const;

// ── CSV import ───────────────────────────────────────────────────────────────

export type ImportFieldType = 'text' | 'phone' | 'bool' | 'tri' | 'priority' | 'brand' | 'status' | 'state' | 'number' | 'list' | 'states';

export interface ImportableField {
  key: string;
  label: string;
  type: ImportFieldType;
  /** Header spellings (lower-case, letters and digits only) that mean this field. */
  aliases: string[];
  /** Stored in vendor.details. */
  detail?: boolean;
}

export const IMPORTABLE_VENDOR_FIELDS: readonly ImportableField[] = [
  { key: 'name', label: 'Name', type: 'text', aliases: ['name', 'vendorname', 'vendor', 'company', 'companyname', 'techname', 'technicianname', 'fullname'] },
  { key: 'phones', label: 'Phone', type: 'phone', aliases: ['phone', 'phones', 'phonenumber', 'phone1', 'phone2', 'mobile', 'cell', 'cellphone', 'tel', 'telephone'] },
  { key: 'email', label: 'Email', type: 'text', aliases: ['email', 'emailaddress'] },
  { key: 'city', label: 'City', type: 'text', aliases: ['city', 'town'] },
  { key: 'state', label: 'State', type: 'state', aliases: ['state', 'st', 'province'] },
  { key: 'zip', label: 'ZIP', type: 'text', aliases: ['zip', 'zipcode', 'postal', 'postalcode'] },
  { key: 'primary_trade', label: 'Primary trade', type: 'text', aliases: ['trade', 'primarytrade', 'tradetype', 'service', 'category', 'skill'] },
  { key: 'secondary_trades', label: 'Secondary trades', type: 'list', aliases: ['secondarytrades', 'othertrades', 'secondarytrade'] },
  { key: 'status', label: 'Status', type: 'status', aliases: ['status', 'vendorstatus'] },
  { key: 'brand_source', label: 'Brand source', type: 'brand', aliases: ['brand', 'brandname', 'brandsource', 'source'] },
  { key: 'priority', label: 'Priority', type: 'priority', aliases: ['priority'] },
  { key: 'legal_name', label: 'Legal business name', type: 'text', aliases: ['legalbusinessname', 'legalname'] },
  { key: 'dba_name', label: 'DBA', type: 'text', aliases: ['dba', 'dbaname'] },
  { key: 'statewide', label: 'Statewide', type: 'bool', aliases: ['statewide'] },
  { key: 'nationwide', label: 'Nationwide', type: 'bool', aliases: ['nationwide'] },
  { key: 'coverage_states', label: 'States covered', type: 'states', aliases: ['coveragestates', 'statescovered'] },
  { key: 'max_travel_radius', label: 'Max travel radius', type: 'text', aliases: ['maxtravelradius', 'travelradius', 'radius'] },
  { key: 'emergency_same_day', label: 'Emergency same day', type: 'bool', aliases: ['emergencysameday', 'sameday'] },
  { key: 'after_hours', label: 'After hours', type: 'bool', aliases: ['afterhours'] },
  { key: 'weekends', label: 'Weekends', type: 'bool', aliases: ['weekends', 'weekend'] },
  { key: 'holiday_emergency', label: 'Holiday emergency', type: 'bool', aliases: ['holidayemergency', 'holidays'] },
  { key: 'estimated_response_time', label: 'Estimated response time', type: 'text', aliases: ['estimatedresponsetime', 'responsetime'] },
  { key: 'regular_hourly_rate', label: 'Regular hourly rate', type: 'number', aliases: ['regularhourlyrate', 'hourlyrate', 'rate'] },
  { key: 'after_hours_rate', label: 'After-hours rate', type: 'number', aliases: ['afterhoursrate'] },
  { key: 'weekend_emergency_rate', label: 'Weekend / emergency rate', type: 'number', aliases: ['weekendemergencyrate', 'weekendrate', 'emergencyrate'] },
  { key: 'trip_charge', label: 'Trip charge', type: 'number', aliases: ['tripcharge', 'trip'] },
  { key: 'diagnostic_fee', label: 'Diagnostic fee', type: 'number', aliases: ['diagnosticfee', 'diagnostic'] },
  { key: 'minimum_charge', label: 'Minimum charge', type: 'number', aliases: ['minimumcharge', 'minimum'] },
  { key: 'payment_methods', label: 'Payment methods', type: 'list', aliases: ['paymentmethods', 'paymentmethod'] },
  { key: 'accepts_payment_after_30_days', label: 'Accepts payment after 30 days', type: 'bool', aliases: ['acceptspaymentafter30days', 'net30'] },
  { key: 'primary_contact_name', label: 'Contact name', type: 'text', aliases: ['primarycontactname', 'contactname', 'contact'] },
  { key: 'primary_contact_role', label: 'Contact role', type: 'text', aliases: ['primarycontactrole', 'contactrole'] },
  { key: 'dispatch_phone', label: 'Dispatch phone', type: 'text', aliases: ['dispatchphone'] },
  { key: 'billing_email', label: 'Billing email', type: 'text', aliases: ['billingemail'] },
  { key: 'w9_received', label: 'W-9 received', type: 'tri', aliases: ['w9received', 'w9'] },
  { key: 'msa_signed', label: 'MSA signed', type: 'tri', aliases: ['msasigned', 'msa'] },
  { key: 'coi_received', label: 'COI received', type: 'tri', aliases: ['coireceived', 'coi'] },
  { key: 'is_subcontractor', label: 'Subcontractor', type: 'bool', aliases: ['subcontractor', 'issubcontractor'] },
  { key: 'notes', label: 'Notes', type: 'text', aliases: ['notes', 'note', 'comments'] },
  { key: 'coverageCities', label: 'Cities covered', type: 'text', aliases: ['coveragecities', 'citiescovered'], detail: true },
  { key: 'coverageArea', label: 'Coverage area', type: 'text', aliases: ['coveragearea'], detail: true },
  { key: 'zipCodes', label: 'ZIP codes covered', type: 'text', aliases: ['zipcodes', 'zipscovered'], detail: true },
  { key: 'commercialExperience', label: 'Commercial experience', type: 'text', aliases: ['commercialexperience'], detail: true },
  { key: 'licenseNumber', label: 'License number', type: 'text', aliases: ['licensenumber', 'license'], detail: true },
  { key: 'folderLink', label: 'Folder link', type: 'text', aliases: ['folderlink', 'folder'], detail: true },
];

export const IMPORT_MAX_ROWS = 2000;

const headerKeyOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** header → field key, for the headers we recognise. Several columns may map
 *  to `phones`; any other field takes the first column that names it. */
export function autoMapImportColumns(headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const taken = new Set<string>();
  for (const h of headers) {
    const k = headerKeyOf(h);
    if (k === '') continue;
    const f = IMPORTABLE_VENDOR_FIELDS.find((x) => x.aliases.includes(k) || headerKeyOf(x.label) === k || headerKeyOf(x.key) === k);
    if (!f) continue;
    if (f.key !== 'phones' && taken.has(f.key)) continue;
    out[h] = f.key;
    taken.add(f.key);
  }
  return out;
}

export interface ImportLists {
  statuses: { key: string; label: string }[];
  brand_sources: { key: string; label: string }[];
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'x']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0']);

export interface ImportedRow {
  input: VendorInput;
  /** The cells that could not be read, by column label. */
  errors: string[];
}

/** One CSV row → the body the vendor API takes. Cells that cannot be read
 *  (a rate of "call us", a state of "Ontario") are reported, not guessed. */
export function buildImportRow(
  row: Record<string, string>,
  mapping: Record<string, string>,
  lists: ImportLists,
  kind: VendorKind,
): ImportedRow {
  const input: Record<string, unknown> = { kind };
  const details: Record<string, unknown> = {};
  const phones: { phone: string }[] = [];
  const errors: string[] = [];
  for (const [header, fieldKey] of Object.entries(mapping)) {
    const def = IMPORTABLE_VENDOR_FIELDS.find((f) => f.key === fieldKey);
    if (!def) continue;
    const raw = (row[header] ?? '').trim();
    if (raw === '' || isBlankValue(raw)) continue;
    const lower = raw.toLowerCase();
    let value: unknown;
    switch (def.type) {
      case 'phone':
        for (const part of raw.split(/[;,/]|\bor\b/i)) {
          const p = part.trim();
          if (p === '') continue;
          if (phoneDigits(p)) phones.push({ phone: p });
          else errors.push(`${def.label}: “${p}” is not a phone number`);
        }
        continue;
      case 'bool':
        if (TRUE_WORDS.has(lower)) value = true;
        else if (FALSE_WORDS.has(lower)) value = false;
        else {
          errors.push(`${def.label}: “${raw}” is not yes or no`);
          continue;
        }
        break;
      case 'tri':
        value = TRUE_WORDS.has(lower) ? 'YES' : FALSE_WORDS.has(lower) ? 'NO' : lower === 'pending' ? 'PENDING' : null;
        if (value === null) {
          errors.push(`${def.label}: “${raw}” is not yes, no or pending`);
          continue;
        }
        break;
      case 'priority': {
        const p = lower.startsWith('h') ? 'HIGH' : lower.startsWith('m') ? 'MEDIUM' : lower.startsWith('l') ? 'LOW' : null;
        if (!p) {
          errors.push(`${def.label}: “${raw}” is not high, medium or low`);
          continue;
        }
        value = p as VendorPriority;
        break;
      }
      case 'brand': {
        const b =
          lists.brand_sources.find((x) => x.key.toLowerCase() === lower || x.label.toLowerCase() === lower) ??
          lists.brand_sources.find((x) => lower.includes(x.label.toLowerCase().split(' ')[0]));
        if (!b) {
          errors.push(`${def.label}: “${raw}” is not a brand source`);
          continue;
        }
        value = b.key;
        break;
      }
      case 'status': {
        const s = lists.statuses.find((x) => x.key.toLowerCase() === lower || x.label.toLowerCase() === lower);
        if (!s) {
          errors.push(`${def.label}: “${raw}” is not a status`);
          continue;
        }
        value = s.key;
        break;
      }
      case 'state': {
        const st = normalizeState(raw);
        if (!st) {
          errors.push(`${def.label}: “${raw}” is not a state`);
          continue;
        }
        value = st;
        break;
      }
      case 'states': {
        const list = raw.split(/[;,]/).map((s) => normalizeState(s)).filter((s): s is string => s !== null);
        value = list;
        break;
      }
      case 'number': {
        const n = Number(raw.replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0) {
          errors.push(`${def.label}: “${raw}” is not a number`);
          continue;
        }
        value = n;
        break;
      }
      case 'list':
        value = raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
        break;
      default:
        value = raw;
    }
    if (def.detail) details[def.key] = value;
    else input[def.key] = value;
  }
  if (phones.length > 0) input.phones = phones;
  if (Object.keys(details).length > 0) input.details = details;
  return { input: input as VendorInput, errors };
}

export type ImportDuplicateStrategy = 'SKIP' | 'FLAG' | 'ADD_ANYWAY' | 'ENRICH';
export type ImportMissingStrategy = 'ADD' | 'SKIP';

export const IMPORT_DUPLICATE_LABELS: Record<ImportDuplicateStrategy, string> = {
  SKIP: 'Skip them',
  FLAG: 'Skip them and list them in a report',
  ADD_ANYWAY: 'Add them anyway, flagged as possible duplicates',
  ENRICH: 'Fill in the record already on file',
};

export interface ImportAnalysis {
  total: number;
  /** A row with a name and nothing unreadable. */
  ready: number;
  no_name: number;
  with_errors: number;
  duplicates: number;
  missing_required: number;
  /** The first few problems, for the review screen. */
  samples: { row: number; name: string; problems: string[] }[];
}

export interface ImportSummary {
  created: number;
  enriched: number;
  skipped_duplicates: number;
  skipped_missing: number;
  skipped_invalid: number;
  flagged_duplicates: number;
  flagged_missing: number;
  not_on_map: number;
  /** Duplicates left out or flagged: the CSV row beside the record on file. */
  report: { row: number; name: string; phone: string | null; existing_id: string; existing_name: string }[];
}

export interface VendorImportRecord {
  id: string;
  file_name: string;
  uploaded_by: FeedActor | null;
  kind: VendorKind;
  total_rows: number;
  duplicate_strategy: ImportDuplicateStrategy;
  missing_strategy: ImportMissingStrategy;
  summary: ImportSummary;
  created_at: string;
}

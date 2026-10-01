// Vendors and technicians (migration 0057): the record, who may see whom on
// the map, preferred vendors, and hiring onto a work order.
//
// One `vendor` table holds both kinds — 'vendor' (a company the VR team
// recruited) and 'tech' (a technician a dispatcher has worked with). Pure
// vocabulary and rules live here so the API and the browser agree; the SQL
// lives under apps/api (services/vendors.ts, vendorMap.ts, geo.ts).

import type { FeedActor } from './index';
import { permAllows, type PermNode, type PermissionSet } from './permissions';

// ── Permission paths ─────────────────────────────────────────────────────────

export const VENDORS_PERM_KEY = 'vendors';
/** view = every vendor; false = only the ones they own. Unset inherits `vendors`. */
export const VENDOR_SCOPE_PERM_KEY = 'vendors/scope';
/** create = add a note / mark blacklisted; edit = clear a blacklist. */
export const VENDOR_BLACKLIST_PERM_KEY = 'vendors/blacklist';
/** view = open the map on a work order; create = hire a technician onto it. */
export const VENDOR_MAP_PERM_KEY = 'vendor_map';
export const VENDOR_MAP_TECHS_PERM_KEY = 'vendor_map/techs';
export const VENDOR_MAP_VR_PERM_KEY = 'vendor_map/vr';
export const VENDOR_MAP_STATEWIDE_PERM_KEY = 'vendor_map/statewide';
export const VENDOR_MAP_NATIONWIDE_PERM_KEY = 'vendor_map/nationwide';
export const VENDOR_MAP_SUBS_PERM_KEY = 'vendor_map/subcontractors';
export const VENDOR_MAP_ADD_PERM_KEY = 'vendor_map/add';
/** Admin › Vendors & map. */
export const ADMIN_VENDORS_SLUG = 'vendors';

export const VENDOR_SCOPE_CHOICES: NonNullable<PermNode['choices']> = [
  { code: 'all', label: 'Everything', hint: 'Every vendor and technician', grant: { view: true } },
  { code: 'owned', label: 'Only theirs', hint: 'Vendors they own, and technicians they have worked with', grant: { view: false } },
];

export const VENDOR_MAP_TECHS_CHOICES: NonNullable<PermNode['choices']> = [
  { code: 'all', label: 'All technicians', hint: 'Every dispatcher’s technicians', grant: { view: true } },
  { code: 'own', label: 'Only theirs', hint: 'Technicians they added, hired or logged a visit with', grant: { view: false } },
];

/** What a person may see and do on the work-order map. */
export interface VendorMapScope {
  open: boolean;
  hire: boolean;
  /** false = only the technicians linked to them. */
  allTechs: boolean;
  vr: boolean;
  statewide: boolean;
  nationwide: boolean;
  subcontractors: boolean;
  add: boolean;
}

export function resolveVendorMapScope(set: PermissionSet | null | undefined, superAdmin = false): VendorMapScope {
  const can = (key: string, action: 'view' | 'create' = 'view') => permAllows(set, key, action, superAdmin);
  return {
    open: can(VENDOR_MAP_PERM_KEY),
    hire: can(VENDOR_MAP_PERM_KEY, 'create'),
    allTechs: can(VENDOR_MAP_TECHS_PERM_KEY),
    vr: can(VENDOR_MAP_VR_PERM_KEY),
    statewide: can(VENDOR_MAP_STATEWIDE_PERM_KEY),
    nationwide: can(VENDOR_MAP_NATIONWIDE_PERM_KEY),
    subcontractors: can(VENDOR_MAP_SUBS_PERM_KEY),
    add: can(VENDOR_MAP_ADD_PERM_KEY, 'create'),
  };
}

/** The Roles-screen rows for vendors and the map (permissions.ts places them). */
export function vendorPermNodes(): PermNode[] {
  return [
    {
      key: VENDORS_PERM_KEY,
      label: 'Vendors',
      actions: ['view', 'create', 'edit', 'delete'],
      note: 'The Vendors section: view = the list and each record; delete = remove a vendor (it is kept, hidden, for the records that point at it).',
      children: [
        {
          key: VENDOR_SCOPE_PERM_KEY,
          label: 'Which vendors',
          actions: ['view'],
          note: 'Everything, or only the vendors they own and the technicians they have worked with.',
          choices: VENDOR_SCOPE_CHOICES,
        },
        {
          key: VENDOR_BLACKLIST_PERM_KEY,
          label: 'Notes and blacklist',
          actions: ['create', 'edit'],
          note: 'Create = add a note or mark a technician blacklisted; edit = clear a blacklist.',
        },
      ],
    },
    {
      key: VENDOR_MAP_PERM_KEY,
      label: 'Technician map',
      actions: ['view', 'create'],
      note: 'The map on a work order: view = open it; create = hire a technician onto the work order.',
      children: [
        {
          key: VENDOR_MAP_TECHS_PERM_KEY,
          label: 'Which technicians',
          actions: ['view'],
          note: 'All technicians, or only the ones they added, hired or logged a visit with.',
          choices: VENDOR_MAP_TECHS_CHOICES,
        },
        { key: VENDOR_MAP_VR_PERM_KEY, label: 'VR vendors', actions: ['view'], note: 'The vendors the VR team recruited.' },
        { key: VENDOR_MAP_STATEWIDE_PERM_KEY, label: 'Statewide vendors', actions: ['view'], note: 'Vendors covering the whole state of the work order, however far away.' },
        { key: VENDOR_MAP_NATIONWIDE_PERM_KEY, label: 'Nationwide vendors', actions: ['view'] },
        { key: VENDOR_MAP_SUBS_PERM_KEY, label: 'Subcontractors', actions: ['view'] },
        { key: VENDOR_MAP_ADD_PERM_KEY, label: 'Add a technician', actions: ['create'] },
      ],
    },
  ];
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

export type VendorKind = 'vendor' | 'tech';
export const VENDOR_KIND_LABELS: Record<VendorKind, string> = { vendor: 'VR vendor', tech: 'Technician' };

export type TriState = 'YES' | 'NO' | 'PENDING';
export const TRI_STATES: readonly TriState[] = ['YES', 'NO', 'PENDING'];
export const TRI_STATE_LABELS: Record<TriState, string> = { YES: 'Yes', NO: 'No', PENDING: 'Pending' };

export type ComplianceStatus = 'MISSING_DOCS' | 'IN_REVIEW' | 'APPROVED' | 'EXPIRED' | 'REJECTED';
export const COMPLIANCE_STATUS_LABELS: Record<ComplianceStatus, string> = {
  MISSING_DOCS: 'Missing documents',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
};

export type VendorPriority = 'HIGH' | 'MEDIUM' | 'LOW';
export const VENDOR_PRIORITIES: readonly VendorPriority[] = ['HIGH', 'MEDIUM', 'LOW'];

/** Status keys the app itself reads. The list of statuses is the vendor_status
 *  table (Admin › Vendors & map); these are the system rows in it. */
export const VENDOR_STATUS_NEW = 'NEW';
export const VENDOR_STATUS_ACTIVE = 'ACTIVE';
export const VENDOR_STATUS_INACTIVE = 'INACTIVE';

export const VENDOR_PAYMENT_METHODS = ['ACH', 'Credit', 'Wire', 'Bank Transfer', 'Zelle', 'Other'] as const;

export const US_STATE_CODES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY',
  'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH',
  'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
] as const;

const STATE_NAMES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT',
  delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID',
  illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN',
  texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY',
};

/** 'tx', 'Texas', ' TX ' → 'TX'; null when it names no state. */
export function normalizeState(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s === '') return null;
  const up = s.toUpperCase();
  if ((US_STATE_CODES as readonly string[]).includes(up)) return up;
  return STATE_NAMES[s.toLowerCase()] ?? null;
}

// ── The long tail of the profile (vendor.details) ────────────────────────────
// The CRM's profile sections that are answers rather than things we filter
// or map by. Stored in `details` (jsonb) under these keys; the profile page
// draws each section from this catalogue.

export type VendorDetailType = 'text' | 'longtext' | 'bool' | 'number' | 'money' | 'date' | 'multi' | 'tri';

export interface VendorDetailField {
  key: string;
  label: string;
  type: VendorDetailType;
  options?: readonly string[];
}

export interface VendorDetailSection {
  slug: string;
  title: string;
  /** Shown only when the vendor's primary or secondary trades include one of these. */
  trades?: readonly string[];
  fields: VendorDetailField[];
}

export const VENDOR_DETAIL_SECTIONS: VendorDetailSection[] = [
  {
    slug: 'company',
    title: 'Company',
    fields: [
      { key: 'hqCity', label: 'HQ city', type: 'text' },
      { key: 'hqState', label: 'HQ state', type: 'text' },
      { key: 'commercialExperience', label: 'Commercial experience', type: 'longtext' },
      { key: 'propertyTypes', label: 'Property types served', type: 'multi', options: ['Restaurants', 'Retail stores', 'Grocery stores', 'Offices', 'Convenience stores', 'Gyms', 'Multi-site clients', 'Other'] },
      { key: 'propertyTypesOther', label: 'Other property types', type: 'text' },
      { key: 'folderLink', label: 'Folder link', type: 'text' },
    ],
  },
  {
    slug: 'coverage',
    title: 'Coverage area',
    fields: [
      { key: 'coverageCities', label: 'Cities covered', type: 'longtext' },
      { key: 'coverageArea', label: 'Coverage area', type: 'longtext' },
      { key: 'zipCodes', label: 'ZIP codes', type: 'longtext' },
      { key: 'excludedAreas', label: 'Excluded areas', type: 'longtext' },
      { key: 'coverageNotes', label: 'Coverage notes', type: 'longtext' },
    ],
  },
  {
    slug: 'plumbing',
    title: 'Plumbing',
    trades: ['Plumbing'],
    fields: [
      { key: 'hasCommercialSnake', label: 'Has a commercial snake', type: 'bool' },
      { key: 'snakeLengthFt', label: 'Snake length (ft)', type: 'number' },
      { key: 'snakeFee', label: 'Snake fee', type: 'money' },
      { key: 'hydrojetFee', label: 'Hydro-jet fee', type: 'money' },
      { key: 'cameraFee', label: 'Camera fee', type: 'money' },
      { key: 'plumbingHasLicense', label: 'Plumbing license', type: 'bool' },
      { key: 'plumbingLicenseNumber', label: 'Plumbing license number', type: 'text' },
    ],
  },
  {
    slug: 'hvac',
    title: 'HVAC and refrigeration',
    trades: ['HVAC', 'HVAC PM', 'Refrigeration', 'Refrigeration PM'],
    fields: [
      { key: 'hvacRefrigerationCaps', label: 'Capabilities', type: 'multi', options: ['Walk-in coolers', 'Reach-in coolers', '2-to-3 door freezers', 'Ice makers', 'General refrigeration repairs'] },
      { key: 'hvacRefrigerationOther', label: 'Other capabilities', type: 'text' },
      { key: 'hvacEpaCertified', label: 'EPA certified', type: 'bool' },
      { key: 'hvacHasLicense', label: 'HVAC license', type: 'bool' },
      { key: 'hvacLicenseNumber', label: 'HVAC license number', type: 'text' },
    ],
  },
  {
    slug: 'electrical',
    title: 'Electrical',
    trades: ['Electric'],
    fields: [
      { key: 'electricalCaps', label: 'Capabilities', type: 'multi', options: ['Service calls', 'Troubleshooting', 'Lighting', 'Panels', 'Outlets', 'Breakers', 'Emergency repairs'] },
      { key: 'electricalCapsOther', label: 'Other capabilities', type: 'text' },
      { key: 'electricalHasLicense', label: 'Electrical license', type: 'bool' },
      { key: 'electricalLicenseNumber', label: 'Electrical license number', type: 'text' },
    ],
  },
  {
    slug: 'handyman',
    title: 'Handyman and general contracting',
    trades: ['Handyman', 'General Contracting', 'General Contractor'],
    fields: [
      { key: 'handymanMaintenanceCaps', label: 'Maintenance capabilities', type: 'longtext' },
      { key: 'handymanExcludedSvcs', label: 'Excluded services', type: 'longtext' },
      { key: 'handymanNotes', label: 'Notes', type: 'longtext' },
    ],
  },
  {
    slug: 'availability',
    title: 'Availability and rates — notes',
    fields: [
      { key: 'available247', label: 'Available 24/7', type: 'bool' },
      { key: 'estimatedResponseTimeNotes', label: 'Response time notes', type: 'longtext' },
      { key: 'materialMarkup', label: 'Material markup (%)', type: 'number' },
      { key: 'ratesNotes', label: 'Rates notes', type: 'longtext' },
      { key: 'paymentMethodOther', label: 'Other payment method', type: 'text' },
      { key: 'acceptsNte', label: 'Accepts NTE', type: 'bool' },
      { key: 'standardNteAmount', label: 'Standard NTE amount', type: 'money' },
      { key: 'nteNotes', label: 'NTE notes', type: 'longtext' },
    ],
  },
  {
    slug: 'workflow',
    title: 'Workflow expectations',
    fields: [
      { key: 'acceptsDocProcess', label: 'Accepts our documentation process', type: 'bool' },
      { key: 'photoDocumentation', label: 'Photo documentation', type: 'bool' },
      { key: 'managerSignOff', label: 'Manager sign-off', type: 'bool' },
      { key: 'etaCommunication', label: 'ETA communication', type: 'bool' },
      { key: 'workflowNotes', label: 'Workflow notes', type: 'longtext' },
    ],
  },
  {
    slug: 'insurance',
    title: 'Insurance and license',
    fields: [
      { key: 'insGeneralLiability', label: 'General liability', type: 'bool' },
      { key: 'insWorkersComp', label: 'Workers comp', type: 'bool' },
      { key: 'insCommercialAuto', label: 'Commercial auto', type: 'bool' },
      { key: 'insAdditionalInsured', label: 'Additional insured', type: 'bool' },
      { key: 'insNotes', label: 'Insurance notes', type: 'longtext' },
      { key: 'licenseReceived', label: 'License received', type: 'tri' },
      { key: 'licenseNumber', label: 'License number', type: 'text' },
      { key: 'epa608', label: 'EPA 608', type: 'bool' },
    ],
  },
  {
    slug: 'followup',
    title: 'Follow-up and first job',
    fields: [
      { key: 'lastContactDate', label: 'Last contact', type: 'date' },
      { key: 'nextFollowUpDate', label: 'Next follow-up', type: 'date' },
      { key: 'firstJobCompleted', label: 'First job completed', type: 'bool' },
      { key: 'firstJobScore', label: 'First job score', type: 'number' },
      { key: 'vendorRating', label: 'Vendor rating', type: 'number' },
    ],
  },
];

/** Every key `details` may hold, for the API's whitelist. */
export const VENDOR_DETAIL_KEYS: ReadonlySet<string> = new Set(
  VENDOR_DETAIL_SECTIONS.flatMap((s) => s.fields.map((f) => f.key)),
);

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface VendorStatusDef {
  key: string;
  label: string;
  color: string;
  position: number;
  is_system: boolean;
  is_active: boolean;
}

export interface VendorBrandSource {
  key: string;
  label: string;
  position: number;
  is_active: boolean;
}

export interface VendorExpiry {
  id: string;
  entity: string | null;
  insurance_type: string;
  expires_on: string; // YYYY-MM-DD
  /** The latest date of its (entity, type) — the only one that counts. */
  current: boolean;
}

export interface VendorNote {
  id: string;
  kind: 'note' | 'blacklist' | 'blacklist_cleared';
  body: string;
  author: FeedActor | null;
  wo_number: string | null;
  created_at: string;
}

export interface VendorPhone {
  digits: string;
  display: string;
  label: string | null;
}

export interface VendorContact {
  id?: string;
  name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
}

export interface VendorLocation {
  id: string;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  is_primary: boolean;
}

/** One row of the Vendors list. */
export interface VendorRow {
  id: string;
  kind: VendorKind;
  name: string;
  status: string;
  brand_source: string | null;
  owner: FeedActor | null;
  priority: VendorPriority | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  primary_trade: string | null;
  secondary_trades: string[];
  compliance_status: ComplianceStatus;
  w9_received: TriState;
  msa_signed: TriState;
  coi_received: TriState;
  nationwide: boolean;
  statewide: boolean;
  is_subcontractor: boolean;
  work_orders_count: number;
  blacklisted: boolean;
  flagged_duplicate: boolean;
  /** Saved without a required field (0058) — waits in the review queue. */
  flagged_missing: boolean;
  on_map: boolean;
  created_at: string;
  // 0059 · what the column picker can show beyond the default columns.
  zip: string | null;
  primary_contact_name: string | null;
  regular_hourly_rate: number | null;
  trip_charge: number | null;
  coi_approved: TriState;
  /** The day of the last logged call, YYYY-MM-DD. */
  last_contact: string | null;
  updated_at: string;
}

export interface VendorDetail extends VendorRow {
  legal_name: string | null;
  dba_name: string | null;
  zip: string | null;
  coverage_states: string[];
  max_travel_radius: string | null;
  emergency_same_day: boolean | null;
  after_hours: boolean | null;
  weekends: boolean | null;
  holiday_emergency: boolean | null;
  estimated_response_time: string | null;
  regular_hourly_rate: number | null;
  after_hours_rate: number | null;
  weekend_emergency_rate: number | null;
  trip_charge: number | null;
  diagnostic_fee: number | null;
  minimum_charge: number | null;
  payment_methods: string[];
  accepts_payment_after_30_days: boolean | null;
  primary_contact_name: string | null;
  primary_contact_role: string | null;
  dispatch_phone: string | null;
  billing_email: string | null;
  coi_approved: TriState;
  blacklist_reason: string | null;
  blacklisted_at: string | null;
  blacklisted_by: FeedActor | null;
  duplicate_of: { id: string; name: string } | null;
  notes: string | null;
  details: Record<string, unknown>;
  phones: VendorPhone[];
  contacts: VendorContact[];
  locations: VendorLocation[];
  expiries: VendorExpiry[];
  dispatchers: (FeedActor & { source: string; since: string })[];
  note_log: VendorNote[];
  /** The work orders this vendor is (or was) hired on, newest first. */
  work_orders: { wo_number: string; title: string; hired_at: string; released_at: string | null }[];
  preferred_for: PreferredVendorRule[];
  compliance_warning: string | null;
  updated_at: string;
  /** What the viewer may do with THIS record. */
  can: { edit: boolean; delete: boolean; note: boolean; clear_blacklist: boolean };
}

/** POST / PATCH body. Everything optional on PATCH; `name` required on POST. */
export interface VendorInput {
  kind?: VendorKind;
  name?: string;
  status?: string;
  brand_source?: string | null;
  owner_id?: string | null;
  priority?: VendorPriority | null;
  email?: string | null;
  legal_name?: string | null;
  dba_name?: string | null;
  primary_trade?: string | null;
  secondary_trades?: string[];
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  nationwide?: boolean;
  statewide?: boolean;
  coverage_states?: string[];
  max_travel_radius?: string | null;
  emergency_same_day?: boolean | null;
  after_hours?: boolean | null;
  weekends?: boolean | null;
  holiday_emergency?: boolean | null;
  estimated_response_time?: string | null;
  regular_hourly_rate?: number | null;
  after_hours_rate?: number | null;
  weekend_emergency_rate?: number | null;
  trip_charge?: number | null;
  diagnostic_fee?: number | null;
  minimum_charge?: number | null;
  payment_methods?: string[];
  accepts_payment_after_30_days?: boolean | null;
  primary_contact_name?: string | null;
  primary_contact_role?: string | null;
  dispatch_phone?: string | null;
  billing_email?: string | null;
  w9_received?: TriState;
  msa_signed?: TriState;
  coi_received?: TriState;
  coi_approved?: TriState;
  compliance_status?: ComplianceStatus;
  is_subcontractor?: boolean;
  notes?: string | null;
  details?: Record<string, unknown>;
  phones?: { phone: string; label?: string | null }[];
  contacts?: VendorContact[];
  /** POST only: save although the name or a phone matches a vendor on file. */
  override_duplicate?: boolean;
  /** POST only (0058): save although a required field is empty — the vendor
   *  is flagged and a missing-information review is raised. */
  override_missing?: boolean;
}

export interface VendorsListResponse {
  items: VendorRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface VendorsMetaResponse {
  statuses: VendorStatusDef[];
  brand_sources: VendorBrandSource[];
  trades: string[];
  owners: FeedActor[];
  /** Counts for the list header. */
  counts: { vendors: number; techs: number; blacklisted: number; not_on_map: number };
  can: { create: boolean; edit: boolean; delete: boolean; all: boolean };
}

export interface VendorResponse {
  vendor: VendorDetail;
}

// ── Preferred vendors ────────────────────────────────────────────────────────

export interface PreferredVendorRule {
  id: string;
  client: string | null;
  trade: string | null;
  state: string | null;
  vendor: { id: string; name: string; phone: string | null; blacklisted: boolean };
  rank: number;
  note: string | null;
}

export interface PreferredVendorInput {
  client?: string | null;
  trade?: string | null;
  state?: string | null;
  vendor_id?: string;
  rank?: number;
  note?: string | null;
}

/** How well a rule fits a work order: higher = more specific; 0 = no match.
 *  client + trade beats client-only beats trade-only; a state on the rule must
 *  match and adds a point. */
export function preferredRuleScore(
  rule: { client: string | null; trade: string | null; state: string | null },
  wo: { client: string | null; trade: string | null; state: string | null },
): number {
  const same = (a: string | null, b: string | null) =>
    a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (rule.client !== null && !same(rule.client, wo.client)) return 0;
  if (rule.trade !== null && !same(rule.trade, wo.trade)) return 0;
  if (rule.state !== null && normalizeState(rule.state) !== normalizeState(wo.state)) return 0;
  if (rule.client === null && rule.trade === null) return 0;
  return (rule.client !== null ? 4 : 0) + (rule.trade !== null ? 2 : 0) + (rule.state !== null ? 1 : 0);
}

// ── The map ──────────────────────────────────────────────────────────────────

export const AVAILABILITY_FLAGS = [
  { key: 'emergency_same_day', label: 'Emergency same day' },
  { key: 'after_hours', label: 'After hours' },
  { key: 'weekends', label: 'Weekends' },
  { key: 'holiday_emergency', label: 'Holiday emergency' },
] as const;
export type AvailabilityKey = (typeof AVAILABILITY_FLAGS)[number]['key'];

/** Why a result is on the map. */
export type MapReach = 'local' | 'statewide' | 'nationwide';

export interface MapVendor {
  id: string;
  kind: VendorKind;
  name: string;
  status: string;
  phone: string | null;
  phones: string[];
  email: string | null;
  city: string | null;
  state: string | null;
  /** NULL for a statewide / nationwide vendor with no placed location. */
  lat: number | null;
  lng: number | null;
  distance_miles: number | null;
  reach: MapReach;
  primary_trade: string | null;
  secondary_trades: string[];
  emergency_same_day: boolean | null;
  after_hours: boolean | null;
  weekends: boolean | null;
  holiday_emergency: boolean | null;
  regular_hourly_rate: number | null;
  after_hours_rate: number | null;
  weekend_emergency_rate: number | null;
  trip_charge: number | null;
  diagnostic_fee: number | null;
  minimum_charge: number | null;
  estimated_response_time: string | null;
  max_travel_radius: string | null;
  work_orders_count: number;
  is_subcontractor: boolean;
  blacklisted: boolean;
  blacklist_reason: string | null;
  /** Theirs: linked to the viewer through vendor_dispatcher. */
  mine: boolean;
  /** Rank of the best preferred-vendor rule that fits this work order, or null. */
  preferred_rank: number | null;
  preferred_note: string | null;
  hired: boolean;
  compliance_warning: string | null;
}

export interface WoMapResponse {
  work_order: { id: string; wo_number: string; client: string | null; trade: string | null; state: string | null };
  /** Where the map is centred, and what it was resolved from; null = the work
   *  order has no ZIP / city we could place. */
  center: { lat: number; lng: number; label: string; from: 'zip' | 'city' } | null;
  radius_miles: number;
  vendors: MapVendor[];
  trades: string[];
  scope: VendorMapScope;
  /** Statewide / nationwide vendors with no placed location — listed, never pinned. */
  unplaced: number;
}

export interface WoTechnician {
  id: string;
  vendor: {
    id: string;
    kind: VendorKind;
    name: string;
    phone: string | null;
    primary_trade: string | null;
    city: string | null;
    state: string | null;
    blacklisted: boolean;
  };
  hired_by: FeedActor | null;
  hired_at: string;
  released_at: string | null;
  note: string | null;
  compliance_warning: string | null;
}

export interface WoTechniciansResponse {
  technicians: WoTechnician[];
  can: { open_map: boolean; hire: boolean };
}

/** One hit of the technician search a visit uses (any technician, any owner). */
export interface TechSearchHit {
  id: string;
  kind: VendorKind;
  name: string;
  phone: string | null;
  primary_trade: string | null;
  city: string | null;
  state: string | null;
  blacklisted: boolean;
  /** Hired on the work order the search was made from. */
  hired: boolean;
}

/** POST /work-orders/:id/technicians/new — add a technician from the map. */
export interface NewTechInput {
  name: string;
  phone: string;
  city: string;
  state: string;
  zip?: string | null;
  trade: string;
  hire?: boolean;
}

// ── Admin › Vendors & map ────────────────────────────────────────────────────

export interface VendorSettings {
  map_radius_miles: number;
  map_daily_alert: number;
  hire_warn_compliance: boolean;
}

export const VENDOR_SETTING_DEFAULTS: VendorSettings = {
  map_radius_miles: 100,
  map_daily_alert: 100,
  hire_warn_compliance: true,
};

export interface MapUsageRow {
  principal: FeedActor;
  day: string;
  opens: number;
  over_limit: boolean;
}

export interface AdminVendorsResponse {
  settings: VendorSettings;
  statuses: VendorStatusDef[];
  brand_sources: VendorBrandSource[];
  trades: { name: string; position: number; is_active: boolean }[];
  preferred: PreferredVendorRule[];
  /** Map opens per person per day, last 14 days, busiest first. */
  usage: MapUsageRow[];
  clients: string[];
  wo_trades: string[];
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** '(409) 555-0143' → '14095550143' (US numbers get their leading 1); null
 *  when there are too few digits. The key two records are "the same phone" by. */
export function phoneDigits(raw: string | null | undefined): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 7 || d.length > 15) return null;
  return d.length === 10 ? `1${d}` : d;
}

/** The lookup key of a city name: lower-cased, punctuation dropped, saint /
 *  mount / fort abbreviated. Must match geo_city.name_key (migration 0056). */
export function cityKey(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[.'’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\bsaint\b/g, 'st')
    .replace(/\bmount\b/g, 'mt')
    .replace(/\bfort\b/g, 'ft');
}

/** A 5-digit ZIP out of '43623', '43623-1234' or an address tail; else null. */
export function zip5(raw: string | null | undefined): string | null {
  const m = /(?:^|\D)(\d{5})(?:-\d{4})?\s*$/.exec((raw ?? '').trim());
  return m ? m[1] : null;
}

const EARTH_MILES = 3958.8;

/** Great-circle distance in miles. */
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Of a vendor's insurance dates, the ones that count: the latest of each
 *  (entity, type). A renewed policy's old date is history, not an expiry. */
export function currentExpiries<T extends { entity: string | null; insurance_type: string; expires_on: string }>(
  rows: T[],
): T[] {
  const latest = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.entity ?? ''}|${r.insurance_type.trim().toLowerCase()}`;
    const cur = latest.get(k);
    if (!cur || r.expires_on > cur.expires_on) latest.set(k, r);
  }
  return [...latest.values()];
}

/**
 * What to say before hiring a VR vendor whose paperwork is not in order — a
 * warning, never a refusal. Null when there is nothing to say. Technicians
 * (kind 'tech') carry no compliance record, so they never warn.
 */
export function complianceWarning(
  v: { kind: VendorKind; coi_received: TriState },
  expiries: { entity: string | null; insurance_type: string; expires_on: string }[],
  today: string,
): string | null {
  if (v.kind !== 'vendor') return null;
  const expired = currentExpiries(expiries).filter((e) => e.expires_on < today);
  if (expired.length > 0) {
    const e = expired.sort((a, b) => a.expires_on.localeCompare(b.expires_on))[0];
    return `${e.insurance_type} expired on ${e.expires_on}`;
  }
  if (v.coi_received !== 'YES') return 'No certificate of insurance on file';
  return null;
}

/** The order the map lists results in: preferred vendors by rank, then the
 *  viewer's own, then by distance; blacklisted always last. */
export function compareMapVendors(a: MapVendor, b: MapVendor): number {
  if (a.blacklisted !== b.blacklisted) return a.blacklisted ? 1 : -1;
  const ap = a.preferred_rank ?? Number.POSITIVE_INFINITY;
  const bp = b.preferred_rank ?? Number.POSITIVE_INFINITY;
  if (ap !== bp) return ap - bp;
  if (a.mine !== b.mine) return a.mine ? -1 : 1;
  const ad = a.distance_miles ?? Number.POSITIVE_INFINITY;
  const bd = b.distance_miles ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.name.localeCompare(b.name);
}

/** Name-or-phone duplicate rule (the CRM's): the same name, case and spacing
 *  aside, or any phone in common. */
export function sameVendorName(a: string, b: string): boolean {
  const k = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  return k(a) !== '' && k(a) === k(b);
}

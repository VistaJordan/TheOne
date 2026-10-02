// 0060 · Portfolio: sites, their buildings / floors / spaces, and assets.
//
// The vocabulary the API and the browser share: permission paths, the shapes
// of a site and an asset, and the few rules that are pure — what may sit
// under what, how a warranty reads against today, how a flat list of
// locations becomes a tree.

import type { FeedActor } from './index';
import type { PermNode } from './permissions';

export const SITES_PERM_KEY = 'sites';
export const ASSETS_PERM_KEY = 'assets';

export function portfolioPermNodes(): PermNode[] {
  return [
    {
      key: SITES_PERM_KEY,
      label: 'Sites',
      actions: ['view', 'create', 'edit', 'delete'],
      note: 'Sites and their buildings, floors and spaces. Edit also covers linking a work order to its site. Delete hides a site; its work orders keep pointing at it.',
    },
    {
      key: ASSETS_PERM_KEY,
      label: 'Assets',
      actions: ['view', 'create', 'edit', 'delete'],
      note: 'The equipment at a site: edit covers the record, its warranty and logging a condition reading.',
      children: [assetRequestPermNode()],
    },
    ...clientPermNodes(),
  ];
}

// ── Sites ────────────────────────────────────────────────────────────────────

export const SITE_OWNERSHIP = ['Owned', 'Leased', 'Franchise', 'Managed'] as const;

/** The geofence, in feet: 50 ft to 5 miles. */
export const SITE_RADIUS_MIN_FT = 50;
export const SITE_RADIUS_MAX_FT = 26400;

export type SiteSource = 'manual' | 'ecotrak' | 'work_orders' | string;

export const SITE_SOURCE_LABELS: Record<string, string> = {
  manual: 'Added by hand',
  ecotrak: 'From Ecotrak',
  work_orders: 'From work orders',
};

/** The columns the Ecotrak sync rewrites on every sighting of one of ITS
 *  sites. Editing them by hand on such a site would be undone, so the form
 *  shows them read-only there. */
export const SITE_SYNCED_FIELDS: readonly string[] = ['client', 'name', 'store_number', 'address1', 'address2', 'city', 'state', 'zip'];

export interface SiteRow {
  id: string;
  source: SiteSource;
  name: string | null;
  client: string | null;
  store_number: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  site_type: string | null;
  managed_by: FeedActor | null;
  is_active: boolean;
  on_map: boolean;
  buildings: number;
  assets: number;
  work_orders: number;
  open_work_orders: number;
  created_at: string;
}

export interface SiteLocation {
  id: string;
  parent_id: string | null;
  kind: SiteLocationKind;
  name: string;
  level: number | null;
  space_type: string | null;
  area_sqft: number | null;
  notes: string | null;
  position: number;
  /** Assets standing in exactly this place. */
  assets: number;
}

export interface SiteWorkOrder {
  wo_number: string;
  title: string;
  status: string;
  status_group: string;
  trade: string | null;
  asset: { id: string; name: string } | null;
  date_received: string | null;
  created_at: string;
}

export interface SiteDetail extends SiteRow {
  address2: string | null;
  phone_1: string | null;
  phone_2: string | null;
  ownership_status: string | null;
  billing_entity: string | null;
  contact_name: string | null;
  contact_email: string | null;
  hours: string | null;
  access_notes: string | null;
  notes: string | null;
  boundary_radius_ft: number | null;
  lat: number | null;
  lng: number | null;
  geo_source: 'zip' | 'city' | 'manual' | null;
  locations: SiteLocation[];
  asset_list: AssetRow[];
  /** The work orders at this site that the viewer may see, newest first. */
  recent_work_orders: SiteWorkOrder[];
  updated_at: string;
  can: { edit: boolean; delete: boolean; add_asset: boolean };
}

export interface SiteInput {
  name?: string | null;
  client?: string | null;
  store_number?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone_1?: string | null;
  phone_2?: string | null;
  site_type?: string | null;
  ownership_status?: string | null;
  managed_by?: string | null;
  billing_entity?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  hours?: string | null;
  access_notes?: string | null;
  notes?: string | null;
  boundary_radius_ft?: number | null;
  /** Sent together to pin the site by hand; both null to place it from the address again. */
  lat?: number | null;
  lng?: number | null;
  is_active?: boolean;
}

export interface SitesListResponse {
  items: SiteRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface PortfolioCounts {
  sites: number;
  buildings: number;
  floors: number;
  spaces: number;
  assets: number;
  /** Work orders the viewer can see that are not linked to any site yet. */
  unlinked_work_orders: number;
  /** Of every unlinked work order, those naming a client and a place — what
   *  "create sites from work orders" could do something with. */
  linkable_work_orders: number;
}

export interface SitesMetaResponse {
  counts: PortfolioCounts;
  clients: string[];
  states: string[];
  site_types: string[];
  asset_categories: string[];
  asset_types: string[];
  space_types: string[];
  billing_entities: string[];
  people: FeedActor[];
  can: {
    sites: { create: boolean; edit: boolean; delete: boolean };
    assets: { view: boolean; create: boolean; edit: boolean; delete: boolean };
  };
}

export interface SiteMapPoint {
  id: string;
  name: string;
  client: string | null;
  city: string | null;
  state: string | null;
  lat: number;
  lng: number;
  open_work_orders: number;
  boundary_radius_ft: number | null;
}

// ── Buildings, floors, spaces ────────────────────────────────────────────────

export const SITE_LOCATION_KINDS = ['building', 'floor', 'space'] as const;
export type SiteLocationKind = (typeof SITE_LOCATION_KINDS)[number];

export const SITE_LOCATION_KIND_LABELS: Record<SiteLocationKind, string> = {
  building: 'Building',
  floor: 'Floor',
  space: 'Space',
};

export const SPACE_TYPE_SUGGESTIONS: readonly string[] = [
  'Kitchen', 'Dining room', 'Sales floor', 'Restroom', 'Office', 'Storage', 'Walk-in cooler',
  'Walk-in freezer', 'Mechanical room', 'Roof', 'Parking lot', 'Drive-through', 'Entrance', 'Loading dock',
];

/** What a new location of `kind` may sit under: null = straight on the site.
 *  A building is always on the site; a floor is always in a building; a space
 *  may be on a floor, in a building, or on the site itself. */
export function allowedParentKinds(kind: SiteLocationKind): (SiteLocationKind | null)[] {
  if (kind === 'building') return [null];
  if (kind === 'floor') return ['building'];
  return ['floor', 'building', null];
}

export function canNestUnder(kind: SiteLocationKind, parentKind: SiteLocationKind | null): boolean {
  return allowedParentKinds(kind).includes(parentKind);
}

export interface SiteLocationInput {
  kind?: SiteLocationKind;
  parent_id?: string | null;
  name?: string;
  level?: number | null;
  space_type?: string | null;
  area_sqft?: number | null;
  notes?: string | null;
}

export interface LocationNode extends SiteLocation {
  children: LocationNode[];
  depth: number;
}

const KIND_ORDER: Record<SiteLocationKind, number> = { building: 0, floor: 1, space: 2 };

/** The flat rows as a tree, each level ordered buildings → floors (top floor
 *  first, as a building reads) → spaces by name. A row whose parent is gone
 *  is shown at the top rather than lost. */
export function locationTree(rows: SiteLocation[]): LocationNode[] {
  const byId = new Map<string, LocationNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [], depth: 0 });
  const roots: LocationNode[] = [];
  for (const n of byId.values()) {
    const parent = n.parent_id ? byId.get(n.parent_id) : undefined;
    if (parent && parent.id !== n.id) parent.children.push(n);
    else roots.push(n);
  }
  const sort = (list: LocationNode[], depth: number) => {
    list.sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        (a.kind === 'floor' ? (b.level ?? 0) - (a.level ?? 0) : 0) ||
        a.position - b.position ||
        a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const n of list) {
      n.depth = depth;
      sort(n.children, depth + 1);
    }
  };
  sort(roots, 0);
  return roots;
}

/** The tree read top to bottom, for a select or a flat table. */
export function flattenLocations(nodes: LocationNode[]): LocationNode[] {
  const out: LocationNode[] = [];
  const walk = (list: LocationNode[]) => {
    for (const n of list) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** "Main building › Floor 1 › Kitchen" for one location. */
export function locationPath(rows: SiteLocation[], id: string | null): string {
  if (!id) return '';
  const byId = new Map(rows.map((r) => [r.id, r]));
  const parts: string[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 10) {
    parts.unshift(cur.name);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return parts.join(' › ');
}

// ── Assets ───────────────────────────────────────────────────────────────────

export const ASSET_STATUSES = ['in_service', 'out_of_service', 'retired'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];
export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  in_service: 'In service',
  out_of_service: 'Out of service',
  retired: 'Retired',
};

export const ASSET_CONDITIONS = ['good', 'fair', 'poor', 'critical'] as const;
export type AssetCondition = (typeof ASSET_CONDITIONS)[number];
export const ASSET_CONDITION_LABELS: Record<AssetCondition, string> = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  critical: 'Critical',
};

export type WarrantyState = 'none' | 'expired' | 'expiring' | 'active';

export const WARRANTY_STATE_LABELS: Record<WarrantyState, string> = {
  none: 'No warranty on file',
  expired: 'Warranty expired',
  expiring: 'Warranty ends soon',
  active: 'Under warranty',
};

/** Days before the end at which a warranty reads "ends soon". */
export const WARRANTY_SOON_DAYS = 60;

/** Where a warranty stands on `today` (both YYYY-MM-DD). The last day of a
 *  warranty is still under warranty. */
export function warrantyState(expiresOn: string | null | undefined, today: string): WarrantyState {
  if (!expiresOn) return 'none';
  if (expiresOn < today) return 'expired';
  const days = Math.round((Date.parse(`${expiresOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= WARRANTY_SOON_DAYS ? 'expiring' : 'active';
}

export interface AssetRow {
  id: string;
  source: SiteSource;
  name: string;
  asset_type: string | null;
  category: string | null;
  manufacturer: string | null;
  model_number: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  site: { id: string; name: string; client: string | null; city: string | null; state: string | null } | null;
  /** "Main building › Floor 1 › Kitchen", when it has been placed. */
  location: string | null;
  location_id: string | null;
  status: AssetStatus;
  condition: AssetCondition | null;
  warranty_expires_on: string | null;
  warranty: WarrantyState;
  work_orders: number;
  open_work_orders: number;
  created_at: string;
}

export interface AssetConditionEntry {
  id: string;
  condition: AssetCondition;
  note: string | null;
  wo_number: string | null;
  recorded_by: FeedActor | null;
  recorded_at: string;
}

export interface AssetDetail extends AssetRow {
  description: string | null;
  alt_description: string | null;
  install_date: string | null;
  warranty_provider: string | null;
  warranty_notes: string | null;
  notes: string | null;
  condition_at: string | null;
  parent: { id: string; name: string } | null;
  children: { id: string; name: string; asset_type: string | null; status: AssetStatus }[];
  condition_log: AssetConditionEntry[];
  /** The service history: work orders raised against this asset that the viewer may see. */
  service_history: SiteWorkOrder[];
  updated_at: string;
  can: { edit: boolean; delete: boolean };
}

export interface AssetInput {
  name?: string;
  site_id?: string | null;
  asset_type?: string | null;
  category?: string | null;
  manufacturer?: string | null;
  model_number?: string | null;
  serial_number?: string | null;
  asset_tag?: string | null;
  description?: string | null;
  install_date?: string | null;
  warranty_expires_on?: string | null;
  warranty_provider?: string | null;
  warranty_notes?: string | null;
  parent_asset_id?: string | null;
  location_id?: string | null;
  status?: AssetStatus;
  notes?: string | null;
}

export interface AssetsListResponse {
  items: AssetRow[];
  total: number;
  page: number;
  page_size: number;
}

export interface PortfolioHistoryEntry {
  id: string;
  action: string;
  actor: FeedActor | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  created_at: string;
}

// ── The work order's place ───────────────────────────────────────────────────

/** GET /work-orders/:id/place — what the Site card on a work order shows. */
export interface WoPlaceResponse {
  site: (Pick<SiteRow, 'id' | 'name' | 'client' | 'store_number' | 'address1' | 'city' | 'state' | 'zip' | 'site_type' | 'open_work_orders'> & {
    phone_1: string | null;
    hours: string | null;
    access_notes: string | null;
    lat: number | null;
    lng: number | null;
    boundary_radius_ft: number | null;
  }) | null;
  asset: (Pick<AssetRow, 'id' | 'name' | 'asset_type' | 'category' | 'model_number' | 'serial_number' | 'status' | 'condition' | 'warranty_expires_on' | 'warranty' | 'location'>) | null;
  /** Sites that look like this work order's (same client and store or city), when it has none. */
  suggestions: Pick<SiteRow, 'id' | 'name' | 'client' | 'store_number' | 'address1' | 'city' | 'state'>[];
  /** The linked site's assets, to pick from. */
  site_assets: { id: string; name: string; asset_type: string | null; location: string | null }[];
  can: { link: boolean; view_sites: boolean; view_assets: boolean };
}

/** What "create sites from work orders" would do, and did. */
export interface LinkWorkOrdersResult {
  /** Work orders with no site that name a client and a place. */
  candidates: number;
  /** Of those, how many match a site already on file. */
  would_link: number;
  /** Distinct places that would become new sites. */
  would_create: number;
  /** Work orders that name too little to place. */
  skipped: number;
  linked?: number;
  created?: number;
}

// ═══ 0061 · Clients, site access, asset requests, the admin lists ════════════

export const CLIENTS_PERM_KEY = 'clients';
export const ASSET_REQUESTS_PERM_KEY = 'assets/requests';
export const ADMIN_PORTFOLIO_SLUG = 'portfolio';

export function clientPermNodes(): PermNode[] {
  return [
    {
      key: CLIENTS_PERM_KEY,
      label: 'Clients',
      actions: ['view', 'create', 'edit', 'delete'],
      note: 'The client records: who to talk to, where to bill, notes. Which client a work order belongs to is still the work order’s own Client field.',
    },
  ];
}

/** Sits under Assets in the permission tree. */
export function assetRequestPermNode(): PermNode {
  return {
    key: ASSET_REQUESTS_PERM_KEY,
    label: 'Asset requests',
    actions: ['create', 'approve'],
    note: 'Create = ask for an asset to be added, replaced, retired or moved; approve = decide a request (approving makes the change).',
  };
}

// ── Clients ──────────────────────────────────────────────────────────────────

export interface ClientRow {
  id: string;
  name: string;
  code: string | null;
  account_manager: FeedActor | null;
  billing_entity: string | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  portal_type: string | null;
  is_active: boolean;
  sites: number;
  assets: number;
  work_orders: number;
  open_work_orders: number;
  created_at: string;
}

export interface ClientDetail extends ClientRow {
  billing_email: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  site_list: SiteRow[];
  recent_work_orders: SiteWorkOrder[];
  contracts: { id: string; name: string; status: string | null }[];
  updated_at: string;
  can: { edit: boolean; delete: boolean };
}

export interface ClientInput {
  name?: string;
  code?: string | null;
  account_manager?: string | null;
  billing_entity?: string | null;
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  billing_email?: string | null;
  address?: string | null;
  portal_type?: string | null;
  payment_terms?: string | null;
  notes?: string | null;
  is_active?: boolean;
}

export interface ClientsListResponse {
  items: ClientRow[];
  total: number;
  people: FeedActor[];
  billing_entities: string[];
  can: { create: boolean; edit: boolean; delete: boolean };
}

export const CLIENT_PORTAL_TYPES = ['Ecotrak', 'Corrigo', 'ServiceChannel', 'Email', 'Other'] as const;

// ── Asset management requests ────────────────────────────────────────────────

export const ASSET_REQUEST_TYPES = ['add', 'replace', 'retire', 'move'] as const;
export type AssetRequestType = (typeof ASSET_REQUEST_TYPES)[number];

export const ASSET_REQUEST_TYPE_LABELS: Record<AssetRequestType, string> = {
  add: 'Add an asset',
  replace: 'Replace an asset',
  retire: 'Retire an asset',
  move: 'Move an asset',
};

export type AssetRequestStatus = 'open' | 'approved' | 'rejected' | 'withdrawn';

export const ASSET_REQUEST_STATUS_LABELS: Record<AssetRequestStatus, string> = {
  open: 'Waiting',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

/** What a new asset is described by, on an add or a replace. */
export interface AssetRequestProposal {
  name?: string | null;
  category?: string | null;
  asset_type?: string | null;
  manufacturer?: string | null;
  model_number?: string | null;
  serial_number?: string | null;
  /** add / replace: where it will stand. move: where it goes. */
  location_id?: string | null;
}

export interface AssetRequest {
  id: string;
  type: AssetRequestType;
  asset: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  reason: string;
  proposed: AssetRequestProposal;
  wo_number: string | null;
  status: AssetRequestStatus;
  requested_by: FeedActor | null;
  decided_by: FeedActor | null;
  decided_at: string | null;
  decision_note: string | null;
  result_asset: { id: string; name: string } | null;
  created_at: string;
  /** What the viewer may do with this one. */
  can: { decide: boolean; withdraw: boolean };
}

export interface AssetRequestInput {
  type: AssetRequestType;
  asset_id?: string | null;
  site_id?: string | null;
  reason: string;
  proposed?: AssetRequestProposal;
  wo_number?: string | null;
}

export interface AssetRequestsResponse {
  requests: AssetRequest[];
  open: number;
  can: { create: boolean; approve: boolean };
}

/** What a request needs before it can be raised; null when it is complete. */
export function assetRequestProblem(input: AssetRequestInput): string | null {
  if (!(ASSET_REQUEST_TYPES as readonly string[]).includes(input.type)) return 'Say what you are asking for';
  if ((input.reason ?? '').trim() === '') return 'Say why';
  const p = input.proposed ?? {};
  if (input.type === 'add') {
    if (!input.site_id) return 'Say which site the asset is at';
    if (!(p.name ?? '').trim()) return 'Name the asset';
    return null;
  }
  if (!input.asset_id) return 'Say which asset';
  if (input.type === 'replace' && !(p.name ?? '').trim()) return 'Name the replacement';
  if (input.type === 'move' && !input.site_id && !p.location_id) return 'Say where it should go';
  return null;
}

// ── Admin › Sites & assets ───────────────────────────────────────────────────

export type PortfolioListName = 'site-types' | 'asset-categories';

export interface PortfolioListItem {
  name: string;
  position: number;
  is_active: boolean;
  /** How many live records carry it. */
  in_use: number;
}

export interface SiteAccessPerson {
  principal: FeedActor;
  role_label: string | null;
  sites: { id: string; name: string; city: string | null; state: string | null }[];
}

export interface AdminPortfolioResponse {
  site_types: PortfolioListItem[];
  asset_categories: PortfolioListItem[];
  /** People restricted to a list of sites. Only super admins receive (and set) this. */
  site_access: SiteAccessPerson[] | null;
  people: (FeedActor & { role_label: string | null; is_super_admin: boolean })[];
}

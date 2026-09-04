// ── Permissions (migration 0015) ─────────────────────────────────────────────
//
// One vocabulary for "who may do what", shared by the API (which enforces it)
// and the web (which hides what the server would refuse).
//
// A permission is addressed by a PATH — 'work_orders', 'work_orders/tabs/money',
// 'work_orders/fields/finances/fields.34. Cost' — and an ACTION. A grant that is
// not set on a path INHERITS from its parent path, so an administrator can
// switch a whole section on with one toggle and then carve out exceptions
// underneath it, field by field.
//
// Two layers are consulted, most specific first:
//   1. the user's own overrides   (principal.permission_overrides)
//   2. the role's grants          (role.permissions)
// Each layer walks up its own path chain; the first explicit answer wins. A
// user-level override therefore beats the role even when the role is more
// specific — "for this person, exactly this" is what the override screen is
// for. Nothing set anywhere means NO.
//
// Super admins skip all of it: every check answers yes.

export type PermAction = 'view' | 'create' | 'edit' | 'delete' | 'approve';

export const PERM_ACTIONS: readonly PermAction[] = ['view', 'create', 'edit', 'delete', 'approve'];

export const PERM_ACTION_LABELS: Record<PermAction, string> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  approve: 'Approve',
};

/** The explicit grants on one path. An absent action inherits. */
export type PermGrant = Partial<Record<PermAction, boolean>>;

/** path → grants. Stored as JSONB on `role` and on `principal`. */
export type PermMap = Record<string, PermGrant>;

/** What a session carries: the role's map and the person's own overrides. */
export interface PermissionSet {
  role: PermMap;
  overrides: PermMap;
}

export const EMPTY_PERMISSION_SET: PermissionSet = { role: {}, overrides: {} };

export function permParent(key: string): string | null {
  const i = key.lastIndexOf('/');
  return i < 0 ? null : key.slice(0, i);
}

/** Walk one map up the path chain; undefined when nothing on the chain says. */
export function resolvePerm(
  map: PermMap | null | undefined,
  key: string,
  action: PermAction,
): boolean | undefined {
  if (!map) return undefined;
  let k: string | null = key;
  while (k !== null) {
    const v = map[k]?.[action];
    if (typeof v === 'boolean') return v;
    k = permParent(k);
  }
  return undefined;
}

/** The one decision function. Both layers, then the default (no). */
export function permAllows(
  set: PermissionSet | null | undefined,
  key: string,
  action: PermAction,
  superAdmin = false,
): boolean {
  if (superAdmin) return true;
  if (!set) return false;
  return resolvePerm(set.overrides, key, action) ?? resolvePerm(set.role, key, action) ?? false;
}

/** Drop empty grant objects and anything that is not a boolean, so the stored
    JSON only ever holds decisions. Unknown paths are kept — a path is data,
    and a field that does not exist yet is not an error. */
export function normalizePermMap(raw: unknown): PermMap {
  const out: PermMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, grant] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof key !== 'string' || key.length === 0 || key.length > 400) continue;
    if (!grant || typeof grant !== 'object' || Array.isArray(grant)) continue;
    const g: PermGrant = {};
    for (const action of PERM_ACTIONS) {
      const v = (grant as Record<string, unknown>)[action];
      if (typeof v === 'boolean') g[action] = v;
    }
    if (Object.keys(g).length > 0) out[key] = g;
  }
  return out;
}

// ── The work-order field sections ────────────────────────────────────────────
// The operator's grouping of the custom-field catalogue (2026-08). It is the
// All-fields tab's default layout AND the middle level of every field's
// permission path, so "hide Finances" is one toggle on 'work_orders/fields/finances'.
// Keys are catalogue keys (`fields.<json key>`), stable across label renames.

export interface FieldSectionDef {
  title: string;
  /** Path segment under work_orders/fields/. */
  slug: string;
  keys: string[];
  /** Spans the full width of the All-fields section grid. */
  wide?: boolean;
}

export const FIELD_SECTIONS: FieldSectionDef[] = [
  {
    title: 'Overview',
    slug: 'overview',
    wide: true,
    keys: [
      'fields.35. WO Description',
      'fields.20. Last Update',
      'fields.29. PDF Link',
      'fields.28. Sharepoint Link',
      'fields.37. PDF',
      'fields.Trade',
    ],
  },
  {
    title: 'Client',
    slug: 'client',
    keys: ['fields.✅ Client AFM', 'fields.22. FM', 'fields.Client', 'fields.Store'],
  },
  {
    title: 'Site',
    slug: 'site',
    keys: ['fields.17. Address', 'fields.City', 'fields.State', 'fields.Zip Code'],
  },
  {
    title: 'Finances',
    slug: 'finances',
    keys: [
      'fields.1. Not Fully Paid',
      'fields.16. Client NTE 🔴',
      'fields.34. Cost',
      'fields.Total Invoiced',
      'fields.Profit',
      'fields.Discount',
      'fields.Client Quote',
    ],
  },
  {
    title: 'Dates',
    slug: 'dates',
    keys: [
      'fields.❌Today',
      'fields.🚨 SLA Requested',
      'fields.🚨 SLA Updated',
      'fields.Date-Time Received',
      'fields.Date Created',
      'fields.Due Date',
    ],
  },
  {
    title: 'CICO',
    slug: 'cico',
    keys: [
      'fields.18. Check-in/out Status',
      'fields.25. IVR Link',
      'fields.30. IVR Pin',
      'fields.CICO Method',
      'fields.24. Sign-Off Link',
    ],
  },
  {
    title: 'People',
    slug: 'people',
    keys: [
      'fields.AM',
      'fields.TL',
      'fields.Assignee',
      'fields.Completion Assignee',
      'fields.Previous Assignees',
      'fields.Sales Owner',
    ],
  },
  {
    title: 'Technician',
    slug: 'technician',
    keys: ['fields.Tech Name', 'fields.Tech Phone Number', 'fields.Tech Map', 'fields.Tech Quote'],
  },
  {
    title: 'Payments',
    slug: 'payments',
    keys: ['fields.26. PPR Link', 'fields.27. Yoda Link'],
  },
  {
    title: 'Invoicing',
    slug: 'invoicing',
    keys: ['fields.Invoice #', 'fields.Invoice Date', 'fields.Days since Invoiced'],
  },
  {
    title: 'AR',
    slug: 'ar',
    keys: [
      'fields.12. Bad quote',
      'fields.Admin Comment',
      'fields.Grey Flag Date',
      'fields.Quote Check',
      'fields.Audited',
      'fields.GTG',
    ],
  },
  {
    title: 'QC',
    slug: 'qc',
    keys: [
      'fields.MoD Call',
      'fields.MoD Call Notes',
      'fields.QC Date',
      'fields.Days Since QC',
      'fields.MOD Date',
    ],
  },
  {
    title: 'Other',
    slug: 'other',
    keys: ['fields.Days since Done', 'fields.Show in CA'],
  },
  {
    title: 'Integrations',
    slug: 'integrations',
    keys: ['fields.Ecotrak ID'],
  },
];

/** Custom fields no section names. */
export const MORE_SECTION_SLUG = 'more';
export const MORE_SECTION_TITLE = 'More fields';
/** The promoted columns (client, city, NTE, …) — the work order's own header. */
export const HEADER_SECTION_SLUG = 'header';
export const HEADER_SECTION_TITLE = 'Work order header';

const SECTION_SLUG_BY_KEY = new Map<string, string>();
FIELD_SECTIONS.forEach((sec) => sec.keys.forEach((k) => SECTION_SLUG_BY_KEY.set(k, sec.slug)));

/** Which section a catalogue key belongs to, as a path segment. */
export function fieldSectionSlug(catalogueKey: string): string {
  if (!catalogueKey.startsWith('fields.')) return HEADER_SECTION_SLUG;
  return SECTION_SLUG_BY_KEY.get(catalogueKey) ?? MORE_SECTION_SLUG;
}

export const WO_FIELDS_PERM_ROOT = 'work_orders/fields';

/** The permission path of one catalogue field. */
export function fieldPermKey(catalogueKey: string): string {
  return `${WO_FIELDS_PERM_ROOT}/${fieldSectionSlug(catalogueKey)}/${catalogueKey}`;
}

/** The permission path of one field SECTION. */
export function fieldSectionPermKey(slug: string): string {
  return `${WO_FIELDS_PERM_ROOT}/${slug}`;
}

// ── The work-order detail tabs ───────────────────────────────────────────────

export const WO_TABS: { id: string; label: string }[] = [
  { id: 'fields', label: 'All fields' },
  { id: 'money', label: 'Finances' },
  { id: 'dates', label: 'Dates' },
  { id: 'cico', label: 'CICO' },
  { id: 'people', label: 'People' },
  { id: 'payables', label: 'Payables' },
  { id: 'site', label: 'Site' },
  { id: 'parts', label: 'Parts' },
  { id: 'flags', label: 'Flags' },
  { id: 'overview', label: 'Overview' },
  { id: 'messages', label: 'Messages' },
  { id: 'audit', label: 'Audit trail' },
];

export function tabPermKey(tabId: string): string {
  return `work_orders/tabs/${tabId}`;
}

// ── The admin console sections ───────────────────────────────────────────────

export const ADMIN_PERM_SECTIONS: { slug: string; label: string; actions: PermAction[] }[] = [
  { slug: 'users', label: 'Users', actions: ['view', 'edit'] },
  { slug: 'roles', label: 'Roles', actions: ['view', 'edit'] },
  { slug: 'settings', label: 'Settings', actions: ['view'] },
  { slug: 'automations', label: 'Automations', actions: ['view', 'edit'] },
  { slug: 'fields', label: 'Custom fields', actions: ['view', 'edit'] },
  { slug: 'themes', label: 'Themes', actions: ['view'] },
  { slug: 'audit', label: 'Audit log', actions: ['view'] },
  { slug: 'trash', label: 'Trash', actions: ['view', 'edit'] },
];

export function adminPermKey(slug: string): string {
  return `admin/${slug}`;
}

// ── The tree the permission editor renders ───────────────────────────────────

export interface PermNode {
  key: string;
  label: string;
  /** Which actions make sense here; the others render blank. */
  actions: PermAction[];
  note?: string;
  children?: PermNode[];
}

export interface PermFieldInfo {
  key: string;
  label: string;
  custom?: boolean;
}

/**
 * Every permission the product has, as a tree — sections at the top, then
 * tabs, field sections and fields under Work orders, and the admin sections
 * under Admin. Built from the live field catalogue so an admin-added field
 * shows up (under "More fields") without a deploy.
 */
export function buildPermissionTree(fields: PermFieldInfo[]): PermNode[] {
  const bySection = new Map<string, PermFieldInfo[]>();
  for (const f of fields) {
    const slug = fieldSectionSlug(f.key);
    const list = bySection.get(slug) ?? [];
    list.push(f);
    bySection.set(slug, list);
  }
  // Curated sections in their order, then the header columns, then the rest.
  const orderIndex = new Map<string, number>();
  FIELD_SECTIONS.forEach((s, i) => orderIndex.set(s.slug, i));
  const sectionNodes: PermNode[] = [];
  const sectionTitle = (slug: string) =>
    slug === HEADER_SECTION_SLUG
      ? HEADER_SECTION_TITLE
      : slug === MORE_SECTION_SLUG
        ? MORE_SECTION_TITLE
        : (FIELD_SECTIONS.find((s) => s.slug === slug)?.title ?? slug);
  const sectionOrder = (slug: string) =>
    slug === HEADER_SECTION_SLUG ? -1 : (orderIndex.get(slug) ?? FIELD_SECTIONS.length);
  for (const slug of [...bySection.keys()].sort((a, b) => sectionOrder(a) - sectionOrder(b))) {
    const members = bySection.get(slug) ?? [];
    const keyOrder =
      slug === HEADER_SECTION_SLUG || slug === MORE_SECTION_SLUG
        ? null
        : (FIELD_SECTIONS.find((s) => s.slug === slug)?.keys ?? null);
    const sorted = keyOrder
      ? [...members].sort((a, b) => keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key))
      : members;
    sectionNodes.push({
      key: fieldSectionPermKey(slug),
      label: sectionTitle(slug),
      actions: ['view', 'edit'],
      children: sorted.map((f) => ({
        key: fieldPermKey(f.key),
        label: f.label,
        actions: ['view', 'edit'],
      })),
    });
  }

  return [
    { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
    {
      key: 'work_orders',
      label: 'Work orders',
      actions: ['view', 'create', 'edit', 'delete'],
      note: 'Create = import; edit = field values and status; delete = bulk delete to Trash.',
      children: [
        { key: 'work_orders/status', label: 'Change status', actions: ['edit'] },
        { key: 'work_orders/comments', label: 'Post updates', actions: ['create'] },
        { key: 'work_orders/export', label: 'Export to CSV', actions: ['view'] },
        { key: 'work_orders/history', label: 'Field history', actions: ['view'] },
        {
          key: 'work_orders/tabs',
          label: 'Detail tabs',
          actions: ['view'],
          children: WO_TABS.map((t) => ({ key: tabPermKey(t.id), label: t.label, actions: ['view'] })),
        },
        {
          key: WO_FIELDS_PERM_ROOT,
          label: 'Fields',
          actions: ['view', 'edit'],
          note: 'A hidden field is left out of the detail page, the list columns, filters and exports.',
          children: sectionNodes,
        },
      ],
    },
    {
      key: 'quotes',
      label: 'Quotes',
      actions: ['view', 'create', 'edit', 'approve'],
      note: 'Approve also covers reject and send to the client CMMS.',
    },
    { key: 'payments', label: 'Payment requests', actions: ['view', 'create'] },
    { key: 'vendors', label: 'Vendors', actions: ['view', 'create', 'edit', 'delete'], note: 'Module not live yet.' },
    { key: 'invoicing', label: 'Invoicing', actions: ['view', 'create', 'edit', 'delete'], note: 'Module not live yet.' },
    {
      key: 'admin',
      label: 'Admin console',
      actions: ['view', 'edit'],
      note: 'Super admins always have every permission; this is for everyone else.',
      children: ADMIN_PERM_SECTIONS.map((s) => ({
        key: adminPermKey(s.slug),
        label: s.label,
        actions: s.actions,
      })),
    },
  ];
}

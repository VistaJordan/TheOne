// ── UAT round 1, Wave B (migration 0084): access and scope ───────────────────
//
// The pure half of Wave B — the vocabulary both the API (which enforces it)
// and the web (which locks the control before the click) read. Nothing here
// opens a database. The decisions behind each block are D3 / D4 / #12–#18 /
// M13 / M28 in docs/specs/uat-round-1.md.

import {
  FIELD_SECTIONS,
  PERM_ACTIONS,
  fieldPermKey,
  fieldSectionSlug,
  permAllows,
  resolvePerm,
  type PermAction,
  type PermissionSet,
  type PermMap,
} from './permissions';
import { SPAN_END_FIELD } from './dashboards';

// ── D3 · who is a dispatcher ─────────────────────────────────────────────────
// OM Under Probation is the dispatcher under probation (the Ops Coordinator
// position: one role since migration 0088 merged ops_coord into it), OM is a
// dispatcher, Senior OM a senior dispatcher. ONE list, so the assignee
// picker, intake submit, Accept and Add work order (Wave D) all agree.

export const DISPATCHER_ROLE_CODES = ['om_probation', 'om', 'senior_om'] as const;
export type DispatcherRoleCode = (typeof DISPATCHER_ROLE_CODES)[number];
export type DispatcherTier = 'probation' | 'dispatcher' | 'senior';

export const DISPATCHER_TIER_BY_ROLE: Record<DispatcherRoleCode, DispatcherTier> = {
  om_probation: 'probation',
  om: 'dispatcher',
  senior_om: 'senior',
};

export function isDispatcherRole(code: string | null | undefined): code is DispatcherRoleCode {
  return typeof code === 'string' && (DISPATCHER_ROLE_CODES as readonly string[]).includes(code);
}

export function dispatcherTier(code: string | null | undefined): DispatcherTier | null {
  return isDispatcherRole(code) ? DISPATCHER_TIER_BY_ROLE[code] : null;
}

// ── M13 · who sees money ─────────────────────────────────────────────────────
// TL and above, plus the two finance desks, see Cost, Profit and the money
// totals; every other role sees the Margin % (0084 hides the rest). The list
// is what 0084 leaves alone; the hidden keys are what it sets view = false on.

export const MONEY_ROLE_CODES = ['admin', 'tl', 'atl', 'am', 'ar', 'ap'] as const;

export function seesMoneyRole(code: string | null | undefined): boolean {
  return typeof code === 'string' && (MONEY_ROLE_CODES as readonly string[]).includes(code);
}

/** The money figures a non-money role does not see (catalogue keys). NTE and
    the Client Quote text stay: a dispatcher works to the NTE. */
export const MONEY_HIDDEN_FIELD_KEYS = [
  'fields.34. Cost',
  'fields.Profit',
  'fields.Total Invoiced',
  'fields.Discount',
] as const;

/** The computed Margin % column (0084) — Profit over Total Invoiced. It is a
    header-section path (`work_orders/fields/header/margin_pct`), so a role
    that hides Cost and Profit still sees it. */
export const MARGIN_PCT_KEY = 'margin_pct';

/** The permission paths 0084 sets `{view: false, edit: false}` on. */
export function moneyHiddenPermKeys(): string[] {
  return MONEY_HIDDEN_FIELD_KEYS.map((k) => fieldPermKey(k));
}

// ── #17 · which columns may leave the building ───────────────────────────────
// `field_def.client_safe` (0084) says whether a custom field may go out on a
// shared Client Update. These are its defaults: off for the Finances,
// Payments (AP), Invoicing and AR sections; on everywhere else. Core columns
// are not field_defs: the one money column among them (Margin %) is off.

export const CLIENT_UNSAFE_SECTION_SLUGS = ['finances', 'payments', 'invoicing', 'ar'] as const;
export const CLIENT_UNSAFE_CORE_KEYS = [MARGIN_PCT_KEY] as const;

/** The default for a catalogue key, before anyone flips it in Admin › Custom fields. */
export function defaultClientSafe(catalogueKey: string): boolean {
  if (!catalogueKey.startsWith('fields.')) {
    return !(CLIENT_UNSAFE_CORE_KEYS as readonly string[]).includes(catalogueKey);
  }
  if ((MONEY_HIDDEN_FIELD_KEYS as readonly string[]).includes(catalogueKey)) return false;
  return !(CLIENT_UNSAFE_SECTION_SLUGS as readonly string[]).includes(fieldSectionSlug(catalogueKey));
}

/** The JSON keys (inside task.fields) that start client-safe = false: what
    0084 UPDATEs and what seed.ts re-applies after it re-inserts field_def. */
export function clientUnsafeDefaultBagKeys(): string[] {
  const keys = new Set<string>();
  for (const sec of FIELD_SECTIONS) {
    if (!(CLIENT_UNSAFE_SECTION_SLUGS as readonly string[]).includes(sec.slug)) continue;
    for (const k of sec.keys) keys.add(k.slice('fields.'.length));
  }
  for (const k of MONEY_HIDDEN_FIELD_KEYS) keys.add(k.slice('fields.'.length));
  return [...keys].sort();
}

/** The 400 a tracker save gets when a shared column is not client-safe. */
export const CLIENT_UNSAFE_COLUMNS_CODE = 'CLIENT_UNSAFE_COLUMNS';

// ── #18 · nobody raises their own rights ─────────────────────────────────────

export const SELF_EDIT_CODE = 'SELF_EDIT';
export const GRANT_EXCEEDS_OWN_CODE = 'GRANT_EXCEEDS_OWN';
export const ROLE_EDIT_RESTRICTED_CODE = 'ROLE_EDIT_RESTRICTED';

export const SELF_EDIT_MESSAGE =
  'You cannot change your own role, status, clients or permissions — ask another administrator.';
export const ROLE_EDIT_MESSAGE = 'Only a super admin or someone in the Admin role can change roles.';

/** Role DEFINITIONS (Admin › Roles: create, change, delete) are edited by
    super admins and by people in these roles — on top of `admin/roles` edit. */
export const ROLE_EDITOR_ROLE_CODES = ['admin'] as const;

export function mayEditRoleDefinitions(p: { isSuperAdmin: boolean; role: string | null | undefined }): boolean {
  return p.isSuperAdmin || (typeof p.role === 'string' && (ROLE_EDITOR_ROLE_CODES as readonly string[]).includes(p.role));
}

/**
 * Every `path:action` that `granted` lets through and the actor does not hold
 * themselves — empty means the grant is within the actor's own rights. Only a
 * `true` is a grant: a `false` narrows and is never an escalation. Two ways
 * to exceed: a true at a path the actor is refused at, or a true ABOVE a
 * path where the actor has their own explicit refusal (granting
 * `work_orders` view while the actor cannot see Finances would hand out
 * Finances), unless the grant narrows that path again itself. `previous` —
 * the map being replaced — exempts what it already granted at the same path,
 * so editing one row of a role does not re-litigate the rest.
 */
export function grantsExceeding(
  actor: PermissionSet,
  actorIsSuperAdmin: boolean,
  granted: PermMap,
  previous: PermMap = {},
): string[] {
  if (actorIsSuperAdmin) return [];
  const own = new Set<string>([...Object.keys(actor.role ?? {}), ...Object.keys(actor.overrides ?? {})]);
  const out = new Set<string>();
  for (const [path, grant] of Object.entries(granted)) {
    for (const action of PERM_ACTIONS) {
      if (grant[action] !== true) continue;
      if (previous[path]?.[action] === true) continue;
      if (!permAllows(actor, path, action)) {
        out.add(`${path}:${action}`);
        continue;
      }
      for (const k of own) {
        if (!k.startsWith(`${path}/`)) continue;
        if (permAllows(actor, k, action)) continue;
        if (resolvePerm(granted, k, action) === true) out.add(`${k}:${action}`);
      }
    }
  }
  return [...out].sort();
}

/** The grants one action set reads as, for a 403's sentence. */
export function describeGrants(list: string[], max = 4): string {
  const shown = list.slice(0, max).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
}

// ── M28 · a hidden field stays hidden everywhere ─────────────────────────────

/** The promoted columns a payload can go without (the API redacts them).
    Identity (id, wo_number, title, status) always ships. */
export const REDACTABLE_CORE_KEYS = [
  'ext_name',
  'description',
  'client',
  'city',
  'state',
  'trade',
  'billing_entity',
  'nte',
  'priority',
  'date_received',
] as const;

/**
 * The catalogue key an audit row's `field` names, when it names one — the
 * key `canViewField` is asked about. 'fields.<key>' and the promoted columns
 * do; 'status_id', 'visit:<id>', 'invoice:<id>' and the rest are not fields
 * and pass untouched. Admin rows name a field_def as 'fields.<key>' too: a
 * person who cannot see the field does not read its definition's history.
 */
export function activityFieldKey(field: string | null | undefined): string | null {
  if (!field) return null;
  if (field.startsWith('fields.')) return field;
  return (REDACTABLE_CORE_KEYS as readonly string[]).includes(field) ? field : null;
}

/** Every work-order field a dashboard card's question reads: what it totals,
    cuts by, runs along, filters on, or measures between. Other sources (the
    money records) name their own columns, not the catalogue, and return []. */
export function widgetNamedFields(config: {
  source?: string | null;
  value_field?: string;
  group_field?: string;
  time_field?: string;
  filters?: { rules?: { field: string }[] } | null;
  from?: { kind: string; field: string } | null;
  to?: { kind: string; field: string } | null;
}): string[] {
  if (config.source && config.source !== 'work_orders') return [];
  const out = new Set<string>();
  for (const k of [config.value_field, config.group_field, config.time_field]) if (k) out.add(k);
  for (const r of config.filters?.rules ?? []) if (r?.field) out.add(r.field);
  for (const leg of [config.from, config.to]) if (leg?.field) out.add(leg.field);
  // The span's own end is not a field (SPAN_END_FIELD in dashboards.ts).
  out.delete(SPAN_END_FIELD);
  return [...out];
}

/** What a card answers when it names a field the viewer may not see. */
export const WIDGET_NOT_AVAILABLE = 'not available';

// ── M29 · a site restriction is a flag, not "has rows" ───────────────────────
// `principal.site_restricted` (0084): on with an empty list = no sites at all;
// off = no restriction, whatever principal_site still holds.

export interface SiteRestriction {
  restricted: boolean;
  site_ids: string[];
}

/** Which actions a role grant holds at one path, as a short list. */
export function grantedActions(map: PermMap, path: string): PermAction[] {
  return PERM_ACTIONS.filter((a) => map[path]?.[a] === true);
}

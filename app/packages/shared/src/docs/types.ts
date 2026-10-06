// 0075 · Admin › Documentation — the shapes of the living documents.
//
// Three documents are drawn from this package: the BRD (what the system does
// and why, every feature with the value it brings), the SOP (how people
// operate it, step by step) and the work-order lifecycle (the picture). The
// prose is hand-written here from the screens and the rules; the live parts
// (statuses, fields, roles, automations, integrations, migrations) are read
// from the database when the page opens, so the documents describe the
// instance as it is right now.
//
// WHEN A FEATURE, A BUTTON LABEL OR A RULE CHANGES, CHANGE ITS ENTRY HERE.
// tests/docs.test.ts fails when a sidebar item, admin section, work-order
// tab, integration or status exists that the registry never mentions.

/** One control the person can act on, with the label as it is on screen. */
export interface DocControl {
  /** The label on screen (button, menu item, switch, column). */
  label: string;
  /** What pressing it does, in one sentence. */
  does: string;
}

/** One feature of a module. */
export interface DocFeature {
  /** The feature's name as the team says it. */
  name: string;
  /** What it does. */
  what: string;
  /** The value it brings to the business, in plain words. */
  value: string;
  /** Buttons, menus, switches and columns on screen. */
  controls?: DocControl[];
  /** The rules the system enforces for it (what is refused, what is automatic). */
  rules?: string[];
  /** Permission paths the API checks (`section/sub` · action). */
  permissions?: string[];
  /** Audit-log event names written by it. */
  audit?: string[];
  /** BRD rule numbers it fulfils, e.g. '2.4.1'. */
  brd?: string[];
  /** The migration or batch it arrived with, e.g. '0036'. */
  since?: string;
  /** What is deliberately not built yet, or deferred by decision. */
  deferred?: string[];
}

/** One module of the application (a sidebar destination, a tab, or a cross-cutting concern). */
export interface DocModule {
  /** Stable key, kebab-case. */
  key: string;
  /** Title as the chapter heading. */
  title: string;
  /** Where it is reached (sidebar item, tab, button). */
  where: string;
  /** What this module is for. */
  purpose: string;
  /** The business value, as a short paragraph. */
  value: string;
  /** Who uses it (role names as on the Roles screen). */
  users?: string[];
  features: DocFeature[];
}

/** A part of the BRD groups modules under one heading. */
export interface DocPart {
  key: string;
  title: string;
  /** One paragraph introducing the part. */
  intro: string;
  modules: DocModule[];
}

/** One line of the business rules register. */
export interface DocRule {
  /** The BRD number, e.g. '1.5.2'. */
  id: string;
  title: string;
  /** What the rule says, as the system applies it. */
  statement: string;
  /** Where in the app it is enforced (screen, service or gate). */
  enforced: string;
  state: 'built' | 'partial' | 'deferred';
  /** Why partial or deferred. */
  note?: string;
}

// ── SOP ──────────────────────────────────────────────────────────────────────

export type SopBlock =
  | { kind: 'p'; text: string }
  | { kind: 'sub'; title: string }
  | { kind: 'steps'; items: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'note'; title: string; text: string };

export interface SopProcedure {
  /** 1-based, printed as "SOP n". */
  n: number;
  title: string;
  /** The grey lead line under the heading. */
  lead: string;
  /** Who performs it (role names). */
  who: string[];
  /** The screen or screens. */
  where: string;
  /** Permission paths the API checks for the steps. */
  needs: string[];
  blocks: SopBlock[];
}

export interface SopTerm {
  term: string;
  definition: string;
}

export interface SopDocument {
  title: string;
  subtitle: string;
  /** "Document control" box. */
  control: string;
  purpose: string[];
  scope: string;
  whoCanUse: string;
  terms: SopTerm[];
  procedures: SopProcedure[];
  successMetric: string;
  /** Role → the procedures that role performs (numbers). */
  matrix: { role: string; procedures: number[] }[];
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export type LifecycleEdgeKind = 'main' | 'system' | 'branch' | 'exception';

export interface LifecycleNode {
  /** The status name exactly as seeded (PHASE_BY_STATUS_NAME key). */
  status: string;
  /** What the status means for the team. */
  meaning: string;
  /** How a work order usually gets here (button, visit, system). */
  enteredBy: string;
  /** What the system does when a work order lands here. */
  onEnter?: string[];
  /** Who normally moves a work order into it. */
  who: string;
  /** Gate code from statusGates ('quote' | 'parts' | 'done') or 'intake'. */
  gate?: 'quote' | 'parts' | 'done';
}

export interface LifecycleEdge {
  from: string;
  to: string;
  /** Short label drawn on the arrow. */
  label?: string;
  kind: LifecycleEdgeKind;
}

export interface LifecycleStage {
  key: string;
  title: string;
  /** Phase names from PHASE_ORDER this stage covers (null phase = off-ramp). */
  phases: string[];
  summary: string;
  /** Roles acting here. */
  who: string[];
}

/** A process that runs beside the status line and attaches to some statuses. */
export interface LifecycleSideProcess {
  key: string;
  title: string;
  /** Statuses it is attached to (drawn as a tether). */
  statuses: string[];
  summary: string;
  steps: string[];
  /** BRD rule numbers. */
  brd?: string[];
}

export interface LifecycleModel {
  stages: LifecycleStage[];
  nodes: LifecycleNode[];
  edges: LifecycleEdge[];
  side: LifecycleSideProcess[];
  /** Legend text per edge kind. */
  legend: Record<LifecycleEdgeKind, string>;
}

// ── The live snapshot the API answers (GET /admin/docs/snapshot) ─────────────

export interface DocsSnapshotStatus {
  name: string;
  group: string;
  color: string;
  position: number;
  is_archive: boolean;
  phase: string | null;
  wo_count: number;
}

export interface DocsSnapshotField {
  key: string;
  label: string;
  type: string;
  section: string;
  options: string[];
  create_mode: string;
  used_by: number;
  computed: boolean;
  visit_owned: boolean;
}

export interface DocsSnapshotRole {
  code: string;
  label: string;
  description: string | null;
  is_system: boolean;
  user_count: number;
  /** Section-level grants, as drawn on the Roles screen's first level. */
  sections: { key: string; label: string; view: boolean; create: boolean; edit: boolean; delete: boolean; approve: boolean }[];
  wo_scope: 'everything' | 'only_theirs';
  status_mode: 'direct' | 'request' | 'none';
}

export interface DocsSnapshotAutomation {
  name: string;
  enabled: boolean;
  trigger: string;
  conditions: number;
  actions: string[];
  run_count: number;
}

export interface DocsSnapshotIntegration {
  key: string;
  name: string;
  group: string;
  enabled: boolean;
  built: boolean;
  configured: boolean;
  summary: string;
}

export interface DocsSnapshotMigration {
  n: number;
  filename: string;
  title: string;
  applied_at: string | null;
}

export interface DocsSnapshot {
  generated_at: string;
  instance: {
    auth_mode: 'entra' | 'bypass';
    node_env: string;
    web_origin: string;
    database: string;
    migrations_applied: number;
    latest_migration: string | null;
  };
  counts: {
    work_orders: number;
    users: number;
    roles: number;
    statuses: number;
    fields: number;
    automations: number;
    saved_views: number;
    dashboards: number;
    vendors: number;
    sites: number;
    assets: number;
    clients: number;
    quotes: number;
    invoices: number;
    payment_requests: number;
    audit_rows: number;
  };
  super_admins: string[];
  service_principals: string[];
  status_groups: { code: string; label: string; position: number; is_builtin: boolean; status_count: number }[];
  statuses: DocsSnapshotStatus[];
  fields: DocsSnapshotField[];
  roles: DocsSnapshotRole[];
  automations: DocsSnapshotAutomation[];
  integrations: DocsSnapshotIntegration[];
  approval_tiers: { kind: string; label: string; min_amount: number; max_amount: number | null; roles: string[] }[];
  holidays: { day: string; name: string }[];
  dashboards: { name: string; folder: string | null; system_key: string | null; widgets: number }[];
  migrations: DocsSnapshotMigration[];
}

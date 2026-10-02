// 0065 · Maintenance modules: job plans, the services catalogue, technician
// time entries, work permits and the Assignment Manager. The vocabulary the
// API and the browser share, and the few rules that are pure.

import type { FeedActor } from './index';
import type { PermNode } from './permissions';

export const MAINT_PERM_KEY = 'maintenance';
export const MAINT_PERM = {
  plans: 'maintenance/job_plans',
  services: 'maintenance/services',
  time: 'maintenance/time',
  permits: 'maintenance/permits',
  assignment: 'maintenance/assignment',
} as const;

export function maintenancePermNodes(): PermNode[] {
  return [
    {
      key: MAINT_PERM_KEY,
      label: 'Maintenance',
      actions: ['view', 'create', 'edit', 'delete', 'approve'],
      note: 'Job plans, the services catalogue, technician time, work permits and the Assignment Manager. Each row below can differ; unset follows this one.',
      children: [
        { key: MAINT_PERM.plans, label: 'Job plans', actions: ['view', 'create', 'edit', 'delete'], note: 'Edit also covers applying a plan to a work order.' },
        { key: MAINT_PERM.services, label: 'Services catalogue', actions: ['view', 'create', 'edit', 'delete'], note: 'Edit also covers adding a service to a work order.' },
        { key: MAINT_PERM.time, label: 'Technician time', actions: ['view', 'create', 'edit', 'delete'], note: 'Create = log time or start a timer; edit = change or stop an entry.' },
        { key: MAINT_PERM.permits, label: 'Work permits', actions: ['view', 'create', 'edit', 'approve'], note: 'Create = write and request a permit; approve also covers reject.' },
        { key: MAINT_PERM.assignment, label: 'Assignment Manager', actions: ['view', 'edit'], note: 'View = the workload of every dispatcher; edit = assign and re-assign work orders in bulk.' },
      ],
    },
  ];
}

// ── Services ─────────────────────────────────────────────────────────────────

export const SERVICE_UNITS = ['each', 'hour', 'visit', 'sq ft', 'linear ft', 'lb', 'gallon'] as const;

export interface ServiceItem {
  id: string;
  code: string | null;
  name: string;
  trade: string | null;
  description: string | null;
  unit: string;
  unit_price: number | null;
  unit_cost: number | null;
  est_minutes: number | null;
  is_active: boolean;
  /** How many work orders carry it. */
  used: number;
}

export interface ServiceItemInput {
  code?: string | null;
  name?: string;
  trade?: string | null;
  description?: string | null;
  unit?: string;
  unit_price?: number | null;
  unit_cost?: number | null;
  est_minutes?: number | null;
  is_active?: boolean;
}

export interface ServicesResponse {
  services: ServiceItem[];
  trades: string[];
  can: { create: boolean; edit: boolean; delete: boolean };
}

// ── Job plans ────────────────────────────────────────────────────────────────

export interface JobPlan {
  id: string;
  name: string;
  trade: string | null;
  description: string | null;
  est_minutes: number | null;
  is_active: boolean;
  steps: { id: string; title: string }[];
  services: { service_id: string; name: string; unit: string; qty: number }[];
  /** How many work orders it was applied to. */
  used: number;
}

export interface JobPlanInput {
  name?: string;
  trade?: string | null;
  description?: string | null;
  est_minutes?: number | null;
  is_active?: boolean;
  steps?: string[];
  services?: { service_id: string; qty: number }[];
}

export interface JobPlansResponse {
  plans: JobPlan[];
  trades: string[];
  services: { id: string; name: string; unit: string }[];
  can: { create: boolean; edit: boolean; delete: boolean };
}

// ── On a work order ──────────────────────────────────────────────────────────

export interface WoServiceLine {
  id: string;
  service_id: string | null;
  name: string;
  unit: string;
  qty: number;
  unit_price: number | null;
  unit_cost: number | null;
  note: string | null;
  added_by: FeedActor | null;
  added_at: string;
}

export const TIME_KINDS = ['labor', 'travel', 'waiting'] as const;
export type TimeKind = (typeof TIME_KINDS)[number];
export const TIME_KIND_LABELS: Record<TimeKind, string> = { labor: 'Labor', travel: 'Travel', waiting: 'Waiting' };

export interface TimeEntry {
  id: string;
  task_id: string;
  wo_number: string;
  /** Client and store, for the rows of the tracker. */
  place: string | null;
  vendor_id: string | null;
  tech_name: string;
  kind: TimeKind;
  started_at: string;
  /** Null = the timer is still running. */
  ended_at: string | null;
  /** Whole minutes; for a running timer, up to the moment of the read. */
  minutes: number;
  billable: boolean;
  hourly_rate: number | null;
  /** minutes × rate, when there is a rate. */
  amount: number | null;
  note: string | null;
  created_by: FeedActor | null;
}

export interface TimeEntryInput {
  tech_name?: string;
  vendor_id?: string | null;
  kind?: TimeKind;
  started_at?: string;
  ended_at?: string | null;
  billable?: boolean;
  hourly_rate?: number | null;
  note?: string | null;
}

export interface TimeTrackerResponse {
  from: string;
  to: string;
  entries: TimeEntry[];
  /** One row per technician over the range. */
  technicians: { tech_name: string; minutes: number; billable_minutes: number; amount: number; entries: number; running: number; work_orders: number }[];
  totals: { minutes: number; billable_minutes: number; amount: number; running: number };
  can: { create: boolean; edit: boolean; delete: boolean };
}

/** minutes × hourly rate, to the cent. */
export function timeAmount(minutes: number, hourlyRate: number | null | undefined): number | null {
  if (hourlyRate === null || hourlyRate === undefined) return null;
  return Math.round((minutes / 60) * hourlyRate * 100) / 100;
}

// ── Work permits ─────────────────────────────────────────────────────────────

export const PERMIT_TYPES = [
  'General work',
  'Hot work',
  'Electrical',
  'Working at height',
  'Roof access',
  'Confined space',
  'Lockout / tagout',
  'Excavation',
] as const;

/** The precautions a new permit of each type starts with. They are a
 *  starting list: whoever writes the permit can add, remove and tick. */
export const PERMIT_PRECAUTIONS: Record<string, string[]> = {
  'General work': ['Work area inspected', 'Store manager informed', 'Area barricaded where customers pass'],
  'Hot work': ['Fire extinguisher within reach', 'Combustibles removed or covered', 'Fire watch for 30 minutes after the work', 'Smoke detection isolated and restored after'],
  Electrical: ['Circuit de-energised and locked out', 'Absence of voltage tested', 'Insulated tools and gloves', 'Panel labelled while open'],
  'Working at height': ['Ladder or lift inspected', 'Fall protection worn above 6 ft', 'Area below barricaded', 'Second person present'],
  'Roof access': ['Roof hatch key signed out', 'Weather checked', 'Stay 6 ft from the edge or tie off', 'Hatch closed and key returned'],
  'Confined space': ['Atmosphere tested', 'Attendant at the entry', 'Rescue plan agreed', 'Ventilation running'],
  'Lockout / tagout': ['Energy sources identified', 'Locks and tags applied', 'Stored energy released', 'Zero-energy verified'],
  Excavation: ['Utilities located (811)', 'Trench protected or sloped', 'Spoil kept back from the edge', 'Barricades in place'],
};

export const PERMIT_STATUSES = ['draft', 'requested', 'approved', 'rejected', 'closed'] as const;
export type PermitStatus = (typeof PERMIT_STATUSES)[number];
/** What a permit reads as on a given day: the stored status, except that an
 *  approved permit is `active` between its dates and `expired` after them. */
export type PermitState = PermitStatus | 'active' | 'expired';

export const PERMIT_STATE_LABELS: Record<PermitState, string> = {
  draft: 'Draft',
  requested: 'Waiting for approval',
  approved: 'Approved',
  active: 'Active',
  expired: 'Expired',
  rejected: 'Rejected',
  closed: 'Closed',
};

export function permitState(status: PermitStatus, validFrom: string | null, validTo: string | null, today: string): PermitState {
  if (status !== 'approved') return status;
  if (validTo !== null && today > validTo) return 'expired';
  if (validFrom !== null && today < validFrom) return 'approved';
  return 'active';
}

export interface PermitPrecaution {
  text: string;
  done: boolean;
}

export interface WorkPermit {
  id: string;
  permit_number: string;
  task_id: string;
  wo_number: string;
  place: string | null;
  permit_type: string;
  status: PermitStatus;
  state: PermitState;
  holder: string | null;
  valid_from: string | null;
  valid_to: string | null;
  hazards: string | null;
  precautions: PermitPrecaution[];
  requested_by: FeedActor | null;
  requested_at: string | null;
  decided_by: FeedActor | null;
  decided_at: string | null;
  decision_note: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface WorkPermitInput {
  permit_type?: string;
  holder?: string | null;
  valid_from?: string | null;
  valid_to?: string | null;
  hazards?: string | null;
  precautions?: PermitPrecaution[];
}

export type PermitAction = 'request' | 'approve' | 'reject' | 'close' | 'reopen';

/** Why a permit cannot be sent for approval yet; null when it can. */
export function permitRequestProblem(p: { permit_type: string; valid_from: string | null; valid_to: string | null; holder: string | null }): string | null {
  if (!p.permit_type.trim()) return 'Pick the kind of permit.';
  if (!p.holder || !p.holder.trim()) return 'Say who holds the permit (the technician or company doing the work).';
  if (!p.valid_from || !p.valid_to) return 'Give the first and the last day the permit covers.';
  if (p.valid_to < p.valid_from) return 'The last day is before the first.';
  return null;
}

export interface PermitsResponse {
  permits: WorkPermit[];
  counts: Record<PermitState, number>;
  can: { create: boolean; edit: boolean; approve: boolean };
}

/** Everything maintenance on one work order. */
export interface WoMaintenance {
  wo_number: string;
  /** The "Work Permit Needed" field (0063). */
  permit_needed: boolean;
  plans_applied: { plan_id: string; name: string; applied_at: string; applied_by: FeedActor | null }[];
  plans: { id: string; name: string; trade: string | null; steps: number; services: number; applied: boolean }[];
  services: WoServiceLine[];
  services_total: { price: number; cost: number };
  catalogue: { id: string; name: string; unit: string; unit_price: number | null; unit_cost: number | null; trade: string | null }[];
  time: TimeEntry[];
  time_total: { minutes: number; billable_minutes: number; amount: number };
  technicians: { vendor_id: string; name: string }[];
  permits: WorkPermit[];
  can: {
    plans: boolean;
    services: boolean;
    time_view: boolean;
    time_create: boolean;
    time_edit: boolean;
    time_delete: boolean;
    permits_view: boolean;
    permits_create: boolean;
    permits_edit: boolean;
    permits_approve: boolean;
  };
}

// ── Assignment Manager ───────────────────────────────────────────────────────

export interface AssignmentPerson {
  id: string;
  name: string;
  role_label: string | null;
  open: number;
  emergencies: number;
  overdue: number;
}

export interface AssignmentWorkOrder {
  id: string;
  wo_number: string;
  client: string | null;
  store: string | null;
  city: string | null;
  state: string | null;
  trade: string | null;
  status_name: string;
  priority: string | null;
  emergency: boolean;
  assignee: string | null;
  vendor: string | null;
  age_days: number;
}

export interface AssignmentBoard {
  people: AssignmentPerson[];
  unassigned: number;
  work_orders: AssignmentWorkOrder[];
  total: number;
  can: { edit: boolean };
}

/** The lightest-loaded people first: who should take the next job. */
export function suggestAssignees(people: AssignmentPerson[], take = 3): AssignmentPerson[] {
  return [...people].sort((a, b) => a.open - b.open || a.emergencies - b.emergencies || a.name.localeCompare(b.name)).slice(0, take);
}

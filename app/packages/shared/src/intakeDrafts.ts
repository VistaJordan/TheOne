// Section 14 — the Incoming Work Order Intake (OP Admin).
//
//   14.1.1  A staging area SEPARATE from the main work-order table.
//   14.1.2  OP Admin, Admin and Super Admin see it; nobody else does.
//   14.2.x  "New Work Order" opens the manual entry form; the 11.1.1 intake
//           fields are mandatory before it can be submitted; an Assignee
//           dropdown says where the ticket goes.
//   14.3.x  The staging list is every draft without an assignee (started or
//           saved). Submit with every field filled AND an assignee → the
//           draft leaves staging and a real work order is created in the
//           main table, in the assigned dispatcher's list.
//
// A draft is a `wo_intake_draft` row (migration 0040): a bag of the same
// keys the work order will carry, the WO# and the assignee. Not a `task`
// row — a draft is not a work order yet, so nothing that lists work orders
// (the list, the queues, the KPIs, the automations) needs to know about it.
// Submitting is the one moment a task is written (services/intake.ts).
//
// The permission path is `intake` (view / create / edit); migration 0040
// grants it to the Operations Admin and Admin roles. Discarding a draft is
// an UPDATE (`discarded_at`) — rule 8.1.1 keeps DELETE out of everyone's
// hands but the super admins', and a draft still leaves a trail.

import { INTAKE_REQUIRED_FIELDS, intakeMissing, intakeValueFilled, type IntakeField } from './intakeGate';

export const INTAKE_PERM_KEY = 'intake';

/** The bag key of the Assignee seat (the same one 0032 scopes by). */
export const INTAKE_ASSIGNEE_KEY = 'Assignee';

/** Optional bag keys the form also offers — a work order without its
    Client reads badly everywhere, but 11.1.1 does not require it. */
export const INTAKE_OPTIONAL_FIELDS: readonly IntakeField[] = [{ key: 'Client', label: 'Client' }];

/** One line of the manual entry form, in the rule's order. WO# leads
    (task.wo_number, typed by hand for a manual entry), then the 13 intake
    fields of 11.1.1, then the optional ones. */
export interface IntakeFormField extends IntakeField {
  required: boolean;
}

export const INTAKE_FORM_FIELDS: readonly IntakeFormField[] = [
  ...INTAKE_REQUIRED_FIELDS.map((f) => ({ ...f, required: true })),
  ...INTAKE_OPTIONAL_FIELDS.map((f) => ({ ...f, required: false })),
];

export interface IntakeDraft {
  id: string;
  /** The client's work-order number, typed by hand — becomes task.wo_number. */
  wo_number: string | null;
  /** The bag the work order will carry, keyed like task.fields. */
  fields: Record<string, unknown>;
  /** Display name of the dispatcher it goes to (the Assignee seat). */
  assignee: string | null;
  created_by: { id: string; display_name: string } | null;
  updated_by: { id: string; display_name: string } | null;
  created_at: string;
  updated_at: string;
  /** Set once submitted: the work order it became. */
  submitted_at: string | null;
  submitted_task_id: string | null;
  submitted_wo_number: string | null;
  discarded_at: string | null;
  /** What still blocks Submit, in the rule's order (labels). Empty = the
      fields are in; an assignee is still needed on top. */
  missing: string[];
}

/** POST /api/intake/drafts and PATCH /api/intake/drafts/:id. Every key is
    optional; a PATCH merges `fields` key by key (null clears one). */
export interface IntakeDraftInput {
  wo_number?: string | null;
  fields?: Record<string, unknown>;
  assignee?: string | null;
}

/** GET /api/intake/drafts — the staging list: open drafts, most recently
    touched first. */
export interface IntakeDraftsResponse {
  items: IntakeDraft[];
  total: number;
}

/** POST /api/intake/drafts/:id/submit — the work order the draft became. */
export interface IntakeSubmitResponse {
  draft: IntakeDraft;
  task_id: string;
  wo_number: string;
}

/** `details.code` on the 409 a refused submit returns. */
export const INTAKE_SUBMIT_ERROR_CODE = 'INTAKE_SUBMIT';

/** Labels of what a draft still lacks before it can be submitted: WO#
    first, then the 11.1.1 fields (the same check the manager's Accept runs).
    The assignee is reported separately (`intakeDraftReady`) because the
    staging list is defined by its absence (14.3.1). */
export function intakeDraftMissing(draft: Pick<IntakeDraft, 'wo_number' | 'fields'>): string[] {
  const out: string[] = [];
  if (!intakeValueFilled(draft.wo_number)) out.push('WO#');
  for (const f of intakeMissing({ fields: draft.fields })) out.push(f.label);
  return out;
}

/** True when Submit may go ahead: every field in, and an assignee named. */
export function intakeDraftReady(draft: Pick<IntakeDraft, 'wo_number' | 'fields' | 'assignee'>): boolean {
  return intakeDraftMissing(draft).length === 0 && intakeValueFilled(draft.assignee);
}

/** The sentence a refused submit reads. */
export function describeIntakeSubmit(missing: readonly string[], assigneeMissing: boolean): string {
  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(
      `fill ${missing.length === 1 ? 'this field' : `these ${missing.length} fields`}: ${missing.join(', ')}`,
    );
  }
  if (assigneeMissing) parts.push('pick an assignee');
  if (parts.length === 0) return 'The work order can be submitted.';
  return `Before this work order can be submitted (rule 14.2.2), ${parts.join(' and ')}.`;
}

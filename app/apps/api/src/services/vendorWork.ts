// 0058 · The vendor relations workflow around a vendor record: tasks and the
// review queue, documents and the COI review, the call and email log, alerts,
// data quality, bulk edit, CSV export, saved lists, daily targets, required
// fields. The record itself is vendors.ts; the CSV import is vendorImport.ts.
//
// Everything here checks two things before it writes: the grant (`vendors`
// edit, or the specific path — vendors/review, vendors/documents, …) and the
// row scope (`vendors/scope`: a rep limited to "only theirs" cannot log a
// call on, upload to, or bulk-edit a vendor they cannot see). The CRM let any
// signed-in user write a vendor's history; this does not.
//
// No email is sent from anywhere in this file. An "email" here is a note that
// one went out.

import { del, get, put } from '@vercel/blob';
import {
  VENDORS_PERM_KEY,
  VENDOR_DOCUMENTS_PERM_KEY,
  VENDOR_DOCUMENT_MAX_BYTES,
  VENDOR_DOCUMENT_TYPES_ALLOWED,
  VENDOR_EXPORT_PERM_KEY,
  VENDOR_LISTS_PERM_KEY,
  VENDOR_REQUIRABLE_FIELDS,
  VENDOR_REVIEW_PERM_KEY,
  VENDOR_REVIEW_TASK_TYPES,
  VENDOR_STATUS_ACTIVE,
  VENDOR_STATUS_INACTIVE,
  VENDOR_TASK_ACTIONS,
  COI_CHECKLIST,
  SAVED_VIEW_KEYS,
  parseVendorFilter,
  serializeVendorFilter,
  expiryBand,
  missingFields,
  permAllows,
  phoneDigits,
  rollUpCoiApproval,
} from '@theone/shared';
import type {
  CoiChecklistKey,
  CoiRequirement,
  DailyTarget,
  DataQualityResponse,
  DuplicateBy,
  DuplicateGroup,
  FeedActor,
  SavedViewVisibility,
  TriState,
  VendorAlert,
  VendorBulkPatch,
  VendorCall,
  VendorCallInput,
  VendorDocument,
  VendorDocumentType,
  VendorDocumentUpload,
  VendorEmail,
  VendorKind,
  VendorSavedView,
  VendorTask,
  VendorTaskAction,
  VendorTaskType,
  VendorTasksResponse,
  VendorWorkResponse,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { logAdminEvent } from './adminAudit.js';
import { notify } from './notices.js';
import { requirePerm } from './permissions.js';
import {
  assertVendorInScope,
  deleteVendor,
  listBrandSources,
  listStatuses,
  recomputeCompliance,
  requireVendorsView,
  updateVendor,
  vendorListWhere,
  vendorSortSql,
  type VendorListQuery,
} from './vendors.js';
import {
  autoCloseTasks,
  openVendorTask,
  recomputeMissing,
  requiredKeys,
  requiredOverrides,
  vendorProblems,
} from './vendorTasks.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);
const today = (): string => new Date().toISOString().slice(0, 10);
const clean = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s === '' ? null : s;
};
const actor3 = (id: string | null, name: string | null, kind: 'human' | 'service' | null): FeedActor | null =>
  id ? { id, name: name ?? 'Unknown', kind: kind ?? 'human' } : null;

const can = (a: ActingPrincipal, key: string, action: 'view' | 'create' | 'edit' | 'delete' | 'approve'): boolean =>
  permAllows(a.perms, key, action, a.isSuperAdmin);

async function vendorName(id: string): Promise<string> {
  if (!UUID_RE.test(id)) throw notFound('Vendor not found');
  const res = await query<{ name: string }>(`SELECT name FROM vendor WHERE id = $1 AND deleted_at IS NULL`, [id]);
  if (!res.rows[0]) throw notFound('Vendor not found');
  return res.rows[0].name;
}

/** May edit THIS vendor: the grant and the row scope. Returns its name. */
async function requireVendorEdit(a: ActingPrincipal, vendorId: string): Promise<string> {
  requirePerm(a, VENDORS_PERM_KEY, 'edit', 'You cannot edit vendors');
  const name = await vendorName(vendorId);
  await assertVendorInScope(a, vendorId);
  return name;
}

async function log(actorId: string, vendorId: string, action: string, after: Record<string, unknown> & { name: string }, before?: Record<string, unknown> & { name: string }): Promise<void> {
  await logAdminEvent({ actorId, entity: 'vendor', entityId: vendorId, action, after, before: before ?? null });
}

// ═══ Tasks ═══════════════════════════════════════════════════════════════════

type TaskRow = {
  id: string;
  type: VendorTaskType;
  title: string;
  vendor_id: string | null;
  vendor_name: string | null;
  entity: string | null;
  a_id: string | null; a_name: string | null; a_kind: 'human' | 'service' | null;
  status: 'OPEN' | 'DONE';
  outcome: string | null;
  note: string | null;
  c_id: string | null; c_name: string | null; c_kind: 'human' | 'service' | null;
  created_at: Date;
  d_id: string | null; d_name: string | null; d_kind: 'human' | 'service' | null;
  completed_at: Date | null;
};

const TASK_SELECT = `
  SELECT t.id::text AS id, t.type, t.title, v.id::text AS vendor_id, v.name AS vendor_name, t.entity,
         a.id::text AS a_id, a.display_name AS a_name, a.kind AS a_kind,
         t.status, t.outcome, t.note,
         c.id::text AS c_id, c.display_name AS c_name, c.kind AS c_kind, t.created_at,
         d.id::text AS d_id, d.display_name AS d_name, d.kind AS d_kind, t.completed_at
    FROM vendor_task t
    LEFT JOIN vendor v ON v.id = t.vendor_id
    LEFT JOIN principal a ON a.id = t.assigned_to
    LEFT JOIN principal c ON c.id = t.created_by
    LEFT JOIN principal d ON d.id = t.completed_by`;

function mapTask(r: TaskRow): VendorTask {
  return {
    id: r.id,
    type: r.type,
    title: r.title,
    vendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor_name ?? '' } : null,
    entity: r.entity,
    assigned_to: actor3(r.a_id, r.a_name, r.a_kind),
    status: r.status,
    outcome: r.outcome,
    note: r.note,
    created_by: actor3(r.c_id, r.c_name, r.c_kind),
    created_at: iso(r.created_at)!,
    completed_by: actor3(r.d_id, r.d_name, r.d_kind),
    completed_at: iso(r.completed_at),
  };
}

/** The viewer's tasks: the ones given to them, plus — for a reviewer — the
    whole review queue. Open ones, and what was closed in the last 30 days. */
export async function listTasks(actor: ActingPrincipal): Promise<VendorTasksResponse> {
  requireVendorsView(actor);
  const reviewer = can(actor, VENDOR_REVIEW_PERM_KEY, 'approve');
  const res = await query<TaskRow>(
    `${TASK_SELECT}
      WHERE (t.assigned_to = $1 OR ($2::boolean AND t.assigned_to IS NULL))
        AND (t.status = 'OPEN' OR t.completed_at >= now() - interval '30 days')
      ORDER BY (t.status = 'DONE'), t.created_at DESC
      LIMIT 500`,
    [actor.id, reviewer],
  );
  const tasks = res.rows.map(mapTask);

  // COI reviews carry their certificates, so a reviewer can decide in place.
  const coi = tasks.filter((t) => t.type === 'COMPLIANCE_REVIEW' && t.status === 'OPEN' && t.vendor);
  if (coi.length > 0) {
    const docs = await loadDocuments(coi.map((t) => t.vendor!.id), 'COI');
    for (const t of coi) {
      t.documents = (docs.get(t.vendor!.id) ?? []).filter((d) => !t.entity || !d.entity || d.entity === t.entity).slice(0, 6);
    }
  }

  const day = today();
  const [mine, all, people] = await Promise.all([
    loadTargets(day, actor.id),
    reviewer ? loadTargets(day, null) : Promise.resolve([] as DailyTarget[]),
    reviewer
      ? query<{ id: string; name: string; kind: 'human' | 'service' }>(
          `SELECT id::text AS id, display_name AS name, kind FROM principal
            WHERE kind = 'human' AND status <> 'disabled' ORDER BY lower(display_name)`,
        ).then((r) => r.rows)
      : Promise.resolve([] as FeedActor[]),
  ]);
  return { tasks, can_review: reviewer, my_target: mine[0] ?? null, targets: all, people };
}

async function loadTask(id: string): Promise<VendorTask> {
  if (!UUID_RE.test(id)) throw notFound('Task not found');
  const res = await query<TaskRow>(`${TASK_SELECT} WHERE t.id = $1`, [id]);
  if (!res.rows[0]) throw notFound('Task not found');
  return mapTask(res.rows[0]);
}

async function closeTask(id: string, outcome: string, note: string | null, actorId: string): Promise<void> {
  await query(
    `UPDATE vendor_task SET status = 'DONE', outcome = $2, note = COALESCE($3, note), completed_by = $4, completed_at = now()
      WHERE id = $1 AND status = 'OPEN'`,
    [id, outcome, note, actorId],
  );
}

export async function createManualTask(
  input: { title: string; vendor_id?: string | null; assigned_to?: string | null },
  actor: ActingPrincipal,
): Promise<VendorTask> {
  requireVendorsView(actor);
  const title = input.title.trim();
  if (title === '') throw badRequest('The task needs a title', { field: 'title' });
  const assignee = input.assigned_to ?? actor.id;
  // Giving a task to someone else is a reviewer's act; anyone may note one for themselves.
  if (assignee !== actor.id) requirePerm(actor, VENDOR_REVIEW_PERM_KEY, 'approve', 'You cannot give tasks to other people');
  if (input.vendor_id) {
    await vendorName(input.vendor_id);
    await assertVendorInScope(actor, input.vendor_id);
  }
  const id = await openVendorTask({ type: 'MANUAL', title, vendorId: input.vendor_id ?? null, assignedTo: assignee, createdBy: actor.id });
  return loadTask(id);
}

/**
 * Decide a task. What each action does:
 *   keep         duplicate review: both records stay; the flag is cleared
 *   remove       duplicate review: the flagged record is removed
 *   acknowledge  missing information: seen, left as it is (the flag stays)
 *   approve      COI review: that company's certificate is approved
 *   send_back    COI review: a note is required; the owner gets a fix task
 *   fixed        COI fix: done — a fresh review is raised
 *   done         manual
 */
export async function resolveTask(id: string, action: VendorTaskAction, note: string | null, actor: ActingPrincipal): Promise<VendorTask> {
  requireVendorsView(actor);
  const task = await loadTask(id);
  if (task.status !== 'OPEN') throw conflict('That task is already closed');
  if (!VENDOR_TASK_ACTIONS[task.type].includes(action)) throw badRequest(`"${action}" does not apply to this task`);
  const review = (VENDOR_REVIEW_TASK_TYPES as readonly string[]).includes(task.type);
  if (review) requirePerm(actor, VENDOR_REVIEW_PERM_KEY, 'approve', 'Deciding a review is a manager’s job');
  else if (task.assigned_to?.id !== actor.id && !can(actor, VENDOR_REVIEW_PERM_KEY, 'approve')) {
    throw forbidden('That task belongs to someone else');
  }
  const text = clean(note);
  const vendorId = task.vendor?.id ?? null;
  const name = task.vendor?.name ?? task.title;

  switch (action) {
    case 'keep':
      await query(`UPDATE vendor SET flagged_duplicate = false, duplicate_of = NULL WHERE id = $1`, [vendorId]);
      await closeTask(id, 'kept', text, actor.id);
      if (vendorId) await log(actor.id, vendorId, 'vendor_duplicate_kept', { name });
      break;
    case 'remove':
      if (!vendorId) throw badRequest('This task has no vendor to remove');
      requirePerm(actor, VENDORS_PERM_KEY, 'delete', 'You cannot remove vendors');
      await closeTask(id, 'removed', text, actor.id);
      await deleteVendor(vendorId, actor);
      break;
    case 'acknowledge':
      await closeTask(id, 'acknowledged', text, actor.id);
      break;
    case 'approve':
    case 'send_back': {
      if (!vendorId || !task.entity) throw badRequest('This review names no certificate');
      if (action === 'send_back' && !text) throw badRequest('Say what needs fixing', { field: 'note' });
      const verdict: TriState = action === 'approve' ? 'YES' : 'NO';
      await query(
        `INSERT INTO vendor_coi_requirement (vendor_id, entity, approved, review_note, reviewed_by, reviewed_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (vendor_id, entity)
         DO UPDATE SET approved = EXCLUDED.approved, review_note = EXCLUDED.review_note,
                       reviewed_by = EXCLUDED.reviewed_by, reviewed_at = now()`,
        [vendorId, task.entity, verdict, action === 'approve' ? null : text, actor.id],
      );
      await closeTask(id, action === 'approve' ? 'approved' : 'sent_back', text, actor.id);
      await syncCoiApproval(vendorId);
      if (action === 'send_back') {
        const owner = await query<{ owner_id: string | null }>(`SELECT owner_id::text AS owner_id FROM vendor WHERE id = $1`, [vendorId]);
        await openVendorTask({
          type: 'COMPLIANCE_FIX',
          title: `Fix needed for the ${task.entity === '-' ? '' : `${await entityLabel(task.entity)} `}COI: ${name} — ${text}`,
          vendorId,
          entity: task.entity,
          assignedTo: owner.rows[0]?.owner_id ?? actor.id,
          createdBy: actor.id,
        });
      }
      await log(actor.id, vendorId, action === 'approve' ? 'vendor_coi_approved' : 'vendor_coi_sent_back', { name, entity: task.entity, note: text });
      break;
    }
    case 'fixed':
      await closeTask(id, 'fixed', text, actor.id);
      if (vendorId && task.entity) {
        await query(`UPDATE vendor_coi_requirement SET approved = 'PENDING' WHERE vendor_id = $1 AND entity = $2`, [vendorId, task.entity]);
        await syncCoiApproval(vendorId);
        await openVendorTask({
          type: 'COMPLIANCE_REVIEW',
          title: `Review COI${task.entity === '-' ? '' : ` for ${await entityLabel(task.entity)}`}: ${name}`,
          vendorId,
          entity: task.entity,
          createdBy: actor.id,
        });
      }
      break;
    case 'done':
      await closeTask(id, 'done', text, actor.id);
      break;
  }
  // 0059 · whoever raised it (and, for an approved COI, the vendor's owner)
  // hears what was decided. A sent-back COI reaches the owner as a fix task.
  const said: Record<VendorTaskAction, string> = {
    keep: 'kept both records',
    remove: 'removed the duplicate',
    acknowledge: 'acknowledged the missing information',
    approve: 'approved the COI',
    send_back: 'sent the COI back',
    fixed: 'marked the COI fixed',
    done: 'closed the task',
  };
  const tell: (string | null | undefined)[] = [task.created_by?.id, task.assigned_to?.id];
  if (action === 'approve' && vendorId) {
    const owner = await query<{ owner_id: string | null }>(`SELECT owner_id::text AS owner_id FROM vendor WHERE id = $1`, [vendorId]);
    tell.push(owner.rows[0]?.owner_id);
  }
  await notify(tell, {
    kind: 'vendor_task_decided',
    title: `${actor.name} ${said[action]}: ${name}`,
    body: text,
    link: action === 'remove' || !vendorId ? '/vendors?view=tasks' : `/vendors/${vendorId}`,
    actorId: actor.id,
  });
  return loadTask(id);
}

async function entityLabel(key: string): Promise<string> {
  const list = await listBrandSources();
  return list.find((b) => b.key === key)?.label ?? key;
}

// ═══ Daily targets ═══════════════════════════════════════════════════════════

async function loadTargets(day: string, principalId: string | null): Promise<DailyTarget[]> {
  const res = await query<{ id: string; name: string; kind: 'human' | 'service'; nationwide_target: number; statewide_target: number; nw: number; sw: number }>(
    `SELECT p.id::text AS id, p.display_name AS name, p.kind, t.nationwide_target, t.statewide_target,
            (SELECT count(*)::int FROM vendor v
              WHERE v.owner_id = p.id AND v.deleted_at IS NULL AND v.nationwide AND v.created_at::date = t.day) AS nw,
            (SELECT count(*)::int FROM vendor v
              WHERE v.owner_id = p.id AND v.deleted_at IS NULL AND v.statewide AND v.created_at::date = t.day) AS sw
       FROM vendor_daily_target t JOIN principal p ON p.id = t.principal_id
      WHERE t.day = $1::date AND ($2::uuid IS NULL OR t.principal_id = $2)
      ORDER BY lower(p.display_name)`,
    [day, principalId],
  );
  return res.rows.map((r) => ({
    principal: { id: r.id, name: r.name, kind: r.kind },
    day,
    nationwide_target: r.nationwide_target,
    statewide_target: r.statewide_target,
    nationwide_added: r.nw,
    statewide_added: r.sw,
  }));
}

export async function setDailyTarget(
  input: { principal_id: string; day?: string; nationwide_target: number; statewide_target: number },
  actor: ActingPrincipal,
): Promise<DailyTarget[]> {
  requirePerm(actor, VENDOR_REVIEW_PERM_KEY, 'approve', 'You cannot set daily targets');
  const day = input.day && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : today();
  const nw = Math.max(0, Math.round(input.nationwide_target));
  const sw = Math.max(0, Math.round(input.statewide_target));
  if (nw === 0 && sw === 0) {
    await query(`DELETE FROM vendor_daily_target WHERE principal_id = $1 AND day = $2::date`, [input.principal_id, day]);
  } else {
    await query(
      `INSERT INTO vendor_daily_target (principal_id, day, nationwide_target, statewide_target, set_by)
       VALUES ($1, $2::date, $3, $4, $5)
       ON CONFLICT (principal_id, day)
       DO UPDATE SET nationwide_target = EXCLUDED.nationwide_target, statewide_target = EXCLUDED.statewide_target,
                     set_by = EXCLUDED.set_by, updated_at = now()`,
      [input.principal_id, day, nw, sw, actor.id],
    );
  }
  return loadTargets(day, null);
}

// ═══ Documents and the COI review ════════════════════════════════════════════

function blobToken(): string | undefined {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  return t && t.trim() !== '' ? t : undefined;
}
export const documentStorageReady = (): boolean => blobToken() !== undefined;

function requireStorage(): string {
  const t = blobToken();
  if (!t) throw new ApiError('CONFLICT', 'File storage is not connected to this environment yet, so uploads are off', { code: 'STORAGE_MISSING' });
  return t;
}

type DocRow = {
  id: string; vendor_id: string; type: VendorDocumentType; entity: string | null; file_name: string;
  storage_key: string; content_type: string | null; byte_size: string | number | null;
  u_id: string | null; u_name: string | null; u_kind: 'human' | 'service' | null; created_at: Date;
};

const DOC_SELECT = `
  SELECT d.id::text AS id, d.vendor_id::text AS vendor_id, d.type, d.entity, d.file_name, d.storage_key,
         d.content_type, d.byte_size, p.id::text AS u_id, p.display_name AS u_name, p.kind AS u_kind, d.created_at
    FROM vendor_document d LEFT JOIN principal p ON p.id = d.uploaded_by`;

const mapDoc = (r: DocRow): VendorDocument => ({
  id: r.id,
  type: r.type,
  entity: r.entity,
  file_name: r.file_name,
  content_type: r.content_type,
  byte_size: r.byte_size === null ? null : Number(r.byte_size),
  uploaded_by: actor3(r.u_id, r.u_name, r.u_kind),
  created_at: iso(r.created_at)!,
});

async function loadDocuments(vendorIds: string[], type?: VendorDocumentType): Promise<Map<string, VendorDocument[]>> {
  const out = new Map<string, VendorDocument[]>();
  if (vendorIds.length === 0) return out;
  const res = await query<DocRow>(
    `${DOC_SELECT} WHERE d.vendor_id = ANY($1::uuid[]) AND ($2::text IS NULL OR d.type = $2) ORDER BY d.created_at DESC`,
    [vendorIds, type ?? null],
  );
  for (const r of res.rows) {
    const list = out.get(r.vendor_id) ?? [];
    list.push(mapDoc(r));
    out.set(r.vendor_id, list);
  }
  return out;
}

const safeName = (raw: string): string => {
  const base = raw.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'file';
};

/** The vendor's coi_approved is the roll-up of its per-company reviews; then
    compliance (and Active) follow from it. */
async function syncCoiApproval(vendorId: string): Promise<void> {
  const reqs = await query<{ approved: TriState }>(
    `SELECT r.approved FROM vendor_coi_requirement r
      WHERE r.vendor_id = $1
        AND EXISTS (SELECT 1 FROM vendor_document d WHERE d.vendor_id = r.vendor_id AND d.type = 'COI' AND COALESCE(d.entity, '-') = r.entity)`,
    [vendorId],
  );
  await query(`UPDATE vendor SET coi_approved = $2 WHERE id = $1`, [vendorId, rollUpCoiApproval(reqs.rows)]);
  await recomputeCompliance(vendorId);
}

export async function uploadDocument(vendorId: string, input: VendorDocumentUpload, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  requirePerm(actor, VENDOR_DOCUMENTS_PERM_KEY, 'create', 'You cannot upload vendor documents');
  const name = await requireVendorEdit(actor, vendorId);
  const token = requireStorage();

  const contentType = (input.content_type ?? '').toLowerCase().split(';')[0].trim();
  if (!VENDOR_DOCUMENT_TYPES_ALLOWED.includes(contentType)) {
    throw badRequest(`Files of type "${contentType || 'unknown'}" cannot be uploaded here — use a PDF, an image or a Word document`);
  }
  const bytes = Buffer.from(input.data ?? '', 'base64');
  if (bytes.length === 0) throw badRequest('That file is empty');
  if (bytes.length > VENDOR_DOCUMENT_MAX_BYTES) {
    throw badRequest(`That file is larger than ${Math.round(VENDOR_DOCUMENT_MAX_BYTES / (1024 * 1024))}MB`);
  }
  const brands = await listBrandSources();
  // A certificate names one company; '-' is "not said" (a vendor with no brand source yet).
  const entity = input.type === 'COI' ? (clean(input.entity) ?? '-') : null;
  if (entity && entity !== '-' && !brands.some((b) => b.key === entity && b.key !== 'BOTH')) {
    throw badRequest('Pick which company the certificate names', { field: 'entity' });
  }

  const fileName = safeName(input.file_name ?? 'file');
  const pathname = `vendors/${vendorId}/${input.type.toLowerCase()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${fileName}`;
  const blob = await put(pathname, bytes, { access: 'private', token, contentType, addRandomSuffix: false });

  await query(
    `INSERT INTO vendor_document (vendor_id, type, entity, file_name, storage_key, content_type, byte_size, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [vendorId, input.type, entity, fileName, blob.pathname, contentType, bytes.length, actor.id],
  );
  if (input.type === 'W9') await query(`UPDATE vendor SET w9_received = 'YES' WHERE id = $1`, [vendorId]);
  if (input.type === 'MSA') await query(`UPDATE vendor SET msa_signed = 'YES' WHERE id = $1`, [vendorId]);
  if (input.type === 'COI' && entity) {
    await query(`UPDATE vendor SET coi_received = 'YES' WHERE id = $1`, [vendorId]);
    // A new certificate reopens the question for that company.
    await query(
      `INSERT INTO vendor_coi_requirement (vendor_id, entity) VALUES ($1, $2)
       ON CONFLICT (vendor_id, entity) DO UPDATE SET approved = 'PENDING', review_note = NULL`,
      [vendorId, entity],
    );
    await autoCloseTasks(vendorId, 'COMPLIANCE_FIX', entity);
    await openVendorTask({
      type: 'COMPLIANCE_REVIEW',
      title: `Review COI${entity === '-' ? '' : ` for ${brands.find((b) => b.key === entity)?.label ?? entity}`}: ${name}`,
      vendorId,
      entity,
      createdBy: actor.id,
    });
    await syncCoiApproval(vendorId);
  } else {
    await recomputeCompliance(vendorId);
  }
  await log(actor.id, vendorId, 'vendor_document_added', { name, type: input.type, entity, file_name: fileName });
  return vendorWork(vendorId, actor);
}

export async function readDocument(vendorId: string, docId: string, actor: ActingPrincipal): Promise<{ stream: ReadableStream; contentType: string; fileName: string }> {
  requireVendorsView(actor);
  await vendorName(vendorId);
  await assertVendorInScope(actor, vendorId);
  if (!UUID_RE.test(docId)) throw notFound('No such document');
  const res = await query<DocRow>(`${DOC_SELECT} WHERE d.id = $1 AND d.vendor_id = $2`, [docId, vendorId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such document');
  const blob = await get(row.storage_key, { access: 'private', token: requireStorage() });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw notFound('That file is no longer in storage');
  return { stream: blob.stream, contentType: row.content_type ?? 'application/octet-stream', fileName: row.file_name };
}

export async function renameDocument(vendorId: string, docId: string, fileName: string, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  const next = safeName(fileName);
  const res = await query<{ file_name: string }>(
    `UPDATE vendor_document d SET file_name = $3 FROM (SELECT file_name FROM vendor_document WHERE id = $1) old
      WHERE d.id = $1 AND d.vendor_id = $2 RETURNING old.file_name`,
    [docId, vendorId, next],
  );
  if (!res.rows[0]) throw notFound('No such document');
  await log(actor.id, vendorId, 'vendor_document_renamed', { name, file_name: next }, { name, file_name: res.rows[0].file_name });
  return vendorWork(vendorId, actor);
}

export async function removeDocument(vendorId: string, docId: string, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  requirePerm(actor, VENDOR_DOCUMENTS_PERM_KEY, 'delete', 'You cannot remove vendor documents');
  const name = await requireVendorEdit(actor, vendorId);
  if (!UUID_RE.test(docId)) throw notFound('No such document');
  const res = await query<DocRow>(`${DOC_SELECT} WHERE d.id = $1 AND d.vendor_id = $2`, [docId, vendorId]);
  const row = res.rows[0];
  if (!row) throw notFound('No such document');
  const token = blobToken();
  if (token) {
    try {
      await del(row.storage_key, { token });
    } catch {
      /* already gone, or storage unreachable — the row still goes */
    }
  }
  await query(`DELETE FROM vendor_document WHERE id = $1`, [docId]);
  if (row.type === 'COI') await syncCoiApproval(vendorId);
  await log(actor.id, vendorId, 'vendor_document_removed', { name }, { name, type: row.type, entity: row.entity, file_name: row.file_name });
  return vendorWork(vendorId, actor);
}

export async function saveCoiChecklist(
  vendorId: string,
  entity: string,
  checks: Partial<Record<CoiChecklistKey, boolean>>,
  actor: ActingPrincipal,
): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  const keys = COI_CHECKLIST.map((c) => c.key);
  const vals = keys.map((k) => Boolean(checks[k]));
  await query(
    `INSERT INTO vendor_coi_requirement (vendor_id, entity, ${keys.join(', ')})
     VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')})
     ON CONFLICT (vendor_id, entity) DO UPDATE SET ${keys.map((k) => `${k} = EXCLUDED.${k}`).join(', ')}`,
    [vendorId, entity, ...vals],
  );
  await log(actor.id, vendorId, 'vendor_coi_checklist_updated', { name, entity, ...Object.fromEntries(keys.map((k, i) => [k, vals[i]])) });
  return vendorWork(vendorId, actor);
}

// ═══ The log: calls and emails ═══════════════════════════════════════════════

export async function logCall(vendorId: string, input: VendorCallInput, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  const status = clean(input.resulting_status);
  if (status) {
    const known = await listStatuses();
    if (!known.some((s) => s.key === status)) throw badRequest('That is not a vendor status', { field: 'resulting_status' });
  }
  const when = input.occurred_at ? new Date(input.occurred_at) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('That is not a date', { field: 'occurred_at' });
  await query(
    `INSERT INTO vendor_call (vendor_id, logged_by, occurred_at, notes, call_link, transcript, summary, resulting_status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [vendorId, actor.id, when.toISOString(), clean(input.notes), clean(input.call_link), clean(input.transcript), clean(input.summary), status],
  );
  await query(`UPDATE vendor SET details = details || jsonb_build_object('lastContactDate', $2::text) WHERE id = $1`, [vendorId, when.toISOString().slice(0, 10)]);
  await log(actor.id, vendorId, 'vendor_call_logged', { name, resulting_status: status, notes: clean(input.notes) });
  // The call's outcome is the vendor's status from now on.
  if (status) await updateVendor(vendorId, { status }, actor);
  return vendorWork(vendorId, actor);
}

export async function editCall(vendorId: string, callId: string, input: VendorCallInput, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  if (!UUID_RE.test(callId)) throw notFound('No such call');
  const res = await query(
    `UPDATE vendor_call
        SET notes = $3, call_link = $4, transcript = $5, summary = $6, edited_by = $7, edited_at = now()
      WHERE id = $1 AND vendor_id = $2`,
    [callId, vendorId, clean(input.notes), clean(input.call_link), clean(input.transcript), clean(input.summary), actor.id],
  );
  if ((res.rowCount ?? 0) === 0) throw notFound('No such call');
  await log(actor.id, vendorId, 'vendor_call_edited', { name });
  return vendorWork(vendorId, actor);
}

export async function removeCall(vendorId: string, callId: string, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  if (!UUID_RE.test(callId)) throw notFound('No such call');
  const res = await query(`DELETE FROM vendor_call WHERE id = $1 AND vendor_id = $2`, [callId, vendorId]);
  if ((res.rowCount ?? 0) === 0) throw notFound('No such call');
  await log(actor.id, vendorId, 'vendor_call_deleted', { name });
  return vendorWork(vendorId, actor);
}

export async function logEmail(vendorId: string, input: { sent_at?: string | null; subject?: string | null; notes?: string | null }, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  const name = await requireVendorEdit(actor, vendorId);
  const when = input.sent_at ? new Date(input.sent_at) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('That is not a date', { field: 'sent_at' });
  if (!clean(input.subject) && !clean(input.notes)) throw badRequest('Say what the email was about');
  await query(`INSERT INTO vendor_email (vendor_id, logged_by, sent_at, subject, notes) VALUES ($1, $2, $3, $4, $5)`, [
    vendorId,
    actor.id,
    when.toISOString(),
    clean(input.subject),
    clean(input.notes),
  ]);
  await log(actor.id, vendorId, 'vendor_email_logged', { name, subject: clean(input.subject) });
  return vendorWork(vendorId, actor);
}

// ═══ Everything 0058 hangs on one record ═════════════════════════════════════

export async function vendorWork(vendorId: string, actor: ActingPrincipal): Promise<VendorWorkResponse> {
  requireVendorsView(actor);
  await vendorName(vendorId);
  await assertVendorInScope(actor, vendorId);
  const [docs, coi, calls, emails, tasks, problems] = await Promise.all([
    loadDocuments([vendorId]),
    query<Record<CoiChecklistKey, boolean> & { entity: string; approved: TriState; review_note: string | null; r_id: string | null; r_name: string | null; r_kind: 'human' | 'service' | null; reviewed_at: Date | null }>(
      `SELECT r.entity, r.cert_holder_confirmed, r.additional_insured_confirmed, r.gl_limit_meets_requirement,
              r.workers_comp, r.commercial_auto, r.waiver_of_subrogation, r.approved, r.review_note,
              p.id::text AS r_id, p.display_name AS r_name, p.kind AS r_kind, r.reviewed_at
         FROM vendor_coi_requirement r LEFT JOIN principal p ON p.id = r.reviewed_by
        WHERE r.vendor_id = $1 ORDER BY r.entity`,
      [vendorId],
    ),
    query<{ id: string; occurred_at: Date; notes: string | null; call_link: string | null; transcript: string | null; summary: string | null; resulting_status: string | null; l_id: string | null; l_name: string | null; l_kind: 'human' | 'service' | null; edited_at: Date | null }>(
      `SELECT c.id::text AS id, c.occurred_at, c.notes, c.call_link, c.transcript, c.summary, c.resulting_status,
              p.id::text AS l_id, p.display_name AS l_name, p.kind AS l_kind, c.edited_at
         FROM vendor_call c LEFT JOIN principal p ON p.id = c.logged_by
        WHERE c.vendor_id = $1 ORDER BY c.occurred_at DESC LIMIT 200`,
      [vendorId],
    ),
    query<{ id: string; sent_at: Date; subject: string | null; notes: string | null; l_id: string | null; l_name: string | null; l_kind: 'human' | 'service' | null }>(
      `SELECT e.id::text AS id, e.sent_at, e.subject, e.notes, p.id::text AS l_id, p.display_name AS l_name, p.kind AS l_kind
         FROM vendor_email e LEFT JOIN principal p ON p.id = e.logged_by
        WHERE e.vendor_id = $1 ORDER BY e.sent_at DESC LIMIT 200`,
      [vendorId],
    ),
    query<TaskRow>(`${TASK_SELECT} WHERE t.vendor_id = $1 ORDER BY (t.status = 'DONE'), t.created_at DESC LIMIT 100`, [vendorId]),
    vendorProblems(vendorId),
  ]);
  const coiRows: CoiRequirement[] = coi.rows.map((r) => ({
    entity: r.entity,
    cert_holder_confirmed: r.cert_holder_confirmed,
    additional_insured_confirmed: r.additional_insured_confirmed,
    gl_limit_meets_requirement: r.gl_limit_meets_requirement,
    workers_comp: r.workers_comp,
    commercial_auto: r.commercial_auto,
    waiver_of_subrogation: r.waiver_of_subrogation,
    approved: r.approved,
    review_note: r.review_note,
    reviewed_by: actor3(r.r_id, r.r_name, r.r_kind),
    reviewed_at: iso(r.reviewed_at),
  }));
  const callRows: VendorCall[] = calls.rows.map((c) => ({
    id: c.id,
    occurred_at: iso(c.occurred_at)!,
    notes: c.notes,
    call_link: c.call_link,
    transcript: c.transcript,
    summary: c.summary,
    resulting_status: c.resulting_status,
    logged_by: actor3(c.l_id, c.l_name, c.l_kind),
    edited_at: iso(c.edited_at),
  }));
  const emailRows: VendorEmail[] = emails.rows.map((e) => ({
    id: e.id,
    sent_at: iso(e.sent_at)!,
    subject: e.subject,
    notes: e.notes,
    logged_by: actor3(e.l_id, e.l_name, e.l_kind),
  }));
  return {
    documents: docs.get(vendorId) ?? [],
    coi: coiRows,
    calls: callRows,
    emails: emailRows,
    tasks: tasks.rows.map(mapTask),
    problems,
    storage_ready: documentStorageReady(),
    can: {
      upload: can(actor, VENDOR_DOCUMENTS_PERM_KEY, 'create') && can(actor, VENDORS_PERM_KEY, 'edit'),
      delete_document: can(actor, VENDOR_DOCUMENTS_PERM_KEY, 'delete') && can(actor, VENDORS_PERM_KEY, 'edit'),
      review: can(actor, VENDOR_REVIEW_PERM_KEY, 'approve'),
      edit: can(actor, VENDORS_PERM_KEY, 'edit'),
    },
  };
}

// ═══ Alerts ══════════════════════════════════════════════════════════════════

/**
 * Bring vendors in step with their insurance dates: an Active vendor whose
 * current date has passed goes Inactive (compliance EXPIRED); one that was
 * renewed comes back. Run before the Alerts and Tasks screens read, the way
 * the CRM's sweep ran — there is no clock job behind it.
 */
export async function sweepExpiries(): Promise<void> {
  const res = await query<{ id: string; status: string; compliance_status: string; expired: boolean }>(
    `WITH cur AS (
       SELECT DISTINCT ON (e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)))
              e.vendor_id, e.expires_on
         FROM vendor_expiry e
        ORDER BY e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)), e.expires_on DESC
     ), agg AS (
       SELECT vendor_id, bool_or(expires_on < CURRENT_DATE) AS expired FROM cur GROUP BY vendor_id
     )
     SELECT v.id::text AS id, v.status, v.compliance_status, a.expired
       FROM vendor v JOIN agg a ON a.vendor_id = v.id
      WHERE v.deleted_at IS NULL
        AND ((a.expired AND v.compliance_status <> 'EXPIRED') OR (NOT a.expired AND v.compliance_status = 'EXPIRED'))
      LIMIT 500`,
  );
  for (const r of res.rows) {
    await recomputeCompliance(r.id);
    if (r.expired && r.status === VENDOR_STATUS_ACTIVE) {
      await query(`UPDATE vendor SET status = $2 WHERE id = $1`, [r.id, VENDOR_STATUS_INACTIVE]);
    }
    if (!r.expired && r.status === VENDOR_STATUS_INACTIVE) {
      // Back in date: Active again, when the paperwork reads approved.
      await query(`UPDATE vendor SET status = $2 WHERE id = $1 AND compliance_status = 'APPROVED'`, [r.id, VENDOR_STATUS_ACTIVE]);
    }
  }
}

export async function listAlerts(actor: ActingPrincipal): Promise<VendorAlert[]> {
  requireVendorsView(actor);
  await sweepExpiries();
  const scope = vendorListWhere({}, actor);
  const res = await query<{ id: string; v_id: string; v_name: string; v_status: string; owner: string | null; entity: string | null; insurance_type: string; expires_on: string }>(
    `SELECT DISTINCT ON (e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)))
            e.id::text AS id, v.id::text AS v_id, v.name AS v_name, v.status AS v_status, o.display_name AS owner,
            e.entity, e.insurance_type, to_char(e.expires_on, 'YYYY-MM-DD') AS expires_on
       FROM vendor_expiry e
       JOIN vendor v ON v.id = e.vendor_id
       LEFT JOIN principal o ON o.id = v.owner_id
      WHERE ${scope.where}
      ORDER BY e.vendor_id, COALESCE(e.entity, ''), lower(btrim(e.insurance_type)), e.expires_on DESC`,
    scope.params,
  );
  const day = today();
  return res.rows
    .map((r) => ({
      id: r.id,
      vendor: { id: r.v_id, name: r.v_name, status: r.v_status, owner: r.owner },
      entity: r.entity,
      insurance_type: r.insurance_type,
      expires_on: r.expires_on,
      band: expiryBand(r.expires_on, day),
    }))
    .sort((a, b) => a.expires_on.localeCompare(b.expires_on));
}

// ═══ Data quality ════════════════════════════════════════════════════════════

export async function dataQuality(by: DuplicateBy, actor: ActingPrincipal): Promise<DataQualityResponse> {
  requireVendorsView(actor);
  const scope = vendorListWhere({}, actor);

  // Duplicates: groups sharing a phone, a name or an email. A person limited
  // to "only theirs" sees the groups that include one of their vendors.
  const keyExpr =
    by === 'phone'
      ? `ph.digits`
      : by === 'name'
        ? `lower(regexp_replace(btrim(x.name), '\\s+', ' ', 'g'))`
        : `lower(btrim(x.email))`;
  const from =
    by === 'phone'
      ? `vendor x JOIN vendor_phone ph ON ph.vendor_id = x.id`
      : `vendor x`;
  const keyFilter = by === 'phone' ? `length(ph.digits) >= 10` : by === 'email' ? `x.email IS NOT NULL AND btrim(x.email) <> ''` : `btrim(x.name) <> ''`;
  const dup = await query<{ key: string; id: string; name: string; kind: VendorKind; phone: string | null; email: string | null; city: string | null; state: string | null; owner: string | null; created_at: Date; mine: boolean }>(
    `WITH keyed AS (
       SELECT DISTINCT ${keyExpr} AS key, x.id
         FROM ${from}
        WHERE x.deleted_at IS NULL AND ${keyFilter}
     ), grp AS (
       SELECT key FROM keyed GROUP BY key HAVING count(*) > 1
     )
     SELECT k.key, v.id::text AS id, v.name, v.kind, v.phone, v.email, v.city, v.state, o.display_name AS owner,
            v.created_at, (${scope.where}) AS mine
       FROM keyed k
       JOIN grp g ON g.key = k.key
       JOIN vendor v ON v.id = k.id
       LEFT JOIN principal o ON o.id = v.owner_id
      ORDER BY k.key, v.created_at
      LIMIT 2000`,
    scope.params,
  );
  const groups = new Map<string, { any: boolean; rows: DuplicateGroup['vendors'] }>();
  for (const r of dup.rows) {
    const g = groups.get(r.key) ?? { any: false, rows: [] };
    g.any = g.any || r.mine;
    g.rows.push({ id: r.id, name: r.name, kind: r.kind, phone: r.phone, email: r.email, city: r.city, state: r.state, owner: r.owner, created_at: iso(r.created_at)! });
    groups.set(r.key, g);
  }
  const duplicates: DuplicateGroup[] = [...groups.entries()].filter(([, g]) => g.any).map(([key, g]) => ({ key, vendors: g.rows }));

  // Missing information: VR vendors that lack a required field, read live.
  const required = await requiredKeys();
  const cand = await query<Record<string, unknown> & { id: string; name: string; owner: string | null; created_at: Date }>(
    `SELECT v.id::text AS id, v.name, v.email, v.owner_id::text AS owner_id, v.city, v.state, v.primary_trade, v.legal_name,
            v.dba_name, v.primary_contact_name, v.dispatch_phone, v.billing_email,
            v.regular_hourly_rate, v.after_hours_rate, v.weekend_emergency_rate, v.trip_charge,
            v.diagnostic_fee, v.minimum_charge, o.display_name AS owner, v.created_at,
            ARRAY(SELECT display FROM vendor_phone ph WHERE ph.vendor_id = v.id ORDER BY position) AS phones
       FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id
      WHERE ${scope.where} AND v.kind = 'vendor'
      ORDER BY v.created_at DESC
      LIMIT 5000`,
    scope.params,
  );
  const missing = cand.rows
    .map((v) => ({ id: v.id, name: v.name, owner: v.owner, created_at: iso(v.created_at)!, problems: missingFields(v as never, required) }))
    .filter((v) => v.problems.length > 0);

  const off = await query<{ id: string; name: string; kind: VendorKind; city: string | null; state: string | null; zip: string | null }>(
    `SELECT v.id::text AS id, v.name, v.kind, v.city, v.state, v.zip
       FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id
      WHERE ${scope.where}
        AND NOT EXISTS (SELECT 1 FROM vendor_location l WHERE l.vendor_id = v.id AND l.lat IS NOT NULL)
      ORDER BY lower(v.name) LIMIT 1000`,
    scope.params,
  );
  return {
    duplicates: duplicates.slice(0, 300),
    missing: missing.slice(0, 500),
    not_on_map: off.rows,
    counts: { duplicates: duplicates.length, missing: missing.length, not_on_map: off.rows.length },
  };
}

// ═══ Bulk edit, select-all, export, bulk search ══════════════════════════════

const BULK_MAX = 5000;

/** Every id the list's filters match — "select all N that match". */
export async function matchingIds(q: VendorListQuery, actor: ActingPrincipal): Promise<string[]> {
  requireVendorsView(actor);
  const { where, params } = vendorListWhere(q, actor);
  const res = await query<{ id: string }>(
    `SELECT v.id::text AS id FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id WHERE ${where} LIMIT ${BULK_MAX}`,
    params,
  );
  return res.rows.map((r) => r.id);
}

/** The ids of a selection that exist and are inside the actor's scope. */
async function scopedIds(ids: string[], actor: ActingPrincipal): Promise<string[]> {
  const clean = [...new Set(ids.filter((i) => UUID_RE.test(i)))].slice(0, BULK_MAX);
  if (clean.length === 0) return [];
  return matchingIds({ ids: clean }, actor);
}

export async function bulkUpdate(ids: string[], patch: VendorBulkPatch, actor: ActingPrincipal): Promise<{ updated: number; skipped: number }> {
  requirePerm(actor, VENDORS_PERM_KEY, 'edit', 'You cannot edit vendors');
  const fields = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (fields.length === 0) throw badRequest('Pick what to change');
  const allowed = await scopedIds(ids, actor);
  // One record at a time through the ordinary edit: the same validation, the
  // same derived fields (map point, compliance, missing flag) and one audit
  // row each — a bulk edit must not be a way round any of them.
  let updated = 0;
  for (const id of allowed) {
    await updateVendor(id, Object.fromEntries(fields), actor);
    updated += 1;
  }
  return { updated, skipped: ids.length - allowed.length };
}

export async function bulkDelete(ids: string[], actor: ActingPrincipal): Promise<{ removed: number; skipped: number }> {
  requirePerm(actor, VENDORS_PERM_KEY, 'delete', 'You cannot remove vendors');
  const allowed = await scopedIds(ids, actor);
  for (const id of allowed) await deleteVendor(id, actor);
  return { removed: allowed.length, skipped: ids.length - allowed.length };
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
  // A leading = + - @ would run as a formula when the file is opened.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export async function exportCsv(q: VendorListQuery, actor: ActingPrincipal): Promise<{ csv: string; rows: number }> {
  requireVendorsView(actor);
  requirePerm(actor, VENDOR_EXPORT_PERM_KEY, 'view', 'You cannot export vendors');
  const { where, params } = vendorListWhere(q, actor);
  const res = await query<Record<string, unknown>>(
    `SELECT v.name, v.kind, v.status, v.brand_source, v.email,
            ARRAY(SELECT display FROM vendor_phone ph WHERE ph.vendor_id = v.id ORDER BY position) AS phones,
            v.city, v.state, v.zip, o.display_name AS owner, v.primary_trade, v.secondary_trades, v.priority,
            v.compliance_status, v.w9_received, v.msa_signed, v.coi_received, v.coi_approved,
            v.nationwide, v.statewide, v.regular_hourly_rate, v.trip_charge, v.work_orders_count,
            v.blacklisted, v.blacklist_reason, to_char(v.created_at, 'YYYY-MM-DD') AS date_added
       FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id
      WHERE ${where}
      ORDER BY ${vendorSortSql(q)}
      LIMIT 20000`,
    params,
  );
  const cols: [string, string][] = [
    ['name', 'Name'], ['kind', 'Kind'], ['status', 'Status'], ['brand_source', 'Brand source'], ['email', 'Email'],
    ['phones', 'Phones'], ['city', 'City'], ['state', 'State'], ['zip', 'ZIP'], ['owner', 'Owner'],
    ['primary_trade', 'Primary trade'], ['secondary_trades', 'Secondary trades'], ['priority', 'Priority'],
    ['compliance_status', 'Compliance'], ['w9_received', 'W-9'], ['msa_signed', 'MSA'], ['coi_received', 'COI received'],
    ['coi_approved', 'COI approved'], ['nationwide', 'Nationwide'], ['statewide', 'Statewide'],
    ['regular_hourly_rate', 'Regular hourly rate'], ['trip_charge', 'Trip charge'], ['work_orders_count', 'Jobs'],
    ['blacklisted', 'Blacklisted'], ['blacklist_reason', 'Blacklist reason'], ['date_added', 'Date added'],
  ];
  const lines = [cols.map(([, label]) => csvCell(label)).join(',')];
  for (const r of res.rows) lines.push(cols.map(([k]) => csvCell(r[k])).join(','));
  await logAdminEvent({
    actorId: actor.id,
    entity: 'export',
    entityId: actor.id,
    action: 'vendors_exported',
    after: { name: 'Vendors CSV', rows: res.rows.length, filters: q as Record<string, unknown> },
  });
  return { csv: `﻿${lines.join('\r\n')}\r\n`, rows: res.rows.length };
}

export interface BulkSearchResult {
  term: string;
  matches: { id: string; name: string; phone: string | null; email: string | null }[];
}

/** Paste a column of names, phones or emails; get back what is on file for
    each and what is not. */
export async function bulkSearch(field: 'name' | 'phone' | 'email', terms: string[], actor: ActingPrincipal): Promise<BulkSearchResult[]> {
  requireVendorsView(actor);
  const list = [...new Set(terms.map((t) => t.trim()).filter(Boolean))].slice(0, 300);
  const scope = vendorListWhere({}, actor);
  const out: BulkSearchResult[] = [];
  for (const term of list) {
    const params = [...scope.params];
    let cond: string;
    if (field === 'phone') {
      const d = phoneDigits(term);
      if (!d) {
        out.push({ term, matches: [] });
        continue;
      }
      params.push(d);
      cond = `EXISTS (SELECT 1 FROM vendor_phone ph WHERE ph.vendor_id = v.id AND ph.digits = $${params.length})`;
    } else if (field === 'email') {
      params.push(term.toLowerCase());
      cond = `(lower(v.email) = $${params.length} OR lower(v.billing_email) = $${params.length})`;
    } else {
      params.push(`%${term.replace(/[\\%_]/g, '\\$&')}%`);
      cond = `v.name ILIKE $${params.length}`;
    }
    const res = await query<{ id: string; name: string; phone: string | null; email: string | null }>(
      `SELECT v.id::text AS id, v.name, v.phone, v.email
         FROM vendor v LEFT JOIN principal o ON o.id = v.owner_id
        WHERE ${scope.where} AND ${cond}
        ORDER BY lower(v.name) LIMIT 10`,
      params,
    );
    out.push({ term, matches: res.rows });
  }
  return out;
}

// ═══ Saved lists ═════════════════════════════════════════════════════════════

const isManager = (a: ActingPrincipal): boolean => can(a, VENDOR_REVIEW_PERM_KEY, 'approve');

export async function listSavedViews(actor: ActingPrincipal): Promise<VendorSavedView[]> {
  requireVendorsView(actor);
  const res = await query<{ id: string; name: string; params: Record<string, string>; visibility: SavedViewVisibility; o_id: string; o_name: string; o_kind: 'human' | 'service' }>(
    `SELECT s.id::text AS id, s.name, s.params, s.visibility, p.id::text AS o_id, p.display_name AS o_name, p.kind AS o_kind
       FROM vendor_saved_view s JOIN principal p ON p.id = s.owner_id
      WHERE s.owner_id = $1 OR s.visibility = 'EVERYONE' OR (s.visibility = 'MANAGERS' AND $2::boolean)
      ORDER BY lower(s.name)`,
    [actor.id, isManager(actor)],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    params: r.params ?? {},
    visibility: r.visibility,
    owner: { id: r.o_id, name: r.o_name, kind: r.o_kind },
    mine: r.o_id === actor.id,
  }));
}

function cleanViewParams(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAVED_VIEW_KEYS) {
    const v = raw[k];
    // The advanced filter is JSON: keep it only when it still parses to rules.
    if (k === 'filter') {
      const f = typeof v === 'string' ? serializeVendorFilter(parseVendorFilter(v)) : null;
      if (f) out[k] = f;
      continue;
    }
    if (typeof v === 'string' && v.trim() !== '') out[k] = v.trim().slice(0, 400);
  }
  return out;
}

export async function saveView(
  input: { name: string; params: Record<string, unknown>; visibility?: SavedViewVisibility },
  actor: ActingPrincipal,
): Promise<VendorSavedView[]> {
  requireVendorsView(actor);
  requirePerm(actor, VENDOR_LISTS_PERM_KEY, 'create', 'You cannot save lists');
  const name = input.name.trim();
  if (name === '') throw badRequest('The list needs a name', { field: 'name' });
  await query(`INSERT INTO vendor_saved_view (owner_id, name, params, visibility) VALUES ($1, $2, $3::jsonb, $4)`, [
    actor.id,
    name.slice(0, 120),
    JSON.stringify(cleanViewParams(input.params)),
    input.visibility ?? 'PRIVATE',
  ]);
  return listSavedViews(actor);
}

export async function deleteView(id: string, actor: ActingPrincipal): Promise<VendorSavedView[]> {
  requireVendorsView(actor);
  if (!UUID_RE.test(id)) throw notFound('List not found');
  // Its owner, or a manager for a list they can see.
  const res = await query(
    `DELETE FROM vendor_saved_view WHERE id = $1 AND (owner_id = $2 OR ($3::boolean AND visibility <> 'PRIVATE'))`,
    [id, actor.id, isManager(actor)],
  );
  if ((res.rowCount ?? 0) === 0) throw notFound('List not found');
  return listSavedViews(actor);
}

// ═══ Required fields (Admin › Vendors & map) ═════════════════════════════════

export async function requiredFieldSettings(): Promise<{ key: string; label: string; required: boolean; default_required: boolean }[]> {
  const over = await requiredOverrides();
  return VENDOR_REQUIRABLE_FIELDS.map((f) => ({
    key: f.key,
    label: f.label,
    required: over[f.key] ?? f.defaultRequired,
    default_required: f.defaultRequired,
  }));
}

export async function setRequiredField(key: string, required: boolean, actor: ActingPrincipal): Promise<void> {
  const def = VENDOR_REQUIRABLE_FIELDS.find((f) => f.key === key);
  if (!def) throw badRequest('That field cannot be required');
  if (key === 'name' && !required) throw badRequest('A vendor always needs a name');
  await query(
    `INSERT INTO vendor_required_field (field_key, is_required) VALUES ($1, $2)
     ON CONFLICT (field_key) DO UPDATE SET is_required = EXCLUDED.is_required, updated_at = now()`,
    [key, required],
  );
  await logAdminEvent({
    actorId: actor.id,
    entity: 'vendor_setting',
    entityId: 'required-fields',
    action: 'vendor_required_field_changed',
    after: { name: def.label, required },
  });
}

/** After the required list changes: re-read every VR vendor's flag. */
export async function refreshMissingFlags(): Promise<void> {
  const res = await query<{ id: string }>(`SELECT id::text AS id FROM vendor WHERE deleted_at IS NULL AND kind = 'vendor' LIMIT 20000`);
  for (const r of res.rows) await recomputeMissing(r.id);
}

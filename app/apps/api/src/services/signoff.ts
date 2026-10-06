// 0070 · Sign-off sheets.
//
// The blank sheet is generated the moment a technician is attached to the
// work order (a hire from the map, a visit with a technician) and kept as the
// newest `wo_signoff` row; the '21. Comp' entity picks the drawing, the
// client's work order number and the service address are printed. Share
// texts the technician a download link through Quo — by API when
// QUO_API_KEY / QUO_FROM_NUMBER are set, otherwise by opening the Quo app on
// the dispatcher's PC with the text pre-filled. The signed copy comes back as
// a text with a file: Quo's message.received webhook lands here, the sender's
// number is matched to the sheets shared with it, and the file is filed as a
// 'signoff' attachment (0061, quarantined until a reviewer approves — rule
// 1.3.1) with '24. Sign-Off Link' pointing at it. A number holding more than
// one open sheet parks the file in `wo_signoff_reply` until a person says
// which work order it belongs to.
//
// Nothing here writes to a client system; Quo is our own line.

import { randomBytes } from 'node:crypto';
import { del, get, put } from '@vercel/blob';
import {
  ATTACHMENT_ALLOWED_TYPES,
  ATTACHMENT_MAX_BYTES,
  SIGNOFF_ENTITY_NAMES,
  SIGNOFF_PERM_KEY,
  SIGNOFF_TOKEN_RE,
  VISIT_MIRROR_KEYS,
  normalizePhone,
  signoffLayoutFor,
  signoffMessageText,
  signoffPublicPath,
  type SignoffLayout,
  type SignoffReply,
  type SignoffShare,
  type SignoffShareInput,
  type SignoffShareResult,
  type SignoffTechnician,
  type WoSignoff,
  type WoSignoffResponse,
} from '@theone/shared';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import type { Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { fetchQuoMedia, quoApiReady, sendQuoText } from '../lib/quoApi.js';
import { renderSignoffSheet } from '../lib/signoffPdf.js';
import type { ActingPrincipal } from './activity.js';
import { addSystemAttachment, storageReady } from './attachments.js';
import { dispatchAutomations } from './automations.js';
import { allowFor, requirePerm } from './permissions.js';
import { serviceActorId } from './serviceActors.js';
import { changed, logTaskChanges, type TaskChange } from './woAudit.js';

const K_ADDRESS = '17. Address';
const K_LINK = '24. Sign-Off Link';
/** How long a shared sheet keeps matching replies from that number. */
const REPLY_WINDOW_DAYS = 45;

function blobToken(): string {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  if (!t) throw conflict('File storage is not connected to this environment yet, so sheets cannot be generated', { code: 'ATTACHMENT_STORAGE_MISSING' });
  return t;
}

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// ── Reading ──────────────────────────────────────────────────────────────────

interface Facts {
  id: string;
  wo_number: string;
  ext_name: string | null;
  billing_entity: string | null;
  client: string | null;
  address: string | null;
  fields: Record<string, unknown>;
}

async function facts(q: Queryable, taskId: string): Promise<Facts> {
  const res = await q.query<Facts>(
    `SELECT id::text AS id, wo_number, ext_name, billing_entity, client,
            fields->>$2 AS address, fields
       FROM task WHERE id = $1 AND deleted_at IS NULL`,
    [taskId, K_ADDRESS],
  );
  if (!res.rows[0]) throw notFound('Work order not found');
  return { ...res.rows[0], fields: res.rows[0].fields ?? {} };
}

/** What the sheet prints: the client's number first, ours as the fallback. */
function refOf(f: Facts): string {
  return (f.ext_name ?? '').trim() || f.wo_number;
}

function layoutOf(f: Facts): SignoffLayout | null {
  return signoffLayoutFor(f.billing_entity, f.client);
}

interface SheetRow {
  id: string;
  layout: SignoffLayout;
  entity: string | null;
  wo_ref: string;
  address: string | null;
  storage_key: string;
  token: string;
  created_by_id: string | null;
  created_by_name: string | null;
  created_at: Date | string;
  signed_attachment_id: string | null;
  signed_at: Date | string | null;
}

const SHEET_SQL = `
  SELECT g.id::text AS id, g.layout, g.entity, g.wo_ref, g.address, g.storage_key, g.token,
         g.created_by::text AS created_by_id, p.display_name AS created_by_name,
         g.created_at, g.signed_attachment_id::text AS signed_attachment_id, g.signed_at
    FROM wo_signoff g LEFT JOIN principal p ON p.id = g.created_by`;

async function currentSheet(q: Queryable, taskId: string): Promise<SheetRow | null> {
  const res = await q.query<SheetRow>(
    `${SHEET_SQL} WHERE g.task_id = $1 AND g.superseded_at IS NULL ORDER BY g.created_at DESC LIMIT 1`,
    [taskId],
  );
  return res.rows[0] ?? null;
}

async function sharesOf(signoffId: string): Promise<SignoffShare[]> {
  const res = await query<{ id: string; vendor_id: string | null; tech_name: string | null; phone: string; channel: 'quo_api' | 'quo_app'; sent_by_id: string | null; sent_by_name: string | null; sent_at: Date }>(
    `SELECT s.id::text AS id, s.vendor_id::text AS vendor_id, s.tech_name, s.phone, s.channel,
            s.sent_by::text AS sent_by_id, p.display_name AS sent_by_name, s.sent_at
       FROM wo_signoff_share s LEFT JOIN principal p ON p.id = s.sent_by
      WHERE s.signoff_id = $1 ORDER BY s.sent_at DESC`,
    [signoffId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    vendor_id: r.vendor_id,
    tech_name: r.tech_name,
    phone: r.phone,
    channel: r.channel,
    sent_by: r.sent_by_id ? { id: r.sent_by_id, name: r.sent_by_name ?? 'Unknown' } : null,
    sent_at: iso(r.sent_at)!,
  }));
}

function publicUrl(token: string): string {
  return `${config.webOrigin}${signoffPublicPath(token)}`;
}

async function present(row: SheetRow, f: Facts): Promise<WoSignoff> {
  return {
    id: row.id,
    layout: row.layout,
    entity_name: SIGNOFF_ENTITY_NAMES[row.layout],
    wo_ref: row.wo_ref,
    address: row.address,
    created_by: row.created_by_id ? { id: row.created_by_id, name: row.created_by_name ?? 'Unknown' } : null,
    created_at: iso(row.created_at)!,
    stale: row.wo_ref !== refOf(f) || (row.address ?? '') !== (f.address ?? '') || row.layout !== layoutOf(f),
    url: publicUrl(row.token),
    shares: await sharesOf(row.id),
    signed_attachment_id: row.signed_attachment_id,
    signed_at: iso(row.signed_at),
  };
}

/** Everyone the sheet could go to: the hired technicians with a number, and
    the technicians named on visits — one entry per phone number. */
async function techniciansOf(taskId: string, f: Facts): Promise<SignoffTechnician[]> {
  const out: SignoffTechnician[] = [];
  const seen = new Set<string>();
  const push = (t: Omit<SignoffTechnician, 'key'>) => {
    if (seen.has(t.phone)) return;
    seen.add(t.phone);
    out.push({ key: `${t.vendor_id ?? 'visit'}:${t.phone}`, ...t });
  };
  const hired = await query<{ vendor_id: string; name: string; phone: string | null; phones: string[] | null }>(
    `SELECT v.id::text AS vendor_id, v.name, v.phone,
            (SELECT array_agg(ph.display ORDER BY ph.position) FROM vendor_phone ph WHERE ph.vendor_id = v.id) AS phones
       FROM wo_technician w JOIN vendor v ON v.id = w.vendor_id
      WHERE w.task_id = $1 AND w.released_at IS NULL AND v.deleted_at IS NULL
      ORDER BY w.hired_at`,
    [taskId],
  );
  for (const h of hired.rows) {
    for (const raw of [h.phone, ...(h.phones ?? [])]) {
      const phone = normalizePhone(raw);
      if (phone) push({ vendor_id: h.vendor_id, name: h.name, phone, source: 'Hired on this work order' });
    }
  }
  const visits = await query<{ tech_name: string | null; tech_phone: string | null; seq: number }>(
    `SELECT tech_name, tech_phone, seq FROM wo_visit WHERE task_id = $1 AND tech_phone IS NOT NULL ORDER BY seq DESC`,
    [taskId],
  );
  for (const v of visits.rows) {
    const phone = normalizePhone(v.tech_phone);
    if (phone) push({ vendor_id: null, name: v.tech_name?.trim() || 'Technician', phone, source: `Visit ${v.seq}` });
  }
  const mirrorPhone = normalizePhone(String(f.fields[VISIT_MIRROR_KEYS.techPhone] ?? ''));
  if (mirrorPhone) {
    push({ vendor_id: null, name: String(f.fields[VISIT_MIRROR_KEYS.techName] ?? '').trim() || 'Technician', phone: mirrorPhone, source: 'Latest visit' });
  }
  return out;
}

async function openRepliesFor(taskId: string): Promise<SignoffReply[]> {
  const res = await query<{ id: string; phone: string; tech_name: string | null; file_name: string; content_type: string; body: string | null; received_at: Date }>(
    `SELECT id::text AS id, phone, tech_name, file_name, content_type, body, received_at
       FROM wo_signoff_reply
      WHERE resolved_at IS NULL AND dismissed_at IS NULL AND $1::uuid = ANY(candidate_task_ids)
      ORDER BY received_at DESC`,
    [taskId],
  );
  return res.rows.map((r) => ({ ...r, received_at: iso(r.received_at)! }));
}

function canWrite(actor: ActingPrincipal): boolean {
  const allow = allowFor(actor);
  return allow('work_orders', 'edit') && allow(SIGNOFF_PERM_KEY, 'edit');
}

function requireWrite(actor: ActingPrincipal): void {
  requirePerm(actor, 'work_orders', 'edit', 'You cannot edit work orders');
  requirePerm(actor, SIGNOFF_PERM_KEY, 'edit', 'You cannot manage sign-off sheets');
}

export async function getSignoff(taskId: string, actor: ActingPrincipal): Promise<WoSignoffResponse> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot view work orders');
  requirePerm(actor, SIGNOFF_PERM_KEY, 'view', 'You cannot view sign-off sheets');
  const f = await facts({ query }, taskId);
  const row = await currentSheet({ query }, taskId);
  const writable = canWrite(actor);
  return {
    signoff: row ? await present(row, f) : null,
    layout: layoutOf(f),
    technicians: await techniciansOf(taskId, f),
    replies: await openRepliesFor(taskId),
    can: { generate: writable, share: writable },
    storage_ready: storageReady(),
    quo_api_ready: quoApiReady(),
  };
}

// ── Generating ───────────────────────────────────────────────────────────────

async function logSignoff(q: Queryable, actorId: string, taskId: string, action: string, signoffId: string | null, after: Record<string, unknown>): Promise<void> {
  await q.query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
     VALUES ($1, 'task', $2, $3, $4, NULL, $5::jsonb)`,
    [actorId, taskId, action, signoffId ? `signoff:${signoffId}` : null, JSON.stringify(after)],
  );
}

/** Draw, store and record a fresh blank sheet; the previous one is superseded. */
async function generate(taskId: string, actorId: string, via: 'button' | 'technician'): Promise<SheetRow> {
  const token = blobToken();
  const f = await facts({ query }, taskId);
  const layout = layoutOf(f);
  if (!layout) {
    throw badRequest(`Set Comp on the work order first — ${f.billing_entity ? `"${f.billing_entity}" has no sign-off sheet` : 'the sheet is drawn in the billing entity\'s branding'}`);
  }
  const wo_ref = refOf(f);
  const bytes = await renderSignoffSheet({ layout, wo_ref, address: f.address });
  const safeWo = f.wo_number.replace(/[^A-Za-z0-9._-]+/g, '-');
  const pathname = `work-orders/${safeWo}/signoff/${Date.now()}-blank.pdf`;
  const blob = await put(pathname, Buffer.from(bytes), { access: 'private', token, contentType: 'application/pdf', addRandomSuffix: false });
  const linkToken = randomBytes(24).toString('base64url');

  return withTransaction(async (tx) => {
    const old = await tx.query<{ id: string; storage_key: string }>(
      `UPDATE wo_signoff SET superseded_at = now() WHERE task_id = $1 AND superseded_at IS NULL RETURNING id::text AS id, storage_key`,
      [taskId],
    );
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO wo_signoff (task_id, layout, entity, wo_ref, address, storage_key, token, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
      [taskId, layout, f.billing_entity, wo_ref, f.address, blob.pathname, linkToken, actorId],
    );
    await logSignoff(tx, actorId, taskId, 'signoff_generated', ins.rows[0].id, {
      layout, entity: f.billing_entity, wo_ref, address: f.address, via, replaced: old.rows.map((r) => r.id),
    });
    const res = await tx.query<SheetRow>(`${SHEET_SQL} WHERE g.id = $1`, [ins.rows[0].id]);
    // The old blank is of no use to anyone; its link dies with the row's
    // superseded_at, and the bytes go once the row is safely replaced.
    for (const o of old.rows) {
      try { await del(o.storage_key, { token }); } catch { /* already gone */ }
    }
    return res.rows[0];
  });
}

/** The button: a new sheet, or a fresh one when the details changed. */
export async function generateSignoff(taskId: string, actor: ActingPrincipal): Promise<WoSignoffResponse> {
  requireWrite(actor);
  await generate(taskId, actor.id, 'button');
  return getSignoff(taskId, actor);
}

/**
 * The hook: called when a technician lands on a work order. Makes the sheet
 * when there is none yet and the pieces are in place (Comp set, storage
 * connected); never throws — a hire must not fail because the sheet could
 * not be drawn. The actor is whoever attached the technician.
 */
export async function ensureSignoff(taskId: string, actorId: string): Promise<void> {
  try {
    if (!storageReady()) return;
    if (await currentSheet({ query }, taskId)) return;
    const f = await facts({ query }, taskId);
    if (!layoutOf(f)) return;
    await generate(taskId, actorId, 'technician');
  } catch (err) {
    console.warn(`[signoff] could not generate the sheet for ${taskId}: ${(err as Error).message}`);
  }
}

// ── Reading the blank ────────────────────────────────────────────────────────

export interface SheetFile { stream: ReadableStream; fileName: string }

async function streamOf(storageKey: string): Promise<ReadableStream> {
  const blob = await get(storageKey, { access: 'private', token: blobToken() });
  if (!blob || blob.statusCode !== 200 || !blob.stream) throw notFound('That sheet is no longer in storage');
  return blob.stream;
}

export async function readSignoffFile(taskId: string, actor: ActingPrincipal): Promise<SheetFile> {
  requirePerm(actor, 'work_orders', 'view', 'You cannot view work orders');
  requirePerm(actor, SIGNOFF_PERM_KEY, 'view', 'You cannot view sign-off sheets');
  const row = await currentSheet({ query }, taskId);
  if (!row) throw notFound('No sign-off sheet has been generated for this work order');
  return { stream: await streamOf(row.storage_key), fileName: `Signoff-${row.wo_ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf` };
}

/** The technician's download. The token is the whole credential; a
    superseded sheet's link answers 404 so a stale address cannot be signed. */
export async function publicSignoffFile(token: string): Promise<SheetFile> {
  if (!SIGNOFF_TOKEN_RE.test(token)) throw notFound('No such sheet');
  const res = await query<{ storage_key: string; wo_ref: string }>(
    `SELECT storage_key, wo_ref FROM wo_signoff WHERE token = $1 AND superseded_at IS NULL`,
    [token],
  );
  const row = res.rows[0];
  if (!row) throw notFound('No such sheet');
  return { stream: await streamOf(row.storage_key), fileName: `Signoff-${row.wo_ref.replace(/[^A-Za-z0-9._-]+/g, '-')}.pdf` };
}

// ── Sharing ──────────────────────────────────────────────────────────────────

export async function shareSignoff(taskId: string, input: SignoffShareInput, actor: ActingPrincipal): Promise<SignoffShareResult> {
  requireWrite(actor);
  const phone = normalizePhone(input.phone);
  if (!phone) throw badRequest('That is not a phone number we can text', { field: 'phone' });

  let row = await currentSheet({ query }, taskId);
  if (!row) row = await generate(taskId, actor.id, 'button');
  const text = signoffMessageText(SIGNOFF_ENTITY_NAMES[row.layout], row.wo_ref, row.address, publicUrl(row.token));

  let channel: 'quo_api' | 'quo_app';
  let quoMessageId: string | null = null;
  let sms: string | null = null;
  if (quoApiReady()) {
    const sent = await sendQuoText(phone, text);
    channel = 'quo_api';
    quoMessageId = sent.id;
  } else {
    channel = 'quo_app';
    sms = `sms:${phone}?body=${encodeURIComponent(text)}`;
  }

  const techName = (input.tech_name ?? '').trim() || null;
  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO wo_signoff_share (signoff_id, task_id, vendor_id, tech_name, phone, channel, quo_message_id, sent_by)
       VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8)`,
      [row!.id, taskId, input.vendor_id ?? null, techName, phone, channel, quoMessageId, actor.id],
    );
    await logSignoff(tx, actor.id, taskId, 'signoff_shared', row!.id, {
      phone, tech_name: techName, vendor_id: input.vendor_id ?? null, channel, quo_message_id: quoMessageId,
    });
  });
  return { ...(await getSignoff(taskId, actor)), channel, sms };
}

// ── The signed copy coming back ──────────────────────────────────────────────

function quoActorId(): Promise<string> {
  return serviceActorId('Quo', 'QU');
}

/** File a signed copy on the work order and point the field at it. */
async function fileSignedCopy(
  taskId: string,
  src: { bytes?: Buffer; storageKey?: string; byteSize?: number; fileName: string; contentType: string },
  actorId: string,
  via: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const f = await facts({ query }, taskId);
  const attachment = await addSystemAttachment(taskId, f.wo_number, {
    bytes: src.bytes,
    storageKey: src.storageKey,
    byteSize: src.byteSize,
    fileName: src.fileName,
    contentType: src.contentType,
    kind: 'signoff',
    actorId,
    via,
  });
  const link = `${config.webOrigin}/api/work-orders/${encodeURIComponent(f.wo_number)}/attachments/${attachment.id}`;
  let changes: TaskChange[] = [];
  await withTransaction(async (tx) => {
    const sheet = await tx.query<{ id: string }>(
      `UPDATE wo_signoff SET signed_attachment_id = $2, signed_at = now()
        WHERE task_id = $1 AND superseded_at IS NULL RETURNING id::text AS id`,
      [taskId, attachment.id],
    );
    const before = f.fields[K_LINK] ?? null;
    if (changed(before, link)) {
      const merged = { ...f.fields, [K_LINK]: link };
      await tx.query(`UPDATE task SET fields = $2::jsonb, updated_at = now() WHERE id = $1`, [taskId, JSON.stringify(merged)]);
      changes = [{ field: `fields.${K_LINK}`, before, after: link }];
      await logTaskChanges(tx, actorId, taskId, changes, 'signoff');
    }
    await logSignoff(tx, actorId, taskId, 'signoff_received', sheet.rows[0]?.id ?? null, {
      attachment_id: attachment.id, file_name: attachment.file_name, content_type: attachment.content_type, via, ...extra,
    });
  });
  if (changes.length) await dispatchAutomations({ taskId, kind: 'changed', changes });
  return attachment.id;
}

/** The work orders a number holds an open sheet for, newest share first. */
// (open = shared, current, and not signed more than two days ago)
async function candidatesFor(phone: string): Promise<string[]> {
  const res = await query<{ task_id: string }>(
    `SELECT s.task_id::text AS task_id
       FROM wo_signoff_share s
       JOIN wo_signoff g ON g.id = s.signoff_id
       JOIN task t ON t.id = s.task_id
      WHERE s.phone = $1 AND g.superseded_at IS NULL AND t.deleted_at IS NULL
        -- a sheet stays matchable for two days after its first signed page,
        -- so a second photo of the same sheet lands on the same work order
        AND (g.signed_at IS NULL OR g.signed_at > now() - interval '2 days')
        AND s.sent_at > now() - make_interval(days => $2::int)
      GROUP BY s.task_id ORDER BY MAX(s.sent_at) DESC`,
    [phone, REPLY_WINDOW_DAYS],
  );
  return res.rows.map((r) => r.task_id);
}

export type SignoffInboundOutcome =
  | { handled: false; reason: string }
  | { handled: true; signoff: 'filed' | 'held'; task_ids: string[]; files: number };

/**
 * Quo's `message.received`. Both payload generations are read: the legacy
 * one (`data.object.from / body / media`) and the versioned one
 * (`data.resource.text / media`, `data.context.senderIdentifier`). A text
 * with no file, or from a number that holds no open sheet, is acknowledged
 * and ignored — Quo must not retry it.
 */
export async function onInboundMessage(data: { object?: Record<string, unknown>; resource?: Record<string, unknown>; context?: Record<string, unknown> } | undefined): Promise<SignoffInboundOutcome> {
  const obj = data?.object ?? data?.resource ?? {};
  const ctx = data?.context ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const direction = str(obj.direction);
  if (direction && direction !== 'incoming') return { handled: false, reason: 'not an incoming message' };
  const from = normalizePhone(str(obj.from) ?? str(ctx.senderIdentifier));
  if (!from) return { handled: false, reason: 'message has no sender number' };
  const media = Array.isArray(obj.media) ? (obj.media as Record<string, unknown>[]) : [];
  const urls = media.map((m) => str(m.url)).filter((u): u is string => !!u);
  if (urls.length === 0) return { handled: false, reason: 'no file on the message' };
  if (!storageReady()) return { handled: false, reason: 'file storage is not connected' };

  const candidates = await candidatesFor(from);
  if (candidates.length === 0) return { handled: false, reason: 'no open sign-off sheet was shared with this number' };

  const quoMessageId = str(obj.id);
  const body = str(obj.body) ?? str(obj.text);
  const techName = await nameFor(from, candidates);
  const actorId = await quoActorId();
  let files = 0;

  for (const [i, url] of urls.entries()) {
    const fetched = await fetchQuoMedia(url, ATTACHMENT_MAX_BYTES);
    if (!fetched) continue;
    const contentType = ATTACHMENT_ALLOWED_TYPES.includes(fetched.contentType) ? fetched.contentType : guessType(url);
    if (!contentType) continue;
    const ext = contentType === 'application/pdf' ? 'pdf' : contentType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    const fileName = `signed-signoff${urls.length > 1 ? `-${i + 1}` : ''}.${ext}`;

    if (candidates.length === 1) {
      await fileSignedCopy(candidates[0], { bytes: fetched.bytes, fileName, contentType }, actorId, 'quo', {
        phone: from, tech_name: techName, quo_message_id: quoMessageId, body,
      });
      files++;
      continue;
    }
    // More than one open sheet on this number: hold it for a person.
    const pathname = `signoff-replies/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${fileName}`;
    const blob = await put(pathname, fetched.bytes, { access: 'private', token: blobToken(), contentType, addRandomSuffix: false });
    const ins = await query<{ id: string }>(
      `INSERT INTO wo_signoff_reply (quo_message_id, phone, tech_name, storage_key, file_name, content_type, byte_size, body, candidate_task_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid[])
       ON CONFLICT (quo_message_id) DO UPDATE SET received_at = wo_signoff_reply.received_at
       RETURNING id::text AS id`,
      [urls.length > 1 && quoMessageId ? `${quoMessageId}#${i + 1}` : quoMessageId, from, techName, blob.pathname, fileName, contentType, fetched.bytes.length, body, candidates],
    );
    for (const taskId of candidates) {
      await logSignoff({ query }, actorId, taskId, 'signoff_reply_held', null, {
        reply_id: ins.rows[0].id, phone: from, tech_name: techName, file_name: fileName, candidates,
      });
    }
    files++;
  }
  if (files === 0) return { handled: false, reason: 'no usable file on the message' };
  return { handled: true, signoff: candidates.length === 1 ? 'filed' : 'held', task_ids: candidates, files };
}

function guessType(url: string): string | null {
  const m = /\.([a-z0-9]+)(?:\?|$)/i.exec(url);
  switch ((m?.[1] ?? '').toLowerCase()) {
    case 'pdf': return 'application/pdf';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'heic': return 'image/heic';
    case 'webp': return 'image/webp';
    default: return null;
  }
}

/** The name we texted this number under, from the newest share. */
async function nameFor(phone: string, taskIds: string[]): Promise<string | null> {
  const res = await query<{ tech_name: string | null }>(
    `SELECT tech_name FROM wo_signoff_share WHERE phone = $1 AND task_id = ANY($2::uuid[]) AND tech_name IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1`,
    [phone, taskIds],
  );
  return res.rows[0]?.tech_name ?? null;
}

// ── Held replies ─────────────────────────────────────────────────────────────

async function openReply(replyId: string, taskId: string) {
  const res = await query<{ id: string; storage_key: string; file_name: string; content_type: string; byte_size: number; phone: string; tech_name: string | null; quo_message_id: string | null; candidate_task_ids: string[] }>(
    `SELECT id::text AS id, storage_key, file_name, content_type, byte_size, phone, tech_name, quo_message_id, candidate_task_ids::text[] AS candidate_task_ids
       FROM wo_signoff_reply
      WHERE id = $1 AND resolved_at IS NULL AND dismissed_at IS NULL AND $2::uuid = ANY(candidate_task_ids)`,
    [replyId, taskId],
  );
  if (!res.rows[0]) throw notFound('That signed copy is no longer waiting here');
  return res.rows[0];
}

/** "This is ours": file the held copy on this work order. */
export async function claimReply(taskId: string, replyId: string, actor: ActingPrincipal): Promise<WoSignoffResponse> {
  requireWrite(actor);
  const r = await openReply(replyId, taskId);
  const attachmentId = await fileSignedCopy(
    taskId,
    { storageKey: r.storage_key, byteSize: r.byte_size, fileName: r.file_name, contentType: r.content_type },
    actor.id,
    'quo',
    { phone: r.phone, tech_name: r.tech_name, quo_message_id: r.quo_message_id, reply_id: r.id, claimed: true },
  );
  await query(
    `UPDATE wo_signoff_reply SET attached_task_id = $2, attachment_id = $3, resolved_by = $4, resolved_at = now() WHERE id = $1`,
    [replyId, taskId, attachmentId, actor.id],
  );
  return getSignoff(taskId, actor);
}

/** "Not ours": the copy stops waiting on this work order; when no candidate
    is left it is dismissed and its bytes dropped. */
export async function dismissReply(taskId: string, replyId: string, actor: ActingPrincipal): Promise<WoSignoffResponse> {
  requireWrite(actor);
  const r = await openReply(replyId, taskId);
  const remaining = r.candidate_task_ids.filter((id) => id !== taskId);
  await query(
    `UPDATE wo_signoff_reply SET candidate_task_ids = $2::uuid[], dismissed_at = CASE WHEN cardinality($2::uuid[]) = 0 THEN now() ELSE dismissed_at END
      WHERE id = $1`,
    [replyId, remaining],
  );
  await logSignoff({ query }, actor.id, taskId, 'signoff_reply_dismissed', null, { reply_id: r.id, phone: r.phone, file_name: r.file_name, remaining });
  if (remaining.length === 0) {
    try { await del(r.storage_key, { token: blobToken() }); } catch { /* already gone */ }
  }
  return getSignoff(taskId, actor);
}

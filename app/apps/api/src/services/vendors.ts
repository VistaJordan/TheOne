// Vendors (technicians) — the record Yoda calls Technician. Search by name /
// phone for the payment request's typeahead, create from a manual payee, and
// the compliance flags AP maintains (W9 on file, blacklist, COI expiry).

import { query } from '../db.js';
import type { Vendor, VendorsResponse } from '@theone/shared';
import { conflict, forbidden, notFound } from '../errors.js';
import type { ActingPrincipal } from './activity.js';
import { canProcessPayments } from './payments.js';

interface VendorRow {
  id: string;
  name: string;
  trades: string[] | string | null;
  phone: string | null;
  email: string | null;
  city: string | null;
  state: string | null;
  is_w9_present: boolean;
  is_blacklisted: boolean;
  blacklist_reason: string | null;
  insurance_expires_on: string | null;
}

const SELECT_SQL = `
  SELECT id::text AS id, name, trades, phone, email, city, state,
         is_w9_present, is_blacklisted, blacklist_reason,
         to_char(insurance_expires_on, 'YYYY-MM-DD') AS insurance_expires_on
    FROM vendor`;

function toTrades(v: VendorRow['trades']): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.replace(/[{}"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

function mapVendor(r: VendorRow): Vendor {
  return {
    id: r.id,
    name: r.name,
    trades: toTrades(r.trades),
    phone: r.phone,
    email: r.email,
    city: r.city,
    state: r.state,
    is_w9_present: r.is_w9_present === true,
    is_blacklisted: r.is_blacklisted === true,
    blacklist_reason: r.blacklist_reason,
    insurance_expires_on: r.insurance_expires_on,
  };
}

export async function listVendors(q: string | null, trade: string | null, limit = 50): Promise<VendorsResponse> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`, q.replace(/\D/g, ''));
    where.push(`(name ILIKE $${params.length - 1} OR ($${params.length} <> '' AND regexp_replace(COALESCE(phone,''), '\\D', '', 'g') LIKE '%' || $${params.length} || '%'))`);
  }
  if (trade && trade.trim()) {
    params.push(trade.trim());
    where.push(`$${params.length} = ANY(trades)`);
  }
  params.push(limit);
  const res = await query<VendorRow>(
    `${SELECT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC LIMIT $${params.length}`,
    params,
  );
  return { items: res.rows.map(mapVendor), total: res.rows.length };
}

export async function getVendor(id: string): Promise<Vendor> {
  const res = await query<VendorRow>(`${SELECT_SQL} WHERE id = $1`, [id]);
  if (res.rows.length === 0) throw notFound('Vendor not found');
  return mapVendor(res.rows[0]);
}

export interface VendorInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  trades?: string[];
  city?: string | null;
  state?: string | null;
}

export async function createVendor(input: VendorInput): Promise<Vendor> {
  if (input.phone) {
    const digits = input.phone.replace(/\D/g, '');
    const dup = await query<{ id: string; name: string }>(
      `SELECT id::text AS id, name FROM vendor WHERE regexp_replace(COALESCE(phone,''), '\\D', '', 'g') = $1 AND $1 <> '' LIMIT 1`,
      [digits],
    );
    if (dup.rows.length > 0) {
      throw conflict('A vendor with this phone number already exists', {
        code: 'VENDOR_PHONE_EXISTS',
        vendor_id: dup.rows[0].id,
        name: dup.rows[0].name,
      });
    }
  }
  const res = await query<{ id: string }>(
    `INSERT INTO vendor (name, phone, email, trades, city, state) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [input.name.trim(), input.phone?.trim() || null, input.email?.trim() || null, input.trades ?? [], input.city ?? null, input.state ?? null],
  );
  return getVendor(res.rows[0].id);
}

export interface VendorComplianceInput {
  is_w9_present?: boolean;
  is_blacklisted?: boolean;
  blacklist_reason?: string | null;
  insurance_expires_on?: string | null;
  notes?: string | null;
}

/** AP / admin maintain the compliance flags (Yoda technician-list edits). */
export async function updateVendorCompliance(id: string, input: VendorComplianceInput, actor: ActingPrincipal): Promise<Vendor> {
  if (!canProcessPayments(actor)) throw forbidden('Updating vendor compliance requires AP', { role: actor.role });
  await getVendor(id);
  const sets: string[] = [];
  const params: unknown[] = [];
  const set = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.is_w9_present !== undefined) set('is_w9_present', input.is_w9_present);
  if (input.is_blacklisted !== undefined) set('is_blacklisted', input.is_blacklisted);
  if (input.blacklist_reason !== undefined) set('blacklist_reason', input.blacklist_reason);
  if (input.insurance_expires_on !== undefined) set('insurance_expires_on', input.insurance_expires_on);
  if (input.notes !== undefined) set('notes', input.notes);
  if (sets.length > 0) {
    params.push(id);
    await query(`UPDATE vendor SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, before, after)
       VALUES ($1, 'vendor', $2, 'vendor_compliance_updated', NULL, NULL, $3::jsonb)`,
      [actor.id, id, JSON.stringify(input)],
    );
  }
  return getVendor(id);
}

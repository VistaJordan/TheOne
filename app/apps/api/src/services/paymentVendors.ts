// The payment request's technician typeahead (Yoda Technician search) — a
// slim read of the vendor record (0057) in the `Vendor` shape the payment
// form and its W9 / blacklist / COI chips expect.
//
// The vendor record stays the one source of truth: W9 on file is
// `w9_received = 'YES'`, the blacklist is `blacklisted` (set and cleared on
// the Vendors page, with its notes), and the COI date is the earliest
// `vendor_expiry`. Nothing here writes compliance — the Vendors module owns
// that, with its own audit. Creating a technician from a manual payee happens
// inside createPaymentRequest (services/payments.ts), keyed by phone.
//
// Mounted under /payment-vendors so it can never shadow the Vendors module's
// own /vendors routes.

import { query } from '../db.js';
import type { Vendor, VendorsResponse } from '@theone/shared';
import { notFound } from '../errors.js';

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
  SELECT v.id::text AS id, v.name, v.trades, v.phone, v.email, v.city, v.state,
         (v.w9_received = 'YES') AS is_w9_present,
         v.blacklisted           AS is_blacklisted,
         v.blacklist_reason,
         (SELECT to_char(min(e.expires_on), 'YYYY-MM-DD') FROM vendor_expiry e WHERE e.vendor_id = v.id)
                                 AS insurance_expires_on
    FROM vendor v`;

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

/** Name or phone (any number the vendor answers on, 0057 vendor_phone). */
export async function searchPaymentVendors(q: string | null, trade: string | null, limit = 50): Promise<VendorsResponse> {
  const where: string[] = ['v.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`, q.replace(/\D/g, ''));
    const name = `$${params.length - 1}`;
    const digits = `$${params.length}`;
    where.push(
      `(v.name ILIKE ${name} OR (length(${digits}) >= 3 AND EXISTS (
          SELECT 1 FROM vendor_phone p WHERE p.vendor_id = v.id AND p.digits LIKE '%' || ${digits} || '%')))`,
    );
  }
  if (trade && trade.trim()) {
    params.push(trade.trim());
    where.push(`$${params.length} = ANY(v.trades)`);
  }
  params.push(limit);
  const res = await query<VendorRow>(
    `${SELECT_SQL} WHERE ${where.join(' AND ')} ORDER BY v.name ASC LIMIT $${params.length}`,
    params,
  );
  return { items: res.rows.map(mapVendor), total: res.rows.length };
}

export async function getPaymentVendor(id: string): Promise<Vendor> {
  const res = await query<VendorRow>(`${SELECT_SQL} WHERE v.id = $1`, [id]);
  if (res.rows.length === 0) throw notFound('Vendor not found');
  return mapVendor(res.rows[0]);
}

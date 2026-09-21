// Approval tiers by amount (0047, rule 6.2.3).
//
// A band of money and the roles that may say yes inside it. Three decisions
// ask before they commit — approving a payment request, approving a vendor
// bill, sending a client invoice — and get a 403 whose details name the band
// when the actor's role is outside it. The list rows carry the same answer
// (`tier: {label, allowed}`) so the button can lock with the reason before
// the click, never after.
//
// Configuration, not data: edited from Admin › Settings, no foreign keys, and
// the seed leaves the table alone (the 0012 reasoning).

import {
  APPROVAL_TIER_CODE,
  APPROVAL_TIER_KINDS,
  describeTierBand,
  tierAllows,
  tierFor,
  type ApprovalTier,
  type ApprovalTierInput,
  type ApprovalTierKind,
} from '@theone/shared';
import { query } from '../db.js';
import { ApiError, badRequest, forbidden } from '../errors.js';
import type { ActingPrincipal } from './activity.js';

interface Row {
  id: string;
  kind: string;
  label: string;
  min_amount: string | number;
  max_amount: string | number | null;
  roles: string[] | null;
  position: number;
}

function mapRow(r: Row): ApprovalTier {
  return {
    id: r.id,
    kind: r.kind as ApprovalTierKind,
    label: r.label,
    min_amount: Number(r.min_amount),
    max_amount: r.max_amount === null ? null : Number(r.max_amount),
    roles: r.roles ?? [],
    position: r.position,
  };
}

const SELECT = `SELECT id::text AS id, kind, label, min_amount, max_amount, roles, position
                  FROM approval_tier`;

export async function listApprovalTiers(): Promise<ApprovalTier[]> {
  const res = await query<Row>(`${SELECT} ORDER BY kind, position, min_amount`);
  return res.rows.map(mapRow);
}

/** The band an amount falls in, for one kind — or null when none is set. */
export async function tierForAmount(
  kind: ApprovalTierKind,
  amount: number,
): Promise<ApprovalTier | null> {
  const all = await listApprovalTiers();
  return tierFor(all, kind, amount);
}

/** `{label, allowed}` for a list row, from an already-loaded tier list so a
    queue of 500 rows costs one query, not 500. */
export function tierSummary(
  tiers: ApprovalTier[],
  kind: ApprovalTierKind,
  amount: number,
  actor: ActingPrincipal,
): { label: string; allowed: boolean } | null {
  const t = tierFor(tiers, kind, amount);
  if (!t) return null;
  return { label: t.label, allowed: tierAllows(t, actor.role, actor.isSuperAdmin) };
}

/**
 * Refuse (403) when the amount's band excludes the actor's role. Called
 * AFTER the base permission check, so the message can be about the amount
 * rather than the right to approve at all.
 */
export async function assertTierAllows(
  kind: ApprovalTierKind,
  amount: number,
  actor: ActingPrincipal,
  what: string,
): Promise<ApprovalTier | null> {
  const t = await tierForAmount(kind, amount);
  if (tierAllows(t, actor.role, actor.isSuperAdmin)) return t;
  throw forbidden(`${what} of this amount (${t!.label}) needs one of: ${t!.roles.join(', ')}`, {
    code: APPROVAL_TIER_CODE,
    tier: t!.label,
    roles: t!.roles,
    min_amount: t!.min_amount,
    max_amount: t!.max_amount,
  });
}

// ── Editing the bands (Admin › Settings) ─────────────────────────────────────

function assertInput(input: ApprovalTierInput): void {
  if (!(APPROVAL_TIER_KINDS as readonly string[]).includes(input.kind)) {
    throw badRequest(`Unknown tier kind "${input.kind}"`);
  }
  if (!Number.isFinite(input.min_amount) || input.min_amount < 0) {
    throw badRequest('A tier starts at zero or more');
  }
  if (input.max_amount != null && input.max_amount <= input.min_amount) {
    throw badRequest('A tier must end above where it starts');
  }
}

export async function createApprovalTier(input: ApprovalTierInput): Promise<ApprovalTier> {
  assertInput(input);
  const label = (input.label ?? '').trim() || describeTierBand(input.min_amount, input.max_amount ?? null);
  const res = await query<Row>(
    `INSERT INTO approval_tier (kind, label, min_amount, max_amount, roles, position)
     VALUES ($1, $2, $3, $4, $5::text[],
             COALESCE($6, (SELECT COALESCE(MAX(position), -1) + 1 FROM approval_tier WHERE kind = $1)))
     RETURNING id::text AS id, kind, label, min_amount, max_amount, roles, position`,
    [input.kind, label, input.min_amount, input.max_amount ?? null, input.roles ?? [], input.position ?? null],
  );
  return mapRow(res.rows[0]);
}

export async function updateApprovalTier(
  id: string,
  input: Partial<ApprovalTierInput>,
): Promise<ApprovalTier> {
  const cur = await query<Row>(`${SELECT} WHERE id = $1`, [id]);
  if (!cur.rows[0]) throw new ApiError('NOT_FOUND', 'No such tier');
  const merged: ApprovalTierInput = {
    ...mapRow(cur.rows[0]),
    ...input,
    roles: input.roles ?? mapRow(cur.rows[0]).roles,
  };
  assertInput(merged);
  const res = await query<Row>(
    `UPDATE approval_tier
        SET kind = $2, label = $3, min_amount = $4, max_amount = $5, roles = $6::text[], position = $7
      WHERE id = $1
      RETURNING id::text AS id, kind, label, min_amount, max_amount, roles, position`,
    [
      id,
      merged.kind,
      (merged.label ?? '').trim() || describeTierBand(merged.min_amount, merged.max_amount ?? null),
      merged.min_amount,
      merged.max_amount ?? null,
      merged.roles ?? [],
      merged.position ?? cur.rows[0].position,
    ],
  );
  return mapRow(res.rows[0]);
}

export async function deleteApprovalTier(id: string): Promise<ApprovalTier | null> {
  const res = await query<Row>(
    `DELETE FROM approval_tier WHERE id = $1
     RETURNING id::text AS id, kind, label, min_amount, max_amount, roles, position`,
    [id],
  );
  return res.rows[0] ? mapRow(res.rows[0]) : null;
}

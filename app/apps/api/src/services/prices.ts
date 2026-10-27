// The price list (migration 0101). Vocabulary and the pure lookup live in
// packages/shared/src/prices.ts; this file reads and writes the three tables
// (price_card → price_rate, price_fee) and gives the quote builder its card.
//
// A card is saved whole: its rates and fees are rewritten inside the same
// transaction as the card row, which is locked first so two edits cannot both
// decide what changed against the same before. Every create / change / delete
// is an admin audit row (entity `price_card`) with whole before / after
// snapshots; a save that changed nothing logs nothing (rule 1.2.1).

import {
  PRICES_PERM_KEY,
  priceCardProblems,
  priceCardTitle,
  priceKey,
  resolvePrice,
  type PriceCard,
  type PriceCardInput,
  type PricesResponse,
  type ResolvedPrice,
} from '@theone/shared';
import { query, withTransaction, type Queryable } from '../db.js';
import { ApiError, badRequest, conflict, notFound } from '../errors.js';
import { allowFor, requirePerm } from './permissions.js';
import { logAdminEvent, snapshotsDiffer, type Snapshot } from './adminAudit.js';
import type { ActingPrincipal } from './activity.js';


interface CardRow {
  id: string;
  billing_entity: string;
  client: string | null;
  client_on_file: boolean;
  trip_rate: number | null;
  materials_markup: number | null;
  note: string | null;
  position: number;
  updated_at: string;
}
interface RateRow {
  id: string;
  card_id: string;
  label: string;
  trades: string[];
  tech_rate: number | null;
  helper_rate: number | null;
  afterhours_rate: number | null;
  holiday_rate: number | null;
  trip_rate: number | null;
}
interface FeeRow {
  id: string;
  card_id: string;
  name: string;
  amount: number | null;
  note: string | null;
}

/** 42P01: a database migration 0101 has not reached yet (the code can be
    deployed before the migration is run by hand). */
const notMigrated = (e: unknown): boolean => (e as { code?: string })?.code === '42P01';

const n = (v: number | string | null): number | null => (v === null ? null : Number(v));

async function loadCards(db: Queryable, where = '', params: unknown[] = []): Promise<PriceCard[]> {
  const cards = await db.query<CardRow>(
    `SELECT c.id::text AS id, c.billing_entity, c.client,
            (c.client IS NULL OR EXISTS (
               SELECT 1 FROM client cl WHERE cl.deleted_at IS NULL AND lower(btrim(cl.name)) = lower(btrim(c.client)))) AS client_on_file,
            c.trip_rate::float8 AS trip_rate, c.materials_markup::float8 AS materials_markup,
            c.note, c.position, c.updated_at::text AS updated_at
       FROM price_card c
       ${where}
      ORDER BY upper(c.billing_entity), (c.client IS NOT NULL), c.position, lower(c.client)`,
    params,
  );
  if (cards.rows.length === 0) return [];
  const ids = cards.rows.map((c) => c.id);
  const rates = await db.query<RateRow>(
    `SELECT id::text AS id, card_id::text AS card_id, label, trades,
            tech_rate::float8 AS tech_rate, helper_rate::float8 AS helper_rate,
            afterhours_rate::float8 AS afterhours_rate, holiday_rate::float8 AS holiday_rate,
            trip_rate::float8 AS trip_rate
       FROM price_rate WHERE card_id = ANY($1::uuid[]) ORDER BY position, label`,
    [ids],
  );
  const fees = await db.query<FeeRow>(
    `SELECT id::text AS id, card_id::text AS card_id, name, amount::float8 AS amount, note
       FROM price_fee WHERE card_id = ANY($1::uuid[]) ORDER BY position, name`,
    [ids],
  );
  return cards.rows.map((c) => ({
    id: c.id,
    billing_entity: c.billing_entity,
    client: c.client,
    client_on_file: c.client_on_file === true,
    trip_rate: n(c.trip_rate),
    materials_markup: n(c.materials_markup),
    note: c.note,
    position: Number(c.position),
    updated_at: c.updated_at,
    rates: rates.rows
      .filter((r) => r.card_id === c.id)
      .map((r) => ({
        id: r.id,
        label: r.label,
        trades: r.trades ?? [],
        tech_rate: n(r.tech_rate),
        helper_rate: n(r.helper_rate),
        afterhours_rate: n(r.afterhours_rate),
        holiday_rate: n(r.holiday_rate),
        trip_rate: n(r.trip_rate),
      })),
    fees: fees.rows.filter((f) => f.card_id === c.id).map((f) => ({ id: f.id, name: f.name, amount: n(f.amount), note: f.note })),
  }));
}

/** Options of a dropdown custom field, in the field's own order. */
async function fieldOptions(key: string): Promise<string[]> {
  const res = await query<{ options: unknown }>(`SELECT type_config->'options' AS options FROM field_def WHERE key = $1 LIMIT 1`, [key]);
  const raw = res.rows[0]?.options;
  return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === 'string' && o.trim() !== '') : [];
}

export async function listPrices(actor: ActingPrincipal): Promise<PricesResponse> {
  requirePerm(actor, PRICES_PERM_KEY, 'view', 'You cannot see the price list');
  const allow = allowFor(actor);
  const [cards, comps, trades, clients] = await Promise.all([
    loadCards({ query }).catch((e: unknown) => {
      if (notMigrated(e)) throw new ApiError('CONFLICT', 'The price list is not set up on this server yet (migration 0101 has not been run).', { code: 'PRICES_NOT_MIGRATED' });
      throw e;
    }),
    fieldOptions('21. Comp'),
    fieldOptions('Trade'),
    query<{ name: string }>(`SELECT name FROM client WHERE is_active AND deleted_at IS NULL ORDER BY lower(name)`),
  ]);
  const entities = [...comps];
  for (const c of cards) if (!entities.some((e) => priceKey(e) === priceKey(c.billing_entity))) entities.push(c.billing_entity);
  return {
    cards,
    entities,
    trades,
    clients: clients.rows.map((r) => r.name),
    can: {
      create: allow(PRICES_PERM_KEY, 'create'),
      edit: allow(PRICES_PERM_KEY, 'edit'),
      delete: allow(PRICES_PERM_KEY, 'delete'),
    },
  };
}

function snapshot(c: PriceCard): Snapshot {
  return {
    name: `${c.billing_entity} · ${priceCardTitle(c)}`,
    billing_entity: c.billing_entity,
    client: c.client,
    trip_rate: c.trip_rate,
    materials_markup: c.materials_markup,
    note: c.note,
    rates: c.rates.map(({ id: _id, ...r }) => r),
    fees: c.fees.map(({ id: _id, ...f }) => f),
  };
}

const text = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
};

/** Trimmed, blanks to null, the rows renumbered; refuses what priceCardProblems names. */
function cleanInput(input: PriceCardInput): PriceCardInput {
  const v: PriceCardInput = {
    billing_entity: input.billing_entity.trim().toUpperCase(),
    client: text(input.client),
    trip_rate: input.trip_rate,
    materials_markup: input.materials_markup,
    note: text(input.note),
    rates: input.rates.map((r) => ({
      ...r,
      label: r.label.trim(),
      trades: [...new Set(r.trades.map((t) => t.trim()).filter(Boolean))],
    })),
    fees: input.fees.map((f) => ({ ...f, name: f.name.trim(), note: text(f.note) })),
  };
  const problems = priceCardProblems(v);
  if (problems.length > 0) throw badRequest(problems[0], { code: 'VALIDATION', problems });
  return v;
}

async function assertNoTwin(db: Queryable, v: PriceCardInput, selfId: string | null): Promise<void> {
  const twin = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM price_card
      WHERE upper(btrim(billing_entity)) = upper(btrim($1))
        AND lower(btrim(COALESCE(client, ''))) = lower(btrim(COALESCE($2, '')))
        AND ($3::uuid IS NULL OR id <> $3::uuid)`,
    [v.billing_entity, v.client, selfId],
  );
  if (twin.rows.length > 0) {
    throw conflict(`${v.billing_entity} already has a ${v.client ? `card for ${v.client}` : 'Standard card'} — edit that one.`, { code: 'PRICE_CARD_EXISTS', id: twin.rows[0].id });
  }
}

async function writeLines(db: Queryable, cardId: string, v: PriceCardInput): Promise<void> {
  await db.query(`DELETE FROM price_rate WHERE card_id = $1`, [cardId]);
  await db.query(`DELETE FROM price_fee WHERE card_id = $1`, [cardId]);
  for (const [i, r] of v.rates.entries()) {
    await db.query(
      `INSERT INTO price_rate (card_id, position, label, trades, tech_rate, helper_rate, afterhours_rate, holiday_rate, trip_rate)
       VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9)`,
      [cardId, i, r.label, r.trades, r.tech_rate, r.helper_rate, r.afterhours_rate, r.holiday_rate, r.trip_rate],
    );
  }
  for (const [i, f] of v.fees.entries()) {
    await db.query(`INSERT INTO price_fee (card_id, position, name, amount, note) VALUES ($1, $2, $3, $4, $5)`, [cardId, i, f.name, f.amount, f.note]);
  }
}

async function getCard(id: string): Promise<PriceCard> {
  const found = await loadCards({ query }, `WHERE c.id = $1`, [id]);
  if (!found[0]) throw notFound('No such price card');
  return found[0];
}

export async function createPriceCard(input: PriceCardInput, actor: ActingPrincipal): Promise<PriceCard> {
  requirePerm(actor, PRICES_PERM_KEY, 'create', 'You cannot add to the price list');
  const v = cleanInput(input);
  let id = '';
  await withTransaction(async (tx) => {
    await assertNoTwin(tx, v, null);
    const pos = await tx.query<{ p: number }>(
      `SELECT COALESCE(max(position), -1) + 1 AS p FROM price_card WHERE upper(btrim(billing_entity)) = $1`,
      [v.billing_entity],
    );
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO price_card (billing_entity, client, trip_rate, materials_markup, note, position, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [v.billing_entity, v.client, v.trip_rate, v.materials_markup, v.note, Number(pos.rows[0].p), actor.id],
    );
    id = ins.rows[0].id;
    await writeLines(tx, id, v);
  });
  const created = await getCard(id);
  await logAdminEvent({ actorId: actor.id, entity: 'price_card', entityId: id, action: 'price_card_created', after: snapshot(created) });
  return created;
}

export async function updatePriceCard(id: string, input: PriceCardInput, actor: ActingPrincipal): Promise<PriceCard> {
  requirePerm(actor, PRICES_PERM_KEY, 'edit', 'Only an admin can change the price list');
  const v = cleanInput(input);
  let before: PriceCard | null = null;
  await withTransaction(async (tx) => {
    const locked = await tx.query(`SELECT id FROM price_card WHERE id = $1 FOR UPDATE`, [id]);
    if (locked.rows.length === 0) throw notFound('No such price card');
    before = (await loadCards(tx, `WHERE c.id = $1`, [id]))[0];
    await assertNoTwin(tx, v, id);
    await tx.query(
      `UPDATE price_card
          SET billing_entity = $2, client = $3, trip_rate = $4, materials_markup = $5, note = $6, updated_by = $7
        WHERE id = $1`,
      [id, v.billing_entity, v.client, v.trip_rate, v.materials_markup, v.note, actor.id],
    );
    await writeLines(tx, id, v);
  });
  const saved = await getCard(id);
  const b = snapshot(before!);
  const a = snapshot(saved);
  if (snapshotsDiffer(b, a)) {
    await logAdminEvent({ actorId: actor.id, entity: 'price_card', entityId: id, action: 'price_card_updated', before: b, after: a });
  }
  return saved;
}

export async function deletePriceCard(id: string, actor: ActingPrincipal): Promise<void> {
  requirePerm(actor, PRICES_PERM_KEY, 'delete', 'Only an admin can remove a price card');
  const before = await getCard(id);
  await query(`DELETE FROM price_card WHERE id = $1`, [id]);
  await logAdminEvent({ actorId: actor.id, entity: 'price_card', entityId: id, action: 'price_card_deleted', before: snapshot(before), after: null });
}

/**
 * The price a work order of (entity, client, trade) is charged at, for the
 * quote builder's rate card (`findLaborRate`). Reads only that entity's
 * cards. No permission check: it prices a quote the caller already opened.
 */
export async function priceFor(entity: string | null, client: string | null, trade: string | null): Promise<ResolvedPrice | null> {
  if (!priceKey(entity)) return null;
  try {
    const cards = await loadCards({ query }, `WHERE upper(btrim(c.billing_entity)) = upper(btrim($1))`, [entity]);
    return resolvePrice(cards, entity, client, trade);
  } catch (e) {
    // Before 0101 runs, the quote builder keeps its old rate card.
    if (notMigrated(e)) return null;
    throw e;
  }
}

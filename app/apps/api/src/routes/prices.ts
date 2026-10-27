// Routes: the price list (0101).
//
//   GET    /prices              every card, with the entities, trades and clients to pick from
//   POST   /prices/cards        add a card (prices:create)
//   PUT    /prices/cards/:id    replace a card, its rates and fees included (prices:edit)
//   DELETE /prices/cards/:id    remove a card (prices:delete)
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { createPriceCard, deletePriceCard, listPrices, updatePriceCard } from '../services/prices.js';
import { zMoney } from '../validation.js';

const idParams = z.object({ id: z.string().uuid() });
const money = (label: string) => zMoney(label, 0).nullable();
const text = (max: number) => z.string().max(max).nullable().optional().transform((v) => v ?? null);

const rateSchema = z
  .object({
    label: z.string().max(200),
    trades: z.array(z.string().trim().min(1).max(120)).max(30),
    tech_rate: money('Tech rate'),
    helper_rate: money('Helper rate'),
    afterhours_rate: money('After-hours rate'),
    holiday_rate: money('Holiday rate'),
    trip_rate: money('Trip'),
  })
  .strict();

const feeSchema = z
  .object({
    name: z.string().max(200),
    amount: money('Fee'),
    note: text(300),
  })
  .strict();

const cardSchema = z
  .object({
    billing_entity: z.string().trim().min(1).max(60),
    client: text(200),
    trip_rate: money('Trip'),
    materials_markup: z.number().min(1).max(10).nullable(),
    note: text(2000),
    rates: z.array(rateSchema).max(60),
    fees: z.array(feeSchema).max(80),
  })
  .strict();

export default async function priceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/prices', async (req) => listPrices(actingPrincipalFromRequest(req)));

  app.post('/prices/cards', async (req, reply) => {
    const card = await createPriceCard(parse(cardSchema, req.body), actingPrincipalFromRequest(req));
    return reply.status(201).send({ card });
  });

  app.put('/prices/cards/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    return { card: await updatePriceCard(id, parse(cardSchema, req.body), actingPrincipalFromRequest(req)) };
  });

  app.delete('/prices/cards/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deletePriceCard(id, actingPrincipalFromRequest(req));
    return reply.status(204).send();
  });
}

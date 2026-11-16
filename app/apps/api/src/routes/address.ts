// Routes: address suggestions from Google Maps (0140).
//
//   GET /address/suggest?q=&session=        addresses matching what is typed
//   GET /address/place?place_id=&session=   the full address of the one picked
//   GET /admin/integrations/google-maps     what we asked Google: today, this month, last month
//   PUT /admin/integrations/google-maps/limit   { daily_cap } — the daily limit (0141)
//
// The first two answer anyone who can see work orders or intake drafts (the
// Address box is on Add work order, on a draft and in the work order's field
// editor); they return an address Google knows and read nothing of ours, so
// no scope applies. Both are GETs that change no record. The key never
// leaves the server.
//
// (Registered under the /api prefix in app.ts.)

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ADDRESS_SUGGEST_DAILY_CAP_MAX, ADDRESS_SUGGEST_MAX_CHARS, GOOGLE_PLACE_ID_RE } from '@theone/shared';
import { ApiError, parse } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { googleUsageOverview, pickedAddress, setDailyCap, suggestAddresses } from '../services/addressSuggest.js';
import { allowFor } from '../services/permissions.js';

// A session token is made by the browser, one per typing session (a UUID).
const session = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, 'Bad session');
const suggestQuery = z.object({ q: z.string().max(ADDRESS_SUGGEST_MAX_CHARS), session });
const placeQuery = z.object({ place_id: z.string().regex(GOOGLE_PLACE_ID_RE, 'Bad place'), session });
const limitBody = z.object({ daily_cap: z.number().int().min(0).max(ADDRESS_SUGGEST_DAILY_CAP_MAX) }).strict();

function requireAddressBox(req: FastifyRequest): void {
  const allow = allowFor(actingPrincipalFromRequest(req));
  if (allow('work_orders', 'view') || allow('intake', 'view')) return;
  throw new ApiError('FORBIDDEN', 'Address suggestions are not available to you');
}

export default async function addressRoutes(app: FastifyInstance): Promise<void> {
  app.get('/address/suggest', async (req) => {
    requireAddressBox(req);
    const { q, session: token } = parse(suggestQuery, req.query);
    return suggestAddresses(q, token);
  });

  app.get('/address/place', async (req) => {
    requireAddressBox(req);
    const { place_id, session: token } = parse(placeQuery, req.query);
    return pickedAddress(place_id, token);
  });

  app.get('/admin/integrations/google-maps', async (req) => {
    if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
    // D6 (Wave B): the person being viewed while viewing as them.
    return googleUsageOverview(req.auth.actingAs);
  });

  app.put('/admin/integrations/google-maps/limit', async (req) => {
    if (!req.auth) throw new ApiError('UNAUTHORIZED', 'Sign in to continue');
    return setDailyCap(parse(limitBody, req.body).daily_cap, req.auth.actingAs);
  });
}

// Routes: per-account preferences.
//
//   GET /prefs/:key    → { key, value }   (value null when never set)
//   PUT /prefs/:key    { value } → { ok }
//
// Attributed to req.auth.user — the REAL person, never actingAs (see prefs.ts).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { unauthorized } from '../services/auth.js';
import { getPref, setPref } from '../services/prefs.js';

const keyParams = z.object({ key: z.string().min(1).max(100) });
const putBody = z.object({ value: z.unknown() });

export default async function prefsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/prefs/:key', async (req) => {
    if (!req.auth) throw unauthorized();
    const { key } = parse(keyParams, req.params);
    return { key, value: await getPref(req.auth.user.id, key) };
  });

  app.put('/prefs/:key', async (req) => {
    if (!req.auth) throw unauthorized();
    const { key } = parse(keyParams, req.params);
    const { value } = parse(putBody, req.body);
    await setPref(req.auth.user.id, key, value ?? null);
    return { ok: true };
  });
}

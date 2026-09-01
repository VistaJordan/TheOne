// Routes: the operator-facing side of automations (the admin console owns the
// builder; these serve the work-orders LIST).
//
//   GET  /automations             enabled rules, light shape — the Enroll menu
//   POST /automations/:id/enroll  run one rule over the selected work orders
//
// Enrolling makes the rule WRITE fields, so it takes the same capability as
// the bulk editor (can_edit_wo_fields) — checked on the ACTING principal, like
// every other field write. Reading the list of names is open to any session.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../errors.js';
import { ApiError } from '../errors.js';
import { actingPrincipalFromRequest } from '../services/activity.js';
import { listAutomations, enrollAutomation, ENROLL_CAP } from '../services/automations.js';

const idParams = z.object({ id: z.string().uuid() });

const enrollBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(ENROLL_CAP),
});

export default async function automationsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/automations', async () => {
    const items = (await listAutomations())
      .filter((a) => a.enabled && a.entity === 'work_order')
      .map((a) => ({
        id: a.id,
        name: a.name,
        entity: a.entity,
        trigger: a.trigger,
      }));
    return { items };
  });

  app.post('/automations/:id/enroll', async (req) => {
    const p = actingPrincipalFromRequest(req);
    if (!p.can.editWoFields) {
      throw new ApiError('FORBIDDEN', 'Your role cannot enroll work orders in automations', {
        required_capability: 'can_edit_wo_fields',
      });
    }
    const { id } = parse(idParams, req.params);
    const { ids } = parse(enrollBody, req.body);
    return enrollAutomation(id, ids);
  });
}

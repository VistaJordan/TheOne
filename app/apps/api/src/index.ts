// Fastify bootstrap — The One API (SPRINT1-SPEC §5). Port 5174, all routes /api.
// No CORS in S1: the browser reaches this only via the Vite dev proxy (§5).
// This process is the long-running single-writer holder of PGlite's pgdata (§2).

import Fastify from 'fastify';
import { registerErrorHandler, badRequest } from './errors.js';
import workOrdersRoutes from './routes/workOrders.js';
import statusesRoutes from './routes/statuses.js';
import kpisRoutes from './routes/kpis.js';
import activityRoutes from './routes/activity.js';
import principalsRoutes from './routes/principals.js';
import quoteRoutes from './routes/quotes.js';
import paymentRoutes from './routes/payments.js';

const PORT = 5174;
const HOST = '127.0.0.1';

async function main(): Promise<void> {
  const app = Fastify({ logger: true });

  registerErrorHandler(app);

  // Replaces Fastify's built-in JSON parser with the same behaviour plus the
  // raw text on the request. A malformed body still yields the §5 400 shape.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body: string | Buffer, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      req.rawBody = text;
      if (text.trim() === '') return done(null, undefined);
      try {
        done(null, JSON.parse(text));
      } catch {
        done(badRequest('Body is not valid JSON'), undefined);
      }
    },
  );

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(workOrdersRoutes, { prefix: '/api' });
  await app.register(statusesRoutes, { prefix: '/api' });
  await app.register(kpisRoutes, { prefix: '/api' });
  await app.register(activityRoutes, { prefix: '/api' });
  await app.register(principalsRoutes, { prefix: '/api' });
  await app.register(quoteRoutes, { prefix: '/api' });
  await app.register(paymentRoutes, { prefix: '/api' });

  await app.listen({ port: PORT, host: HOST });
}

main().catch((err) => {
  console.error('API failed to start:', err);
  process.exit(1);
});

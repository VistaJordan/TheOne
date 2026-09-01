// Fastify bootstrap — The One API. All routes under /api.
//
// No CORS: the browser reaches this only through the Vite dev proxy, so every
// request is same-origin. That is also what makes a SameSite=Lax session cookie
// work without any cross-site relaxation.
//
// This process is the long-running single-writer holder of PGlite's pgdata (§2).
//
// ORDER MATTERS BELOW. Cookies must be parsed before the auth guard can read
// one; the guard must be registered before any business route so that no route
// can ever be added and accidentally left unauthenticated.

import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { config, describeAuth } from './config.js';
import { registerErrorHandler, badRequest } from './errors.js';
import authGuard from './plugins/authGuard.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import workOrdersRoutes from './routes/workOrders.js';
import statusesRoutes from './routes/statuses.js';
import kpisRoutes from './routes/kpis.js';
import metricsRoutes from './routes/metrics.js';
import activityRoutes from './routes/activity.js';
import principalsRoutes from './routes/principals.js';
import quoteRoutes from './routes/quotes.js';
import paymentRoutes from './routes/payments.js';
import obligationRoutes from './routes/obligations.js';
import integrationRoutes from './routes/integrations.js';
import viewRoutes from './routes/views.js';
import prefsRoutes from './routes/prefs.js';
import automationsRoutes from './routes/automations.js';
import { startAutomationScheduler } from './services/automations.js';

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

  await app.register(cookie);

  // Liveness only — deliberately says nothing about who is asking.
  app.get('/api/health', async () => ({ ok: true, auth_mode: config.authMode }));

  // 1 · the guard, before anything it protects
  await app.register(authGuard);

  // 2 · sign-in surface (allowlisted inside the guard)
  await app.register(authRoutes, { prefix: '/api' });

  // 3 · everything else — now unreachable without a session
  await app.register(adminRoutes, { prefix: '/api' });
  await app.register(workOrdersRoutes, { prefix: '/api' });
  await app.register(statusesRoutes, { prefix: '/api' });
  await app.register(kpisRoutes, { prefix: '/api' });
  await app.register(metricsRoutes, { prefix: '/api' });
  await app.register(activityRoutes, { prefix: '/api' });
  await app.register(principalsRoutes, { prefix: '/api' });
  await app.register(quoteRoutes, { prefix: '/api' });
  await app.register(paymentRoutes, { prefix: '/api' });
  // S5 · /pulse, /obligations, /notifications. Every handler degrades to an
  // empty payload until migration 0004 has been applied, so registering it
  // cannot break a running API that is still on 0003.
  await app.register(obligationRoutes, { prefix: '/api' });
  // Ecotrak ingestion — manual trigger; the worker polls on the same service.
  await app.register(integrationRoutes, { prefix: '/api' });
  await app.register(viewRoutes, { prefix: '/api' });
  await app.register(prefsRoutes, { prefix: '/api' });
  await app.register(automationsRoutes, { prefix: '/api' });

  await app.listen({ port: config.port, host: config.host });

  // Delayed automations: sweep the DB-backed timer queue (catches anything
  // that came due while the process was down, then polls every 30 s).
  startAutomationScheduler();

  app.log.info(describeAuth());
  if (config.authMode === 'bypass') {
    app.log.warn(
      'DEV BYPASS ACTIVE — anyone who can reach this port can sign in as any user. ' +
        'Set ENTRA_* credentials to switch on Microsoft sign-in.',
    );
  }
}

main().catch((err) => {
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});

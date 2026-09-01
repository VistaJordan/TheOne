// Local dev / server entrypoint — builds the app (see app.ts), binds the
// port, and starts the delayed-automations scheduler. The Vercel deployment
// uses app.ts through its own handler and never runs this file.

import { buildApp } from './app.js';
import { config, describeAuth } from './config.js';
import { startAutomationScheduler } from './services/automations.js';

async function main(): Promise<void> {
  const app = await buildApp();

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

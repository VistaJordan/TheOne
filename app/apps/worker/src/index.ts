// The One — worker process.
//
// The second deployable. It exists because request latency must never be
// hostage to a third-party API, and a crashing adapter must not take down
// dispatch. It owns everything that runs on a clock or against someone else's
// server:
//
//   - the Ecotrak poll (and later, webhook delivery)
//   - the seven obligation clocks
//   - notification fan-out from the outbox
//
// This process could not exist before Phase 1: PGlite is single-writer, so the
// API already held the only connection. It opens its own pool alongside the
// API's — that concurrency is the point.
//
// Jobs are NOT wired yet. This is the runnable skeleton plus the health probe
// that proves two processes hold the database at once.

import { query, closePool, connectionString } from '@theone/db';

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 30_000);

/** Redact the password before anything reaches a log. */
function safeDsn(): string {
  try {
    const u = new URL(connectionString());
    if (u.password) u.password = '***';
    return `${u.protocol}//${u.username ? `${u.username}:${u.password}@` : ''}${u.host}${u.pathname}`;
  } catch {
    return '<unparseable DATABASE_URL>';
  }
}

/**
 * One tick. Reports how many backends are connected, which is the concrete
 * evidence that the API and the worker are both holding the database — the
 * thing PGlite made impossible.
 */
async function tick(): Promise<void> {
  const res = await query<{ backends: number; me: string }>(
    `SELECT count(*)::int AS backends,
            current_setting('application_name') AS me
       FROM pg_stat_activity
      WHERE datname = current_database()`,
  );
  const { backends } = res.rows[0];
  console.log(`[worker] tick — ${backends} backend(s) on this database`);
}

async function main(): Promise<void> {
  console.log(`[worker] starting · ${safeDsn()} · tick ${TICK_MS}ms`);

  await tick(); // fail fast if the database is unreachable
  const timer = setInterval(() => {
    tick().catch((err) => {
      // A failed tick must never kill the worker — the next one retries.
      console.error('[worker] tick failed:', (err as Error).message);
    });
  }, TICK_MS);

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} — draining`);
    clearInterval(timer);
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[worker] failed to start:', err);
  process.exit(1);
});

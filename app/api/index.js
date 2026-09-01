// Vercel serverless entry — every /api/* request lands here (catch-all), and
// Fastify does its own routing exactly as it does locally (all routes are
// registered under the /api prefix, and req.url arrives untouched).
//
// Plain CommonJS on purpose: it requires the esbuild bundle that
// scripts/bundle-api.mjs writes during the Vercel build (see vercel.json),
// so there is no TS compilation or ESM/CJS seam left at runtime.
//
// The instance is built once per warm lambda and reused across invocations;
// `ready` is a promise so concurrent cold-start requests share one build.
// The delayed-automations scheduler (apps/api/src/index.ts) is deliberately
// NOT started here — a setInterval in a lambda dies with the instance.

const { buildApp } = require('./_bundle.cjs');

let ready;

module.exports = async function handler(req, res) {
  ready ??= buildApp().then(async (app) => {
    await app.ready();
    return app;
  });
  const app = await ready;
  app.server.emit('request', req, res);
};

// Bundle the whole API (Fastify app + workspace packages + deps) into ONE
// self-contained CommonJS file the Vercel function can require.
//
// Why: Vercel's per-file TS compilation turns api/*.ts into CJS while the
// workspace packages stay ESM ("type": "module"), and require(ESM) crashes
// the lambda at cold start (ERR_REQUIRE_ESM). One flat CJS bundle has no
// module-format seams and no runtime resolution of workspace TS.
//
// Runs from app/ as part of the Vercel buildCommand (see vercel.json), before
// the function builder picks api/ up. `pg-native` stays external: it is pg's
// optional native binding, guarded by try/catch at runtime.

import { build } from 'esbuild';

await build({
  entryPoints: ['apps/api/src/app.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'api/_bundle.cjs',
  external: ['pg-native'],
  sourcemap: false,
  logLevel: 'info',
});

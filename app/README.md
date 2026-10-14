# The One — Sprint 1 Prototype

Work-order management platform for Seamless FM. This file is the Sprint 1
note, kept for its setup steps; the current map of the system (every module,
the two auth modes, the rules that bite) is `../CLAUDE.md`. Sprint 1 was a
seeded work-orders table backed by Postgres, an app shell in two Seamless FM
brand skins with a day/night theme toggle, and a single write path — changing
a work order's status — that updates the record and appends an entry to the
activity log. Everything that was deferred then (WO detail, vendors, quotes,
financials, auth, dashboards) has since been built.

## Prerequisites

- Node 24 (what CI runs; >= 20 works)
- npm
- Postgres 16 on localhost:5432 with user, password and database `theone`
  (the default URL in `packages/db/src/client.ts`). A native install works and
  is what the main machine runs (it has no Docker); with Docker,
  `docker compose up -d db` starts the one in `docker-compose.yml`. For a
  server of your own, set `DATABASE_URL` in `.env` for the API and the worker
  (`.env.example` has the line) and export it in the shell for
  `npm run setup`, which does not read `.env`.

The database is a real Postgres server reached through node-postgres
(`pg.Pool`, `packages/db/src/client.ts`); on Vercel it is Neon. There is no
embedded database and no `pgdata` directory any more.

## Quickstart

Run these commands from this directory (`app/`) once that Postgres is up
(with Docker, `docker compose up -d db` first):

```
npm install
npm run setup
npm run dev
```

Then open http://localhost:5173.

## npm scripts

- `npm run setup` — runs the DB migrations then seeds the sample data
  (`db:migrate` + `db:seed`). `db:seed` TRUNCATEs the data tables and refuses
  a host that is not localhost unless `ALLOW_SEED=<host>/<database>` is set;
  `db:migrate` records a checksum per file and refuses an applied file that
  changed (`MIGRATE_ALLOW_CHECKSUM_MISMATCH=1` accepts it).
- `npm run dev` — starts the API (:5174), the worker and web (:5173) together
  via `concurrently`. They share the Postgres server, so `setup` can run while
  they are up; re-seeding still wipes local edits.
- `npm run typecheck` — `tsc` over shared, db, api, worker and web.
- `npm test` — the vitest suite under `tests/`; hermetic (`tests/setup.ts`),
  opens no database.

## Repo layout

```
app/
├─ packages/
│  ├─ shared/   @theone/shared — types only (WorkOrder, Status, Kpis…)
│  └─ db/       @theone/db — node-postgres client, migrations, migrate, seed
├─ apps/
│  ├─ api/      @theone/api — Fastify REST API on :5174
│  ├─ worker/   @theone/worker — a second process on the same pool
│  └─ web/      @theone/web — React + Vite front end on :5173
└─ tests/       vitest suite (hermetic; tests/setup.ts)
```

## Known machine note

If `npm install` fails with an `EEXIST` error, the global npm cache on this
machine has NTFS corruption. Retry with a local cache:

```
npm install --cache .npm-cache
```

If it still fails, run `chkdsk` to repair the volume, then retry.

## Full spec

See [docs/SPRINT1-SPEC.md](docs/SPRINT1-SPEC.md) for the complete Sprint 1
specification (stack, schema, seed plan, API contract, and web app spec).

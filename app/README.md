# The One — Sprint 1 Prototype

Work-order management platform for Seamless FM. This is the S1 (skeleton)
prototype: a seeded work-orders table backed by an embedded Postgres database,
an app shell in two Seamless FM brand skins with a day/night theme toggle, and a
single write path — changing a work order's status — that updates the record and
appends an entry to the activity log. Everything else (WO detail, vendors,
quotes, financials, auth, dashboards) is deferred to later sprints.

## Prerequisites

- Node >= 20
- npm

Nothing else. No Docker, no external database, no cloud services. The database is
PGlite (embedded Postgres 16, WASM) persisted to the local filesystem.

## Quickstart

Run these three commands from this directory (`app/`):

```
npm install
npm run setup
npm run dev
```

Then open http://localhost:5173.

## npm scripts

- `npm run setup` — runs the DB migrations then seeds real data
  (`db:migrate` + `db:seed`). Short-lived; opens the DB, writes, and exits.
- `npm run dev` — starts the API (:5174) and web (:5173) together via
  `concurrently`. The API holds the DB; do not run `setup`/seed while it is up.

## Repo layout

```
app/
├─ packages/
│  ├─ shared/   @theone/shared — types only (WorkOrder, Status, Kpis…)
│  └─ db/       @theone/db — PGlite client, migrations, seed
└─ apps/
   ├─ api/      @theone/api — Fastify REST API on :5174
   └─ web/      @theone/web — React + Vite front end on :5173
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

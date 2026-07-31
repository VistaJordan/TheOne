# The One — Sprint 1 Build Specification

**Sprint:** S1 (R0 · Prototype · Skeleton) · **Date:** 2026-07-29 · **Owner:** Jordan Brown (jordan@seamlessfm.com)
**App root:** `c:/Users/JordanBrown/Downloads/The One/app`

## S1 scope (do not exceed)

Project skeleton: schema + seed with real data, app shell in both brand skins with a working theme toggle, a work-orders **table** page, and **one write path** — change a WO's status — that lands in the activity log.

**S1 exit criterion:** *a seeded WO shows in a table view and every edit lands in the activity log.*

Everything past this (WO detail page, phase bar, intake, vendors module, quotes, financial tab, filters UI beyond status, dashboards, auth/RBAC, automations, outbox/notifications, attachments upload, Ecotrak) is **out of scope for S1** — S2+ per the roadmap. The schema below still *provisions* the Phase-0-critical entities (`vendor`, `payable`, `client_visible`, `activity_log`, `principal` with service accounts, `field_def`, membership) because **the schema is the contract that survives the rebuild; the UI is disposable.**

---

## 1. Stack decisions

| Layer | Choice | One-line rationale |
|---|---|---|
| Database | **PGlite** (`@electric-sql/pglite`, embedded Postgres 16 WASM, filesystem-persisted) | Real Postgres dialect and semantics with **no Docker / no cloud** on Windows; the schema that survives the rebuild is written in genuine Postgres SQL, not SQLite dialect. |
| DB access | **Plain SQL** via a thin `query()` helper over the PGlite client | Boring, AI-legible, zero ORM lock-in; migrations are raw `.sql` files that a real Postgres will run verbatim at rebuild time. |
| Migrations | Ordered `migrations/NNNN_*.sql`, each passed **whole** to `db.exec()` (never semicolon-split) | Postgres-compatible DDL is the contract; keep it inspectable and portable. PGlite's `exec()` runs a multi-statement script including dollar-quoted `plpgsql` bodies in one call. |
| TS execution | **`tsx`** (esbuild-based) is the canonical runner for every `.ts` entrypoint (migrate/seed/api) | Plain `node` refuses to strip types for files under `node_modules/` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) — fatal because workspaces symlink `@theone/db`/`@theone/shared` into `node_modules/@theone/`. `tsx` transpiles workspace `.ts` source on import; raw `.ts` stays the source of truth (no build step). Web is unaffected (Vite/esbuild). |
| API framework | **Fastify** (TypeScript) + **Zod** at every request boundary | Fast, first-class TS, JSON in/out, trivial to reason about; REST is the simplest edge for a prototype (no tRPC needed per task). |
| Frontend | **React 18 + Vite + TypeScript**, **@tanstack/react-query** for fetching | Matches the locked house stack; Vite dev proxy removes CORS; React Query gives cache + refetch-on-mutate for the status write. |
| Styling | **Plain CSS with custom-property design tokens.** NO Tailwind, NO component library, NO CSS-in-JS. | Tokens are the brand contract; two themes are two token blocks toggled by `data-theme`. Component libraries would fight the exact Seamless FM skins. |
| Types | **`@theone/shared`** package (types-only, authored by Agent A) | One source of truth for `WorkOrder`, `Status`, `Kpis`, error shapes, and the status-group map; consumed **read-only** by API and web. Web never imports the DB runtime (keeps PGlite/WASM out of the browser bundle). |
| Local Postgres upgrade path | `docker-compose.yml` (Postgres 16) committed but **unused** | Same migrations run against it later; upgrade is a connection-string swap, not a rewrite. |
| Monorepo | **npm workspaces** (npm 11, Node 24) | No pnpm/yarn; native to the environment. |

**Deliberately deferred to later sprints (not built in S1):** outbox/event stream, pg-boss worker, WS/SSE realtime, FTS/`pg_trgm`, ACL enforcement, formula engine, automations, Drizzle/Kysely (raw SQL is enough for one write path).

---

## 2. Repository layout & agent ownership

Three build agents work in parallel with **disjoint file ownership**. The only shared artifact is `@theone/shared` (types), authored by **A** and imported **read-only** by **B** and **C**.

```
app/
├─ package.json                 # npm workspaces root, root scripts (A)
├─ tsconfig.base.json           # shared compiler options (A)
├─ .gitignore                   # (A) — see §9
├─ .env.example                 # (A)
├─ docker-compose.yml           # Postgres 16, unused upgrade path (A)
├─ docs/
│  └─ SPRINT1-SPEC.md           # this file
├─ packages/
│  ├─ shared/                   # ── AGENT A (types only; B & C read-only) ──
│  │  ├─ package.json           #    name: @theone/shared
│  │  └─ src/index.ts           #    WorkOrder, Status, Kpis, ApiError, StatusGroup, STATUS_GROUP_BY_TYPE
│  └─ db/                       # ── AGENT A ──
│     ├─ package.json           #    name: @theone/db
│     ├─ src/
│     │  ├─ client.ts           #    opens PGlite at ABSOLUTE ../pgdata (module-relative), exports query()/getDb()
│     │  ├─ migrate.ts          #    exec()s each migrations/*.sql WHOLE, in filename order (no split)
│     │  └─ seed.ts             #    loads seed/clickup-data.json → rows
│     ├─ scripts/
│     │  └─ check-contrast.ts    #    objective ≥4.5:1 gate for pills + --ink-3 (§7), run via tsx
│     ├─ migrations/
│     │  └─ 0001_init.sql       #    full DDL (§3)
│     ├─ seed/
│     │  └─ clickup-data.json   #    COPIED from mockup/design/clickup-data.json
│     └─ pgdata/                #    PGlite data dir (gitignored)
└─ apps/
   ├─ api/                      # ── AGENT B ──
   │  ├─ package.json           #    depends on @theone/db, @theone/shared
   │  └─ src/
   │     ├─ index.ts            #    Fastify bootstrap, port 5174
   │     ├─ db.ts               #    re-exports query() from @theone/db
   │     ├─ errors.ts           #    ApiError → { error: {...} }
   │     ├─ routes/
   │     │  ├─ workOrders.ts
   │     │  ├─ statuses.ts
   │     │  ├─ kpis.ts
   │     │  └─ activity.ts
   │     └─ services/
   │        ├─ workOrders.ts
   │        ├─ kpis.ts
   │        └─ activity.ts
   └─ web/                      # ── AGENT C ──
      ├─ package.json           #    depends on @theone/shared ONLY
      ├─ index.html
      ├─ vite.config.ts         #    dev server 5173, proxy /api → 5174
      ├─ public/
      │  ├─ fonts/              #    4 copied .woff2 (see §6)
      │  └─ brand/              #    logo-black.png, logo-white.png, mascot.png
      └─ src/
         ├─ main.tsx
         ├─ App.tsx
         ├─ api/client.ts       #    typed fetch wrappers over /api
         ├─ theme/
         │  ├─ tokens.css       #    :root[data-theme="night"|"day"] token blocks (§6)
         │  ├─ fonts.css        #    @font-face
         │  ├─ ThemeProvider.tsx
         │  └─ ThemeToggle.tsx
         ├─ pages/
         │  └─ WorkOrdersPage.tsx
         ├─ components/
         │  ├─ AppShell.tsx
         │  ├─ KpiRow.tsx
         │  ├─ WorkOrdersTable.tsx
         │  ├─ StatusPill.tsx
         │  └─ StatusChangeMenu.tsx
         └─ styles/app.css
```

### Ownership boundaries (hard rules)

- **Agent A (Foundation/DB)** owns: root config files (`package.json`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`), `packages/shared/**`, `packages/db/**`. A publishes the **only** writable copy of shared types. A must NOT touch `apps/**`.
- **Agent B (API)** owns: `apps/api/**`. B imports `@theone/db` (runtime) and `@theone/shared` (types) read-only. B must NOT edit `packages/**` or `apps/web/**`, and must NOT redefine shared types locally.
- **Agent C (Web)** owns: `apps/web/**`. C imports `@theone/shared` (types) read-only and talks to the API over HTTP (`/api/*` via Vite proxy). C must NOT import `@theone/db` (keeps PGlite/WASM out of the browser bundle) and must NOT edit `packages/**` or `apps/api/**`.
- If B or C believe a shared type must change, they file it for A; they do not edit `packages/shared`.

### Root scripts (`app/package.json`)

```jsonc
{
  "private": true,
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "db:migrate": "npm -w @theone/db run migrate",
    "db:seed":    "npm -w @theone/db run seed",
    "setup":      "npm run db:migrate && npm run db:seed",
    "dev:api":    "npm -w @theone/api run dev",
    "dev:web":    "npm -w @theone/web run dev",
    "dev":        "concurrently -n api,web -c cyan,magenta \"npm run dev:api\" \"npm run dev:web\""
  },
  "devDependencies": { "concurrently": "^9", "tsx": "^4", "typescript": "^5.6" }
}
```

**TS execution — the canonical runner is `tsx` (root devDependency).** Plain `node` cannot run these `.ts` entrypoints: it hard-refuses type-stripping for any file under `node_modules/` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and npm workspaces symlink `@theone/db`/`@theone/shared` into `node_modules/@theone/`, so a bare import of them resolves to `.ts` source and fails under plain `node`. The workspace scripts therefore invoke `tsx`, not `node`:

```jsonc
// packages/db/package.json
"scripts": { "migrate": "tsx src/migrate.ts", "seed": "tsx src/seed.ts" }
// apps/api/package.json
"scripts": { "dev": "tsx watch src/index.ts" }
```

`tsx` (esbuild) transpiles the workspace `.ts` source on import — no build step, raw `.ts` stays the source of truth. `apps/web` is unaffected (Vite/esbuild already handles TS). Never invoke these entrypoints with plain `node`; use `tsx` (or `npx tsx`) for any ad-hoc script that imports `@theone/db`.

**PGlite single-writer constraint (important):** PGlite persists to one filesystem dir and allows **one process at a time**. `migrate`/`seed` are short-lived processes that open, write, and exit; the long-running holder is the API. Workflow is therefore always: `npm install` → `npm run setup` (migrate+seed, exits) → `npm run dev` (API opens `pgdata`, web starts). Never run `db:seed` while the API is up.

---

## 3. Full DDL — `packages/db/migrations/0001_init.sql`

Postgres-16-compatible. Adjacency (`parent_id`) only — no `ltree`, no extensions beyond built-ins (`gen_random_uuid()` is core since PG13; `plpgsql` ships with PGlite).

```sql
-- ============ ENUMS ============
CREATE TYPE container_kind AS ENUM ('workspace','space','folder','list');
CREATE TYPE status_group   AS ENUM ('open','active','done','closed');
CREATE TYPE principal_kind AS ENUM ('human','service');
CREATE TYPE payable_status AS ENUM ('pending','approved','paid');
CREATE TYPE field_type AS ENUM (
  'checkbox','short_text','long_text','dropdown','date','users',
  'formula','currency','attachment','location','rating','url','number'
);  -- 13 types, all in real use

-- ============ updated_at helper ============
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

-- ============ HIERARCHY (workspace → space → folder → list) ============
-- One polymorphic table; kind discriminates the four levels; parent_id is the adjacency edge.
CREATE TABLE container (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       container_kind NOT NULL,
  parent_id  uuid REFERENCES container(id),
  name       text NOT NULL,
  ext_ref    text,                 -- original ClickUp list/folder name for traceability
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX container_parent_idx ON container(parent_id);
CREATE INDEX container_kind_idx   ON container(kind);
CREATE TRIGGER container_touch BEFORE UPDATE ON container
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ PRINCIPALS (humans + service accounts) ============
CREATE TABLE principal (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind           principal_kind NOT NULL,
  display_name   text NOT NULL,
  email          text,
  role           text,             -- free-text role code (admin/member/owner/OM/AM/TL…) in v0
  initials       text,
  api_token_hash text,             -- for service accounts (hashed); NULL for humans
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER principal_touch BEFORE UPDATE ON principal
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ STATUS SETS & STATUSES ============
CREATE TABLE status_set (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id uuid NOT NULL REFERENCES container(id),  -- attaches at space (or any node) — inheritance resolved app-side later
  name         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER status_set_touch BEFORE UPDATE ON status_set
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE status (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status_set_id uuid NOT NULL REFERENCES status_set(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status_group  status_group NOT NULL,     -- open/active/done/closed drives filters & KPIs
  color         text NOT NULL,             -- real ClickUp hex, e.g. '#ff3f48'
  position      int  NOT NULL,             -- pipeline order 0..n
  is_archive    boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (status_set_id, name)
);
CREATE INDEX status_group_idx ON status(status_group);
CREATE TRIGGER status_touch BEFORE UPDATE ON status
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ FIELD DEFINITIONS (custom-field engine) ============
CREATE TABLE field_def (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  container_id uuid NOT NULL REFERENCES container(id),   -- shared across the container's lists
  key          text NOT NULL,          -- key used inside task.fields JSONB (= original ClickUp field name, verbatim)
  label        text NOT NULL,          -- human label (same as key in v0, e.g. '16. Client NTE 🔴')
  type         field_type NOT NULL,
  type_config  jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {"options":[...]} for dropdowns, {"formula":true} etc
  position     int,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (container_id, key)
);
CREATE TRIGGER field_def_touch BEFORE UPDATE ON field_def
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ TASK (Work Order) — flat record ============
CREATE TABLE task (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wo_number      text NOT NULL UNIQUE,        -- 'WO-39403'
  ext_name       text,                        -- client's WO name/number, e.g. 'WOT0452814'
  title          text NOT NULL,               -- first meaningful line of description
  description    text,
  home_list_id   uuid REFERENCES container(id),
  status_id      uuid NOT NULL REFERENCES status(id),
  status_group   status_group NOT NULL,       -- denormalized from status for fast filtering
  -- promoted hot columns (mirror of task.fields, written by the service layer on every write):
  billing_entity text,                        -- fields '21. Comp'
  client         text,                        -- fields 'Client'
  trade          text,                        -- fields 'Trade'
  city           text,                        -- fields 'City'
  state          text,                        -- fields 'State'
  nte            numeric(12,2),               -- fields '16. Client NTE 🔴'
  date_received  date,                        -- fields 'Date-Time Received'
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- full custom-field bag, keyed by field_def.key
  parent_task_id uuid REFERENCES task(id),    -- future subtasks; unused in v1 (schema-ready)
  priority       text,                        -- 'urgent'|'high'|'normal'|'low'|null
  deleted_at     timestamptz,                 -- soft delete
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX task_status_idx        ON task(status_id);
CREATE INDEX task_status_group_idx  ON task(status_group);
CREATE INDEX task_home_list_idx     ON task(home_list_id);
CREATE INDEX task_client_idx        ON task(client);
CREATE INDEX task_trade_idx         ON task(trade);
CREATE INDEX task_state_idx         ON task(state);
CREATE INDEX task_date_received_idx ON task(date_received);
CREATE INDEX task_fields_gin        ON task USING gin (fields);   -- drop if a PGlite build lacks GIN; small data tolerates it
CREATE TRIGGER task_touch BEFORE UPDATE ON task
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ TASK ↔ LIST MEMBERSHIP (routing; multi-home) ============
CREATE TABLE task_list_membership (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  list_id    uuid NOT NULL REFERENCES container(id),
  is_home    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, list_id)
);
-- exactly one home list per task:
CREATE UNIQUE INDEX one_home_list_per_task ON task_list_membership(task_id) WHERE is_home;
-- NOTE: task.home_list_id is a DENORMALIZED MIRROR of this task's is_home membership row; the
-- service/seed layer keeps the two consistent on every write. "At least one home" is APP-ENFORCED,
-- not DB-enforced: the partial unique index above guarantees at-most-one home, never at-least-one.

-- ============ ACTIVITY LOG (append-only, every mutation attributed) ============
CREATE TABLE activity_log (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_principal_id uuid NOT NULL REFERENCES principal(id),
  entity_type        text NOT NULL,        -- 'task'
  entity_id          uuid NOT NULL,
  action             text NOT NULL,        -- 'created' | 'status_changed' | 'field_updated' | 'routed'
  field              text,                 -- e.g. 'status_id'
  before             jsonb,
  after              jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_entity_idx ON activity_log(entity_type, entity_id, created_at DESC);
-- Append-only by convention: application never issues UPDATE or DELETE on this table.

-- ============ COMMENT / UPDATE (client-visibility boundary) ============
CREATE TABLE comment (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id             uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  author_principal_id uuid NOT NULL REFERENCES principal(id),
  body                text NOT NULL,
  client_visible      boolean NOT NULL DEFAULT false,   -- Phase-0 schema commitment
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_task_idx ON comment(task_id);
CREATE TRIGGER comment_touch BEFORE UPDATE ON comment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ VENDOR (minimal — external subcontractors) ============
CREATE TABLE vendor (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  trades     text[] NOT NULL DEFAULT '{}',
  phone      text,
  city       text,
  state      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER vendor_touch BEFORE UPDATE ON vendor
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ PAYABLE (stub — tech payment tied to WO + vendor) ============
CREATE TABLE payable (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    uuid NOT NULL REFERENCES task(id),
  vendor_id  uuid REFERENCES vendor(id),
  amount     numeric(12,2) NOT NULL DEFAULT 0,
  status     payable_status NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payable_task_idx ON payable(task_id);
CREATE TRIGGER payable_touch BEFORE UPDATE ON payable
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============ ATTACHMENT (stub — local disk in v0) ============
CREATE TABLE attachment (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        uuid REFERENCES task(id) ON DELETE CASCADE,
  comment_id     uuid REFERENCES comment(id) ON DELETE CASCADE,
  file_name      text NOT NULL,
  storage_key    text,                 -- local path in v0 → object-store key later
  content_type   text,
  byte_size      bigint,
  client_visible boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachment_task_idx ON attachment(task_id);
CREATE TRIGGER attachment_touch BEFORE UPDATE ON attachment
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
```

**Notes for the rebuild:** promoted columns are plain writable columns (not `GENERATED`) in v0 so the single write path stays trivial; the service layer keeps them in sync with `fields`. The production rebuild may convert them to `GENERATED ALWAYS AS (...) STORED` off `fields`. Keeping them plain now avoids JSONB-immutability friction and lets the seed populate them directly.

**DECISION (client-visibility carrier):** client-visible updates are always modeled as `comment` rows (`comment.client_visible`); `activity_log` remains a pure internal audit trail and never carries client visibility. The future outbound client-CMMS sync reads `client_visible` comments, never `activity_log`. *(Also recorded in §10.)*

---

## 4. Seed plan — `packages/db/src/seed.ts`

**Source:** copy `mockup/design/clickup-data.json` → `packages/db/seed/clickup-data.json` (Agent A copies it; the seed reads the copy so the app is self-contained).
**Run:** `npm run db:seed` (root) → `npm -w @theone/db run seed`. Idempotent: it `TRUNCATE`s app tables (RESTART IDENTITY CASCADE) then inserts, so re-seeding is safe.

### 4.1 Hierarchy (containers)
- 1 `workspace`: **"Seamless FM"**.
- 1 `space`: **"Vista Operations"** (parent = workspace). The `status_set` and `field_def` rows attach here.
- Folders from `routing[]`: **"Active"**, **"✅ Finished WOs"**, **"SFM"** (parent = space).
- Lists: insert **every** list under each folder from `routing[].lists[]` (name + `ext_ref`), including zero-task lists — cheap, and it makes every WO's `home_list_id` and every membership FK resolve. (~50 list rows; the per-person "Active" lists are the OM/dispatcher **books**, per lifecycle §Product-insight #1.)

### 4.2 Statuses (`status_set` "Vista WO Pipeline" + statuses)
Insert **all 19** statuses from `statuses[]` with their **real colors and order**. Map ClickUp `type` → our `status_group`:

| ClickUp `type` | `status_group` |
|---|---|
| `open` | `open` |
| `custom` | `active` |
| `done` | `done` |
| `closed` | `closed` |

Resulting rows (name → group, color, position):

| # | name | group | color |
|---|---|---|---|
|0|Open|open|#ff3f48|
|1|emergency|active|#ff3f48|
|2|waiting for quote|active|#ff3f48|
|3|approved|active|#ee5e99|
|4|return trip needed|active|#ff3f48|
|5|assessment ongoing|active|#f8ae00|
|6|job ongoing|active|#f8ae00|
|7|assessment scheduled|active|#ee5e99|
|8|job scheduled|active|#ee5e99|
|9|pm scheduled|active|#b660e0|
|10|quote ready|active|#4466ff|
|11|please order parts|active|#b660e0|
|12|waiting for parts|active|#aa8d80|
|13|!! waiting for advice|active|#1090e0|
|14|!! waiting for approval|active|#0f9d9f|
|15|<< invoiced not paid >>|active|#656f7d|
|16|!! ready to invoice|done|#6bed5e|
|17|done/incurred|done|#64c6a2|
|18|!! canceled/postponed|closed|#008844|

Plus **one archive terminal status** `invoiced` (group `done`, `is_archive=true`, color `#656f7d`) — 6 of the 28 sample WOs carry status `"invoiced"` (they live in the archive **"Invoiced"** list) and it is not one of the 19 pipeline statuses. Seeding it as a 20th, flagged `is_archive`, keeps the 19 pristine while letting real data map cleanly. *(Open question §10 — confirm treatment.)*

**Status-name normalization for sample rows:** the seed maps each WO's `status` string to a status via exact match, with a small alias map for the two non-canonical strings in the samples: `"!! approved" → "approved"`, `"invoiced" → "invoiced"` (the archive status above).

### 4.3 Field definitions
Insert one `field_def` per entry in `fields[]` (container = "Vista Operations" space). Map ClickUp field types → `field_type`:
`attachment→attachment`, `checkbox→checkbox`, `drop_down→dropdown`, `short_text→short_text`, `text→long_text`, `date→date`, `users→users`, `formula→formula`, `number→number`, `currency→currency`, `location→location`, `url→url`, `emoji→rating`. For dropdowns, store `{"options":[...]}` in `type_config`; for formulas, `{"formula":true}`. `key` = `label` = the field's original name verbatim (e.g. `"16. Client NTE 🔴"`), so `task.fields` can be copied straight from the JSON with no key rewriting.

### 4.4 Tasks (the 28 real WOs)
Insert all 28 from `taskSamples[]`. For each:
- `wo_number` = `id` (`"WO-39403"`), `ext_name` = `name`, `priority` = `priority`.
- `description` = `fields["35. WO Description"]`; `title` = first non-empty line of it (truncated ~120 chars), fallback to `ext_name`.
- `status_id` via the normalized status name; `status_group` copied from that status.
- `home_list_id` = the list whose name = the WO's `list` field.
- `fields` = the entire `fields` object copied verbatim (JSONB).
- **Promoted columns** extracted from `fields`: `billing_entity`←`"21. Comp"`, `client`←`"Client"`, `trade`←`"Trade"`, `city`←`"City"`, `state`←`"State"`, `nte`←`"16. Client NTE 🔴"` (numeric), `date_received`←`"Date-Time Received"` (date). `created_at` = `created` date.

The 28 WO ids: WO-39403, WO-38787, WO-38893, WO-41061, WO-41066, WO-40801, WO-40656, WO-37597, WO-37579, WO-41027, WO-40782, WO-40356, WO-36500, WO-40970, WO-40845, WO-40611, WO-40374, WO-40172, WO-40818, WO-40379, WO-40127, WO-41037, WO-40668, WO-40947, WO-40948, WO-40652, WO-41017, WO-40999.

### 4.5 Memberships
One `task_list_membership` per WO: `(task_id, home_list_id, is_home=true)`. (Multi-home is schema-ready but S1 seeds only the home row.)

### 4.6 Principals (~22 humans + 2 service accounts)
Insert all people from `people[]` as `principal(kind='human')` with `display_name`, `initials`, `role` (their ClickUp role: owner/admin/member), `email` = `slug(name)+entry.email` (e.g. `peter.hope@byblosvista.com`). Plus **2 service accounts** (`kind='service'`): **"Seed Bot"** (`role='service'`, used as the actor for seeded `created` activity rows) and **"n8n Automation"** (provisioned for the future automation layer). Designate **Jordan Brown** (admin) as the default human actor for API writes when no actor header is supplied.

### 4.7 Vendors (5–8 synthesized from technicians named in the data)
The `assignees` on WOs are internal OM/dispatcher **books**, not techs — the actual external technicians appear in the `"20. Last Update"` free text. Synthesize vendors from those:

| name | trades | phone | city | state |
|---|---|---|---|---|
| Eon Electric | {Electric} | (801) 615-1560 | Provo | UT |
| AAA Plumbing | {Plumbing} | — | San Antonio | TX |
| O5 Plumbing | {Plumbing} | (210) 899-2474 | San Antonio | TX |
| Don's Electrical & Handyman Service | {Electric,Handyman} | — | Mankato | MN |
| Nick Handyman | {Handyman} | — | Medford | MA |
| Seeder and Son | {Handyman,Roofing} | — | Saint Louis | MO |
| Electrical Services LLC | {Electric} | — | Mankato | MN |
| Amigo Appliance | {Appliance} | — | Manteca | CA |

### 4.8 Payables (stub — a handful)
For ~6 WOs whose status is `done/incurred`/`invoiced` and `"34. Cost" > 0`, insert a `payable(task_id, vendor_id=<any synthesized vendor>, amount="34. Cost", status='approved'|'paid')`. Enough to prove the FK path; not a real matching.

### 4.9 Seeded activity
For each of the 28 WOs, write one `activity_log` row: `action='created'`, `actor=Seed Bot`, `after={status_id, status_name}`. This guarantees the log is non-empty on first load and demonstrates service-account attribution; the S1 write path then appends `status_changed` rows on top.

---

## 5. API contract (REST)

- **Base:** `http://localhost:5174`, all routes under `/api`. JSON in/out.
- **CORS decision:** **Vite dev proxy** (`/api` → `:5174`), so the browser only ever calls same-origin `/api/*` and **no CORS is needed**. `@fastify/cors` is left out in S1 (add it only if a non-proxied client appears).
- **Actor:** no auth in S1. The API resolves the acting principal from an optional `X-Actor-Id` header, falling back to the seeded **Jordan Brown** admin principal. Every write is attributed in `activity_log`.
- **Error shape (all non-2xx):**
  ```json
  { "error": { "code": "NOT_FOUND", "message": "Work order not found", "details": null } }
  ```
  Codes: `BAD_REQUEST` (400, Zod failure → `details` holds issues), `NOT_FOUND` (404), `INTERNAL` (500).

### GET `/api/work-orders`
List with filters. Query (all optional): `status_group` (`open|active|done|closed`), `status_id` (uuid), `search` (matches `wo_number`, `ext_name`, `client`, `city` case-insensitively), `limit` (default 50, max 200), `offset` (default 0). Excludes soft-deleted.
```json
{
  "items": [
    { "id":"…","wo_number":"WO-39403","ext_name":"WOT0452814",
      "title":"Standing freezer not holding temperature",
      "client":"7-Eleven","city":"GALVESTON","state":"TX","trade":"Refrigeration",
      "billing_entity":"SFM","nte":3202.00,"priority":"high",
      "date_received":"2026-06-25","home_list":"Matt Hammond",
      "status":{ "id":"…","name":"<< invoiced not paid >>","group":"active","color":"#656f7d" },
      "age_days":34 }
  ],
  "total": 28, "limit": 50, "offset": 0
}
```
`age_days` computed in SQL: `(now()::date - date_received)`.

### GET `/api/work-orders/:id`
Detail (by `id` uuid **or** `wo_number`), including memberships and recent activity.
```json
{
  "id":"…","wo_number":"WO-39403","ext_name":"WOT0452814","title":"…","description":"…",
  "client":"7-Eleven","city":"GALVESTON","state":"TX","trade":"Refrigeration",
  "billing_entity":"SFM","nte":3202.00,"priority":"high","date_received":"2026-06-25",
  "status":{ "id":"…","name":"…","group":"active","color":"#656f7d" },
  "fields":{ "…": "… full JSONB bag …" },
  "memberships":[ { "list_id":"…","list_name":"Matt Hammond","is_home":true } ],
  "recent_activity":[
    { "id":42,"action":"status_changed","field":"status_id",
      "before":{"status_name":"done/incurred"},"after":{"status_name":"<< invoiced not paid >>"},
      "actor":{"id":"…","display_name":"Jordan Brown"},"created_at":"2026-07-29T12:00:00Z" }
  ]
}
```

### PATCH `/api/work-orders/:id/status` — the S1 write path
Body: `{ "status_id": "<uuid>" }` (Zod-validated; 400 if absent/unknown, 404 if WO missing). In **one transaction**: read current `status_id`; if changed, `UPDATE task SET status_id, status_group, updated_at`; `INSERT` an `activity_log` row (`action='status_changed'`, `field='status_id'`, `before/after = {status_id, status_name}`, actor from header/default). Returns the updated detail object (same shape as GET `/:id`). No-op change (same status) returns 200 without writing a log row.

### GET `/api/statuses`
```json
[ { "id":"…","name":"Open","group":"open","color":"#ff3f48","position":0,"is_archive":false }, … ]
```
Ordered by `position`. Feeds the StatusChangeMenu and pill colors.

### GET `/api/kpis`
Computed live from the DB (not hard-coded). **The JSON below illustrates the response _shape_ only — the numbers are placeholders, not the seed-derived counts (which the endpoint computes live).**
```json
{
  "active":         { "count": 3 },
  "waitingApproval":{ "count": 1, "oldestAgeDays": 22 },
  "readyToInvoice": { "count": 1, "queuedAmount": 0.01 },
  "margin":         { "pct": 44.7, "avgProfit": 271, "placeholder": true }
}
```
- `active.count` = tasks where `status_group IN ('open','active')`.
- `waitingApproval` = tasks where status name = `!! waiting for approval`; `oldestAgeDays` = `max(now()::date - date_received)`.
- `readyToInvoice` = tasks where status name = `!! ready to invoice`; `queuedAmount` = `sum(nte)`.
- `margin` = if invoiced WOs present, `sum(total_invoiced - cost)/sum(total_invoiced)` from `fields`; else fall back to the `aggregates.invoicedSample` numbers (44.7% / $271) with `placeholder:true`.

### GET `/api/activity?wo=:id`
`wo` = task uuid or `wo_number`. Returns that WO's activity newest-first (`limit` default 50):
```json
[ { "id":42,"action":"status_changed","field":"status_id",
    "before":{…},"after":{…},
    "actor":{"id":"…","display_name":"Jordan Brown","kind":"human"},
    "created_at":"2026-07-29T12:00:00Z" } ]
```

---

## 6. Web app spec

### Routes
- `/` → **Work Orders** page (the only S1 route). React Router is included with this single route so S2 can add `/work-orders/:id`, `/vendors`, etc., without refactoring the shell. Sidebar nav items other than "Work Orders" render but are inert (no-op) in S1.

### Component list
- **AppShell** — the black-topbar + themed-sidebar chrome from the chosen skins: left sidebar (logo, nav items Dashboard / Work Orders (active, badge = total) / Vendors / Quotes / Invoicing / Admin, user chip at bottom) and a **black** topbar (search field, "New Work Order" button [inert in S1], notification bell, and the **ThemeToggle**). Children render in the light/dark work canvas.
- **ThemeToggle** — sun/moon button; flips `data-theme` between `day`/`night`, persists to `localStorage`.
- **KpiRow** — four KPI cards from `GET /api/kpis`: Active WOs · Waiting approval (`hot` styling, shows oldest age) · Ready to invoice (shows queued $) · Margin (30d, placeholder). Cards use `--kpi-font/--kpi-weight/--kpi-ls`.
- **WorkOrdersTable** — columns: WO # (mono) · Client / Site (client bold, `city, state · ext_name` sub) · Trade · Status (**StatusPill**, opens **StatusChangeMenu**) · NTE (right-aligned, tabular) · Home list (OM/book) · Age. Fetched via `GET /api/work-orders`. A single status-group filter control (All / Open / Active / Done / Closed) + a search box wired to the `search` param satisfy S1; no other filters.
- **StatusPill** — renders a status by its **real hex color** using `color-mix` tints (see below), so all 19+ colors show correctly per theme.
- **StatusChangeMenu** — click a pill → dropdown of all statuses (from `GET /api/statuses`, grouped by `group`) → selecting one calls `PATCH …/status`; React Query invalidates the list + KPIs so the change and the new activity are reflected immediately.

### Theme system — `theme/tokens.css`

`ThemeProvider` sets `data-theme` on `<html>`: default from `matchMedia('(prefers-color-scheme: dark)')` → `night`, else `day`; a stored value in `localStorage['theone.theme']` wins. The two blocks below are the **`.d1` (Blackout → night)** and **`.d2` (Daylight Dispatch → day)** custom-property values from `ui-directions-template.html`, translated 1:1 into app token names. **Use these values exactly, with one documented exception:** `--ink-3` is darkened from the raw template value in **both** themes because the template's `--ink-3` fails WCAG AA (night `#6b7078` = 3.90:1; day `#8a919d` = 3.17:1) and `--ink-3` colors *non-decorative* small (10.5–11px, normal-weight) text — table-header text (`.ct th`), the client/site sub-line carrying `city, state · ext_name` (`.ct .site small`), KPI meta captions (`.kpi .km`), and the night search field — all of which require ≥4.5:1. The adjusted values (night `#7f838c`, day `#6c727b`) satisfy the §7 acceptance gate. No other token is changed.

```css
:root[data-theme="night"] {          /* .d1 Blackout */
  --bg:#050505;            --surface:#0c0d0e;
  --border:rgba(255,255,255,.09);    --border-strong:rgba(255,255,255,.14);
  --row-border:rgba(255,255,255,.055);
  --ink:#f2f3f5;          --ink-2:#9aa0ab;      --ink-3:#7f838c;  /* darkened from template #6b7078 (3.90:1) → 5.12:1 on #0c0d0e, clears AA */
  --side-bg:#000;          --side-border:rgba(53,184,243,.16);   --side-ink:#8b9098;
  --side-active-bg:rgba(53,184,243,.12);        --side-active-ink:#fff;
  --topbar-bg:#000;        --field-bg:#0c0d0e;
  --accent:#35b8f3;        --on-accent:#00121c;  --accent-text:#35b8f3;
  --tab-on-bg:rgba(53,184,243,.14);             --tab-on-ink:#7fd5f8;
  --chip:rgba(255,255,255,.08);
  --danger:#ff6b6a;        --danger-border:rgba(255,107,106,.35);
  --radius:4px;            --radius-sm:3px;      --pill-radius:3px;   --shadow:none;
  --thead-bg:#0c0d0e;      --th-font:'Barlow Condensed'; --th-size:11px;
  --kpi-font:'Barlow Condensed'; --kpi-weight:800; --kpi-ls:.02em;
}
:root[data-theme="day"] {            /* .d2 Daylight Dispatch */
  --bg:#f2f4f6;            --surface:#ffffff;
  --border:#e3e6ea;        --border-strong:#d4d9df;   --row-border:#edf0f3;
  --ink:#191c21;          --ink-2:#555c68;      --ink-3:#6c727b;  /* darkened from template #8a919d (3.17:1) → 4.85:1 on #ffffff, 4.68:1 on #fafbfc, clears AA */
  --side-bg:#ffffff;       --side-border:#e3e6ea;      --side-ink:#555c68;
  --side-active-bg:#e5f5fd;                     --side-active-ink:#0d6e97;
  --topbar-bg:#000;        --field-bg:#ffffff;         /* topbar stays black in BOTH themes */
  --accent:#1a9fd4;        --on-accent:#ffffff;  --accent-text:#0d6e97;
  --tab-on-bg:#e5f5fd;                          --tab-on-ink:#0d6e97;
  --chip:#eceff2;
  --danger:#c92a29;        --danger-border:#f3b9b9;
  --radius:10px;           --radius-sm:7px;      --pill-radius:999px;
  --shadow:0 1px 2px rgba(20,25,35,.05);
  --thead-bg:#fafbfc;      --th-font:'Barlow'; --th-size:10.5px;
  --kpi-font:'Barlow'; --kpi-weight:600; --kpi-ls:-.02em;
}
```

**Skin-specific rules** (small, per template): the **topbar is black in both themes**, so its search field and bell use light ink (`#b8c0ca` / `#cfd6de`) and translucent borders regardless of theme; night adds an inset accent rail on the active nav item (`box-shadow: inset 2px 0 0 var(--accent)`), an uppercase Barlow-Condensed page/table-header treatment, a soft glow on the "New WO" button and the `hot` KPI; day removes the topbar bottom border and uses pill-radius `999px`.

**Status pill color derivation** (real hex per theme, via `color-mix`; set `--pill: <status.color>` inline on the element). The base formulas below pass ≥4.5:1 for **16 of the 19** pipeline statuses in day and **all** in night; the **three** light/bright day-theme failures are corrected by an enumerated inline `--pill-ink-day` override (below), so the day text falls back to the base formula for everything else and uses the pinned dark ink for exactly those three:
```css
.pill{ background:color-mix(in srgb, var(--pill) 14%, var(--surface));
       border:1px solid color-mix(in srgb, var(--pill) 32%, transparent);
       border-radius:var(--pill-radius); }
:root[data-theme="night"] .pill{ color:color-mix(in srgb, var(--pill) 78%, #ffffff); }
:root[data-theme="day"]   .pill{ color:var(--pill-ink-day, color-mix(in srgb, var(--pill) 72%, #000000)); }
```
Night lightens the text toward white; day darkens toward black. Under the day base formula (`text = color-mix(--pill 72%, #000)`, `bg = color-mix(--pill 14%, #fff)`) exactly three pipeline colors compute below 4.5:1 — these are **deterministic, not spot-checked**:

| status color | statuses using it | day base ratio | day override (`--pill-ink-day`) | override ratio |
|---|---|---|---|---|
| `#f8ae00` | *assessment ongoing*, *job ongoing* | 3.28:1 | **`#7c5700`** | 5.96:1 |
| `#6bed5e` | *!! ready to invoice* | 2.71:1 | **`#36772f`** | 5.11:1 |
| `#64c6a2` | *done/incurred* | 3.49:1 | **`#326351`** | 6.27:1 |

**Implementation:** `StatusPill` sets `--pill: <status.color>` inline always; when `status.color` is one of the three above, it *additionally* sets `--pill-ink-day: <override>` inline (a static 3-entry map keyed by hex, lower-cased). Night needs no overrides (all 20 seeded statuses pass — the 19 pipeline colors plus archive `invoiced` `#656f7d`). The archive `invoiced` color `#656f7d` also passes in day (6.81:1). A tiny check script proving every seeded status ≥4.5:1 in both themes is specified in §7.

### Fonts — `theme/fonts.css`
Copy the four local woff2 files into `apps/web/public/fonts/` (do **not** re-download):

```powershell
$src = "C:/Users/JORDAN~1/AppData/Local/Temp/claude/c--Users-JordanBrown-Downloads-The-One/7bef5089-5b3a-4a00-9f8d-9a8901595ce6/scratchpad"
$dst = "c:/Users/JordanBrown/Downloads/The One/app/apps/web/public/fonts"
New-Item -ItemType Directory -Force $dst | Out-Null
Copy-Item "$src/font2.woff2"  "$dst/barlow-400.woff2"
Copy-Item "$src/font5.woff2"  "$dst/barlow-600.woff2"
Copy-Item "$src/font8.woff2"  "$dst/barlow-condensed-700.woff2"
Copy-Item "$src/font11.woff2" "$dst/barlow-condensed-800.woff2"
```
```css
@font-face{font-family:'Barlow';font-weight:400;font-display:swap;src:url(/fonts/barlow-400.woff2) format('woff2');}
@font-face{font-family:'Barlow';font-weight:600;font-display:swap;src:url(/fonts/barlow-600.woff2) format('woff2');}
@font-face{font-family:'Barlow Condensed';font-weight:700;font-display:swap;src:url(/fonts/barlow-condensed-700.woff2) format('woff2');}
@font-face{font-family:'Barlow Condensed';font-weight:800;font-display:swap;src:url(/fonts/barlow-condensed-800.woff2) format('woff2');}
```
Body font `'Barlow', system-ui, sans-serif`; headers/table-headers/KPI values `'Barlow Condensed'` where the tokens call for it.

### Logo usage
Copy `UI Essentials/Logo for black background.png` → `public/brand/logo-black.png`, `Logo for white background.png` → `public/brand/logo-white.png`, `Mascot.png` → `public/brand/mascot.png`. The sidebar ground differs by theme, so **swap the logo to match its background**:
- **Night (Blackout)** — sidebar is black → use **`logo-black.png`** ("Logo for black background").
- **Day (Daylight Dispatch)** — sidebar is white → use **`logo-white.png`** ("Logo for white background").

`AppShell` selects the logo from the active theme (`useTheme()`), height ~40px.

### API access — `api/client.ts`
Typed `fetch` wrappers (`listWorkOrders`, `getWorkOrder`, `patchStatus`, `getStatuses`, `getKpis`, `getActivity`) returning the `@theone/shared` types, all hitting relative `/api/*`. `vite.config.ts` proxies `/api` → `http://localhost:5174`.

---

## 7. Acceptance checklist (S1 exit)

- [ ] **Clean install works on Windows/PowerShell:** from `app/`, `npm install` then `npm run setup` (migrate+seed) then `npm run dev` starts API (5174) + web (5173) with no errors; opening `http://localhost:5173` shows the app.
- [ ] **Table shows 28 seeded WOs** with WO #, client/site, trade, status pill, NTE, home list (book), and age.
- [ ] **KPIs are computed from the DB** (not hard-coded): Active count, Waiting-approval count + oldest age, Ready-to-invoice count + queued $, Margin placeholder — values change if the seed changes.
- [ ] **Status write path persists + logs:** changing a WO's status via the pill menu (a) updates `task.status_id`/`status_group`, (b) inserts a `status_changed` row into `activity_log` attributed to the acting principal, (c) reflects in the table and KPIs without a manual refresh, and (d) survives a full restart (PGlite `pgdata` persistence) and a page reload.
- [ ] `GET /api/activity?wo=<id>` returns the new `status_changed` entry (plus the seeded `created` entry).
- [ ] **Theme toggle** switches between Blackout (night) and Daylight Dispatch (day) skins — including the sidebar logo swap — and the choice **persists** across reload via `localStorage`; first load with no stored value follows `prefers-color-scheme`.
- [ ] **Contrast (body/caption text):** `--ink`, `--ink-2`, and `--ink-3` all meet **≥4.5:1** against their surface in both themes. (The adjusted `--ink-3` values — night `#7f838c` = 5.12:1 on `#0c0d0e`; day `#6c727b` = 4.85:1 on `#ffffff`, 4.68:1 on `#fafbfc` — are the pinned §6 tokens.)
- [ ] **Contrast (status pills) — deterministic:** all **20** seeded statuses render text at **≥4.5:1** against their pill background in **both** themes. Specifically, the three day-theme overrides are applied and verified: `#f8ae00`→`#7c5700` (5.96:1), `#6bed5e`→`#36772f` (5.11:1), `#64c6a2`→`#326351` (6.27:1). Verified by the check script below (objective pass/fail — no spot-checking).

  <details><summary>Pill/token contrast check script — <code>npx tsx packages/db/scripts/check-contrast.ts</code> (or run in the Bash tool)</summary>

  ```ts
  // Verifies every seeded status pill ≥4.5:1 in both themes, plus --ink-3 in both.
  // Reproduces the CSS color-mix(in srgb, …) math and WCAG relative-luminance ratio.
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c/12.92 : ((c+0.055)/1.055)**2.4; };
  const L = ([r,g,b]: number[]) => 0.2126*lin(r)+0.7152*lin(g)+0.0722*lin(b);
  const ratio = (a: number[], b: number[]) => { const hi=Math.max(L(a),L(b)), lo=Math.min(L(a),L(b)); return (hi+0.05)/(lo+0.05); };
  const hx = (h: string) => [0,2,4].map(i => parseInt(h.replace('#','').slice(i,i+2),16));
  const mix = (c: number[], p: number, o: number[]) => c.map((x,i) => Math.round(x*p + o[i]*(1-p)));
  const WHITE = [255,255,255], BLACK = [0,0,0];
  const NIGHT_SURFACE = hx('0c0d0e'), DAY_SURFACE = hx('ffffff');
  // 19 pipeline colors + archive invoiced #656f7d:
  const colors = ['ff3f48','ff3f48','ff3f48','ee5e99','ff3f48','f8ae00','f8ae00','ee5e99','ee5e99','b660e0','4466ff','b660e0','aa8d80','1090e0','0f9d9f','656f7d','6bed5e','64c6a2','008844','656f7d'];
  const DAY_OVERRIDE: Record<string,string> = { 'f8ae00':'#7c5700', '6bed5e':'#36772f', '64c6a2':'#326351' };
  let fail = 0;
  for (const h of colors) {
    const c = hx(h);
    const nightBg = mix(c, 0.14, NIGHT_SURFACE), nightTxt = mix(c, 0.78, WHITE);
    const dayBg   = mix(c, 0.14, DAY_SURFACE);
    const dayTxt  = DAY_OVERRIDE[h] ? hx(DAY_OVERRIDE[h]) : mix(c, 0.72, BLACK);
    const rn = ratio(nightTxt, nightBg), rd = ratio(dayTxt, dayBg);
    if (rn < 4.5 || rd < 4.5) { fail++; console.log(`FAIL #${h}  night=${rn.toFixed(2)} day=${rd.toFixed(2)}`); }
  }
  // --ink-3 on worst-case surface
  const ink3 = [
    ['night --ink-3', hx('7f838c'), hx('0c0d0e')],
    ['day --ink-3 / surface', hx('6c727b'), hx('ffffff')],
    ['day --ink-3 / thead', hx('6c727b'), hx('fafbfc')],
  ] as const;
  for (const [name, t, bg] of ink3) { const r = ratio(t as number[], bg as number[]); if (r < 4.5) { fail++; console.log(`FAIL ${name} = ${r.toFixed(2)}`); } }
  console.log(fail === 0 ? 'PASS: all pills + --ink-3 ≥4.5:1 in both themes' : `${fail} contrast failure(s)`);
  process.exit(fail === 0 ? 0 : 1);
  ```
  </details>
- [ ] **No console errors or unhandled request failures** in the browser or API on load and on a status change.
- [ ] **Ownership intact:** web bundle does **not** import `@theone/db`/PGlite; API and web both consume `@theone/shared` types without redefining them.
- [ ] `git init` has been run; **no commits** made.

---

## 8. Build-agent task cards

**Build ordering — installs are Agent A's job (never concurrent):** Agent A scaffolds the npm-workspaces root + `packages/**` **first** and runs the **initial `npm install` at the root**. Because npm workspaces hoist every workspace's dependencies into one shared root `node_modules`, A performs a single consolidated install that also **pre-installs the full dependency sets declared for `apps/api` and `apps/web`** in Cards B and C (Fastify/Zod for B; React/Vite/`@tanstack/react-query` for C), so Agents B and C never need to install. This touches no files under `apps/**` — it only writes the shared root `node_modules` and the root `package-lock.json`, both of which are generated artifacts under A's root scope (B and C still author their own `apps/**/package.json` manifests, which reference the already-installed packages). **Agents B and C must NOT run `npm install`** unless a dependency is genuinely missing — and **never simultaneously** (concurrent installs on the shared `node_modules`/lockfile corrupt it).

### Card A — DB & Foundation (`@theone/db`, `@theone/shared`, root)
**Owns:** root `package.json`/`tsconfig.base.json`/`.gitignore`/`.env.example`/`docker-compose.yml`; `packages/shared/**`; `packages/db/**` (incl. `migrations/0001_init.sql`, `src/client.ts`, `src/migrate.ts`, `src/seed.ts`, `scripts/check-contrast.ts`, `seed/clickup-data.json`).
**Must NOT touch:** `apps/**`.
**Do:**
1. Scaffold npm-workspaces root + `.gitignore` (§9) + unused `docker-compose.yml` (Postgres 16). Root `devDependencies` include **`tsx`** (canonical TS runner — see §2). Run `git init` (no commits).
2. `@theone/shared/src/index.ts`: export `StatusGroup`, `Status`, `WorkOrderListItem`, `WorkOrderDetail`, `Kpis`, `ActivityEntry`, `ApiError`, and `STATUS_GROUP_BY_CLICKUP_TYPE`.
3. `packages/db` (scripts `"migrate":"tsx src/migrate.ts"`, `"seed":"tsx src/seed.ts"`): add `@electric-sql/pglite`; `client.ts` opens PGlite at a **module-relative absolute** path (`fileURLToPath(new URL('../pgdata', import.meta.url))`, **never** `./pgdata`/CWD-relative) and exports `query()`/`getDb()`; `migrate.ts` reads each `migrations/*.sql` in filename order and passes it **whole** to `db.exec(readFileSync(file,'utf8'))` in one call — **no semicolon-splitting** (a split runner dies on the dollar-quoted `set_updated_at()` body); write `0001_init.sql` = the full DDL in §3.
4. Copy `clickup-data.json` into `seed/`; implement `seed.ts` per §4 (idempotent truncate+insert; 20 statuses incl. archive `invoiced`; ~50 containers; 102 field_defs (one per `fields[]` entry in `clickup-data.json`); 28 tasks with promoted columns + verbatim `fields`; memberships; 22 humans + 2 service accounts; 5–8 vendors; a few payables; a `created` activity row per WO).
5. `scripts/check-contrast.ts` (§7): the objective ≥4.5:1 gate over all 20 seeded status pills (both themes, with the three day overrides) and `--ink-3`; exits non-zero on any failure. Run via `npx tsx packages/db/scripts/check-contrast.ts`.
**Definition of done:** `npm run setup` completes with no error; a count via a `tsx` scratch script shows 28 tasks, 20 statuses, 102 field_defs, 28 `created` activity rows. Note `migrate.ts` MUST call `await db.exec(readFileSync(file,'utf8'))` per `.sql` file (whole-file, one call) — do **not** hand-roll a semicolon-splitting runner: splitting on `;` breaks on the dollar-quoted `set_updated_at()` `plpgsql` body (`unterminated dollar-quoted string at or near "$$"`) and migration 0001 dies before any table is created. `client.ts` MUST resolve `pgdata` **absolutely** against the module (`fileURLToPath(new URL('../pgdata', import.meta.url))`), not `process.cwd()`, so migrate/seed/api all open the same `packages/db/pgdata` regardless of launch CWD.
**Verify** (`tsx` runner — plain `node` cannot import the `.ts` workspace package):
```
npm run setup
npx tsx -e "import('@theone/db').then(async m=>{console.log((await m.query('select count(*) from task')).rows, (await m.query('select count(*) from status')).rows, (await m.query('select count(*) from field_def')).rows, (await m.query('select count(*) from activity_log')).rows)})"
```

### Card B — API (`@theone/api`)
**Owns:** `apps/api/**`.
**Must NOT touch:** `packages/**`, `apps/web/**`. Import `@theone/db` (runtime) and `@theone/shared` (types) read-only.
**Do:** Fastify server on **5174**; Zod-validate every input; implement the six routes in §5 (`GET /api/work-orders`, `GET /api/work-orders/:id`, `PATCH /api/work-orders/:id/status`, `GET /api/statuses`, `GET /api/kpis`, `GET /api/activity`) via thin `services/*` running parameterized SQL through `@theone/db`; central error handler emits the `{ error: { code, message, details } }` shape; resolve actor from `X-Actor-Id` else default admin; the PATCH does update + `activity_log` insert in one transaction.
**Definition of done:** with DB seeded, all six routes return correct shapes; a PATCH changes status and creates an activity row; no-op PATCH writes nothing.
**Verify** — the canonical path is npm-safe on PowerShell (npm runs package scripts via cmd.exe, so the `&&` inside `setup` works). Start the stack, then exercise routes with PowerShell cmdlets (not bash `curl`/`$(...)`/`&&`):
```powershell
# terminal 1 — seed once, then start the API (leave running)
npm run setup ; if ($?) { npm -w @theone/api run dev }

# terminal 2 — PowerShell verification (Invoke-RestMethod, no bash-isms)
Invoke-RestMethod "http://localhost:5174/api/work-orders?limit=5"
Invoke-RestMethod "http://localhost:5174/api/kpis"
$S = (Invoke-RestMethod "http://localhost:5174/api/statuses")[0].id
Invoke-RestMethod -Method Patch "http://localhost:5174/api/work-orders/WO-39403/status" -ContentType "application/json" -Body (@{ status_id = $S } | ConvertTo-Json)
Invoke-RestMethod "http://localhost:5174/api/activity?wo=WO-39403"
```
(Equivalent bash — `curl`/`$(...)`/`&&` — is fine **only** if run in the Bash tool / Git Bash, not Windows PowerShell.)

### Card C — Web (`@theone/web`)
**Owns:** `apps/web/**` (incl. `public/fonts`, `public/brand`, `theme/*`, components, pages).
**Must NOT touch:** `packages/**`, `apps/api/**`. Import `@theone/shared` types only; **never** import `@theone/db`. **Type-only imports only:** use `import type { … } from '@theone/shared'` (erased at build time) — `apps/web` must **never** import a runtime *value* from the workspace package. If web needs a runtime constant (e.g. status-group mappings), it must fetch it from the API or duplicate it locally in `apps/web`.
**Do:** Vite + React + TS on **5173** with `/api`→`5174` proxy; copy the 4 woff2 + 3 brand PNGs (§6); `tokens.css` with the exact night/day blocks; `ThemeProvider`/`ThemeToggle` (localStorage `theone.theme`, default via `prefers-color-scheme`); build `AppShell`, `KpiRow`, `WorkOrdersTable`, `StatusPill`, `StatusChangeMenu`; wire React Query to the API; the pill menu PATCHes status and invalidates the list + KPI queries.
**Definition of done:** table renders 28 WOs; KPI row populated from `/api/kpis`; changing a status via the pill updates the row + KPIs and persists; theme toggle swaps skin + logo and persists; no console errors; body + pill text pass 4.5:1 in both themes.
**Verify** (PowerShell-safe; `npm run setup` is npm/cmd.exe-internal so its `&&` is fine):
```powershell
npm run setup ; if ($?) { npm run dev }
# browser http://localhost:5173 : 28 rows; toggle theme (persists on reload);
# change WO-39403 status → row + KPI update; DevTools console clean.
# Objective contrast gate: npx tsx packages/db/scripts/check-contrast.ts  (§7) → must print PASS.
```

---

## 9. `.gitignore` (content spec for `app/.gitignore`)

```gitignore
node_modules/
.env
.env.*
!.env.example
dist/
build/
*.local
# PGlite data directory (regenerated by migrate+seed)
pgdata/
packages/db/pgdata/
# misc
.DS_Store
*.log
```

**Git:** Agent A runs `git init` inside `app/`. **Make NO commits** — leave the tree staged/untracked for Jordan to review and commit.

---

## 10. Open questions (flag; do not block S1)

1. **Archive `invoiced` status:** seeded as a 20th, `is_archive=true`, done-group status because 6 samples use it and it's absent from the 19. Confirm this vs. folding invoiced/paid into the pipeline differently. — **DECIDED (APPROVED):** keep it seeded as the 20th status. The real ClickUp archive uses `invoiced`, so seeding it (flagged `is_archive`, done-group) preserves source parity while keeping the 19 pipeline statuses pristine.
2. **`status_group` for `<< invoiced not paid >>`:** source type is `custom` → mapped to `active`; arguably `done`. Confirm which side of the open/closed KPI split it belongs on. — **DECIDED:** stays `active`. This matches ClickUp's open/closed semantics: the 19 source statuses split **16 on the open/active side** (1 `open` + 15 `custom`→`active`, per §4.2) vs **2 `done` + 1 `closed`**, and `<< invoiced not paid >>` is a `custom` (open-side) status. **Parity wins in the prototype.** Consequence: the KPI `active` count (`status_group IN ('open','active')`) therefore **includes** invoiced-not-paid WOs, matching that open/closed split.
3. **Per-person "Active" lists = OM/dispatcher books (not technicians)** — assumed per lifecycle. Confirm before any S3 routing/import work; affects vendor synthesis too. — **DECIDED:** the OM/dispatcher-books assumption **STANDS for S1** (flagged to Jordan); it must be **confirmed before any S3 routing** work.
4. **Assignees vs. technicians:** WO `assignees` are internal people; the real external techs live in `"20. Last Update"` text. Vendors are synthesized from that text — confirm this reading. *(Still open — carried forward.)*
5. **Default API actor:** S1 uses Jordan Brown (or `X-Actor-Id`). Confirm this is acceptable until auth lands in S5. — **DECIDED (APPROVED):** default write actor = the **Jordan Brown** principal (overridable via the `X-Actor-Id` header), accepted until auth lands in **R1/S5**.
6. **State dropdown noise:** the real `State` field has dirty option values (`" MN"`, `"az"`, `"TZ"`, a zip). Seed stores them verbatim in `field_def.type_config`; promoted `task.state` uses the WO's raw value. Confirm no cleanup is wanted in the prototype. — **DECIDED (APPROVED):** store the dirty `State` values **verbatim**. Parity first; cleanup is a later sprint's problem.
7. **PGlite single-writer workflow:** `npm run setup` (migrate+seed, exits) then `npm run dev` (API holds the single writer) — see §2. — **DECIDED (APPROVED):** this single-writer `setup`-then-`dev` sequence is accepted for the prototype.

**DECISION (client-visibility carrier):** client-visible updates are always modeled as `comment` rows (`comment.client_visible`); `activity_log` remains a pure internal audit trail and never carries client visibility. The future outbound client-CMMS sync reads `client_visible` comments, never `activity_log`. *(Also recorded in §3.)*

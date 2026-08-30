# The One — guide for Claude Code

Work-order, quote and vendor-payment platform for Seamless FM (Byblos Vista).
React + Vite front end, Fastify API, embedded Postgres (PGlite). Read this
before touching code; it is the map, the run book and the list of rules that
are easy to break without noticing.

## Layout

```
app/                      npm workspace root — run npm commands here (or use the root shim)
  packages/shared/        @theone/shared — types + shared vocab (status groups, capability names)
  packages/db/            @theone/db — PGlite client, migrations/, seed.ts
  apps/api/               @theone/api — Fastify on :5174 (src/routes, src/services, src/auth, src/plugins)
  apps/web/               @theone/web — React on :5173 (src/pages, src/components, src/styles, src/theme)
product/                  product docs: feature-roadmap.md is the sprint plan; the others are domain specs
docs/ (inside app/)       SPRINT1-SPEC.md — original schema/API contract
package.json (root)       scripts-only shim that forwards to app/ so `npm run dev` works from the repo root
```

## Run

```
npm run setup     # migrate + seed the local PGlite DB (app/packages/db/pgdata, gitignored)
npm run dev       # API :5174 + web :5173 via concurrently
```

Open http://localhost:5173. Both commands work from the repo root or `app/`.

Rules that bite:
- **PGlite is single-writer.** Stop the API before `setup`/`db:seed`; a second
  process opening `pgdata` reads a stale view (symptom: empty user list).
- **`db:seed` TRUNCATEs and re-inserts.** Re-seeding wipes local edits.
- Vite binds `127.0.0.1` (see `vite.config.ts` comment); the API is v4-only too.
- `EADDRINUSE` on :5174 means an old `tsx src/index.ts` is still alive — find it
  with `netstat -ano | findstr 5174` and stop that PID.

## Auth (the part most likely to confuse a reviewer)

Two mutually exclusive modes, chosen by env (`app/.env`, template in `.env.example`):

| Mode   | Trigger                                               | What sign-in does |
|--------|-------------------------------------------------------|-------------------|
| entra  | `ENTRA_TENANT_ID` + `ENTRA_CLIENT_ID` + `ENTRA_CLIENT_SECRET` set | Real Microsoft OIDC round trip (`apps/api/src/auth/entra.ts`) |
| bypass | `AUTH_DEV_BYPASS=true` (refuses to boot if `NODE_ENV=production`) | The same "Sign in with Microsoft" button signs in as `DEV_DEFAULT_EMAIL` (`eliseam@byblosvista.com`, set in `apps/web/src/pages/SignInPage.tsx`) with no password; a footnote can reveal the full account picker |

- Sessions are **server-side rows** (`session` table) sent as an httpOnly
  cookie — not JWTs — so sign-out and "disable user" revoke immediately.
- `plugins/authGuard.ts` 401s every `/api/*` route except the allowlist at its top.
- Sign-in is **invite-only**: the callback looks the principal up by verified
  email; creating the row in Admin › Users *is* the invitation.
- **Super admins** (`principal.is_super_admin`) gate the whole admin console.
  The four are Elise, Jordan Brown, Jeff S, Jack — created by migration 0004
  *and* by `seed.ts` (see "keep in step" below).
- Roles live in the `role` table with capability flags
  (`can_edit_quote`, `can_approve_quote`, `can_manage_users`); the server
  enforces those and nothing else. `principal.role` holds the role *code*.

## Data: migrations and seed must stay in step

`packages/db/migrations/000N_*.sql` run once each (ledger table). `seed.ts`
truncates and rebuilds the sample data. Because `setup` runs migrate **then**
seed, any *data* a migration inserts (super admins in 0004, roles in 0005) is
wiped by the seed unless the seed re-creates it. Both files carry the same
statements on purpose — **if you change one, change the other** (0003/roles,
0004/super admins). The seed prints `super admins : 4 (…)` so drift is visible.

## Verify

```
npm -w @theone/web run build          # from app/: tsc -b && vite build — the only typecheck that exists
curl -s http://127.0.0.1:5174/api/health                      # {"ok":true,"auth_mode":"bypass"}
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/api/work-orders   # 401 without a session
```

- The **API and shared packages have no tsconfig** — they run under `tsx` and
  are never type-checked. An ad-hoc `tsc` over `apps/api/src` reports ~27
  `TS2344` errors from `db.query<T>`'s `Record<string, unknown>` constraint;
  that pattern predates auth and is in untouched files (`feed.ts`,
  `messages.ts`, `payments.ts`, `principals.ts`). Not a regression.
- Dev-bypass smoke test: `POST /api/auth/dev-login {"principal_id":"<id>"}`
  (ids from `GET /api/auth/dev-candidates`), keep the cookie, then hit
  `/api/auth/me`, `/api/work-orders`, `/api/admin/users` (403 unless super admin).
- No test suite exists yet. Verification so far has been build + curl + headless
  Chromium screenshots of both themes.

## Front-end conventions

- **Two themes** via `data-theme="night"|"day"` on `<html>`; every colour is a
  token in `src/theme/tokens.css`. Never hardcode a colour outside that file
  except brand-mandated ones (Microsoft mark) and the sign-in route bubbles.
- **Icons** are a `<symbol>` sprite in `components/Icon.tsx` used via `<use>`.
  The six sidebar icons are drawn inline in `components/NavIcon.tsx` instead
  because hover animations cannot reach inside a `<use>` clone.
- **The wordmark** (`public/brand/logo-the-one.png`) is rendered through crop
  windows keyed to pixel boxes measured from the PNG (`.topbar-brand` in
  `styles/app.css`, `.signin-logo` in `styles/auth.css`). If the asset changes
  size or layout, re-measure and update those numbers — the comments list them.
  Night mode inverts the mark with `filter: invert(1) hue-rotate(180deg)`.
- Motion is always inside `@media (prefers-reduced-motion: no-preference)` or
  disabled under `reduce`.
- Files are CRLF on disk (`core.autocrlf=true`, no `.gitattributes`); the
  LF→CRLF warnings from git are noise.

## Known gaps / deliberate decisions

- Entra mode has not been exercised against a real tenant yet (no app
  registration existed at build time); the code path is complete and typed.
- Vendors and Invoicing appear in the sidebar but are inert placeholders.
- React Router prints v7 future-flag warnings in the console; harmless.
- `public/brand/logo-the-one-2.png` is an untracked leftover of the previous
  logo — safe to delete.
- Product roadmap and open decisions: `product/feature-roadmap.md` (§ "Standing
  risks / open decisions").

## Branches

`main` = last reviewed state. Work lands on `Primary-Updates*` branches, one
per review batch; each is frozen once it is up for review and the next batch
starts from it, so PRs fast-forward in order.

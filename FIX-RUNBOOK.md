# Fix runbook: the operator half of the 2026-10-14 audit batch

For Jordan. AUDIT.md lists twelve Must-fix items. The code half landed on
`phase-0-ground` on 2026-10-14 (60 test files, 957 tests, typecheck clean;
section 9 says what it enforces). This file is the half that needs a person
with credentials: production queries, secret rotation, Neon and Vercel
settings, the GitHub repository and the `main` branch. Sections 1 to 7 run in
the order of risk of AUDIT.md's Must-fix list. Each says why, what to check
first, the exact commands, how to verify, and the finding ids.

Conventions:

- DESTRUCTIVE marks a step that rewrites history, force-pushes, resets a
  branch or changes production data. Read its "check first" line before
  running it.
- Production credentials live in a shell variable for one session, never in a
  file inside the repository. `app/.vercel/.env.production.local` is the
  September pull of production variables; step 2 deletes it.
- Use the pooled `DATABASE_URL` for `psql` queries and the direct
  `DATABASE_URL_UNPOOLED` host for `npm run db:migrate`: the runner refuses a
  `-pooler` host and exits 1 before connecting. Export the two together and
  `unset` both when the step is done: the runner also refuses a pair that
  names different databases, and a `DATABASE_URL_UNPOOLED` standing alone
  that is not localhost unless `ALLOW_MIGRATE=<host>/<database>` confirms it
  — the seed reads only `DATABASE_URL`, so a production direct URL left in a
  shell could otherwise make `npm run setup` migrate production and seed the
  laptop.
- Run `git filter-repo` and the branch reset outside OneDrive. The working
  copy under OneDrive is for editing only.

## Before you start

- Tools: `gh` signed in as an admin of `VistaJordan/TheOne`, `vercel` linked
  to the project, `neonctl` signed in, `psql`, `git-filter-repo`
  (`pip install git-filter-repo`), Node 24.
- Confirm the live state: `curl -s https://the-one-sandy.vercel.app/api/health`
  must answer `{"ok":true,"auth_mode":"entra"}`. If it says `bypass`, stop and
  remove `AUTH_DEV_BYPASS` and `DEMO_MODE` from the Production environment
  first.
- Find out which branch Vercel deploys: Vercel, Project, Settings, Git,
  Production Branch. The audit could not read it from the repository. If it is
  `main`, step 5 deploys this batch to production the moment `main` is reset,
  so the production database must be migrated (step 5c) before that push.
- This machine's working tree holds the batch uncommitted. The 19 new files
  the code needs (migration 0082, `migrateLedger.ts`, `seedGuard.ts`,
  `advisoryLocks.ts`, `tests/setup.ts` and 14 new test files) are ALREADY
  STAGED: `git diff --cached --name-status` lists them as `A`. The modified
  tracked files are not. Before committing, run
  `COMMIT_CHECK=1 npx vitest run tests/commit-completeness.test.ts` from
  `app/`: it fails while a file the commit needs is still untracked and
  prints the `git add` that fixes it. Then, from the repo root, either
  `git add -A -- app ':(exclude)app/.agents' ':(exclude)app/skills-lock.json' CLAUDE.md FIX-RUNBOOK.md AUDIT.md`
  (without the two excludes it also stages `app/.agents/` and
  `app/skills-lock.json`) and commit, or
  `git add CLAUDE.md FIX-RUNBOOK.md AUDIT.md` and `git commit -a`. Leave out
  `Petor.png`, `#To-Dos.md`, `Facilio Map 1.pdf`, `desktop.ini`,
  `app/.agents/`, `app/skills-lock.json`, `product/ui-*.html` and
  `docs/agents/`. Commit on `phase-0-ground` and push before step 4.
  `app/package.json` carries an `allowScripts` hunk that predates the batch;
  decide whether it goes in the same commit.
- The dev API on 127.0.0.1:5174 is a `tsx watch` that still holds fastify
  5.10.0 in memory. Restart it after `npm ci` so it runs 5.12.7.

## 1. Find out whether the password-less window was used (W4-11, Must-fix 2)

Why: around 2026-09-01 to 2026-09-04 production ran the dev bypass with
`DEMO_MODE` on, the Ecotrak credentials loaded and the same Neon database
production uses today. Whether anyone used it is not established. The bypass
logs `signed_in` with `method: dev_bypass`, so the audit log answers it.

Check first: these queries are read-only. Pull the production URL into a
temporary file outside the repository, export it for this shell, and delete
the file afterwards.

```
vercel env pull --environment=production C:/src/prod.env
# copy the DATABASE_URL value out of it, then:
export PRODUCTION_DATABASE_URL='postgres://...'
rm C:/src/prod.env

psql "$PRODUCTION_DATABASE_URL" -c "SELECT a.created_at, p.display_name, p.email, p.is_super_admin, a.after FROM activity_log a JOIN principal p ON p.id = a.actor_principal_id WHERE a.action = 'signed_in' AND a.after->>'method' = 'dev_bypass' ORDER BY a.created_at;"
psql "$PRODUCTION_DATABASE_URL" -c "SELECT a.created_at, p.display_name, a.action, a.after FROM activity_log a JOIN principal p ON p.id = a.actor_principal_id WHERE a.action IN ('impersonation_started','impersonation_ended') AND a.created_at BETWEEN '2026-08-30' AND '2026-09-10' ORDER BY a.created_at;"
psql "$PRODUCTION_DATABASE_URL" -c "SELECT count(*) AS writes, min(created_at), max(created_at) FROM activity_log WHERE created_at BETWEEN '2026-09-01' AND '2026-09-05';"
```

How to verify: the first query lists every dev-bypass sign-in the database
has ever recorded; rows between 2026-08-30 and 2026-09-10 are the window. The
second lists impersonations in the window. The third is the volume of writes.
If the first query shows a sign-in nobody on the team recognises, or a
super-admin sign-in at an odd hour, treat every record changed in the window
as suspect and read them:

```
psql "$PRODUCTION_DATABASE_URL" -c "SELECT action, count(*) FROM activity_log WHERE created_at BETWEEN '2026-09-01' AND '2026-09-05' GROUP BY 1 ORDER BY 2 DESC;"
```

Record the answer under "Facts nobody could verify" in AUDIT.md.

Finding ids: W4-11.

## 2. Rotate the Ecotrak secret and the Neon password (W4-11, Must-fix 2)

Why: both were readable by a server anyone could sign into. Rotation makes
the question of step 1 moot for the future.

Check first: step 1 done. Have the Ecotrak developer console login. Pick a
quiet hour: the Neon password change ends the API's connections for a minute,
and the every-minute Ecotrak and ClickUp crons fail once and recover on the
next run.

```
# Ecotrak: issue a new client secret in the Ecotrak developer console, then
vercel env rm ECOTRAK_CLIENT_SECRET production
vercel env add ECOTRAK_CLIENT_SECRET production

# Neon: Project, Roles, reset the password of the app role, then put the new
# URLs in Production (pooled for the API, direct for migrate)
vercel env rm DATABASE_URL production
vercel env add DATABASE_URL production
vercel env rm DATABASE_URL_UNPOOLED production
vercel env add DATABASE_URL_UNPOOLED production

# redeploy so the lambda reads the new values
vercel --prod

# the September pull on disk holds the old values; it is gitignored but delete it
rm -f app/.vercel/.env.production.local
```

How to verify: `curl -s https://the-one-sandy.vercel.app/api/health` answers
`ok: true`; Admin, Integrations, the Ecotrak panel, Sync now, shows a run with
no error (the token request is the only POST the Ecotrak client makes, so a
good run proves the new secret); `vercel env ls` shows fresh timestamps on the
four variables; `ls app/.vercel` no longer lists `.env.production.local`.

Finding ids: W4-11.

## 3. Give Preview and Development their own Neon branches (W4-20, W3-14, Must-fix 2)

Why: `DATABASE_URL`, `DATABASE_URL_UNPOOLED` and `PGHOST` are scoped to all
three Vercel environments, so `vercel env pull` hands every developer the
production URL (this machine's `app/.env.local` holds it today), and
`npm run setup` against it TRUNCATEs production. The seed guard in the code
now refuses a host that is not localhost unless `ALLOW_SEED` spells its
`<host>/<database>` (the name alone would not do: every Neon branch's
database is `neondb`, so a name persisted once for the development branch
would have confirmed production too), and the migrate runner refuses a
`DATABASE_URL_UNPOOLED` that names
a different database from `DATABASE_URL`, or stands alone off this machine
without `ALLOW_MIGRATE=<host>/<database>` (the seed never reads that
variable, so the two halves of `setup` could otherwise go to two databases),
but the real fence is that the production URL never reaches a laptop.

Check first: step 2 done, so the branches are cut from the rotated state. Know
the Neon project id (`neonctl projects list`).

```
# Neon
neonctl branches create --project-id <PROJECT_ID> --name preview --parent main
neonctl branches create --project-id <PROJECT_ID> --name development --parent main
neonctl connection-string --project-id <PROJECT_ID> --branch preview --pooled
neonctl connection-string --project-id <PROJECT_ID> --branch development --pooled

# Vercel: remove the shared values from Preview and Development
vercel env rm DATABASE_URL preview
vercel env rm DATABASE_URL development
vercel env rm DATABASE_URL_UNPOOLED preview
vercel env rm DATABASE_URL_UNPOOLED development
vercel env rm PGHOST preview
vercel env rm PGHOST development

# then add per-environment values (paste the branch URLs from neonctl)
vercel env add DATABASE_URL preview
vercel env add DATABASE_URL development
vercel env add DATABASE_URL_UNPOOLED preview
vercel env add DATABASE_URL_UNPOOLED development
vercel env ls
```

Then on every developer machine:

```
rm app/.env.local
vercel env pull --environment=development app/.env.local
grep DATABASE_URL app/.env.local      # the host must be the development branch
```

A Neon branch is not localhost, so seeding it needs
`ALLOW_SEED='<host>/<database>' npm run db:seed` — the refusal prints the
exact value for the branch in front of you (the host as pg opens it, case
aside; the database exactly). Type it on the command line for that one run,
never into a profile: a token names one branch, and the database name alone
is refused because every branch's database is `neondb`. Day-to-day work
should use the local Postgres 16 on localhost:5432 (a native install, which
is what the main machine runs, or `docker compose up -d db` from `app/`;
`DATABASE_URL` unset or the localhost default).

How to verify: `vercel env ls` shows `DATABASE_URL` three times with three
different values and the production value only under Production; a developer
shell's `app/.env.local` names the development host; `npm run db:seed`
against a Neon branch without `ALLOW_SEED` prints
`seed: REFUSED — DATABASE_URL points at <host>/<database>, which is not
localhost. Set ALLOW_SEED=<host>/<database> to confirm you really mean to
TRUNCATE it.` and exits 1 before opening a connection; with
`ALLOW_SEED=neondb` (the name alone) it prints the same line and exits 1.

Finding ids: W4-20, W3-14, W4-11.

## 4. Make the repository private, then purge the ClickUp exports from history (W6-15, Must-fix 3)

Why: `VistaJordan/TheOne` is public and tracks `clickup-raw/` and
`platform-brainstorm/clickup-raw/` (25 files each) with team and client
contact data. Making it private is one command and removes the exposure now;
purging the history removes the data from every past commit.

Check first for the visibility change: nothing, do it now.

```
gh repo edit VistaJordan/TheOne --visibility private --accept-visibility-change-consequences
gh repo view VistaJordan/TheOne --json visibility
```

Check first for the purge (DESTRUCTIVE, rewrites every commit hash): every
branch anyone cares about is pushed (`git status` clean here, `git fetch
--all`); every teammate is told that every clone, including this OneDrive
working copy, becomes invalid and must be re-cloned; no branch protection is
on yet (step 6 comes after). Do not run `filter-repo` inside the OneDrive
working copy.

```
# 1. a fresh mirror clone OUTSIDE OneDrive
git clone --mirror https://github.com/VistaJordan/TheOne.git C:/src/TheOne-mirror.git
cd C:/src/TheOne-mirror.git
pip install git-filter-repo   # once

# 2. DESTRUCTIVE: rewrite every commit without the two folders
git filter-repo --invert-paths --path clickup-raw/ --path platform-brainstorm/clickup-raw/ --force

# 3. verify nothing is left before pushing
git log --all --oneline -- clickup-raw/ platform-brainstorm/clickup-raw/ | head

# 4. DESTRUCTIVE: force-push every branch and tag
git push --force --all origin
git push --force --tags origin
```

Then everyone re-clones to a path outside OneDrive, for example
`C:/src/TheOne`, and in the new clone adds two lines to `.gitignore`,
`clickup-raw/` and `platform-brainstorm/clickup-raw/`, commits and pushes.
GitHub keeps unreachable objects for a while (pull-request refs, caches);
if the files must be unrecoverable, ask GitHub support to run a garbage
collection on the repository.

How to verify: `gh repo view VistaJordan/TheOne --json visibility` says
`PRIVATE`; in a fresh clone `git rev-list --all --objects | grep -c clickup-raw`
prints 0; `gh api repos/VistaJordan/TheOne/contents/clickup-raw` answers 404.
Every commit hash changes: CLAUDE.md's Branches section names `3226570` as the
merge base of `main` and `phase-0-ground`, and AUDIT.md names `51eb1e4`;
update both after the rewrite.

Finding ids: W6-15.

## 5. The migration ledger and the `main` branch (W3-6, W3-7, Must-fix 9)

Why: `main` and `phase-0-ground` diverged at `3226570`. `main` has 48 commits
of its own and 27 migration files; `phase-0-ground` has 133 and 82 (0082 is
this batch). From 0004 on the file names differ (`0004_auth.sql` on `main` is
`0009_auth.sql` on `phase-0-ground`, `0005_roles.sql` is `0010_roles.sql`,
and so on), and `_migrations` is keyed by filename. The new runner records a
checksum per file and refuses a changed applied file, but on its first run it
can only backfill checksums from the files it finds on disk, so the
production ledger has to be read and, if it holds `main`'s names, mapped by
hand before that first run. Otherwise the runner would treat a renamed file
as new and run it a second time.

### 5a. Read the production ledger (read-only)

```
psql "$PRODUCTION_DATABASE_URL" -c "SELECT filename, applied_at, checksum FROM _migrations ORDER BY filename;" > C:/src/prod-ledger.txt
git ls-tree --name-only phase-0-ground:app/packages/db/migrations | sort > C:/src/branch-files.txt
diff <(awk '$1 ~ /\.sql$/ {print $1}' C:/src/prod-ledger.txt | sort) C:/src/branch-files.txt
```

(`checksum` does not exist until the new runner has run once; drop the column
from the query if psql says so.) Three outcomes:

- The ledger holds `phase-0-ground`'s names (`0004_obligations.sql`,
  `0005_cmms.sql`, ...): nothing to map. Go to 5b.
- The ledger holds `main`'s names (`0004_auth.sql`, `0005_roles.sql`, ...):
  production was migrated from `main`. For every ledger row whose filename is
  not on the branch, find the file on `phase-0-ground` with the same title
  (the part after the number) and rename the row, one UPDATE per file:

  ```
  psql "$PRODUCTION_DATABASE_URL" -c "UPDATE _migrations SET filename = '0009_auth.sql' WHERE filename = '0004_auth.sql';"
  ```

  Do this for every renamed row before 5c, or the runner will "apply" a file
  whose tables already exist. The files that exist only on `phase-0-ground`
  (`0004_obligations.sql`, `0005_cmms.sql`, `0006_status_group_pending.sql`,
  `0007_pending_statuses.sql`, `0008_sites_assets.sql` and everything from
  0028 on) are genuinely new to that database and will be applied in 5c; read
  them first, in order, and expect 5c to take a few minutes.
- Rows that match neither list: stop and ask before running anything.

### 5b. Reset `main` to `phase-0-ground` (DESTRUCTIVE for `main`)

Check first: 5a done; step 4's history rewrite done (the hashes below change
with it); the batch committed and pushed on `phase-0-ground`; if Vercel
deploys `main`, 5c done BEFORE this push.

```
git fetch origin
git branch -f main phase-0-ground
git push --force-with-lease=main origin main
```

### 5c. First migrate run with the new runner, by hand, against production

Check first: 5a done and every renamed row mapped. Use the DIRECT Neon host.
Export the two URLs together, in ONE shell, and unset both at the end of the
step: the runner refuses a pair that names different databases, and a
`DATABASE_URL_UNPOOLED` on its own that is not localhost unless
`ALLOW_MIGRATE=<host>/<database>` confirms it (compared as `ALLOW_SEED` is:
the host case-insensitively, the database exactly), so a stale export cannot
make a later `npm run setup` (migrate, then seed — the seed reads only
`DATABASE_URL`) migrate production and seed the laptop. A
`DATABASE_URL_UNPOOLED` it cannot read as a URL is refused outright, with or
without `DATABASE_URL` beside it; no `ALLOW_MIGRATE` value confirms it.

```
cd app
export DATABASE_URL='<production pooled URL>'
export DATABASE_URL_UNPOOLED='<production direct URL, the host without -pooler>'
npm run db:migrate
unset DATABASE_URL DATABASE_URL_UNPOOLED
```

If the shell may hold only the direct URL, run
`ALLOW_MIGRATE='<host>/<database>' npm run db:migrate` with the value the
refusal prints, on that one command line — never `export` it.

What the output means:

- First line `migrate: <host>/<database> (DATABASE_URL_UNPOOLED)`: the runner
  chose the direct URL. `migrate: REFUSED — DATABASE_URL_UNPOOLED is a pooled
  endpoint` means the host still carries `-pooler`; fix the variable.
- `migrate: REFUSED — DATABASE_URL_UNPOOLED (<host>/<db>) and DATABASE_URL
  (<host>/<db>) name different databases`: the two exports do not name one
  database (one is stale, or a typo). Fix them; nothing was written.
- `migrate: REFUSED — DATABASE_URL_UNPOOLED points at <host>/<db>, which is
  not localhost`: `DATABASE_URL` is not exported in this shell. Export it too
  (the pooled URL of the same database), or confirm with `ALLOW_MIGRATE` as
  above.
- `migrate: REFUSED — DATABASE_URL_UNPOOLED is not a URL the guard can
  read`, or `... names no host` / `names no database`: the value is truncated
  or mistyped (`user:pass@/db`, with no host, is one). Spell it out as
  `postgres://user:password@host/database`; no `ALLOW_MIGRATE` value is
  accepted for it.
- `migrate: checksum recorded for <file>`, once per already-applied file (81
  on a database that is level with the branch): the NULL-checksum backfill.
  It writes nothing else.
- `apply <file>` lines for the new files, each in its own transaction.
- `migrate: REFUSED — N applied migration file(s) changed since they ran`
  with the list: the text on disk no longer matches what the database ran.
  Read the diff for each named file. Only when the change is one you accept
  (a comment, a line-ending fix), run once more with
  `MIGRATE_ALLOW_CHECKSUM_MISMATCH=1 npm run db:migrate`; it records the new
  checksums and prints one line per file. Never set it in Vercel.
- `migrate: REFUSED — N migration file(s) to apply cannot run as written`,
  then one line per statement with its file and line: a new file has BEGIN /
  START TRANSACTION / COMMIT / ROLLBACK at a statement start, or a
  CONCURRENTLY (the runner wraps each file in a transaction of its own). Fix
  the file; there is no override.
- `another migration run has held the lock for more than 120 s`: a previous
  runner leaked the advisory lock (`ADVISORY_LOCKS.migrate` in
  `packages/shared/src/advisoryLocks.ts`). Find it with
  `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 7262026`,
  let that session end (`pg_terminate_backend(pid)` only if it is a dead
  runner), run again.
- A refused run, for any of these reasons, writes nothing.

How to verify: `psql "$PRODUCTION_DATABASE_URL" -c "SELECT count(*) FILTER (WHERE checksum IS NULL) AS unchecked, count(*) AS rows, max(filename) FROM _migrations;"`
answers 0, 82, `0082_app_meta.sql`; `env | grep DATABASE_URL` prints nothing
once the step is done; `git log --oneline -1 main` equals
`phase-0-ground`'s head; after the deploy `/api/health` answers `ok: true`.
From then on the runner refuses a renumbered or edited applied file, so
never renumber a migration again.

Finding ids: W3-6, W3-7.

## 6. Protect `main` (W6-9, W6-4, Must-fix 10)

Why: no branch is protected and one pull request exists in 146 commits. CI is
green now that the tests are hermetic, so it can be a gate.

Check first: steps 4 and 5 done (protection blocks exactly the force-pushes
they need); `gh run list --branch phase-0-ground --limit 3` shows the
"typecheck + test" check green (that is the job name in
`.github/workflows/ci.yml`, and the name the rule below requires).

```
gh api -X PUT repos/VistaJordan/TheOne/branches/main/protection -H 'Accept: application/vnd.github+json' --input - <<'JSON'
{
  "required_status_checks": { "strict": true, "contexts": ["typecheck + test"] },
  "enforce_admins": true,
  "required_pull_request_reviews": { "required_approving_review_count": 1, "dismiss_stale_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": true
}
JSON
gh api repos/VistaJordan/TheOne/branches/main/protection | head -40
```

How to verify: the second command prints the rule; `git push origin main`
from a clone is refused with "protected branch"; a pull request from any
branch shows "typecheck + test" as required.

Finding ids: W6-9, W6-4.

## 7. Dependencies (W6-14, Must-fix 11)

Done by the batch: `npm update fastify fast-uri react-router react-router-dom`
(fastify 5.10.0 to 5.12.7, fast-uri 3.1.4 to 3.1.8 and 4.1.1 to 4.2.2,
react-router and react-router-dom 6.30.4 to 6.30.6), `app/package-lock.json`
only, no manifest changed; `npm audit --omit=dev` went from 5 advisories to 3.

What you do now:

```
cd app
npm ci                    # installs the lock's versions
# restart the dev API (the tsx watch on :5174 keeps fastify 5.10.0 in memory until then)
npm audit --omit=dev      # expect exactly 3: maplibre-gl critical, react-router moderate x2
npm run typecheck && npm test && npm -w @theone/web run build
```

The three that remain and why they stay:

- `maplibre-gl` 5.24.0, critical GHSA-jrc7-96c5-q579 (XSS sanitizer bypass):
  the fix is 6.14.0, a major. Planned, not this batch; see below.
- `react-router` / `react-router-dom` 6.30.6, moderate GHSA-wrjc-x8rr-h8h6
  (open redirect through a backslash in a `<Link>` or `navigate()` target) and
  GHSA-337j-9hxr-rhxg (constructor injection in `deserializeErrors()` during
  SSR hydration): no 6.x patch exists, the fix is react-router-dom 7.18.4, a
  major. The web app is a Vite SPA without SSR, so the second is unreachable;
  the first matters only where a user-typed string reaches `navigate()`.
  Decide: accept until the v7 migration, or plan it with the maplibre major.

Planned, next sprint (the map library major):

```
cd app
npm outdated maplibre-gl
npm -w @theone/web install maplibre-gl@latest
npm -w @theone/web run build     # compare the map chunk size with today's build output
```

Then open a work order, People, Technicians, Find a technician, and Vendors,
Coverage map, in the night and day themes, and read the maplibre changelog for
breaking changes to Marker, Popup and the style spec before merging.

Dev-only advisories (shell-quote through concurrently, source-map-js) have
non-breaking fixes: `npm audit fix` takes them; read the lock diff before
committing. The esbuild advisory needs Vite 8 (major) and waits.

Finding ids: W6-14.

## 8. Deploying this batch: what to expect

- DEMO_MODE deployments: none exists today (production is Entra). If one is
  made, it must be migrated to 0082 and seeded with
  `ALLOW_SEED='<host>/<database>' npm run db:seed` (the value the refusal
  prints; the database name alone is refused), or `POST /api/auth/dev-login`
  and `GET /api/auth/dev-candidates` answer 403 `DEMO_NOT_SEEDED` for
  everyone. The API refuses to boot in DEMO_MODE while any of the 14
  credentials in `DEMO_MODE_SECRET_VARS` (`apps/api/src/config.ts`;
  `SALES_TAX_API_KEY` is one, `CRON_SECRET` is left out on purpose) is set,
  and the message names the one to remove.
- The first `npm run db:migrate` on every existing database, laptops
  included, prints `migrate: checksum recorded for ...` once per applied file
  and writes nothing else (section 5c explains the other lines).
- A shell that still exports a production `DATABASE_URL_UNPOOLED` beside a
  local (or unset) `DATABASE_URL` is refused by `npm run db:migrate` and
  `npm run setup` before any connection (`name different databases`, or
  `points at <host>/<db>, which is not localhost`), and `npm run db:seed`
  prints `seed: WARNING DATABASE_URL_UNPOOLED is set and names ...`. Unset
  the variable.
- The first authenticated `GET /api/pulse` or `GET /api/obligations` after
  the deploy runs the first obligation reconcile since migration 0023: every
  work order sitting in a rule's status gets an obligation at once, most of
  them already at tier 2 or 3, and the fan-out notifies the owner, TL and ATL,
  Admin and AM in one burst (once per obligation per tier, never repeated).
  Tell the team before deploying; it happens once.
- `GET /api/obligations?wo=<a trashed work order>` now answers an empty list
  (every per-work-order route hides Trash).
- Viewing as someone is read-only: a super admin viewing as a person gets
  403 on every change, on the CSV exports, Save as PDF and the technician
  map (the export and Save as PDF links are drawn inert, dimmed, with the
  read-only hint as their title, so nothing saves the 403 body as a file),
  and per-user preference saves fail silently meanwhile.
- Smoke test as a super admin after the deploy: `/api/health` says `entra`;
  Pulse opens and lists clocks; pick Viewing as, try a status change, read the
  read-only sentence, switch back to Myself; as an admin-role user who is not
  a super admin, Admin, Users: the Super admin switch and a super admin's
  Role / Disable are locked; as a scoped dispatcher, import a CSV naming a
  work order outside their book: the file is refused naming the number.

## 9. What the code changes already enforce

No manual step is needed for these; each is pinned by a test under
`app/tests/`.

| Must-fix | Finding | Guard | Where | Test |
|---|---|---|---|---|
| 1 | W4-1 | Only a super admin (the real signed-in user, never the one viewed as) may set or clear `is_super_admin` or change a super admin's role, name, status, client list (clearing included) or per-person dashboard overrides; 403 `SUPER_ADMIN_ONLY`; `actorIsSuperAdmin` is required on all five writers and the check runs again where the write happens; the last-super-admin count and the update run in one transaction under the `superAdminRing` advisory lock | `apps/api/src/services/users.ts`, `routes/admin.ts`, `services/dashboards.ts`, `apps/web/src/pages/admin/AdminUsersPage.tsx` | `admin-super-admin.test.ts` |
| 2 | W4-11 | The API refuses to boot in DEMO_MODE with any of 14 real credentials set (`SALES_TAX_API_KEY` included, `CRON_SECRET` left out with its reason; a drift test fails when the API reads a credential-looking name that is in neither list); the bypass sign-in and the account picker answer 403 `DEMO_NOT_SEEDED` until the seed marker exists, which is also what stops a demo pointed at a real database (`DATABASE_URL` is not boot-checked) | `apps/api/src/config.ts`, `services/auth.ts`, `routes/auth.ts`, migration `0082_app_meta.sql`, `packages/db/src/seed.ts` | `config-guards.test.ts` |
| 2 | W3-14, W4-20 | The seed refuses a `DATABASE_URL` host that is not localhost unless `ALLOW_SEED` spells its `<host>/<database>` (host case-insensitive, database exact; the name alone is refused — every Neon branch's database is `neondb`), decided before any connection, with pg's own `?host=` rule; the refusal prints the exact value to set | `packages/db/src/seedGuard.ts`, `seed.ts` | `seed-guard.test.ts` |
| 4 | W4-4 | The CSV import takes the acting principal: a number outside their scope refuses the whole file (403 `IMPORT_SCOPE`), a status cell or a home-list cell on a new row needs `work_orders/status` edit (403 `IMPORT_STATUS_PERMISSION`), dry runs included; rows in Trash are skipped; the update branch diffs against the locked row | `apps/api/src/services/woBulk.ts`, `routes/workOrders.ts` | `import-scope.test.ts` |
| 5 | W3-3 | Every whole-bag write reads `task.fields` `FOR NO KEY UPDATE` inside its transaction and merges from that read (NO KEY: no bag write changes `id` or `wo_number`, so a child row's foreign-key KEY SHARE never waits on it; the reason is in `updateWorkOrderFields`, and the test fails when a new unique column on `task` would break it); the parent row is locked before a child row is inserted; bulk and import lock in id order; the money lock is checked on the transaction | `woFieldValues.ts`, `woBulk.ts`, `visits.ts`, `signoff.ts`, `assigneeHistory.ts`, `moneySync.ts` | `bag-lock.test.ts` |
| 6 | W1-8 | `awardQuote`, `saveRfq`, `saveVendorQuote`, `deleteVendorQuote`, `receiveOrder` lock the RFQ or order and re-check its status inside one transaction; the delete-then-insert line rewrites commit as one; every purchase-request, RFQ and purchase-order status move is one conditional UPDATE on the status it moves from (409 when the row moved since it was read), and PO issue and cancel re-check under the order's lock; `saveDocTemplate`'s default flip is one transaction and "not the default" clears that template only; every move is logged | `apps/api/src/services/purchasing.ts`, `maintenance.ts` | `purchasing-tx.test.ts`, `vendor-workflow.test.ts` |
| 7 | W3-2, W4-7 | The obligation queries cast `t.id::text` (the engine had returned nothing since 0023); `/pulse`, `/obligations`, `/notifications` and the snooze need `work_orders` view and follow the viewer's scope; `?wo=` resolves like every per-work-order route; the reconcile insert is `ON CONFLICT DO NOTHING`; swallowed errors are logged with their code | `apps/api/src/services/obligations.ts`, `routes/obligations.ts`, `apps/web/src/App.tsx` | `obligations-sql.test.ts` |
| 8 | W4-2 | Viewing as someone is read-only: every non-GET under `/api` and the five row-writing GETs answer 403 `IMPERSONATION_READ_ONLY`, except ending the view and signing out; the top bar shows a Read-only chip, and the export and Save as PDF links are drawn inert with the hint (`downloadLinkProps`) instead of saving the 403 body | `apps/api/src/plugins/authGuard.ts`, `apps/web/src/components/ActorSwitcher.tsx`, `apps/web/src/lib/actor.ts` | `impersonation-readonly.test.ts` |
| 9 | W3-6 (code half) | The migration ledger carries a sha256 per file, each file and its row commit together, the run holds an advisory lock on a direct connection (a `-pooler` host is refused), waits at most 120 s, refuses a changed applied file unless `MIGRATE_ALLOW_CHECKSUM_MISMATCH=1`, refuses a file to apply that manages its own transaction or says CONCURRENTLY (no override), and writes nothing when refused; `DATABASE_URL_UNPOOLED` must name the same database as `DATABASE_URL` and, alone off this machine, needs `ALLOW_MIGRATE=<host>/<database>` (the host read as pg opens it, `?host=` included; compared as `ALLOW_SEED` is), and one the guard cannot read is refused outright; the seed warns when it points elsewhere; every advisory lock key comes from one registry | `packages/db/src/migrate.ts`, `migrateLedger.ts`, `seed.ts`, `packages/shared/src/advisoryLocks.ts` | `migrate-ledger.test.ts`, `advisory-locks.test.ts` |
| 10 | W6-4 | The tests are hermetic: `tests/setup.ts` sets the environment, `config.ts` skips `app/.env` under vitest, no test opens a database; CI is green | `app/vitest.config.mts`, `app/tests/setup.ts`, `apps/api/src/config.ts` | the whole suite under `env -i` |
| 11 | W6-14 | fastify, fast-uri, react-router, react-router-dom updated inside their ranges | `app/package-lock.json` | typecheck, suite, build |
| 12 | W2-1 | `/receivables` needs `invoicing` view; the Audit tab is labelled a prototype, reads only facts the lists carry and shows "not tracked yet" for the rest; Ready = Done + a quote approved, sent or client-approved + no invoice; the three list windows are named constants and the page says when one is hit | `apps/web/src/App.tsx`, `pages/ReceivablesPage.tsx`, `lib/receivables.ts`, `components/rcv/InvoicingTab.tsx` | `receivables-no-fake.test.ts`, `wo-lifecycle-grey-flag.test.ts` |

Also in the batch: the two false engine strings (`adminMeta.ts`,
`docsSnapshot.ts`) say Postgres 16 (node-postgres); no comment under
`apps/api/src` or `packages/db/src` justifies an ordering by PGlite any more
(only `client.ts`'s historical notes name it), and `app/docker-compose.yml`'s
header calls it the local Postgres for Docker users; the assistant's guide
has a drift guard (`assistant-guide.test.ts`: every bold label is checked
against the web source, every sentence it quotes against the code);
CLAUDE.md, `app/README.md`, `app/.env.example` and the Admin, Documentation
registry (`packages/shared/src/docs`) describe the database, the tests and
the guards as they are, and `guard-docs-drift.test.ts` fails when CLAUDE.md
or this runbook states a credential count, a bag-lock strength or an
advisory lock key the code no longer holds.

## 10. Not done in this batch

Follow-ups the batch recorded, with where they start:

- An `on_behalf_of` column on `activity_log` so writes while viewing as
  someone can be allowed again and logged under the real user. Until then
  viewing as is read-only (section 9, row 8).
- The maplibre-gl major (section 7).
- A Postgres-backed test tier: a CI job with a Postgres service that runs
  every migration from empty, seeds, and exercises the obligation queries,
  the append-only trigger, the gates, the bag lock (`FOR NO KEY UPDATE`
  against a child insert's KEY SHARE, for real), the import and the
  purchasing races through `app.inject`. The batch pins SQL text and pure
  functions only.
- A route-matrix security test: every registered route, signed in as each
  role and as a scoped dispatcher, asserting 401, 403, scoped rows and
  redacted fields (W4-3, W4-5, W4-6, W4-8 stay open).
- Receivables: the Ready lane cannot see a quote older than the 200 most
  recently updated (`GET /quotes` has no `?limit=`), so it is false-negative
  only and says so; an empty CICO on an imported Done work order reads as a
  minor finding (AR's call to change).
- `packages/db/package.json` does not list `@theone/shared`, which
  `migrateLedger.ts` (`ADVISORY_LOCKS`) and `seed.ts` import; it resolves
  only through the workspace symlink. Add it to `dependencies`.
- Lost updates on `principal.permission_overrides`: `setUserOverrideView`
  (the Share dialog's per-person tick) reads the map on the pool and writes it
  whole, and `setUserPermissions` (Adjust) writes the whole map the dialog
  sent over whatever is there, so two shares, or a share and an Adjust save,
  for one person close together lose one of them; both, and `setUserClients`,
  log `before` from a pool read (the ring check itself runs at the write). A
  row lock or a `jsonb_set` of the one key closes the share; Adjust also needs
  to send the version it edited.
- The same unguarded status move outside purchasing: the status is checked on
  a pool read and the UPDATE does not repeat the check, so two moves racing
  on one record both land, and both log. `maintenance.ts` `actOnPermit`
  (request ~785, approve / reject ~802, close ~817, back to draft ~822);
  `vendorExtras.ts` `decideCreditNote` (approve ~290, void ~298) and
  `answerOffer` (accept ~447, which then sets the task's vendor, and decline
  ~452; the vendor portal answers through it too); `woRecord.ts`
  `decideNteIncrease` (~762, where an approval has already written the new
  NTE); and `quotes.ts` `transition()`, which all eight quote moves go
  through, and `updateQuote`'s editable check. The fix is the purchasing one:
  `AND status = <expected> RETURNING id`, and `conflict()` when no row comes
  back (the NTE decision must claim the request before it writes the NTE).
  Credit notes, NTE decisions and quote approval and sending touch money.
- `vendorWork.ts` holds no delete-then-insert rewrite, but its multi-statement
  writes are not one transaction: `resolveTask` (approve, send back, fixed),
  `uploadDocument`'s COI path, `removeDocument` and `logCall` call pool-only
  helpers (`recomputeCompliance` and `updateVendor` in `vendors.ts`,
  `openVendorTask` and `autoCloseTasks` in `vendorTasks.ts`). Putting each on
  one transaction needs those helpers to take a `Queryable` first.
- `logWo` in `purchasing.ts` returns without writing when a document is not
  tied to a work order, so the moves of a standalone purchase request, RFQ or
  purchase order leave no audit row (a gap in rule 1.2.1 that predates the
  batch). It needs an admin-audit entity for purchasing documents.
- Find a technician (People tab) is not inert while viewing as someone: the
  API answers 403 and the map sheet prints that error, where the export and
  Save as PDF links are drawn inert with the read-only hint up front.
- `saveDocTemplate`: two concurrent "make default" saves for one kind can
  surface as a 500 (the `doc_template_one_default` unique index refuses the
  second; the data stays consistent).
- Process items from AUDIT.md not in this batch: `.gitattributes` with
  `* text=auto`, moving the working copy out of OneDrive, Dependabot or a
  monthly `npm outdated` pass, ESLint, migrations as a deploy step instead of
  by hand, a drift-test suite for the keep-in-step pairs, and the docs split
  (README, ARCHITECTURE.md, one doc per module).

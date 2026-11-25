#!/usr/bin/env node
// OBI load simulation — N simulated people working M work orders through the
// ordinary flow, against a running API, while measuring every request.
//
//   node scripts/simulate-load.mjs --base http://127.0.0.1:5174 --db postgres://theone:theone@localhost:5432/theone
//   node scripts/simulate-load.mjs --base https://<preview>.vercel.app --db "<neon branch DIRECT url>" --users 40 --wos 100 --minutes 60
//
// What it does
//   1. Setup (directly in the database named by --db): creates the simulated
//      people (`sim+<role>-NN@sim.obi.local`, display names "Sim OM 01"…) in
//      the real roles, and one session row each. No sign-in route is used, so
//      it works in entra, bypass and test-account deployments alike.
//   2. Every person runs a "browser" loop like the web app does: the live-sync
//      poll every 3 s (GET /activity/since), the badges every 60 s, the open
//      work order's poll every 4 s, and — whenever someone ELSE changed
//      something — a re-read of every query on the page they are looking at
//      (useAppLiveUpdates invalidates them all).
//   3. Each work order is created by an OP Admin and walked through the flow by
//      the right roles: assign, status requests approved by a manager, the
//      Assessment visit (check-in / check-out requests approved), the quote
//      (dispatcher submits for correction, manager sends, OP Admin records the
//      client's approval), Job Sched, the Job visit, a payment request
//      (approved in band, paid by AP), messages, escalations, emergencies.
//   4. Every request is timed; a report (per endpoint p50 / p95 / p99, status
//      codes, refusal codes, how far each work order got) is printed and saved
//      as JSON + Markdown under --out.
//
// Safety
//   - --db must be localhost, or SIM_ALLOW_DB must spell its <host>/<database>
//     exactly (the ALLOW_SEED rule) — so it cannot be pointed at production by a
//     stray paste. Run it against a Neon BRANCH and a Preview deployment.
//   - Every work order it makes is numbered SIM-<run>-NNN. activity_log is
//     append-only: what the run writes stays on that database. Delete the
//     branch afterwards.
//   - --cleanup disables the sim people and deletes their sessions.
//
// Options (defaults in brackets)
//   --base URL         API origin, with or without /api            [http://127.0.0.1:5174]
//   --db URL           the SAME database the API at --base uses      [postgres://theone:theone@localhost:5432/theone]
//   --users N          simulated people                              [40]
//   --wos N            work orders to create over the run            [100]
//   --minutes N        length of the run ("the day")                 [60]
//   --step-sec N       mean think time between steps of one WO       [minutes*60/24]
//   --no-browse        skip the background browsing load (flows only)
//   --out DIR          where the report goes                         [.sim-reports]
//   --cleanup          disable sim people + delete their sessions, then exit
//   env VERCEL_AUTOMATION_BYPASS_SECRET   sent as x-vercel-protection-bypass

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const BASE = opt('base', 'http://127.0.0.1:5174').replace(/\/+$/, '').replace(/\/api$/, '') + '/api';
const DB = opt('db', process.env.SIM_DATABASE_URL ?? 'postgres://theone:theone@localhost:5432/theone');
const USERS = Number(opt('users', 40));
const WOS = Number(opt('wos', 100));
const MINUTES = Number(opt('minutes', 60));
const STEP_SEC = Number(opt('step-sec', (MINUTES * 60) / 24));
const BROWSE = !flag('no-browse');
const OUT = opt('out', '.sim-reports');
const BYPASS = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ?? '';
const RUN = new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '');
const RUN_MS = MINUTES * 60_000;

// ── database guard (the seedGuard rule) ──────────────────────────────────────
function dbTarget(url) {
  const u = new URL(url);
  const hostParam = u.searchParams.getAll('host').pop();
  return { host: (hostParam || u.hostname || '').toLowerCase(), database: decodeURIComponent(u.pathname.replace(/^\//, '')) };
}
const { host: dbHost, database: dbName } = dbTarget(DB);
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(dbHost);
if (!local) {
  const allow = (process.env.SIM_ALLOW_DB ?? '').trim();
  const [h, ...rest] = allow.split('/');
  if (!allow || h.toLowerCase() !== dbHost || rest.join('/') !== dbName) {
    console.error(`Refusing to write sim people to ${dbHost}/${dbName}.\nIf this is a Neon BRANCH made for the test (never production), set:\n  SIM_ALLOW_DB=${dbHost}/${dbName}`);
    process.exit(1);
  }
}

// ── the team ─────────────────────────────────────────────────────────────────
// 24 dispatchers, 4 OP Admin, 9 managers, 3 AP for 40; scaled for other sizes.
const MIX = [
  ['om', 15], ['senior_om', 4], ['om_probation', 4],
  ['oa', 4],
  ['atl', 4], ['tl', 3], ['am', 2],
  ['ap', 2], ['ar', 2],
];
// Roles that need two different people (the raiser of an invoice may not send it).
const MIN_PER_ROLE = { ar: 2 };
const LABEL = { om: 'OM', senior_om: 'SOM', om_probation: 'OMP', oa: 'OA', atl: 'ATL', tl: 'TL', am: 'AM', ap: 'AP', ar: 'AR' };
function teamPlan(n) {
  const total = MIX.reduce((s, [, k]) => s + k, 0);
  const plan = MIX.map(([role, k]) => [role, Math.max(MIN_PER_ROLE[role] ?? 1, Math.round((k * n) / total))]);
  let diff = n - plan.reduce((s, [, k]) => s + k, 0);
  while (diff !== 0) { plan[0][1] += Math.sign(diff); diff -= Math.sign(diff); }
  return plan;
}

const pool = new pg.Pool({ connectionString: DB, max: 3, ssl: local ? undefined : { rejectUnauthorized: false } });

async function setupPeople() {
  const people = [];
  for (const [role, k] of teamPlan(USERS)) {
    const r = await pool.query('SELECT 1 FROM role WHERE code = $1', [role]);
    if (!r.rowCount) throw new Error(`role ${role} is not on this database`);
    for (let i = 1; i <= k; i++) {
      const nn = String(i).padStart(2, '0');
      const email = `sim+${role}-${nn}@sim.obi.local`;
      const name = `Sim ${LABEL[role]} ${nn}`;
      let row = (await pool.query('SELECT id FROM principal WHERE lower(email) = lower($1)', [email])).rows[0];
      if (!row) {
        row = (await pool.query(
          `INSERT INTO principal (kind, display_name, email, role, initials, status, is_super_admin)
           VALUES ('human', $1, $2, $3, $4, 'active', false) RETURNING id`,
          [name, email, role, `S${LABEL[role][0]}`],
        )).rows[0];
      } else {
        await pool.query(`UPDATE principal SET status = 'active', role = $2, display_name = $3, permission_overrides = '{}'::jsonb WHERE id = $1`, [row.id, role, name]);
      }
      const sid = randomBytes(32).toString('base64url');
      await pool.query(
        `INSERT INTO session (id, principal_id, expires_at, user_agent, ip, remember)
         VALUES ($1, $2, now() + interval '18 hours', 'obi-load-sim', '127.0.0.1', false)`,
        [sid, row.id],
      );
      people.push({ id: row.id, name, role, cookie: `theone.sid=${sid}`, tab: randomUUID(), page: { kind: 'list' }, cursor: null });
    }
  }
  return people;
}

async function cleanup() {
  const r = await pool.query(`UPDATE principal SET status = 'disabled' WHERE email LIKE 'sim+%@sim.obi.local' RETURNING id`);
  const s = await pool.query(`DELETE FROM session WHERE principal_id = ANY($1::uuid[])`, [r.rows.map((x) => x.id)]);
  console.log(`disabled ${r.rowCount} sim people, deleted ${s.rowCount} sessions`);
}

// ── HTTP with measurement ────────────────────────────────────────────────────
const stats = new Map(); // "METHOD /path" → { lat: [], codes: {}, refusals: {} }
const timeline = []; // per 10 s bucket: { t, n, err, lat: [] }
let inflight = 0, peakInflight = 0;
const t0 = Date.now();

function template(path) {
  return path
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/SIM-[\w-]+/g, ':wo');
}
function bucket() {
  const t = Math.floor((Date.now() - t0) / 10_000);
  let b = timeline[t];
  if (!b) b = timeline[t] = { t: t * 10, n: 0, err: 0, lat: [] };
  return b;
}

async function api(person, method, path, body) {
  const key = `${method} ${template(path)}`;
  let s = stats.get(key);
  if (!s) stats.set(key, (s = { lat: [], codes: {}, refusals: {} }));
  const headers = { cookie: person.cookie, 'x-obi-tab': person.tab, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (BYPASS) headers['x-vercel-protection-bypass'] = BYPASS;
  const start = performance.now();
  inflight++; peakInflight = Math.max(peakInflight, inflight);
  let status = 0, json = null;
  try {
    const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    status = res.status;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 200) }; }
  } catch (e) {
    status = e?.name === 'TimeoutError' ? -2 : -1; // -1 network, -2 timeout
    json = { error: String(e?.message ?? e) };
  } finally {
    inflight--;
  }
  const ms = performance.now() - start;
  s.lat.push(ms);
  s.codes[status] = (s.codes[status] ?? 0) + 1;
  const b = bucket();
  b.n++; b.lat.push(ms);
  if (status >= 500 || status < 0) b.err++;
  if (status >= 400 && status < 500) {
    const code = errCode(json) ?? String(status);
    const k = `${status} ${code}`;
    s.refusals[k] = (s.refusals[k] ?? 0) + 1;
  }
  if ((status >= 500 || status < 0) && errorSamples.length < 40) errorSamples.push({ key, status, body: JSON.stringify(json).slice(0, 300) });
  return { ok: status >= 200 && status < 300, status, json };
}
const errorSamples = [];
/** The API answers { error: { code, message, details: { code? } } }. */
function errCode(json) {
  const e = json?.error;
  if (!e || typeof e !== 'object') return null;
  return e.details?.code ?? e.code ?? null;
}
function errText(json) {
  const e = json?.error;
  return e && typeof e === 'object' ? `${errCode(json)}: ${String(e.message ?? '').slice(0, 110)}` : null;
}

// ── helpers ──────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const ended = () => Date.now() - t0 > RUN_MS + 15 * 60_000; // hard stop: the day + 15 min
const think = () => sleep(Math.max(500, rnd(0.3, 1.7) * STEP_SEC * 1000));
const money = (n) => Math.round(n * 100) / 100;

const PLACES = [
  ['742 Evergreen Ter', 'Springfield', 'IL', '62704'],
  ['1600 Main St', 'Dallas', 'TX', '75201'],
  ['55 Peachtree St NE', 'Atlanta', 'GA', '30303'],
  ['200 E Colfax Ave', 'Denver', 'CO', '80203'],
  ['400 Broad St', 'Charlotte', 'NC', '28202'],
  ['901 Market St', 'Philadelphia', 'PA', '19107'],
  ['3500 Central Ave', 'Phoenix', 'AZ', '85012'],
  ['120 S State St', 'Chicago', 'IL', '60603'],
];
const PROBLEMS = ['Walk-in cooler not holding temp', 'Toilet clogged in men\'s room', 'Front door closer broken', 'Lights out in parking lot', 'Leak under 3-comp sink', 'RTU making loud noise', 'Ceiling tiles stained after rain', 'Hand sink no hot water'];

// ── the shared state the flows read ──────────────────────────────────────────
let STATUS = {}; // name → id
let FORM = null;
const progress = new Map(); // stage → count of WOs that reached it
const stuck = {};
const handoffs = {};
const startupFailures = { n: 0 }; // steps another role had to take because of permissions // "stage: reason" → n
const reach = (stage) => progress.set(stage, (progress.get(stage) ?? 0) + 1);
const stop = (stage, res) => {
  const why = errText(res?.json) ?? '';
  const k = `${stage}: ${res?.status} ${why}`.trim();
  stuck[k] = (stuck[k] ?? 0) + 1;
  return null;
};

let people = [];
const byRole = (...roles) => people.filter((p) => roles.includes(p.role));

// ── the browser loop each person runs ────────────────────────────────────────
// Which queries are live on each page (re-read on every "someone else changed").
function pageQueries(p) {
  const badges = ['/approvals/counts', '/notices/count'];
  switch (p.page.kind) {
    case 'wo': {
      const id = p.page.id;
      return [...badges, `/work-orders/${id}`, `/work-orders/${id}/record`, `/work-orders/${id}/visits`, `/work-orders/${id}/quote`,
        `/work-orders/${id}/messages`, `/work-orders/${id}/approval-tasks`, `/work-orders/${id}/payment-requests`, `/work-orders/${id}/feed`];
    }
    case 'approvals':
      return [...badges, '/approvals', '/quotes', '/payments?status=requested'];
    case 'payments':
      return [...badges, '/payments', '/payments?status=approved'];
    default:
      return [...badges, '/work-orders?limit=50'];
  }
}
async function openPage(p, page) {
  p.page = page;
  await Promise.all(pageQueries(p).map((q) => api(p, 'GET', q)));
}
async function browse(p) {
  await sleep(rnd(0, 3000));
  let lastBadges = Date.now();
  let lastWoPoll = Date.now();
  let lastWander = Date.now();
  const home = p.role === 'ap' ? { kind: 'payments' } : ['atl', 'tl', 'am'].includes(p.role) ? { kind: 'approvals' } : { kind: 'list' };
  await openPage(p, home);
  while (!ended() && !done) {
    const r = await api(p, 'GET', `/activity/since${p.cursor ? `?after=${encodeURIComponent(p.cursor)}` : ''}`);
    if (r.ok && r.json) {
      const changed = p.cursor !== null && r.json.others;
      p.cursor = r.json.cursor ?? p.cursor;
      if (changed) await Promise.all(pageQueries(p).map((q) => api(p, 'GET', q)));
    }
    if (p.page.kind === 'wo' && Date.now() - lastWoPoll > 4000) {
      lastWoPoll = Date.now();
      await api(p, 'GET', `/activity/latest?wo=${encodeURIComponent(p.page.id)}`);
    }
    if (Date.now() - lastBadges > 60_000) {
      lastBadges = Date.now();
      await Promise.all(['/approvals/counts', '/notices/count'].map((q) => api(p, 'GET', q)));
    }
    // People wander: back to their home list now and then, search, open Notifications.
    if (Date.now() - lastWander > rnd(90_000, 240_000)) {
      lastWander = Date.now();
      if (chance(0.3)) await api(p, 'GET', '/notices/inbox?show=unread');
      if (chance(0.3)) await api(p, 'GET', `/work-orders?limit=50&q=${encodeURIComponent(pick(['cooler', 'leak', 'door', 'SIM']))}`);
      await openPage(p, home);
    }
    await sleep(3000);
  }
}

// ── one work order's life ────────────────────────────────────────────────────
async function view(p, woId) {
  // The person opens the work order (unless they are already on it).
  if (p.page.kind === 'wo' && p.page.id === woId) return;
  await openPage(p, { kind: 'wo', id: woId });
}

async function openTaskOf(p, woId, type = 'status_change') {
  const r = await api(p, 'GET', `/work-orders/${woId}/approval-tasks`);
  const items = r.json?.items ?? r.json ?? [];
  return Array.isArray(items) ? items.find((t) => (t.type === type || t.task_type === type) && (t.status === 'open' || t.status === 'pending')) : null;
}

/** A manager decides the open status / visit request on the work order. */
async function managerApproves(mgr, woId, stage, reject = false) {
  await openPage(mgr, { kind: 'approvals' });
  await think();
  const t = await openTaskOf(mgr, woId);
  if (!t) return stop(stage, { status: 'no-open-task' });
  if (reject) {
    const r = await api(mgr, 'POST', `/approval-tasks/${t.id}/reject`, { note: 'Not yet — check with the store first.' });
    return r.ok ? 'rejected' : stop(stage + ' (reject)', r);
  }
  const r = await api(mgr, 'POST', `/approval-tasks/${t.id}/approve`, {});
  return r.ok ? 'approved' : stop(stage, r);
}

async function requestStatus(disp, mgr, woId, name, stage) {
  const sid = STATUS[name];
  if (!sid) return stop(stage, { status: `no status "${name}"` });
  // 8% of requests are turned down once and asked again.
  for (let round = 0; round < 2; round++) {
    const r = await api(disp, 'POST', `/work-orders/${woId}/status-request`, { status_id: sid });
    if (!r.ok) {
      // A dispatcher who may move it directly (no-approval moves) does so.
      const d = await api(disp, 'PATCH', `/work-orders/${woId}/status`, { status_id: sid });
      return d.ok ? 'moved' : stop(stage, r);
    }
    await think();
    const reject = round === 0 && chance(0.08);
    const out = await managerApproves(mgr, woId, stage, reject);
    if (out === 'approved') return out;
    if (out !== 'rejected') return null;
    // The requester reads the rejection and asks again.
    const t = r.json?.item?.id;
    if (t) await api(disp, 'POST', `/approval-tasks/${t}/acknowledge`, {});
    await think();
  }
  return null;
}

async function visitStep(disp, mgr, woId, stage, body, visitId) {
  const r = visitId
    ? await api(disp, 'PATCH', `/visits/${visitId}`, body)
    : await api(disp, 'POST', `/work-orders/${woId}/visits`, body);
  if (!r.ok) return stop(stage, r);
  const v = r.json?.item;
  // Dispatchers are in request mode: the stamp waits for a manager.
  if (v?.pending_request || r.json?.request) {
    await think();
    const out = await managerApproves(mgr, woId, stage);
    if (out !== 'approved') return null;
  }
  return v?.id ?? visitId ?? 'ok';
}

// A 1×1 JPEG: the photo a tech texts in. Real photos are ~1 MB after the
// browser shrinks them; the upload cost here is the request, not the bytes.
const JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
let fakedPhotos = 0;
/** The dispatcher files a photo; a manager looks at it full size and approves it. */
async function photoStep(disp, reviewer, woId, kind, stage) {
  const up = await api(disp, 'POST', `/work-orders/${woId}/attachments`, { file_name: `${kind}-${Date.now()}.jpg`, content_type: 'image/jpeg', data: JPEG, kind });
  if (up.ok) {
    await think();
    await view(reviewer, woId);
    await api(reviewer, 'GET', `/work-orders/${woId}/attachments`);
    const r = await api(reviewer, 'POST', `/work-orders/${woId}/attachments/${up.json.item.id}/review`, { decision: 'approve', kind, viewed: true });
    return r.ok ? 'ok' : stop(stage, r);
  }
  // No file storage on this deployment (local dev): record the approved photo
  // straight in the database so the Done gate can be measured. Counted and
  // said in the report — on the preview, set BLOB_READ_WRITE_TOKEN instead.
  if (errCode(up.json) === 'ATTACHMENT_STORAGE_MISSING' || up.status === 409) {
    const t = await pool.query('SELECT id FROM task WHERE id::text = $1 OR wo_number = $1', [String(woId)]);
    await pool.query(
      `INSERT INTO attachment (task_id, file_name, storage_key, content_type, byte_size, uploaded_by, review_status, kind, reviewed_by, reviewed_at)
       VALUES ($1, $2, $3, 'image/jpeg', 300, $4, 'approved', $5, $6, now())`,
      [t.rows[0].id, `${kind}-sim.jpg`, `sim/${randomUUID()}.jpg`, disp.id, kind, reviewer.id],
    );
    fakedPhotos++;
    return 'faked';
  }
  return stop(stage, up);
}

// A valid US number: area 312, an exchange 200–999 that does not end in 11.
const phone = () => {
  let ex;
  do ex = 200 + Math.floor(Math.random() * 800); while (ex % 100 === 11);
  return `312-${ex}-${String(1000 + Math.floor(Math.random() * 9000))}`;
};

async function workOrderLife(n) {
  const oa = pick(byRole('oa'));
  const disp = pick(byRole('om', 'senior_om', 'om_probation'));
  const atl = pick(byRole('atl'));
  const tl = pick(byRole('tl'));
  const am = pick(byRole('am'));
  const mgr = () => pick([atl, tl]);
  const ap = pick(byRole('ap'));
  const [street, city, state, zip] = pick(PLACES);
  const fieldOpts = (k) => FORM.find((f) => f.key === k)?.options ?? [];
  const unassigned = chance(0.15);
  const now = new Date();
  const fields = {
    '21. Comp': pick(fieldOpts('21. Comp').length ? fieldOpts('21. Comp') : ['SFM']),
    Client: pick(fieldOpts('Client')),
    Store: `Store #${100 + n}`,
    '17. Address': `${street}, ${city}, ${state} ${zip}`,
    City: city, State: state, 'Zip Code': zip,
    Trade: pick(fieldOpts('Trade')),
    '35. WO Description': `${pick(PROBLEMS)} (simulated load test)`,
    'Date-Time Received': now.toISOString(),
    'Due Date': new Date(now.getTime() + 3 * 86400_000).toISOString(),
    '16. Client NTE 🔴': 2500,
    TL: tl.name, ATL: atl.name, AM: am.name,
    ...(unassigned ? {} : { Assignee: disp.name }),
    ...(chance(0.08) ? { Emergency: true } : {}),
  };
  const wo = `SIM-${RUN}-${String(n).padStart(3, '0')}`;

  // 1 · OP Admin raises it.
  await openPage(oa, { kind: 'list' });
  await api(oa, 'GET', '/work-orders/new/form');
  await api(oa, 'GET', `/work-orders/new/check?wo_number=${wo}`);
  const c = await api(oa, 'POST', '/work-orders', { wo_number: wo, fields });
  if (!c.ok) return stop('create', c);
  const woId = c.json?.id ?? c.json?.item?.id ?? c.json?.work_order?.id ?? wo;
  reach('1 created');
  await think();

  // 2 · Unassigned ones are picked up by a manager.
  if (unassigned) {
    const m = mgr();
    await view(m, woId);
    const r = await api(m, 'PATCH', `/work-orders/${woId}/fields`, { values: { 'fields.Assignee': disp.name } });
    if (!r.ok) return stop('assign', r);
    await think();
  }
  reach('2 assigned');

  // 3 · The dispatcher opens it, writes, and asks for Assessment Sched.
  await view(disp, woId);
  await api(disp, 'POST', `/work-orders/${woId}/messages`, { body: `Calling techs for ${fields.Trade} at ${fields.Store}.`, client_visible: false });
  if (chance(0.15)) {
    // An escalation: the store called again.
    await api(disp, 'PATCH', `/work-orders/${woId}/fields`, { values: { 'fields.Escalated': true } });
    reach('(escalated)');
  }
  await think();
  if (!(await requestStatus(disp, mgr(), woId, 'Assessment Sched', 'assessment sched'))) return null;
  reach('3 assessment sched');
  await think();

  // 4 · The tech checks in for the assessment, then out with a quote needed.
  const visit = await visitStep(disp, mgr(), woId, 'assessment check-in', { visit_type: 'Assessment', status: 'checked_in', tech_name: `Tech ${n}`, tech_phone: phone() });
  if (!visit) return null;
  reach('4 on site (assessment)');
  await think();
  if (!(await photoStep(disp, mgr(), woId, 'before', 'before photo'))) return null;
  if (!(await visitStep(disp, mgr(), woId, 'assessment check-out', { status: 'checked_out', checkout_outcome: 'quote' }, visit))) return null;
  reach('5 waiting for quote');
  await think();

  // 5 · The dispatcher writes the quote and submits it for correction. Who
  // may write quotes is the target database's Roles setting: when the
  // assigned dispatcher may not, a Senior OM takes it, else the ATL.
  let writer = null, quote = null, q = null;
  // (A Senior OM not on the job cannot open it, so the hand-off is to the ATL.)
  for (const w of [disp, atl]) {
    await view(w, woId);
    q = await api(w, 'GET', `/work-orders/${woId}/quote`);
    if (!q.json?.quote) q = await api(w, 'POST', `/work-orders/${woId}/quote`, {});
    if (q.json?.quote) { writer = w; quote = q.json.quote; break; }
    if (q.status !== 403) break;
  }
  if (!quote) return stop('quote create', q);
  if (writer !== disp) handoffs[`quote written by ${writer.role} (assigned ${disp.role} may not)`] = (handoffs[`quote written by ${writer.role} (assigned ${disp.role} may not)`] ?? 0) + 1;
  const price = money(rnd(600, 1800));
  const cost = money(price * rnd(0.45, 0.7));
  const sections = (quote.sections ?? []).map((s) => ({
    kind: s.kind,
    name: s.name ?? null,
    scope_lines: s.scope_lines ?? [],
    lines: (s.lines ?? []).map((l) => ({ line_type: l.line_type, description: l.description, qty: Number(l.qty), rate: Number(l.rate), day: l.day ?? 1 })),
  }));
  const opt = sections.find((s) => s.kind === 'option') ?? (sections.push({ kind: 'option', name: null, scope_lines: [], lines: [] }), sections[sections.length - 1]);
  opt.narrative_reported = `${pick(PROBLEMS).toLowerCase()} — part needs replacing`;
  opt.lines = [
    { line_type: 'material', description: 'Replacement part', qty: 1, rate: money(price - 150), day: 1 },
    { line_type: 'fee', description: 'Disposal', qty: 1, rate: 150, day: 1 },
  ];
  // The builder autosaves while typing: a few PUTs, not one.
  for (let i = 0; i < 3; i++) {
    const u = await api(writer, 'PUT', `/work-orders/${woId}/quote`, { sections, total_cost: cost });
    if (!u.ok) return stop('quote save', u);
    await sleep(rnd(1500, 4000));
  }
  const sub = await api(writer, 'POST', `/work-orders/${woId}/quote/submit`, {});
  if (!sub.ok) return stop('quote submit', sub);
  reach('6 quote submitted');
  await think();

  // 6 · A manager sends it to the client; the OP Admin records the client's yes.
  const m = mgr();
  await view(m, woId);
  const send = await api(m, 'POST', `/work-orders/${woId}/quote/send`, {});
  if (!send.ok) return stop('quote send', send);
  reach('7 quote sent');
  await think();
  const sent = send.json?.quote ?? (await api(oa, 'GET', `/work-orders/${woId}/quote`)).json?.quote;
  const option = (sent?.sections ?? []).find((s) => s.kind === 'option');
  await view(oa, woId);
  const ca = await api(oa, 'POST', `/work-orders/${woId}/quote/client-approve`, { section_id: option?.id, note: 'Client approved by email.' });
  if (!ca.ok) return stop('client approval', ca);
  reach('8 approved');
  await think();

  // 7 · Job Sched, the job visit, the payment, the check-out.
  if (!(await requestStatus(disp, mgr(), woId, 'Job Sched', 'job sched'))) return null;
  reach('9 job sched');
  await think();
  const job = await visitStep(disp, mgr(), woId, 'job check-in', { visit_type: 'Job', status: 'checked_in', tech_name: `Tech ${n}`, tech_phone: phone() });
  if (!job) return null;
  reach('10 on site (job)');
  await think();

  await view(disp, woId);
  await api(disp, 'GET', `/work-orders/${woId}/payment-requests/preview?amount=${cost}&method=check`);
  const pr = await api(disp, 'POST', `/work-orders/${woId}/payment-requests`, {
    payee_name: `Tech ${n} LLC`, payee_phone: phone(), purpose: 'J', amount: cost, method: 'check',
    payment_address: { method: 'check', payable_to: `Tech ${n} LLC`, mailing_address: `${street}, ${city}, ${state} ${zip}` },
    submit_key: randomUUID(),
  });
  if (!pr.ok) stop('payment request', pr);
  else {
    reach('11 payment requested');
    const pay = pr.json?.item ?? pr.json;
    let status = pay?.status;
    if (status === 'requested') {
      await think();
      const approver = cost >= 3000 ? tl : pick([atl, tl]);
      await openPage(approver, { kind: 'approvals' });
      const a = await api(approver, 'POST', `/payment-requests/${pay.id}/approve`, {});
      if (a.ok) status = 'approved'; else stop('payment approve', a);
    }
    if (status === 'approved') {
      await think();
      await openPage(ap, { kind: 'payments' });
      const p = await api(ap, 'POST', `/payment-requests/${pay.id}/pay`, {});
      if (p.ok) reach('12 paid'); else stop('payment pay', p);
    }
  }
  await think();

  if (!(await photoStep(disp, mgr(), woId, 'after', 'after photo'))) return null;
  await think();
  const out = await visitStep(disp, mgr(), woId, 'job check-out (Done gate)', { status: 'checked_out', checkout_outcome: 'completed' }, job);
  if (!out) return null;
  reach('13 done');
  await think();

  // 8 · Billing: a manager moves it to Ready to Invoice, one AR raises the
  // invoice, the other sends it, the work order goes Invoiced Not Paid, then
  // the client pays and it is Invoiced. The full cycle.
  const [ar1, ar2] = [...byRole('ar')].sort(() => Math.random() - 0.5);
  const boss = mgr();
  await view(boss, woId);
  const rti = await api(boss, 'PATCH', `/work-orders/${woId}/status`, { status_id: STATUS['Ready to Invoice'] });
  if (!rti.ok) return stop('ready to invoice', rti);
  reach('14 ready to invoice');
  await think();
  const taskUuid = rti.json?.id ?? (await api(ar1, 'GET', `/work-orders/${woId}`)).json?.id;
  await openPage(ar1, { kind: 'list' });
  await api(ar1, 'GET', '/invoices');
  const inv = await api(ar1, 'POST', '/invoices', { task_id: taskUuid });
  if (!inv.ok) return stop('invoice create', inv);
  const invId = inv.json?.invoice?.id ?? inv.json?.item?.id ?? inv.json?.id;
  await think();
  await api(ar2, 'GET', `/invoices/${invId}`);
  const snd = await api(ar2, 'POST', `/invoices/${invId}/send`, {});
  if (!snd.ok) return stop('invoice send', snd);
  reach('15 invoice sent');
  const inp = await api(boss, 'PATCH', `/work-orders/${woId}/status`, { status_id: STATUS['Invoiced Not Paid'] });
  // Some client portals (Corrigo) go straight from Ready to Invoice to Invoiced.
  if (!inp.ok && errCode(inp.json) !== 'STATUS_ORDER') stop('invoiced not paid', inp);
  await think();
  const paid = await api(ar1, 'POST', `/invoices/${invId}/paid`, { reference: `CHK-${n}`, paid_on: new Date().toISOString().slice(0, 10) });
  if (!paid.ok) return stop('invoice paid', paid);
  const fin = await api(boss, 'PATCH', `/work-orders/${woId}/status`, { status_id: STATUS['Invoiced'] });
  if (!fin.ok) return stop('invoiced', fin);
  reach('16 invoiced (finished)');
  return 'ok';
}

// ── progress line ────────────────────────────────────────────────────────────
function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
function progressLine() {
  const recent = timeline.slice(-3).filter(Boolean);
  const n = recent.reduce((s, b) => s + b.n, 0);
  const err = recent.reduce((s, b) => s + b.err, 0);
  const lat = recent.flatMap((b) => b.lat);
  const mins = ((Date.now() - t0) / 60_000).toFixed(1);
  console.log(`[${mins} min] ${(n / 30).toFixed(1)} req/s · p50 ${pct(lat, 50).toFixed(0)} ms · p95 ${pct(lat, 95).toFixed(0)} ms · 5xx/net ${err} · in flight ${inflight} · WOs created ${progress.get('1 created') ?? 0}, done ${progress.get('13 done') ?? 0}, finished ${progress.get('16 invoiced (finished)') ?? 0}`);
}

// ── report ───────────────────────────────────────────────────────────────────
function report() {
  const rows = [...stats.entries()].map(([key, s]) => {
    const n = s.lat.length;
    const bad = Object.entries(s.codes).filter(([c]) => Number(c) >= 500 || Number(c) < 0).reduce((t, [, v]) => t + v, 0);
    return { key, n, p50: pct(s.lat, 50), p95: pct(s.lat, 95), p99: pct(s.lat, 99), max: Math.max(...s.lat), errors: bad, codes: s.codes, refusals: s.refusals };
  }).sort((a, b) => b.n - a.n);
  const all = rows.reduce((a, r) => a + r.n, 0);
  const allLat = [...stats.values()].flatMap((s) => s.lat);
  const errs = rows.reduce((a, r) => a + r.errors, 0);
  const secs = (Date.now() - t0) / 1000;
  const peak = timeline.filter(Boolean).reduce((m, b) => Math.max(m, b.n / 10), 0);
  const summary = {
    run: RUN, base: BASE, db: `${dbHost}/${dbName}`, users: USERS, wos: WOS, minutes: MINUTES, step_sec: STEP_SEC, browse: BROWSE,
    duration_s: Math.round(secs), requests: all, avg_rps: +(all / secs).toFixed(2), peak_rps_10s: +peak.toFixed(1), peak_inflight: peakInflight,
    p50_ms: +pct(allLat, 50).toFixed(0), p95_ms: +pct(allLat, 95).toFixed(0), p99_ms: +pct(allLat, 99).toFixed(0),
    server_errors: errs, error_rate_pct: +((100 * errs) / Math.max(1, all)).toFixed(3),
    photos_recorded_without_storage: fakedPhotos,
    handoffs,
    progress: Object.fromEntries([...progress.entries()].sort()), stuck,
  };
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `sim-${RUN}`);
  writeFileSync(`${file}.json`, JSON.stringify({ summary, endpoints: rows, timeline: timeline.filter(Boolean).map((b) => ({ t: b.t, rps: b.n / 10, p95: pct(b.lat, 95), err: b.err })), errorSamples }, null, 2));
  const md = [
    `# OBI load simulation ${RUN}`, '',
    `- Target: ${BASE} · database ${dbHost}/${dbName}`,
    `- ${USERS} people, ${WOS} work orders over ${MINUTES} min (think time ~${STEP_SEC.toFixed(0)} s), browsing load ${BROWSE ? 'on' : 'off'}`,
    `- ${all} requests in ${Math.round(secs)} s · avg ${summary.avg_rps} req/s · peak ${summary.peak_rps_10s} req/s (10 s) · peak in flight ${peakInflight}`,
    `- Latency p50 ${summary.p50_ms} ms · p95 ${summary.p95_ms} ms · p99 ${summary.p99_ms} ms`,
    `- Server errors / network / timeouts: ${errs} (${summary.error_rate_pct}%)`,
    ...(fakedPhotos ? [`- ${fakedPhotos} photos were recorded straight in the database (this deployment has no file storage), so uploads are NOT in these numbers`] : []), '',
    '## How far the work orders got', '', ...Object.entries(summary.progress).map(([k, v]) => `- ${k}: ${v}`), '',
    '## Steps handed to another role (permissions on this database)', '', ...Object.entries(handoffs).map(([k, v]) => `- ${v} × ${k}`), '',
    '## Where work orders stopped (business refusals, expected ones included)', '', ...Object.entries(stuck).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${v} × ${k}`), '',
    '## Endpoints (by volume)', '', '| endpoint | n | p50 | p95 | p99 | max | 5xx/net | 4xx |', '|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((r) => `| ${r.key} | ${r.n} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.p99.toFixed(0)} | ${r.max.toFixed(0)} | ${r.errors} | ${Object.entries(r.refusals).map(([k, v]) => `${k} ×${v}`).join(', ')} |`),
    '', '## Server error samples', '', ...errorSamples.map((e) => `- ${e.key} → ${e.status}: \`${e.body}\``),
  ].join('\n');
  writeFileSync(`${file}.md`, md);
  console.log('\n' + md.split('## Endpoints')[0]);
  console.log(`Slowest p95 endpoints:`);
  for (const r of [...rows].filter((r) => r.n >= 5).sort((a, b) => b.p95 - a.p95).slice(0, 12)) console.log(`  ${r.p95.toFixed(0).padStart(6)} ms  ${r.key}  (n=${r.n})`);
  console.log(`\nReport: ${file}.md and .json`);
}

// ── main ─────────────────────────────────────────────────────────────────────
let done = false;
async function main() {
  if (flag('cleanup')) { await cleanup(); await pool.end(); return; }
  console.log(`OBI load sim ${RUN}: ${USERS} people, ${WOS} WOs over ${MINUTES} min → ${BASE} (db ${dbHost}/${dbName})`);
  people = await setupPeople();
  console.log(`team: ${teamPlan(USERS).map(([r, k]) => `${k} ${r}`).join(', ')}`);
  const me = await api(people[0], 'GET', '/auth/me');
  if (!me.ok || !me.json?.authenticated) throw new Error(`sim sessions are not accepted by ${BASE} (/auth/me → ${me.status}). Is --db the database that API uses?`);
  const st = await api(byRole('oa')[0], 'GET', '/statuses');
  const list = st.json?.items ?? st.json?.statuses ?? st.json ?? [];
  STATUS = Object.fromEntries(list.map((s) => [s.name, s.id]));
  const f = await api(byRole('oa')[0], 'GET', '/work-orders/new/form');
  FORM = f.json?.fields ?? [];
  if (!FORM.length) throw new Error(`could not read the Add work order form (${f.status})`);

  const ticker = setInterval(progressLine, 30_000);
  const browsers = BROWSE ? people.map((p) => browse(p).catch((e) => console.error('browse', e))) : [];
  // Work orders arrive across the day, a little bunched like a real inbox.
  const flows = [];
  for (let i = 1; i <= WOS; i++) {
    const at = (RUN_MS * 0.6 * (i - 1)) / Math.max(1, WOS - 1) + rnd(-0.02, 0.02) * RUN_MS; // the first 60% of the day
    flows.push(sleep(Math.max(0, at)).then(() => workOrderLife(i)).catch((e) => { stop('crash', { status: String(e?.message ?? e).slice(0, 80) }); }));
  }
  await Promise.all(flows);
  // Keep browsing until the day is over, so the tail is measured too.
  while (Date.now() - t0 < RUN_MS) await sleep(1000);
  done = true;
  clearInterval(ticker);
  await Promise.all(browsers);
  report();
  await pool.end();
}
process.on('SIGINT', () => { console.log('\ninterrupted — writing the report'); done = true; report(); process.exit(130); });
main().catch(async (e) => { console.error(e); try { await pool.end(); } catch {} process.exit(1); });

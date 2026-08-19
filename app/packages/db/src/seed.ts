// Seed — loads seed/clickup-data.json → rows, per SPRINT1-SPEC §4.
// Idempotent: TRUNCATE … RESTART IDENTITY CASCADE, then insert. Re-seeding is safe.
//
// Single-writer: run via `npm run db:seed` (short-lived; opens pgdata, writes, exits).
// Never run while the API is up.

import { exec, query, closePool } from './client.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATUS_GROUP_BY_TYPE, type StatusGroup } from '@theone/shared';
// S5 · the demo-state anchors below are computed with the SAME business-time
// arithmetic the obligation engine evaluates with, so the seeded tiers are
// exact rather than approximated by calendar offsets — a 4-business-hour clock
// has a tier-2 window only four business hours wide, which no "n days ago"
// subtraction can hit reliably. Relative path because this is dev-only tooling
// run by tsx; the module is dependency-free by design (see its header).
import {
  subBusinessMs,
  diffBusinessMs,
  businessHours,
  chicagoWallToInstant,
  toWall,
} from '../../../apps/api/src/lib/businessTime.js';

// ── Source data ──────────────────────────────────────────────────────────────
interface ClickupStatus { name: string; type: string; order: number; color: string }
interface ClickupField { name: string; type: string; options?: string[] }
interface ClickupList { name: string; tasks: number }
interface ClickupFolder { folder: string; lists: ClickupList[] }
interface ClickupPerson { name: string; initials: string; role: string; email: string }
interface ClickupTask {
  id: string;
  name: string;
  status: string;
  list: string;
  created: string;
  due: string;
  assignees: string[];
  tags: string[];
  priority: string | null;
  fields: Record<string, unknown>;
}
interface ClickupData {
  statuses: ClickupStatus[];
  fields: ClickupField[];
  taskSamples: ClickupTask[];
  routing: ClickupFolder[];
  people: ClickupPerson[];
}

const DATA_PATH = fileURLToPath(new URL('../seed/clickup-data.json', import.meta.url));
const data: ClickupData = JSON.parse(readFileSync(DATA_PATH, 'utf8'));

// ── Helpers ──────────────────────────────────────────────────────────────────
async function insertId(sql: string, params: unknown[]): Promise<string> {
  const res = await query<{ id: string }>(sql, params);
  return res.rows[0].id;
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '.');
}

/** ClickUp field type → our field_type enum. */
const FIELD_TYPE_MAP: Record<string, string> = {
  attachment: 'attachment',
  checkbox: 'checkbox',
  drop_down: 'dropdown',
  short_text: 'short_text',
  text: 'long_text',
  date: 'date',
  users: 'users',
  formula: 'formula',
  number: 'number',
  currency: 'currency',
  location: 'location',
  url: 'url',
  emoji: 'rating',
};

/** Non-canonical sample status strings → canonical status name. */
const STATUS_ALIAS: Record<string, string> = {
  '!! approved': 'approved',
  invoiced: 'invoiced', // the archive terminal status seeded below
};

function firstLine(text: string | undefined, fallback: string): string {
  if (!text) return fallback;
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return fallback;
  return line.length > 120 ? line.slice(0, 120) : line;
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length > 0 ? s : null;
}

// ── Vendors (§4.7) ───────────────────────────────────────────────────────────
const VENDORS: { name: string; trades: string[]; phone: string | null; city: string; state: string }[] = [
  { name: 'Eon Electric', trades: ['Electric'], phone: '(801) 615-1560', city: 'Provo', state: 'UT' },
  { name: 'AAA Plumbing', trades: ['Plumbing'], phone: null, city: 'San Antonio', state: 'TX' },
  { name: 'O5 Plumbing', trades: ['Plumbing'], phone: '(210) 899-2474', city: 'San Antonio', state: 'TX' },
  { name: "Don's Electrical & Handyman Service", trades: ['Electric', 'Handyman'], phone: null, city: 'Mankato', state: 'MN' },
  { name: 'Nick Handyman', trades: ['Handyman'], phone: null, city: 'Medford', state: 'MA' },
  { name: 'Seeder and Son', trades: ['Handyman', 'Roofing'], phone: null, city: 'Saint Louis', state: 'MO' },
  { name: 'Electrical Services LLC', trades: ['Electric'], phone: null, city: 'Mankato', state: 'MN' },
  { name: 'Amigo Appliance', trades: ['Appliance'], phone: null, city: 'Manteca', state: 'CA' },
  // S3 — the refrigeration tech on WO-39403's Quo thread (§S3 seed, below).
  { name: 'Gulf Coast Refrigeration LLC', trades: ['Refrigeration'], phone: '(409) 555-0143', city: 'Galveston', state: 'TX' },
];

const QUO_VENDOR_NAME = 'Gulf Coast Refrigeration LLC';
const QUO_WO_NUMBER = 'WO-39403';

// ── S3 · the demo Quo thread (copy + timestamps VERBATIM from the approved
//    Messages comp, messages-comp.tpl.html) ───────────────────────────────────
//
// Timestamps are stored as absolute UTC instants and the API renders them back
// as ISO-8601 UTC, so "2026-07-15T09:12:00Z" is what the comp shows as
// "Jul 15 · 09:12" — no timezone maths anywhere in the chain.
//
// Transcripts are seeded at FULL length: the comp shows the first two lines and
// derives "18 more lines" / "9 more lines" from the remaining entries, so the
// arrays below must hold 2 + 18 = 20 and 2 + 9 = 11 entries respectively.
const TECH = 'Gulf Coast';
const DISP = 'M. Hammond';

const CALL_1_TRANSCRIPT: { speaker: string; line: string }[] = [
  { speaker: TECH, line: "I'm out front at the Seawall store — who do I see about getting into the back stockroom?" },
  { speaker: DISP, line: "Ask for Dana at the counter, she's expecting you. What's the case reading when you get eyes on it?" },
  { speaker: TECH, line: "Give me two minutes, I'm walking it now." },
  { speaker: DISP, line: "Take your time — it's the standing freezer on the customer-facing side, the ice cream door." },
  { speaker: TECH, line: 'Got it. Door gasket looks fine, no frost on the seal.' },
  { speaker: DISP, line: 'Store manager says it started Sunday overnight.' },
  { speaker: TECH, line: 'That tracks. Display shelf is reading +18, should be sitting at zero.' },
  { speaker: DISP, line: 'Is the product still salvageable?' },
  { speaker: TECH, line: "Top two racks are soft. They'll want to pull those." },
  { speaker: DISP, line: "I'll note it on the WO. Any noise off the condenser?" },
  { speaker: TECH, line: "Nothing — and that's the part I don't like. Fan should be running with the coil this cold." },
  { speaker: DISP, line: "So it's stuck in defrost?" },
  { speaker: TECH, line: "Looks that way. Coil's iced over solid, front to back." },
  { speaker: DISP, line: 'Can you pull the panel and confirm before you price anything?' },
  { speaker: TECH, line: "Doing that now. I'll send photos once I have the coil open." },
  { speaker: DISP, line: 'Send them to this number and they land straight on the work order.' },
  { speaker: TECH, line: "Will do. Give me an hour on the diagnosis — it's a full defrost cycle to clear the ice." },
  { speaker: DISP, line: "That's fine, the store is 24h so there's no access window to worry about." },
  { speaker: TECH, line: 'One more thing — is this the same 7-Eleven that had the walk-in last spring?' },
  { speaker: DISP, line: "Same store, different box. I'll pull that history and text you the old WO number." },
];

const CALL_2_TRANSCRIPT: { speaker: string; line: string }[] = [
  { speaker: DISP, line: 'Running your $1,450 into the client quote at $2,890 — anything else on the coil clean?' },
  { speaker: TECH, line: "That covers it. Hold Thursday for me and I'll pull the motor off the shelf Wednesday night." },
  { speaker: DISP, line: 'Start kit included in that number?' },
  { speaker: TECH, line: 'Included. Motor, start kit and the full clean, one trip.' },
  { speaker: DISP, line: 'How long are you on site Thursday?' },
  { speaker: TECH, line: "Four hours, maybe five if the drain line's packed." },
  { speaker: DISP, line: "Bill the drain line separately if it is — don't eat it." },
  { speaker: TECH, line: 'Understood.' },
  { speaker: DISP, line: "Quote goes to 7-Eleven this morning. They're usually 48 hours." },
  { speaker: TECH, line: "If it slips past Thursday I'm into next week — I have a PM route Friday." },
  { speaker: DISP, line: "Noted. I'll flag it urgent on our side." },
];

const QUO_CALLS: {
  direction: 'in' | 'out';
  duration_seconds: number;
  ai_summary: string;
  transcript: { speaker: string; line: string }[];
  occurred_at: string;
}[] = [
  {
    direction: 'in',
    duration_seconds: 272, // 4m 32s
    ai_summary: 'Tech on site, freezer stuck in defrost, needs assessment access.',
    transcript: CALL_1_TRANSCRIPT,
    occurred_at: '2026-07-15T09:12:00Z',
  },
  {
    direction: 'out',
    duration_seconds: 125, // 2m 05s
    ai_summary: 'Confirmed scope and pricing, tech holding Thursday slot.',
    transcript: CALL_2_TRANSCRIPT,
    occurred_at: '2026-07-16T10:02:00Z',
  },
];

// The comp's thread carries FIVE quo_message rows — four plain SMS plus one MMS
// — and its own right rail counts them as "Texts 5 · Photos 2". So `texts` is
// every message row and `photos` is the total media count; that is the comp's
// arithmetic, reproduced exactly. (The S3 brief's "5 texts + 1 MMS = 6 rows"
// double-counts the MMS: adding a sixth bubble would put copy on screen that the
// founder never approved. Flagged for the orchestrator.)
const QUO_MESSAGES: {
  direction: 'in' | 'out';
  body: string;
  media: { name: string; label: string }[];
  occurred_at: string;
}[] = [
  {
    direction: 'in',
    body: "On site. Freezer's stuck in defrost, coil is iced solid. Getting photos now.",
    media: [],
    occurred_at: '2026-07-15T09:34:00Z',
  },
  {
    direction: 'in',
    body: 'Coil and the case temp — reading +18°F at the display shelf.',
    media: [
      { name: 'coil-iced.jpg', label: 'Coil' },
      { name: 'case-temp.jpg', label: 'Case' },
    ],
    occurred_at: '2026-07-15T09:41:00Z',
  },
  {
    direction: 'out',
    body: "Got them. Can you price out motor + start kit while you're there?",
    media: [],
    occurred_at: '2026-07-15T10:02:00Z',
  },
  {
    direction: 'in',
    body: 'Condenser fan motor seized. Motor + start kit + full coil clean. $1,450 parts+labor my side, 1 day, need approval before Thursday.',
    media: [],
    occurred_at: '2026-07-15T16:48:00Z',
  },
  {
    direction: 'out',
    body: "Confirmed — quote's with 7-Eleven for approval. Hold Thursday, I'll call you the second it lands.",
    media: [],
    occurred_at: '2026-07-16T10:08:00Z',
  },
];

// ── S4 · ROLES ───────────────────────────────────────────────────────────────
// Role gates ship before auth (S5): until then `principal.role` IS the
// permission. The ClickUp export only knows admin/member/owner, so the operating
// hierarchy is applied here — and migration 0003 carries the SAME statements for
// a pgdata that is migrated but never re-seeded. Keep the two in step.
//   quote create/edit  : senior_om | atl | tl | am | admin
//   quote approve/send :             atl | tl | am | admin
const ROLE_BY_NAME: Record<string, string> = {
  'Jordan Brown': 'admin', // default X-Actor-Id principal
  Elise: 'atl', // approves and sends
  'Matt Hammond': 'senior_om', // builds the quotes — WO-39403's dispatcher
  'Peter Hope': 'am',
  'Zach Malden': 'tl',
};
/** Everyone else: a plain ClickUp 'member' is a dispatcher/OM — BELOW the
 *  builder gate, which is what makes the 403 path testable. 'owner' is admin. */
const ROLE_BY_CLICKUP_ROLE: Record<string, string> = { member: 'om', owner: 'admin' };

// ── S4 · the demo QUOTE for WO-39403 (copy VERBATIM from the approved comp,
//    quote-comp.tpl.html) ─────────────────────────────────────────────────────
//
// Amounts are NEVER seeded: every line carries qty/rate/ot and the API computes
// qty × rate × (ot ? 1.5 : 1). The numbers below are therefore the ONLY inputs,
// and they must reproduce the comp exactly:
//   incurred  75 + 180 + (2.5 × 180 × 1.5 = 675)          = $930.00
//   Option A  830 + 260 + (6 × 180) + (4 × 180)           = $2,890.00
//   grand total (RULE B — included options only)          = $2,890.00
//
// The comp's Option A line 5 ("R-404A refrigerant, 4 lb", rate blank) is a
// VALIDATION demo, not data: it is the screenshot's "1 field needs attention"
// state. Seeding it would put a permanently invalid row in the demo quote, so
// the seed carries the four priced lines and the comp's $2,890 total.
const QUOTE_INCURRED_NARRATIVE =
  'the customer-facing standing freezer at the front of the store was reading +18°F and would not pull down. On arrival the evaporator was iced over and the condenser fan motor was seized — windings read open and the blade would not turn by hand. The compressor cycles on the start capacitor but drops out on overload after roughly 40 seconds, and condenser ambient measured 118°F with the fan down. Product on the top two racks has softened; the store moved the ice cream to the walk-in overnight. Case is safe to leave off until parts land.';

const QUOTE_SCOPE_LINES = [
  'Replace the seized condenser fan motor with the OEM assembly and a new blade.',
  'Install a hard-start kit (start capacitor + potential relay) to take load off the compressor.',
  'Defrost and clear the iced evaporator, then verify defrost heater and termination switch operation.',
  'Evacuate, weigh in the R-404A charge to nameplate and leak-check every joint disturbed.',
  'Run the case 60 minutes and log pull-down to +2°F before leaving site; photo the final temp.',
];

const QUOTE_OPTION_A_NARRATIVE =
  'Return with the OEM condenser fan motor assembly and a hard-start kit. Pull and replace the seized motor and blade, install the start capacitor and potential relay, clear the iced evaporator and confirm the defrost cycle terminates, then evacuate and weigh in the R-404A charge to nameplate. Commission the case and log a 60-minute pull-down to +2°F before leaving site. Parts carry a 12-month manufacturer warranty; our labour carries the standard 30-day workmanship warranty.';

const QUOTE_SPECS = [
  'Case: True GDM-49F, S/N 8814-C2, R-404A.',
  'Motor: 1/15 HP 208-230V CW, OEM #833-2244.',
  'Start kit: SPP6 + PR-90 relay.',
  'Nameplate charge 2 lb 6 oz.',
].join('\n');

const QUOTE_NOTE_TO_CUSTOMER =
  'Parts are stocked in Houston — we can be back on site the morning after approval. Store can keep product in the walk-in until then.';

interface SeedLine {
  line_type: 'service' | 'labor' | 'part' | 'material';
  description: string;
  qty: number;
  rate: number;
  day_value: string;
  ot: boolean;
}

const QUOTE_INCURRED_LINES: SeedLine[] = [
  { line_type: 'service', description: 'Trip — dispatch to site, Galveston', qty: 1, rate: 75, day_value: 'Day 1', ot: false },
  { line_type: 'labor', description: 'Tech 1 — diagnostic & temp logging', qty: 1, rate: 180, day_value: 'Day 1', ot: false },
  { line_type: 'labor', description: 'Tech 2 — after-hours assist', qty: 2.5, rate: 180, day_value: 'Day 1', ot: true },
];

const QUOTE_OPTION_A_LINES: SeedLine[] = [
  { line_type: 'part', description: 'Condenser fan motor, OEM', qty: 1, rate: 830, day_value: 'Day 2', ot: false },
  { line_type: 'part', description: 'Hard-start kit + relay', qty: 1, rate: 260, day_value: 'Day 2', ot: false },
  { line_type: 'labor', description: 'Tech 1 — install', qty: 6, rate: 180, day_value: 'Day 2', ot: false },
  { line_type: 'labor', description: 'Tech 2 — assist & brazing', qty: 4, rate: 180, day_value: 'Day 2', ot: false },
];

// ── S4 · the comp's "Previous payments on this work order" table ─────────────
// Both are PAID, so the screen's "Total paid on this WO" and "Payables total"
// both read $475.00 — exactly what the comp shows.
const SEED_PAYMENTS: {
  purpose: string;
  amount: number;
  method: string;
  status: string;
  created_at: string;
}[] = [
  { purpose: 'Assessment trip charge', amount: 75, method: 'Zelle', status: 'paid', created_at: '2026-07-15T14:20:00Z' },
  { purpose: 'Parts advance', amount: 400, method: 'ACH', status: 'paid', created_at: '2026-07-22T16:05:00Z' },
];

// ── S5 · THE DEMO STATE ──────────────────────────────────────────────────────
// The obligation engine derives everything from CURRENT DB STATE, so the seed
// does not create a single obligation row — it creates the WORLD that implies
// them, and the first read of /api/pulse materialises the lot.
//
// Every anchor below is expressed as "N business hours before the seed ran",
// measured with the engine's own clock. That is what makes the demo tiers
// deterministic on a Tuesday morning and on a Saturday night alike: a clock
// rewound 22 business hours against a 20-business-hour budget is at 110% of its
// budget whenever you seed it.
//
// Each anchor also carries HEADROOM — the ratio is placed well inside its tier
// band so that hours of demo drift (or a founder who seeds tonight and presents
// tomorrow) cannot tip a card into the next colour. The one deliberate
// exception is WO-40356, parked low in tier 0 so the board visibly climbs.
//
//   rule                subject             ratio at seed   tier   headroom
//   emergency_ack       WO-39422            2.5x (24/7)      3     terminal
//   sla_blown           WO-39457            ~2.6x            3     terminal
//   approval_followup   WO-39403            1.2x             2     40 bus. hours
//   quote_review_owed   WO-39403's quote    1.25x            2     3 bus. hours
//   quote_owed          WO-39457            1.1x             2     18 bus. hours
//   payment_processing  WO-39403 parts run  1.1x             2     18 bus. hours
//   approval_followup   WO-40127            0.82x            1     9 bus. hours
//   schedule_owed       WO-40356            0.1x             0     1.4 bus. hours
//   quote_owed          WO-39440            0.2x             0     12 bus. hours
//   payment_processing  WO-39440 trip       0.1x             0     14 bus. hours
const S5 = {
  EMERGENCY_WO: 'WO-39422',
  QUOTE_OWED_TIER0_WO: 'WO-39440',
  QUOTE_OWED_TIER2_WO: 'WO-39457',
  APPROVAL_TIER2_WO: 'WO-39403',
  APPROVAL_TIER1_WO: 'WO-40127',
  SCHEDULE_TIER0_WO: 'WO-40356',
  /** 24/7 clock, 2h budget → 2.5x. Emergencies have no "mildly late" tier. */
  EMERGENCY_AGE_HOURS: 5,
  /** 5 business days = 50h budget → 60/50 = 1.2x. */
  APPROVAL_TIER2_AGE: 60,
  /** 50h budget → 41/50 = 0.82x, the storm front. */
  APPROVAL_TIER1_AGE: 41,
  /** 4h budget → 5/4 = 1.25x. */
  QUOTE_REVIEW_AGE: 5,
  /** 2 business days = 20h budget → 22/20 = 1.1x. */
  QUOTE_OWED_TIER2_AGE: 22,
  /** 20h budget → 4/20 = 0.2x. */
  QUOTE_OWED_TIER0_AGE: 4,
  /** 2h budget → 0.2/2 = 0.1x; climbs to tier 1 after ~1.4 business hours. */
  SCHEDULE_AGE: 0.2,
  /** 20h budget → 1.1x and 0.1x. */
  PAYMENT_TIER2_AGE: 22,
  PAYMENT_TIER0_AGE: 2,
  /** Calendar days back for the blown SLA — last-resort fallback only. */
  SLA_DAYS_AGO: 4,
  /**
   * Business hours the SLA's 18:00 close must already be behind us. With the
   * rule's 10-business-hour grace this is progress = (10 + 16) / 10 = 2.6x —
   * tier 3 with six business hours of headroom below the boundary, on every
   * weekday and at every hour of the day.
   */
  SLA_PAST_DUE_HOURS: 16,
};

/** The three work orders S5 adds, so the demo has an emergency and live quotes. */
const S5_TASKS: {
  wo_number: string;
  ext_name: string;
  title: string;
  description: string;
  status: string;
  list: string;
  client: string;
  city: string;
  state: string;
  trade: string;
  nte: number;
  priority: string;
  extraFields?: Record<string, unknown>;
}[] = [
  {
    wo_number: 'WO-39422',
    ext_name: 'WOT0468110',
    title: 'Walk-in cooler down — product at risk',
    description:
      'Walk-in cooler (back of house) is at +48°F and climbing. Store has moved what it can to the reach-ins.\n\nCalled in as an emergency by the store manager.',
    status: 'emergency',
    list: 'Matt Hammond',
    client: '7-Eleven',
    city: 'SAN ANTONIO',
    state: 'TX',
    trade: 'Refrigeration',
    nte: 2500,
    priority: 'high',
  },
  {
    wo_number: 'WO-39440',
    ext_name: 'DG-771204',
    title: 'Reach-in freezer not holding temp — quote requested',
    description:
      'Reach-in freezer on the beverage aisle is running warm. Client has asked for a quote before any work is authorised.',
    status: 'waiting for quote',
    list: 'Zach Malden',
    client: 'Dollar General',
    city: 'MANKATO',
    state: 'MN',
    trade: 'Refrigeration',
    nte: 1800,
    priority: 'normal',
  },
  {
    wo_number: 'WO-39457',
    ext_name: 'ALD-55913',
    title: 'Parking lot pole light out — quote requested',
    description:
      'Two pole lights on the north row of the lot are out. Client wants a quote covering both, including the lift.',
    status: 'waiting for quote',
    list: 'John Hayes',
    client: 'ALDI',
    city: 'SAINT LOUIS',
    state: 'MO',
    trade: 'Electric',
    nte: 1200,
    priority: 'high',
  },
];

/** The Chicago calendar date of an instant, as the 'YYYY-MM-DD' fields carry. */
function chicagoDate(at: Date): string {
  const wall = new Date(toWall(at.getTime()));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`;
}

async function main() {


  // ── 0. Idempotent reset ────────────────────────────────────────────────────
  await exec(`
    TRUNCATE TABLE
      quote_line, quote_section, quote, payment_request,
      quo_message, quo_call, quo_job_segment, quo_conversation,
      attachment, payable, vendor, comment, activity_log,
      task_list_membership, task, field_def, status, status_set,
      principal, container
    RESTART IDENTITY CASCADE;
  `);

  // ── 1. Hierarchy (§4.1) ────────────────────────────────────────────────────
  const workspaceId = await insertId(
    `INSERT INTO container (kind, name, ext_ref) VALUES ('workspace', $1, $1) RETURNING id`,
    ['Seamless FM'],
  );
  const spaceId = await insertId(
    `INSERT INTO container (kind, parent_id, name, ext_ref) VALUES ('space', $1, $2, $2) RETURNING id`,
    [workspaceId, 'Vista Operations'],
  );

  const listIdByName = new Map<string, string>();
  let listCount = 0;
  for (const folder of data.routing) {
    const folderId = await insertId(
      `INSERT INTO container (kind, parent_id, name, ext_ref) VALUES ('folder', $1, $2, $2) RETURNING id`,
      [spaceId, folder.folder],
    );
    for (const list of folder.lists) {
      const listId = await insertId(
        `INSERT INTO container (kind, parent_id, name, ext_ref) VALUES ('list', $1, $2, $2) RETURNING id`,
        [folderId, list.name],
      );
      listIdByName.set(list.name, listId);
      listCount++;
    }
  }

  // ── 2. Principals (§4.6) ───────────────────────────────────────────────────
  const principalIdByName = new Map<string, string>();
  for (const p of data.people) {
    const email = `${slug(p.name)}${p.email}`;
    // S4: the operating role, not the ClickUp seat type (see ROLE_BY_NAME).
    const role = ROLE_BY_NAME[p.name] ?? ROLE_BY_CLICKUP_ROLE[p.role] ?? p.role;
    const id = await insertId(
      `INSERT INTO principal (kind, display_name, email, role, initials)
       VALUES ('human', $1, $2, $3, $4) RETURNING id`,
      [p.name, email, role, p.initials],
    );
    principalIdByName.set(p.name, id);
  }
  const seedBotId = await insertId(
    `INSERT INTO principal (kind, display_name, role, initials) VALUES ('service', $1, 'service', 'SB') RETURNING id`,
    ['Seed Bot'],
  );
  await insertId(
    `INSERT INTO principal (kind, display_name, role, initials) VALUES ('service', $1, 'service', 'N8') RETURNING id`,
    ['n8n Automation'],
  );
  const defaultActorId = principalIdByName.get('Jordan Brown');
  if (!defaultActorId) throw new Error('Jordan Brown principal not found — default actor missing');

  // ── 3. Statuses (§4.2) ─────────────────────────────────────────────────────
  const statusSetId = await insertId(
    `INSERT INTO status_set (container_id, name) VALUES ($1, $2) RETURNING id`,
    [spaceId, 'Vista WO Pipeline'],
  );

  const statusIdByName = new Map<string, string>();
  const statusGroupById = new Map<string, StatusGroup>();
  for (const s of data.statuses) {
    const group = STATUS_GROUP_BY_TYPE[s.type];
    if (!group) throw new Error(`Unknown ClickUp status type: ${s.type}`);
    const id = await insertId(
      `INSERT INTO status (status_set_id, name, status_group, color, position, is_archive)
       VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [statusSetId, s.name, group, s.color, s.order],
    );
    statusIdByName.set(s.name, id);
    statusGroupById.set(id, group);
  }
  // Archive terminal status "invoiced" (20th) — §4.2 / §10 decision.
  {
    const id = await insertId(
      `INSERT INTO status (status_set_id, name, status_group, color, position, is_archive)
       VALUES ($1, 'invoiced', 'done', '#656f7d', 19, true) RETURNING id`,
      [statusSetId],
    );
    statusIdByName.set('invoiced', id);
    statusGroupById.set(id, 'done');
  }

  function resolveStatusId(raw: string): string {
    const canonical = STATUS_ALIAS[raw] ?? raw;
    const id = statusIdByName.get(canonical);
    if (!id) throw new Error(`Cannot resolve status "${raw}" (canonical "${canonical}")`);
    return id;
  }

  // ── 4. Field definitions (§4.3) ────────────────────────────────────────────
  let fieldCount = 0;
  let position = 0;
  for (const f of data.fields) {
    const type = FIELD_TYPE_MAP[f.type];
    if (!type) throw new Error(`Unknown ClickUp field type: ${f.type}`);
    let typeConfig: Record<string, unknown> = {};
    if (f.type === 'drop_down' && f.options) typeConfig = { options: f.options };
    else if (f.type === 'formula') typeConfig = { formula: true };
    await query(
      `INSERT INTO field_def (container_id, key, label, type, type_config, position)
       VALUES ($1, $2, $2, $3, $4::jsonb, $5)`,
      [spaceId, f.name, type, JSON.stringify(typeConfig), position++],
    );
    fieldCount++;
  }

  // ── 5. Tasks (§4.4) + memberships (§4.5) + created activity (§4.9) ──────────
  let taskCount = 0;
  let membershipCount = 0;
  let activityCount = 0;
  const taskIdByWo = new Map<string, string>();
  const taskMeta = new Map<string, { statusName: string; fields: Record<string, unknown> }>();

  for (const t of data.taskSamples) {
    const f = t.fields ?? {};
    const description = str(f['35. WO Description']);
    const title = firstLine(description ?? undefined, t.name);
    const canonicalStatus = STATUS_ALIAS[t.status] ?? t.status;
    const statusId = resolveStatusId(t.status);
    const statusGroup = statusGroupById.get(statusId)!;
    const homeListId = listIdByName.get(t.list) ?? null;
    const createdAt = toDate(t.created);

    const taskId = await insertId(
      `INSERT INTO task (
         wo_number, ext_name, title, description, home_list_id, status_id, status_group,
         billing_entity, client, trade, city, state, nte, date_received,
         fields, priority, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12, $13, $14,
         $15::jsonb, $16, COALESCE($17::timestamptz, now())
       ) RETURNING id`,
      [
        t.id,
        t.name,
        title,
        description,
        homeListId,
        statusId,
        statusGroup,
        str(f['21. Comp']),
        str(f['Client']),
        str(f['Trade']),
        str(f['City']),
        str(f['State']),
        toNumber(f['16. Client NTE 🔴']),
        toDate(f['Date-Time Received']),
        JSON.stringify(f),
        t.priority,
        createdAt,
      ],
    );
    taskIdByWo.set(t.id, taskId);
    taskMeta.set(t.id, { statusName: canonicalStatus, fields: f });
    taskCount++;

    if (homeListId) {
      await query(
        `INSERT INTO task_list_membership (task_id, list_id, is_home) VALUES ($1, $2, true)`,
        [taskId, homeListId],
      );
      membershipCount++;
    }

    // Seeded 'created' activity, attributed to Seed Bot.
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after)
       VALUES ($1, 'task', $2, 'created', $3::jsonb)`,
      [seedBotId, taskId, JSON.stringify({ status_id: statusId, status_name: canonicalStatus })],
    );
    activityCount++;
  }

  // ── 6. Vendors (§4.7) ──────────────────────────────────────────────────────
  const vendorIds: string[] = [];
  const vendorIdByName = new Map<string, string>();
  for (const v of VENDORS) {
    const id = await insertId(
      `INSERT INTO vendor (name, trades, phone, city, state)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [v.name, v.trades, v.phone, v.city, v.state],
    );
    vendorIdByName.set(v.name, id);
    // Gulf Coast is deliberately kept OUT of the §4.8 payable round-robin: the
    // Messages correlation is payable.vendor_id → quo_conversation.vendor_id, so
    // handing Gulf Coast to some other WO would give that WO a conversation too.
    if (v.name !== QUO_VENDOR_NAME) vendorIds.push(id);
  }

  // ── 7. Payables (§4.8) — a handful for done/incurred|invoiced with cost>0 ──
  let payableCount = 0;
  let vi = 0;
  for (const t of data.taskSamples) {
    if (payableCount >= 6) break;
    const meta = taskMeta.get(t.id)!;
    if (meta.statusName !== 'done/incurred' && meta.statusName !== 'invoiced') continue;
    const cost = toNumber(meta.fields['34. Cost']);
    if (cost === null || cost <= 0) continue;
    const vendorId = vendorIds[vi % vendorIds.length];
    vi++;
    const payStatus = meta.statusName === 'invoiced' ? 'paid' : 'approved';
    await query(
      `INSERT INTO payable (task_id, vendor_id, amount, status)
       VALUES ($1, $2, $3, $4)`,
      [taskIdByWo.get(t.id), vendorId, cost, payStatus],
    );
    payableCount++;
  }

  // ── 8. S3 · the Quo conversation mirror for WO-39403 ───────────────────────
  // Correlation seam: WO → payable.vendor_id → vendor → quo_conversation.
  // WO-39403 is the ONLY seeded WO with a tech payable pointing at Gulf Coast,
  // so it is the only WO whose Messages tab resolves a conversation; every other
  // WO returns conversation:null.
  const quoVendorId = vendorIdByName.get(QUO_VENDOR_NAME);
  if (!quoVendorId) throw new Error(`Vendor "${QUO_VENDOR_NAME}" not seeded`);
  const quoTaskId = taskIdByWo.get(QUO_WO_NUMBER);
  if (!quoTaskId) throw new Error(`Task ${QUO_WO_NUMBER} not seeded`);

  // The tech's side of the job ($1,450 per the thread) — this row IS the link.
  await query(
    `INSERT INTO payable (task_id, vendor_id, amount, status) VALUES ($1, $2, $3, 'pending')`,
    [quoTaskId, quoVendorId, 1450],
  );
  payableCount++;

  const conversationId = await insertId(
    `INSERT INTO quo_conversation (vendor_id, counterparty_phone, quo_line_label, claimed_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [quoVendorId, '(409) 555-0143', 'Dispatch TX-01', 'Matt Hammond'],
  );

  await query(
    `INSERT INTO quo_job_segment (conversation_id, label, started_at)
     VALUES ($1, 'Assessment visit', $2::timestamptz)`,
    [conversationId, '2026-07-15T09:00:00Z'],
  );

  for (const c of QUO_CALLS) {
    await query(
      `INSERT INTO quo_call (conversation_id, direction, duration_seconds, ai_summary, transcript, occurred_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
      [conversationId, c.direction, c.duration_seconds, c.ai_summary, JSON.stringify(c.transcript), c.occurred_at],
    );
  }

  // Seeded traffic is real traffic: delivered, nothing pending. Only messages
  // composed in The One (POST /messages) carry pending_sync=true.
  for (const m of QUO_MESSAGES) {
    await query(
      `INSERT INTO quo_message (conversation_id, direction, body, media, delivered, pending_sync, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, true, false, $5::timestamptz)`,
      [conversationId, m.direction, m.body, JSON.stringify(m.media), m.occurred_at],
    );
  }

  // ── 9. S4 · the demo quote + payment ledger for WO-39403 ───────────────────
  // Status is pending_approval: the WO-39403 demo opens on the screenshot's
  // state — Matt (senior_om) has submitted, Elise (atl) has not yet approved.
  // Rev 3 matches the comp's header chip.
  const mattId = principalIdByName.get('Matt Hammond');
  if (!mattId) throw new Error('Matt Hammond principal not found — quote author missing');

  const quoteId = await insertId(
    `INSERT INTO quote (task_id, status, rev, sales_tax, total_cost, specs, note_to_customer, created_by)
     VALUES ($1, 'pending_approval', 3, 0, 1610, $2, $3, $4) RETURNING id`,
    [quoTaskId, QUOTE_SPECS, QUOTE_NOTE_TO_CUSTOMER, mattId],
  );

  // The "Required is to…" scope list lives on the INCURRED section (that is
  // where the comp edits it) and the summary prints it under the proposed
  // option — see buildAutoSummary()'s documented fallback.
  const incurredSectionId = await insertId(
    `INSERT INTO quote_section
       (quote_id, kind, name, narrative_reported, scope_lines, include_in_summary, position)
     VALUES ($1, 'incurred', 'Work already performed', $2, $3::jsonb, true, 0) RETURNING id`,
    [quoteId, QUOTE_INCURRED_NARRATIVE, JSON.stringify(QUOTE_SCOPE_LINES)],
  );
  const optionSectionId = await insertId(
    `INSERT INTO quote_section
       (quote_id, kind, name, narrative_reported, scope_lines, include_in_summary, position)
     VALUES ($1, 'option', $2, $3, '[]'::jsonb, true, 1) RETURNING id`,
    [quoteId, 'Condenser fan motor + start kit replacement', QUOTE_OPTION_A_NARRATIVE],
  );

  let quoteLineCount = 0;
  for (const [sectionId, lines] of [
    [incurredSectionId, QUOTE_INCURRED_LINES],
    [optionSectionId, QUOTE_OPTION_A_LINES],
  ] as [string, SeedLine[]][]) {
    let linePos = 0;
    for (const l of lines) {
      await query(
        `INSERT INTO quote_line (section_id, line_type, description, qty, rate, day_value, ot, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [sectionId, l.line_type, l.description, l.qty, l.rate, l.day_value, l.ot, linePos++],
      );
      quoteLineCount++;
    }
  }

  // S5 · this row IS the quote_review_owed clock start (the engine reads the
  // submission, not quote.updated_at, so a reviewer's own edit cannot reset it).
  // Back-dated 5 business hours against a 4-hour budget → 125%, tier 2, owed to
  // the ATL desk (Elise).
  const seededAt = new Date();
  const quoteSubmittedAt = subBusinessMs(seededAt, businessHours(S5.QUOTE_REVIEW_AGE));
  await query(
    `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, field, after, created_at)
     VALUES ($1, 'task', $2, 'quote_submitted', 'quote.status', $3::jsonb, $4::timestamptz)`,
    [
      mattId,
      quoTaskId,
      JSON.stringify({ status: 'pending_approval', quote_id: quoteId }),
      quoteSubmittedAt.toISOString(),
    ],
  );
  activityCount++;

  for (const p of SEED_PAYMENTS) {
    await query(
      `INSERT INTO payment_request
         (task_id, vendor_id, purpose, amount, method, status, requested_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)`,
      [quoTaskId, quoVendorId, p.purpose, p.amount, p.method, p.status, mattId, p.created_at],
    );
  }

  // ── 10. S5 · the obligation demo state ─────────────────────────────────────
  // NOTHING here writes an obligation row. The engine is a pure function of DB
  // state; this block builds the state and the first /api/pulse read derives
  // ten live obligations from it. See the S5 table above for the full matrix.

  /** N business hours before the seed ran, on the engine's own clock. */
  const bAgo = (hours: number) => subBusinessMs(seededAt, businessHours(hours));

  /**
   * Back-date a work order's entry into its CURRENT status.
   *
   * The engine derives "in this status since" from the newest `status_changed`
   * activity row naming that status, so writing one IS how you age a clock —
   * no column to fake, and the WO's feed tells the same story the Pulse does.
   */
  async function ageStatus(
    woNumber: string,
    statusName: string,
    at: Date,
    fromStatus: string | null = null,
  ): Promise<void> {
    const taskId = taskIdByWo.get(woNumber);
    if (!taskId) throw new Error(`S5 demo state: task ${woNumber} not seeded`);
    await query(
      `INSERT INTO activity_log
         (actor_principal_id, entity_type, entity_id, action, field, before, after, created_at)
       VALUES ($1, 'task', $2, 'status_changed', 'status_id', $3::jsonb, $4::jsonb, $5::timestamptz)`,
      [
        seedBotId,
        taskId,
        fromStatus === null ? null : JSON.stringify({ status_name: fromStatus }),
        JSON.stringify({ status_name: statusName }),
        at.toISOString(),
      ],
    );
    activityCount++;
  }

  // ── 10a · three new work orders ───────────────────────────────────────────
  // The ClickUp export has no emergency and nothing in "waiting for quote", so
  // two of the seven rules would have no subject at all. These three give the
  // demo its emergency and its quote backlog.
  // The blown SLA is the one anchor that cannot be expressed as "N business
  // hours ago": the rule reads a DATE, backdates the clock to sla − grace, and
  // lands the due moment at that date's 18:00 close. A fixed calendar offset
  // therefore lands on a different ratio every weekday — 4 days before a
  // Tuesday is a Friday, whose close is only 10 business hours behind Tuesday's
  // open, i.e. exactly 200% and NOT tier 3 (the boundary is `> 2`). So walk
  // back through Chicago dates and take the first whose close is at least
  // SLA_PAST_DUE_HOURS business hours behind us — progress is then
  // (grace + past_due) / grace, comfortably inside tier 3 on any weekday.
  const slaDate = ((): string => {
    const graceHours = 10; // mirrors obligation_rule.params.grace_business_hours
    for (let back = 1; back <= 21; back++) {
      const candidate = chicagoDate(new Date(seededAt.getTime() - back * 86_400_000));
      const [y, m, d] = candidate.split('-').map(Number);
      const close = chicagoWallToInstant(y, m, d, 18, 0);
      if (close.getTime() >= seededAt.getTime()) continue;
      const pastDueHours = diffBusinessMs(close, seededAt) / businessHours(1);
      if (pastDueHours >= S5.SLA_PAST_DUE_HOURS) {
        return candidate; // progress = (10 + pastDueHours) / 10
      }
    }
    // Unreachable in practice (21 days back always clears 16 business hours);
    // fall back to the old calendar offset rather than seeding no SLA at all.
    return chicagoDate(new Date(seededAt.getTime() - S5.SLA_DAYS_AGO * 86_400_000));
  })();
  const s5ClockStart = new Map<string, Date>([
    // 24/7 clock, 2h budget: 5 wall hours ago is 250% — tier 3, and it only
    // ever gets worse, which is the point of an unacknowledged emergency.
    [S5.EMERGENCY_WO, new Date(seededAt.getTime() - S5.EMERGENCY_AGE_HOURS * 3_600_000)],
    [S5.QUOTE_OWED_TIER0_WO, bAgo(S5.QUOTE_OWED_TIER0_AGE)],
    [S5.QUOTE_OWED_TIER2_WO, bAgo(S5.QUOTE_OWED_TIER2_AGE)],
  ]);

  for (const t of S5_TASKS) {
    const statusId = resolveStatusId(t.status);
    const statusGroup = statusGroupById.get(statusId)!;
    const homeListId = listIdByName.get(t.list) ?? null;
    if (!homeListId) throw new Error(`S5 demo state: list "${t.list}" not seeded`);
    const openedAt = s5ClockStart.get(t.wo_number)!;

    const fields: Record<string, unknown> = {
      '35. WO Description': t.description,
      Client: t.client,
      City: t.city,
      State: t.state,
      Trade: t.trade,
      '16. Client NTE 🔴': t.nte,
      '21. Comp': 'SFM',
      '22. FM': t.client,
      'Date-Time Received': chicagoDate(openedAt),
      ...(t.extraFields ?? {}),
    };
    // The blown-SLA subject. The rule reads this key out of the JSONB bag, so a
    // promoted `task.sla_due` column can land later with no rule change.
    if (t.wo_number === S5.QUOTE_OWED_TIER2_WO) fields['SLA Due Date'] = slaDate;

    const taskId = await insertId(
      `INSERT INTO task (
         wo_number, ext_name, title, description, home_list_id, status_id, status_group,
         billing_entity, client, trade, city, state, nte, date_received,
         fields, priority, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         'SFM', $8, $9, $10, $11, $12, $13,
         $14::jsonb, $15, $16::timestamptz
       ) RETURNING id`,
      [
        t.wo_number,
        t.ext_name,
        t.title,
        t.description,
        homeListId,
        statusId,
        statusGroup,
        t.client,
        t.trade,
        t.city,
        t.state,
        t.nte,
        chicagoDate(openedAt),
        JSON.stringify(fields),
        t.priority,
        openedAt.toISOString(),
      ],
    );
    taskIdByWo.set(t.wo_number, taskId);
    taskCount++;

    await query(
      `INSERT INTO task_list_membership (task_id, list_id, is_home) VALUES ($1, $2, true)`,
      [taskId, homeListId],
    );
    membershipCount++;

    // The 'created' row is the clock start for a work order that was never moved
    // between statuses. Stamped AT the anchor, not after it: emergency_ack is
    // silenced by any activity STRICTLY AFTER its start, and a WO must not
    // silence itself by existing.
    await query(
      `INSERT INTO activity_log (actor_principal_id, entity_type, entity_id, action, after, created_at)
       VALUES ($1, 'task', $2, 'created', $3::jsonb, $4::timestamptz)`,
      [
        seedBotId,
        taskId,
        JSON.stringify({ status_id: statusId, status_name: t.status, via: 'demo seed' }),
        openedAt.toISOString(),
      ],
    );
    activityCount++;
  }

  // ── 10b · age three existing work orders into their clocks ────────────────
  // WO-39403 moves from "<< invoiced not paid >>" to "!! waiting for approval".
  // It is the demo's centre of gravity (quote builder, Quo thread, payments) and
  // this is what puts TWO clocks on one work order — the client chase and the
  // quote review — which is the clearest possible statement of what an
  // obligation is: not a property of the WO, but of who owes what on it.
  {
    const statusName = '!! waiting for approval';
    const statusId = resolveStatusId(statusName);
    const statusGroup = statusGroupById.get(statusId)!;
    await query(`UPDATE task SET status_id = $1, status_group = $2 WHERE id = $3`, [
      statusId,
      statusGroup,
      quoTaskId,
    ]);
    await ageStatus(
      S5.APPROVAL_TIER2_WO,
      statusName,
      bAgo(S5.APPROVAL_TIER2_AGE),
      '<< invoiced not paid >>',
    );
  }

  // The storm front: 82% of a 5-business-day clock, tier 1 for another 9 hours.
  await ageStatus(
    S5.APPROVAL_TIER1_WO,
    '!! waiting for approval',
    bAgo(S5.APPROVAL_TIER1_AGE),
    'quote ready',
  );
  // Ambient, and visibly climbing: 10% of a 2-business-hour clock.
  await ageStatus(S5.SCHEDULE_TIER0_WO, 'approved', bAgo(S5.SCHEDULE_AGE), '!! waiting for approval');

  // ── 10c · two payment requests left in the AP queue ───────────────────────
  // The two seeded S4 rows are both `paid`, so payment_processing has no subject
  // without these. Owed by the admin desk (§4.3 defers the real routing).
  // The second one uses the MANUAL payee path (a tech who is not a vendor
  // record), so the AP queue demo shows both shapes. Gulf Coast stays on
  // WO-39403 where it is actually the tech on the job — pointing it at a
  // Minnesota job would be wrong, though harmlessly so: the Messages tab
  // correlates through `payable`, not `payment_request`.
  const s5Payments: {
    wo: string;
    purpose: string;
    amount: number;
    method: string;
    age: number;
    vendor: boolean;
    payee_name?: string;
    payee_phone?: string;
  }[] = [
    {
      wo: S5.APPROVAL_TIER2_WO,
      purpose: 'Emergency parts run — condenser fan motor',
      amount: 830,
      method: 'Zelle',
      age: S5.PAYMENT_TIER2_AGE,
      vendor: true,
    },
    {
      wo: S5.QUOTE_OWED_TIER0_WO,
      purpose: 'Assessment trip charge',
      amount: 95,
      method: 'ACH',
      age: S5.PAYMENT_TIER0_AGE,
      vendor: false,
      payee_name: 'Dale Whitaker',
      payee_phone: '(507) 555-0168',
    },
  ];
  for (const p of s5Payments) {
    const taskId = taskIdByWo.get(p.wo);
    if (!taskId) throw new Error(`S5 demo state: task ${p.wo} not seeded`);
    await query(
      `INSERT INTO payment_request
         (task_id, vendor_id, payee_name, payee_phone, purpose, amount, method, status,
          requested_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'requested', $8, $9::timestamptz)`,
      [
        taskId,
        p.vendor ? quoVendorId : null,
        p.payee_name ?? null,
        p.payee_phone ?? null,
        p.purpose,
        p.amount,
        p.method,
        mattId,
        bAgo(p.age).toISOString(),
      ],
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('seed: done');
  console.log(`  containers        : ${2 + data.routing.length + listCount} (1 workspace, 1 space, ${data.routing.length} folders, ${listCount} lists)`);
  console.log(`  principals        : ${data.people.length + 2} (${data.people.length} human, 2 service)`);
  console.log(`  statuses          : ${data.statuses.length + 1} (19 pipeline + 1 archive)`);
  console.log(`  field_defs        : ${fieldCount}`);
  console.log(`  tasks             : ${taskCount}`);
  console.log(`  memberships       : ${membershipCount}`);
  console.log(`  vendors           : ${VENDORS.length}`);
  console.log(`  payables          : ${payableCount}`);
  console.log(`  activity (created): ${activityCount}`);
  console.log(`  quo conversations : 1 (${QUO_WO_NUMBER} ↔ ${QUO_VENDOR_NAME})`);
  console.log(`  quo calls         : ${QUO_CALLS.length}`);
  console.log(`  quo messages      : ${QUO_MESSAGES.length} (${QUO_MESSAGES.filter((m) => m.media.length === 0).length} SMS, ${QUO_MESSAGES.filter((m) => m.media.length > 0).length} MMS, ${QUO_MESSAGES.reduce((n, m) => n + m.media.length, 0)} photos)`);
  console.log(`  quo job segments  : 1`);
  console.log(`  quotes            : 1 (${QUO_WO_NUMBER}, pending_approval, 2 sections, ${quoteLineCount} lines)`);
  console.log(`  payment requests  : ${SEED_PAYMENTS.length + s5Payments.length} (${SEED_PAYMENTS.filter((p) => p.status === 'paid').length} paid, ${s5Payments.length} requested)`);
  console.log(`  S5 demo state     : ${S5_TASKS.length} new WOs (${S5_TASKS.map((t) => t.wo_number).join(', ')}), 3 clocks aged, blown SLA ${slaDate}`);
  console.log(`  S5 obligations    : 0 rows seeded — the engine derives 10 on the first /api/pulse read`);
  console.log(`                      tier 3 x2 · tier 2 x4 · tier 1 x1 · tier 0 x3`);
}

main()
  .finally(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('seed: FAILED');
    console.error(err);
    process.exit(1);
  });

// Distills clickup-raw/*.json into mockup/design/clickup-data.json (compact, agent-readable)
const fs = require('fs');
const path = require('path');
const RAW = path.join(__dirname, '..', 'clickup-raw');
const load = (f) => JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));

const out = {};

// ---- statuses (with real ClickUp colors) ----
const space = load('spaces.json').spaces.find(s => s.id === '90050318380');
out.statuses = space.statuses.map(s => ({ name: s.status, type: s.type, order: s.orderindex, color: s.color }));

// ---- field schema (merge active + archive definitions) ----
const fieldDefs = new Map();
for (const file of ['field_incoming_wos.json', 'field_invoiced.json', 'field_matt_hammond.json']) {
  for (const f of load(file).fields) {
    if (!fieldDefs.has(f.name)) fieldDefs.set(f.name, f);
  }
}
out.fields = [...fieldDefs.values()].map(f => {
  const o = { name: f.name, type: f.type };
  if (f.type === 'drop_down' && f.type_config && f.type_config.options) {
    o.options = f.type_config.options.map(op => op.name);
  }
  if (f.type === 'formula' && f.type_config && f.type_config.formula) o.formula = true;
  return o;
});

// ---- decoder for task custom field values ----
function decode(cf) {
  const v = cf.value;
  if (v === undefined || v === null || v === '') return undefined;
  switch (cf.type) {
    case 'drop_down': {
      const opts = (cf.type_config && cf.type_config.options) || [];
      const hit = opts.find(o => o.id === v || o.orderindex === v);
      return hit ? hit.name : undefined;
    }
    case 'users':
      return Array.isArray(v) ? v.map(u => u.username || u.email).filter(Boolean).join(', ') : undefined;
    case 'date': {
      const d = new Date(Number(v));
      return isNaN(d) ? undefined : d.toISOString().slice(0, 10);
    }
    case 'checkbox': return v === 'true' || v === true ? true : undefined;
    case 'currency': case 'number': return Number(v);
    case 'formula': {
      if (typeof v === 'object' && v !== null) return v.value !== undefined ? v.value : undefined;
      return v;
    }
    case 'location': return typeof v === 'object' ? (v.formatted_address || undefined) : v;
    case 'attachment': return Array.isArray(v) ? v.length + ' file(s)' : undefined;
    case 'url': case 'short_text': case 'text': return String(v).slice(0, 300);
    case 'emoji': return Number(v);
    default: return typeof v === 'string' ? v.slice(0, 120) : undefined;
  }
}

function normalizeTask(t) {
  const fields = {};
  for (const cf of t.custom_fields || []) {
    const val = decode(cf);
    if (val !== undefined) fields[cf.name] = val;
  }
  return {
    id: t.custom_id || t.id,
    name: (t.name || '').slice(0, 160),
    status: t.status && t.status.status,
    list: t.list && t.list.name,
    created: t.date_created ? new Date(Number(t.date_created)).toISOString().slice(0, 10) : null,
    due: t.due_date ? new Date(Number(t.due_date)).toISOString().slice(0, 10) : null,
    assignees: (t.assignees || []).map(a => a.username),
    tags: (t.tags || []).map(g => g.name),
    priority: t.priority && t.priority.priority,
    fields
  };
}

// ---- task samples + aggregations ----
const active = [...load('tasks_am_peter.json').tasks, ...load('tasks_matt_hammond.json').tasks];
const invoiced = load('tasks_invoiced.json').tasks;
const all = [...active, ...invoiced].map(normalizeTask);

const tally = (arr, key) => {
  const m = {};
  arr.forEach(t => { const k = key(t); if (k) m[k] = (m[k] || 0) + 1; });
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};
out.aggregates = {
  sampled: all.length,
  byStatus: tally(all, t => t.status),
  byClient: tally(all, t => t.fields['Client']),
  byTrade: tally(all, t => t.fields['Trade']),
  byFM: Object.fromEntries(Object.entries(tally(all, t => t.fields['22. FM'])).slice(0, 20)),
  byComp: tally(all, t => t.fields['21. Comp']),
  byState: Object.fromEntries(Object.entries(tally(all, t => t.fields['State'])).slice(0, 15)),
  byAM: tally(all, t => t.fields['AM']),
};

// profit stats from invoiced sample
const nums = (arr, f) => arr.map(t => Number(t.fields[f])).filter(n => !isNaN(n) && isFinite(n));
const inv = invoiced.map(normalizeTask);
const profits = nums(inv, 'Profit');
const totals = nums(inv, 'Total Invoiced');
const costs = nums(inv, '34. Cost');
const sum = a => a.reduce((x, y) => x + y, 0);
out.aggregates.invoicedSample = {
  n: inv.length,
  totalInvoiced: Math.round(sum(totals)),
  totalCost: Math.round(sum(costs)),
  totalProfit: Math.round(sum(profits)),
  avgInvoice: totals.length ? Math.round(sum(totals) / totals.length) : 0,
  avgProfit: profits.length ? Math.round(sum(profits) / profits.length) : 0,
};

// keep interesting task samples: prefer active ones with rich fields + descriptions
const scored = all
  .map(t => ({ t, score: Object.keys(t.fields).length + (t.fields['35. WO Description'] ? 10 : 0) + (t.status === 'emergency' ? 5 : 0) }))
  .sort((a, b) => b.score - a.score);
const activeSamples = scored.filter(x => x.t.list !== 'Invoiced').slice(0, 22).map(x => x.t);
const invSamples = scored.filter(x => x.t.list === 'Invoiced').slice(0, 6).map(x => x.t);
out.taskSamples = [...activeSamples, ...invSamples];

// ---- routing: folders + lists with task counts ----
const folders = load('folders_90050318380.json').folders;
out.routing = folders.map(f => ({
  folder: f.name,
  lists: (f.lists || []).map(l => ({ name: l.name, tasks: l.task_count }))
    .sort((a, b) => b.tasks - a.tasks)
}));

// ---- team: admins + anyone appearing in samples ----
const team = load('team.json');
const members = (team.teams ? team.teams[0].members : team.members).map(m => m.user);
const seen = new Set();
out.taskSamples.forEach(t => { t.assignees.forEach(a => seen.add(a)); const am = t.fields['AM']; if (am) String(am).split(', ').forEach(a => seen.add(a)); });
out.people = members
  .filter(u => u.role <= 2 || seen.has(u.username))
  .map(u => ({ name: u.username, initials: u.initials, role: u.role === 1 ? 'owner' : u.role === 2 ? 'admin' : 'member', email: (u.email || '').replace(/^[^@]+/, '') }))
  .slice(0, 40);

// ---- tags & views ----
out.tags = load('tags_90050318380.json').tags.map(t => t.name);
out.views = load('views_space_vista.json').views.map(v => ({ name: v.name, type: v.type }));

const dest = path.join(__dirname, 'design', 'clickup-data.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 1));
console.log('Wrote', dest, Math.round(fs.statSync(dest).size / 1024) + ' KB');
console.log('statuses:', out.statuses.length, '| fields:', out.fields.length, '| samples:', out.taskSamples.length, '| people:', out.people.length);
console.log('status dist:', JSON.stringify(out.aggregates.byStatus));
console.log('comp:', JSON.stringify(out.aggregates.byComp));
console.log('clients top5:', Object.entries(out.aggregates.byClient).slice(0, 5).map(e => e.join(':')).join(', '));
console.log('trades:', Object.entries(out.aggregates.byTrade).slice(0, 8).map(e => e.join(':')).join(', '));
console.log('invoiced $:', JSON.stringify(out.aggregates.invoicedSample));

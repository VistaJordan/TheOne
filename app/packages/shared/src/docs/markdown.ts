// 0075 · The documents as Markdown — the Download Markdown button, and the
// text a reviewer can diff. Pure: the same registry the page draws, plus the
// live snapshot when one is at hand.

import { BRD_PARTS, DOCS_REVIEWED_ON } from './brd';
import { BUSINESS_RULES } from './rules';
import { SOP } from './sop';
import { LIFECYCLE } from './lifecycle';
import type { DocsSnapshot, SopBlock } from './types';

const nl = '\n';

function esc(s: string): string {
  return s.replace(/\|/g, '\\|');
}

function table(head: string[], rows: string[][]): string {
  const h = `| ${head.map(esc).join(' | ')} |`;
  const sep = `| ${head.map(() => '---').join(' | ')} |`;
  const body = rows.map((r) => `| ${r.map((c) => esc(c ?? '')).join(' | ')} |`).join(nl);
  return [h, sep, body].join(nl);
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/** The version line both documents carry. */
export function docsVersionLine(snap: DocsSnapshot | null): string {
  const parts = [`Prose reviewed ${DOCS_REVIEWED_ON}`];
  if (snap) {
    parts.push(`schema ${snap.instance.latest_migration ?? '—'} (${snap.instance.migrations_applied} migrations applied)`);
    parts.push(`generated ${snap.generated_at.slice(0, 16).replace('T', ' ')} UTC`);
  }
  return parts.join(' · ');
}

// ── BRD ──────────────────────────────────────────────────────────────────────

export function brdMarkdown(snap: DocsSnapshot | null): string {
  const out: string[] = [];
  out.push('# The One — Business Requirements Document (living)');
  out.push('');
  out.push(`_${docsVersionLine(snap)}_`);
  out.push('');
  out.push('## 1. Introduction');
  out.push('');
  out.push(
    'This document describes what The One does and why, module by module and feature by feature, with the controls on screen, the rules the system enforces, the permission each action needs and the value each feature brings. Sections 1 to 3 are written by hand beside the code and reviewed against the screens; the appendix is read from the live instance each time the document is generated, so statuses, fields, roles, automations, integrations and the revision history always describe the system as it is.',
  );
  out.push('');
  out.push('## 2. Business context');
  out.push('');
  out.push(
    'Seamless FM (Byblos Vista) runs facilities work orders for retail and restaurant clients through external technicians. Work arrives in the clients\' own systems (Ecotrak, Corrigo, ServiceChannel), by email and by phone; it must be accepted, dispatched to a subcontractor, assessed, quoted inside the client\'s clock, approved by the client, fulfilled, closed with proof, paid on the technician side and invoiced on the client side. Before The One this ran across ClickUp, Teams reminders, a tech-locator map, a vendor CRM, Make and Paperform automations and tracking spreadsheets per client. The One replaces them with one record and one set of rules.',
  );
  out.push('');
  out.push('### 2.1 The lifecycle');
  out.push('');
  for (const st of LIFECYCLE.stages) out.push(`- **${st.title}** (${st.who.join(', ')}): ${st.summary}`);
  out.push('');
  out.push('## 3. Modules and features');
  out.push('');
  let partNo = 0;
  for (const part of BRD_PARTS) {
    partNo += 1;
    out.push(`### 3.${partNo} ${part.title}`);
    out.push('');
    out.push(part.intro);
    out.push('');
    let modNo = 0;
    for (const m of part.modules) {
      modNo += 1;
      out.push(`#### 3.${partNo}.${modNo} ${m.title}`);
      out.push('');
      out.push(`**Where:** ${m.where}  `);
      out.push(`**Purpose:** ${m.purpose}  `);
      out.push(`**Value:** ${m.value}`);
      if (m.users?.length) out.push(`**Users:** ${m.users.join(', ')}`);
      out.push('');
      for (const f of m.features) {
        out.push(`##### ${f.name}${f.since ? ` _(since ${f.since})_` : ''}`);
        out.push('');
        out.push(`- **What:** ${f.what}`);
        if (f.value) out.push(`- **Value:** ${f.value}`);
        if (f.controls?.length) {
          out.push('- **Controls:**');
          for (const c of f.controls) out.push(`  - **${c.label}** — ${c.does}`);
        }
        if (f.rules?.length) {
          out.push('- **Rules:**');
          for (const r of f.rules) out.push(`  - ${r}`);
        }
        if (f.permissions?.length) out.push(`- **Permissions:** ${f.permissions.map((p) => `\`${p}\``).join(', ')}`);
        if (f.audit?.length) out.push(`- **Audit:** ${f.audit.map((p) => `\`${p}\``).join(', ')}`);
        if (f.brd?.length) out.push(`- **BRD rules:** ${f.brd.join(', ')}`);
        if (f.deferred?.length) {
          out.push('- **Deferred / not yet:**');
          for (const d of f.deferred) out.push(`  - ${d}`);
        }
        out.push('');
      }
    }
  }
  out.push('## 4. Business rules register');
  out.push('');
  out.push(
    table(
      ['Rule', 'Title', 'Statement', 'Enforced', 'State'],
      BUSINESS_RULES.map((r) => [r.id, r.title, r.statement, r.enforced, r.state + (r.note ? ` — ${r.note}` : '')]),
    ),
  );
  out.push('');
  out.push('## 5. Appendix: the live instance');
  out.push('');
  if (!snap) {
    out.push('_The live appendix was not available when this file was generated._');
    out.push('');
  } else {
    out.push('### 5.1 Instance');
    out.push('');
    out.push(
      table(
        ['Setting', 'Value'],
        [
          ['Authentication', snap.instance.auth_mode === 'entra' ? 'Microsoft Entra ID' : 'Development bypass'],
          ['Environment', snap.instance.node_env],
          ['Web origin', snap.instance.web_origin],
          ['Database', snap.instance.database],
          ['Migrations applied', String(snap.instance.migrations_applied)],
          ['Latest migration', snap.instance.latest_migration ?? '—'],
          ['Super admins', snap.super_admins.join(', ')],
          ['Service principals', snap.service_principals.join(', ')],
        ],
      ),
    );
    out.push('');
    out.push('### 5.2 Contents');
    out.push('');
    out.push(table(['Record', 'Count'], Object.entries(snap.counts).map(([k, v]) => [k.replace(/_/g, ' '), String(v)])));
    out.push('');
    out.push('### 5.3 Statuses and phases');
    out.push('');
    out.push(
      table(
        ['Status', 'Phase group', 'Lifecycle phase', 'Live work orders', 'Archive'],
        snap.statuses.map((s) => [s.name, s.group, s.phase ?? '—', String(s.wo_count), s.is_archive ? 'yes' : '']),
      ),
    );
    out.push('');
    out.push('### 5.4 Field catalogue');
    out.push('');
    out.push(
      table(
        ['Field', 'Type', 'Section', 'Options', 'Add work order', 'In use', 'Notes'],
        snap.fields.map((f) => [
          f.label,
          f.type,
          f.section,
          f.options.length ? f.options.join('; ') : '',
          f.create_mode,
          String(f.used_by),
          [f.computed ? 'computed' : '', f.visit_owned ? 'mirrors the latest visit' : ''].filter(Boolean).join(', '),
        ]),
      ),
    );
    out.push('');
    out.push('### 5.5 Roles');
    out.push('');
    for (const r of snap.roles) {
      out.push(`#### ${r.label} (\`${r.code}\`)${r.is_system ? ' · built in' : ''} · ${r.user_count} people`);
      out.push('');
      if (r.description) out.push(r.description);
      out.push('');
      out.push(`Work orders seen: **${r.wo_scope === 'everything' ? 'Everything' : 'Only theirs'}** · Status changes: **${r.status_mode === 'direct' ? 'Change directly' : r.status_mode === 'request' ? 'Must request' : 'Not allowed'}**`);
      out.push('');
      out.push(
        table(
          ['Section', 'View', 'Create', 'Edit', 'Delete', 'Approve'],
          r.sections.map((s) => [s.label, s.view ? '✓' : '', s.create ? '✓' : '', s.edit ? '✓' : '', s.delete ? '✓' : '', s.approve ? '✓' : '']),
        ),
      );
      out.push('');
    }
    out.push('### 5.6 Automations');
    out.push('');
    out.push(table(['Rule', 'State', 'Trigger', 'Conditions', 'Actions', 'Runs'], snap.automations.map((a) => [a.name, a.enabled ? 'on' : 'paused', a.trigger, String(a.conditions), a.actions.join('; '), String(a.run_count)])));
    out.push('');
    out.push('### 5.7 Integrations');
    out.push('');
    out.push(table(['Connector', 'Group', 'Switch', 'Built', 'Set up', 'What it does'], snap.integrations.map((i) => [i.name, i.group, i.enabled ? 'on' : 'off', i.built ? 'yes' : 'not yet', i.configured ? 'yes' : 'no', i.summary])));
    out.push('');
    out.push('### 5.8 Approval tiers by amount');
    out.push('');
    out.push(table(['Kind', 'Band', 'From', 'Up to', 'Roles'], snap.approval_tiers.map((t) => [t.kind, t.label, money(t.min_amount), t.max_amount == null ? 'no ceiling' : money(t.max_amount), t.roles.length ? t.roles.join(', ') : 'anyone with the permission'])));
    out.push('');
    out.push('### 5.9 Holidays (the quote clock skips these)');
    out.push('');
    out.push(table(['Day', 'Name'], snap.holidays.map((h) => [h.day, h.name])));
    out.push('');
    out.push('### 5.10 Dashboards');
    out.push('');
    out.push(table(['Dashboard', 'Folder', 'Shipped as', 'Cards'], snap.dashboards.map((d) => [d.name, d.folder ?? '', d.system_key ?? '', String(d.widgets)])));
    out.push('');
    out.push('### 5.11 Revision history (the migration ledger)');
    out.push('');
    out.push(table(['#', 'Migration', 'Applied'], snap.migrations.map((m) => [String(m.n).padStart(4, '0'), m.title, m.applied_at ? m.applied_at.slice(0, 10) : ''])));
    out.push('');
  }
  return out.join(nl);
}

// ── SOP ──────────────────────────────────────────────────────────────────────

function blockMd(b: SopBlock): string {
  switch (b.kind) {
    case 'p':
      return b.text + nl;
    case 'sub':
      return `**${b.title}**${nl}`;
    case 'steps':
      return b.items.map((it, i) => `${i + 1}. ${it}`).join(nl) + nl;
    case 'bullets':
      return b.items.map((it) => `- ${it}`).join(nl) + nl;
    case 'table':
      return table(b.head, b.rows) + nl;
    case 'note':
      return `> **${b.title}** ${b.text}${nl}`;
  }
}

export function sopMarkdown(snap: DocsSnapshot | null): string {
  const out: string[] = [];
  out.push(`# ${SOP.title}`);
  out.push('');
  out.push(`_${SOP.subtitle}_`);
  out.push('');
  out.push(`_${docsVersionLine(snap)}_`);
  out.push('');
  out.push(`> **Document control** ${SOP.control}`);
  out.push('');
  out.push('## Role Purpose');
  out.push('');
  for (const p of SOP.purpose) {
    out.push(p);
    out.push('');
  }
  out.push('## Scope');
  out.push('');
  out.push(SOP.scope);
  out.push('');
  out.push(`> **Who can use it** ${SOP.whoCanUse}`);
  out.push('');
  out.push('## Table of Contents');
  out.push('');
  for (const p of SOP.procedures) out.push(`${p.n}. SOP ${p.n}: ${p.title}`);
  out.push('');
  out.push('## Definitions of Technical Terms');
  out.push('');
  out.push(table(['Term', 'Definition'], SOP.terms.map((t) => [t.term, t.definition])));
  out.push('');
  for (const p of SOP.procedures) {
    out.push(`## SOP ${p.n}: ${p.title}`);
    out.push('');
    out.push(`_${p.lead}_`);
    out.push('');
    out.push(`**Who:** ${p.who.join(', ')}  `);
    out.push(`**Where:** ${p.where}  `);
    if (p.needs.length) out.push(`**Needs:** ${p.needs.map((n) => `\`${n}\``).join(', ')}`);
    out.push('');
    for (const b of p.blocks) out.push(blockMd(b));
  }
  out.push('## Who Does What');
  out.push('');
  out.push(table(['Role', 'Procedures'], SOP.matrix.map((m) => [m.role, m.procedures.map((n) => `SOP ${n}`).join(', ')])));
  out.push('');
  out.push('## Main Success Metric');
  out.push('');
  out.push(SOP.successMetric);
  out.push('');
  out.push('## Review and Revision History');
  out.push('');
  if (snap) {
    out.push(table(['Version', 'Date', 'Revision description', 'Status'], snap.migrations.slice().reverse().map((m) => [String(m.n).padStart(4, '0'), m.applied_at ? m.applied_at.slice(0, 10) : '', m.title, 'Applied'])));
  } else {
    out.push('_The migration ledger was not available when this file was generated._');
  }
  out.push('');
  out.push('## Document Sign-Off');
  out.push('');
  out.push(table(['Approval type', 'Name', 'Title / Department', 'Signature', 'Date'], [['Presented By', '', '', '', ''], ['Reviewed By', '', '', '', '']]));
  out.push('');
  return out.join(nl);
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function lifecycleMarkdown(snap: DocsSnapshot | null): string {
  const out: string[] = [];
  out.push('# The One — Work-order lifecycle');
  out.push('');
  out.push(`_${docsVersionLine(snap)}_`);
  out.push('');
  out.push('## Stages');
  out.push('');
  for (const st of LIFECYCLE.stages) out.push(`- **${st.title}** · ${st.who.join(', ')}: ${st.summary}`);
  out.push('');
  out.push('## Statuses');
  out.push('');
  const counts = new Map((snap?.statuses ?? []).map((s) => [s.name, s.wo_count]));
  out.push(
    table(
      ['Status', 'Meaning', 'Entered by', 'Who', 'Gate', 'Live'],
      LIFECYCLE.nodes.map((n) => [n.status, n.meaning, n.enteredBy, n.who, n.gate ?? '', counts.has(n.status) ? String(counts.get(n.status)) : '']),
    ),
  );
  out.push('');
  out.push('## Moves');
  out.push('');
  out.push(table(['From', 'To', 'When', 'Kind'], LIFECYCLE.edges.map((e) => [e.from, e.to, e.label ?? '', e.kind])));
  out.push('');
  out.push('## What runs beside the statuses');
  out.push('');
  for (const s of LIFECYCLE.side) {
    out.push(`### ${s.title}`);
    out.push('');
    out.push(`_Attached to: ${s.statuses.join(', ')}${s.brd?.length ? ` · rules ${s.brd.join(', ')}` : ''}_`);
    out.push('');
    out.push(s.summary);
    out.push('');
    for (const step of s.steps) out.push(`- ${step}`);
    out.push('');
  }
  return out.join(nl);
}

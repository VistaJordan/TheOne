/* 0075 — Admin › Documentation. The registry describes the system as built,
 * so this suite fails when something exists that the documents forget: a
 * sidebar item, an admin section, a work-order tab, an integration, a status.
 * It also checks the documents are internally consistent (every lifecycle
 * edge joins two nodes, SOP numbers run 1..n, rule ids are unique) and that
 * the Markdown exports carry every chapter. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  BRD_MODULES,
  BRD_PARTS,
  BUSINESS_RULES,
  DOCS_PERM_KEY,
  LIFECYCLE,
  SOP,
  brdMarkdown,
  lifecycleMarkdown,
  sopMarkdown,
} from '../packages/shared/src/docs';
import { ADMIN_PERM_SECTIONS, WO_TABS } from '../packages/shared/src/permissions';
import { PHASE_BY_STATUS_NAME, PHASE_ORDER } from '../packages/shared/src/index';
import { ECOTRAK_PUSH_BY_STATUS_NAME } from '../packages/shared/src/ecotrak';
import { INTEGRATIONS } from '../packages/shared/src/integrations';

const brdText = JSON.stringify(BRD_PARTS);
const sopText = JSON.stringify(SOP);
const allText = brdText + sopText + JSON.stringify(LIFECYCLE);

/** The sidebar as AppShell declares it (`label: '…'` inside NAV). */
function sidebarLabels(): string[] {
  const src = readFileSync(resolve(__dirname, '..', 'apps', 'web', 'src', 'components', 'AppShell.tsx'), 'utf8');
  const navBlock = src.slice(src.indexOf('const NAV: NavItem[] = ['), src.indexOf('const NAV_PERM'));
  return [...navBlock.matchAll(/\{ label: '([^']+)'/g)].map((m) => m[1]);
}

describe('the registry covers what exists', () => {
  it('names every sidebar item', () => {
    const labels = sidebarLabels();
    expect(labels.length).toBeGreaterThan(10);
    for (const l of labels) expect(allText, `sidebar item "${l}"`).toContain(l);
  });
  it('names every admin section, and Documentation is one of them', () => {
    for (const s of ADMIN_PERM_SECTIONS) expect(brdText, `admin section "${s.label}"`).toContain(s.label);
    expect(ADMIN_PERM_SECTIONS.find((s) => s.slug === 'docs')?.actions).toEqual(['view']);
    expect(DOCS_PERM_KEY).toBe('admin/docs');
  });
  it('names every work-order tab', () => {
    for (const t of WO_TABS) expect(brdText, `tab "${t.label}"`).toContain(t.label);
  });
  it('names every integration', () => {
    for (const i of INTEGRATIONS) expect(brdText, `integration "${i.name}"`).toContain(i.name);
  });
});

describe('the lifecycle model', () => {
  const nodeNames = new Set(LIFECYCLE.nodes.map((n) => n.status));
  it('has one node per seeded status, and no stranger', () => {
    const seeded = Object.keys(PHASE_BY_STATUS_NAME).sort();
    expect([...nodeNames].sort()).toEqual(seeded);
    expect(Object.keys(ECOTRAK_PUSH_BY_STATUS_NAME).sort()).toEqual(seeded);
  });
  it('joins every edge to two nodes and never to itself', () => {
    for (const e of LIFECYCLE.edges) {
      expect(nodeNames.has(e.from), `edge from "${e.from}"`).toBe(true);
      expect(nodeNames.has(e.to), `edge to "${e.to}"`).toBe(true);
      expect(e.from).not.toBe(e.to);
    }
  });
  it('reaches every status from Open except the planned-maintenance entry', () => {
    const reach = new Set<string>(['Open']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of LIFECYCLE.edges) if (reach.has(e.from) && !reach.has(e.to)) { reach.add(e.to); grew = true; }
    }
    const unreachable = [...nodeNames].filter((n) => !reach.has(n));
    expect(unreachable).toEqual(['PM Sched']);
  });
  it('covers every phase with a stage, and attaches side processes to real statuses', () => {
    const covered = new Set(LIFECYCLE.stages.flatMap((s) => s.phases));
    for (const p of PHASE_ORDER) expect(covered.has(p), `phase "${p}"`).toBe(true);
    for (const s of LIFECYCLE.side) for (const st of s.statuses) expect(nodeNames.has(st), `${s.key} → "${st}"`).toBe(true);
  });
  it('marks exactly the gated statuses', () => {
    const gated = LIFECYCLE.nodes.filter((n) => n.gate).map((n) => n.status).sort();
    expect(gated).toEqual(['Done / Incurred', 'Please Order Parts', 'Quote Ready', 'Waiting for Parts']);
  });
});

describe('the documents are consistent', () => {
  it('has unique module keys and rule ids', () => {
    expect(new Set(BRD_MODULES.map((m) => m.key)).size).toBe(BRD_MODULES.length);
    expect(new Set(BUSINESS_RULES.map((r) => r.id)).size).toBe(BUSINESS_RULES.length);
    for (const m of BRD_MODULES) {
      expect(m.features.length, m.key).toBeGreaterThan(0);
      for (const f of m.features) expect(f.what.length, `${m.key} › ${f.name}`).toBeGreaterThan(20);
    }
  });
  it('numbers the SOP procedures 1..n and the matrix points at them', () => {
    expect(SOP.procedures.map((p) => p.n)).toEqual(SOP.procedures.map((_, i) => i + 1));
    const valid = new Set(SOP.procedures.map((p) => p.n));
    for (const row of SOP.matrix) for (const n of row.procedures) expect(valid.has(n), `${row.role} → SOP ${n}`).toBe(true);
    for (const p of SOP.procedures) expect(p.blocks.length, p.title).toBeGreaterThan(0);
  });
  it('cites only rules the register knows', () => {
    const ids = new Set(BUSINESS_RULES.map((r) => r.id));
    for (const m of BRD_MODULES) for (const f of m.features) for (const id of f.brd ?? []) expect(ids.has(id), `${m.key} › ${f.name} cites ${id}`).toBe(true);
    for (const s of LIFECYCLE.side) for (const id of s.brd ?? []) expect(ids.has(id), `${s.key} cites ${id}`).toBe(true);
  });
  it('exports every chapter to Markdown without a snapshot', () => {
    const brd = brdMarkdown(null);
    for (const m of BRD_MODULES) expect(brd).toContain(m.title);
    for (const r of BUSINESS_RULES) expect(brd).toContain(r.id);
    const sop = sopMarkdown(null);
    for (const p of SOP.procedures) expect(sop).toContain(`SOP ${p.n}: ${p.title}`);
    const lc = lifecycleMarkdown(null);
    for (const n of LIFECYCLE.nodes) expect(lc).toContain(n.status);
  });
});

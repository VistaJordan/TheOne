// 2026-10-22 · the Finances profitability exception, the Penalties section,
// Incoming › Unassigned, reassign / unassign from the header, and the
// one-click status-change approval. Pure checks plus source-text pins; the
// suite opens no database.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_UNSAFE_SECTION_SLUGS,
  FIELD_SECTIONS,
  MANAGER_FLAG_LOCKED_ROLES,
  MANAGER_FLAG_NEW_FIELDS,
  PENALTIES_SECTION_KEYS,
  PENALTIES_SECTION_SLUG,
  PENALTY_FIELDS,
  PROFITABILITY_EXCEPTION_KEY,
  PROFITABILITY_NOTES_KEY,
  UNASSIGNED_STATUS_GROUPS,
  clientUnsafeDefaultBagKeys,
  fieldSectionSlug,
  unassignedWorkFilter,
} from '../packages/shared/src/index';
import { migrationFileProblems } from '../packages/db/src/migrateLedger';

const src = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const MIGRATION = src('packages/db/migrations/0094_manager_flags.sql');
const SEED = src('packages/db/src/seed.ts');

describe('the Finances profitability exception and the Penalties section', () => {
  it('the two profitability rows sit in Finances, the penalty rows in Penalties, Bad quote left AR', () => {
    expect(fieldSectionSlug(`fields.${PROFITABILITY_EXCEPTION_KEY}`)).toBe('finances');
    expect(fieldSectionSlug(`fields.${PROFITABILITY_NOTES_KEY}`)).toBe('finances');
    const pen = FIELD_SECTIONS.find((s) => s.slug === PENALTIES_SECTION_SLUG);
    expect(pen?.title).toBe('Penalties');
    expect(pen?.keys).toEqual([...PENALTIES_SECTION_KEYS]);
    expect(fieldSectionSlug('fields.12. Bad quote')).toBe('penalties');
    expect(FIELD_SECTIONS.find((s) => s.slug === 'ar')?.keys).not.toContain('fields.12. Bad quote');
    expect(PENALTY_FIELDS.map((f) => f.label)).toEqual(['Bad Quote', 'Penalty', 'Late Quote', 'Missed ETA', 'Recall', 'Manager Description']);
  });

  it('none of it is client-safe', () => {
    expect(CLIENT_UNSAFE_SECTION_SLUGS).toContain('penalties');
    const unsafe = clientUnsafeDefaultBagKeys();
    for (const f of MANAGER_FLAG_NEW_FIELDS) expect(unsafe).toContain(f.key);
    expect(unsafe).toContain('12. Bad quote');
  });

  it('migration 0094 and the seed insert the same rows, and 0094 locks the managers’ call', () => {
    for (const f of MANAGER_FLAG_NEW_FIELDS) {
      expect(MIGRATION).toContain(`('${f.key}',`);
      expect(MIGRATION).toContain(`'${f.type}',`);
      expect(SEED).toContain(`{ key: '${f.key}',`);
      expect(SEED).toContain(`type: '${f.type}' }`);
    }
    expect(MIGRATION).toContain("'work_orders/fields/penalties'");
    expect(MIGRATION).toContain(`'work_orders/fields/finances/fields.${PROFITABILITY_EXCEPTION_KEY}'`);
    expect(MIGRATION).toContain(`'work_orders/fields/finances/fields.${PROFITABILITY_NOTES_KEY}'`);
    expect(MIGRATION).toContain(`ARRAY[${MANAGER_FLAG_LOCKED_ROLES.map((r) => `'${r}'`).join(', ')}]`);
    expect(migrationFileProblems('0094_manager_flags.sql', MIGRATION)).toEqual([]);
  });

  it('the Finances card draws the two rows', () => {
    const card = src('apps/web/src/components/wo/MoneyCard.tsx');
    expect(card).toContain('PROFITABILITY_EXCEPTION_KEY');
    expect(card).toContain('PROFITABILITY_NOTES_KEY');
    expect(card).toContain('<dt>Profitability exception</dt>');
    expect(card).toContain('<dt>Manager notes</dt>');
  });
});

describe('Incoming › Unassigned', () => {
  it('the filter is Assignee empty AND a live status group', () => {
    const f = unassignedWorkFilter();
    expect(f.match).toBe('all');
    expect(f.rules[0]).toEqual({ field: 'fields.Assignee', op: 'is_not_set' });
    expect(f.rules[1]).toEqual({ field: 'status_group', op: 'in', value: [...UNASSIGNED_STATUS_GROUPS], join: 'and' });
    expect(UNASSIGNED_STATUS_GROUPS).toEqual(['open', 'active', 'pending']);
  });

  it('the tab, the route and the page exist and write through the Assignee field', () => {
    const tabs = src('apps/web/src/components/IncomingTabs.tsx');
    expect(tabs).toContain("'/incoming/unassigned'");
    expect(tabs).toContain("export type IncomingTab = 'accept' | 'unassigned' | 'drafts';");
    const app = src('apps/web/src/App.tsx');
    expect(app).toContain('path="/incoming/unassigned"');
    expect(app).toContain('<RequireCan perm={INCOMING_ACCEPT_PERM} nav="Incoming Work Orders"><UnassignedPage />');
    const page = src('apps/web/src/pages/UnassignedPage.tsx');
    expect(page).toContain('patchWorkOrderFields(v.id, { [ASSIGNEE_KEY]: v.name })');
    expect(page).toContain("useCanEditField(ASSIGNEE_KEY)");
    expect(src('apps/web/src/lib/unassigned.ts')).toContain('unassignedWorkFilter()');
  });
});

describe('reassign / unassign from the header', () => {
  it('the assignee chip opens the dispatcher picker for whoever may edit the field; Unassign clears it', () => {
    const header = src('apps/web/src/components/wo/WoHeader.tsx');
    expect(header).toContain("useCanEditField(assigneeKey)");
    expect(header).toContain('<AssignDialog');
    expect(header).toContain('onAssign={(name) => assignSave.mutate({ key: assigneeKey, value: name })}');
    expect(header).toContain('onUnassign={() => assignSave.mutate({ key: assigneeKey, value: null })}');
    const dialog = src('apps/web/src/components/wo/AssignDialog.tsx');
    expect(dialog).toContain('isDispatcherRole(p.role)');
    expect(dialog).toContain('Unassign');
    expect(dialog).toContain("current ? 'Reassign' : 'Assign'");
  });
});

describe('approving a status change is one click', () => {
  it('the inbox sends a status_change approve straight through, like a payment', () => {
    const inbox = src('apps/web/src/pages/ApprovalsPage.tsx');
    expect(inbox).toContain("(kind === 'approve' && r.data.kind === 'task' && r.data.item.type === 'status_change')");
  });
});

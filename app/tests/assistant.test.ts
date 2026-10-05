// 0068 — the pure parts of the assistant: which routes a look-up may reach,
// how a result is cut down before the model reads it, and which links a reply
// may carry.
import { describe, expect, it } from 'vitest';
import { assistantLinkOk, compactForModel, filterRows, lookupResultText, rowsOf } from '@theone/shared';
import { ASSISTANT_TOOLS, LookupInputError, planLookup, shapeResult } from '../apps/api/src/lib/assistantTools';
import { STATIC_INSTRUCTIONS, buildQuestion, buildReference, describeAbilities } from '../apps/api/src/lib/assistantPrompt';

describe('a look-up only ever reads', () => {
  it('turns a work-order search into the list route with the saved-view filter shape', () => {
    const plan = planLookup('search_work_orders', {
      filters: { rules: [{ field: 'status', op: 'in', value: ['Waiting for Quote', 'Quote Ready'] }] },
      columns: ['fields.Assignee'],
      limit: 10,
    });
    expect(plan.requests).toHaveLength(1);
    const url = new URL(`http://x${plan.requests[0].url}`);
    expect(url.pathname).toBe('/work-orders');
    expect(JSON.parse(url.searchParams.get('filters')!)).toEqual({
      match: 'all',
      rules: [{ field: 'status', op: 'in', value: ['Waiting for Quote', 'Quote Ready'] }],
    });
    expect(url.searchParams.get('columns')).toBe('fields.Assignee');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('asks for one row when only the count is wanted', () => {
    const plan = planLookup('search_work_orders', { count_only: true, group_by: 'client', columns: ['trade'] });
    const url = new URL(`http://x${plan.requests[0].url}`);
    expect(url.searchParams.get('limit')).toBe('1');
    expect(url.searchParams.get('group_by')).toBe('client');
    expect(url.searchParams.has('columns')).toBe(false);
  });

  it('reads the asked-for parts of one work order, each from its own route', () => {
    const plan = planLookup('get_work_order', { wo: 'WO 12/3', parts: ['details', 'visits', 'visits', 'quote'] });
    expect(plan.requests.map((r) => r.url)).toEqual([
      '/work-orders/WO%2012%2F3',
      '/work-orders/WO%2012%2F3/visits',
      '/work-orders/WO%2012%2F3/quote',
    ]);
  });

  it('cannot be pointed at a path: a resource is a name from the list, and an id is one path segment', () => {
    expect(() => planLookup('lookup', { resource: 'admin/users' })).toThrow(LookupInputError);
    expect(() => planLookup('lookup', { resource: '../auth/me' })).toThrow(LookupInputError);
    expect(() => planLookup('delete_work_order', { wo: '1' })).toThrow(LookupInputError);
    expect(() => planLookup('lookup', { resource: 'quotes', id: 'x' })).toThrow(/cannot be opened by id/);
    expect(planLookup('lookup', { resource: 'vendors', id: '../../admin/users' }).requests[0].url).toBe('/vendors/..%2F..%2Fadmin%2Fusers');
    expect(planLookup('get_work_order', { wo: '1?x=1#y' }).requests[0].url).toBe('/work-orders/1%3Fx%3D1%23y');
  });

  it('hands a searchable resource the search and the page size', () => {
    const plan = planLookup('lookup', { resource: 'vendors', search: 'acme', params: { state: 'TX' }, limit: 5 });
    const url = new URL(`http://x${plan.requests[0].url}`);
    expect(url.pathname).toBe('/vendors');
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: 'TX', search: 'acme', page_size: '5' });
  });

  it('offers no tool that is not one of the three look-ups', () => {
    expect(ASSISTANT_TOOLS.map((t) => t.name)).toEqual(['search_work_orders', 'get_work_order', 'lookup']);
  });
});

describe('what the model is given back', () => {
  it('gives the total and tidy rows for a search', () => {
    const plan = planLookup('search_work_orders', { columns: ['fields.Assignee'] });
    const out = shapeResult(plan, [
      {
        label: 'work_orders',
        status: 200,
        body: {
          total: 42,
          offset: 0,
          items: [{ id: 'u', wo_number: '100', title: 'Leak', client: 'Acme', city: 'Austin', state: 'TX', status: { id: 's', name: 'On Site' }, emergency: true, escalated: false, nte: null, custom: { 'fields.Assignee': 'Dana' } }],
        },
      },
    ]);
    expect(out.ok).toBe(true);
    expect(out.outcome).toBe('42 found');
    const parsed = JSON.parse(out.text);
    expect(parsed.total).toBe(42);
    expect(parsed.rows[0]).toEqual({ wo_number: '100', title: 'Leak', client: 'Acme', location: 'Austin, TX', status: 'On Site', emergency: true, Assignee: 'Dana' });
  });

  it('says a forbidden part is not available instead of failing the whole read', () => {
    const plan = planLookup('get_work_order', { wo: '100', parts: ['details', 'quote'] });
    const out = shapeResult(plan, [
      { label: 'details', status: 200, body: { wo_number: '100', title: 'Leak' } },
      { label: 'quote', status: 403, body: { error: { code: 'FORBIDDEN', message: 'You cannot view quotes' } } },
    ]);
    expect(out.ok).toBe(true);
    expect(out.outcome).toBe('partly read');
    const parsed = JSON.parse(out.text);
    expect(parsed.details.title).toBe('Leak');
    expect(parsed.quote).toMatch(/Not available to this person/);
  });

  it('passes a refused filter back with the reason, so the model can correct it', () => {
    const plan = planLookup('search_work_orders', { filters: { rules: [{ field: 'nte', op: 'contains', value: 'x' }] } });
    const out = shapeResult(plan, [
      { label: 'work_orders', status: 400, body: { error: { code: 'BAD_REQUEST', message: '"NTE" does not support the "contains" test', details: { allowed: ['eq', 'gt'] } } } },
    ]);
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/does not support/);
    expect(out.text).toMatch(/"allowed"/);
  });

  it('narrows a whole-list resource by words, by a field and by count', () => {
    const plan = planLookup('lookup', { resource: 'payments', where: { status: 'requested' }, count_by: 'vendor', limit: 1 });
    const out = shapeResult(plan, [
      {
        label: 'payments',
        status: 200,
        body: { items: [{ id: 1, status: 'requested', vendor: 'A' }, { id: 2, status: 'paid', vendor: 'A' }, { id: 3, status: 'Requested', vendor: 'B' }] },
      },
    ]);
    const parsed = JSON.parse(out.text);
    expect(parsed).toMatchObject({ total_in_list: 3, matched: 2, shown: 1, counts: { A: 1, B: 1 } });
  });
});

describe('cutting a result down', () => {
  it('drops what says nothing and shortens what is long', () => {
    const c = compactForModel({ a: null, b: '', c: [], d: { e: null }, f: 'x'.repeat(700), g: 0, h: false }) as Record<string, unknown>;
    expect(Object.keys(c)).toEqual(['f', 'g', 'h']);
    expect(String(c.f)).toMatch(/100 more characters\]$/);
  });

  it('keeps the first entries of a nested list and says how many it left out', () => {
    const c = compactForModel({ lines: Array.from({ length: 30 }, (_, i) => i) }) as { lines: unknown[] };
    expect(c.lines).toHaveLength(21);
    expect(c.lines[20]).toBe('[10 more not shown]');
  });

  it('says so when a result is still too large', () => {
    const text = lookupResultText({ rows: Array.from({ length: 50 }, () => ({ note: 'y'.repeat(500) })) }, 2000);
    expect(text.length).toBeLessThan(2300);
    expect(text).toMatch(/\[CUT: this result was too large/);
  });

  it('finds the rows whatever the list calls them', () => {
    expect(rowsOf({ items: [1] })).toEqual([1]);
    expect(rowsOf({ total: 2, vendors: [1, 2] })).toEqual([1, 2]);
    expect(rowsOf({ a: [1], b: [2] })).toBeNull();
    expect(filterRows([{ a: 'Roof leak' }, { a: 'Door' }], { search: 'LEAK roof' }).matched).toBe(1);
  });
});

describe('what a reply may link to', () => {
  it('only a path inside the app', () => {
    expect(assistantLinkOk('/work-orders/48213')).toBe(true);
    expect(assistantLinkOk('/vendors/0b0b6b3e-1111-4222-8333-444455556666')).toBe(true);
    expect(assistantLinkOk('/payments?tab=open')).toBe(true);
    expect(assistantLinkOk('//evil.example/x')).toBe(false);
    expect(assistantLinkOk('https://evil.example')).toBe(false);
    expect(assistantLinkOk('javascript:alert(1)')).toBe(false);
    expect(assistantLinkOk('/a b')).toBe(false);
  });
});

describe('what the model is told', () => {
  it('names the work order the person is looking at', () => {
    const q = buildQuestion('what is blocking it?', { today: '2026-10-05', weekday: 'Monday', askerName: 'Dana', askerRole: 'OM', page: '/work-orders/48213/quote', abilities: 'Quotes [quotes]: view' });
    expect(q).toMatch(/Today is Monday 2026-10-05/);
    expect(q).toMatch(/looking at work order 48213/);
    expect(q).toContain('What this person may do');
    expect(q).toContain('Quotes [quotes]: view\n</context>');
    expect(q.endsWith('what is blocking it?')).toBe(true);
  });

  it('lists statuses, the visible fields and the taught notes', () => {
    const ref = buildReference(
      [{ name: 'Waiting for Quote', group: 'open', phase: 'Quote' }],
      [{ code: 'open', label: 'Open' }],
      [
        { key: 'client', label: 'Client', type: 'select', group: 'Work order', options: [{ value: 'Acme' }] },
        { key: 'status', label: 'Status', type: 'select', group: 'Status', options: [{ value: 'Waiting for Quote' }] },
      ],
      { select: ['eq', 'in'] },
      [{ title: 'Pending vendor', body: 'means Waiting\nfor Vendor' }],
    );
    expect(ref).toMatch(/- Waiting for Quote · group: open · phase: Quote/);
    expect(ref).toMatch(/client — Client \(select\) · values: Acme/);
    expect(ref).toMatch(/status — Status \(select\)\n|status — Status \(select\)$/m);
    expect(ref).toMatch(/- Pending vendor: means Waiting for Vendor/);
  });
});

describe('knowing whether the person can follow the steps', () => {
  const om = {
    isSuperAdmin: false,
    roleLabel: 'OM',
    perms: {
      role: {
        work_orders: { view: true, edit: true },
        'work_orders/scope': { view: false },
        'work_orders/scope/entity/SFM': { view: true },
        'work_orders/status': { edit: false, create: true },
        quotes: { view: true },
      },
      overrides: {},
    },
  };
  const admin = { isSuperAdmin: false, roleLabel: 'Admin', perms: { role: { admin: { view: true, edit: true } }, overrides: {} } };
  const superAdmin = { isSuperAdmin: true, roleLabel: 'Admin', perms: { role: {}, overrides: {} } };
  const lines = (text: string) => text.split('\n');

  it('lists what a role may and may not do, one row per line', () => {
    const rows = lines(describeAbilities(om, om));
    expect(rows).toContain('Work orders [work_orders]: view, edit');
    expect(rows).toContain('  Which work orders they see: only the ones assigned to them, plus everything billed by SFM');
    expect(rows).toContain('  Status changes: must request a status change, which a manager approves');
    expect(rows).toContain('Quotes [quotes]: view');
    expect(rows).toContain('  Automations [admin/automations]: none');
    expect(rows).toContain('Payments [payments]: none');
  });

  it('reads the Admin console from the person signed in, not who they are viewing as', () => {
    expect(lines(describeAbilities(admin, admin))).toContain('  Automations [admin/automations]: view, edit');
    // A super admin viewing as an OM still holds the console; the rest is the OM's.
    const viewingAs = lines(describeAbilities(superAdmin, om));
    expect(viewingAs).toContain('  Automations [admin/automations]: view, edit');
    expect(viewingAs).toContain('Payments [payments]: none');
    // Acting as an admin does not lend an OM the console.
    expect(lines(describeAbilities(om, admin))).toContain('  Automations [admin/automations]: none');
  });

  it('says a super admin may do everything', () => {
    expect(describeAbilities(superAdmin, superAdmin).startsWith('Super admin: may do everything')).toBe(true);
  });
});

describe('the standing instructions', () => {
  it('carry the guide, the permission rule and the limit to this app', () => {
    expect(STATIC_INSTRUCTIONS).toContain('Anything outside The One is not yours to answer');
    expect(STATIC_INSTRUCTIONS).toContain('You are not allowed to add automations');
    expect(STATIC_INSTRUCTIONS).toContain('click **New automation**');
    expect(STATIC_INSTRUCTIONS).toContain('`admin/automations` edit');
    for (const section of ['Work Orders list', 'Quotes', 'Payments', 'Approvals', 'Vendors', 'Admin console']) {
      expect(STATIC_INSTRUCTIONS).toContain(`### ${section}`);
    }
  });

  it('never change between requests', () => {
    expect(STATIC_INSTRUCTIONS).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });
});

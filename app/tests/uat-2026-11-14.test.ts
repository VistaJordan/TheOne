/**
 * Elise's list of 2026-11-14 (no migration): the SLA is required at intake for
 * Corrigo clients only; a quote above the NTE is sent with a warning; a
 * message seen on the Messages tab marks its notice read; a payment under
 * $500 on a loss-making job (Cost above the NTE) is never auto-approved and is
 * a TL's / ATL's (or the AM's) to approve.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INTAKE_REQUIRED_FIELDS,
  intakeFieldAsked,
  intakeMissing,
  mayApproveOverNtePayment,
  overNteApproverLabel,
  quoteOverNteWarning,
} from '@theone/shared';

const root = resolve(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8');

const FULL: Record<string, unknown> = Object.fromEntries(INTAKE_REQUIRED_FIELDS.map((f) => [f.key, 'x']));

describe('SLA: Corrigo clients only', () => {
  const sla = INTAKE_REQUIRED_FIELDS.find((f) => f.key === 'SLA Due Date')!;
  it('the SLA names Corrigo; nothing else names a portal', () => {
    expect(sla.portal).toBe('corrigo');
    expect(INTAKE_REQUIRED_FIELDS.filter((f) => f.portal).map((f) => f.key)).toEqual(['SLA Due Date']);
  });
  it('is asked only when Client Portal Type is Corrigo', () => {
    expect(intakeFieldAsked(sla, { 'Client Portal Type': 'Corrigo' })).toBe(true);
    expect(intakeFieldAsked(sla, { 'Client Portal Type': ' corrigo ' })).toBe(true);
    expect(intakeFieldAsked(sla, { 'Client Portal Type': 'Ecotrak' })).toBe(false);
    expect(intakeFieldAsked(sla, {})).toBe(false);
    const { 'SLA Due Date': _sla, ...rest } = FULL;
    expect(intakeMissing({ fields: rest })).toEqual([]);
    expect(intakeMissing({ fields: { ...rest, 'Client Portal Type': 'Corrigo' } }).map((f) => f.label)).toEqual(['SLA']);
  });
  it('the Incoming rows carry the portal type so the check can read it', () => {
    const svc = read('apps', 'api', 'src', 'services', 'approvals.ts');
    expect(svc).toContain('CLIENT_PORTAL_TYPE_KEY,\n].map((k)'.replace(/\n/g, svc.includes('\r\n') ? '\r\n' : '\n'));
  });
});

describe('a quote above the NTE is sent, with a warning', () => {
  it('sendQuote no longer refuses it', () => {
    const q = read('apps', 'api', 'src', 'services', 'quotes.ts');
    const send = q.slice(q.indexOf('export async function sendQuote('), q.indexOf('export async function rejectQuote('));
    expect(send).not.toContain('QUOTE_OVER_NTE');
    expect(send).not.toContain('quoteOverNte(');
  });
  it('the builder draws the warning beside an unlocked Send to client', () => {
    const b = read('apps', 'web', 'src', 'pages', 'QuoteBuilderPage.tsx');
    expect(b).toContain('quoteOverNteWarning(nteTotal, nte)');
    expect(b).toContain('Above NTE');
    expect(quoteOverNteWarning(1200, 1000)).toContain('$1,200.00');
  });
});

describe('a message seen marks its notice read', () => {
  it('the service matches the message links of this work order', () => {
    const svc = read('apps', 'api', 'src', 'services', 'notices.ts');
    expect(svc).toContain('export async function markMessageNoticesSeen(');
    expect(svc).toContain('?tab=messages&msg=${id}');
    expect(svc).toContain('read_at IS NULL AND link = ANY($2::text[])');
  });
  it('the route sits under /notices (quiet for live sync) and the panel calls it', () => {
    expect(read('apps', 'api', 'src', 'routes', 'notices.ts')).toContain("app.post('/notices/seen-messages'");
    const panel = read('apps', 'web', 'src', 'components', 'wo', 'messages', 'MessagesPanel.tsx');
    expect(panel).toContain('<MarkNoticesSeen woNumber={woNumber} ids={items.map((m) => m.id)} />');
    expect(panel).toContain("qc.invalidateQueries({ queryKey: ['notices'] })");
  });
});

describe('a payment under $500 on a loss-making job', () => {
  it('TL / ATL / AM approve one under $500 above the NTE; $500 and over stays the AM', () => {
    for (const r of ['tl', 'atl', 'am']) expect(mayApproveOverNtePayment(r, false, 499.99)).toBe(true);
    for (const r of ['om', 'senior_om', 'om_probation', 'oa', 'ap']) expect(mayApproveOverNtePayment(r, false, 100)).toBe(false);
    expect(mayApproveOverNtePayment('tl', false, 500)).toBe(false);
    expect(mayApproveOverNtePayment('atl', false)).toBe(false);
    expect(mayApproveOverNtePayment('am', false, 5000)).toBe(true);
    expect(mayApproveOverNtePayment('om', true, 5000)).toBe(true);
    expect(overNteApproverLabel(200)).toBe('a TL, an ATL or an Account Manager');
    expect(overNteApproverLabel(800)).toBe('an Account Manager');
  });
  it('is never approved as it is raised, whatever an override covers', () => {
    const svc = read('apps', 'api', 'src', 'services', 'payments.ts');
    expect(svc).toContain('const lossJob = await aboveNteFor(taskId, input.amount);');
    expect(svc).toContain('const autoApproved = !approval.needed && !overage && !lossJob;');
    expect(svc).toContain('mayApproveOverNtePayment(actor.role, actor.isSuperAdmin, amount)');
  });
});

describe('Add work order: an exit by mistake keeps a draft', () => {
  const dlg = read('apps', 'web', 'src', 'components', 'wo', 'list', 'CreateWorkOrderDialog.tsx');
  it('a refresh or closed tab asks first, then files the draft on the way out', () => {
    expect(dlg).toContain("window.addEventListener('beforeunload', warn)");
    expect(dlg).toContain("window.addEventListener('pagehide', leave)");
    expect(dlg).toContain('createIntakeDraftOnExit(draftInput())');
    expect(read('apps', 'web', 'src', 'api', 'client.ts')).toContain('keepalive: true');
  });
  it('leaving inside the app files it too; Create, Save as draft and Cancel do not', () => {
    expect(dlg).toContain('// Unmounted with the form still open (Back, a link): keep it as a draft.');
    expect(dlg).toContain('onClick={cancel}');
    expect(dlg.match(/finished\.current = true;/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

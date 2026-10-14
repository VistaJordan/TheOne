/* W4-2 (D1) — viewing as someone is read-only.
 *
 * While a super admin is "viewing as" another person, the request's actor is
 * the impersonated person (actingPrincipalFromRequest returns actingAs), so a
 * write made in that state would be logged under the wrong name. Until an
 * on_behalf_of column exists, plugins/authGuard refuses every non-GET under
 * /api for an impersonating session — except the two acts that end or switch
 * the view, and signing out — and also the five GETs that write a row under
 * the acting principal (the CSV exports, Save as PDF, the technician map),
 * whatever the method, because Fastify answers HEAD with the GET handler.
 *
 * Pinned here: the pure decision (`impersonationWriteBlocked`), the exact
 * allowlist and denylist, the 403's sentence, that every denylisted path is a
 * route that really exists (so a moved route fails here rather than silently
 * escaping the rule), and — by reading the plugin's source — that the
 * preHandler enforces it after the public-path return and the session check,
 * on the query-stripped path. This file FAILS on the tree before the fix (the
 * exports do not exist) and passes after it. Hermetic: no database, no
 * network, no .env.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  IMPERSONATION_GET_DENYLIST,
  IMPERSONATION_GET_DENYLIST_ROUTES,
  IMPERSONATION_READ_ONLY_MESSAGE,
  IMPERSONATION_WRITE_ALLOWLIST,
  impersonationWriteBlocked,
} from '../apps/api/src/plugins/authGuard';
import { ApiRequestError } from '../apps/web/src/api/client';
import { importRefusalRows } from '../apps/web/src/components/wo/list/ImportDialog';
import { READ_ONLY_HINT, downloadLinkProps } from '../apps/web/src/lib/actor';

const READS = ['GET', 'HEAD', 'OPTIONS'] as const;
const WRITES = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
const SOME_PATHS = [
  '/api/work-orders/abc/fields',
  '/api/admin/users/1',
  '/api/prefs',
  '/api/auth/impersonate',
  '/api/auth/logout',
  '/api/notifications/read',
  '/api/assistant/ask',
];

/** The GETs that write a row under the acting principal, with the row each
    one writes — the reason it is on the denylist. */
const TRACED_READS: Array<[path: string, writes: string]> = [
  ['/api/work-orders/export', 'work_orders_exported'],
  ['/api/vendors/export', 'vendors_exported'],
  ['/api/work-orders/abc/pdf', 'work_order_pdf_saved'],
  ['/api/work-orders/abc/tech-map', 'vendor_map_log.principal_id'],
  ['/api/client-updates/abc/csv', 'client_update_exported'],
];

describe('impersonationWriteBlocked (W4-2)', () => {
  it('never blocks a read that leaves no trace, whatever the path', () => {
    for (const m of READS) {
      for (const p of SOME_PATHS) expect(impersonationWriteBlocked(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it('blocks every write under /api that is not on the allowlist', () => {
    expect(impersonationWriteBlocked('POST', '/api/work-orders/abc/fields')).toBe(true);
    expect(impersonationWriteBlocked('PATCH', '/api/admin/users/1')).toBe(true);
    expect(impersonationWriteBlocked('PUT', '/api/prefs')).toBe(true);
    expect(impersonationWriteBlocked('DELETE', '/api/work-orders/abc')).toBe(true);
    expect(impersonationWriteBlocked('POST', '/api/notifications/read')).toBe(true);
    for (const m of WRITES) expect(impersonationWriteBlocked(m, '/api/quotes/1/approve'), m).toBe(true);
  });

  it('lets through only the acts that end or switch the view, and signing out', () => {
    expect(impersonationWriteBlocked('DELETE', '/api/auth/impersonate')).toBe(false);
    expect(impersonationWriteBlocked('POST', '/api/auth/impersonate')).toBe(false);
    expect(impersonationWriteBlocked('POST', '/api/auth/logout')).toBe(false);
    // The method is part of the key: another verb on the same path is a write
    // like any other.
    expect(impersonationWriteBlocked('PUT', '/api/auth/impersonate')).toBe(true);
    expect(impersonationWriteBlocked('PATCH', '/api/auth/logout')).toBe(true);
    // POST /api/auth/dev-login is deliberately NOT asserted here: it is a
    // PUBLIC path, and the guard returns on isPublic(path) before this rule is
    // ever asked, so whatever the pure function answers for it describes a
    // branch the guard never takes. Its precedence is pinned under "the
    // preHandler enforces it" below.
  });

  it('the allowlist is exactly those three entries', () => {
    expect([...IMPERSONATION_WRITE_ALLOWLIST].sort()).toEqual(
      ['DELETE /api/auth/impersonate', 'POST /api/auth/impersonate', 'POST /api/auth/logout'].sort(),
    );
  });

  it('handles a lower-case method', () => {
    expect(impersonationWriteBlocked('get', '/api/prefs')).toBe(false);
    expect(impersonationWriteBlocked('post', '/api/auth/impersonate')).toBe(false);
    expect(impersonationWriteBlocked('patch', '/api/prefs')).toBe(true);
  });

  it('takes the PATH only — the caller (pathOf) must strip the query string', () => {
    // A query string is not part of the allowlist key, so an unstripped URL is
    // refused. This pins that the guard compares pathOf(req), never req.url.
    expect(impersonationWriteBlocked('POST', '/api/auth/impersonate?x=1')).toBe(true);
  });

  it('carries the sentence the 403 shows', () => {
    expect(IMPERSONATION_READ_ONLY_MESSAGE).toBe(
      'Viewing as another user is read-only. Stop viewing as them to make changes.',
    );
  });
});

/** Source text with CRLF folded to LF. The repo runs core.autocrlf=true with
    no .gitattributes, so the same file is CRLF on one checkout and LF on
    another (`git ls-files --eol`: i/lf, w/crlf) — a `\n`-anchored assertion
    below must not depend on which one this is. `rawSrc` is the bytes as they
    are on disk, for the line-ending proof at the foot of this file. */
const foldCrlf = (s: string) => s.replace(/\r\n/g, '\n');
const rawSrc = (...parts: string[]) => readFileSync(resolve(__dirname, '..', ...parts), 'utf8');
const readSrc = (...parts: string[]) => foldCrlf(rawSrc(...parts));
const apiSrc = (...parts: string[]) => readSrc('apps', 'api', 'src', ...parts);
const webSrc = (...parts: string[]) => readSrc('apps', 'web', 'src', ...parts);

describe('GETs that write a row under the acting principal are refused too', () => {
  it('refuses the five traced reads whatever the method', () => {
    for (const [p, writes] of TRACED_READS) {
      for (const m of [...READS, ...WRITES]) {
        expect(impersonationWriteBlocked(m, p), `${m} ${p} (${writes})`).toBe(true);
      }
    }
  });

  it('is exactly five patterns, one per traced read', () => {
    expect(IMPERSONATION_GET_DENYLIST).toHaveLength(5);
    for (const [p] of TRACED_READS) {
      expect(IMPERSONATION_GET_DENYLIST.filter((re) => re.test(p)), p).toHaveLength(1);
    }
  });

  it('an encoded spelling of a denylisted path is refused too — by route pattern and by decoded path (skeptic loop 2)', () => {
    const cases: [string, string][] = [
      ['/api/work-orders/%65xport', '/api/work-orders/export'],
      ['/api/work-orders/abc/%70df', '/api/work-orders/:id/pdf'],
      ['/api/work-orders/abc/tech%2Dmap', '/api/work-orders/:id/tech-map'],
      ['/api/client-updates/abc/%63sv', '/api/client-updates/:id/csv'],
    ];
    for (const [raw, route] of cases) {
      for (const m of ['GET', 'HEAD']) {
        expect(impersonationWriteBlocked(m, raw, route), `${m} ${raw} via route`).toBe(true);
        expect(impersonationWriteBlocked(m, raw), `${m} ${raw} via decoded path`).toBe(true);
      }
    }
    // A path that does not decode is matched as it came, never thrown on.
    expect(impersonationWriteBlocked('GET', '/api/work-orders/%E0%A4%A')).toBe(false);
  });

  it('the route denylist is the five app.get strings with the /api prefix, each registered in its routes file', () => {
    const routes = [...IMPERSONATION_GET_DENYLIST_ROUTES].sort();
    expect(routes).toEqual(
      [
        '/api/client-updates/:id/csv',
        '/api/vendors/export',
        '/api/work-orders/:id/pdf',
        '/api/work-orders/:id/tech-map',
        '/api/work-orders/export',
      ].sort(),
    );
    const files = ['clientUpdates.ts', 'vendorWork.ts', 'woPdf.ts', 'vendors.ts', 'workOrders.ts'].map((f) =>
      apiSrc('routes', f),
    );
    for (const r of routes) {
      const registered = `app.get('${r.slice('/api'.length)}'`;
      expect(files.some((src) => src.includes(registered)), registered).toBe(true);
    }
    // A neighbouring route pattern is not on it.
    expect(impersonationWriteBlocked('GET', '/api/work-orders/abc', '/api/work-orders/:id')).toBe(false);
  });

  it('leaves the neighbouring reads alone', () => {
    const open = [
      '/api/work-orders',
      '/api/work-orders/abc',
      '/api/work-orders/abc/record',
      '/api/work-orders/abc/suggested-vendors',
      '/api/work-orders/abc/technicians',
      '/api/work-orders/abc/attachments/def',
      '/api/work-orders/abc/pdf/x',
      '/api/vendors',
      '/api/vendors/abc',
      '/api/vendors/board',
      '/api/client-updates',
      '/api/client-updates/abc',
      '/api/client-updates/abc/deliveries',
      '/api/pulse',
      '/api/dashboards/abc/data',
    ];
    for (const m of READS) {
      for (const p of open) expect(impersonationWriteBlocked(m, p), `${m} ${p}`).toBe(false);
    }
  });

  it("does not list Admin › Audit's export: routes/admin.ts logs it under the REAL user", () => {
    expect(impersonationWriteBlocked('GET', '/api/admin/audit/export')).toBe(false);
    const admin = apiSrc('routes', 'admin.ts');
    const at = admin.indexOf('function requireAdmin(');
    expect(at).toBeGreaterThan(-1);
    const requireAdmin = admin.slice(at, admin.indexOf('\n}', at));
    expect(requireAdmin).toMatch(/requirePerm\(\s*req\.auth\.user,/);
    expect(requireAdmin).toMatch(/return req\.auth\.user\.id;/);
    const exportAt = admin.indexOf("app.get('/admin/audit/export'");
    expect(exportAt).toBeGreaterThan(-1);
    expect(admin.slice(exportAt, exportAt + 400)).toMatch(/const actorId = requireAdmin\(req, 'audit'\)/);
  });

  it('every denylisted path is a route that exists, and each really writes under the actor', () => {
    // A moved or renamed route must update the denylist; a write that moves to
    // the real user (or goes away) should take its path off the list.
    expect(apiSrc('routes', 'workOrders.ts')).toContain("app.get('/work-orders/export'");
    expect(apiSrc('routes', 'workOrders.ts')).toMatch(/logExport\(p\.id, 'work_orders_exported'/);
    expect(apiSrc('routes', 'vendorWork.ts')).toContain("app.get('/vendors/export'");
    expect(apiSrc('services', 'vendorWork.ts')).toContain("action: 'vendors_exported'");
    expect(apiSrc('routes', 'woPdf.ts')).toContain("app.get('/work-orders/:id/pdf'");
    expect(apiSrc('services', 'woPdf.ts')).toContain("'work_order_pdf_saved'");
    expect(apiSrc('routes', 'vendors.ts')).toContain("app.get('/work-orders/:id/tech-map'");
    expect(apiSrc('services', 'vendorMap.ts')).toContain('INSERT INTO vendor_map_log (principal_id');
    expect(apiSrc('routes', 'clientUpdates.ts')).toContain("app.get('/client-updates/:id/csv'");
    expect(apiSrc('services', 'clientUpdates.ts')).toContain("action: 'client_update_exported'");
  });
});

describe('the preHandler enforces it', () => {
  const src = apiSrc('plugins', 'authGuard.ts');
  const start = src.indexOf("app.addHook('preHandler'");
  const hook = src.slice(start);

  it('checks auth.isImpersonating through impersonationWriteBlocked', () => {
    expect(start).toBeGreaterThan(-1);
    expect(hook).toMatch(/auth\.isImpersonating/);
    expect(hook).toMatch(/impersonationWriteBlocked\(/);
    expect(hook).toMatch(/IMPERSONATION_READ_ONLY/);
  });

  it('runs after the public-path return and the session check, on the stripped path', () => {
    const publicAt = hook.indexOf('isPublic(');
    const unauthorizedAt = hook.indexOf('throw unauthorized()');
    const blockedAt = hook.indexOf('impersonationWriteBlocked(');
    expect(publicAt).toBeGreaterThan(-1);
    expect(unauthorizedAt).toBeGreaterThan(publicAt);
    expect(blockedAt).toBeGreaterThan(unauthorizedAt);
    // The guard hands the pure function the normalised path, not req.url, and
    // the matched route's pattern so an encoded path cannot dodge the denylist.
    expect(hook).toMatch(/impersonationWriteBlocked\(req\.method,\s*path,\s*req\.routeOptions\??\.url\)/);
    expect(hook).not.toMatch(/impersonationWriteBlocked\([^)]*req\.url/);
  });

  it('dev-login is public: the guard returns before the rule is asked, so the pure answer for it is moot', () => {
    // An earlier version of this file asserted impersonationWriteBlocked('POST',
    // '/api/auth/dev-login') as if it were the guard's behaviour. It is not:
    // the path sits in PUBLIC_PATHS, and the hook returns on isPublic(path)
    // before the session check and before the read-only rule — the branch
    // that assertion described is never taken. The precedence is what matters.
    const listAt = src.indexOf('const PUBLIC_PATHS = new Set([');
    expect(listAt).toBeGreaterThan(-1);
    const publicPaths = src.slice(listAt, src.indexOf(']);', listAt));
    expect(publicPaths).toContain("'/api/auth/dev-login'");
    const returnAt = hook.indexOf('if (isPublic(path)) return;');
    expect(returnAt).toBeGreaterThan(-1);
    expect(returnAt).toBeLessThan(hook.indexOf('throw unauthorized()'));
    expect(returnAt).toBeLessThan(hook.indexOf('impersonationWriteBlocked('));
  });

  it('answers 403 FORBIDDEN with details.code IMPERSONATION_READ_ONLY', () => {
    expect(hook).toMatch(
      /new ApiError\('FORBIDDEN',\s*IMPERSONATION_READ_ONLY_MESSAGE,\s*\{\s*code:\s*'IMPERSONATION_READ_ONLY'\s*\}\)/,
    );
  });
});

// ── The web side (F7 follow-ups, FIX-RUNBOOK §10) ────────────────────────────
//
// The four download anchors answered by the denylist above are plain
// `<a href download>`s: while viewing as someone the browser would fetch the
// 403 and save its JSON body as the file. They go inert instead, through one
// helper, and the hint they carry is the ActorSwitcher's own.

describe('downloads go inert while viewing as (F7)', () => {
  it('READ_ONLY_HINT lives in lib/actor and the switcher imports it back', () => {
    expect(READ_ONLY_HINT).toBe('Viewing as someone is read-only. Switch back to Myself to make changes.');
    const switcher = webSrc('components', 'ActorSwitcher.tsx');
    expect(switcher).toMatch(/import \{[^}]*\bREAD_ONLY_HINT\b[^}]*\} from '\.\.\/lib\/actor'/);
    expect(switcher).not.toMatch(/const READ_ONLY_HINT\b/);
    expect(switcher).toContain('title={READ_ONLY_HINT}');
  });

  it('downloadLinkProps leaves a live link exactly as given — attribute for attribute', () => {
    expect(downloadLinkProps(false, '/api/work-orders/export?x=1', { title: 'Export' })).toEqual({
      href: '/api/work-orders/export?x=1',
      title: 'Export',
    });
    // No title asked for → no title key at all (a bare `href` is what the
    // Vendors anchor had), and `download` is passed through only when asked.
    const bare = downloadLinkProps(false, '/api/vendors/export');
    expect(Object.keys(bare)).toEqual(['href']);
    expect(bare.href).toBe('/api/vendors/export');
    const dl = downloadLinkProps(false, '/api/work-orders/abc/pdf?kind=full', { download: true });
    expect(Object.keys(dl).sort()).toEqual(['download', 'href']);
    expect(dl.download).toBe(true);
    expect(downloadLinkProps(false, '/x', { download: false })).toEqual({ href: '/x' });
  });

  it('while viewing as: no href and no download, aria-disabled as a link, the hint as the title, and the click is swallowed', () => {
    const inert = downloadLinkProps(true, '/api/work-orders/abc/pdf?kind=full', { title: 'Save', download: true });
    expect(inert.href).toBeUndefined();
    expect(inert.download).toBeUndefined();
    expect(inert['aria-disabled']).toBe(true);
    expect(inert.role).toBe('link');
    expect(inert.title).toBe(READ_ONLY_HINT);
    let prevented = 0;
    inert.onClick?.({ preventDefault: () => { prevented += 1; } });
    expect(prevented).toBe(1);
  });

  it('the inert link still reaches its hint: a tab stop, hover kept on past messages.css, and visibly off', () => {
    // messages.css's `a.btn[aria-disabled="true"] { pointer-events: none }` —
    // written for the Quo tel:/sms: buttons — would stop the hover that shows
    // the title on the two .btn anchors, and an href-less <a> is not focusable;
    // .tool-btn and .rec-pdf-item have no [aria-disabled] rule, so the Export
    // button and the PDF items would look live. The helper carries the fix
    // itself: pointer events on, tabIndex 0, dimmed like .tool-btn:disabled.
    const inert = downloadLinkProps(true, '/api/vendors/export');
    expect(inert.tabIndex).toBe(0);
    expect(inert.style).toEqual({ opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'auto' });
    const css = webSrc('styles', 'messages.css');
    expect(css).toMatch(/a\.btn\[aria-disabled="true"\]\s*\{[^}]*pointer-events:\s*none/);
    expect(webSrc('styles', 'wo-list.css')).toMatch(/\.tool-btn:disabled\s*\{\s*opacity:\s*0\.5;/);
  });

  it('the four anchors use it with isImpersonating, one per denylisted route, with no live href or bare download beside it', () => {
    const anchors: Array<[file: string[], urlHelper: string, download: boolean]> = [
      [['pages', 'WorkOrdersPage.tsx'], 'workOrdersExportUrl', false],
      [['pages', 'ClientUpdatesPage.tsx'], 'clientUpdateCsvUrl', false],
      [['pages', 'VendorsPage.tsx'], 'vendorExportUrl', true],
      [['components', 'wo', 'record', 'RecordParts.tsx'], 'workOrderPdfUrl', true],
    ];
    for (const [file, helper, download] of anchors) {
      const name = file.join('/');
      const src = webSrc(...file);
      expect(src, name).toMatch(/import \{[^}]*\bdownloadLinkProps\b[^}]*\} from '(\.\.\/)+lib\/actor'/);
      const call = `{...downloadLinkProps(isImpersonating, ${helper}(`;
      const at = src.indexOf(call);
      expect(at, name).toBeGreaterThan(-1);
      expect(src.indexOf(call, at + 1), `${name}: one anchor`).toBe(-1);
      expect(src, name).not.toContain(`href={${helper}(`);
      expect(src, name).toMatch(/\{[^}]*\bisImpersonating\b[^}]*\}\s*=\s*useAuth\(\)/);
      // The <a>'s attributes up to the end of the helper's line. `download`
      // goes through the helper (so the inert link carries no download intent)
      // and never sits beside it as a bare attribute.
      const tag = src.slice(src.lastIndexOf('<a', at), src.indexOf('\n', at));
      expect(tag, name).not.toMatch(/\sdownload(?=[\s>])/);
      expect(tag.includes('download: true'), `${name}: download via the helper`).toBe(download);
    }
  });

  it("the PDF menu's items write role=\"menuitem\" after the spread, so the menu wins over the helper's link role", () => {
    const src = webSrc('components', 'wo', 'record', 'RecordParts.tsx');
    const at = src.indexOf('{...downloadLinkProps(isImpersonating, workOrderPdfUrl(');
    const tag = src.slice(src.lastIndexOf('<a', at), src.indexOf('\n', at));
    expect(tag.indexOf('role="menuitem"')).toBeGreaterThan(tag.indexOf('downloadLinkProps('));
    expect(tag).toMatch(/onClick=\{isImpersonating \? \(e\) => e\.preventDefault\(\) : \(\) => setOpen\(false\)\}/);
  });
});

describe('an import refusal names its rows (F7)', () => {
  const refusal = (code: string, wo_numbers: unknown) =>
    new ApiRequestError(403, { error: { code: 'FORBIDDEN', message: 'refused', details: { code, wo_numbers } } }, 'x');

  it('lists details.wo_numbers for IMPORT_SCOPE and IMPORT_STATUS_PERMISSION', () => {
    expect(importRefusalRows(refusal('IMPORT_SCOPE', ['WO-1', 'WO-2']))).toEqual(['WO-1', 'WO-2']);
    expect(importRefusalRows(refusal('IMPORT_STATUS_PERMISSION', ['WO-3', 'row 4']))).toEqual(['WO-3', 'row 4']);
  });

  it('names no rows for any other failure, and never throws on a payload it does not recognise', () => {
    expect(importRefusalRows(refusal('SOMETHING_ELSE', ['WO-1']))).toEqual([]);
    expect(importRefusalRows(refusal('IMPORT_SCOPE', 'WO-1'))).toEqual([]);
    expect(importRefusalRows(refusal('IMPORT_SCOPE', [1, null, 'WO-9']))).toEqual(['WO-9']);
    expect(importRefusalRows(new ApiRequestError(500, null, 'boom'))).toEqual([]);
    expect(importRefusalRows(new Error('network'))).toEqual([]);
    expect(importRefusalRows(undefined)).toEqual([]);
  });

  it('the dialog keeps them with the message and draws them under it', () => {
    const src = webSrc('components', 'wo', 'list', 'ImportDialog.tsx');
    expect(src).toMatch(/rows:\s*importRefusalRows\(e\)/);
    expect(src).toMatch(/error\.rows\.length > 0/);
  });
});

describe('the bell asks the Pulse only for a role with work_orders view (F7)', () => {
  it('useNotifications takes `enabled` and hands it to the query', () => {
    const src = webSrc('hooks', 'useObligations.ts');
    const at = src.indexOf('export function useNotifications(');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('\n}', at));
    expect(fn).toMatch(/useNotifications\(enabled = true\)/);
    expect(fn).toMatch(/\n\s+enabled,\r?\n/);
  });

  it("PulseBell gates it on can('work_orders', 'view') and leaves the notices half alone", () => {
    const src = webSrc('components', 'obligations', 'PulseBell.tsx');
    expect(src).toMatch(/const canPulse = can\('work_orders', 'view'\);/);
    expect(src).toMatch(/useNotifications\(canPulse\)/);
    // 0059's two queries, exactly as they were.
    expect(src).toContain('useQuery({ queryKey: NOTICE_COUNT_KEY, queryFn: getNoticeCount, refetchInterval: 60_000, retry: 0 })');
    expect(src).toContain('useQuery({ queryKey: NOTICES_KEY, queryFn: getNotices, enabled: open, retry: 0 })');
  });

  it('without the Pulse, "Nothing for you" waits for the notices to load — no empty state flashes while the list is on its way', () => {
    // The notices list is `enabled: open`, so on the first open forYou is []
    // until it lands; the dropdown shows the notices' own three states
    // (loading / unavailable / empty), as the Pulse half does for its rows.
    const src = webSrc('components', 'obligations', 'PulseBell.tsx');
    const at = src.indexOf('{!canPulse && (');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf('{canPulse && (', at));
    expect(block).toMatch(/notices\.isLoading && <div className="pulse-pop-note">Loading…<\/div>/);
    expect(block).toMatch(/notices\.isError && !notices\.isLoading &&/);
    expect(block).toMatch(
      /!notices\.isLoading && !notices\.isError && forYou\.length === 0 && \(\s*<div className="pulse-pop-note">Nothing for you right now\.<\/div>/,
    );
    expect(src).not.toMatch(/!canPulse && forYou\.length === 0 &&/);
  });
});

describe('the source readers above are line-ending proof', () => {
  // An earlier version asserted that readSrc's OUTPUT carries no '\r' — true
  // by construction, since readSrc IS the fold, so it proved nothing. What the
  // name means is pinned on the bytes as they are on disk instead: every file
  // the \n-anchored assertions above read is uniformly ONE ending (every line
  // CRLF or every line LF — the house rule is "keep each file's own line
  // endings", and a mixed file is what a careless edit leaves behind) with no
  // lone '\r', the one ending the fold would not touch; and the fold itself on
  // a synthetic string, so the proof holds on either checkout, whichever the
  // raw files happen to be (`git ls-files --eol`'s w/ column says which).
  it('the fold turns CRLF into LF and touches nothing else', () => {
    expect(foldCrlf('a\r\nb\r\n')).toBe('a\nb\n');
    expect(foldCrlf('a\nb\n')).toBe('a\nb\n');
    expect(foldCrlf('a\rb')).toBe('a\rb'); // a lone CR is left alone — the raw check below refuses one
  });

  it('every file read above is uniformly one line ending on disk, with no lone CR', () => {
    const files: string[][] = [
      ['apps', 'api', 'src', 'plugins', 'authGuard.ts'],
      ['apps', 'web', 'src', 'lib', 'actor.ts'],
      ['apps', 'web', 'src', 'components', 'ActorSwitcher.tsx'],
      ['apps', 'web', 'src', 'pages', 'WorkOrdersPage.tsx'],
      ['apps', 'web', 'src', 'pages', 'ClientUpdatesPage.tsx'],
      ['apps', 'web', 'src', 'pages', 'VendorsPage.tsx'],
      ['apps', 'web', 'src', 'components', 'wo', 'record', 'RecordParts.tsx'],
      ['apps', 'web', 'src', 'components', 'wo', 'list', 'ImportDialog.tsx'],
      ['apps', 'web', 'src', 'components', 'obligations', 'PulseBell.tsx'],
      ['apps', 'web', 'src', 'hooks', 'useObligations.ts'],
      ['apps', 'web', 'src', 'styles', 'messages.css'],
      ['apps', 'web', 'src', 'styles', 'wo-list.css'],
    ];
    for (const parts of files) {
      const name = parts.join('/');
      const raw = rawSrc(...parts);
      const lf = (raw.match(/\n/g) ?? []).length;
      const crlf = (raw.match(/\r\n/g) ?? []).length;
      expect(lf, `${name}: no line ends at all`).toBeGreaterThan(0);
      expect(raw, `${name}: a lone \\r`).not.toMatch(/\r(?!\n)/);
      expect(crlf === 0 || crlf === lf, `${name}: ${crlf} CRLF among ${lf} line ends — mixed endings`).toBe(true);
      // …and the reader the assertions above use folds whatever the file has.
      expect(readSrc(...parts), name).not.toContain('\r');
    }
  });
});

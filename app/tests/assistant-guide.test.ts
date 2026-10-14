/* The assistant's guide (apps/api/src/lib/assistantGuide*.ts) is written by
 * hand from the JSX, and the assistant repeats its labels to people. This
 * suite fails when a **bold label** in the guide is not, verbatim, somewhere
 * in the web source under apps/web/src — a renamed button, a dropped lane, a
 * retired word — when a sentence it quotes from the API or from a screen has
 * changed, and when the Payments entry drifts from what PaymentsPage and the
 * payment lifecycle say. The label check is a text search over every .ts/.tsx
 * file, not a render: a label that survives in a constant, a type or a column
 * header still passes, so a green run means "the words exist in the web
 * source", not "that button is on that screen". Hermetic: source trees read
 * as text, no database, no network. */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_GUIDE } from '../apps/api/src/lib/assistantGuide';

const APP = resolve(__dirname, '..');
const WEB_SRC = join(APP, 'apps', 'web', 'src');
const API_SRC = join(APP, 'apps', 'api', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** A source file as the screen shows it: comments dropped (a label that
    survives only in a comment is a renamed button, not a screen — that is how
    "Approve & Send to CMMS" slipped through a plain substring check) and the
    entities JSX spells a character with decoded (`Submit &amp; assign` reads
    "Submit & assign"). Only whole-line and JSX comments go; a `//` after code
    stays, so a URL inside a string is never cut. */
const ENTITY: Record<string, string> = {
  '&amp;': '&', '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>',
  '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘', '&hellip;': '…',
};
function asShown(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')
    .replace(/&(amp|apos|quot|lt|gt|nbsp|rsquo|lsquo|hellip);/g, (m) => ENTITY[m]);
}

const webFile = (rel: string) => asShown(readFileSync(join(WEB_SRC, rel), 'utf8'));
/** Every web source file as shown, one string: a label must occur in it verbatim. */
const webSource = walk(WEB_SRC).map((p) => asShown(readFileSync(p, 'utf8'))).join('\n');

/** The guide's convention: a label on screen is written **bold**. */
const boldLabels = [...new Set([...APP_GUIDE.matchAll(/\*\*([^*\n]+?)\*\*/g)].map((m) => m[1]))];

/** Bold text that is NOT a label on any screen, with why. Keep it short. */
const ALLOWLIST: Record<string, string> = {
  'Add a work order': 'a heading in the guide; the button is "Add work order"',
  'Custom fields and statuses': 'a heading in the guide; the admin section is "Custom fields"',
};

/** Labels with a placeholder: the literal part around it must still be on
    screen, so a rename is caught even though the whole cannot match. */
const TEMPLATES: Record<string, string> = {
  'Hire for <WO#>': 'Hire for ',
  'Create … field': ' field',
  'Add a status to …': 'Add a status to ',
  'Add a sub-category of …': 'Add a sub-category of ',
  'Import N rows': ' rows`',
  'Import N row(s)': ' row(s)`',
  'Still needs …': 'Still needs',
  'Fill before assigning: …': 'Fill before assigning: ',
  'Select all N matching': ' matching',
};

/** Vocabulary the screens draw from packages/shared (the permission tree's
    row labels, the create-form modes, a field key): the label must be in that
    file, as written or as the literal part of the template that builds it.
    The docs registry under shared is NOT a source — it quotes labels, it does
    not draw them. */
const FROM_SHARED: Record<string, { file: string; literal?: string }> = {
  'Admin console': { file: 'packages/shared/src/permissions.ts' },
  'Entity · <Comp>': { file: 'packages/shared/src/permissions.ts', literal: 'Entity · ' },
  'Which dashboards': { file: 'packages/shared/src/permissions.ts' },
  'Which work orders it counts': { file: 'packages/shared/src/permissions.ts' },
  'Not on the form': { file: 'packages/shared/src/woCreate.ts' },
  'On the form': { file: 'packages/shared/src/woCreate.ts' },
  'Parts Required': { file: 'packages/shared/src/statusGates.ts' },
};

describe('every bold label in the guide is in the web source', () => {
  it('collects a realistic number of labels', () => {
    expect(boldLabels.length).toBeGreaterThan(300);
  });

  it('finds each label verbatim under apps/web/src, or knows why not', () => {
    const missing: string[] = [];
    for (const label of boldLabels) {
      if (label in ALLOWLIST) continue;
      const shared = FROM_SHARED[label];
      if (shared) {
        if (!readFileSync(join(APP, shared.file), 'utf8').includes(shared.literal ?? label)) {
          missing.push(`${label} (expected in ${shared.file})`);
        }
        continue;
      }
      if (!webSource.includes(TEMPLATES[label] ?? label)) missing.push(label);
    }
    expect(missing, `labels the screens do not carry:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('keeps the exceptions to text that really is absent from the screens as written', () => {
    // An entry that would pass on its own is dead weight; a list that grows
    // unread stops meaning anything. When this names an entry because a
    // screen now carries the text as written, drop the entry — the plain
    // check above covers it from then on.
    const stale = [...Object.keys(ALLOWLIST), ...Object.keys(TEMPLATES), ...Object.keys(FROM_SHARED)].filter(
      (label) => !boldLabels.includes(label) || webSource.includes(label),
    );
    expect(stale, `entries no longer needed: ${stale.join(', ')}`).toEqual([]);
  });
});

describe('phrases the screens retired are gone from the guide', () => {
  it.each(['Send to Yoda', 'Yoda reference', 'sent to Yoda', '**To process**', 'Send to CMMS'])('never says %s', (phrase) => {
    expect(APP_GUIDE).not.toContain(phrase);
  });
});

describe('sentences the guide quotes are the ones the code says', () => {
  /** Refusals and notices the API answers with: the file must still say it. */
  const FROM_API: [string, string][] = [
    ['services/users.ts', 'Only a super admin can grant or remove super-admin access'],
    ['services/users.ts', "Only a super admin can change a super admin's account"],
    ['plugins/authGuard.ts', 'Viewing as another user is read-only. Stop viewing as them to make changes.'],
    ['services/woBulk.ts', 'Some rows in this file are work orders that are not assigned to you'],
    ['services/woBulk.ts', 'You cannot set work-order status — remove the status column, or clear it on these rows'],
    ['services/woBulk.ts', 'You cannot route work orders to a home list — remove the home list column, or clear it on these rows'],
    ['services/woBulk.ts', 'In trash'],
    ['services/woScope.ts', 'This work order is not assigned to you'],
  ];
  it.each(FROM_API)('%s still says "%s", and so does the guide', (file, sentence) => {
    expect(readFileSync(join(API_SRC, file), 'utf8')).toContain(sentence);
    expect(APP_GUIDE).toContain(sentence);
  });

  /** Sentences read off a screen (locks, warnings, chips): the file as shown must carry it. */
  const FROM_SCREENS: [string, string][] = [
    ['pages/admin/AdminUsersPage.tsx', 'Only a super admin can change this'],
    ['pages/QuoteBuilderPage.tsx', 'On hold — decide the NTE override under Approvals first'],
    ['components/payments/PaymentActions.tsx', 'On hold — the NTE override on this work order has to be decided first'],
    ['pages/RequestPaymentPage.tsx', 'This technician is blacklisted — AP cannot pay them'],
    ['pages/VendorDetailPage.tsx', 'This may already be on file.'],
    ['pages/VendorDetailPage.tsx', 'Still needed:'],
    ['pages/ReceivablesPage.tsx', 'not checked'],
    ['pages/WorkOrdersPage.tsx', 'Yours only'],
    ['components/wo/list/CreateWorkOrderDialog.tsx', 'Possible duplicates'],
  ];
  it.each(FROM_SCREENS)('%s still shows "%s", and the guide quotes it', (file, sentence) => {
    expect(webFile(file)).toContain(sentence);
    expect(APP_GUIDE).toContain(sentence);
  });

  it('names the read-only error code', () => {
    expect(APP_GUIDE).toContain('IMPERSONATION_READ_ONLY');
  });
});

describe('the Payments entry follows PaymentsPage and the payment lifecycle', () => {
  const start = APP_GUIDE.indexOf('### Payments');
  const section = APP_GUIDE.slice(start, APP_GUIDE.indexOf('### ', start + 1));

  it('names every lane PaymentsPage declares, in bold', () => {
    const src = readFileSync(join(WEB_SRC, 'pages', 'PaymentsPage.tsx'), 'utf8');
    const at = src.indexOf('const LANE_LABEL');
    const block = src.slice(at, src.indexOf('};', at));
    const lanes = [...block.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(lanes.length).toBe(4);
    for (const lane of lanes) expect(section, `lane "${lane}"`).toContain(`**${lane}**`);
  });

  it('calls a rejected request Rejected — there is no draft for it to go back to', () => {
    // services/payments.ts: requested | approved → rejected, edited only while
    // requested; the request form's own copy once promised a draft instead.
    const lifecycle = readFileSync(join(API_SRC, 'services', 'payments.ts'), 'utf8');
    expect(lifecycle).toContain("'rejected'");
    expect(lifecycle).not.toContain("'draft'");
    expect(section).toContain('**Rejected**');
    expect(section).not.toMatch(/draft/i);
  });
});

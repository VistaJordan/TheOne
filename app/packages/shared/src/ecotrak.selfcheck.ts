// Self-checks for the rule 2.6.3 / 2.7 table. Run: npx tsx packages/shared/src/ecotrak.selfcheck.ts
import { checkEcotrakTransition, ECOTRAK_PUSH_BY_STATUS_NAME, ECOTRAK_ALLOWED_TRANSITIONS, PHASE_BY_STATUS_NAME } from './index';

let failed = 0;
function is(desc: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed++; console.error(`FAIL ${desc}\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`); }
}
const o = (cur: unknown, name: string) => checkEcotrakTransition(cur, name).outcome;

// Every seeded status has a projection, and only seeded statuses do.
is('projection covers the pipeline', Object.keys(ECOTRAK_PUSH_BY_STATUS_NAME).sort(), Object.keys(PHASE_BY_STATUS_NAME).sort());
// Every target in every allowed list is a status the table knows as a current state or a known wire value.
for (const [from, rule] of Object.entries(ECOTRAK_ALLOWED_TRANSITIONS)) {
  if (rule === 'locked') continue;
  for (const to of rule) is(`${from} → ${to} is a wire value`, /^[A-Z_]+$/.test(to), true);
}

is('no Ecotrak status: nothing to check', o(null, 'On Site (Job)'), 'not_linked');
is('empty string: nothing to check', o('', 'On Site (Job)'), 'not_linked');
is('Accepted → Submitting Proposal', o('ACCEPTED', 'Waiting for Quote'), 'allowed');
is('Accepted → Pending Parts', o('ACCEPTED', 'Waiting for Parts'), 'allowed');
is('Accepted → En route then Arrived', o('ACCEPTED', 'On Site (Job)'), 'allowed');
is('Accepted → assessment on site (same two-step)', o('ACCEPTED', 'On Site (Assessment)'), 'allowed');
is('Accepted → Completed is not listed', o('ACCEPTED', 'Done / Incurred'), 'blocked');
is('Accepted → Return Visit Required is not listed', o('ACCEPTED', 'Return Trip Needed'), 'blocked');
is('Accepted → Assessment Sched pushes nothing', o('ACCEPTED', 'Assessment Sched'), 'no_push');
is('En route → Arrived', o('ENROUTE', 'On Site (Job)'), 'allowed');
is('Arrived → Completed', o('ARRIVED', 'Done / Incurred'), 'allowed');
// ACCEPTED appears in no allowed list (accepting is a one-time act), so going back to Open is deferred, not refused.
is('Arrived → Accepted is deferred', o('ARRIVED', 'Open'), 'unlisted');
is('Pending Parts → En route is not listed (2.7)', o('PENDING_PARTS', 'On Site (Job)'), 'blocked');
is('Pending Parts → Pending Parts is staying put', o('PENDING_PARTS', 'Waiting for Parts'), 'allowed');
is('Return Visit Required → En route then Arrived', o('RETURN_VISIT_REQUIRED', 'On Site (Job)'), 'allowed');
is('Proposal Approved → En route (2.7)', o('PROPOSAL_APPROVED', 'On Site (Job)'), 'allowed');
is('Proposal Approved → Completed is not listed (2.7)', o('PROPOSAL_APPROVED', 'Done / Incurred'), 'blocked');
is('Proposal Rejected → Return Visit Required (2.7)', o('PROPOSAL_REJECTED', 'Return Trip Needed'), 'allowed');
is('Completed is locked', o('COMPLETED', 'On Site (Job)'), 'locked');
is('Cancelled is locked', o('CANCELLED', 'Open'), 'locked');
is('Canceled (US spelling) is locked', o('Canceled', 'Open'), 'locked');
is('Not Fixed is locked (2.7)', o('NOT_FIXED', 'Waiting for Quote'), 'locked');
is('Pending SP Acceptance is locked (2.7)', o('PENDING_SP_ACCEPTANCE', 'Open'), 'locked');
is('locked but nothing pushed: no push', o('COMPLETED', 'Ready to Invoice'), 'no_push');
is('UI label form still reads', o('En route', 'On Site (Job)'), 'allowed');
is('Proposal Submitted as a target is deferred', o('SUBMITTING_PROPOSAL', 'Waiting for Approval'), 'unlisted');
is('Cancelled as a target is deferred', o('ACCEPTED', 'Cancelled / Postponed'), 'unlisted');
is('Cancelled from a locked state is still locked', o('COMPLETED', 'Cancelled / Postponed'), 'locked');
is('Unassigned has no rule yet', o('UNASSIGNED', 'On Site (Job)'), 'unlisted');
is('soft close as current state has no rule yet', o('SOFT_COMPLETED', 'Return Trip Needed'), 'unlisted');
is('unknown status name pushes nothing', o('ACCEPTED', 'Some Admin Status'), 'no_push');
is('verdict carries the failing step', checkEcotrakTransition('PENDING_PARTS', 'On Site (Job)'), { outcome: 'blocked', from: 'PENDING_PARTS', to: 'ENROUTE' });
is('verdict carries the last step when allowed', checkEcotrakTransition('ACCEPTED', 'On Site (Job)'), { outcome: 'allowed', from: 'ACCEPTED', to: 'ARRIVED' });

if (failed) { console.error(`ecotrak: ${failed} self-check(s) failed`); process.exit(1); }
console.log('ecotrak: self-checks passed');

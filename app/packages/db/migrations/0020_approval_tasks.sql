-- ============================================================================
-- 0020 · Approval tasks — the manager's inbox (business rule 1.5.2)
--
--   Rule 1.5.2 (Manager escalation): IF Cost > NTE, THEN auto-generate an
--   NTE_Override_Approval task in the Manager's To-Do list.
--
-- Quotes and payment requests each already have an approval queue of their
-- own. This table is the generic one: something on a work order needs a
-- person with authority to say yes or no, and the decision has to be on the
-- record. The Approvals page (/approvals) is the inbox; the rules engine is
-- the first thing that writes here (automations.ts, action kind
-- 'approval_task'), and the reason for the task rides in `detail` so the
-- row explains itself long after the numbers on the work order have moved.
--
--   open ──approve──▶ approved
--     │──reject───▶ rejected   (note kept on the row AND posted as an
--     │                         internal WO comment, like a payment rejection)
--     └──cancelled            (the reason went away on its own: the cost
--                              dropped back under the NTE)
--
-- Routing is by ROLE, not by person: `assigned_role` is the role code whose
-- inbox the task lands in (null = anyone who may approve), and `assigned_to`
-- is whoever claimed it. A named person changes jobs or goes on leave; a
-- role does not.
--
-- One OPEN task per (work order, type): a cost edited five times in a row
-- refreshes the same task instead of raising five.
--
-- Foreign keys to task and principal cascade — the seed TRUNCATEs both and
-- these rows are data, not configuration (unlike `automation`, which is why
-- source_automation_id is a bare uuid: a rule deleted later leaves its name
-- behind in source_name).
--
-- Permissions (0015 tree):
--   approvals:view      the Approvals page and the tasks on a work order
--   approvals:approve   approve / reject / claim — the quote approvers
-- Roles are never truncated by the seed, so the grants live here only.
-- ============================================================================

CREATE TABLE IF NOT EXISTS approval_task (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type                 text NOT NULL,                       -- 'nte_override' | 'manager_review'
  task_id              uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  title                text NOT NULL,
  detail               jsonb NOT NULL DEFAULT '{}'::jsonb,  -- e.g. {"cost":1200,"nte":1000,"over_by":200}
  assigned_role        text,                                -- role.code; null = any approver
  assigned_to          uuid REFERENCES principal(id) ON DELETE SET NULL,
  status               text NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open', 'approved', 'rejected', 'cancelled')),
  source_automation_id uuid,
  source_name          text,
  created_by           uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  decided_by           uuid REFERENCES principal(id) ON DELETE SET NULL,
  decided_at           timestamptz,
  decision_note        text
);

-- The dedupe rule: one open task per work order and type.
CREATE UNIQUE INDEX IF NOT EXISTS approval_task_one_open
  ON approval_task (task_id, type) WHERE status = 'open';

-- The inbox lists across work orders, open first, newest first.
CREATE INDEX IF NOT EXISTS approval_task_status_idx
  ON approval_task (status, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_task_by_task
  ON approval_task (task_id, created_at DESC);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Everyone can see the inbox (it is the to-do list); deciding mirrors the
-- quote approvers. Only the new path is touched — anything an admin has
-- already tuned on the Roles screen stays.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object(
          'approvals',
          jsonb_build_object('view', true, 'approve', code IN ('admin', 'tl', 'atl', 'am')))
 WHERE code <> 'service'
   AND NOT (permissions ? 'approvals');

-- ── Rule 1.5.2 itself, as an automation ─────────────────────────────────────
-- "When Cost changes to more than NTE, create an NTE override approval task."
-- The trigger compares the new value against ANOTHER field (`to_field`, new
-- with this migration) rather than a constant. The rule is ordinary
-- configuration: Admin › Automations can pause, edit or delete it. If the
-- catalogue has no '34. Cost' field the trigger simply never matches.
INSERT INTO automation (name, enabled, entity, trigger, conditions, actions, position)
SELECT 'Rule 1.5.2 · Manager escalation (cost over NTE)',
       true,
       'work_order',
       '{"kind":"changed","field":"fields.34. Cost","to":null,"to_op":"gt","to_field":"nte","delay_minutes":null}'::jsonb,
       '{"match":"all","rules":[]}'::jsonb,
       '[{"kind":"approval_task","field":"approval_task","value":"nte_override","assign_role":null}]'::jsonb,
       COALESCE((SELECT MAX(position) + 1 FROM automation), 0)
 WHERE NOT EXISTS (
         SELECT 1 FROM automation
          WHERE name = 'Rule 1.5.2 · Manager escalation (cost over NTE)');

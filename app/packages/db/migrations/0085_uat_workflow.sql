-- 0085 · UAT round 1, Wave C — workflow (docs/specs/uat-round-1.md).
--
-- The pure vocabulary these lists come from is packages/shared/src/workflow.ts
-- (and statusGates.ts for the gates); tests/uat-wave-c.test.ts fails when the
-- two drift.
--
--   task.cancelled_from_status_id   M31: the status a cancel moved the work
--                                   order out of, so Reopen puts it back.
--                                   A plain uuid (no FK): a status removed
--                                   later makes Reopen say so, it never
--                                   blocks the status delete.
--   quote.client_decision_attachment_id
--                                   M6: the file that records the client's
--                                   approval (a note or a file is required).
--                                   Plain uuid: the attachment row may go,
--                                   the decision stays.
--   #16 request mode                The four dispatchers (D3: ops_coord,
--                                   om_probation, om, senior_om) request
--                                   status changes — set outright, not only
--                                   where unset as 0031 did, so a database
--                                   where a click gave one of them direct
--                                   status moves is put back.
--   #15 work_orders/lifecycle       New path: the record bar's Cancel /
--                                   Reopen, Pause / Resume and Complete
--                                   service. Off for every request-mode
--                                   system role (the dispatchers plus
--                                   vr_officer and oa, 0084); unset for the
--                                   rest, so it follows work_orders edit.
--   #15 fields                      NTE (the header column and Client NTE),
--                                   the SLA dates (Due Date, SLA Due Date,
--                                   SLA Requested, SLA Updated) and the AR
--                                   section are view-only for the
--                                   dispatchers and the VR officer. The Cost
--                                   is already hidden from them (0084, M13).
--                                   oa keeps them: intake and Add work order
--                                   are where they are typed.
--
-- Roles are not truncated by the seed, so the grants need no twin in seed.ts;
-- the two columns are schema, which the seed never drops.

ALTER TABLE task ADD COLUMN IF NOT EXISTS cancelled_from_status_id uuid;

ALTER TABLE quote ADD COLUMN IF NOT EXISTS client_decision_attachment_id uuid;

-- Work orders cancelled before this file: the status the cancel moved them out
-- of, read from the newest status_changed row into a Cancel… status.
UPDATE task t
   SET cancelled_from_status_id = sub.from_id
  FROM (
    SELECT DISTINCT ON (a.entity_id)
           a.entity_id,
           (a.before ->> 'status_id')::uuid AS from_id
      FROM activity_log a
     WHERE a.entity_type = 'task'
       AND a.action = 'status_changed'
       AND (a.after ->> 'status_name') ~* '^cancel'
       AND (a.before ->> 'status_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ORDER BY a.entity_id, a.created_at DESC, a.id DESC
  ) sub
 WHERE t.id::text = sub.entity_id
   AND t.cancelled_at IS NOT NULL
   AND t.cancelled_from_status_id IS NULL;

-- ── A helper for the grants below (this session only) ───────────────────────
-- Merges `p_grant` into the one path's existing grant, so an action this file
-- does not name keeps what it was.

CREATE FUNCTION pg_temp.wc_grant(p_code text, p_path text, p_grant jsonb) RETURNS void AS $$
  UPDATE role
     SET permissions = COALESCE(permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(permissions -> p_path, '{}'::jsonb) || p_grant)
   WHERE code = p_code;
$$ LANGUAGE sql;

-- ── #16 · the dispatchers request status changes ────────────────────────────

SELECT pg_temp.wc_grant(c, 'work_orders/status', '{"edit": false, "create": true}')
  FROM unnest(ARRAY['ops_coord', 'om_probation', 'om', 'senior_om']) AS c;

-- ── #15 · no side doors ──────────────────────────────────────────────────────

SELECT pg_temp.wc_grant(c, 'work_orders/lifecycle', '{"edit": false}')
  FROM unnest(ARRAY['ops_coord', 'om_probation', 'om', 'senior_om', 'vr_officer', 'oa']) AS c;

SELECT pg_temp.wc_grant(r.c, f.path, '{"edit": false}')
  FROM unnest(ARRAY['ops_coord', 'om_probation', 'om', 'senior_om', 'vr_officer']) AS r(c)
 CROSS JOIN unnest(ARRAY[
   'work_orders/fields/header/nte',
   'work_orders/fields/finances/fields.16. Client NTE 🔴',
   'work_orders/fields/dates/fields.Due Date',
   'work_orders/fields/dates/fields.SLA Due Date',
   'work_orders/fields/dates/fields.🚨 SLA Requested',
   'work_orders/fields/dates/fields.🚨 SLA Updated',
   'work_orders/fields/ar'
 ]) AS f(path);

-- The AR section's own fields: a child grant someone set by hand would
-- otherwise win over the section (unset inherits; set does not).
SELECT pg_temp.wc_grant(r.c, 'work_orders/fields/ar/' || k.key, '{"edit": false}')
  FROM unnest(ARRAY['ops_coord', 'om_probation', 'om', 'senior_om', 'vr_officer']) AS r(c)
 CROSS JOIN unnest(ARRAY[
   'fields.12. Bad quote', 'fields.Admin Comment', 'fields.Grey Flag Date', 'fields.Quote Check',
   'fields.Audited', 'fields.GTG', 'fields.Bill For Incurred'
 ]) AS k(key)
 WHERE EXISTS (SELECT 1 FROM role WHERE code = r.c AND permissions ? ('work_orders/fields/ar/' || k.key));

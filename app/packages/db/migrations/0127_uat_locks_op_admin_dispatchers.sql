-- 0127 · who may edit what, UAT list of 2026-11-09 (Elise).
--
-- OP Admin (oa): view-only on the AR, QC, Payments and Invoicing sections of
-- All fields and on Not fully paid (the rest of Finances stays), and no longer
-- creates or changes payment requests: dispatchers request payments. 0085 had
-- left oa out of the AR lock on purpose; this replaces that.
--
-- OM, Senior OM, OM Under Probation: view-only on QC, Invoicing and
-- Integrations (Client Portal Type, Portal ID). The Add work order form still
-- fills Client Portal Type for them (CREATE_FILLABLE_FIELD_KEYS).
--
-- Only `edit` changes, so a field a role could not see stays hidden. The
-- lists are OP_ADMIN_LOCKED_* and DISPATCHER_LOCKED_FIELD_SECTIONS_0127 in
-- shared workflow.ts. role is not truncated by the seed: no seed twin.
-- Loosen any of it in Admin › Roles or per person with Adjust.

CREATE FUNCTION pg_temp.p127_lock(p_code text, p_path text) RETURNS void AS $$
  -- The section, then any child grant someone set by hand: a set child wins
  -- over its section (unset inherits; set does not).
  UPDATE role r
     SET permissions = COALESCE(r.permissions, '{}'::jsonb)
                       || jsonb_build_object(p_path, COALESCE(r.permissions -> p_path, '{}'::jsonb) || '{"edit": false}'::jsonb)
                       || COALESCE((SELECT jsonb_object_agg(e.key, e.value || '{"edit": false}'::jsonb)
                                      FROM jsonb_each(COALESCE(r.permissions, '{}'::jsonb)) e
                                     WHERE starts_with(e.key, p_path || '/')), '{}'::jsonb)
   WHERE r.code = p_code;
$$ LANGUAGE sql;

SELECT pg_temp.p127_lock('oa', 'work_orders/fields/' || s)
  FROM unnest(ARRAY['ar', 'qc', 'payments', 'invoicing']) AS s;

SELECT pg_temp.p127_lock('oa', 'work_orders/fields/finances/fields.1. Not Fully Paid');

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object('payments', COALESCE(permissions -> 'payments', '{}'::jsonb)
                                                       || '{"create": false, "edit": false, "delete": false, "approve": false}'::jsonb)
 WHERE code = 'oa';

SELECT pg_temp.p127_lock(r.c, 'work_orders/fields/' || s.s)
  FROM unnest(ARRAY['om_probation', 'om', 'senior_om']) AS r(c)
 CROSS JOIN unnest(ARRAY['qc', 'invoicing', 'integrations']) AS s(s);

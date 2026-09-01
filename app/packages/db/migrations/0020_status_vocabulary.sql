-- 0020 — converge existing databases on the S8 operational vocabulary.
--
-- The Primary-Updates line renamed the pipeline statuses in the SEED (clean
-- title-case names, no '!!' / '<< >>' wrappers); the phase-0 line kept the
-- legacy production names because the Ecotrak ingestion and the obligations
-- engine referenced them. The merge adopted the new vocabulary in code and
-- seed, so a database created before the rename must follow. A fresh database
-- seeds the new names directly and every UPDATE below matches nothing.
--
-- 'Emergency' and 'Approved' survive the rename (the renamed seed had dropped
-- them, but production Ecotrak traffic lands on both: PROPOSAL_APPROVED and
-- the emergency_ack rule).
--
-- History (activity_log payloads, cmms_event_raw) keeps the names it was
-- written with — those are records of what was said at the time, not lookups.

UPDATE status SET name = 'Emergency'             WHERE name = 'emergency';
UPDATE status SET name = 'Assessment Sched'      WHERE name = 'assessment scheduled';
UPDATE status SET name = 'Job Sched'             WHERE name = 'job scheduled';
UPDATE status SET name = 'PM Sched'              WHERE name = 'pm scheduled';
UPDATE status SET name = 'On Site (Assessment)'  WHERE name = 'assessment ongoing';
UPDATE status SET name = 'On Site (Job)'         WHERE name = 'job ongoing';
UPDATE status SET name = 'Return Trip Needed'    WHERE name = 'return trip needed';
UPDATE status SET name = 'Waiting for Quote'     WHERE name = 'waiting for quote';
UPDATE status SET name = 'Quote Ready'           WHERE name = 'quote ready';
UPDATE status SET name = 'Waiting for Parts'     WHERE name = 'waiting for parts';
UPDATE status SET name = 'Please Order Parts'    WHERE name = 'please order parts';
UPDATE status SET name = 'Waiting for Advice'    WHERE name = '!! waiting for advice';
UPDATE status SET name = 'Waiting for Approval'  WHERE name = '!! waiting for approval';
UPDATE status SET name = 'Approved'              WHERE name = 'approved';
UPDATE status SET name = 'Ready to Invoice'      WHERE name = '!! ready to invoice';
UPDATE status SET name = 'Done / Incurred'       WHERE name = 'done/incurred';
UPDATE status SET name = 'Invoiced Not Paid'     WHERE name = '<< invoiced not paid >>';
UPDATE status SET name = 'Invoiced'              WHERE name = 'invoiced';
UPDATE status SET name = 'Cancelled / Postponed' WHERE name = '!! canceled/postponed';

-- Obligation rules carry status names in params.statuses (jsonb). Map every
-- legacy element to its new name, whatever the rule — customised rules
-- included — and leave unknown values untouched.
UPDATE obligation_rule r
   SET params = jsonb_set(r.params, '{statuses}', sub.mapped)
  FROM (
    SELECT r2.rule_key,
           -- DISTINCT: 'approved' and '!! approved' both map to 'Approved'.
           jsonb_agg(DISTINCT
             CASE elem
               WHEN 'emergency'                THEN 'Emergency'
               WHEN 'assessment scheduled'     THEN 'Assessment Sched'
               WHEN 'job scheduled'            THEN 'Job Sched'
               WHEN 'pm scheduled'             THEN 'PM Sched'
               WHEN 'assessment ongoing'       THEN 'On Site (Assessment)'
               WHEN 'job ongoing'              THEN 'On Site (Job)'
               WHEN 'return trip needed'       THEN 'Return Trip Needed'
               WHEN 'waiting for quote'        THEN 'Waiting for Quote'
               WHEN 'quote ready'              THEN 'Quote Ready'
               WHEN 'waiting for parts'        THEN 'Waiting for Parts'
               WHEN 'please order parts'       THEN 'Please Order Parts'
               WHEN '!! waiting for advice'    THEN 'Waiting for Advice'
               WHEN '!! waiting for approval'  THEN 'Waiting for Approval'
               WHEN 'approved'                 THEN 'Approved'
               WHEN '!! approved'              THEN 'Approved'
               WHEN '!! ready to invoice'      THEN 'Ready to Invoice'
               WHEN 'done/incurred'            THEN 'Done / Incurred'
               WHEN '<< invoiced not paid >>'  THEN 'Invoiced Not Paid'
               WHEN 'invoiced'                 THEN 'Invoiced'
               WHEN '!! canceled/postponed'    THEN 'Cancelled / Postponed'
               ELSE elem
             END) AS mapped
      FROM obligation_rule r2,
           jsonb_array_elements_text(r2.params->'statuses') AS elem
     WHERE r2.params ? 'statuses'
     GROUP BY r2.rule_key
  ) sub
 WHERE sub.rule_key = r.rule_key;

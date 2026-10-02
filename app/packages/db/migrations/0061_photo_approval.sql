-- 0061 · Rules 1.3.1–1.3.4 (photo approval) and 11.3.4 (proof before Done).
--
-- Until now a file was as visible as its work order the moment it was
-- uploaded (0043). The rules want a quarantine: an upload lands Pending and
-- hidden, a dispatcher approves or declines each one, and only an approved
-- file shows to everybody else. Approving is also where the file is told
-- apart — before photo, after photo, sign-off — because rule 11.3.4 reads
-- that tag: Done / Incurred needs an approved after photo, or, when the job
-- is Bill For Incurred, an approved before photo and an approved sign-off.
--
--   review_status  pending | approved | declined
--   kind           before | after | signoff | other   (NULL = nobody has said)
--   reviewed_by / reviewed_at   who decided, and when
--
-- Files that are already here have been visible all along, so they stay
-- visible: the column is added with DEFAULT 'approved' (which stamps every
-- existing row) and only then does the default become 'pending' for new
-- uploads. Their kind follows the reading the Photos card has used since
-- 0043 — an internal photo is the "before", a client-visible one the "after".

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS review_status text NOT NULL DEFAULT 'approved'
    CHECK (review_status IN ('pending', 'approved', 'declined'));

ALTER TABLE attachment ALTER COLUMN review_status SET DEFAULT 'pending';

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS kind text
    CHECK (kind IN ('before', 'after', 'signoff', 'other'));

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES principal(id) ON DELETE SET NULL;

ALTER TABLE attachment
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

UPDATE attachment
   SET kind = CASE
                WHEN content_type LIKE 'image/%' AND client_visible THEN 'after'
                WHEN content_type LIKE 'image/%' THEN 'before'
                ELSE 'other'
              END
 WHERE kind IS NULL
   AND review_status = 'approved';

CREATE INDEX IF NOT EXISTS attachment_review_idx ON attachment(task_id, review_status);

-- ── Rule 11.3.4's BFI_Checkbox ───────────────────────────────────────────────
-- field_def rows are seed-owned (0011's data note): seed.ts declares the same
-- row in CURATED_FIELDS; this INSERT is for an already-seeded database.
-- KEEP THE FIELD IN STEP.
INSERT INTO field_def (container_id, key, label, type, type_config, position)
SELECT c.id,
       'Bill For Incurred',
       'Bill For Incurred',
       'checkbox',
       '{}'::jsonb,
       (SELECT COALESCE(max(position), 0) + 1 FROM field_def WHERE container_id = c.id)
  FROM container c
 WHERE c.kind = 'space'
ON CONFLICT (container_id, key) DO NOTHING;

-- ── Who reviews (rule 1.3.3: the dispatcher) ─────────────────────────────────
-- `work_orders/attachments` gains an `approve` action. The managers, the OP
-- Admin and the two full dispatcher tiers get it; the probation tiers do not
-- (their uploads wait for someone else). Only where nobody has set it, so a
-- choice made on the Roles screen survives. `role` is never truncated by the
-- seed, so this grant lives here only.
UPDATE role
   SET permissions = jsonb_set(
         permissions,
         '{work_orders/attachments}',
         COALESCE(permissions -> 'work_orders/attachments', '{}'::jsonb) || '{"approve": true}'::jsonb,
         true)
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'oa', 'senior_om', 'om')
   AND NOT (COALESCE(permissions -> 'work_orders/attachments', '{}'::jsonb) ? 'approve');

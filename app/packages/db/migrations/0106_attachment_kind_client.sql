-- 0106 · Elise, 2026-10-28. A fourth kind of file on the Drive tab: "From
-- client" — the pictures and files the client shares with us. A reviewer
-- picks it in "What is it?" like the other kinds (rule 1.3.3), and the Drive
-- tab draws it as a fourth column beside Before · After · Sign-off. It is
-- not proof of work: the Job is Done gate (11.3.4) still reads only after /
-- before / sign-off.
--
-- 0061 declared the CHECK inline, so its name is Postgres's choice; it is
-- found by its definition and replaced by a named one.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'attachment'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%kind%'
       AND pg_get_constraintdef(oid) NOT LIKE '%review_status%'
  LOOP
    EXECUTE format('ALTER TABLE attachment DROP CONSTRAINT %I', c.conname);
  END LOOP;
END
$$;

ALTER TABLE attachment
  ADD CONSTRAINT attachment_kind_check
    CHECK (kind IN ('before', 'after', 'signoff', 'client', 'other'));

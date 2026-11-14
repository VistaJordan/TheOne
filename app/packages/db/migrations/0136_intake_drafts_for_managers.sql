-- 0136 · Elise, 2026-11-14.
--
-- Drafts for everyone who opens Add work order. Rule 14.1.2 (0040) kept WO
-- Intake to OP Admin and Admin, when a draft was only the OP Admin's staging
-- area. Since 2026-10-27 the Add work order form files drafts too (Save as
-- draft, the ✕, and since 2026-11-14 a refresh or Back by mistake), and TL,
-- ATL and AM open that form from Incoming Work Orders — without `intake`
-- create their mistaken exits were lost. They now hold `intake` view, create
-- and edit: they save drafts and open the Drafts tab to finish them.
--
-- The three actions are merged over whatever the role holds for `intake`
-- (another action set on the Roles screen stays). role is not truncated by
-- the seed, so this lives here only.

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
     || jsonb_build_object(
          'intake',
          COALESCE(permissions -> 'intake', '{}'::jsonb)
            || jsonb_build_object('view', true, 'create', true, 'edit', true))
 WHERE code IN ('tl', 'atl', 'am');

-- 0142 · Elise, 2026-11-15 · who reads the client conversation and who
-- writes to it.
--
-- `work_orders/comments/client` ("Message the client" in Admin › Roles) gains
-- a `view` action: without it the Messages tab has no Client visible tab, the
-- API sends none of those messages (thread, Overview feed, the "Last client
-- message" columns) and nobody is notified or @mentioned about one. Posting
-- to the client needs view AND create.
--
--   OM Under Probation, OM    view false, create false
--   Senior OM                 view true,  create false   (0134 had create)
--   TL, ATL, Admin, OP Admin  view true,  create true
--
-- Every other role is left as it was (unset inherits Messages, then Work
-- orders view; create as before). Per-person overrides (Adjust) are left
-- alone. Super admins always see and send. `role` is not truncated by the
-- seed, so this lives here only.

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object(
                          'work_orders/comments/client',
                          COALESCE(permissions -> 'work_orders/comments/client', '{}'::jsonb)
                            || '{"view": false, "create": false}'::jsonb)
 WHERE code IN ('om_probation', 'om');

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object(
                          'work_orders/comments/client',
                          COALESCE(permissions -> 'work_orders/comments/client', '{}'::jsonb)
                            || '{"view": true, "create": false}'::jsonb)
 WHERE code = 'senior_om';

UPDATE role
   SET permissions = COALESCE(permissions, '{}'::jsonb)
                     || jsonb_build_object(
                          'work_orders/comments/client',
                          COALESCE(permissions -> 'work_orders/comments/client', '{}'::jsonb)
                            || '{"view": true, "create": true}'::jsonb)
 WHERE code IN ('tl', 'atl', 'admin', 'oa');

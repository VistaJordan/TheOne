-- 0118 · The app is called OBI now (Elise, 2026-11-03).
--
-- The shipped dashboards are inserted once by ensureSystemDashboards and never
-- rewritten (an edited board stays edited), so the payments board's "How to
-- read this board" card still says "The One" on databases that already hold
-- it. This renames the app in the narrative cards of the shipped boards only
-- (system_key set); a card someone wrote on their own board is left alone.
-- Nothing in seed.ts: the seed does not insert dashboards.

UPDATE dashboard_widget w
   SET config = jsonb_set(w.config, '{text}', to_jsonb(replace(w.config->>'text', 'The One', 'OBI')))
  FROM dashboard d
 WHERE d.id = w.dashboard_id
   AND d.system_key IS NOT NULL
   AND w.kind = 'narrative'
   AND w.config->>'text' LIKE '%The One%';

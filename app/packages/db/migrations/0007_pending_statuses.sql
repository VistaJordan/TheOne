-- 0007 — move the "blocked on someone else" statuses into the pending group.
--
-- The split this draws: ACTIVE means the work is ours to move. PENDING means we
-- are waiting on a party outside dispatch and no amount of dispatcher effort
-- advances it. Before this, `active` held 15 of the 20 statuses and could not
-- distinguish "a tech is on site" from "the client has sat on a quote for six
-- weeks" — which is exactly the 46-WO problem in the PRD.
--
--   !! waiting for approval  -> the client owes a decision
--   !! waiting for advice    -> the client / AM owes direction
--   waiting for parts        -> a supplier owes delivery
--
-- Deliberately NOT moved, because the next action is OURS:
--   waiting for quote  (a dispatcher owes the quote — BR-OBL-008)
--   quote ready        (internal ATL review gate)
--   please order parts (someone here has to place the order)

UPDATE status SET status_group = 'pending'
 WHERE name IN ('!! waiting for approval', '!! waiting for advice', 'waiting for parts');

-- task.status_group is denormalised from status for fast filtering, so it has
-- to follow or the list view and the detail page disagree.
UPDATE task t SET status_group = s.status_group
  FROM status s
 WHERE s.id = t.status_id AND t.status_group IS DISTINCT FROM s.status_group;

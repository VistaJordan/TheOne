-- 0007 · Field engine groundwork.
--
-- Three independent pieces, one sprint:
--   1. a 'phone' member on field_type — the curated catalogue (seed §4) declares
--      "Tech Phone Number" as a phone field and the enum predates the idea.
--   2. two new role capabilities: editing work-order field values inline, and
--      viewing a field's change history. Granted here to the operating roles the
--      same way 0005 granted the quote gates; the Roles screen can retune them.
--   3. user_pref — the first per-ACCOUNT preference store. The saved-view system
--      deliberately keeps working state in localStorage ("a property of the tab");
--      the detail page's field ORDER is the opposite: "my order, on every
--      machine", so it lives server-side, one JSONB value per (user, key).
--
-- Data note (CLAUDE.md "keep in step"): the role UPDATEs below touch rows that
-- migrations own and the seed never truncates, so they live here ONLY. The
-- field_def rows themselves are seed-owned (truncated + rebuilt) and carry no
-- statements here.

ALTER TYPE field_type ADD VALUE IF NOT EXISTS 'phone';

ALTER TABLE role ADD COLUMN IF NOT EXISTS can_edit_wo_fields     boolean NOT NULL DEFAULT false;
ALTER TABLE role ADD COLUMN IF NOT EXISTS can_view_field_history boolean NOT NULL DEFAULT false;

-- Field editing is the dispatcher's day job — every operating role gets it.
-- Finance (ar/ap) and guests read; the Roles screen can widen this later.
UPDATE role SET can_edit_wo_fields = true
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'senior_om', 'om', 'ops_coord', 'oa');

-- History is the supervisory view — leads and up.
UPDATE role SET can_view_field_history = true
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'senior_om');

CREATE TABLE IF NOT EXISTS user_pref (
  principal_id uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  key          text NOT NULL,
  value        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, key)
);

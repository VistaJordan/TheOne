-- 0014 · Automations: which record type a rule runs over.
--
-- The builder's "Applies to" step (work orders · vendors · quotes · invoices).
-- Only 'work_order' is accepted today — the service rejects the other three
-- until their modules go live — but the column ships now so existing rules
-- keep meaning the same thing when a second entity arrives.

ALTER TABLE automation
  ADD COLUMN IF NOT EXISTS entity text NOT NULL DEFAULT 'work_order';

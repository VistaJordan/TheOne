-- ============================================================================
-- 0016 · Payment requests get an approval flow and a Yoda hand-off
--
-- Until now a payment_request only ever sat at 'requested': the routes could
-- create and list, nothing could move one. The Payments tab (2026-09-07) adds
-- the decisions, so the row now records who made each one and when:
--
--   requested ──approve──▶ approved ──send──▶ sent_to_yoda ──paid──▶ paid
--       │                     │
--       └───────reject────────┘──▶ rejected (note kept on the row AND posted
--                                             as an internal WO comment)
--
-- Yoda is the payment tool the money actually leaves from; "sent to Yoda" is
-- the hand-off, `yoda_ref` whatever reference Yoda gives back. Marking paid
-- is the confirmation that Yoda paid it.
--
-- Permissions (0015 tree):
--   payments:approve        approve / reject   — the quote approvers (atl, tl, am, admin)
--   payments/process:edit   send to Yoda / mark paid — AP and admin
-- Roles are never truncated by the seed, so the grants below live here ONLY
-- (CLAUDE.md "keep in step" does not apply to `role`).
-- ============================================================================

ALTER TABLE payment_request DROP CONSTRAINT IF EXISTS payment_request_status_check;
ALTER TABLE payment_request
  ADD CONSTRAINT payment_request_status_check
  CHECK (status IN ('requested', 'approved', 'sent_to_yoda', 'paid', 'rejected'));

ALTER TABLE payment_request
  ADD COLUMN IF NOT EXISTS approved_by      uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS approved_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by      uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS rejected_at      timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_note   text,
  ADD COLUMN IF NOT EXISTS sent_to_yoda_by  uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS sent_to_yoda_at  timestamptz,
  ADD COLUMN IF NOT EXISTS yoda_ref         text,
  ADD COLUMN IF NOT EXISTS paid_by          uuid REFERENCES principal(id),
  ADD COLUMN IF NOT EXISTS paid_at          timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at       timestamptz NOT NULL DEFAULT now();

-- The Payments tab lists across work orders, filtered by status.
CREATE INDEX IF NOT EXISTS payment_request_status_idx ON payment_request (status, created_at DESC);

-- ── Grants ──────────────────────────────────────────────────────────────────
-- Approve mirrors the quote approvers; process is AP's job (admin can too).
-- Only roles with an explicit `payments` entry are touched, and only the two
-- new actions — anything an admin has already retuned on the Roles screen stays.
UPDATE role
   SET permissions = jsonb_set(
         permissions,
         '{payments}',
         COALESCE(permissions -> 'payments', '{}'::jsonb)
           || jsonb_build_object('approve', code IN ('admin', 'tl', 'atl', 'am')),
         true)
 WHERE code <> 'service';

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('payments/process', jsonb_build_object('edit', code IN ('admin', 'ap')))
 WHERE code <> 'service';

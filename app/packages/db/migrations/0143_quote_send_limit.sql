-- 0143 · How much a person may send to a client on their own (Elise, 2026-11-16).
--
-- An ATL sends quotes up to $5,000 by default (QUOTE_SEND_LIMIT_DEFAULT_BY_ROLE
-- in packages/shared/src/quoteSendLimit.ts); above it they submit the quote for
-- approval and a Team Lead sends it. This column is the per-person figure set in
-- Admin › Users: NULL = the role's default (no default = no limit), a figure =
-- this person's own limit. Read by services/quotes.ts on Approve and Send.
-- The seed re-creates principals with the column NULL, which is the default.

ALTER TABLE principal
  ADD COLUMN IF NOT EXISTS quote_send_limit numeric(12,2)
    CHECK (quote_send_limit IS NULL OR quote_send_limit >= 0);

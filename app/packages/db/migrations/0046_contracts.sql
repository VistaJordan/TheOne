-- 0046 · Contracts and labor rates (Facilio parity, batch 5).
--
-- A contract is what a client and an entity have agreed the work costs: the
-- hourly rate, the overtime rate, the trip charge, the markup on parts, for a
-- span of dates, over a client (and optionally one billing entity, some sites
-- and some trades). Two things read it:
--
--   the quote builder   — overtime has been a hard-coded ×1.5 since 0003
--                          (services/quotes.ts, lib/quoteTotals.ts). A quote
--                          raised on a work order the contract covers now takes
--                          its multiplier from overtime ÷ standard, and its
--                          default line rates from the contract.
--   the invoice         — a work order with no quote on it used to bill as a
--                          single "Work order WO-…" line for the NTE. Under a
--                          time-and-materials contract it now bills the hours
--                          on site (wo_visit check-in → check-out) at the
--                          contract rate, plus the trip charge.
--
-- Matching is by client name (task.client) and, when set, billing entity —
-- the client is still plain text on the task (portfolio batch 2 promotes it).
-- Sites and trades are covered lists, empty = all. The most specific active
-- contract wins: entity + client over client alone, a named trade over any.

CREATE TABLE IF NOT EXISTS contract (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  -- task.client to match. NULL = every client (a house rate card).
  client          text,
  -- task.billing_entity to match. NULL = every entity.
  billing_entity  text,
  -- 'tm' = time and materials (rates apply per hour on site);
  -- 'scheduled_pm' = a planned-maintenance contract (a flat visit price).
  kind            text NOT NULL DEFAULT 'tm' CHECK (kind IN ('tm', 'scheduled_pm')),
  account_code    text,
  starts_on       date NOT NULL DEFAULT CURRENT_DATE,
  ends_on         date,
  active          boolean NOT NULL DEFAULT true,
  -- Store numbers or site names this contract is limited to; empty = all.
  sites_covered   text[] NOT NULL DEFAULT '{}',
  -- Trades this contract is limited to; empty = all.
  trades_covered  text[] NOT NULL DEFAULT '{}',
  notes           text,
  created_by      uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_client_idx ON contract(client);
CREATE INDEX IF NOT EXISTS contract_active_idx ON contract(active, starts_on, ends_on);

-- One row per rate the contract states. `trade` narrows a rate to one trade
-- (an HVAC hour costs more than a handyman hour); NULL applies to every trade
-- the contract covers and is the fallback when no trade-specific row matches.
CREATE TABLE IF NOT EXISTS contract_rate (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id  uuid NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  -- 'standard' | 'overtime' | 'double_time' — per hour;
  -- 'trip_charge' — per visit; 'markup_pct' — a percentage on parts.
  rate_type    text NOT NULL
                 CHECK (rate_type IN ('standard', 'overtime', 'double_time', 'trip_charge', 'markup_pct')),
  trade        text,
  amount       numeric(12,2) NOT NULL DEFAULT 0,
  position     int NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS contract_rate_contract_idx ON contract_rate(contract_id, position);

CREATE TRIGGER contract_touch BEFORE UPDATE ON contract
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER contract_rate_touch BEFORE UPDATE ON contract_rate
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who may see and keep the rate cards. AR and the account managers own the
-- commercial terms; team leads can read them so a quote's rate is explicable.
-- Only where the path is not already set, so a Roles-screen decision survives.
UPDATE role
   SET permissions = permissions
     || jsonb_build_object('contracts', jsonb_build_object(
          'view', true, 'create', true, 'edit', true, 'delete', true))
 WHERE code IN ('admin', 'ar', 'am')
   AND NOT (permissions ? 'contracts');

UPDATE role
   SET permissions = permissions
     || jsonb_build_object('contracts', jsonb_build_object('view', true))
 WHERE code IN ('tl', 'atl', 'ap')
   AND NOT (permissions ? 'contracts');

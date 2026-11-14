-- 0138 · AI usage, models and limits (Elise, 2026-11-14).
--
-- Dashboard › AI usage (super admins) picks, per AI feature (the assistant, the AI quote draft,
-- Improve on a message), the Claude model it runs on, how many times one
-- person may use it a day and how much the team may spend on it in a month;
-- and it shows what each feature and each person cost.
--
-- No FK to principal or task on either table: the seed TRUNCATEs both
-- … CASCADE, and the settings and the spend record must survive a re-seed
-- (the 0060 / 0096 reasoning). The seed truncates neither table.

CREATE TABLE IF NOT EXISTS ai_setting (
  feature            text PRIMARY KEY
                     CHECK (feature IN ('assistant', 'quote_draft', 'message_improve')),
  model              text NOT NULL,
  daily_limit        integer CHECK (daily_limit IS NULL OR daily_limit BETWEEN 0 AND 10000),
  monthly_budget_usd numeric(10, 2) CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd BETWEEN 0 AND 100000),
  updated_by         uuid,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per use of an AI feature: who, which model, the tokens and what
-- they cost at the price on file when it ran. A refused use (limit, budget,
-- switched off) writes nothing; a call Claude failed is kept with status
-- 'error' so a run of failures shows up.
CREATE TABLE IF NOT EXISTS ai_usage (
  id                 bigserial PRIMARY KEY,
  feature            text NOT NULL,
  principal_id       uuid NOT NULL,
  model              text,
  status             text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error')),
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd           numeric(12, 6) NOT NULL DEFAULT 0,
  task_id            uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_feature_at ON ai_usage (feature, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_principal_at ON ai_usage (principal_id, created_at);

-- The page is the Dashboard's AI usage tab and answers super admins only:
-- no permission path, so no role grant.

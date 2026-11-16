-- 0145 · Quote templates (Elise, 2026-11-16).
--
-- A saved set of quote content — the Incurred section and the options, each
-- with its scope lines and line items, plus the specs and the note to the
-- customer — to start a quote from later. The content is the quote builder's
-- own save shape (QuoteDraftBody in packages/shared/src/calls.ts, the shape
-- the AI quote draft already stores), so the builder loads it with the same
-- converter. Nothing about one job is kept: no work order, client or number.
--
-- Who sees one: a template is private to whoever saved it until a quote
-- approver (`quotes` approve) shares it with everyone. Read and written by
-- services/quoteTemplates.ts.
--
-- No FK to principal (`created_by` is a plain uuid): the seed truncates
-- principal and the templates are configuration that must survive a re-seed,
-- as wo_create_template (0063) does. The seed does not truncate this table.

CREATE TABLE quote_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description text,
  trade       text,
  content     jsonb NOT NULL,
  shared      boolean NOT NULL DEFAULT false,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quote_template_owner_idx ON quote_template (created_by);
CREATE INDEX quote_template_shared_idx ON quote_template (shared) WHERE shared;
CREATE TRIGGER quote_template_touch BEFORE UPDATE ON quote_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

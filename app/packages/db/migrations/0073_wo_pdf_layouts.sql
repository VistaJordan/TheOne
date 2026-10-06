-- 0073 · Save a work order as a PDF.
--
-- Two documents can be drawn from one work order, in the billing entity's
-- branding (the sign-off sheets' header / footer art, lib/signoffPdf.ts):
--
--   full      the work order as the team sees it — the main fields;
--   request   what the client sent — who they are, where the site is, what
--             they asked for.
--
-- Which fields each one prints, in what order, is this table: one row per
-- kind, edited in Admin › Settings › Work-order PDFs (admin/settings edit).
-- `items` is an ordered list of catalogue keys — the promoted columns by
-- name (wo_number, client, nte, …) and the bag by `fields.<json key>`. A
-- field the viewer may not see is never printed whatever the list says: the
-- renderer applies the same redaction as the work-order payload.
--
-- Configuration with no FK, so the seed leaves it alone (the 0012 reasoning).
-- The lists below are also WO_PDF_DEFAULTS in packages/shared/src/woPdf.ts
-- (the API's fallback should a row go missing) — change both together.

CREATE TABLE wo_pdf_layout (
  kind       text PRIMARY KEY CHECK (kind IN ('full', 'request')),
  -- The heading on the document.
  title      text NOT NULL,
  items      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Leave a field off the page when the work order has no value for it.
  hide_empty boolean NOT NULL DEFAULT false,
  -- Printed under the fields: a disclaimer, a contact line, instructions.
  note       text,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wo_pdf_layout (kind, title, items, hide_empty) VALUES
  ('full', 'Work order', '[
    "wo_number", "ext_name", "status", "priority", "client", "billing_entity", "trade", "date_received",
    "fields.SLA Due Date", "fields.Due Date", "fields.Scheduled Date",
    "fields.Store", "fields.17. Address", "fields.City", "fields.State", "fields.Zip Code", "fields.22. FM",
    "fields.Assignee", "fields.TL", "fields.AM", "fields.Tech Name", "fields.Tech Phone Number",
    "nte", "fields.16. Client NTE 🔴", "fields.Client Quote", "fields.34. Cost", "fields.Total Invoiced",
    "fields.Checked-in At", "fields.Checked-out At",
    "fields.35. WO Description", "fields.Parts Required", "fields.20. Last Update"
  ]'::jsonb, false),
  ('request', 'Service request', '[
    "client", "ext_name", "wo_number", "date_received",
    "fields.Store", "fields.17. Address", "fields.City", "fields.State", "fields.Zip Code",
    "fields.22. FM", "fields.✅ Client AFM",
    "trade", "fields.Sub Category", "fields.Problem Type", "priority",
    "fields.16. Client NTE 🔴", "fields.SLA Due Date", "fields.Client Portal Type",
    "description", "fields.35. WO Description"
  ]'::jsonb, true);

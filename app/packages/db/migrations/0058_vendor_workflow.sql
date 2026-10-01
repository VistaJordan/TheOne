-- 0058 · The vendor relations workflow: documents and the COI review, tasks,
--        the call and email log, CSV imports, saved lists, required fields,
--        daily targets.
--
-- 0057 gave The One the vendor RECORD and the map. This is the work the VR
-- team does around the record in VR - CRM, rebuilt here (that app is still
-- untouched and still the one in use):
--
-- DOCUMENTS. `vendor_document`: a W-9, an MSA or a certificate of insurance,
-- stored in the same private file store as work-order attachments (0043) —
-- the URL is never kept, every read goes back through the API. An upload is a
-- new row, never an overwrite. Uploading sets the matching "received" answer
-- on the vendor; a COI also opens a review task.
--
-- THE COI REVIEW. `vendor_coi_requirement`: per vendor and per company the
-- certificate names (a brand source key), the six things a reviewer ticks and
-- the verdict. Approve / send back with a note / mark fixed is the loop; the
-- vendor's own `coi_approved` (0057) is the roll-up — YES only when every
-- company with a certificate is approved, NO while any is sent back — and it
-- is that approval, not the upload, that can turn a vendor Active.
--
-- TASKS. `vendor_task`. A review task (duplicate, missing information, COI
-- review) is NOT copied to every manager as the CRM did: it has no assignee
-- and sits in one review queue that anyone holding `vendors/review` works, so
-- there is nothing to keep in step when one of them decides it. A COI fix
-- and a manual task belong to one person.
--
-- MISSING INFORMATION. `vendor_required_field` says which fields a vendor
-- must carry (Admin › Vendors & map); a field not listed takes its default
-- from packages/shared/src/vendorWorkflow.ts. A vendor saved without one is
-- flagged (`vendor.flagged_missing`) and raises a review task that closes by
-- itself once the field is filled.
--
-- THE LOG. `vendor_call` (date, notes, a link or pasted transcript and
-- summary, and the status the call left the vendor in) and `vendor_email`
-- (a manual note that an email went out — nothing is sent from here).
-- Feedback is the vendor_note log of 0057.
--
-- IMPORTS. `vendor_import`: one row per CSV import run — who, the file, the
-- choices made, what happened to each kind of row, and the flagged
-- duplicates. The rows themselves are not kept.
--
-- SAVED LISTS. `vendor_saved_view`: a named set of list filters, private,
-- for managers, or for everyone.
--
-- DAILY TARGETS. `vendor_daily_target`: how many nationwide and statewide
-- vendors a rep is asked to add on a day; progress is counted from the
-- vendors they own that were created that day.
--
-- Permissions added under `vendors`:
--   vendors/review     approve = decide the review queue (duplicates, missing
--                      information, COI review), create tasks for other
--                      people, set daily targets
--   vendors/documents  create = upload; delete = remove a document
--   vendors/import     create = import a CSV
--   vendors/export     view   = download the list as CSV
--   vendors/lists      create = save a list

ALTER TABLE vendor ADD COLUMN flagged_missing boolean NOT NULL DEFAULT false;

CREATE TABLE vendor_document (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  type         text NOT NULL CHECK (type IN ('W9', 'MSA', 'COI', 'OTHER')),
  entity       text,                       -- COI: the company it names (a brand source key)
  file_name    text NOT NULL,
  storage_key  text NOT NULL,              -- pathname in the private store; never a URL
  content_type text,
  byte_size    bigint,
  uploaded_by  uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_document_vendor_idx ON vendor_document(vendor_id, created_at DESC);

CREATE TABLE vendor_coi_requirement (
  vendor_id                    uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  entity                       text NOT NULL,
  cert_holder_confirmed        boolean NOT NULL DEFAULT false,
  additional_insured_confirmed boolean NOT NULL DEFAULT false,
  gl_limit_meets_requirement   boolean NOT NULL DEFAULT false,
  workers_comp                 boolean NOT NULL DEFAULT false,
  commercial_auto              boolean NOT NULL DEFAULT false,
  waiver_of_subrogation        boolean NOT NULL DEFAULT false,
  approved                     text NOT NULL DEFAULT 'PENDING' CHECK (approved IN ('YES', 'NO', 'PENDING')),
  review_note                  text,
  reviewed_by                  uuid REFERENCES principal(id) ON DELETE SET NULL,
  reviewed_at                  timestamptz,
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, entity)
);
CREATE TRIGGER vendor_coi_requirement_touch BEFORE UPDATE ON vendor_coi_requirement
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vendor_task (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text NOT NULL CHECK (type IN ('DUPLICATE_REVIEW', 'MISSING_INFO_REVIEW', 'COMPLIANCE_REVIEW', 'COMPLIANCE_FIX', 'MANUAL')),
  title        text NOT NULL,
  vendor_id    uuid REFERENCES vendor(id) ON DELETE CASCADE,
  entity       text,                       -- COI tasks: which company's certificate
  assigned_to  uuid REFERENCES principal(id) ON DELETE CASCADE,   -- NULL = the review queue
  status       text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE')),
  outcome      text,                       -- 'kept' | 'removed' | 'approved' | 'sent_back' | 'acknowledged' | 'fixed' | 'done' | 'auto'
  note         text,
  created_by   uuid REFERENCES principal(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_by uuid REFERENCES principal(id) ON DELETE SET NULL,
  completed_at timestamptz
);
CREATE INDEX vendor_task_open_idx     ON vendor_task(status, type) WHERE status = 'OPEN';
CREATE INDEX vendor_task_assignee_idx ON vendor_task(assigned_to, status);
CREATE INDEX vendor_task_vendor_idx   ON vendor_task(vendor_id);

CREATE TABLE vendor_call (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  logged_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  notes            text,
  call_link        text,
  transcript       text,
  summary          text,
  resulting_status text,
  edited_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  edited_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_call_vendor_idx ON vendor_call(vendor_id, occurred_at DESC);

CREATE TABLE vendor_email (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id  uuid NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  logged_by  uuid REFERENCES principal(id) ON DELETE SET NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  subject    text,
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_email_vendor_idx ON vendor_email(vendor_id, sent_at DESC);

CREATE TABLE vendor_import (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name          text NOT NULL,
  uploaded_by        uuid REFERENCES principal(id) ON DELETE SET NULL,
  kind               text NOT NULL DEFAULT 'vendor' CHECK (kind IN ('vendor', 'tech')),
  total_rows         int  NOT NULL DEFAULT 0,
  column_mapping     jsonb NOT NULL DEFAULT '{}'::jsonb,
  duplicate_strategy text NOT NULL CHECK (duplicate_strategy IN ('SKIP', 'FLAG', 'ADD_ANYWAY', 'ENRICH')),
  missing_strategy   text NOT NULL CHECK (missing_strategy IN ('ADD', 'SKIP')),
  summary            jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {created, skipped, enriched, flagged, invalid, report: [...]}
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_import_when_idx ON vendor_import(created_at DESC);

CREATE TABLE vendor_saved_view (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id   uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  name       text NOT NULL,
  params     jsonb NOT NULL DEFAULT '{}'::jsonb,           -- the list's query string, as an object
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE', 'MANAGERS', 'EVERYONE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_saved_view_owner_idx ON vendor_saved_view(owner_id);
CREATE TRIGGER vendor_saved_view_touch BEFORE UPDATE ON vendor_saved_view
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Configuration (the seed does not truncate it): only the fields somebody has
-- switched are stored; the rest take their default from the shared catalogue.
CREATE TABLE vendor_required_field (
  field_key   text PRIMARY KEY,
  is_required boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendor_daily_target (
  principal_id      uuid NOT NULL REFERENCES principal(id) ON DELETE CASCADE,
  day               date NOT NULL,
  nationwide_target int  NOT NULL DEFAULT 0,
  statewide_target  int  NOT NULL DEFAULT 0,
  set_by            uuid REFERENCES principal(id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, day)
);

-- ── Who may do what ──────────────────────────────────────────────────────────
-- Only fills a path the role has not set.

-- The review queue: the people who manage the VR team.
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/review', jsonb_build_object('approve', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'vendors/review');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/review', jsonb_build_object('approve', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'vendors/review');

-- Documents: whoever works the Vendors section uploads; removing one is for
-- managers.
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/documents', jsonb_build_object('create', true, 'delete', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am') AND NOT (permissions ? 'vendors/documents');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/documents', jsonb_build_object('create', true, 'delete', false))
 WHERE code = 'vr_officer' AND NOT (permissions ? 'vendors/documents');
UPDATE role SET permissions = permissions
    || jsonb_build_object('vendors/documents', jsonb_build_object('create', false, 'delete', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'vr_officer') AND NOT (permissions ? 'vendors/documents');

-- Import, export, saved lists: on for the same five roles.
UPDATE role SET permissions = permissions
    || jsonb_build_object(
         'vendors/import', jsonb_build_object('create', true),
         'vendors/export', jsonb_build_object('view', true),
         'vendors/lists',  jsonb_build_object('create', true))
 WHERE code IN ('admin', 'tl', 'atl', 'am', 'vr_officer') AND NOT (permissions ? 'vendors/import');
UPDATE role SET permissions = permissions
    || jsonb_build_object(
         'vendors/import', jsonb_build_object('create', false),
         'vendors/export', jsonb_build_object('view', false),
         'vendors/lists',  jsonb_build_object('create', false))
 WHERE code NOT IN ('admin', 'tl', 'atl', 'am', 'vr_officer') AND NOT (permissions ? 'vendors/import');

-- 0005 — CMMS integration tables (Ecotrak first).
--
-- Deliberately provider-agnostic: Corrigo and ServiceChannel land as additional
-- `cmms_connection` rows, not additional tables. The status map is DATA, keyed
-- per connection, because ServiceChannel and Corrigo are per-tenant configurable
-- — two clients on the same provider can have different vocabularies, so a
-- hardcoded per-provider map is wrong the day the second client onboards.

-- ── One per client + CMMS instance ──────────────────────────────────────────
CREATE TABLE cmms_connection (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL,                  -- 'ecotrak' | 'corrigo' | 'servicechannel'
  name           text NOT NULL,                  -- human label, e.g. 'Ecotrak — Seamless FM (prod)'
  environment    text NOT NULL DEFAULT 'production',
  -- Credentials live in env, NEVER here. This names the env prefix to read,
  -- e.g. 'ECOTRAK' -> ECOTRAK_CLIENT_ID / ECOTRAK_CLIENT_SECRET / ...
  credentials_ref text NOT NULL,
  base_url       text,
  account_ref    text,                           -- their id for us (SP id 1567657)
  -- Shadow mode: ingest and map, but never write status or push outbound.
  -- Ships true; flipped only once the map is proven against real payloads.
  shadow_mode    boolean NOT NULL DEFAULT true,
  active         boolean NOT NULL DEFAULT true,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, environment, account_ref)
);
CREATE TRIGGER cmms_connection_touch BEFORE UPDATE ON cmms_connection
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Immutable landing zone ─────────────────────────────────────────────────
-- The raw payload is kept VERBATIM and never edited. Vendor docs are wrong
-- about status semantics often enough that the map WILL be corrected; keeping
-- the original means re-running the mapping instead of re-fetching, and it is
-- the audit trail when a client disputes what they sent us.
CREATE TABLE cmms_event_raw (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  connection_id  uuid NOT NULL REFERENCES cmms_connection(id) ON DELETE CASCADE,
  external_id    text NOT NULL,                  -- their work-order id
  source         text NOT NULL DEFAULT 'poll',   -- 'poll' | 'webhook'
  payload        jsonb NOT NULL,
  external_status text,                          -- lifted for indexing; payload stays authoritative
  external_updated_at timestamptz,
  received_at    timestamptz NOT NULL DEFAULT now(),
  processed_at   timestamptz,
  -- Which mapping produced the interpretation, so a re-map is identifiable.
  map_version    text,
  process_error  text
);
CREATE INDEX cmms_event_raw_conn_ext_idx ON cmms_event_raw(connection_id, external_id);
CREATE INDEX cmms_event_raw_unprocessed  ON cmms_event_raw(processed_at) WHERE processed_at IS NULL;

-- ── The link between their record and ours ─────────────────────────────────
CREATE TABLE cmms_wo_link (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES cmms_connection(id) ON DELETE CASCADE,
  -- Ecotrak `id`, their immutable PK. NOT `work_order_id`, which is ours to set
  -- and is null on 100% of production records.
  external_id    text NOT NULL,
  task_id        uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,

  last_seen_external_status text,
  last_seen_at              timestamptz,

  -- Echo suppression: we push -> their webhook fires -> we ingest -> we push.
  -- An inbound event matching a recent outbound fingerprint is dropped.
  last_pushed_status      text,
  last_pushed_at          timestamptz,
  last_push_fingerprint   text,

  -- Per-WO SharePoint folder. webUrl opens it; full_path re-addresses it via
  -- Graph without another lookup.
  sharepoint_item_id  text,
  sharepoint_url      text,
  sharepoint_path     text,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  -- The dedupe key. Re-running the poll must never duplicate a work order.
  UNIQUE (connection_id, external_id),
  UNIQUE (task_id)
);
CREATE INDEX cmms_wo_link_task_idx ON cmms_wo_link(task_id);
CREATE TRIGGER cmms_wo_link_touch BEFORE UPDATE ON cmms_wo_link
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Per-connection status map — DATA, not code ─────────────────────────────
-- Inbound and outbound are separate rows because the projection is lossy: many
-- internal statuses collapse to one external value, so the inbound map is not
-- the inverse of the outbound one.
CREATE TABLE cmms_status_map (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  uuid NOT NULL REFERENCES cmms_connection(id) ON DELETE CASCADE,
  direction      text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  external_value text NOT NULL,
  canonical      text NOT NULL,
  -- inbound only: 'authoritative' | 'advisory' | 'divergent-risk'
  authority      text,
  -- The internal status this maps to, when one applies.
  status_id      uuid REFERENCES status(id),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, direction, external_value)
);

-- ── The Ecotrak production connection ──────────────────────────────────────
-- shadow_mode = true: ingest and map, write nothing back. Per the build plan,
-- the shadow week ships with zero authoritative rows.
INSERT INTO cmms_connection (provider, name, environment, credentials_ref, base_url, account_ref, shadow_mode)
VALUES (
  'ecotrak',
  'Ecotrak — Seamless FM (production, read-only)',
  'production',
  'ECOTRAK',
  'https://api.ecotrak.com',
  '1567657',
  true
);

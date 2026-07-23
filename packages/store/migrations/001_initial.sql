CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_known CHECK (id IN ('Steven','Isa','Jhon','Pablo','Miguel'))
);

CREATE TABLE rooms (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES tenants(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE memberships (
  tenant_id text NOT NULL REFERENCES tenants(id),
  room_id text NOT NULL REFERENCES rooms(id),
  alias text NOT NULL,
  role text NOT NULL DEFAULT 'agent' CHECK (role IN ('agent','operator','adapter')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, room_id, alias),
  FOREIGN KEY (room_id, tenant_id) REFERENCES rooms(id, tenant_id)
);
CREATE INDEX memberships_alias_idx ON memberships (tenant_id, alias) WHERE enabled;

CREATE TABLE acl_edges (
  from_tenant text NOT NULL REFERENCES tenants(id),
  to_tenant text NOT NULL REFERENCES tenants(id),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_tenant, to_tenant),
  CHECK (from_tenant <> to_tenant),
  CHECK (from_tenant = 'Steven' OR to_tenant = 'Steven')
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL DEFAULT '3.0' CHECK (version = '3.0'),
  request_id uuid NOT NULL,
  trace_id text NOT NULL CHECK (length(trace_id) BETWEEN 1 AND 256),
  tenant_id text NOT NULL REFERENCES tenants(id),
  room_id text NOT NULL REFERENCES rooms(id),
  actor_alias text NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  origin jsonb CHECK (origin IS NULL OR jsonb_typeof(origin) = 'object'),
  lane text NOT NULL CHECK (lane IN ('interactive','batch')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, room_id, actor_alias) REFERENCES memberships(tenant_id, room_id, alias)
);
CREATE UNIQUE INDEX messages_request_actor_idx ON messages (tenant_id, actor_alias, request_id);
CREATE INDEX messages_room_created_idx ON messages (tenant_id, room_id, created_at DESC);

CREATE TABLE idempotency_keys (
  tenant_id text NOT NULL REFERENCES tenants(id),
  actor_alias text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  message_id uuid REFERENCES messages(id),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  PRIMARY KEY (tenant_id, actor_alias, idempotency_key)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id),
  recipient_tenant text NOT NULL REFERENCES tenants(id),
  recipient_alias text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','leased','accepted','started','done','failed','retry','dead')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  consumer_instance_id text,
  consumer_epoch bigint,
  last_ack_rank smallint NOT NULL DEFAULT 0 CHECK (last_ack_rank BETWEEN 0 AND 3),
  last_error text,
  result jsonb,
  terminal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, recipient_tenant, recipient_alias)
);
CREATE INDEX deliveries_claim_idx ON deliveries (recipient_tenant, recipient_alias, available_at, status, created_at)
  WHERE status IN ('pending','retry');
CREATE INDEX deliveries_inflight_idx ON deliveries (claim_expires_at, claimed_at)
  WHERE status IN ('leased','accepted','started');
CREATE INDEX deliveries_message_idx ON deliveries (message_id);

CREATE TABLE delivery_acks (
  id bigserial PRIMARY KEY,
  delivery_id uuid NOT NULL REFERENCES deliveries(id),
  status text NOT NULL CHECK (status IN ('accepted','started','done','failed')),
  instance_id text NOT NULL,
  epoch bigint NOT NULL,
  applied boolean NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX delivery_acks_delivery_idx ON delivery_acks (delivery_id, created_at);

CREATE TABLE connection_leases (
  tenant_id text NOT NULL REFERENCES tenants(id),
  alias text NOT NULL,
  instance_id text NOT NULL,
  epoch bigint NOT NULL CHECK (epoch > 0),
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
  lease_until timestamptz NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  connected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, alias)
);
CREATE INDEX connection_leases_presence_idx ON connection_leases (lease_until);

CREATE TABLE adapter_inbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  adapter text NOT NULL,
  external_id text NOT NULL,
  request_id uuid NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (tenant_id, adapter, external_id)
);

CREATE TABLE adapter_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  adapter text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('wake','origin_relay')),
  idempotency_key text NOT NULL,
  request_id uuid NOT NULL,
  message_id uuid NOT NULL REFERENCES messages(id),
  delivery_id uuid REFERENCES deliveries(id),
  trace_id text NOT NULL,
  origin jsonb,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, adapter, idempotency_key)
);
CREATE INDEX adapter_outbox_claim_idx ON adapter_outbox (available_at, created_at) WHERE status IN ('pending','failed');

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL REFERENCES tenants(id),
  lane text NOT NULL CHECK (lane IN ('interactive','batch')),
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN -100 AND 100),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','dead')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  available_at timestamptz NOT NULL DEFAULT now(),
  claimed_by text,
  claimed_at timestamptz,
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (lane, priority DESC, available_at, created_at) WHERE status = 'queued';

CREATE TABLE dead_letters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid UNIQUE REFERENCES deliveries(id),
  job_id uuid UNIQUE REFERENCES jobs(id),
  tenant_id text NOT NULL REFERENCES tenants(id),
  reason text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT dead_letters_exactly_one_target CHECK (num_nonnulls(delivery_id, job_id) = 1)
);
CREATE INDEX dead_letters_open_idx ON dead_letters (tenant_id, created_at) WHERE resolved_at IS NULL;

CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text,
  actor_alias text,
  action text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow','deny','info')),
  request_id uuid,
  message_id uuid,
  delivery_id uuid,
  trace_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_trace_idx ON audit_events (trace_id, created_at);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, created_at DESC);

INSERT INTO tenants(id) VALUES ('Steven'),('Isa'),('Jhon'),('Pablo'),('Miguel') ON CONFLICT DO NOTHING;
INSERT INTO rooms(id, tenant_id) VALUES
  ('grp.steven','Steven'),('grp.isa','Isa'),('grp.jhon','Jhon'),('grp.pablo','Pablo'),('grp.miguel','Miguel')
ON CONFLICT DO NOTHING;
INSERT INTO memberships(tenant_id, room_id, alias, role) VALUES
  ('Steven','grp.steven','kant','agent'),('Steven','grp.steven','argos','agent'),
  ('Steven','grp.steven','socrates','agent'),('Steven','grp.steven','jarvis','agent'),
  ('Isa','grp.isa','salva','agent'),('Jhon','grp.jhon','hegel','agent'),
  ('Pablo','grp.pablo','dedalo','agent'),('Pablo','grp.pablo','midas','agent'),
  ('Pablo','grp.pablo','seneca','agent'),('Pablo','grp.pablo','vulcano','agent'),
  ('Miguel','grp.miguel','kratos','agent'),('Miguel','grp.miguel','janus','agent')
ON CONFLICT DO NOTHING;
INSERT INTO acl_edges(from_tenant, to_tenant)
SELECT t.id, 'Steven' FROM tenants t WHERE t.id <> 'Steven'
ON CONFLICT DO NOTHING;
INSERT INTO acl_edges(from_tenant, to_tenant)
SELECT 'Steven', t.id FROM tenants t WHERE t.id <> 'Steven'
ON CONFLICT DO NOTHING;

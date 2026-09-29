SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_043);

ALTER TABLE blobs DROP CONSTRAINT blobs_pkey;
ALTER TABLE blobs ADD CONSTRAINT blobs_pkey PRIMARY KEY (tenant_id, sha256);

CREATE TABLE blob_delivery_grants (
  delivery_id uuid NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  sha256 text NOT NULL,
  owner_tenant_id text NOT NULL,
  source_tenant_id text NOT NULL,
  source_alias text NOT NULL,
  target_tenant_id text NOT NULL,
  target_alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_id, sha256),
  FOREIGN KEY (owner_tenant_id, sha256) REFERENCES blobs(tenant_id, sha256) ON DELETE RESTRICT
);

CREATE INDEX blob_delivery_grants_recipient_idx
  ON blob_delivery_grants(target_tenant_id, target_alias, sha256);

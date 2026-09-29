SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_043);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
    WHERE version > '043_blob_tenant_entitlements.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 043 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM blob_delivery_grants) THEN
    RAISE EXCEPTION 'cannot downgrade schema 043 while blob delivery grants exist';
  END IF;
  IF EXISTS (
    SELECT 1 FROM blobs GROUP BY sha256 HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 043 while a digest belongs to multiple tenants';
  END IF;
END
$$;

DROP TABLE blob_delivery_grants;
ALTER TABLE blobs DROP CONSTRAINT blobs_pkey;
ALTER TABLE blobs ADD CONSTRAINT blobs_pkey PRIMARY KEY (sha256);
DELETE FROM schema_migrations WHERE version='043_blob_tenant_entitlements.sql';

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_044);

LOCK TABLE human_external_identities, human_tenant_memberships, human_message_initiators
  IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '044_human_mcp_identity.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 044 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM human_external_identities)
     OR EXISTS (SELECT 1 FROM human_tenant_memberships)
     OR EXISTS (SELECT 1 FROM human_message_initiators) THEN
    RAISE EXCEPTION 'cannot downgrade schema 044 while human identity records exist';
  END IF;
END;
$$;

DROP TABLE human_message_initiators;
DROP TABLE human_external_identities;
DROP TABLE human_tenant_memberships;
DROP FUNCTION enforce_human_identity_immutability();
DROP INDEX messages_id_tenant_identity_idx;
DELETE FROM schema_migration_ledger WHERE version = '044_human_mcp_identity.sql';
DELETE FROM schema_migrations WHERE version = '044_human_mcp_identity.sql';

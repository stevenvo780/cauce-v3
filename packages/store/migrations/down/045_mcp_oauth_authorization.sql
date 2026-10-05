SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_045);
LOCK TABLE console_users, human_external_identities, human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE cauce_oauth_requests, cauce_oauth_grants, cauce_oauth_codes, cauce_oauth_tokens,
  cauce_oauth_refresh_tokens, cauce_oauth_clients IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '045_mcp_oauth_authorization.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 045 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM cauce_oauth_requests)
     OR EXISTS (SELECT 1 FROM cauce_oauth_grants)
     OR EXISTS (SELECT 1 FROM cauce_oauth_codes)
     OR EXISTS (SELECT 1 FROM cauce_oauth_tokens)
     OR EXISTS (SELECT 1 FROM cauce_oauth_refresh_tokens) THEN
    RAISE EXCEPTION 'OAuth rollback requires an approved data-retention procedure';
  END IF;
END $$;
DROP TABLE cauce_oauth_refresh_tokens;
DROP TABLE cauce_oauth_tokens;
DROP TABLE cauce_oauth_codes;
DROP TABLE cauce_oauth_grants;
DROP TABLE cauce_oauth_requests;
DROP TABLE cauce_oauth_clients;
DROP FUNCTION cauce_oauth_preserve_authority();
DROP DOMAIN cauce_oauth_scopes;
DROP FUNCTION cauce_oauth_reject_truncate();
DROP TRIGGER cauce_oauth_binding_revision ON human_external_identities;
DROP TRIGGER cauce_oauth_membership_revision ON human_tenant_memberships;
DROP FUNCTION cauce_oauth_advance_identity_revision();
ALTER TABLE human_external_identities DROP CONSTRAINT human_external_identity_oauth_owner;
DELETE FROM schema_migration_ledger WHERE version = '045_mcp_oauth_authorization.sql';
DELETE FROM schema_migrations WHERE version = '045_mcp_oauth_authorization.sql';

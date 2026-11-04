SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_098);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'098_dlq_platform_company_reach.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'098_dlq_platform_company_reach.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 098 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='098_dlq_platform_company_reach.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='098_dlq_platform_company_reach.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='098_dlq_platform_company_reach.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'f91a233e2ca3ab0e216b9d0d0c27448fed18f6e7a6afaf9f5b633c888fb75569')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 098 from an inconsistent atomic ledger state';
  END IF;
END $$;
-- Resolutions already recorded through these functions stay: they are ordinary 030 rows
-- (dlq_operator_resolutions, dlq_reconciliation_transitions, audit_events) and remain valid.
DROP FUNCTION cauce_resolve_dlq_without_replay_platform_098(text,uuid,text,text,text,text,text,uuid,text,boolean,boolean);
DROP FUNCTION cauce_list_dlq_platform_098(text,text,text,uuid,integer,text);
DROP FUNCTION cauce_dlq_assert_platform_098(text,text,text,uuid);
DROP FUNCTION cauce_dlq_platform_classification_098(uuid);
DROP FUNCTION cauce_dlq_platform_reach_098(text,text);
DELETE FROM schema_migration_ledger WHERE version='098_dlq_platform_company_reach.sql';
DELETE FROM schema_migrations WHERE version='098_dlq_platform_company_reach.sql';

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_069);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'069_diagnostic_frontier_indexes.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'069_diagnostic_frontier_indexes.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 069 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='069_diagnostic_frontier_indexes.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='069_diagnostic_frontier_indexes.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='069_diagnostic_frontier_indexes.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'3f5facd6a77af5bbb246b0ce13e116ee0d94592108df45ea9042221b430829c8')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 069 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
DROP INDEX IF EXISTS audit_diagnostic_context_idx;
DROP INDEX IF EXISTS audit_diagnostic_backup_id_idx;
DROP INDEX IF EXISTS audit_diagnostic_receipts_idx;
DROP INDEX IF EXISTS audit_diagnostic_delivery_idx;
DROP INDEX IF EXISTS audit_diagnostic_message_idx;
DROP INDEX IF EXISTS terminal_sessions_diagnostic_trace_idx;
DROP INDEX IF EXISTS messages_diagnostic_trace_idx;
DELETE FROM schema_migration_ledger WHERE version='069_diagnostic_frontier_indexes.sql';
DELETE FROM schema_migrations WHERE version='069_diagnostic_frontier_indexes.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

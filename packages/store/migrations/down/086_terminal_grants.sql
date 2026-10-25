SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_086);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'086_terminal_grants.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'086_terminal_grants.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 086 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='086_terminal_grants.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='086_terminal_grants.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='086_terminal_grants.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'e7dbe8eaf7e24d786fd86ca9458bebb4d0a0c389aeed5efa396198c83d153f44')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 086 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE terminal_grants IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM terminal_grants WHERE revoked_at IS NULL) THEN
    RAISE EXCEPTION 'revoke every terminal grant before reverting schema 086';
  END IF;
END
$$;

DROP TABLE terminal_grants;
DROP FUNCTION cauce_terminal_grant_validate();
DROP FUNCTION cauce_runtime_grants_086();

DELETE FROM schema_migration_ledger WHERE version='086_terminal_grants.sql';
DELETE FROM schema_migrations WHERE version='086_terminal_grants.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

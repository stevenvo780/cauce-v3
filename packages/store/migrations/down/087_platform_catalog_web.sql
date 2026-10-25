SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_087);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'087_platform_catalog_web.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'087_platform_catalog_web.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 087 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='087_platform_catalog_web.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='087_platform_catalog_web.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='087_platform_catalog_web.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'9c155815d18b4d4f08924f5ecf3fddc5e37e628e784f91ab0b43b0df30c2e287')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 087 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);

CREATE OR REPLACE FUNCTION cauce_platform_write_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NOT pg_has_role(current_user,'cauce_platform','MEMBER') THEN
    RAISE EXCEPTION '% on % requires the cauce_platform role',TG_OP,TG_TABLE_NAME USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END
$$;

REVOKE INSERT, DELETE ON harness_definitions, role_policies FROM cauce_runtime;
DROP FUNCTION cauce_runtime_grants_087();

DELETE FROM schema_migration_ledger WHERE version='087_platform_catalog_web.sql';
DELETE FROM schema_migrations WHERE version='087_platform_catalog_web.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

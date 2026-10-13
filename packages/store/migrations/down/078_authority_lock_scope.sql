SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_078);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'078_authority_lock_scope.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'078_authority_lock_scope.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 078 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='078_authority_lock_scope.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='078_authority_lock_scope.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='078_authority_lock_scope.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'2250ef6e6e3956a98834b534b3165bcffb2588b26926cfad60f1052a4c31da34')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 078 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
CREATE OR REPLACE FUNCTION cauce_lock_owner_guard(p_company text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_admins admin ORDER BY admin.human_id FOR NO KEY UPDATE OF admin;
  PERFORM 1 FROM public.company_admins admin WHERE admin.company_id=p_company AND admin.role='owner'
    ORDER BY admin.human_id FOR NO KEY UPDATE OF admin;
END
$$;

CREATE OR REPLACE FUNCTION cauce_console_users_owner_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT (OLD.active AND OLD.role='operator') OR (NEW.active AND NEW.role='operator') THEN RETURN NEW; END IF;
  PERFORM cauce_lock_owner_guard(OLD.company_id);
  IF EXISTS (SELECT 1 FROM company_admins admin WHERE admin.company_id=OLD.company_id
      AND admin.human_id=OLD.id AND admin.role='owner')
    AND NOT EXISTS (SELECT 1 FROM company_admins admin JOIN console_users person ON person.id=admin.human_id
      WHERE admin.company_id=OLD.company_id AND admin.role='owner' AND admin.human_id<>OLD.id
        AND person.active AND person.role='operator') THEN
    RAISE EXCEPTION 'the last active owner of company % must stay an active operator',OLD.company_id
      USING ERRCODE='23514', TABLE='console_users', CONSTRAINT='console_users_last_company_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM platform_admins admin WHERE admin.human_id=OLD.id)
    AND NOT EXISTS (SELECT 1 FROM platform_admins admin JOIN console_users person ON person.id=admin.human_id
      WHERE admin.human_id<>OLD.id AND person.active AND person.role='operator') THEN
    RAISE EXCEPTION 'the last active platform administrator must stay an active operator'
      USING ERRCODE='23514', TABLE='console_users', CONSTRAINT='console_users_last_platform_admin';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION cauce_lock_authority_read_guard()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_admins admin ORDER BY admin.human_id FOR SHARE OF admin;
END
$$;

DROP TRIGGER IF EXISTS platform_admins_authority_guard ON platform_admins;
DROP TRIGGER IF EXISTS platform_admins_z_authority_statement_guard ON platform_admins;
DROP FUNCTION IF EXISTS cauce_platform_admins_authority_guard();
DROP FUNCTION IF EXISTS cauce_runtime_grants_078();
DROP FUNCTION IF EXISTS cauce_lock_platform_owner_guard();
DELETE FROM schema_migration_ledger WHERE version='078_authority_lock_scope.sql';
DELETE FROM schema_migrations WHERE version='078_authority_lock_scope.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

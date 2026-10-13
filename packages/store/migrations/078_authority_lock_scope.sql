SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_078);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE platform_admins IN SHARE ROW EXCLUSIVE MODE;

-- A waiter needs a fresh snapshot after the preceding writer commits.
CREATE OR REPLACE FUNCTION cauce_lock_owner_guard(p_company text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'authority writes require read committed isolation' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('lock_timeout','5s',true);
  PERFORM pg_advisory_xact_lock(783003055,hashtext(p_company));
END
$$;

-- Platform-holder changes take this guard before the company guard.
CREATE FUNCTION cauce_lock_platform_owner_guard()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'authority writes require read committed isolation' USING ERRCODE='40001';
  END IF;
  PERFORM set_config('lock_timeout','5s',true);
  PERFORM pg_advisory_xact_lock(783003078,0);
END
$$;

-- Older runtimes still call this function; identity rows keep their specific locks.
CREATE OR REPLACE FUNCTION cauce_lock_authority_read_guard()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM set_config('lock_timeout','5s',true);
END
$$;

CREATE OR REPLACE FUNCTION cauce_console_users_owner_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  platform boolean;
BEGIN
  IF NOT (OLD.active AND OLD.role='operator') OR (NEW.active AND NEW.role='operator') THEN RETURN NEW; END IF;
  platform := EXISTS (SELECT 1 FROM platform_admins admin WHERE admin.human_id=OLD.id);
  IF platform THEN PERFORM cauce_lock_platform_owner_guard(); END IF;
  PERFORM cauce_lock_owner_guard(OLD.company_id);
  IF NOT platform AND EXISTS (SELECT 1 FROM platform_admins admin WHERE admin.human_id=OLD.id) THEN
    RAISE EXCEPTION 'platform authority changed; reload and retry' USING ERRCODE='40001';
  END IF;
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

-- Holder grants and revocations cannot overtake a company authority write.
CREATE FUNCTION cauce_platform_admins_authority_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  subject_company text;
BEGIN
  IF TG_LEVEL='STATEMENT' THEN
    PERFORM cauce_lock_platform_owner_guard();
    RETURN NULL;
  END IF;
  FOR subject_company IN SELECT DISTINCT person.company_id FROM console_users person
    WHERE person.id IN (CASE WHEN TG_OP<>'INSERT' THEN OLD.human_id END,
      CASE WHEN TG_OP<>'DELETE' THEN NEW.human_id END) ORDER BY person.company_id
  LOOP
    PERFORM cauce_lock_owner_guard(subject_company);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER platform_admins_authority_guard BEFORE INSERT OR UPDATE OR DELETE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION cauce_platform_admins_authority_guard();
CREATE TRIGGER platform_admins_z_authority_statement_guard BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform_admins
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_admins_authority_guard();

CREATE FUNCTION cauce_runtime_grants_078()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_lock_platform_owner_guard(),cauce_platform_admins_authority_guard(),cauce_runtime_grants_078() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_lock_platform_owner_guard() TO cauce_runtime,cauce_platform;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_078() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_078();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

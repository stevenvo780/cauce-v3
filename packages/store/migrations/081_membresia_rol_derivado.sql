SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_081);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE console_users,human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;

-- Only the home membership is live authority; revoked rows of earlier tenants are
-- immutable history whose stored role is discarded without being reconciled.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM human_tenant_memberships h JOIN console_users u
               ON u.id=h.human_id AND h.tenant_id=u.tenant_id
             WHERE h.role<>u.role) THEN
    RAISE EXCEPTION 'cannot derive membership role: console_users.role and the home membership role differ'
      USING ERRCODE='23514';
  END IF;
END
$$;

CREATE FUNCTION pg_temp.cauce_081_patch(p_proc regprocedure,p_from text,p_to text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source text := pg_get_functiondef(p_proc); patched text;
BEGIN
  patched := replace(source,p_from,p_to);
  IF patched = source THEN RAISE EXCEPTION 'pattern % not found in %',p_from,p_proc; END IF;
  EXECUTE patched;
END
$$;

SELECT pg_temp.cauce_081_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,company_id)',
  'human_tenant_memberships(human_id,tenant_id,actor_alias,permissions,company_id)');
SELECT pg_temp.cauce_081_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'VALUES(person,hub,''owner'',''operator'',ARRAY[',
  'VALUES(person,hub,''owner'',ARRAY[');
SELECT pg_temp.cauce_081_patch('cauce_require_company_owner(text,uuid)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_assert_qualified_company_owner(text)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_set_company_admin(text,uuid,uuid,text,bigint)'::regprocedure,
  'AND h.role=''operator'' AND ''control''=ANY(h.permissions)','AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND member.role=identity.role','AND member.role=human.role');
SELECT pg_temp.cauce_081_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  ' AND identity.role=human.role','');

CREATE OR REPLACE FUNCTION cauce_oauth_advance_identity_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Human identity revision cannot decrease';
  END IF;
  IF TG_TABLE_NAME='human_external_identities' THEN
    changed := (NEW.enabled, NEW.revoked_at) IS DISTINCT FROM (OLD.enabled, OLD.revoked_at);
  ELSE
    changed := (NEW.enabled, NEW.revoked_at, NEW.actor_alias, NEW.permissions)
      IS DISTINCT FROM (OLD.enabled, OLD.revoked_at, OLD.actor_alias, OLD.permissions);
  END IF;
  IF changed THEN NEW.revision := GREATEST(NEW.revision, OLD.revision+1); END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION cauce_console_user_role_revision() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  UPDATE human_tenant_memberships SET revision=revision+1 WHERE human_id=NEW.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER console_users_role_revision AFTER UPDATE OF role ON console_users
  FOR EACH ROW WHEN (NEW.role IS DISTINCT FROM OLD.role) EXECUTE FUNCTION cauce_console_user_role_revision();

CREATE FUNCTION cauce_human_reader_ceiling() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM human_tenant_memberships h JOIN console_users u
               ON u.id=h.human_id AND h.tenant_id=u.tenant_id
             WHERE h.human_id=(to_jsonb(NEW)->>TG_ARGV[0])::uuid
               AND u.role='reader' AND NOT h.permissions <@ ARRAY['read']::text[]) THEN
    RAISE EXCEPTION 'a reader may only hold the read permission'
      USING ERRCODE='23514', TABLE='human_tenant_memberships', CONSTRAINT='human_membership_reader_read_only';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER human_memberships_reader_ceiling
  AFTER INSERT OR UPDATE OF permissions ON human_tenant_memberships
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cauce_human_reader_ceiling('human_id');
CREATE CONSTRAINT TRIGGER console_users_reader_ceiling
  AFTER UPDATE OF role, tenant_id ON console_users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.role='reader') EXECUTE FUNCTION cauce_human_reader_ceiling('id');

ALTER TABLE human_tenant_memberships DROP COLUMN role;

CREATE FUNCTION cauce_runtime_grants_081()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_console_user_role_revision(),cauce_human_reader_ceiling(),cauce_runtime_grants_081() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_console_user_role_revision(),cauce_human_reader_ceiling(),cauce_runtime_grants_081() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_081();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

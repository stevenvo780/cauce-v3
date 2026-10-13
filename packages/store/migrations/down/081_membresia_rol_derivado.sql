SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_081);
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'081_membresia_rol_derivado.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'081_membresia_rol_derivado.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 081 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version='081_membresia_rol_derivado.sql') <>
      EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='081_membresia_rol_derivado.sql')
    OR EXISTS (SELECT 1 FROM schema_migration_ledger WHERE version='081_membresia_rol_derivado.sql'
      AND (source_origin<>'applied-atomically'
        OR source_sha256<>'e74d501afd273038dcf9c02d2e63d983f7c48236db12c5fc32979c0189fc4582'))
    OR (to_regprocedure('public.cauce_runtime_grants_081()') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version='081_membresia_rol_derivado.sql')) THEN
    RAISE EXCEPTION 'cannot downgrade schema 081 from an inconsistent atomic ledger state';
  END IF;
END
$$;
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE console_users,human_tenant_memberships IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS console_users_reader_ceiling ON console_users;
DROP TRIGGER IF EXISTS human_memberships_reader_ceiling ON human_tenant_memberships;
DROP TRIGGER IF EXISTS console_users_role_revision ON console_users;
DROP FUNCTION IF EXISTS cauce_runtime_grants_081();
DROP FUNCTION IF EXISTS cauce_human_reader_ceiling();
DROP FUNCTION IF EXISTS cauce_console_user_role_revision();

CREATE OR REPLACE FUNCTION cauce_oauth_advance_identity_revision() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE changed boolean;
BEGIN
  IF NEW.revision < OLD.revision THEN
    RAISE EXCEPTION 'Human identity revision cannot decrease';
  END IF;
  IF TG_TABLE_NAME='human_external_identities' THEN
    changed := (NEW.enabled, NEW.revoked_at) IS DISTINCT FROM (OLD.enabled, OLD.revoked_at);
  ELSE
    changed := (NEW.enabled, NEW.revoked_at, NEW.actor_alias, NEW.role, NEW.permissions)
      IS DISTINCT FROM (OLD.enabled, OLD.revoked_at, OLD.actor_alias, OLD.role, OLD.permissions);
  END IF;
  IF changed THEN NEW.revision := GREATEST(NEW.revision, OLD.revision+1); END IF;
  RETURN NEW;
END $$;

ALTER TABLE human_tenant_memberships DISABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships ADD COLUMN role text;
UPDATE human_tenant_memberships h SET role=CASE
    WHEN h.tenant_id=u.tenant_id THEN u.role
    WHEN h.permissions <@ ARRAY['read']::text[] THEN 'reader'
    ELSE 'operator' END
  FROM console_users u WHERE u.id=h.human_id;
ALTER TABLE human_tenant_memberships ENABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT human_tenant_memberships_role_check CHECK (role IN ('operator','reader')),
  ADD CONSTRAINT human_tenant_memberships_check
    CHECK (role <> 'reader' OR permissions <@ ARRAY['read']::text[]);

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
  'human_tenant_memberships(human_id,tenant_id,actor_alias,permissions,company_id)',
  'human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,company_id)');
SELECT pg_temp.cauce_081_patch('cauce_register_company_without_director(text,text,text,text,text)'::regprocedure,
  'VALUES(person,hub,''owner'',ARRAY[','VALUES(person,hub,''owner'',''operator'',ARRAY[');
SELECT pg_temp.cauce_081_patch('cauce_require_company_owner(text,uuid)'::regprocedure,
  'h.revoked_at IS NULL AND ''control''=ANY(h.permissions)',
  'h.revoked_at IS NULL AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_assert_qualified_company_owner(text)'::regprocedure,
  'h.actor_alias=u.alias AND ''control''=ANY(h.permissions)',
  'h.actor_alias=u.alias AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_set_company_admin(text,uuid,uuid,text,bigint)'::regprocedure,
  'h.actor_alias=u.alias AND ''control''=ANY(h.permissions)',
  'h.actor_alias=u.alias AND h.role=''operator'' AND ''control''=ANY(h.permissions)');
SELECT pg_temp.cauce_081_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND member.role=human.role','AND member.role=identity.role');
SELECT pg_temp.cauce_081_patch('cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
  'AND identity.enabled AND identity.revoked_at IS NULL',
  'AND identity.enabled AND identity.revoked_at IS NULL AND identity.role=human.role');
DELETE FROM schema_migration_ledger WHERE version='081_membresia_rol_derivado.sql';
DELETE FROM schema_migrations WHERE version='081_membresia_rol_derivado.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

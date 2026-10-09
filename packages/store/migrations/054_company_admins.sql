SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_054);
-- As in 053, one statement takes every lock so statement_timeout bounds the whole lock phase.
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('cauce.migration_statement_timeout',current_setting('statement_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
SELECT set_config('statement_timeout','6s',true);
DO $$
BEGIN
  LOCK TABLE tenants,agent_role_templates,agents,companies,company_links,console_users,egress_destinations,
    platform_admins,rooms IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE human_tenant_memberships,memberships,role_policies IN SHARE MODE;
END
$$;
SELECT set_config('statement_timeout',current_setting('cauce.migration_statement_timeout'),true);

CREATE TABLE company_admins (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  human_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin')),
  source text NOT NULL CHECK (source IN ('v4.0-hub-operator','platform','import')),
  granted_by uuid REFERENCES console_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,human_id),
  FOREIGN KEY (human_id,company_id) REFERENCES console_users(id,company_id) ON DELETE RESTRICT,
  CHECK (source='v4.0-hub-operator' OR granted_by IS NOT NULL)
);
CREATE INDEX company_admins_human_idx ON company_admins(human_id);

CREATE TABLE platform_authority_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL CHECK (action IN ('company.create','company.state','company.link','company.unlink',
    'admin.grant','admin.revoke','platform_admin.grant','platform_admin.revoke')),
  company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  peer_company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  subject_human_id uuid,
  actor_human_id uuid,
  database_role text NOT NULL DEFAULT session_user,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_authority_events_company_idx ON platform_authority_events(company_id,id DESC);

-- Data that replaces company literals in code: reserved principals and well-known agent roles. Their
-- foreign keys keep a named agent or room from being deleted until the platform reassigns the role.
CREATE TABLE company_system_principals (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('gate_probe','director','supervision_notice','human_receipt')),
  tenant_id text NOT NULL,
  room_id text,
  actor_alias text,
  principal_alias text NOT NULL CHECK (principal_alias ~ '^[a-z][a-z0-9_-]{0,63}$'),
  recipient_alias text,
  notify_handle text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,kind,tenant_id,principal_alias),
  FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  FOREIGN KEY (tenant_id,room_id) REFERENCES rooms(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_alias) REFERENCES agents(tenant_id,alias),
  FOREIGN KEY (tenant_id,recipient_alias) REFERENCES agents(tenant_id,alias),
  FOREIGN KEY (tenant_id,recipient_alias,notify_handle) REFERENCES egress_destinations(tenant_id,alias,handle)
);
CREATE UNIQUE INDEX company_system_principals_singleton_idx ON company_system_principals(company_id,kind)
  WHERE kind IN ('gate_probe','supervision_notice');

CREATE TABLE company_agent_roles (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role ~ '^[a-z][a-z0-9_]{0,63}$'),
  tenant_id text NOT NULL,
  alias text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id,role,tenant_id,alias),
  FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  FOREIGN KEY (tenant_id,alias) REFERENCES agents(tenant_id,alias)
);
CREATE UNIQUE INDEX company_agent_roles_singleton_idx ON company_agent_roles(company_id,role)
  WHERE role IN ('infra_escalation','coordination');

-- A template without an owner stays shared by every company.
CREATE TABLE agent_role_template_owners (
  slug text PRIMARY KEY REFERENCES agent_role_templates(slug) ON DELETE CASCADE,
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Serializes every change that could remove the last owner of a company or the last platform
-- administrator. Row locks need UPDATE, which the runtime never holds on these tables.
CREATE FUNCTION cauce_lock_owner_guard(p_company text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.platform_admins admin ORDER BY admin.human_id FOR NO KEY UPDATE OF admin;
  PERFORM 1 FROM public.company_admins admin WHERE admin.company_id=p_company AND admin.role='owner'
    ORDER BY admin.human_id FOR NO KEY UPDATE OF admin;
END
$$;

-- G3: a new company commits with an owner, and a company with an owner never commits without one.
CREATE FUNCTION cauce_company_owner_continuity()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  checked text;
BEGIN
  IF TG_TABLE_NAME='companies' THEN checked := NEW.id;
  ELSIF OLD.role='owner' THEN checked := OLD.company_id;
  ELSE RETURN NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM companies company WHERE company.id=checked) THEN RETURN NULL; END IF;
  PERFORM cauce_lock_owner_guard(checked);
  IF NOT EXISTS (SELECT 1 FROM company_admins admin JOIN console_users person ON person.id=admin.human_id
    WHERE admin.company_id=checked AND admin.role='owner' AND person.active AND person.role='operator') THEN
    RAISE EXCEPTION 'company % must keep an active owner',checked
      USING ERRCODE='23514', TABLE='company_admins', CONSTRAINT='company_admins_owner_continuity';
  END IF;
  RETURN NULL;
END
$$;

-- G4: the last active owner of a company and the last active platform administrator stay operators.
-- G3 and G4 watch only the role and state of a person: the home membership and the credentials of an
-- owner are protected by the application alone.
CREATE FUNCTION cauce_console_users_owner_guard()
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

-- Facts for the authority resolver, row-locked for the caller transaction. A NULL company means the
-- home company of the person; an unknown person yields no row.
CREATE FUNCTION cauce_company_authority(p_human uuid, p_company text)
RETURNS TABLE(home_company text, platform_admin boolean, company_role text, company_enabled boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  acting text;
BEGIN
  SELECT person.company_id INTO home_company FROM public.console_users person
    WHERE person.id=p_human FOR SHARE OF person;
  IF NOT FOUND THEN RETURN; END IF;
  acting := COALESCE(p_company,home_company);
  platform_admin := EXISTS (SELECT 1 FROM public.platform_admins admin WHERE admin.human_id=p_human FOR SHARE OF admin);
  SELECT admin.role INTO company_role FROM public.company_admins admin
    WHERE admin.company_id=acting AND admin.human_id=p_human FOR SHARE OF admin;
  SELECT company.enabled AND company.retired_at IS NULL INTO company_enabled FROM public.companies company
    WHERE company.id=acting FOR SHARE OF company;
  company_enabled := COALESCE(company_enabled,false);
  RETURN NEXT;
END
$$;

CREATE FUNCTION cauce_platform_record(
  p_action text, p_company text, p_peer text, p_subject uuid, p_admin uuid, p_metadata jsonb
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  INSERT INTO platform_authority_events(action,company_id,peer_company_id,subject_human_id,actor_human_id,metadata)
    VALUES(p_action,p_company,p_peer,p_subject,p_admin,p_metadata);
  INSERT INTO audit_events(action,decision,company_id,actor_human_id,metadata)
    VALUES('platform.'||p_action,'allow',p_company,p_admin,
      jsonb_strip_nulls(jsonb_build_object('peer_company_id',p_peer,'subject_human_id',p_subject))||p_metadata);
END
$$;

CREATE FUNCTION cauce_platform_assert_admin(p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM 1 FROM platform_admins admin JOIN console_users person ON person.id=admin.human_id
    WHERE admin.human_id=p_admin AND person.active AND person.role='operator' FOR SHARE OF admin;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'an active platform administrator is required' USING ERRCODE='42501';
  END IF;
END
$$;

-- Superuser changes to the platform administrators are journaled with the database role.
CREATE FUNCTION cauce_platform_admins_journal()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM cauce_platform_record('platform_admin.grant',NULL,NULL,NEW.human_id,NULL,'{}'::jsonb);
  ELSE
    PERFORM cauce_platform_record('platform_admin.revoke',NULL,NULL,OLD.human_id,NULL,'{}'::jsonb);
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION cauce_platform_create_company(p_company text, p_name text, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  INSERT INTO companies(id,name) VALUES(p_company,btrim(p_name));
  PERFORM cauce_platform_record('company.create',p_company,NULL,NULL,p_admin,jsonb_build_object('name',btrim(p_name)));
END
$$;

CREATE FUNCTION cauce_platform_set_company_state(p_company text, p_state text, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  previous text;
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  IF p_state IS NULL OR p_state NOT IN ('enabled','disabled','retired') THEN
    RAISE EXCEPTION 'company state must be enabled, disabled or retired' USING ERRCODE='22023';
  END IF;
  SELECT CASE WHEN company.retired_at IS NOT NULL THEN 'retired' WHEN company.enabled THEN 'enabled' ELSE 'disabled' END
    INTO previous FROM companies company WHERE company.id=p_company FOR UPDATE OF company;
  IF NOT FOUND THEN RAISE EXCEPTION 'company % does not exist',p_company USING ERRCODE='P0002'; END IF;
  UPDATE companies SET enabled=(p_state='enabled'),
    retired_at=CASE WHEN p_state='retired' THEN COALESCE(retired_at,now()) END,
    version=version+1,updated_at=now()
    WHERE id=p_company;
  PERFORM cauce_platform_record('company.state',p_company,NULL,NULL,p_admin,
    jsonb_build_object('state',p_state,'previous_state',previous));
END
$$;

CREATE FUNCTION cauce_platform_link(p_company_a text, p_company_b text, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  first_company text := LEAST(p_company_a COLLATE "C",p_company_b COLLATE "C");
  second_company text := GREATEST(p_company_a COLLATE "C",p_company_b COLLATE "C");
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  INSERT INTO company_links(company_a,company_b,created_by) VALUES(first_company,second_company,p_admin);
  PERFORM cauce_platform_record('company.link',first_company,second_company,NULL,p_admin,'{}'::jsonb);
END
$$;

CREATE FUNCTION cauce_platform_unlink(p_company_a text, p_company_b text, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  first_company text := LEAST(p_company_a COLLATE "C",p_company_b COLLATE "C");
  second_company text := GREATEST(p_company_a COLLATE "C",p_company_b COLLATE "C");
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  DELETE FROM company_links WHERE company_a=first_company AND company_b=second_company;
  IF NOT FOUND THEN RAISE EXCEPTION 'company link does not exist' USING ERRCODE='P0002'; END IF;
  PERFORM cauce_platform_record('company.unlink',first_company,second_company,NULL,p_admin,'{}'::jsonb);
END
$$;

-- Both the id and the email must match the person the platform administrator confirmed.
CREATE FUNCTION cauce_platform_grant_admin(p_company text, p_human uuid, p_email text, p_role text, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  previous text;
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  IF p_role IS NULL OR p_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'company administrator role must be owner or admin' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM companies company WHERE company.id=p_company FOR UPDATE OF company;
  IF NOT FOUND THEN RAISE EXCEPTION 'company % does not exist',p_company USING ERRCODE='P0002'; END IF;
  PERFORM 1 FROM console_users person WHERE person.id=p_human AND person.email_normalized=lower(btrim(p_email))
    AND person.active AND person.role='operator' AND person.company_id=p_company FOR SHARE OF person;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the confirmed person is not an active operator of company %',p_company USING ERRCODE='22023';
  END IF;
  SELECT admin.role INTO previous FROM company_admins admin WHERE admin.company_id=p_company AND admin.human_id=p_human;
  INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES(p_company,p_human,p_role,'platform',p_admin)
    ON CONFLICT (company_id,human_id) DO UPDATE SET role=EXCLUDED.role,source=EXCLUDED.source,granted_by=EXCLUDED.granted_by;
  PERFORM cauce_platform_record('admin.grant',p_company,NULL,p_human,p_admin,
    jsonb_strip_nulls(jsonb_build_object('role',p_role,'previous_role',previous)));
END
$$;

CREATE FUNCTION cauce_platform_revoke_admin(p_company text, p_human uuid, p_admin uuid)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  previous text;
BEGIN
  PERFORM cauce_platform_assert_admin(p_admin);
  PERFORM 1 FROM companies company WHERE company.id=p_company FOR UPDATE OF company;
  IF NOT FOUND THEN RAISE EXCEPTION 'company % does not exist',p_company USING ERRCODE='P0002'; END IF;
  DELETE FROM company_admins WHERE company_id=p_company AND human_id=p_human RETURNING role INTO previous;
  IF NOT FOUND THEN RAISE EXCEPTION 'company administrator does not exist' USING ERRCODE='P0002'; END IF;
  PERFORM cauce_platform_record('admin.revoke',p_company,NULL,p_human,p_admin,jsonb_build_object('previous_role',previous));
END
$$;

CREATE FUNCTION cauce_role_template_company_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='agents' THEN
    IF NEW.role_template_slug IS NOT NULL AND EXISTS (SELECT 1 FROM agent_role_template_owners owner
      WHERE owner.slug=NEW.role_template_slug AND owner.company_id<>NEW.company_id) THEN
      RAISE EXCEPTION 'role template % belongs to another company',NEW.role_template_slug
        USING ERRCODE='23514', TABLE='agents', CONSTRAINT='agents_role_template_company';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM agents agent WHERE agent.role_template_slug=NEW.slug AND agent.company_id<>NEW.company_id) THEN
    RAISE EXCEPTION 'role template % is already used by another company',NEW.slug
      USING ERRCODE='23514', TABLE='agent_role_template_owners', CONSTRAINT='agents_role_template_company';
  END IF;
  RETURN NEW;
END
$$;

-- The current people administrators keep their access as admins; owners are seeded by hand.
INSERT INTO company_admins(company_id,human_id,role,source)
SELECT DISTINCT person.company_id,person.id,'admin','v4.0-hub-operator' FROM console_users person
  JOIN human_tenant_memberships human ON human.human_id=person.id AND human.tenant_id=person.tenant_id
    AND human.actor_alias=person.alias
  JOIN agents agent ON agent.tenant_id=person.tenant_id AND agent.alias=person.alias
  JOIN tenants tenant ON tenant.id=person.tenant_id
  JOIN memberships member ON member.tenant_id=person.tenant_id AND member.alias=person.alias
  JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
  JOIN role_policies policy ON policy.role=member.role
  WHERE person.active AND person.role='operator' AND human.enabled AND human.revoked_at IS NULL
    AND human.role='operator' AND 'control'=ANY(human.permissions) AND agent.retired_at IS NULL
    AND tenant.enabled AND tenant.is_hub AND member.enabled AND room.enabled AND policy.allow_control;

INSERT INTO company_system_principals(company_id,kind,tenant_id,room_id,actor_alias,principal_alias)
SELECT tenant.company_id,'gate_probe',tenant.id,room.id,agent.alias,'gate-probe' FROM tenants tenant
  JOIN rooms room ON room.tenant_id=tenant.id AND room.id='grp.steven'
  JOIN agents agent ON agent.tenant_id=tenant.id AND agent.alias='kant'
  WHERE tenant.id='Steven' AND tenant.company_id='humanizar';
INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias)
SELECT tenant.company_id,'director',tenant.id,agent.alias FROM tenants tenant
  JOIN agents agent ON agent.tenant_id=tenant.id AND agent.alias='argos'
  WHERE tenant.id='Steven' AND tenant.company_id='humanizar';
INSERT INTO company_agent_roles(company_id,role,tenant_id,alias)
SELECT tenant.company_id,seed.role,tenant.id,agent.alias FROM (VALUES('infra_escalation','zeus'),('coordination','kant')) seed(role,alias)
  JOIN tenants tenant ON tenant.id='Steven' AND tenant.company_id='humanizar'
  JOIN agents agent ON agent.tenant_id=tenant.id AND agent.alias=seed.alias;

-- G1: only the platform role writes the platform plane, besides the missing grants: the statement
-- guard of 052.
CREATE TRIGGER companies_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON companies
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER company_links_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON company_links
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER platform_admins_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform_admins
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER company_admins_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON company_admins
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER platform_authority_events_platform_write
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON platform_authority_events
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER company_system_principals_platform_write
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON company_system_principals
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER company_agent_roles_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON company_agent_roles
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER agent_role_template_owners_platform_write
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON agent_role_template_owners
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard();
CREATE TRIGGER platform_authority_events_append_only BEFORE UPDATE OR DELETE ON platform_authority_events
  FOR EACH ROW EXECUTE FUNCTION cauce_append_only();
CREATE CONSTRAINT TRIGGER companies_owner_required AFTER INSERT ON companies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cauce_company_owner_continuity();
CREATE CONSTRAINT TRIGGER company_admins_owner_continuity AFTER UPDATE OR DELETE ON company_admins
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION cauce_company_owner_continuity();
CREATE TRIGGER console_users_owner_guard BEFORE UPDATE OF active,role ON console_users
  FOR EACH ROW EXECUTE FUNCTION cauce_console_users_owner_guard();
CREATE TRIGGER platform_admins_journal AFTER INSERT OR DELETE ON platform_admins
  FOR EACH ROW EXECUTE FUNCTION cauce_platform_admins_journal();
CREATE TRIGGER agents_role_template_company_guard BEFORE INSERT OR UPDATE OF role_template_slug ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_role_template_company_guard();
CREATE TRIGGER agent_role_template_owners_company_guard BEFORE INSERT OR UPDATE ON agent_role_template_owners
  FOR EACH ROW EXECUTE FUNCTION cauce_role_template_company_guard();

-- The grants of 054, replayed by cauce_apply_runtime_grants() of 052 after a restore without ACLs.
-- The runtime only reads the tables of 054, and executes the resolver and the owner lock that its
-- writes to console_users call. The platform writes them as their owner; as in 052, membership in
-- cauce_platform only lets it through the write guard.
CREATE FUNCTION cauce_runtime_grants_054()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_lock_owner_guard(text),cauce_company_authority(uuid,text),
    cauce_company_owner_continuity(),cauce_console_users_owner_guard(),cauce_platform_record(text,text,text,uuid,uuid,jsonb),
    cauce_platform_assert_admin(uuid),cauce_platform_admins_journal(),cauce_platform_create_company(text,text,uuid),
    cauce_platform_set_company_state(text,text,uuid),cauce_platform_link(text,text,uuid),cauce_platform_unlink(text,text,uuid),
    cauce_platform_grant_admin(text,uuid,text,text,uuid),cauce_platform_revoke_admin(text,uuid,uuid),
    cauce_role_template_company_guard(),cauce_runtime_grants_054() FROM PUBLIC;
  GRANT SELECT ON company_admins,platform_authority_events,company_system_principals,company_agent_roles,
    agent_role_template_owners TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_company_authority(uuid,text),cauce_lock_owner_guard(text) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_lock_owner_guard(text),cauce_company_authority(uuid,text),
    cauce_company_owner_continuity(),cauce_console_users_owner_guard(),cauce_platform_record(text,text,text,uuid,uuid,jsonb),
    cauce_platform_assert_admin(uuid),cauce_platform_admins_journal(),cauce_platform_create_company(text,text,uuid),
    cauce_platform_set_company_state(text,text,uuid),cauce_platform_link(text,text,uuid),cauce_platform_unlink(text,text,uuid),
    cauce_platform_grant_admin(text,uuid,text,text,uuid),cauce_platform_revoke_admin(text,uuid,uuid),
    cauce_role_template_company_guard(),cauce_runtime_grants_054() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_054();
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_055);

CREATE FUNCTION cauce_register_company(p_email text,p_name text,p_hash text,p_company text,p_company_name text)
RETURNS TABLE(human_id uuid,tenant_id text,actor_alias text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  person uuid := gen_random_uuid();
  hub text := 'hub-'||replace(person::text,'-','');
BEGIN
  IF p_email IS NULL OR p_email<>lower(btrim(p_email)) OR char_length(p_email)>254
    OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    OR p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 120
    OR p_company IS NULL OR p_company !~ '^[a-z][a-z0-9_-]{0,63}$'
    OR p_company_name IS NULL OR char_length(btrim(p_company_name)) NOT BETWEEN 1 AND 80
    OR p_hash IS NULL OR p_hash !~ '^[$]scrypt[$]n=32768,r=8,p=1[$][A-Za-z0-9+/=]+[$][A-Za-z0-9+/=]+$' THEN
    RAISE EXCEPTION 'invalid registration' USING ERRCODE='22023';
  END IF;
  INSERT INTO companies(id,name) VALUES(p_company,btrim(p_company_name));
  INSERT INTO tenants(id,company_id,is_hub,display_name) VALUES(hub,p_company,true,btrim(p_company_name));
  INSERT INTO rooms(tenant_id,id) VALUES(hub,'office');
  INSERT INTO agents(tenant_id,alias,display_name,company_id) VALUES(hub,'owner',btrim(p_name),p_company);
  INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES(hub,'office','owner','operator');
  INSERT INTO console_users(id,email,email_normalized,display_name,password_hash,tenant_id,alias,role,company_id)
    VALUES(person,p_email,p_email,btrim(p_name),p_hash,hub,'owner','operator',p_company);
  INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,company_id)
    VALUES(person,hub,'owner','operator',ARRAY['route','read','control','notify'],p_company);
  INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
    VALUES(p_company,person,'owner','import',person);
  PERFORM cauce_platform_record('company.create',p_company,NULL,person,person,
    jsonb_build_object('origin','public_registration','name',btrim(p_company_name)));
  RETURN QUERY SELECT person,hub,'owner'::text;
END
$$;

CREATE FUNCTION cauce_require_company_owner(p_company text,p_human uuid)
RETURNS boolean LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE person record; platform boolean;
BEGIN
  SELECT u.* INTO person FROM console_users u WHERE u.id=p_human FOR SHARE;
  IF NOT FOUND OR NOT person.active OR person.role<>'operator' THEN
    RAISE EXCEPTION 'company owner authority required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM human_tenant_memberships h JOIN agents a
    ON a.tenant_id=h.tenant_id AND a.alias=h.actor_alias
    JOIN tenants t ON t.id=h.tenant_id JOIN memberships m ON m.tenant_id=h.tenant_id AND m.alias=h.actor_alias
    JOIN rooms r ON r.tenant_id=m.tenant_id AND r.id=m.room_id JOIN role_policies policy ON policy.role=m.role
    WHERE h.human_id=p_human AND h.tenant_id=person.tenant_id AND h.actor_alias=person.alias AND h.enabled
      AND h.revoked_at IS NULL AND h.role='operator' AND 'control'=ANY(h.permissions)
      AND a.retired_at IS NULL AND a.purged_at IS NULL AND t.enabled AND t.retired_at IS NULL AND t.purged_at IS NULL AND m.enabled
      AND m.retired_at IS NULL AND r.enabled AND r.retired_at IS NULL AND r.purged_at IS NULL AND policy.allow_control
    FOR SHARE OF h,a,t,m,r,policy) THEN
    RAISE EXCEPTION 'company owner membership required' USING ERRCODE='42501';
  END IF;
  platform := EXISTS (SELECT 1 FROM platform_admins a WHERE a.human_id=p_human FOR SHARE);
  IF NOT platform AND (person.company_id<>p_company OR NOT EXISTS
    (SELECT 1 FROM company_admins a WHERE a.company_id=p_company AND a.human_id=p_human AND a.role='owner' FOR SHARE)) THEN
    RAISE EXCEPTION 'company owner authority required' USING ERRCODE='42501';
  END IF;
  RETURN platform;
END
$$;

CREATE FUNCTION cauce_update_company(p_company text,p_human uuid,p_version bigint,p_name text,p_state text)
RETURNS TABLE(id text,name text,state text,version bigint) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  company record;
  platform boolean;
BEGIN
  platform := cauce_require_company_owner(p_company,p_human);
  SELECT c.* INTO company FROM companies c WHERE c.id=p_company FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company unavailable' USING ERRCODE='P0002'; END IF;
  IF NOT platform AND (NOT company.enabled OR company.retired_at IS NOT NULL) THEN
    RAISE EXCEPTION 'company unavailable' USING ERRCODE='42501';
  END IF;
  IF company.version<>p_version THEN RAISE EXCEPTION 'company version changed' USING ERRCODE='40001'; END IF;
  IF (p_name IS NOT NULL AND char_length(btrim(p_name)) NOT BETWEEN 1 AND 80)
    OR (p_state IS NOT NULL AND p_state NOT IN ('enabled','disabled','retired')) THEN
    RAISE EXCEPTION 'invalid company update' USING ERRCODE='22023';
  END IF;
  UPDATE companies c SET name=COALESCE(btrim(p_name),c.name),enabled=COALESCE(p_state='enabled',c.enabled),
    retired_at=CASE WHEN p_state='retired' THEN COALESCE(c.retired_at,now()) WHEN p_state IS NULL THEN c.retired_at END,
    version=c.version+1,updated_at=now() WHERE c.id=p_company;
  PERFORM cauce_platform_record('company.state',p_company,NULL,NULL,p_human,
    jsonb_build_object('name',COALESCE(btrim(p_name),company.name),'state',COALESCE(p_state,'unchanged')));
  RETURN QUERY SELECT c.id,c.name,CASE WHEN c.retired_at IS NOT NULL THEN 'retired' WHEN c.enabled THEN 'enabled' ELSE 'disabled' END,
    c.version FROM companies c WHERE c.id=p_company;
END
$$;

ALTER TABLE company_admins ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version>0);
CREATE TABLE company_admin_versions (
  company_id text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  human_id uuid NOT NULL REFERENCES console_users(id) ON DELETE RESTRICT,
  version bigint NOT NULL CHECK (version>0),
  PRIMARY KEY(company_id,human_id)
);
INSERT INTO company_admin_versions(company_id,human_id,version)
  SELECT company_id,human_id,version FROM company_admins;
CREATE FUNCTION cauce_assert_qualified_company_owner(p_company text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_admins owner JOIN console_users u ON u.id=owner.human_id
    JOIN human_tenant_memberships h ON h.human_id=u.id AND h.tenant_id=u.tenant_id
    JOIN tenants t ON t.id=h.tenant_id AND t.company_id=owner.company_id
    JOIN agents a ON a.tenant_id=h.tenant_id AND a.alias=h.actor_alias
    JOIN memberships m ON m.tenant_id=h.tenant_id AND m.alias=h.actor_alias
    JOIN rooms r ON r.tenant_id=m.tenant_id AND r.id=m.room_id JOIN role_policies policy ON policy.role=m.role
    WHERE owner.company_id=p_company AND owner.role='owner' AND u.active AND u.role='operator'
      AND h.enabled AND h.revoked_at IS NULL AND h.actor_alias=u.alias AND h.role='operator' AND 'control'=ANY(h.permissions)
      AND a.retired_at IS NULL AND a.purged_at IS NULL AND m.enabled AND m.retired_at IS NULL AND policy.allow_control
      AND r.enabled AND r.retired_at IS NULL AND r.purged_at IS NULL AND t.enabled AND t.retired_at IS NULL AND t.purged_at IS NULL
    FOR SHARE OF u,h,t,a,m,r,policy) THEN
    RAISE EXCEPTION 'company must retain a qualified owner' USING ERRCODE='23514';
  END IF;
END
$$;
CREATE FUNCTION cauce_set_company_admin(p_company text,p_actor uuid,p_subject uuid,p_role text,p_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE platform boolean; previous record; next_version bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(783003055,hashtext(p_company));
  platform := cauce_require_company_owner(p_company,p_actor);
  PERFORM 1 FROM companies c WHERE c.id=p_company AND (platform OR (c.enabled AND c.retired_at IS NULL)) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'company unavailable' USING ERRCODE='P0002'; END IF;
  IF p_actor=p_subject OR (p_role='owner' AND NOT platform) OR (p_role IS NOT NULL AND p_role NOT IN ('owner','admin')) THEN
    RAISE EXCEPTION 'company administrator grant unavailable' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM console_users u WHERE u.id=p_subject AND u.company_id=p_company FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'person unavailable' USING ERRCODE='P0002'; END IF;
  SELECT a.* INTO previous FROM company_admins a WHERE a.company_id=p_company AND a.human_id=p_subject FOR UPDATE;
  IF COALESCE(previous.version,0)<>p_version THEN RAISE EXCEPTION 'administrator version changed' USING ERRCODE='40001'; END IF;
  IF NOT platform AND (previous.role='owner' OR EXISTS (SELECT 1 FROM platform_admins a WHERE a.human_id=p_subject)) THEN
    RAISE EXCEPTION 'company administrator grant unavailable' USING ERRCODE='42501';
  END IF;
  IF p_role IS NULL THEN
    DELETE FROM company_admins a WHERE a.company_id=p_company AND a.human_id=p_subject;
    IF NOT FOUND THEN RAISE EXCEPTION 'administrator unavailable' USING ERRCODE='P0002'; END IF;
    PERFORM cauce_assert_qualified_company_owner(p_company);
    INSERT INTO company_admin_versions(company_id,human_id,version) VALUES(p_company,p_subject,p_version+1)
      ON CONFLICT(company_id,human_id) DO UPDATE SET version=GREATEST(company_admin_versions.version,EXCLUDED.version);
    PERFORM cauce_platform_record('admin.revoke',p_company,NULL,p_subject,p_actor,jsonb_build_object('previous_role',previous.role));
    RETURN p_version+1;
  END IF;
  SELECT GREATEST(COALESCE(previous.version,0),COALESCE((SELECT v.version FROM company_admin_versions v
    WHERE v.company_id=p_company AND v.human_id=p_subject),0))+1 INTO next_version;
  IF NOT EXISTS (SELECT 1 FROM console_users u JOIN human_tenant_memberships h ON h.human_id=u.id AND h.tenant_id=u.tenant_id
    JOIN agents a ON a.tenant_id=h.tenant_id AND a.alias=h.actor_alias
    JOIN memberships m ON m.tenant_id=h.tenant_id AND m.alias=h.actor_alias
    JOIN rooms r ON r.tenant_id=m.tenant_id AND r.id=m.room_id JOIN role_policies policy ON policy.role=m.role
    JOIN tenants t ON t.id=h.tenant_id WHERE u.id=p_subject AND u.active AND u.role='operator'
      AND h.enabled AND h.revoked_at IS NULL AND h.actor_alias=u.alias AND h.role='operator' AND 'control'=ANY(h.permissions)
      AND a.retired_at IS NULL AND a.purged_at IS NULL AND m.enabled AND m.retired_at IS NULL AND r.enabled AND r.retired_at IS NULL AND r.purged_at IS NULL
      AND t.enabled AND t.retired_at IS NULL AND t.purged_at IS NULL AND policy.allow_control FOR SHARE OF u,h,a,m,r,t,policy) THEN
    RAISE EXCEPTION 'administrator needs qualified membership' USING ERRCODE='42501';
  END IF;
  INSERT INTO company_admins(company_id,human_id,role,source,granted_by,version)
    VALUES(p_company,p_subject,p_role,'platform',p_actor,next_version)
    ON CONFLICT(company_id,human_id) DO UPDATE SET role=EXCLUDED.role,granted_by=EXCLUDED.granted_by,
      source=EXCLUDED.source,version=EXCLUDED.version RETURNING version INTO next_version;
  PERFORM cauce_assert_qualified_company_owner(p_company);
  INSERT INTO company_admin_versions(company_id,human_id,version) VALUES(p_company,p_subject,next_version)
    ON CONFLICT(company_id,human_id) DO UPDATE SET version=EXCLUDED.version;
  PERFORM cauce_platform_record('admin.grant',p_company,NULL,p_subject,p_actor,jsonb_build_object('role',p_role,'version',next_version));
  RETURN next_version;
END
$$;

CREATE FUNCTION cauce_runtime_grants_055()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_register_company(text,text,text,text,text),
    cauce_update_company(text,uuid,bigint,text,text),cauce_require_company_owner(text,uuid),
    cauce_assert_qualified_company_owner(text),cauce_set_company_admin(text,uuid,uuid,text,bigint),cauce_runtime_grants_055() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_register_company(text,text,text,text,text),
    cauce_update_company(text,uuid,bigint,text,text),cauce_set_company_admin(text,uuid,uuid,text,bigint) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_055() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_055();

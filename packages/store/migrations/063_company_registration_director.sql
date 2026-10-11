SELECT pg_advisory_xact_lock(783_003_063);
ALTER TABLE company_system_principals ADD COLUMN delivery_source_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT company_system_principals_source_only CHECK (NOT delivery_source_only OR kind='director');
INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
  VALUES('context_broker',true,false,false,false) ON CONFLICT DO NOTHING;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM role_policies WHERE role='context_broker'
    AND ROW(allow_route,allow_read,allow_control,allow_notify) IS DISTINCT FROM ROW(true,false,false,false)) THEN
    RAISE EXCEPTION 'context broker requires route-only permissions' USING ERRCODE='23514';
  END IF;
END
$$;

CREATE FUNCTION cauce_register_company_director(p_company text,p_tenant text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE source_room text; candidate text := 'context-director'; created text; suffix bigint := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('company-context-director:'||p_company,0));
  IF EXISTS (SELECT 1 FROM public.company_system_principals WHERE company_id=p_company AND kind='director') THEN RETURN; END IF;
  SELECT room.id INTO source_room FROM public.rooms room JOIN public.tenants tenant ON tenant.id=room.tenant_id
    JOIN public.companies company ON company.id=tenant.company_id WHERE tenant.id=p_tenant AND tenant.company_id=p_company
      AND tenant.is_hub AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND company.enabled AND company.retired_at IS NULL AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
    ORDER BY (room.id='office') DESC,room.id LIMIT 1 FOR SHARE OF room,tenant,company;
  IF source_room IS NULL THEN RAISE EXCEPTION 'company context source is unavailable' USING ERRCODE='22023'; END IF;
  LOOP
    INSERT INTO public.agents(tenant_id,alias,display_name,company_id,enabled,lifecycle_state)
      VALUES(p_tenant,candidate,'Company context broker',p_company,false,'draft') ON CONFLICT DO NOTHING RETURNING alias INTO created;
    EXIT WHEN created IS NOT NULL;
    suffix := suffix+1; candidate := 'context-director-'||suffix::text;
  END LOOP;
  INSERT INTO public.memberships(tenant_id,room_id,alias,role) VALUES(p_tenant,source_room,created,'context_broker');
  INSERT INTO public.company_system_principals(company_id,kind,tenant_id,principal_alias,delivery_source_only)
    VALUES(p_company,'director',p_tenant,created,true);
END
$$;

ALTER FUNCTION cauce_register_company(text,text,text,text,text) RENAME TO cauce_register_company_without_director;
CREATE FUNCTION cauce_register_company(p_email text,p_name text,p_hash text,p_company text,p_company_name text)
RETURNS TABLE(human_id uuid,tenant_id text,actor_alias text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE registered record;
BEGIN
  SELECT * INTO registered FROM public.cauce_register_company_without_director(p_email,p_name,p_hash,p_company,p_company_name);
  PERFORM public.cauce_register_company_director(p_company,registered.tenant_id);
  RETURN QUERY SELECT registered.human_id,registered.tenant_id,registered.actor_alias;
END
$$;

CREATE FUNCTION cauce_context_director_mutation_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NOT pg_has_role(current_user,'cauce_platform','MEMBER') AND EXISTS (
    SELECT 1 FROM public.company_system_principals principal WHERE principal.delivery_source_only
      AND ((TG_OP<>'DELETE' AND principal.tenant_id=NEW.tenant_id AND principal.principal_alias=NEW.alias)
        OR (TG_OP<>'INSERT' AND principal.tenant_id=OLD.tenant_id AND principal.principal_alias=OLD.alias))) THEN
    RAISE EXCEPTION 'company context source requires platform authority' USING ERRCODE='42501';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER agents_context_director_guard BEFORE UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_context_director_mutation_guard();
CREATE TRIGGER memberships_context_director_guard BEFORE INSERT OR UPDATE OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION cauce_context_director_mutation_guard();

CREATE FUNCTION cauce_context_director_recipient_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_tenant text; target_alias text;
BEGIN
  IF TG_TABLE_NAME='deliveries' THEN target_tenant := NEW.recipient_tenant; target_alias := NEW.recipient_alias;
  ELSE target_tenant := NEW.tenant_id; target_alias := NEW.alias; END IF;
  IF EXISTS (SELECT 1 FROM public.company_system_principals principal WHERE principal.delivery_source_only
    AND principal.tenant_id=target_tenant AND principal.principal_alias=target_alias) THEN
    RAISE EXCEPTION 'company context source cannot consume deliveries' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER deliveries_context_director_guard BEFORE INSERT OR UPDATE OF recipient_tenant,recipient_alias ON deliveries
  FOR EACH ROW EXECUTE FUNCTION cauce_context_director_recipient_guard();
CREATE TRIGGER connection_leases_context_director_guard BEFORE INSERT OR UPDATE OF tenant_id,alias ON connection_leases
  FOR EACH ROW EXECUTE FUNCTION cauce_context_director_recipient_guard();

DO $$
DECLARE company record;
BEGIN
  FOR company IN SELECT owner.id,(SELECT tenant.id FROM tenants tenant JOIN rooms room ON room.tenant_id=tenant.id
    WHERE tenant.company_id=owner.id AND tenant.is_hub AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL ORDER BY tenant.id,room.id LIMIT 1) AS tenant_id
    FROM companies owner WHERE owner.enabled AND owner.retired_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM company_system_principals principal WHERE principal.company_id=owner.id AND principal.kind='director')
    ORDER BY owner.id LOOP
    PERFORM cauce_register_company_director(company.id,company.tenant_id);
  END LOOP;
END
$$;

CREATE FUNCTION cauce_runtime_grants_063()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_register_company_without_director(text,text,text,text,text),cauce_register_company_director(text,text)
    FROM PUBLIC,cauce_runtime,cauce_observer;
  REVOKE ALL ON FUNCTION cauce_register_company(text,text,text,text,text),cauce_context_director_mutation_guard(),
    cauce_context_director_recipient_guard(),cauce_runtime_grants_063() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_register_company(text,text,text,text,text) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_register_company_director(text,text),cauce_runtime_grants_063() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_063();

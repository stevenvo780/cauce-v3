SELECT pg_advisory_xact_lock(783_003_064);

CREATE FUNCTION cauce_ensure_context_director_anchor(p_company text,p_tenant text,p_alias text,p_version bigint,p_digest text)
RETURNS TABLE(tenant_id text,alias text,room_id text) LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE target_enabled boolean; source_tenant text; source_alias text; source_room text; candidate text; suffix bigint := 0;
BEGIN
  IF p_version IS NULL OR p_version<=0 OR p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023';
  END IF;
  SELECT target.enabled INTO target_enabled FROM public.agents target JOIN public.tenants tenant ON tenant.id=target.tenant_id
    JOIN public.companies company ON company.id=tenant.company_id
    WHERE target.tenant_id=p_tenant AND target.alias=p_alias AND target.company_id=p_company AND tenant.company_id=p_company
      AND target.retired_at IS NULL AND target.purged_at IS NULL
      AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
      AND EXISTS(SELECT 1 FROM public.memberships member JOIN public.rooms room
        ON room.tenant_id=member.tenant_id AND room.id=member.room_id
        WHERE member.tenant_id=target.tenant_id AND member.alias=target.alias AND member.enabled AND member.retired_at IS NULL
          AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL)
      AND company.enabled AND company.retired_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM public.company_system_principals principal WHERE principal.delivery_source_only
          AND principal.tenant_id=target.tenant_id AND principal.principal_alias=target.alias)
    FOR SHARE OF target,tenant,company;
  IF NOT FOUND THEN RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023'; END IF;
  IF NOT target_enabled THEN
    PERFORM 1 FROM public.console_users human JOIN public.human_tenant_memberships identity
      ON identity.human_id=human.id AND identity.tenant_id=human.tenant_id AND identity.actor_alias=human.alias
    JOIN public.memberships member ON member.tenant_id=identity.tenant_id AND member.alias=identity.actor_alias AND member.role=identity.role
    JOIN public.rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
    JOIN public.role_policies policy ON policy.role=member.role
    WHERE human.tenant_id=p_tenant AND human.alias=p_alias AND human.company_id=p_company AND human.active
      AND identity.company_id=p_company AND identity.enabled AND identity.revoked_at IS NULL AND identity.role=human.role
      AND member.enabled AND member.retired_at IS NULL AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
      AND (('read'=ANY(identity.permissions) AND policy.allow_read) OR ('control'=ANY(identity.permissions) AND policy.allow_control))
    FOR SHARE OF human,identity,member,room,policy;
    IF NOT FOUND THEN RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(format('context-version:[%s,%s,%s]',
    to_json(p_company),to_json(p_tenant),to_json(p_alias)),0));
  PERFORM 1 FROM public.agent_context_versions version JOIN public.agent_context_state desired
    USING(company_id,tenant_id,alias) JOIN public.agent_context_outbox outbox USING(company_id,tenant_id,alias,version)
    WHERE version.company_id=p_company AND version.tenant_id=p_tenant AND version.alias=p_alias
      AND version.version=p_version AND version.digest=p_digest AND desired.desired_version=p_version
      AND outbox.applied_at IS NULL FOR SHARE OF version,desired,outbox;
  IF NOT FOUND THEN RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('company-context-director:'||p_company,0));
  IF (SELECT count(*) FROM public.company_system_principals principal
    WHERE principal.company_id=p_company AND principal.kind='director' AND principal.delivery_source_only)<>1 THEN
    RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023';
  END IF;
  SELECT principal.tenant_id,principal.principal_alias INTO source_tenant,source_alias
    FROM public.company_system_principals principal JOIN public.tenants source
      ON source.id=principal.tenant_id AND source.company_id=principal.company_id
    JOIN public.agents actor ON actor.tenant_id=principal.tenant_id AND actor.alias=principal.principal_alias
      AND actor.company_id=principal.company_id
    WHERE principal.company_id=p_company AND principal.kind='director' AND principal.delivery_source_only
      AND source.enabled AND source.retired_at IS NULL AND source.purged_at IS NULL
      AND NOT actor.enabled AND actor.retired_at IS NULL AND actor.purged_at IS NULL
      AND actor.runtime_key IS NULL AND actor.harness_id IS NULL AND actor.host_id IS NULL AND actor.runtime_mode IS NULL
      AND actor.container_name IS NULL AND actor.runtime_user IS NULL AND actor.home_directory IS NULL
      AND actor.state_directory IS NULL AND actor.systemd_user IS NULL AND actor.primary_account_id IS NULL
    FOR SHARE OF principal,source,actor;
  IF NOT FOUND THEN RAISE EXCEPTION 'company context source scope is unavailable' USING ERRCODE='22023'; END IF;
  PERFORM 1 FROM public.role_policies policy WHERE policy.role='context_broker'
    AND ROW(policy.allow_route,policy.allow_read,policy.allow_control,policy.allow_notify)=ROW(true,false,false,false) FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'context broker requires route-only permissions' USING ERRCODE='23514'; END IF;
  SELECT room.id INTO source_room FROM public.rooms room
    WHERE room.tenant_id=source_tenant AND room.company_id=p_company AND room.enabled
      AND room.retired_at IS NULL AND room.purged_at IS NULL
    ORDER BY EXISTS(SELECT 1 FROM public.memberships member WHERE member.tenant_id=source_tenant
        AND member.room_id=room.id AND member.alias<>source_alias AND member.enabled AND member.retired_at IS NULL) DESC,
      EXISTS(SELECT 1 FROM public.memberships member WHERE member.tenant_id=source_tenant AND member.room_id=room.id
        AND member.alias=source_alias AND member.enabled AND member.retired_at IS NULL AND member.role='context_broker') DESC,
      (room.id='office') DESC,room.id LIMIT 1 FOR SHARE OF room;
  IF source_room IS NULL THEN
    LOOP
      candidate := CASE WHEN suffix=0 THEN 'context-anchor' ELSE 'context-anchor-'||suffix::text END;
      INSERT INTO public.rooms(tenant_id,id,company_id,display_name)
        VALUES(source_tenant,candidate,p_company,'Internal context anchor') ON CONFLICT DO NOTHING RETURNING id INTO source_room;
      EXIT WHEN source_room IS NOT NULL;
      suffix := suffix+1;
    END LOOP;
  END IF;
  INSERT INTO public.memberships AS member(tenant_id,room_id,alias,role,enabled)
    VALUES(source_tenant,source_room,source_alias,'context_broker',true) ON CONFLICT ON CONSTRAINT memberships_pkey
    DO UPDATE SET role='context_broker',enabled=true,retired_at=NULL,retired_enabled=NULL
      WHERE member.role<>'context_broker' OR NOT member.enabled OR member.retired_at IS NOT NULL OR member.retired_enabled IS NOT NULL;
  RETURN QUERY SELECT source_tenant,source_alias,source_room;
END
$$;
REVOKE ALL ON FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text) FROM PUBLIC,cauce_runtime,cauce_observer;
GRANT EXECUTE ON FUNCTION cauce_ensure_context_director_anchor(text,text,text,bigint,text) TO cauce_runtime,cauce_platform;

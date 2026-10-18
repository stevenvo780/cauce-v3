SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_082);

CREATE FUNCTION cauce_company_purge_data(p_company text,p_admin uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  relation record; dependency record; column_name text; predicate text; join_sql text;
  locations jsonb := '{}'::jsonb; scoped text[] := '{}'; found_rows jsonb; previous jsonb;
  records jsonb := '{}'::jsonb; blockers jsonb := '[]'::jsonb; changed boolean; count_rows bigint;
  tenant_ids text[];
BEGIN
  IF current_setting('transaction_isolation')<>'read committed' THEN
    RAISE EXCEPTION 'company purge requires read committed isolation' USING ERRCODE='40001';
  END IF;
  IF NOT public.cauce_require_company_owner(p_company,p_admin) OR NOT EXISTS (
    SELECT 1 FROM public.console_users person JOIN public.companies home ON home.id=person.company_id
      WHERE person.id=p_admin AND home.enabled AND home.retired_at IS NULL AND home.id<>p_company
  ) THEN RAISE EXCEPTION 'an active platform administrator is required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(783_003_004);
  -- The filesystem backup and deletion see one stable graph, including incoming cross-company references.
  FOR relation IN SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.oid LOOP
    EXECUTE format('LOCK TABLE public.%I IN SHARE ROW EXCLUSIVE MODE',relation.relname);
  END LOOP;
  PERFORM 1 FROM public.companies WHERE id=p_company AND retired_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS(SELECT 1 FROM public.companies WHERE id=p_company) THEN
      RAISE EXCEPTION 'company must be retired before purge' USING ERRCODE='55000';
    END IF;
    RAISE EXCEPTION 'company does not exist' USING ERRCODE='P0002';
  END IF;
  SELECT array_agg(id) INTO tenant_ids FROM public.tenants WHERE company_id=p_company;
  tenant_ids := COALESCE(tenant_ids,'{}');
  SELECT COALESCE(jsonb_agg(item),'[]'::jsonb) INTO blockers FROM (
    SELECT jsonb_build_object('kind','agent','id',tenant_id||'/'||alias,'tenant_id',tenant_id,'alias',alias,
      'host_id',host_id,'container_name',container_name,'runtime_key',runtime_key) AS item
      FROM public.agents WHERE company_id=p_company AND purged_at IS NULL
        AND (container_name IS NOT NULL OR host_id IS NOT NULL OR runtime_mode IS NOT NULL OR runtime_key IS NOT NULL)
    UNION ALL SELECT jsonb_build_object('kind','quota_environment','id',id,'container_name',container_name,'status',status)
      FROM public.quota_environments WHERE company_id=p_company AND status<>'deleted'
    UNION ALL SELECT jsonb_build_object('kind','fleet_operation','id',id,'status',status)
      FROM public.fleet_operations WHERE company_id=p_company AND status IN ('queued','running','awaiting_auth','cancelling')
    UNION ALL SELECT jsonb_build_object('kind','quota_operation','id',id,'status',status)
      FROM public.quota_environment_operations WHERE company_id=p_company AND status IN ('pending','running','awaiting_auth')
    UNION ALL SELECT jsonb_build_object('kind','agent_quota_operation','id',id,'status',status)
      FROM public.agent_quota_operations WHERE company_id=p_company AND status IN ('pending','running','awaiting_auth')
    UNION ALL SELECT jsonb_build_object('kind','connection','id',tenant_id||'/'||alias)
      FROM public.connection_leases WHERE tenant_id=ANY(tenant_ids) AND lease_until>clock_timestamp()
    UNION ALL SELECT jsonb_build_object('kind','space_backup','id',id,'status',status)
      FROM public.space_backups WHERE company_id=p_company AND status IN ('pending','running')
  ) physical;

  FOR relation IN SELECT c.oid,c.relname,array_agg(a.attname::text ORDER BY a.attnum) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.oid,c.relname ORDER BY c.oid LOOP
    predicate := NULL;
    IF relation.relname='companies' THEN predicate := 'entry.id=$1';
    ELSIF relation.relname='company_links' THEN predicate := 'entry.company_a=$1 OR entry.company_b=$1';
    ELSIF relation.relname='acl_edges' THEN predicate := 'entry.from_tenant=ANY($2) OR entry.to_tenant=ANY($2)';
    ELSIF relation.relname='agent_role_templates' THEN
      predicate := 'entry.slug IN (SELECT slug FROM public.agent_role_template_owners WHERE company_id=$1)';
    ELSIF relation.relname='audit_events' THEN
      predicate := 'entry.company_id=$1 OR (entry.company_id IS NULL AND entry.tenant_id=ANY($2))';
    ELSIF 'company_id'=ANY(relation.columns) THEN predicate := 'entry.company_id=$1';
    ELSE
      SELECT candidate INTO column_name FROM unnest(ARRAY['tenant_id','recipient_tenant','source_tenant','from_tenant',
        'collector_tenant','actor_tenant','owner_tenant_id','message_tenant_id','initiating_tenant_id',
        'parent_tenant','target_tenant','target_tenant_id','source_tenant_id','child_tenant','to_tenant'])
        WITH ORDINALITY ordered(candidate,position) WHERE candidate=ANY(relation.columns) ORDER BY position LIMIT 1;
      IF column_name IS NOT NULL THEN predicate := format('entry.%I=ANY($2)',column_name); END IF;
    END IF;
    IF predicate IS NULL THEN CONTINUE; END IF;
    scoped := array_append(scoped,relation.oid::text);
    EXECUTE format('SELECT COALESCE(jsonb_agg(entry.ctid::text ORDER BY entry.ctid),''[]''::jsonb)
      FROM public.%I entry WHERE (%s) AND $1::text IS NOT NULL AND $2::text[] IS NOT NULL',relation.relname,predicate)
      INTO found_rows USING p_company,tenant_ids;
    locations := jsonb_set(locations,ARRAY[relation.oid::text],found_rows);
  END LOOP;

  -- Tables without ownership columns inherit only from their foreign-key parents.
  LOOP
    changed := false;
    FOR dependency IN SELECT fk.oid,fk.conrelid,fk.confrelid,child.relname AS child_name,parent.relname AS parent_name
      FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
      WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
        AND NOT fk.conrelid::text=ANY(scoped) ORDER BY fk.oid LOOP
      IF COALESCE(jsonb_array_length(locations->dependency.confrelid::text),0)=0 THEN CONTINUE; END IF;
      SELECT string_agg(format('child.%I=parent.%I',child.attname,parent.attname),' AND ' ORDER BY pair.position)
        INTO join_sql FROM pg_constraint fk CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey)
          WITH ORDINALITY pair(child_key,parent_key,position)
        JOIN pg_attribute child ON child.attrelid=fk.conrelid AND child.attnum=pair.child_key
        JOIN pg_attribute parent ON parent.attrelid=fk.confrelid AND parent.attnum=pair.parent_key WHERE fk.oid=dependency.oid;
      previous := COALESCE(locations->dependency.conrelid::text,'[]'::jsonb);
      EXECUTE format('SELECT COALESCE(jsonb_agg(DISTINCT child.ctid::text ORDER BY child.ctid::text),''[]''::jsonb)
        FROM public.%I child WHERE child.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($1)))
          OR EXISTS(SELECT 1 FROM public.%I parent WHERE (%s)
            AND parent.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($2))))',
        dependency.child_name,dependency.parent_name,join_sql)
        INTO found_rows USING previous,locations->dependency.confrelid::text;
      IF found_rows<>previous THEN
        locations := jsonb_set(locations,ARRAY[dependency.conrelid::text],found_rows); changed := true;
      END IF;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  FOR dependency IN SELECT fk.oid,fk.conname,fk.conrelid,fk.confrelid,child.relname AS child_name,parent.relname AS parent_name
    FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_class parent ON parent.oid=fk.confrelid
    WHERE fk.contype='f' AND child.relnamespace='public'::regnamespace AND parent.relnamespace='public'::regnamespace
    ORDER BY fk.oid LOOP
    IF COALESCE(jsonb_array_length(locations->dependency.confrelid::text),0)=0 THEN CONTINUE; END IF;
    SELECT string_agg(format('child.%I=parent.%I',child.attname,parent.attname),' AND ' ORDER BY pair.position)
      INTO join_sql FROM pg_constraint fk CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey)
        WITH ORDINALITY pair(child_key,parent_key,position)
      JOIN pg_attribute child ON child.attrelid=fk.conrelid AND child.attnum=pair.child_key
      JOIN pg_attribute parent ON parent.attrelid=fk.confrelid AND parent.attnum=pair.parent_key WHERE fk.oid=dependency.oid;
    EXECUTE format('SELECT count(*) FROM public.%I child WHERE
      NOT child.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($1)))
      AND EXISTS(SELECT 1 FROM public.%I parent WHERE (%s)
        AND parent.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($2))))',
      dependency.child_name,dependency.parent_name,join_sql)
      INTO count_rows USING COALESCE(locations->dependency.conrelid::text,'[]'::jsonb),locations->dependency.confrelid::text;
    IF count_rows>0 THEN blockers := blockers||jsonb_build_array(jsonb_build_object('kind','foreign_reference',
      'id',dependency.conname,'table',dependency.child_name,'count',count_rows)); END IF;
  END LOOP;
  FOR relation IN SELECT c.oid,c.relname FROM pg_class c WHERE locations ? c.oid::text ORDER BY c.relname LOOP
    IF jsonb_array_length(locations->relation.oid::text)=0 THEN CONTINUE; END IF;
    EXECUTE format('SELECT jsonb_agg(to_jsonb(entry) ORDER BY entry.ctid) FROM public.%I entry
      WHERE entry.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($1)))',relation.relname)
      INTO found_rows USING locations->relation.oid::text;
    records := jsonb_set(records,ARRAY[relation.relname],found_rows);
  END LOOP;
  RETURN jsonb_build_object('snapshot',jsonb_build_object('format','cauce-company-purge','version',1,
    'company_id',p_company,'captured_at',transaction_timestamp(),'records',records),'locations',locations,'blockers',blockers);
END
$$;

CREATE FUNCTION cauce_prepare_company_purge(p_company text,p_admin uuid)
RETURNS TABLE(snapshot jsonb,snapshot_hash text,blockers jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prepared jsonb;
BEGIN
  prepared := public.cauce_company_purge_data(p_company,p_admin);
  snapshot := prepared->'snapshot'; blockers := prepared->'blockers';
  snapshot_hash := encode(public.digest(snapshot::text,'sha256'),'hex');
  RETURN NEXT;
END
$$;

CREATE FUNCTION cauce_purge_company(p_company text,p_admin uuid,p_confirmation text,p_backup text,p_snapshot_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE prepared jsonb; locations jsonb; relation record; guard record; dependency record; guards jsonb := '[]'::jsonb;
  deleted jsonb := '{}'::jsonb; deleted_count bigint; remaining integer; progressed boolean; refreshed jsonb;
  join_sql text; has_children boolean; blocked boolean;
BEGIN
  IF p_confirmation IS DISTINCT FROM p_company OR p_backup IS NULL OR btrim(p_backup)='' THEN
    RAISE EXCEPTION 'company confirmation and backup are required' USING ERRCODE='22023';
  END IF;
  prepared := public.cauce_company_purge_data(p_company,p_admin);
  IF jsonb_array_length(prepared->'blockers')>0 THEN
    RAISE EXCEPTION 'company still has physical resources or foreign references' USING ERRCODE='55000';
  END IF;
  IF p_snapshot_hash IS DISTINCT FROM encode(public.digest((prepared->'snapshot')::text,'sha256'),'hex') THEN
    RAISE EXCEPTION 'company backup snapshot changed' USING ERRCODE='40001';
  END IF;
  locations := prepared->'locations';
  FOR guard IN SELECT t.tgname,t.tgenabled,c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    WHERE NOT t.tgisinternal AND t.tgenabled<>'D' AND COALESCE(jsonb_array_length(locations->c.oid::text),0)>0
    ORDER BY c.oid,t.tgname LOOP
    guards := guards||jsonb_build_array(to_jsonb(guard));
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER %I',guard.relname,guard.tgname);
  END LOOP;
  -- Break the only cross-table ownership cycle after preserving the original values in the backup.
  UPDATE public.agents SET primary_room_id=NULL WHERE company_id=p_company AND primary_room_id IS NOT NULL;
  SELECT COALESCE(jsonb_agg(ctid::text ORDER BY ctid),'[]'::jsonb) INTO refreshed FROM public.agents WHERE company_id=p_company;
  locations := jsonb_set(locations,ARRAY['public.agents'::regclass::oid::text],refreshed);
  LOOP
    progressed := false; remaining := 0;
    FOR relation IN SELECT c.oid,c.relname FROM pg_class c WHERE COALESCE(jsonb_array_length(locations->c.oid::text),0)>0
      ORDER BY c.oid LOOP
      blocked := false;
      -- Delete children first even for SET NULL and CASCADE: both can change a saved row location.
      FOR dependency IN SELECT fk.oid,fk.conrelid,child.relname AS child_name FROM pg_constraint fk
        JOIN pg_class child ON child.oid=fk.conrelid WHERE fk.contype='f' AND fk.confrelid=relation.oid
          AND fk.conrelid<>fk.confrelid ORDER BY fk.oid LOOP
        SELECT string_agg(format('child.%I=parent.%I',child.attname,parent.attname),' AND ' ORDER BY pair.position)
          INTO join_sql FROM pg_constraint fk CROSS JOIN LATERAL unnest(fk.conkey,fk.confkey)
            WITH ORDINALITY pair(child_key,parent_key,position)
          JOIN pg_attribute child ON child.attrelid=fk.conrelid AND child.attnum=pair.child_key
          JOIN pg_attribute parent ON parent.attrelid=fk.confrelid AND parent.attnum=pair.parent_key WHERE fk.oid=dependency.oid;
        EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I child JOIN public.%I parent ON (%s)
          WHERE parent.ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($1))))',
          dependency.child_name,relation.relname,join_sql) INTO has_children USING locations->relation.oid::text;
        IF has_children THEN blocked := true; EXIT; END IF;
      END LOOP;
      IF blocked THEN remaining := remaining+1; CONTINUE; END IF;
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE ctid=ANY(ARRAY(SELECT value::tid FROM jsonb_array_elements_text($1)))',relation.relname)
          USING locations->relation.oid::text;
        GET DIAGNOSTICS deleted_count=ROW_COUNT;
        IF deleted_count<>jsonb_array_length(locations->relation.oid::text) THEN
          RAISE EXCEPTION 'company backup row locations changed' USING ERRCODE='40001';
        END IF;
        deleted := jsonb_set(deleted,ARRAY[relation.relname],to_jsonb(deleted_count));
        locations := jsonb_set(locations,ARRAY[relation.oid::text],'[]'::jsonb); progressed := true;
      EXCEPTION WHEN foreign_key_violation THEN remaining := remaining+1;
      END;
    END LOOP;
    EXIT WHEN remaining=0;
    IF NOT progressed THEN RAISE EXCEPTION 'company purge has an unresolved foreign-key cycle' USING ERRCODE='23503'; END IF;
  END LOOP;
  FOR guard IN SELECT * FROM jsonb_to_recordset(guards) AS restored(tgname text,tgenabled text,relname text) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE %s TRIGGER %I',guard.relname,
      CASE guard.tgenabled WHEN 'A' THEN 'ALWAYS' WHEN 'R' THEN 'REPLICA' ELSE '' END,guard.tgname);
  END LOOP;
  INSERT INTO public.audit_events(action,decision,actor_human_id,metadata)
    VALUES('platform.company.purge','allow',p_admin,jsonb_build_object('company_id',p_company,
      'backup_path',p_backup,'snapshot_sha256',p_snapshot_hash,'deleted_rows',deleted));
  RETURN deleted;
END
$$;

CREATE FUNCTION cauce_runtime_grants_082()
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  REVOKE ALL ON FUNCTION cauce_company_purge_data(text,uuid),cauce_prepare_company_purge(text,uuid),
    cauce_purge_company(text,uuid,text,text,text),cauce_runtime_grants_082() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION cauce_prepare_company_purge(text,uuid),cauce_purge_company(text,uuid,text,text,text) TO cauce_runtime;
  GRANT EXECUTE ON FUNCTION cauce_runtime_grants_082() TO cauce_platform;
END
$$;
SELECT cauce_runtime_grants_082();

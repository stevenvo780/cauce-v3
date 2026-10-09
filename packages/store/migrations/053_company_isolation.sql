SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_053);
-- Every lock is taken up front, tenants first and the rewritten tables before the guarded ones. One
-- statement takes them all: lock_timeout bounds each wait and statement_timeout the whole phase, so
-- neither a long reader nor a stream of short ones keeps tenants exclusively locked behind it.
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('cauce.migration_statement_timeout',current_setting('statement_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
SELECT set_config('statement_timeout','6s',true);
DO $$
BEGIN
  LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE agent_account_bindings,agents,alias_routing_ceiling,audit_events,config_revisions,console_agent_favorites,
    console_users,fleet_hosts,fleet_operations,human_tenant_memberships,memberships,messages,provider_accounts,
    quota_window_state,rooms IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE agent_failure_notices,agent_output_materializations,blob_delivery_grants,companies,company_links,
    platform_admins,quota_collections,quota_window_samples,secret_handoffs IN SHARE ROW EXCLUSIVE MODE;
END
$$;
SELECT set_config('statement_timeout',current_setting('cauce.migration_statement_timeout'),true);

-- Guards run as the writer, so every function pins its search path with pg_temp last: a temporary
-- table of the writer never shadows the tables or catalogs a guard reads.

-- Membership in cauce_platform is the only authority above a company. Before the role exists, only
-- a superuser qualifies.
CREATE FUNCTION cauce_platform_operator()
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF to_regrole('cauce_platform') IS NULL THEN
    RETURN EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper);
  END IF;
  RETURN pg_has_role(current_user,'cauce_platform','MEMBER');
END
$$;

CREATE FUNCTION cauce_fill_company()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT tenant.company_id INTO NEW.company_id FROM tenants tenant WHERE tenant.id=to_jsonb(NEW)->>TG_ARGV[0];
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION cauce_fill_company_from_human()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT person.company_id INTO NEW.company_id FROM console_users person WHERE person.id=NEW.human_id;
  END IF;
  RETURN NEW;
END
$$;

-- Company ownership never moves with UPDATE: a company is exported and imported. The emergency
-- hatch needs both the platform role and an explicit cauce.company_move='on' setting, and moves only
-- rows nothing references yet, such as an empty tenant: the composite foreign keys stay immediate.
CREATE FUNCTION cauce_company_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF current_setting('cauce.company_move',true)='on' AND cauce_platform_operator() THEN RETURN NEW; END IF;
  RAISE EXCEPTION '%.company_id is immutable',TG_TABLE_NAME
    USING ERRCODE='23514', TABLE=TG_TABLE_NAME, COLUMN='company_id', CONSTRAINT=TG_TABLE_NAME||'_company_immutable';
END
$$;

CREATE FUNCTION cauce_tenants_company_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM companies company WHERE company.id=NEW.company_id
    AND (NOT company.enabled OR company.retired_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'tenant company % is disabled or retired',NEW.company_id
      USING ERRCODE='23514', TABLE='tenants', CONSTRAINT='tenants_company_admission';
  END IF;
  RETURN NEW;
END
$$;

-- Unknown tenants are left to the foreign keys; history tables without one stay readable.
CREATE FUNCTION cauce_assert_company_reachable(p_left text, p_right text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  left_company text;
  right_company text;
BEGIN
  IF p_left IS NULL OR p_right IS NULL OR p_left=p_right THEN RETURN; END IF;
  SELECT tenant.company_id INTO left_company FROM tenants tenant WHERE tenant.id=p_left;
  SELECT tenant.company_id INTO right_company FROM tenants tenant WHERE tenant.id=p_right;
  IF left_company IS NULL OR right_company IS NULL OR left_company=right_company
    OR cauce_lock_company_link(left_company,right_company) THEN RETURN; END IF;
  RAISE EXCEPTION 'cross-company pair requires an explicit company link: % -> %',p_left,p_right
    USING ERRCODE='23514', CONSTRAINT='cauce_company_reachable';
END
$$;

-- Trigger arguments are tenant column pairs: (left, right[, left, right...]).
CREATE FUNCTION cauce_pair_company_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  candidate jsonb := to_jsonb(NEW);
  pair_start integer := 0;
BEGIN
  WHILE pair_start+1<TG_NARGS LOOP
    PERFORM cauce_assert_company_reachable(candidate->>TG_ARGV[pair_start],candidate->>TG_ARGV[pair_start+1]);
    pair_start := pair_start+2;
  END LOOP;
  RETURN NEW;
END
$$;

-- Reuses the company of an existing host so status upserts keep working with several companies.
CREATE FUNCTION cauce_fill_host_company()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT host.company_id INTO NEW.company_id FROM fleet_hosts host WHERE host.host_id=NEW.host_id;
  END IF;
  IF NEW.company_id IS NULL THEN
    IF (SELECT count(*) FROM companies)<>1 THEN
      RAISE EXCEPTION 'fleet host company is required once another company exists'
        USING ERRCODE='23502', TABLE='fleet_hosts', COLUMN='company_id';
    END IF;
    SELECT company.id INTO NEW.company_id FROM companies company;
  END IF;
  RETURN NEW;
END
$$;

-- V4.0 placed agents on approved hosts it never registered. While one company exists, the first
-- placement registers the host in it, as a controller report would; once there are several, only the
-- platform registers a host in its company and a placement on an unregistered one fails.
CREATE FUNCTION cauce_register_placed_host()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.host_id IS NULL OR (TG_OP='UPDATE' AND NEW.host_id IS NOT DISTINCT FROM OLD.host_id)
    OR (SELECT count(*) FROM companies)<>1 THEN RETURN NEW; END IF;
  INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES(NEW.host_id,NEW.host_id,NEW.company_id)
    ON CONFLICT (host_id) DO NOTHING;
  RETURN NEW;
END
$$;

-- The target company acts; the actor company is only a fallback for targets without a tenant.
CREATE FUNCTION cauce_fill_operation_company()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF NEW.company_id IS NULL THEN
    SELECT tenant.company_id INTO NEW.company_id FROM tenants tenant WHERE tenant.id=NEW.target->>'tenant_id';
  END IF;
  IF NEW.company_id IS NULL THEN
    SELECT tenant.company_id INTO NEW.company_id FROM tenants tenant WHERE tenant.id=NEW.actor_tenant;
  END IF;
  RETURN NEW;
END
$$;

-- Installation catalogs (harnesses, role and chain policies) are platform revisions; everything
-- else, including a batch that mixes both, belongs to a company.
CREATE FUNCTION cauce_config_revision_scope(p_operation jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public,pg_temp AS $$
SELECT CASE WHEN p_operation->>'resource' IN ('harness','role_policy','chain_policy')
  OR (p_operation->>'resource'='batch' AND jsonb_typeof(p_operation->'mutations')='array'
    AND jsonb_array_length(p_operation->'mutations')>0
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_operation->'mutations') mutation
      WHERE jsonb_typeof(mutation)<>'object' OR mutation->>'resource' IS NULL
        OR mutation->>'resource' NOT IN ('harness','role_policy','chain_policy')))
  THEN 'platform' ELSE 'company' END
$$;

-- The operation alone decides the scope. Another company needs a platform override, and an override
-- or a platform revision written outside the platform role needs an active platform administrator.
-- A rollback stays in the scope and company of the revision it reverts.
CREATE FUNCTION cauce_config_revision_company()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  actor_company text;
  derived text := cauce_config_revision_scope(NEW.operation);
BEGIN
  IF NEW.scope<>derived THEN
    RAISE EXCEPTION 'revision scope % contradicts its operation',NEW.scope
      USING ERRCODE='23514', TABLE='config_revisions', CONSTRAINT='config_revisions_scope_derived';
  END IF;
  NEW.scope := derived;
  SELECT tenant.company_id INTO actor_company FROM tenants tenant WHERE tenant.id=NEW.actor_tenant;
  IF NEW.scope='company' THEN NEW.company_id := COALESCE(NEW.company_id,actor_company); END IF;
  IF (NEW.scope='company' AND NEW.company_id IS DISTINCT FROM actor_company AND NOT NEW.platform_override)
    OR ((NEW.platform_override OR (NEW.scope='platform' AND NOT cauce_platform_operator()))
      AND NOT EXISTS (SELECT 1 FROM platform_admins admin JOIN console_users person ON person.id=admin.human_id
        WHERE admin.human_id=NEW.actor_human_id AND person.active AND person.role='operator')) THEN
    RAISE EXCEPTION 'a revision for another company or the platform requires an active platform administrator'
      USING ERRCODE='23514', TABLE='config_revisions', CONSTRAINT='config_revisions_platform_override';
  END IF;
  IF EXISTS (SELECT 1 FROM config_revisions reverted WHERE reverted.id=NEW.rolled_back_revision_id
    AND (reverted.scope<>NEW.scope OR reverted.company_id IS DISTINCT FROM NEW.company_id)) THEN
    RAISE EXCEPTION 'a rollback stays in the scope and company of revision %',NEW.rolled_back_revision_id
      USING ERRCODE='23514', TABLE='config_revisions', CONSTRAINT='config_revisions_rollback_scope';
  END IF;
  RETURN NEW;
END
$$;

CREATE FUNCTION cauce_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only',TG_TABLE_NAME
    USING ERRCODE='23514', TABLE=TG_TABLE_NAME, CONSTRAINT=TG_TABLE_NAME||'_append_only';
END
$$;

-- A sample has no company column: its account must belong to the company of its collector.
CREATE FUNCTION cauce_quota_company_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME='quota_window_samples' THEN
    IF NEW.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM quota_collections collection
      JOIN tenants collector ON collector.id=collection.collector_tenant
      JOIN provider_accounts account ON account.id=NEW.account_id
      WHERE collection.id=NEW.collection_id AND account.company_id<>collector.company_id) THEN
      RAISE EXCEPTION 'quota account % belongs to another company than its collector',NEW.account_id
        USING ERRCODE='23514', TABLE=TG_TABLE_NAME, CONSTRAINT='quota_account_company';
    END IF;
  ELSIF EXISTS (SELECT 1 FROM quota_window_samples sample
    JOIN provider_accounts account ON account.id=sample.account_id
    JOIN tenants collector ON collector.id=NEW.collector_tenant
    WHERE sample.collection_id=NEW.id AND account.company_id<>collector.company_id) THEN
    RAISE EXCEPTION 'quota collection % would collect accounts of another company',NEW.id
      USING ERRCODE='23514', TABLE=TG_TABLE_NAME, CONSTRAINT='quota_account_company';
  END IF;
  RETURN NEW;
END
$$;

ALTER TABLE tenants ADD CONSTRAINT tenants_id_company_key UNIQUE (id,company_id);
CREATE TRIGGER tenants_company_admission BEFORE INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION cauce_tenants_company_admission();
CREATE TRIGGER tenants_company_immutable BEFORE UPDATE ON tenants
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();

ALTER TABLE rooms ADD COLUMN company_id text;
ALTER TABLE console_users ADD COLUMN company_id text;
ALTER TABLE agents ADD COLUMN company_id text;
ALTER TABLE provider_accounts ADD COLUMN company_id text;
ALTER TABLE alias_routing_ceiling ADD COLUMN company_id text;
ALTER TABLE agent_account_bindings ADD COLUMN company_id text;
ALTER TABLE quota_window_state ADD COLUMN company_id text;
ALTER TABLE console_agent_favorites ADD COLUMN company_id text;
ALTER TABLE human_tenant_memberships ADD COLUMN company_id text;
ALTER TABLE fleet_hosts ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE fleet_operations ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT;
ALTER TABLE config_revisions ADD COLUMN scope text, ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT,
  ADD COLUMN actor_human_id uuid, ADD COLUMN platform_override boolean NOT NULL DEFAULT false;
ALTER TABLE audit_events ADD COLUMN company_id text REFERENCES companies(id) ON DELETE RESTRICT, ADD COLUMN actor_human_id uuid;

-- The backfill must not advance OAuth revisions, journal role briefs, reserve runtime keys or rewrite
-- template links. Only these named triggers pause; foreign keys keep checking every row.
ALTER TABLE human_tenant_memberships DISABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships DISABLE TRIGGER human_membership_preserved;
ALTER TABLE agents DISABLE TRIGGER agents_role_brief_journal;
ALTER TABLE agents DISABLE TRIGGER agent_runtime_key_reservation;
ALTER TABLE agents DISABLE TRIGGER agents_role_template_coherence;
ALTER TABLE fleet_operations DISABLE TRIGGER fleet_operations_history;
UPDATE rooms target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE console_users target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE agents target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE provider_accounts target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.payer_tenant_id;
UPDATE alias_routing_ceiling target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE agent_account_bindings target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE quota_window_state target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.collector_tenant;
UPDATE console_agent_favorites target SET company_id=tenant.company_id FROM tenants tenant WHERE tenant.id=target.tenant_id;
UPDATE human_tenant_memberships target SET company_id=person.company_id FROM console_users person WHERE person.id=target.human_id;
UPDATE fleet_operations target SET company_id=COALESCE(
  (SELECT tenant.company_id FROM tenants tenant WHERE tenant.id=target.target->>'tenant_id'),
  (SELECT tenant.company_id FROM tenants tenant WHERE tenant.id=target.actor_tenant));
UPDATE config_revisions target SET scope=cauce_config_revision_scope(target.operation);
UPDATE config_revisions target SET company_id=tenant.company_id FROM tenants tenant
  WHERE tenant.id=target.actor_tenant AND target.scope='company';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    WHERE agent.host_id IS NOT NULL GROUP BY agent.host_id HAVING count(DISTINCT tenant.company_id)>1) THEN
    RAISE EXCEPTION 'a fleet host carries agents of several companies' USING ERRCODE='23514';
  END IF;
END;
$$;
-- V4.0 also placed agents on approved hosts it never registered; they are registered now in the
-- company of their agents, so every placement satisfies the host foreign key.
INSERT INTO fleet_hosts(host_id,display_name,company_id)
SELECT agent.host_id,agent.host_id,min(tenant.company_id) FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
  WHERE agent.host_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM fleet_hosts host WHERE host.host_id=agent.host_id)
  GROUP BY agent.host_id;
UPDATE fleet_hosts host SET company_id=placed.company_id
  FROM (SELECT agent.host_id,min(tenant.company_id) AS company_id FROM agents agent
    JOIN tenants tenant ON tenant.id=agent.tenant_id WHERE agent.host_id IS NOT NULL GROUP BY agent.host_id) placed
  WHERE placed.host_id=host.host_id;
UPDATE fleet_hosts host SET company_id=(SELECT company.id FROM companies company)
  WHERE host.company_id IS NULL AND (SELECT count(*) FROM companies)=1;
ALTER TABLE human_tenant_memberships ENABLE TRIGGER cauce_oauth_membership_revision;
ALTER TABLE human_tenant_memberships ENABLE TRIGGER human_membership_preserved;
ALTER TABLE agents ENABLE TRIGGER agents_role_brief_journal;
ALTER TABLE agents ENABLE TRIGGER agent_runtime_key_reservation;
ALTER TABLE agents ENABLE TRIGGER agents_role_template_coherence;
ALTER TABLE fleet_operations ENABLE TRIGGER fleet_operations_history;

ALTER TABLE rooms ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT rooms_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id);
ALTER TABLE console_users ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT console_users_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT console_users_id_company_key UNIQUE (id,company_id);
ALTER TABLE provider_accounts ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT provider_accounts_company_fkey FOREIGN KEY (payer_tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT provider_accounts_id_company_key UNIQUE (id,company_id);
ALTER TABLE agents ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT agents_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT agents_primary_account_company_fkey FOREIGN KEY (primary_account_id,company_id)
    REFERENCES provider_accounts(id,company_id);
ALTER TABLE alias_routing_ceiling ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT alias_routing_ceiling_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT alias_routing_ceiling_account_company_fkey FOREIGN KEY (account_id,company_id)
    REFERENCES provider_accounts(id,company_id);
ALTER TABLE agent_account_bindings ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT agent_account_bindings_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT agent_account_bindings_account_company_fkey FOREIGN KEY (account_id,company_id)
    REFERENCES provider_accounts(id,company_id);
ALTER TABLE quota_window_state ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT quota_window_state_company_fkey FOREIGN KEY (collector_tenant,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT quota_window_state_account_company_fkey FOREIGN KEY (account_id,company_id)
    REFERENCES provider_accounts(id,company_id);
ALTER TABLE console_agent_favorites ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT console_agent_favorites_company_fkey FOREIGN KEY (tenant_id,company_id) REFERENCES tenants(id,company_id),
  ADD CONSTRAINT console_agent_favorites_human_company_fkey FOREIGN KEY (human_id,company_id)
    REFERENCES console_users(id,company_id) ON DELETE CASCADE;
-- One person, one company: a human membership stays inside the company of the person.
ALTER TABLE human_tenant_memberships ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT human_tenant_memberships_company_fkey FOREIGN KEY (tenant_id,company_id)
    REFERENCES tenants(id,company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT human_tenant_memberships_human_company_fkey FOREIGN KEY (human_id,company_id)
    REFERENCES console_users(id,company_id) ON DELETE RESTRICT;

-- Room ids are unique per company; messages bind their room to their own tenant.
ALTER TABLE messages ADD CONSTRAINT messages_room_id_tenant_id_fkey FOREIGN KEY (room_id,tenant_id)
  REFERENCES rooms(id,tenant_id) NOT VALID;
ALTER TABLE messages VALIDATE CONSTRAINT messages_room_id_tenant_id_fkey;
ALTER TABLE messages DROP CONSTRAINT messages_room_id_fkey;
ALTER TABLE memberships DROP CONSTRAINT memberships_room_id_fkey;
ALTER TABLE rooms DROP CONSTRAINT rooms_pkey;
ALTER TABLE rooms ADD CONSTRAINT rooms_pkey PRIMARY KEY (tenant_id,id),
  ADD CONSTRAINT rooms_company_id_id_key UNIQUE (company_id,id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM fleet_hosts WHERE company_id IS NULL) THEN
    RAISE EXCEPTION 'a fleet host without agents needs an explicit company once several companies exist'
      USING ERRCODE='23502';
  END IF;
END;
$$;
ALTER TABLE fleet_hosts ALTER COLUMN company_id SET NOT NULL,
  ADD CONSTRAINT fleet_hosts_host_company_key UNIQUE (host_id,company_id);
ALTER TABLE agents ADD CONSTRAINT agents_host_company_fkey FOREIGN KEY (host_id,company_id)
  REFERENCES fleet_hosts(host_id,company_id);

ALTER TABLE fleet_operations ALTER COLUMN company_id SET NOT NULL;
CREATE INDEX fleet_operations_company_idx ON fleet_operations(company_id,created_at);

ALTER TABLE config_revisions ALTER COLUMN scope SET NOT NULL,
  ADD CONSTRAINT config_revisions_scope_check CHECK (scope IN ('company','platform')),
  ADD CONSTRAINT config_revisions_scope_company CHECK ((scope='company')=(company_id IS NOT NULL));
CREATE INDEX config_revisions_company_idx ON config_revisions(company_id,id DESC);
CREATE INDEX config_revisions_platform_idx ON config_revisions(id DESC) WHERE scope='platform';

CREATE TRIGGER rooms_company_fill BEFORE INSERT ON rooms
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER console_users_company_fill BEFORE INSERT ON console_users
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER agents_company_fill BEFORE INSERT ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER provider_accounts_company_fill BEFORE INSERT ON provider_accounts
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('payer_tenant_id');
CREATE TRIGGER alias_routing_ceiling_company_fill BEFORE INSERT ON alias_routing_ceiling
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER agent_account_bindings_company_fill BEFORE INSERT ON agent_account_bindings
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER quota_window_state_company_fill BEFORE INSERT ON quota_window_state
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('collector_tenant');
CREATE TRIGGER console_agent_favorites_company_fill BEFORE INSERT ON console_agent_favorites
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company('tenant_id');
CREATE TRIGGER human_tenant_memberships_company_fill BEFORE INSERT ON human_tenant_memberships
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_company_from_human();
CREATE TRIGGER fleet_hosts_company_fill BEFORE INSERT ON fleet_hosts
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_host_company();
CREATE TRIGGER agents_host_registration BEFORE INSERT OR UPDATE OF host_id ON agents
  FOR EACH ROW EXECUTE FUNCTION cauce_register_placed_host();
CREATE TRIGGER fleet_operations_company_fill BEFORE INSERT ON fleet_operations
  FOR EACH ROW EXECUTE FUNCTION cauce_fill_operation_company();
CREATE TRIGGER config_revisions_company_fill BEFORE INSERT ON config_revisions
  FOR EACH ROW EXECUTE FUNCTION cauce_config_revision_company();
CREATE TRIGGER config_revisions_append_only BEFORE UPDATE OR DELETE ON config_revisions
  FOR EACH ROW EXECUTE FUNCTION cauce_append_only();
CREATE TRIGGER rooms_company_immutable BEFORE UPDATE ON rooms
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER console_users_company_immutable BEFORE UPDATE ON console_users
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER agents_company_immutable BEFORE UPDATE ON agents
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER provider_accounts_company_immutable BEFORE UPDATE ON provider_accounts
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER alias_routing_ceiling_company_immutable BEFORE UPDATE ON alias_routing_ceiling
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER agent_account_bindings_company_immutable BEFORE UPDATE ON agent_account_bindings
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER quota_window_state_company_immutable BEFORE UPDATE ON quota_window_state
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER console_agent_favorites_company_immutable BEFORE UPDATE ON console_agent_favorites
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER human_tenant_memberships_company_immutable BEFORE UPDATE ON human_tenant_memberships
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER fleet_hosts_company_immutable BEFORE UPDATE ON fleet_hosts
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();
CREATE TRIGGER fleet_operations_company_immutable BEFORE UPDATE ON fleet_operations
  FOR EACH ROW WHEN (NEW.company_id IS DISTINCT FROM OLD.company_id) EXECUTE FUNCTION cauce_company_immutable();

CREATE TRIGGER secret_handoffs_company_reachable BEFORE INSERT OR UPDATE OF from_tenant,to_tenant ON secret_handoffs
  FOR EACH ROW EXECUTE FUNCTION cauce_pair_company_guard('from_tenant','to_tenant');
CREATE TRIGGER blob_delivery_grants_company_reachable
  BEFORE INSERT OR UPDATE OF owner_tenant_id,source_tenant_id,target_tenant_id ON blob_delivery_grants
  FOR EACH ROW EXECUTE FUNCTION cauce_pair_company_guard('owner_tenant_id','target_tenant_id','source_tenant_id','target_tenant_id');
CREATE TRIGGER agent_output_materializations_company_reachable
  BEFORE INSERT OR UPDATE OF source_tenant,target_tenant ON agent_output_materializations
  FOR EACH ROW EXECUTE FUNCTION cauce_pair_company_guard('source_tenant','target_tenant');
CREATE TRIGGER agent_failure_notices_company_reachable
  BEFORE INSERT OR UPDATE OF parent_tenant,child_tenant ON agent_failure_notices
  FOR EACH ROW EXECUTE FUNCTION cauce_pair_company_guard('parent_tenant','child_tenant');
CREATE TRIGGER quota_window_samples_company_guard BEFORE INSERT OR UPDATE OF account_id,collection_id ON quota_window_samples
  FOR EACH ROW EXECUTE FUNCTION cauce_quota_company_guard();
CREATE TRIGGER quota_collections_company_guard BEFORE UPDATE OF collector_tenant ON quota_collections
  FOR EACH ROW EXECUTE FUNCTION cauce_quota_company_guard();

-- The guards above only see new writes; history must already satisfy them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM secret_handoffs handoff JOIN tenants source ON source.id=handoff.from_tenant
      JOIN tenants target ON target.id=handoff.to_tenant WHERE source.company_id<>target.company_id
        AND NOT cauce_lock_company_link(source.company_id,target.company_id))
    OR EXISTS (SELECT 1 FROM blob_delivery_grants grant_row JOIN tenants target ON target.id=grant_row.target_tenant_id
      JOIN tenants other ON other.id IN (grant_row.owner_tenant_id,grant_row.source_tenant_id)
      WHERE other.company_id<>target.company_id AND NOT cauce_lock_company_link(other.company_id,target.company_id))
    OR EXISTS (SELECT 1 FROM agent_output_materializations output JOIN tenants source ON source.id=output.source_tenant
      JOIN tenants target ON target.id=output.target_tenant WHERE source.company_id<>target.company_id
        AND NOT cauce_lock_company_link(source.company_id,target.company_id))
    OR EXISTS (SELECT 1 FROM agent_failure_notices notice JOIN tenants parent ON parent.id=notice.parent_tenant
      JOIN tenants child ON child.id=notice.child_tenant WHERE parent.company_id<>child.company_id
        AND NOT cauce_lock_company_link(parent.company_id,child.company_id))
    OR EXISTS (SELECT 1 FROM quota_window_samples sample JOIN quota_collections collection ON collection.id=sample.collection_id
      JOIN tenants collector ON collector.id=collection.collector_tenant
      JOIN provider_accounts account ON account.id=sample.account_id WHERE account.company_id<>collector.company_id) THEN
    RAISE EXCEPTION 'existing rows cross a company boundary without a link' USING ERRCODE='23514';
  END IF;
END;
$$;

-- Trigger functions fire without EXECUTE; each function is still granted to the role whose writes
-- run it, and the helpers that guards call are granted to the platform role as well.
REVOKE ALL ON FUNCTION cauce_platform_operator(),cauce_fill_company(),cauce_fill_company_from_human(),
  cauce_company_immutable(),cauce_tenants_company_admission(),cauce_assert_company_reachable(text,text),
  cauce_pair_company_guard(),cauce_fill_host_company(),cauce_register_placed_host(),cauce_fill_operation_company(),
  cauce_config_revision_scope(jsonb),cauce_config_revision_company(),cauce_append_only(),cauce_quota_company_guard()
  FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_runtime') THEN
    GRANT EXECUTE ON FUNCTION cauce_platform_operator(),cauce_fill_company(),cauce_fill_company_from_human(),
      cauce_company_immutable(),cauce_tenants_company_admission(),cauce_assert_company_reachable(text,text),
      cauce_pair_company_guard(),cauce_fill_host_company(),cauce_register_placed_host(),cauce_fill_operation_company(),
      cauce_config_revision_scope(jsonb),cauce_config_revision_company(),cauce_append_only(),cauce_quota_company_guard()
      TO cauce_runtime;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_platform') THEN
    GRANT EXECUTE ON FUNCTION cauce_platform_operator(),cauce_assert_company_reachable(text,text),
      cauce_config_revision_scope(jsonb) TO cauce_platform;
  END IF;
END;
$$;
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

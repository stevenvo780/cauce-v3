SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_051);
-- Take every table lock up front, strongest first, and fail fast instead of queueing live
-- traffic behind a long reader. The previous lock_timeout is restored at the end.
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE tenants IN ACCESS EXCLUSIVE MODE;
LOCK TABLE acl_edges,deliveries,console_users IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE companies (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  enabled boolean NOT NULL DEFAULT true,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CHECK (retired_at IS NULL OR NOT enabled)
);
INSERT INTO companies(id,name) VALUES('humanizar','Humanizar');

ALTER TABLE tenants ADD COLUMN company_id text NOT NULL DEFAULT 'humanizar'
  REFERENCES companies(id) ON DELETE RESTRICT;
-- Writers that predate companies may still omit company_id. That only stays valid while
-- Humanizar is the sole company; afterwards an omitted company fails closed.
CREATE FUNCTION cauce_legacy_company_id()
RETURNS text LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.companies WHERE id<>'humanizar') THEN
    RAISE EXCEPTION 'tenant company is required once another company exists'
      USING ERRCODE='23502', TABLE='tenants', COLUMN='company_id';
  END IF;
  RETURN 'humanizar';
END
$$;
ALTER TABLE tenants ALTER COLUMN company_id SET DEFAULT cauce_legacy_company_id();
DROP INDEX tenants_single_hub_idx;
CREATE UNIQUE INDEX tenants_company_hub_idx ON tenants(company_id) WHERE is_hub;
CREATE INDEX tenants_company_idx ON tenants(company_id);

CREATE TABLE platform_admins (
  human_id uuid PRIMARY KEY REFERENCES console_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE company_links (
  company_a text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  company_b text NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES platform_admins(human_id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_a,company_b),
  CHECK (company_a COLLATE "C" < company_b COLLATE "C")
);

CREATE FUNCTION cauce_lock_company_link(p_company_a text, p_company_b text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  RETURN EXISTS (SELECT 1 FROM public.company_links link
    WHERE (link.company_a=p_company_a AND link.company_b=p_company_b)
       OR (link.company_a=p_company_b AND link.company_b=p_company_a)
    FOR SHARE OF link);
END
$$;
REVOKE ALL ON FUNCTION cauce_lock_company_link(text,text) FROM PUBLIC;

-- Row locks need UPDATE privilege; the definer keeps the trigger backstop usable by a runtime
-- role that may only read tenants.
CREATE FUNCTION cauce_lock_hub_star_tenant(p_tenant text, OUT hub boolean, OUT company text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  SELECT tenant.is_hub,tenant.company_id INTO hub,company FROM public.tenants tenant
    WHERE tenant.id=p_tenant FOR SHARE OF tenant;
END
$$;
REVOKE ALL ON FUNCTION cauce_lock_hub_star_tenant(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION cauce_assert_hub_star(p_from_tenant text, p_to_tenant text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  from_is_hub boolean;
  to_is_hub boolean;
  from_company text;
  to_company text;
BEGIN
  IF p_from_tenant=p_to_tenant THEN RETURN; END IF;
  SELECT locked.hub,locked.company INTO from_is_hub,from_company FROM cauce_lock_hub_star_tenant(p_from_tenant) locked;
  SELECT locked.hub,locked.company INTO to_is_hub,to_company FROM cauce_lock_hub_star_tenant(p_to_tenant) locked;
  IF from_is_hub IS NULL OR to_is_hub IS NULL THEN RETURN; END IF;
  IF from_company=to_company AND (from_is_hub OR to_is_hub) THEN RETURN; END IF;
  IF from_company<>to_company AND from_is_hub AND to_is_hub
    AND cauce_lock_company_link(from_company,to_company) THEN RETURN; END IF;
  RAISE EXCEPTION 'cross-tenant routes require a company hub or an explicit inter-company hub link: % -> %',
    p_from_tenant,p_to_tenant USING ERRCODE='23514', CONSTRAINT='cauce_hub_star_route';
END
$$;

CREATE OR REPLACE FUNCTION cauce_acl_edges_hub_star_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM cauce_assert_hub_star(NEW.from_tenant,NEW.to_tenant);
  RETURN NEW;
END
$$;
-- Re-enabling an edge is a new grant: it must satisfy the current topology and links.
CREATE TRIGGER acl_edges_enable_hub_star_guard BEFORE UPDATE OF enabled ON acl_edges
  FOR EACH ROW WHEN (NEW.enabled AND NOT OLD.enabled) EXECUTE FUNCTION cauce_acl_edges_hub_star_guard();

CREATE OR REPLACE FUNCTION cauce_tenants_hub_star_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  edge record;
BEGIN
  IF OLD.is_hub IS DISTINCT FROM NEW.is_hub OR OLD.company_id IS DISTINCT FROM NEW.company_id THEN
    FOR edge IN SELECT from_tenant,to_tenant FROM acl_edges WHERE from_tenant=NEW.id OR to_tenant=NEW.id LOOP
      PERFORM cauce_assert_hub_star(edge.from_tenant,edge.to_tenant);
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER tenants_hub_star_guard ON tenants;
CREATE TRIGGER tenants_hub_star_guard AFTER UPDATE OF is_hub,company_id ON tenants
  FOR EACH ROW EXECUTE FUNCTION cauce_tenants_hub_star_guard();

-- Withdrawing a link disables every cross-company edge it no longer covers, so each reader
-- that requires an enabled edge loses the foreign company at once. History is preserved.
CREATE FUNCTION cauce_company_links_withdraw_edges()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE acl_edges edge SET enabled=false
    FROM tenants source,tenants target
   WHERE source.id=edge.from_tenant AND target.id=edge.to_tenant AND edge.enabled
     AND source.company_id<>target.company_id
     AND NOT EXISTS (SELECT 1 FROM company_links link
       WHERE (link.company_a=source.company_id AND link.company_b=target.company_id)
          OR (link.company_a=target.company_id AND link.company_b=source.company_id));
  RETURN NULL;
END
$$;
CREATE TRIGGER company_links_withdraw_edges AFTER UPDATE OR DELETE OR TRUNCATE ON company_links
  FOR EACH STATEMENT EXECUTE FUNCTION cauce_company_links_withdraw_edges();

CREATE OR REPLACE FUNCTION cauce_dlq_can_control_tenant_030(
  p_actor_tenant text,
  p_target_tenant text
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
SELECT EXISTS (
  SELECT 1
    FROM tenants target_tenant
   WHERE target_tenant.id=p_target_tenant AND target_tenant.enabled
     AND (
       p_actor_tenant=p_target_tenant
       OR EXISTS (
         SELECT 1
           FROM acl_edges edge
           JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
          WHERE edge.from_tenant=p_actor_tenant AND edge.to_tenant=p_target_tenant
            AND edge.enabled AND edge.allow_control AND source_tenant.enabled
            AND ((source_tenant.company_id=target_tenant.company_id AND (source_tenant.is_hub OR target_tenant.is_hub))
              OR (source_tenant.company_id<>target_tenant.company_id AND source_tenant.is_hub AND target_tenant.is_hub
                AND EXISTS (SELECT 1 FROM company_links link
                  WHERE (link.company_a=source_tenant.company_id AND link.company_b=target_tenant.company_id)
                     OR (link.company_a=target_tenant.company_id AND link.company_b=source_tenant.company_id))))
       )
     )
)
$$;

-- Applies only where a dedicated least-privilege runtime role has been provisioned.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN
    GRANT SELECT ON companies,platform_admins,company_links TO cauce_gateway;
    GRANT EXECUTE ON FUNCTION cauce_lock_company_link(text,text),cauce_lock_hub_star_tenant(text) TO cauce_gateway;
    REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON companies,platform_admins,company_links FROM cauce_gateway;
  END IF;
END;
$$;
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

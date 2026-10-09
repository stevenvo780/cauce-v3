SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_051);
SELECT set_config('cauce.migration_lock_timeout',current_setting('lock_timeout'),true);
SELECT set_config('lock_timeout','5s',true);
LOCK TABLE tenants,acl_edges,deliveries,console_users,companies,platform_admins,company_links IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version>'051_companies.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 051 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM companies WHERE id<>'humanizar' OR name<>'Humanizar' OR NOT enabled
    OR retired_at IS NOT NULL OR version<>1 OR updated_at<>created_at)
    OR EXISTS (SELECT 1 FROM tenants WHERE company_id<>'humanizar')
    OR EXISTS (SELECT 1 FROM platform_admins) OR EXISTS (SELECT 1 FROM company_links) THEN
    RAISE EXCEPTION 'rollback preserves company data; changed company schema cannot be removed';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION cauce_assert_hub_star(p_from_tenant text, p_to_tenant text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  from_is_hub boolean;
  to_is_hub boolean;
BEGIN
  IF p_from_tenant=p_to_tenant THEN
    RETURN;
  END IF;

  SELECT is_hub INTO from_is_hub FROM tenants WHERE id=p_from_tenant;
  SELECT is_hub INTO to_is_hub FROM tenants WHERE id=p_to_tenant;
  -- Let the existing foreign keys report missing tenants.
  IF from_is_hub IS NULL OR to_is_hub IS NULL THEN
    RETURN;
  END IF;
  IF NOT from_is_hub AND NOT to_is_hub THEN
    RAISE EXCEPTION 'cross-tenant routes require a hub endpoint: % -> %',
      p_from_tenant,p_to_tenant
      USING ERRCODE='23514', CONSTRAINT='cauce_hub_star_route';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION cauce_acl_edges_hub_star_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM cauce_assert_hub_star(NEW.from_tenant,NEW.to_tenant);
  RETURN NEW;
END
$$;
DROP TRIGGER acl_edges_enable_hub_star_guard ON acl_edges;

CREATE OR REPLACE FUNCTION cauce_tenants_hub_star_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_hub IS DISTINCT FROM NEW.is_hub AND EXISTS (
    SELECT 1 FROM acl_edges edge
    JOIN tenants source ON source.id=edge.from_tenant
    JOIN tenants target ON target.id=edge.to_tenant
    WHERE NOT source.is_hub AND NOT target.is_hub
  ) THEN
    RAISE EXCEPTION 'tenant hub change would violate the hub-star topology'
      USING ERRCODE='23514', CONSTRAINT='tenants_hub_star';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER tenants_hub_star_guard ON tenants;
CREATE TRIGGER tenants_hub_star_guard
AFTER UPDATE OF is_hub ON tenants
FOR EACH ROW EXECUTE FUNCTION cauce_tenants_hub_star_guard();

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
            AND (source_tenant.is_hub OR target_tenant.is_hub)
       )
     )
)
$$;

DROP INDEX tenants_company_hub_idx;
DROP INDEX tenants_company_idx;
ALTER TABLE tenants DROP COLUMN company_id;
CREATE UNIQUE INDEX tenants_single_hub_idx ON tenants(is_hub) WHERE is_hub;
DROP FUNCTION cauce_legacy_company_id();
DROP FUNCTION cauce_lock_hub_star_tenant(text);
DROP FUNCTION cauce_lock_company_link(text,text);
DROP TABLE company_links;
DROP FUNCTION cauce_company_links_withdraw_edges();
DROP TABLE platform_admins;
DROP TABLE companies;
DELETE FROM schema_migration_ledger WHERE version='051_companies.sql';
DELETE FROM schema_migrations WHERE version='051_companies.sql';
SELECT set_config('lock_timeout',current_setting('cauce.migration_lock_timeout'),true);

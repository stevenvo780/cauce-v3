-- Runtime authorization, data-driven hub-star backstops and self-healing outbox leases.

-- Pre-lease outbox rows may not have received a deadline when migration 003 added the
-- column. Treat those claims as expired so a normal claim call can recover them.
UPDATE adapter_outbox
SET claim_expires_at=COALESCE(claimed_at,created_at,now())
WHERE status='processing' AND claim_expires_at IS NULL;

CREATE INDEX IF NOT EXISTS adapter_outbox_stuck_kind_idx
  ON adapter_outbox (kind,status,available_at,claim_expires_at)
  WHERE status IN ('pending','failed','processing');

-- All topology decisions remain data-driven through tenants.is_hub. This helper is
-- shared by the ACL and delivery triggers so repository checks cannot be the only guard.
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

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM acl_edges edge
    JOIN tenants source ON source.id=edge.from_tenant
    JOIN tenants target ON target.id=edge.to_tenant
    WHERE NOT source.is_hub AND NOT target.is_hub
  ) THEN
    RAISE EXCEPTION 'existing ACL edges violate the data-driven hub-star topology'
      USING ERRCODE='23514', CONSTRAINT='acl_edges_hub_star';
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

DROP TRIGGER IF EXISTS acl_edges_hub_star_guard ON acl_edges;
CREATE TRIGGER acl_edges_hub_star_guard
BEFORE INSERT OR UPDATE OF from_tenant,to_tenant ON acl_edges
FOR EACH ROW EXECUTE FUNCTION cauce_acl_edges_hub_star_guard();

CREATE OR REPLACE FUNCTION cauce_deliveries_hub_star_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_tenant text;
BEGIN
  SELECT tenant_id INTO source_tenant FROM messages WHERE id=NEW.message_id;
  IF source_tenant IS NOT NULL THEN
    PERFORM cauce_assert_hub_star(source_tenant,NEW.recipient_tenant);
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS deliveries_hub_star_guard ON deliveries;
CREATE TRIGGER deliveries_hub_star_guard
BEFORE INSERT OR UPDATE OF message_id,recipient_tenant ON deliveries
FOR EACH ROW EXECUTE FUNCTION cauce_deliveries_hub_star_guard();

-- Changing which tenant is the hub must not silently invalidate existing ACL edges.
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

DROP TRIGGER IF EXISTS tenants_hub_star_guard ON tenants;
CREATE TRIGGER tenants_hub_star_guard
AFTER UPDATE OF is_hub ON tenants
FOR EACH ROW EXECUTE FUNCTION cauce_tenants_hub_star_guard();

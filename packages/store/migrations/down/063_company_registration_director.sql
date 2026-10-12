SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_063);
-- The source-only directors are exactly the agents 063 registered, by its backfill or by a registration;
-- a director that runs, such as argos, is never source-only. They leave with their memberships, so a
-- later 063 registers the same alias again instead of a second context-director-N. One that already
-- published or was given a runtime holds history, which the rollback refuses to drop.
DO $$
BEGIN
  IF EXISTS (SELECT version FROM schema_migrations WHERE version>'063_company_registration_director.sql'
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version>'063_company_registration_director.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 063 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM company_system_principals principal JOIN agents agent
      ON agent.tenant_id=principal.tenant_id AND agent.alias=principal.principal_alias
    WHERE principal.delivery_source_only AND (agent.enabled OR agent.runtime_key IS NOT NULL OR agent.harness_id IS NOT NULL
      OR agent.host_id IS NOT NULL OR agent.container_name IS NOT NULL OR EXISTS (SELECT 1 FROM messages message
        WHERE message.tenant_id=principal.tenant_id AND message.actor_alias=principal.principal_alias))) THEN
    RAISE EXCEPTION 'export the history of the company context directors before reverting';
  END IF;
END
$$;
DROP TRIGGER connection_leases_context_director_guard ON connection_leases;
DROP TRIGGER deliveries_context_director_guard ON deliveries;
DROP TRIGGER memberships_context_director_guard ON memberships;
DROP TRIGGER agents_context_director_guard ON agents;
DROP FUNCTION cauce_context_director_recipient_guard();
DROP FUNCTION cauce_context_director_mutation_guard();
DELETE FROM agents agent USING company_system_principals principal
  WHERE principal.delivery_source_only AND agent.tenant_id=principal.tenant_id AND agent.alias=principal.principal_alias;
DELETE FROM memberships member USING company_system_principals principal
  WHERE principal.delivery_source_only AND member.tenant_id=principal.tenant_id AND member.alias=principal.principal_alias;
DELETE FROM company_system_principals WHERE delivery_source_only;
ALTER TABLE company_system_principals DROP CONSTRAINT company_system_principals_source_only,DROP COLUMN delivery_source_only;
DELETE FROM role_policies WHERE role='context_broker' AND NOT EXISTS (SELECT 1 FROM memberships WHERE role='context_broker');
DROP FUNCTION cauce_register_company(text,text,text,text,text);
ALTER FUNCTION cauce_register_company_without_director(text,text,text,text,text) RENAME TO cauce_register_company;
DROP FUNCTION cauce_register_company_director(text,text);
DROP FUNCTION cauce_runtime_grants_063();
SELECT cauce_runtime_grants_055();
DELETE FROM schema_migration_ledger WHERE version='063_company_registration_director.sql';
DELETE FROM schema_migrations WHERE version='063_company_registration_director.sql';

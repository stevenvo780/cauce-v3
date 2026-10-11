SELECT pg_advisory_xact_lock(783_003_063);
DROP TRIGGER connection_leases_context_director_guard ON connection_leases;
DROP TRIGGER deliveries_context_director_guard ON deliveries;
DROP TRIGGER memberships_context_director_guard ON memberships;
DROP TRIGGER agents_context_director_guard ON agents;
DROP FUNCTION cauce_context_director_recipient_guard();
DROP FUNCTION cauce_context_director_mutation_guard();
WITH removed AS (DELETE FROM company_system_principals WHERE delivery_source_only RETURNING tenant_id,principal_alias)
  UPDATE memberships member SET enabled=false,role='agent' FROM removed
    WHERE member.tenant_id=removed.tenant_id AND member.alias=removed.principal_alias;
ALTER TABLE company_system_principals DROP CONSTRAINT company_system_principals_source_only,DROP COLUMN delivery_source_only;
DELETE FROM role_policies WHERE role='context_broker' AND NOT EXISTS (SELECT 1 FROM memberships WHERE role='context_broker');
DROP FUNCTION cauce_register_company(text,text,text,text,text);
ALTER FUNCTION cauce_register_company_without_director(text,text,text,text,text) RENAME TO cauce_register_company;
DROP FUNCTION cauce_register_company_director(text,text);
DROP FUNCTION cauce_runtime_grants_063();
SELECT cauce_runtime_grants_055();

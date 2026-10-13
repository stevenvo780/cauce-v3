-- Read-only export of the live Hospital agents and their profiles, the private input of
-- `cauce platform empresa importar --perfiles`. Run it on the V3 database of the hospital:
--   psql -X -A -t -q -v ON_ERROR_STOP=1 -f praxis-perfiles-export.sql > perfiles.json
-- It writes nothing: the transaction is READ ONLY and only reads tenant Hospital.
\set ON_ERROR_STOP on
BEGIN TRANSACTION READ ONLY;
SELECT json_build_object(
  'format', 'cauce-agent-profiles',
  'version', 1,
  'tenant_id', 'Hospital',
  'agents', COALESCE((SELECT json_agg(json_build_object('alias', agent.alias, 'display_name', agent.display_name)
      ORDER BY agent.alias)
    FROM agents agent WHERE agent.tenant_id = 'Hospital' AND agent.enabled), '[]'::json),
  'profiles', COALESCE((SELECT json_agg(json_build_object(
      'tenant_id', profile.tenant_id,
      'alias', profile.alias,
      'purpose', profile.purpose,
      'role_summary', profile.role_summary,
      'human_brief', profile.human_brief,
      'responsibilities', COALESCE(profile.responsibilities, ARRAY[]::text[]),
      'restrictions', COALESCE(profile.restrictions, ARRAY[]::text[]),
      'tools', COALESCE(profile.tools, ARRAY[]::text[]),
      'operating_rules', COALESCE(profile.operating_rules, ARRAY[]::text[]))
      ORDER BY profile.alias)
    FROM agent_profiles profile JOIN agents agent USING (tenant_id, alias)
    WHERE profile.tenant_id = 'Hospital' AND agent.enabled), '[]'::json));
COMMIT;

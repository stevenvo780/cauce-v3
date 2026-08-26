-- Destructive schema downgrade is allowed only before runtime expectation/adoption evidence exists.
-- Runtime rollback normally retains this additive schema and uses the verified bridge image.

-- Serialize schema_migrations and teardown with the forward migration runner before entering the
-- profile-runtime-specific critical section.
SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_006);
LOCK TABLE agent_profile_runtime_adoptions, agent_profile_runtime_expectations IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version>'035_agent_profile_runtime_adoption.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 035 while a later migration is present';
  END IF;

  IF EXISTS (SELECT 1 FROM agent_profile_runtime_adoptions)
     OR EXISTS (SELECT 1 FROM agent_profile_runtime_expectations) THEN
    RAISE EXCEPTION 'cannot downgrade schema 035 after runtime profile evidence has been recorded';
  END IF;
END
$$;

DROP TABLE agent_profile_runtime_adoptions;
DROP TABLE agent_profile_runtime_expectations;
DROP FUNCTION cauce_profile_runtime_adoption_matches_expectation();
DROP FUNCTION cauce_profile_runtime_documents_valid(jsonb);

DELETE FROM schema_migrations
 WHERE version='035_agent_profile_runtime_adoption.sql';

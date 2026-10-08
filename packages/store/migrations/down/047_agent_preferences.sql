SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_047);
LOCK TABLE console_agent_favorites, agent_appearances IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM schema_migrations WHERE version > '047_agent_preferences.sql') THEN
    RAISE EXCEPTION 'cannot downgrade schema 047 while a later migration is present';
  END IF;
  IF EXISTS (SELECT 1 FROM console_agent_favorites) OR EXISTS (SELECT 1 FROM agent_appearances) THEN
    RAISE EXCEPTION 'rollback preserves console agent preferences; populated preference schema cannot be removed';
  END IF;
END;
$$;
DROP TABLE agent_appearances;
DROP TABLE console_agent_favorites;
DELETE FROM schema_migration_ledger WHERE version = '047_agent_preferences.sql';
DELETE FROM schema_migrations WHERE version = '047_agent_preferences.sql';

-- Capture the exact migration generation before joining the global critical section. If a
-- forward runner installs or rewrites 037 while this down waits, its row/ledger xmin or checksum
-- changes and the post-lock CAS rejects the stale teardown. A concurrent no-op apply leaves this
-- snapshot unchanged; serial order apply(no-op) -> explicit down is therefore safe and allowed.
CREATE TEMP TABLE cauce_down_037_snapshot ON COMMIT DROP AS
SELECT (
         SELECT xmin::text FROM schema_migrations
          WHERE version='037_console_publish_intent_indexes.sql'
       ) AS migration_xmin,
       (
         SELECT xmin::text FROM schema_migration_ledger
          WHERE version='037_console_publish_intent_indexes.sql'
       ) AS ledger_xmin,
       (
         SELECT source_sha256 FROM schema_migration_ledger
          WHERE version='037_console_publish_intent_indexes.sql'
       ) AS source_sha256,
       (
         SELECT source_origin FROM schema_migration_ledger
          WHERE version='037_console_publish_intent_indexes.sql'
       ) AS source_origin;

SELECT pg_advisory_xact_lock(783_003_003);
SELECT pg_advisory_xact_lock(783_003_008);
LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM cauce_down_037_snapshot snapshot
      JOIN schema_migrations migration
        ON migration.version='037_console_publish_intent_indexes.sql'
       AND migration.xmin::text=snapshot.migration_xmin
      JOIN schema_migration_ledger ledger
        ON ledger.version=migration.version
       AND ledger.xmin::text=snapshot.ledger_xmin
       AND ledger.source_sha256=snapshot.source_sha256
       AND ledger.source_origin=snapshot.source_origin
     WHERE snapshot.migration_xmin IS NOT NULL
       AND snapshot.ledger_xmin IS NOT NULL
       AND snapshot.source_sha256=
           '0daeb89c224e940600562ab162fba03c4facd4cb0b80b65f20feedc02b33f281'
       AND snapshot.source_origin='applied-atomically'
  ) THEN
    RAISE EXCEPTION
      'cannot downgrade schema 037 from absent, incomplete, or concurrently changed ledger state';
  END IF;

  IF EXISTS (
    SELECT 1 FROM schema_migrations
     WHERE version>'037_console_publish_intent_indexes.sql'
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 037 while a later migration is present';
  END IF;

  IF EXISTS (SELECT 1 FROM audit_events WHERE action LIKE 'console.publish.%') THEN
    RAISE EXCEPTION 'cannot downgrade schema 037 after console publish journal use';
  END IF;

  IF 4<>(
    SELECT count(*)
      FROM pg_class index_relation
      JOIN pg_namespace namespace ON namespace.oid=index_relation.relnamespace
      JOIN pg_index index_value ON index_value.indexrelid=index_relation.oid
     WHERE namespace.nspname='public'
       AND index_relation.relname IN (
         'audit_events_console_publish_key_037_idx',
         'audit_events_console_publish_nonce_037_idx',
         'audit_events_console_publish_rate_037_idx',
         'audit_events_console_publish_head_037_idx'
       )
       AND index_value.indrelid='public.audit_events'::regclass
       AND index_value.indisvalid
       AND index_value.indisready
       AND index_value.indislive
  ) THEN
    RAISE EXCEPTION 'cannot downgrade schema 037 from drifted index state';
  END IF;
END
$$;

DROP INDEX IF EXISTS audit_events_console_publish_head_037_idx;
DROP INDEX IF EXISTS audit_events_console_publish_rate_037_idx;
DROP INDEX IF EXISTS audit_events_console_publish_nonce_037_idx;
DROP INDEX IF EXISTS audit_events_console_publish_key_037_idx;

DELETE FROM schema_migrations
 WHERE version='037_console_publish_intent_indexes.sql';

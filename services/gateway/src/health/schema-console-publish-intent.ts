import { withTransaction, type DatabasePool } from '@cauce/store';
import { isLiteralTrue } from '../runtime-guards.js';

interface ConsolePublishIntentSchemaProbeRow {
  readonly migration_ledger_exact: boolean;
  readonly indexes_exact: boolean;
  readonly journal_permissions: boolean;
}

// Readiness binds the installed schema to the exact source recorded atomically by the migration
// runner. Keep this in lockstep with migration 037; the PostgreSQL focal test catches divergence.
const consolePublishIntentMigrationSha256 =
  '0daeb89c224e940600562ab162fba03c4facd4cb0b80b65f20feedc02b33f281';

/** Proves the exact schema-037 journal indexes and atomic source ledger without reading history. */
export async function probeConsolePublishIntentPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<ConsolePublishIntentSchemaProbeRow>(
      `WITH expected_indices(
         name,key_expressions,sort_options,predicate,definition
       ) AS (VALUES
         (
           'audit_events_console_publish_key_037_idx'::text,
           ARRAY[
             'tenant_id','actor_alias',
             '(metadata ->> ''idempotency_key''::text)','id'
           ]::text[],
           ARRAY[0,0,0,0]::smallint[],
           'action = ANY (ARRAY[''console.publish.prepare''::text, ''console.publish.confirm''::text, ''console.publish.expire''::text])'::text,
           'CREATE INDEX audit_events_console_publish_key_037_idx ON audit_events USING btree (tenant_id, actor_alias, (metadata ->> ''idempotency_key''::text), id) WHERE action = ANY (ARRAY[''console.publish.prepare''::text, ''console.publish.confirm''::text, ''console.publish.expire''::text])'::text
         ),
         (
           'audit_events_console_publish_nonce_037_idx',
           ARRAY[
             'tenant_id','actor_alias','(metadata ->> ''operator_scope_hash''::text)',
             '(metadata ->> ''intent_nonce_hash''::text)','id'
           ]::text[],
           ARRAY[0,0,0,0,3]::smallint[],
           'action = ''console.publish.prepare''::text',
           'CREATE INDEX audit_events_console_publish_nonce_037_idx ON audit_events USING btree (tenant_id, actor_alias, (metadata ->> ''operator_scope_hash''::text), (metadata ->> ''intent_nonce_hash''::text), id DESC) WHERE action = ''console.publish.prepare''::text'
         ),
         (
           'audit_events_console_publish_rate_037_idx',
           ARRAY[
             'tenant_id','actor_alias','(metadata ->> ''operator_scope_hash''::text)',
             'created_at','id'
           ]::text[],
           ARRAY[0,0,0,3,3]::smallint[],
           'action = ''console.publish.prepare''::text',
           'CREATE INDEX audit_events_console_publish_rate_037_idx ON audit_events USING btree (tenant_id, actor_alias, (metadata ->> ''operator_scope_hash''::text), created_at DESC, id DESC) WHERE action = ''console.publish.prepare''::text'
         ),
         (
           'audit_events_console_publish_head_037_idx',
           ARRAY[
             'tenant_id','actor_alias','(metadata ->> ''operator_scope_hash''::text)',
             '(metadata ->> ''conversation_hash''::text)','id'
           ]::text[],
           ARRAY[0,0,0,0,3]::smallint[],
           'action = ''console.publish.head''::text',
           'CREATE INDEX audit_events_console_publish_head_037_idx ON audit_events USING btree (tenant_id, actor_alias, (metadata ->> ''operator_scope_hash''::text), (metadata ->> ''conversation_hash''::text), id DESC) WHERE action = ''console.publish.head''::text'
         )
       ), checked_indices AS (
         SELECT expected.name,
                index_record.oid IS NOT NULL
                AND index_record.relkind='i'
                AND index_record.relpersistence='p'
                AND access_method.amname='btree'
                AND metadata.indrelid='public.audit_events'::regclass
                AND metadata.indisvalid AND metadata.indisready AND metadata.indislive
                AND NOT metadata.indisunique AND NOT metadata.indisprimary
                AND NOT metadata.indisexclusion AND NOT metadata.indisreplident
                AND metadata.indnkeyatts=cardinality(expected.key_expressions)
                AND metadata.indnatts=metadata.indnkeyatts
                AND ARRAY(
                  SELECT pg_get_indexdef(index_record.oid,key_position,true)
                    FROM generate_series(1,metadata.indnkeyatts) AS key_position
                   ORDER BY key_position
                )=expected.key_expressions
                AND ARRAY(
                  SELECT metadata.indoption[key_position-1]
                    FROM generate_series(1,metadata.indnkeyatts) AS key_position
                   ORDER BY key_position
                )=expected.sort_options
                AND pg_get_expr(metadata.indpred,metadata.indrelid,true)=expected.predicate
                AND pg_get_indexdef(index_record.oid,0,true)=expected.definition
                  AS exact
           FROM expected_indices expected
           LEFT JOIN pg_namespace namespace_record
             ON namespace_record.nspname='public'
           LEFT JOIN pg_class index_record
             ON index_record.relnamespace=namespace_record.oid
            AND index_record.relname=expected.name
           LEFT JOIN pg_index metadata ON metadata.indexrelid=index_record.oid
           LEFT JOIN pg_am access_method ON access_method.oid=index_record.relam
       )
       SELECT
         EXISTS (
           SELECT 1
             FROM schema_migrations migration
             JOIN schema_migration_ledger ledger USING (version)
            WHERE migration.version='037_console_publish_intent_indexes.sql'
              AND ledger.source_sha256=$1
              AND ledger.source_origin='applied-atomically'
         ) AS migration_ledger_exact,
         COALESCE((
           SELECT count(*)=4 AND bool_and(checked.exact)
             FROM checked_indices checked
         ),false) AS indexes_exact,
         has_schema_privilege(current_user,'public','USAGE')
           AND has_table_privilege(current_user,'public.schema_migrations','SELECT')
           AND has_table_privilege(current_user,'public.schema_migration_ledger','SELECT')
           AND has_table_privilege(current_user,'public.audit_events','SELECT')
           AND has_table_privilege(current_user,'public.audit_events','INSERT')
           AND has_sequence_privilege(current_user,'public.audit_events_id_seq','USAGE')
           AS journal_permissions`,
      [consolePublishIntentMigrationSha256],
    );
    const contract = schema.rows[0];
    if (!isLiteralTrue(contract?.migration_ledger_exact)
        || !isLiteralTrue(contract?.indexes_exact)
        || !isLiteralTrue(contract?.journal_permissions)) {
      throw new Error('gateway schema-037 console publish intent contract is unavailable');
    }
  });
}

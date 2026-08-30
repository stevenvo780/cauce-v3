import { withTransaction, type DatabasePool } from '@cauce/store';

interface TerminalClaimSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraint_exact: boolean;
  readonly claim_permissions: boolean;
  readonly audit_permissions: boolean;
}

/** Validates schema-032 and its exact fenced CAS predicate without observing a session. */
export async function probeTerminalClaimPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<TerminalClaimSchemaProbeRow>(
      `WITH claim_columns(name,type_name,not_null,default_expression) AS (VALUES
         ('relay_claim_sha256','bytea',false,NULL::text),
         ('relay_claim_epoch','bigint',true,'0'::text),
         ('relay_claimed_at','timestamp with time zone',false,NULL::text),
         ('relay_claim_expires_at','timestamp with time zone',false,NULL::text)
       ), checked_columns AS (
         SELECT count(attribute.attname)=4
                AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
                AND bool_and(attribute.attnotnull=expected.not_null)
                AND bool_and(attribute.attidentity='')
                AND bool_and(attribute.attgenerated='')
                AND bool_and(
                  pg_get_expr(definition.adbin,definition.adrelid)
                    IS NOT DISTINCT FROM expected.default_expression
                ) AS exact
           FROM claim_columns expected
           LEFT JOIN pg_attribute attribute
             ON attribute.attrelid='public.terminal_sessions'::regclass
            AND attribute.attname=expected.name AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef definition
             ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
       ), claim_constraint AS (
         SELECT pg_get_constraintdef(constraint_record.oid,true) AS definition,
                constraint_record.convalidated,
                constraint_record.connoinherit
           FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid='public.terminal_sessions'::regclass
            AND constraint_record.conname='terminal_sessions_relay_claim_shape'
            AND constraint_record.contype='c'
       )
       SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='032_terminal_session_claim_fencing.sql'
         ) AS migration_applied,
         COALESCE((SELECT exact FROM checked_columns),false) AS columns_exact,
         EXISTS (
           SELECT 1 FROM claim_constraint
            WHERE convalidated AND NOT connoinherit
              AND definition='CHECK (relay_claim_sha256 IS NULL AND relay_claim_epoch = 0 AND relay_claimed_at IS NULL AND relay_claim_expires_at IS NULL OR consumed_at IS NOT NULL AND relay_claim_sha256 IS NOT NULL AND octet_length(relay_claim_sha256) = 32 AND relay_claim_epoch > 0 AND relay_claimed_at IS NOT NULL AND relay_claim_expires_at IS NOT NULL AND relay_claim_expires_at > relay_claimed_at)'
         ) AS constraint_exact,
         has_table_privilege(current_user,'public.terminal_sessions','SELECT')
           AND has_table_privilege(current_user,'public.terminal_sessions','UPDATE')
           AS claim_permissions,
         has_table_privilege(current_user,'public.audit_events','INSERT')
           AND COALESCE(has_sequence_privilege(
             current_user,pg_get_serial_sequence('public.audit_events','id'),'USAGE'
           ),false) AS audit_permissions`
    );
    const contract = schema.rows[0];
    /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: 'error' */ // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- PostgreSQL rows are runtime input; every readiness authority flag must be literal true.
    if (contract?.migration_applied !== true || contract.columns_exact !== true || contract.constraint_exact !== true || contract.claim_permissions !== true || contract.audit_permissions !== true) {
      throw new Error('gateway terminal schema-032 claim contract is unavailable');
    }
    await client.query(
      `WITH requested(id,claim_sha256,claim_epoch,claim_lease_seconds,session_ttl_seconds) AS (
         VALUES(NULL::uuid,NULL::bytea,NULL::bigint,1::integer,1::integer)
       )
       SELECT 1
         FROM requested
         JOIN terminal_sessions session
           ON session.id=requested.id
          AND session.relay_claim_sha256=requested.claim_sha256
          AND session.relay_claim_epoch=requested.claim_epoch
          AND session.relay_claim_expires_at>now()
          AND session.consumed_at IS NOT NULL
          AND session.revoked_at IS NULL AND session.closed_at IS NULL
          AND session.consumed_at
                + make_interval(secs => requested.session_ttl_seconds)>now()
          AND LEAST(
                session.consumed_at+make_interval(secs => requested.session_ttl_seconds),
                now()+make_interval(secs => requested.claim_lease_seconds)
              )>now()
        LIMIT 1`
    );
  });
}

interface TerminalBrowserOwnerSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraint_exact: boolean;
  readonly request_index_exact: boolean;
  readonly mutation_permissions: boolean;
  readonly audit_permissions: boolean;
}

/**
 * Validates schema-033 structurally, including the one-column unique request-id index and every
 * permission used by admission/retry/takeover/revocation. The final SELECT exercises the exact
 * request and browser-owner fences with NULL sentinels, so no session identity is observed.
 */
export async function probeTerminalBrowserOwnerPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<TerminalBrowserOwnerSchemaProbeRow>(
      `WITH browser_columns(name,type_name) AS (VALUES
         ('request_id','uuid'),
         ('request_sha256','bytea'),
         ('browser_owner_sha256','bytea'),
         ('browser_owner_generation','bigint')
       ), checked_columns AS (
         SELECT count(attribute.attname)=4
                AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
                AND bool_and(attribute.attnotnull)
                AND bool_and(attribute.attidentity='')
                AND bool_and(attribute.attgenerated='')
                AND bool_and(definition.adbin IS NULL) AS exact
           FROM browser_columns expected
           LEFT JOIN pg_attribute attribute
             ON attribute.attrelid='public.terminal_sessions'::regclass
            AND attribute.attname=expected.name AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef definition
             ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
       ), owner_constraint AS (
         SELECT pg_get_constraintdef(constraint_record.oid,true) AS definition,
                constraint_record.convalidated,
                constraint_record.connoinherit
           FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid='public.terminal_sessions'::regclass
            AND constraint_record.conname='terminal_sessions_browser_owner_shape'
            AND constraint_record.contype='c'
       ), request_index AS (
         SELECT index_record.indisunique,index_record.indisvalid,index_record.indisready,
                index_record.indislive,index_record.indisprimary,index_record.indnkeyatts,
                index_record.indnatts,index_record.indpred,index_record.indexprs,
                pg_get_indexdef(index_record.indexrelid) AS definition
           FROM pg_index index_record
           JOIN pg_class index_relation ON index_relation.oid=index_record.indexrelid
          WHERE index_record.indrelid='public.terminal_sessions'::regclass
            AND index_relation.relname='terminal_sessions_request_id_idx'
       )
       SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='033_terminal_browser_owner_fencing.sql'
         ) AS migration_applied,
         COALESCE((SELECT exact FROM checked_columns),false) AS columns_exact,
         EXISTS (
           SELECT 1 FROM owner_constraint
            WHERE convalidated AND NOT connoinherit
              AND definition='CHECK (octet_length(request_sha256) = 32 AND octet_length(browser_owner_sha256) = 32 AND browser_owner_generation > 0)'
         ) AS constraint_exact,
         EXISTS (
           SELECT 1 FROM request_index
            WHERE indisunique AND indisvalid AND indisready AND indislive AND NOT indisprimary
              AND indnkeyatts=1 AND indnatts=1 AND indpred IS NULL AND indexprs IS NULL
              AND definition='CREATE UNIQUE INDEX terminal_sessions_request_id_idx ON public.terminal_sessions USING btree (request_id)'
         ) AS request_index_exact,
         has_table_privilege(current_user,'public.terminal_sessions','SELECT')
           AND has_table_privilege(current_user,'public.terminal_sessions','INSERT')
           AND has_table_privilege(current_user,'public.terminal_sessions','UPDATE')
           AS mutation_permissions,
         has_table_privilege(current_user,'public.audit_events','INSERT')
           AND COALESCE(has_sequence_privilege(
             current_user,pg_get_serial_sequence('public.audit_events','id'),'USAGE'
           ),false) AS audit_permissions`
    );
    const contract = schema.rows[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- PostgreSQL rows are runtime input; every readiness authority flag must be literal true.
    if (contract?.migration_applied !== true || contract.columns_exact !== true || contract.constraint_exact !== true || contract.request_index_exact !== true || contract.mutation_permissions !== true || contract.audit_permissions !== true) {
      throw new Error('gateway terminal schema-033 browser owner contract is unavailable');
    }
    await client.query(
      `WITH requested(request_id,request_sha256,browser_owner_sha256,browser_owner_generation) AS (
         VALUES(NULL::uuid,NULL::bytea,NULL::bytea,NULL::bigint)
       )
       SELECT 1
         FROM requested
         JOIN terminal_sessions session
           ON session.request_id=requested.request_id
          AND session.request_sha256=requested.request_sha256
          AND session.browser_owner_sha256=requested.browser_owner_sha256
          AND session.browser_owner_generation=requested.browser_owner_generation
          AND session.revoked_at IS NULL AND session.closed_at IS NULL
        LIMIT 1`
    );
  });
}

interface TerminalRelayInstanceSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraint_exact: boolean;
  readonly mutation_permissions: boolean;
}

/** Schema-034: exact authenticated relay pin plus process-generation fence, with no row read. */
export async function probeTerminalRelayInstancePath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<TerminalRelayInstanceSchemaProbeRow>(
      `WITH relay_columns(name,type_name) AS (VALUES
         ('relay_instance_id','text'),
         ('relay_boot_id','uuid')
       ), checked_columns AS (
         SELECT count(attribute.attname)=2
                AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
                AND bool_and(NOT attribute.attnotnull)
                AND bool_and(attribute.attidentity='')
                AND bool_and(attribute.attgenerated='')
                AND bool_and(definition.adbin IS NULL) AS exact
           FROM relay_columns expected
           LEFT JOIN pg_attribute attribute
             ON attribute.attrelid='public.terminal_sessions'::regclass
            AND attribute.attname=expected.name AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef definition
             ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
       ), relay_constraint AS (
         SELECT pg_get_constraintdef(constraint_record.oid,true) AS definition,
                constraint_record.convalidated,
                constraint_record.connoinherit
           FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid='public.terminal_sessions'::regclass
            AND constraint_record.conname='terminal_sessions_relay_instance_shape'
            AND constraint_record.contype='c'
       )
       SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='034_terminal_relay_instance_fencing.sql'
         ) AS migration_applied,
         COALESCE((SELECT exact FROM checked_columns),false) AS columns_exact,
         EXISTS (
           SELECT 1 FROM relay_constraint
            WHERE convalidated AND NOT connoinherit
              AND definition='CHECK (relay_instance_id IS NULL AND relay_boot_id IS NULL AND (closed_at IS NOT NULL OR revoked_at IS NOT NULL) OR relay_instance_id IS NOT NULL AND relay_instance_id ~ ''^[0-9a-f]{64}$''::text AND (relay_claim_epoch = 0 AND relay_boot_id IS NULL OR relay_claim_epoch > 0 AND relay_boot_id IS NOT NULL AND relay_boot_id::text ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''::text))'
         ) AS constraint_exact,
         has_table_privilege(current_user,'public.terminal_sessions','SELECT')
           AND has_table_privilege(current_user,'public.terminal_sessions','INSERT')
           AND has_table_privilege(current_user,'public.terminal_sessions','UPDATE')
           AS mutation_permissions`
    );
    const contract = schema.rows[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- PostgreSQL rows are runtime input; every readiness authority flag must be literal true.
    if (contract?.migration_applied !== true || contract.columns_exact !== true || contract.constraint_exact !== true || contract.mutation_permissions !== true) {
      throw new Error('gateway terminal schema-034 relay instance contract is unavailable');
    }
    await client.query(
      `WITH requested(id,relay_instance_id,relay_boot_id,claim_epoch) AS (
         VALUES(NULL::uuid,NULL::text,NULL::uuid,NULL::bigint)
       )
       SELECT 1
         FROM requested
         JOIN terminal_sessions session
           ON session.id=requested.id
          AND session.relay_instance_id=requested.relay_instance_id
          AND session.relay_claim_epoch=requested.claim_epoch
          AND session.relay_boot_id IS NOT DISTINCT FROM requested.relay_boot_id
          AND session.revoked_at IS NULL AND session.closed_at IS NULL
        LIMIT 1`
    );
  });
}

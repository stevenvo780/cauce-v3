import { withTransaction, type DatabasePool } from '@cauce/store';
import { probeSchemaContract } from './probe.js';

export interface LiveProfilePresence {
  available(): boolean;
  generationFor(tenantId: string, alias: string): string | undefined;
}

export interface StaleProfileExpectation {
  readonly tenant_id: string;
  readonly alias: string;
  readonly revision: number;
  readonly recorded_generation: string;
  readonly live_generation: string;
}

export interface MalformedProfileExpectation {
  readonly tenant_id: string | null;
  readonly alias: string | null;
  readonly reason: string;
}

export interface DegradedProfileExpectations {
  readonly stale: readonly StaleProfileExpectation[];
  readonly malformed: readonly MalformedProfileExpectation[];
  readonly unobserved: number;
  readonly truncated: boolean;
}

const MAX_SCANNED_EXPECTATIONS = 500;

interface ProfileExpectationRow {
  readonly tenant_id: unknown;
  readonly alias: unknown;
  readonly revision: unknown;
  readonly generation: unknown;
}

function identity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error(`gateway profile runtime expectation has an invalid ${field}`);
  }
  return value;
}

function revisionOf(value: unknown): number {
  const revision = typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('gateway profile runtime expectation has an invalid revision');
  }
  return revision;
}

function label(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : null;
}

export async function readStaleProfileExpectations(
  pool: DatabasePool, presence: LiveProfilePresence,
): Promise<DegradedProfileExpectations> {
  return withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const result = await client.query<ProfileExpectationRow>(
      `SELECT tenant_id,alias,revision,generation
         FROM agent_profile_runtime_expectations
        ORDER BY tenant_id,alias
        LIMIT ${String(MAX_SCANNED_EXPECTATIONS + 1)}`,
    );
    const stale: StaleProfileExpectation[] = [];
    const malformed: MalformedProfileExpectation[] = [];
    let unobserved = 0;
    for (const row of result.rows.slice(0, MAX_SCANNED_EXPECTATIONS)) {
      try {
        const tenantId = identity(row.tenant_id, 'tenant');
        const alias = identity(row.alias, 'alias');
        const recorded = identity(row.generation, 'generation');
        const revision = revisionOf(row.revision);
        const live = presence.generationFor(tenantId, alias);
        if (live === undefined) {
          unobserved += 1;
          continue;
        }
        if (live === recorded) continue;
        stale.push({
          tenant_id: tenantId,
          alias,
          revision,
          recorded_generation: recorded,
          live_generation: live,
        });
      } catch (error) {
        malformed.push({
          tenant_id: label(row.tenant_id),
          alias: label(row.alias),
          reason: error instanceof Error ? error.message : 'unreadable profile runtime expectation',
        });
      }
    }
    return {
      stale, malformed, unobserved,
      truncated: result.rows.length > MAX_SCANNED_EXPECTATIONS,
    };
  });
}

const profileDocumentsFunctionBody = `
DECLARE
  document jsonb;
  document_count integer;
BEGIN
  IF jsonb_typeof(candidate) IS DISTINCT FROM 'array' THEN
    RETURN false;
  END IF;
  document_count := jsonb_array_length(candidate);
  IF document_count NOT BETWEEN 1 AND 7 THEN
    RETURN false;
  END IF;
  FOR document IN SELECT value FROM jsonb_array_elements(candidate) LOOP
    IF jsonb_typeof(document) IS DISTINCT FROM 'object'
       OR (SELECT count(*) FROM jsonb_object_keys(document)) <> 3
       OR NOT document ?& ARRAY['name','path','sha']
       OR (document->>'name') !~ '^[A-Za-z0-9._-]{1,128}$'
       OR char_length(document->>'path') NOT BETWEEN 1 AND 4096
       OR left(document->>'path', 1) <> '/'
       OR regexp_replace(document->>'path', '^.*/', '') <> document->>'name'
       OR (document->>'sha') !~ '^[a-f0-9]{64}$' THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN (SELECT count(DISTINCT value->>'name') = document_count
                  AND count(DISTINCT value->>'path') = document_count
            FROM jsonb_array_elements(candidate));
END
`;

const profileAdoptionTriggerFunctionBody = `
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM agent_profile_runtime_expectations expectation
     WHERE expectation.tenant_id=NEW.tenant_id
       AND expectation.alias=NEW.alias
       AND expectation.revision=NEW.revision
       AND expectation.generation=NEW.generation
       AND expectation.documents=NEW.documents
  ) THEN
    RAISE EXCEPTION 'runtime profile adoption does not match the current expectation'
      USING ERRCODE='23514', CONSTRAINT='agent_profile_runtime_adoptions_expectation';
  END IF;
  RETURN NEW;
END
`;

/** Proves schema-035 topology and privileges read-only with impossible identity keys. */
export async function probeProfileRuntimePath(pool: DatabasePool): Promise<void> {
  await probeSchemaContract(pool, {
    name: 'schema-035 profile runtime',
    required: [
      'migration_applied', 'columns_exact', 'constraints_exact',
      'functions_exact', 'triggers_exact', 'mutation_permissions',
    ],
    params: [profileDocumentsFunctionBody, profileAdoptionTriggerFunctionBody],
    sql: `WITH expected_columns(table_name,position,name,type_name,default_expression) AS (VALUES
         ('agent_profile_runtime_expectations',1,'tenant_id','text',NULL::text),
         ('agent_profile_runtime_expectations',2,'alias','text',NULL::text),
         ('agent_profile_runtime_expectations',3,'revision','bigint',NULL::text),
         ('agent_profile_runtime_expectations',4,'generation','text',NULL::text),
         ('agent_profile_runtime_expectations',5,'documents','jsonb',NULL::text),
         ('agent_profile_runtime_expectations',6,'recorded_at','timestamp with time zone','clock_timestamp()'),
         ('agent_profile_runtime_expectations',7,'updated_at','timestamp with time zone','clock_timestamp()'),
         ('agent_profile_runtime_adoptions',1,'tenant_id','text',NULL::text),
         ('agent_profile_runtime_adoptions',2,'alias','text',NULL::text),
         ('agent_profile_runtime_adoptions',3,'revision','bigint',NULL::text),
         ('agent_profile_runtime_adoptions',4,'generation','text',NULL::text),
         ('agent_profile_runtime_adoptions',5,'documents','jsonb',NULL::text),
         ('agent_profile_runtime_adoptions',6,'delivery_id','uuid',NULL::text),
         ('agent_profile_runtime_adoptions',7,'attempt','integer',NULL::text),
         ('agent_profile_runtime_adoptions',8,'instance_id','text',NULL::text),
         ('agent_profile_runtime_adoptions',9,'epoch','bigint',NULL::text),
         ('agent_profile_runtime_adoptions',10,'adopted_at','timestamp with time zone','clock_timestamp()')
       ), checked_columns AS (
         SELECT count(attribute.attname)=17
                AND bool_and(attribute.attnum=expected.position)
                AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
                AND bool_and(attribute.attnotnull)
                AND bool_and(attribute.attidentity='')
                AND bool_and(attribute.attgenerated='')
                AND bool_and(
                  pg_get_expr(definition.adbin,definition.adrelid)
                    IS NOT DISTINCT FROM expected.default_expression
                )
                AND (
                  SELECT count(*)=17 FROM pg_attribute actual
                   WHERE actual.attrelid IN (
                     'public.agent_profile_runtime_expectations'::regclass,
                     'public.agent_profile_runtime_adoptions'::regclass
                   ) AND actual.attnum>0 AND NOT actual.attisdropped
                ) AS exact
           FROM expected_columns expected
           LEFT JOIN pg_attribute attribute
             ON attribute.attrelid=('public.'||expected.table_name)::regclass
            AND attribute.attname=expected.name AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef definition
             ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
       ), expected_constraints(table_name,name,type_name,no_inherit,definition) AS (VALUES
         ('agent_profile_runtime_expectations','agent_profile_runtime_expectations_revision_check','c',false,'CHECK (revision > 0)'),
         ('agent_profile_runtime_expectations','agent_profile_runtime_expectations_generation_check','c',false,'CHECK (generation <> ''''::text AND char_length(generation) <= 128)'),
         ('agent_profile_runtime_expectations','agent_profile_runtime_expectations_documents_valid','c',false,'CHECK (cauce_profile_runtime_documents_valid(documents))'),
         ('agent_profile_runtime_expectations','agent_profile_runtime_expectations_pkey','p',true,'PRIMARY KEY (tenant_id, alias)'),
         ('agent_profile_runtime_expectations','agent_profile_runtime_expectations_tenant_id_alias_fkey','f',true,'FOREIGN KEY (tenant_id, alias) REFERENCES agent_profiles(tenant_id, alias) ON DELETE CASCADE'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_revision_check','c',false,'CHECK (revision > 0)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_generation_check','c',false,'CHECK (generation <> ''''::text AND char_length(generation) <= 128)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_documents_valid','c',false,'CHECK (cauce_profile_runtime_documents_valid(documents))'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_attempt_check','c',false,'CHECK (attempt > 0)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_instance_id_check','c',false,'CHECK (instance_id <> ''''::text AND char_length(instance_id) <= 128)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_epoch_check','c',false,'CHECK (epoch > 0)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_pkey','p',true,'PRIMARY KEY (tenant_id, alias, revision, generation)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_delivery_id_key','u',true,'UNIQUE (delivery_id)'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_tenant_id_alias_fkey','f',true,'FOREIGN KEY (tenant_id, alias) REFERENCES agent_profiles(tenant_id, alias) ON DELETE CASCADE'),
         ('agent_profile_runtime_adoptions','agent_profile_runtime_adoptions_delivery_id_fkey','f',true,'FOREIGN KEY (delivery_id) REFERENCES deliveries(id) ON DELETE RESTRICT')
       ), checked_constraints AS (
         SELECT count(constraint_record.oid)=15
                AND bool_and(constraint_record.contype::text=expected.type_name)
                AND bool_and(constraint_record.convalidated)
                AND bool_and(NOT constraint_record.condeferrable)
                AND bool_and(NOT constraint_record.condeferred)
                AND bool_and(constraint_record.connoinherit=expected.no_inherit)
                AND bool_and(pg_get_constraintdef(constraint_record.oid,true)=expected.definition)
                AND bool_and(
                  CASE WHEN expected.type_name IN ('p','u') THEN
                    index_record.indisunique AND index_record.indisvalid
                    AND index_record.indisready AND index_record.indislive
                    AND index_record.indpred IS NULL AND index_record.indexprs IS NULL
                  ELSE true END
                )
                AND (
                  SELECT count(*)=15 FROM pg_constraint actual
                   WHERE actual.conrelid IN (
                     'public.agent_profile_runtime_expectations'::regclass,
                     'public.agent_profile_runtime_adoptions'::regclass
                   )
                ) AS exact
           FROM expected_constraints expected
           LEFT JOIN pg_constraint constraint_record
             ON constraint_record.conrelid=('public.'||expected.table_name)::regclass
            AND constraint_record.conname=expected.name
           LEFT JOIN pg_index index_record
             ON index_record.indexrelid=constraint_record.conindid
       ), expected_functions(name,arguments,result,language,volatility,parallel_mode,body) AS (VALUES
         ('cauce_profile_runtime_documents_valid','candidate jsonb','boolean','plpgsql','i','s',$1::text),
         ('cauce_profile_runtime_adoption_matches_expectation','','trigger','plpgsql','v','u',$2::text)
       ), checked_functions AS (
         SELECT count(function_record.oid)=2
                AND bool_and(pg_get_function_identity_arguments(function_record.oid)=expected.arguments)
                AND bool_and(pg_get_function_result(function_record.oid)=expected.result)
                AND bool_and(language_record.lanname=expected.language)
                AND bool_and(function_record.provolatile::text=expected.volatility)
                AND bool_and(function_record.proparallel::text=expected.parallel_mode)
                AND bool_and(NOT function_record.prosecdef)
                AND bool_and(NOT function_record.proleakproof)
                AND bool_and(NOT function_record.proisstrict)
                AND bool_and(NOT function_record.proretset)
                AND bool_and(function_record.prokind='f')
                AND bool_and(function_record.pronargdefaults=0)
                AND bool_and(function_record.proconfig IS NULL)
                AND bool_and(function_record.prosrc=expected.body)
                AND (
                  SELECT count(*)=2 FROM pg_proc actual
                   JOIN pg_namespace namespace_record ON namespace_record.oid=actual.pronamespace
                  WHERE namespace_record.nspname='public'
                    AND actual.proname IN (
                      'cauce_profile_runtime_documents_valid',
                      'cauce_profile_runtime_adoption_matches_expectation'
                    )
                ) AS exact
           FROM expected_functions expected
           LEFT JOIN pg_proc function_record ON function_record.proname=expected.name
           LEFT JOIN pg_namespace namespace_record
             ON namespace_record.oid=function_record.pronamespace
            AND namespace_record.nspname='public'
           LEFT JOIN pg_language language_record ON language_record.oid=function_record.prolang
          WHERE namespace_record.oid IS NOT NULL
       ), checked_triggers AS (
         SELECT
           EXISTS (
             SELECT 1 FROM pg_trigger trigger_record
              WHERE trigger_record.tgrelid='public.agent_profile_runtime_adoptions'::regclass
                AND trigger_record.tgname='agent_profile_runtime_adoptions_expectation_guard'
                AND NOT trigger_record.tgisinternal AND trigger_record.tgenabled='O'
                AND pg_get_triggerdef(trigger_record.oid,true)=
                  'CREATE TRIGGER agent_profile_runtime_adoptions_expectation_guard BEFORE INSERT OR UPDATE ON agent_profile_runtime_adoptions FOR EACH ROW EXECUTE FUNCTION cauce_profile_runtime_adoption_matches_expectation()'
           )
           AND (
             SELECT count(*)=1 FROM pg_trigger trigger_record
              WHERE trigger_record.tgrelid IN (
                'public.agent_profile_runtime_expectations'::regclass,
                'public.agent_profile_runtime_adoptions'::regclass
              ) AND NOT trigger_record.tgisinternal
           )
           AND (
             SELECT count(*)=12 AND bool_and(trigger_record.tgisinternal)
                              AND bool_and(trigger_record.tgenabled='O')
               FROM pg_trigger trigger_record
              WHERE trigger_record.tgconstraint IN (
                SELECT constraint_record.oid FROM pg_constraint constraint_record
                 WHERE constraint_record.conrelid IN (
                   'public.agent_profile_runtime_expectations'::regclass,
                   'public.agent_profile_runtime_adoptions'::regclass
                 ) AND constraint_record.contype='f'
              )
           ) AS exact
       )
       SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='035_agent_profile_runtime_adoption.sql'
         ) AS migration_applied,
         COALESCE((SELECT exact FROM checked_columns),false) AS columns_exact,
         COALESCE((SELECT exact FROM checked_constraints),false) AS constraints_exact,
         COALESCE((SELECT exact FROM checked_functions),false) AS functions_exact,
         COALESCE((SELECT exact FROM checked_triggers),false) AS triggers_exact,
         has_table_privilege(current_user,'public.schema_migrations','SELECT')
           AND has_table_privilege(current_user,'public.agent_profile_runtime_expectations','SELECT')
           AND has_table_privilege(current_user,'public.agent_profile_runtime_expectations','INSERT')
           AND has_table_privilege(current_user,'public.agent_profile_runtime_expectations','UPDATE')
           AND has_table_privilege(current_user,'public.agent_profile_runtime_adoptions','SELECT')
           AND has_table_privilege(current_user,'public.agent_profile_runtime_adoptions','INSERT')
           AND has_table_privilege(current_user,'public.agent_profiles','SELECT')
           AND has_table_privilege(current_user,'public.agent_profiles','UPDATE')
           AND has_table_privilege(current_user,'public.deliveries','SELECT')
           AND has_table_privilege(current_user,'public.audit_events','INSERT')
           AND COALESCE(has_sequence_privilege(
             current_user,pg_get_serial_sequence('public.audit_events','id'),'USAGE'
           ),false)
           AND has_function_privilege(
             current_user,'public.cauce_profile_runtime_documents_valid(jsonb)','EXECUTE'
           )
           AND has_function_privilege(
             current_user,'public.cauce_profile_runtime_adoption_matches_expectation()','EXECUTE'
           ) AS mutation_permissions`,
    after: async (client) => {
      const behavior = await client.query<{ documents_contract: boolean }>(
        `WITH requested(tenant_id,alias,revision,generation,delivery_id) AS (
         VALUES(NULL::text,NULL::text,NULL::bigint,NULL::text,NULL::uuid)
       ), documents AS (
         SELECT
           cauce_profile_runtime_documents_valid(
             '[{"name":"AGENTS.md","path":"/profiles/AGENTS.md","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}]'::jsonb
           )
           AND NOT cauce_profile_runtime_documents_valid('[]'::jsonb) AS valid
       )
       SELECT documents.valid
              AND NOT EXISTS (
                SELECT 1 FROM requested
                 JOIN agent_profile_runtime_expectations expectation
                   ON expectation.tenant_id=requested.tenant_id
                  AND expectation.alias=requested.alias
                  AND expectation.revision=requested.revision
                  AND expectation.generation=requested.generation
                 JOIN agent_profile_runtime_adoptions adoption
                   ON adoption.tenant_id=expectation.tenant_id
                  AND adoption.alias=expectation.alias
                  AND adoption.revision=expectation.revision
                  AND adoption.generation=expectation.generation
                  AND adoption.documents=expectation.documents
                  AND adoption.delivery_id=requested.delivery_id
                 JOIN agent_profiles profile
                   ON profile.tenant_id=expectation.tenant_id
                  AND profile.alias=expectation.alias
                  AND profile.revision=expectation.revision
              ) AS documents_contract
         FROM documents`,
      );
      if (behavior.rows[0]?.documents_contract !== true) {
        throw new Error('gateway schema-035 profile runtime behavior is unavailable');
      }
    },
  });
}

import { withTransaction, type DatabasePool } from '@cauce/store';

interface ShadowTargetPhaseSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraint_exact: boolean;
  readonly functions_exact: boolean;
  readonly triggers_exact: boolean;
  readonly phase_permissions: boolean;
}

// These digests bind readiness to the independently reviewed definitions installed by migration
// 036. They are regenerated only when that migration's contract changes and are exercised against
// PostgreSQL 16 in health-progress.test.ts; relation/object names alone are not accepted as green.
const shadowClaimPhaseConstraintSha256 = '3744b38b5e27f0def89f983afce9987b6bfb225a120dbec432fdb426008a262c';
const shadowClaimPhaseFunctionSha256 = '7c24fde424d76277733cb0403399378cc88942a186fff9754afa3355fc11f54c';
const shadowMappingMonotonicFunctionSha256 = 'ce8ca46fd783f4d05d00ce59fad7d08c2ebf26bfd8c47c38b3082b4164dc84fa';
const shadowMappingReconcileFunctionSha256 = '12c9f73d21b93bdf6f283b156c35590ccd082183f69833d3b245123166ae7eb5';

/**
 * Proves the schema-036 target-dispatch accounting contract without claiming an inbox row. The
 * final NULL-sentinel query resolves the same phase, lease and mapping columns used by the router,
 * while READ ONLY prevents a future accidental mutation from turning readiness into a writer.
 */
export async function probeShadowTargetPhasePath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<ShadowTargetPhaseSchemaProbeRow>(
      `WITH expected_columns(position,name,type_name,not_null,default_expression) AS (VALUES
         (18,'claim_target_started','boolean',true,'false'::text)
       ), checked_columns AS (
         SELECT count(attribute.attname)=1
                AND bool_and(attribute.attnum=expected.position)
                AND bool_and(format_type(attribute.atttypid,attribute.atttypmod)=expected.type_name)
                AND bool_and(attribute.attnotnull=expected.not_null)
                AND bool_and(attribute.attidentity='')
                AND bool_and(attribute.attgenerated='')
                AND bool_and(
                  pg_get_expr(definition.adbin,definition.adrelid)
                    IS NOT DISTINCT FROM expected.default_expression
                )
                AND (
                  SELECT count(*)=18 FROM pg_attribute actual
                   WHERE actual.attrelid='public.shadow_router_inbox'::regclass
                     AND actual.attnum>0 AND NOT actual.attisdropped
                ) AS exact
           FROM expected_columns expected
           LEFT JOIN pg_attribute attribute
             ON attribute.attrelid='public.shadow_router_inbox'::regclass
            AND attribute.attname=expected.name AND NOT attribute.attisdropped
           LEFT JOIN pg_attrdef definition
             ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
       ), phase_constraint AS (
         SELECT constraint_record.oid,constraint_record.convalidated,
                constraint_record.connoinherit,
                encode(digest(convert_to(
                  pg_get_constraintdef(constraint_record.oid,true),'UTF8'
                ),'sha256'),'hex') AS definition_sha256
           FROM pg_constraint constraint_record
          WHERE constraint_record.conrelid='public.shadow_router_inbox'::regclass
            AND constraint_record.conname='shadow_router_inbox_claim_phase_shape'
            AND constraint_record.contype='c'
       ), expected_functions(name,body_sha256) AS (VALUES
         ('cauce_shadow_router_claim_phase_transition',$2::text),
         ('cauce_shadow_router_mapping_status_monotonic',$3::text),
         ('cauce_shadow_router_mapping_terminal_reconcile',$4::text)
       ), checked_functions AS (
         SELECT count(procedure.oid)=3
                AND bool_and(procedure.prorettype='trigger'::regtype)
                AND bool_and(procedure.provolatile='v' AND procedure.proparallel='u')
                AND bool_and(NOT procedure.prosecdef AND NOT procedure.proleakproof)
                AND bool_and(NOT procedure.proisstrict AND NOT procedure.proretset)
                AND bool_and(procedure.prokind='f' AND procedure.pronargdefaults=0)
                AND bool_and(procedure.proconfig IS NULL)
                AND bool_and(language_record.lanname='plpgsql')
                AND bool_and(pg_get_function_identity_arguments(procedure.oid)='')
                AND bool_and(encode(digest(convert_to(procedure.prosrc,'UTF8'),'sha256'),'hex')
                  =expected.body_sha256) AS exact
           FROM expected_functions expected
           LEFT JOIN pg_proc procedure
             ON procedure.pronamespace='public'::regnamespace
            AND procedure.proname=expected.name
           LEFT JOIN pg_language language_record ON language_record.oid=procedure.prolang
       ), expected_triggers(table_name,name,definition) AS (VALUES
         ('shadow_router_inbox','shadow_router_inbox_claim_phase_transition',
          'CREATE TRIGGER shadow_router_inbox_claim_phase_transition BEFORE UPDATE ON shadow_router_inbox FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_claim_phase_transition()'),
         ('shadow_router_mappings','shadow_router_mapping_status_monotonic',
          'CREATE TRIGGER shadow_router_mapping_status_monotonic BEFORE UPDATE OF status ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_status_monotonic()'),
         ('shadow_router_mappings','shadow_router_mapping_terminal_reconcile',
          'CREATE TRIGGER shadow_router_mapping_terminal_reconcile AFTER INSERT OR UPDATE ON shadow_router_mappings FOR EACH ROW EXECUTE FUNCTION cauce_shadow_router_mapping_terminal_reconcile()')
       ), checked_triggers AS (
         SELECT count(trigger_record.oid)=3
                AND bool_and(trigger_record.tgenabled='O')
                AND bool_and(NOT trigger_record.tgisinternal)
                AND bool_and(pg_get_triggerdef(trigger_record.oid,true)=expected.definition) AS exact
           FROM expected_triggers expected
           LEFT JOIN pg_trigger trigger_record
             ON trigger_record.tgrelid=('public.'||expected.table_name)::regclass
            AND trigger_record.tgname=expected.name
       )
       SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='036_shadow_router_target_phase.sql'
         ) AS migration_applied,
         COALESCE((SELECT exact FROM checked_columns),false) AS columns_exact,
         EXISTS (
           SELECT 1 FROM phase_constraint
            WHERE convalidated AND NOT connoinherit AND definition_sha256=$1
         ) AND (SELECT count(*)=1 FROM phase_constraint) AS constraint_exact,
         COALESCE((SELECT exact FROM checked_functions),false) AS functions_exact,
         COALESCE((SELECT exact FROM checked_triggers),false) AS triggers_exact,
         has_table_privilege(current_user,'public.schema_migrations','SELECT')
           AND has_table_privilege(current_user,'public.shadow_router_inbox','SELECT')
           AND has_table_privilege(current_user,'public.shadow_router_inbox','INSERT')
           AND has_table_privilege(current_user,'public.shadow_router_inbox','UPDATE')
           AND has_table_privilege(current_user,'public.shadow_router_mappings','SELECT')
           AND has_table_privilege(current_user,'public.shadow_router_mappings','INSERT')
           AND has_table_privilege(current_user,'public.shadow_router_mappings','UPDATE')
           AND has_function_privilege(
             current_user,'public.cauce_shadow_router_claim_phase_transition()','EXECUTE'
           )
           AND has_function_privilege(
             current_user,'public.cauce_shadow_router_mapping_status_monotonic()','EXECUTE'
           )
           AND has_function_privilege(
             current_user,'public.cauce_shadow_router_mapping_terminal_reconcile()','EXECUTE'
           )
           AND has_function_privilege(current_user,'gen_random_uuid()','EXECUTE')
           AS phase_permissions`,
      [
        shadowClaimPhaseConstraintSha256,
        shadowClaimPhaseFunctionSha256,
        shadowMappingMonotonicFunctionSha256,
        shadowMappingReconcileFunctionSha256,
      ],
    );
    const contract = schema.rows[0];
    if (contract?.migration_applied !== true || contract.columns_exact !== true
        || contract.constraint_exact !== true || contract.functions_exact !== true
        || contract.triggers_exact !== true || contract.phase_permissions !== true) {
      throw new Error('gateway schema-036 shadow target phase contract is unavailable');
    }
    const behavior = await client.query<{ phase_contract: boolean }>(
      `WITH requested(id,claim_token,prospective_attempt) AS (
         VALUES(NULL::uuid,NULL::uuid,NULL::integer)
       )
       SELECT NOT EXISTS (
         SELECT 1 FROM requested
         JOIN shadow_router_inbox inbox ON inbox.id=requested.id
          AND inbox.status='processing' AND inbox.claim_token=requested.claim_token
          AND inbox.claim_expires_at>now()
          AND inbox.attempts=requested.prospective_attempt-1
          AND inbox.attempts<inbox.max_attempts
          AND inbox.claim_target_started IN (false,true)
         LEFT JOIN shadow_router_mappings mapping
           ON mapping.direction=inbox.direction
          AND mapping.source_event_id=inbox.source_event_id
          AND mapping.status IN ('shadowed','compared','delivered','blocked')
       ) AS phase_contract`,
    );
    if (behavior.rows[0]?.phase_contract !== true) {
      throw new Error('gateway schema-036 shadow target phase behavior is unavailable');
    }
  });
}

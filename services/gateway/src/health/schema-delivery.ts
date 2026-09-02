import { withTransaction, type DatabasePool } from '@cauce/store';
import { isLiteralTrue } from '@cauce/protocol';

interface DeliveryAdmissionSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly capacity_column_exact: boolean;
  readonly capacity_constraint_valid: boolean;
  readonly inflight_index_valid: boolean;
  readonly claim_permissions: boolean;
}

/** Proves the schema and authority used by `claimDeliveries` without observing an identity. */
export async function probeDeliveryAdmissionPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<DeliveryAdmissionSchemaProbeRow>(
      `SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='015_delivery_concurrency_cap.sql'
         ) AS migration_applied,
         EXISTS (
           SELECT 1
             FROM pg_attribute attribute
             JOIN pg_attrdef definition
               ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
            WHERE attribute.attrelid='public.agents'::regclass
              AND attribute.attname='max_concurrent_deliveries'
              AND attribute.atttypid='integer'::regtype
              AND NOT attribute.attnotnull AND NOT attribute.attisdropped
              AND pg_get_expr(definition.adbin,definition.adrelid)='2'
         ) AS capacity_column_exact,
         EXISTS (
           SELECT 1 FROM pg_constraint constraint_
            WHERE constraint_.conrelid='public.agents'::regclass
              AND constraint_.conname='agents_max_concurrent_deliveries_sane'
              AND constraint_.contype='c' AND constraint_.convalidated
              AND pg_get_constraintdef(constraint_.oid) LIKE '%max_concurrent_deliveries IS NULL%'
              AND pg_get_constraintdef(constraint_.oid) LIKE '%max_concurrent_deliveries >= 1%'
              AND pg_get_constraintdef(constraint_.oid) LIKE '%max_concurrent_deliveries <= 100%'
         ) AS capacity_constraint_valid,
         EXISTS (
           SELECT 1
             FROM pg_class index_
             JOIN pg_index metadata ON metadata.indexrelid=index_.oid
            WHERE index_.relname='deliveries_inflight_by_recipient_idx'
              AND metadata.indrelid='public.deliveries'::regclass
              AND metadata.indisvalid AND metadata.indisready
              AND pg_get_indexdef(index_.oid) LIKE '%recipient_tenant, recipient_alias%'
              AND pg_get_expr(metadata.indpred,metadata.indrelid)
                    LIKE '%status = ANY%leased%accepted%started%'
         ) AS inflight_index_valid,
         has_table_privilege(current_user,'public.agents','SELECT')
           AND has_table_privilege(current_user,'public.memberships','SELECT')
           AND has_table_privilege(current_user,'public.role_policies','SELECT')
           AND has_table_privilege(current_user,'public.tenants','SELECT')
           AND has_table_privilege(current_user,'public.rooms','SELECT')
           AND has_table_privilege(current_user,'public.acl_edges','SELECT')
           AND has_table_privilege(current_user,'public.connection_leases','SELECT')
           AND has_table_privilege(current_user,'public.connection_leases','UPDATE')
           AND has_table_privilege(current_user,'public.delivery_lane_fairness','SELECT')
           AND has_table_privilege(current_user,'public.delivery_lane_fairness','INSERT')
           AND has_table_privilege(current_user,'public.delivery_lane_fairness','UPDATE')
           AND has_table_privilege(current_user,'public.deliveries','SELECT')
           AND has_table_privilege(current_user,'public.deliveries','UPDATE')
           AND has_table_privilege(current_user,'public.messages','SELECT')
           AND has_function_privilege(current_user,'gen_random_uuid()','EXECUTE')
           AS claim_permissions`,
    );
    const contract = schema.rows[0];
    if (!isLiteralTrue(contract?.migration_applied)
        || !isLiteralTrue(contract?.capacity_column_exact)
        || !isLiteralTrue(contract?.capacity_constraint_valid)
        || !isLiteralTrue(contract?.inflight_index_valid)
        || !isLiteralTrue(contract?.claim_permissions)) {
      throw new Error('gateway schema-015 delivery admission contract is unavailable');
    }
    await client.query(
      `WITH requested(tenant_id,alias,human_floor) AS (
         VALUES(NULL::text,NULL::text,60::integer)
       )
       SELECT agent.max_concurrent_deliveries,fairness.interactive_streak,
              lease.connection_token,
              (SELECT bool_or(policy.allow_route)
                 FROM memberships membership
                 JOIN role_policies policy ON policy.role=membership.role
                 JOIN tenants tenant ON tenant.id=membership.tenant_id
                 JOIN rooms room
                   ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
                WHERE membership.tenant_id=requested.tenant_id
                  AND membership.alias=requested.alias
                  AND membership.enabled AND tenant.enabled AND room.enabled
                  AND (
                    membership.tenant_id=requested.tenant_id
                    OR EXISTS (
                      SELECT 1 FROM acl_edges edge
                      JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
                      WHERE edge.from_tenant=requested.tenant_id
                        AND edge.to_tenant=membership.tenant_id
                        AND edge.enabled AND edge.allow_route
                        AND source_tenant.enabled
                        AND (source_tenant.is_hub OR tenant.is_hub)
                    )
                  )) AS route_allowed,
              (SELECT count(*) FROM deliveries delivery
                WHERE delivery.recipient_tenant=requested.tenant_id
                  AND delivery.recipient_alias=requested.alias
                  AND delivery.status IN ('leased','accepted','started')
                  AND delivery.claim_token IS NOT NULL
                  AND delivery.ack_deadline_at IS NOT NULL
                  AND delivery.ack_deadline_at>now()) AS live_claims,
              (SELECT count(*) FROM deliveries delivery
                 JOIN messages message ON message.id=delivery.message_id
                WHERE delivery.recipient_tenant=requested.tenant_id
                  AND delivery.recipient_alias=requested.alias
                  AND delivery.status IN ('leased','accepted','started')
                  AND delivery.claim_token IS NOT NULL
                  AND delivery.ack_deadline_at IS NOT NULL
                  AND delivery.ack_deadline_at>now()
                  AND message.priority>=requested.human_floor) AS live_human_claims
         FROM requested
         LEFT JOIN agents agent
           ON agent.tenant_id=requested.tenant_id AND agent.alias=requested.alias
         LEFT JOIN delivery_lane_fairness fairness
           ON fairness.tenant_id=requested.tenant_id AND fairness.alias=requested.alias
         LEFT JOIN connection_leases lease
           ON lease.tenant_id=requested.tenant_id AND lease.alias=requested.alias
          AND lease.connection_token=NULL::uuid`,
    );
  });
}

interface WakeSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly connection_token_exact: boolean;
  readonly claim_permissions: boolean;
}

/**
 * Probes the SQL and effective privileges needed by the schema-031 wake claim without requiring
 * a connected recipient and without locking, claiming or changing a row. The read-only
 * transaction is a second guard in case a future edit accidentally adds a mutating statement.
 */
export async function probeWakePath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<WakeSchemaProbeRow>(
      `SELECT
         EXISTS (
           SELECT 1 FROM schema_migrations
            WHERE version='031_connection_session_fencing.sql'
         ) AS migration_applied,
         EXISTS (
           SELECT 1
             FROM pg_attribute attribute
             JOIN pg_attrdef definition
               ON definition.adrelid=attribute.attrelid AND definition.adnum=attribute.attnum
            WHERE attribute.attrelid='connection_leases'::regclass
              AND attribute.attname='connection_token'
              AND attribute.atttypid='uuid'::regtype
              AND attribute.attnotnull
              AND NOT attribute.attisdropped
              AND pg_get_expr(definition.adbin,definition.adrelid)='gen_random_uuid()'
         ) AS connection_token_exact,
         has_table_privilege(current_user,'connection_leases','SELECT')
           AND has_table_privilege(current_user,'connection_leases','UPDATE')
           AND has_table_privilege(current_user,'adapter_outbox','SELECT')
           AND has_table_privilege(current_user,'adapter_outbox','UPDATE')
           AND has_table_privilege(current_user,'outbox_dead_letters','INSERT')
           AND has_function_privilege(current_user,'gen_random_uuid()','EXECUTE')
           AS claim_permissions`
    );
    const contract = schema.rows[0];
    if (!isLiteralTrue(contract?.migration_applied)
        || !isLiteralTrue(contract?.connection_token_exact)
        || !isLiteralTrue(contract?.claim_permissions)) {
      throw new Error('gateway wake schema-031 claim contract is unavailable');
    }
    // This is the read-only half of claimWakeOutbox's fenced claim. A NULL recipient cannot match
    // the NOT NULL lease key, so the probe is independent of the live session set and cannot read
    // an identity. PostgreSQL still parses, plans and authorizes every table, column, JSON
    // expression, UUID comparison and ordering expression used by claim/retirement.
    await client.query(
      `WITH requested(
         tenant_id,alias,instance_id,epoch,connection_token,recipient_order
       ) AS (VALUES (NULL::text,NULL::text,NULL::text,NULL::bigint,NULL::uuid,0::integer))
       SELECT 1
         FROM requested
         JOIN connection_leases lease
           ON lease.tenant_id=requested.tenant_id AND lease.alias=requested.alias
          AND lease.instance_id=requested.instance_id AND lease.epoch=requested.epoch
          AND lease.connection_token=requested.connection_token AND lease.lease_until>now()
         JOIN LATERAL (
           SELECT outbox.id,outbox.tenant_id,outbox.adapter,outbox.kind,outbox.request_id,
                  outbox.message_id,outbox.delivery_id,outbox.trace_id,outbox.origin,outbox.payload,
                  outbox.status,outbox.attempts,outbox.max_attempts,outbox.available_at,
                  outbox.claimed_at,outbox.claimed_by,outbox.claim_token,outbox.claim_expires_at,
                  outbox.last_error,outbox.dead_at,outbox.created_at
             FROM adapter_outbox outbox
            WHERE outbox.kind='wake' AND outbox.tenant_id=requested.tenant_id
              AND outbox.payload->>'recipient_alias'=requested.alias
              AND (
                (outbox.status IN ('pending','failed') AND outbox.available_at<=now())
                OR (outbox.status='processing'
                    AND COALESCE(
                      outbox.claim_expires_at,outbox.claimed_at,outbox.created_at
                    )<=now())
              )
              AND outbox.attempts<outbox.max_attempts
            ORDER BY CASE WHEN outbox.status='processing'
                          THEN outbox.claim_expires_at ELSE outbox.available_at END,
                     outbox.created_at
            LIMIT 1
         ) candidate ON true
         LEFT JOIN LATERAL (
           SELECT dead.outbox_id
             FROM outbox_dead_letters dead
            WHERE dead.outbox_id=candidate.id AND dead.tenant_id=candidate.tenant_id
              AND dead.adapter=candidate.adapter AND dead.kind=candidate.kind
              AND dead.reason=candidate.last_error AND dead.payload=candidate.payload
              AND dead.attempts=candidate.attempts
            LIMIT 1
         ) dead_letter ON true
        ORDER BY requested.recipient_order
        LIMIT 1`,
    );
  });
}

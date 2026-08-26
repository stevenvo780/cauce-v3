import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { withTransaction, type DatabasePool } from '@cauce/store';
import type { WakePumpTelemetry } from './wake-pump-telemetry.js';
import {
  consolePublishTelemetryVocabulary, type ConsolePublishTelemetry,
} from './console-publish-telemetry.js';

export interface HealthOptions {
  pool: DatabasePool;
  logger?: boolean;
  requirePostgresTls?: boolean;
  /** The externally-facing data listener, distinct from the loopback health server. */
  dataApp?: Pick<FastifyInstance, 'server'>;
  /** A bounded, non-mutating probe of the tables used by the delivery ACK transaction. */
  ackProbe?: () => Promise<void>;
  /** Test override; production probes schema-015 delivery admission and its effective privileges. */
  deliveryAdmissionProbe?: () => Promise<void>;
  /** Aggregate, identity-free progress of the durable wake pump. */
  wakePumpTelemetry?: Pick<WakePumpTelemetry, 'snapshot'>;
  /** Aggregate, identity-free outcomes of the durable console publish protocol. */
  consolePublishTelemetry?: Pick<ConsolePublishTelemetry, 'snapshot'>;
  /**
   * Override for tests. Production deliberately omits it so readiness executes the concrete,
   * read-only schema-031 wake probe against the same pool as the pump.
   */
  wakeProbe?: () => Promise<void>;
  /** Test override; production probes schema-032 and its exact-fence CAS read-only. */
  terminalClaimProbe?: () => Promise<void>;
  /** Test override; production probes schema-033 browser admission and owner fencing. */
  terminalBrowserOwnerProbe?: () => Promise<void>;
  /** Test override; production probes schema-034 authenticated relay routing fences. */
  terminalRelayInstanceProbe?: () => Promise<void>;
  /** Test override; production probes schema-035 runtime profile expectations and adoption. */
  profileRuntimeProbe?: () => Promise<void>;
  /** Test override; production probes schema-036 shadow dispatch phase accounting. */
  shadowTargetPhaseProbe?: () => Promise<void>;
  /** Test override; production probes schema-037's durable console publish journal indexes. */
  consolePublishIntentProbe?: () => Promise<void>;
  /** How long a core wake cycle may go without a clean completion before readiness fails. */
  wakePumpMaxStaleMs?: number;
}

const wakeOutcomes = ['sent', 'retry', 'dead', 'fenced', 'error', 'cancelled'] as const;
const wakeStates = ['idle', 'running', 'stopping'] as const;

function metricValue(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`gateway wake telemetry returned an invalid ${label} counter`);
  }
  return value;
}

/** Prometheus text with a fixed label vocabulary and no tenant, alias, event or claim identity. */
export function renderWakePumpMetrics(
  telemetry: Pick<WakePumpTelemetry, 'snapshot'>
): string {
  const snapshot = telemetry.snapshot();
  if (!wakeStates.includes(snapshot.state)) {
    throw new Error('gateway wake telemetry returned an invalid state');
  }
  if (snapshot.lastProgressAtMs !== null
      && (!Number.isFinite(snapshot.lastProgressAtMs) || snapshot.lastProgressAtMs < 0)) {
    throw new Error('gateway wake telemetry returned an invalid progress timestamp');
  }
  if (snapshot.lastSuccessAtMs !== null
      && (!Number.isFinite(snapshot.lastSuccessAtMs) || snapshot.lastSuccessAtMs < 0)) {
    throw new Error('gateway wake telemetry returned an invalid success timestamp');
  }
  metricValue(snapshot.consecutiveFailures, 'consecutive failures');
  const lines = [
    '# HELP cauce_gateway_wake_pump_state Current wake-pump lifecycle state.',
    '# TYPE cauce_gateway_wake_pump_state gauge',
  ];
  for (const state of wakeStates) {
    lines.push(`cauce_gateway_wake_pump_state{state="${state}"} ${snapshot.state === state ? 1 : 0}`);
  }
  lines.push(
    '# HELP cauce_gateway_wake_pump_last_progress_timestamp_seconds Unix time of the last wake-pump progress.',
    '# TYPE cauce_gateway_wake_pump_last_progress_timestamp_seconds gauge',
    `cauce_gateway_wake_pump_last_progress_timestamp_seconds ${(snapshot.lastProgressAtMs ?? 0) / 1_000}`,
    '# HELP cauce_gateway_wake_pump_last_success_timestamp_seconds Unix time of the last clean wake-pump cycle.',
    '# TYPE cauce_gateway_wake_pump_last_success_timestamp_seconds gauge',
    `cauce_gateway_wake_pump_last_success_timestamp_seconds ${(snapshot.lastSuccessAtMs ?? 0) / 1_000}`,
    '# HELP cauce_gateway_wake_pump_consecutive_failures Consecutive wake-pump cycles with fenced or error outcomes.',
    '# TYPE cauce_gateway_wake_pump_consecutive_failures gauge',
    `cauce_gateway_wake_pump_consecutive_failures ${snapshot.consecutiveFailures}`,
    '# HELP cauce_gateway_wake_pump_cycles_total Completed or attempted wake-pump polling cycles.',
    '# TYPE cauce_gateway_wake_pump_cycles_total counter',
    `cauce_gateway_wake_pump_cycles_total ${metricValue(snapshot.counters.cycles, 'cycles')}`,
    '# HELP cauce_gateway_wake_pump_claimed_total Durable wake events claimed by the gateway.',
    '# TYPE cauce_gateway_wake_pump_claimed_total counter',
    `cauce_gateway_wake_pump_claimed_total ${metricValue(snapshot.counters.claimed, 'claimed')}`,
    '# HELP cauce_gateway_wake_pump_outcomes_total Wake-pump outcomes by bounded result.',
    '# TYPE cauce_gateway_wake_pump_outcomes_total counter',
  );
  for (const result of wakeOutcomes) {
    lines.push(
      `cauce_gateway_wake_pump_outcomes_total{result="${result}"} ${metricValue(snapshot.counters[result], result)}`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Fixed-label console journal counters; no operator or message material reaches Prometheus. */
export function renderConsolePublishMetrics(
  telemetry: Pick<ConsolePublishTelemetry, 'snapshot'>,
): string {
  const counters = telemetry.snapshot();
  const expected = new Set(consolePublishTelemetryVocabulary.map(
    (event) => `${event.operation}:${event.result}`,
  ));
  if (Object.keys(counters).length !== expected.size
      || Object.keys(counters).some((key) => !expected.has(key))) {
    throw new Error('gateway console publish telemetry returned an unknown counter');
  }
  const lines = [
    '# HELP cauce_gateway_console_publish_operations_total Durable console publish protocol request outcomes.',
    '# TYPE cauce_gateway_console_publish_operations_total counter',
  ];
  for (const event of consolePublishTelemetryVocabulary) {
    const key = `${event.operation}:${event.result}`;
    lines.push(
      `cauce_gateway_console_publish_operations_total{operation="${event.operation}",result="${event.result}"} ${metricValue(counters[key] ?? -1, `console publish ${key}`)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function readiness(options: HealthOptions, reply: FastifyReply): Promise<unknown> {
  try {
    await options.pool.query('SELECT 1');
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
  }
  if (options.requirePostgresTls === true) {
    try {
      const encrypted = await options.pool.query<{ ssl: boolean }>(
        'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
      );
      if (encrypted.rows[0]?.ssl !== true) {
        return reply.code(503).send({ status: 'not_ready', reason: 'postgres_tls_required' });
      }
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'postgres_unavailable' });
    }
  }
  if (options.dataApp !== undefined && !options.dataApp.server.listening) {
    return reply.code(503).send({ status: 'not_ready', reason: 'data_listener_down' });
  }
  try {
    await options.ackProbe?.();
  } catch {
    return reply.code(503).send({ status: 'not_ready', reason: 'ack_path_unavailable' });
  }
  if (options.wakePumpTelemetry !== undefined) {
    const maximum = options.wakePumpMaxStaleMs ?? 60_000;
    if (!Number.isSafeInteger(maximum) || maximum < 1) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_configuration_invalid' });
    }
    try {
      await (options.deliveryAdmissionProbe?.() ?? probeDeliveryAdmissionPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'delivery_admission_path_unavailable',
      });
    }
    try {
      await (options.terminalClaimProbe?.() ?? probeTerminalClaimPath(options.pool));
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'terminal_claim_path_unavailable' });
    }
    try {
      await (options.terminalBrowserOwnerProbe?.() ?? probeTerminalBrowserOwnerPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'terminal_browser_owner_path_unavailable',
      });
    }
    try {
      await (options.terminalRelayInstanceProbe?.() ?? probeTerminalRelayInstancePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'terminal_relay_instance_path_unavailable',
      });
    }
    try {
      await (options.profileRuntimeProbe?.() ?? probeProfileRuntimePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'profile_runtime_path_unavailable',
      });
    }
    try {
      await (options.shadowTargetPhaseProbe?.() ?? probeShadowTargetPhasePath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'shadow_target_phase_path_unavailable',
      });
    }
    try {
      await (options.consolePublishIntentProbe?.()
        ?? probeConsolePublishIntentPath(options.pool));
    } catch {
      return reply.code(503).send({
        status: 'not_ready', reason: 'console_publish_intent_path_unavailable',
      });
    }
    try {
      await (options.wakeProbe?.() ?? probeWakePath(options.pool));
    } catch {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_path_unavailable' });
    }
    const snapshot = options.wakePumpTelemetry.snapshot();
    const now = Date.now();
    if (snapshot.state === 'stopping') {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_stopping' });
    }
    if (snapshot.lastProgressAtMs === null) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_not_started' });
    }
    if (!Number.isFinite(snapshot.lastProgressAtMs)
        || snapshot.lastProgressAtMs < 0 || snapshot.lastProgressAtMs > now + maximum
        || now - snapshot.lastProgressAtMs > maximum) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_stalled' });
    }
    if (snapshot.lastSuccessAtMs === null
        || !Number.isFinite(snapshot.lastSuccessAtMs)
        || snapshot.lastSuccessAtMs < 0 || snapshot.lastSuccessAtMs > now + maximum
        || now - snapshot.lastSuccessAtMs > maximum) {
      return reply.code(503).send({ status: 'not_ready', reason: 'wake_pump_degraded' });
    }
  }
  return { status: 'ready' };
}

/**
 * Exercises relation availability and query permissions for both sides of the ACK ledger without
 * selecting payloads or identities and without mutating a delivery.
 */
export async function probeAckPath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    await client.query(
      `SELECT 1 FROM deliveries d
       LEFT JOIN delivery_acks a ON a.delivery_id=d.id
       LIMIT 1`
    );
  });
}

interface DeliveryAdmissionSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly capacity_column_exact: boolean;
  readonly capacity_constraint_valid: boolean;
  readonly inflight_index_valid: boolean;
  readonly claim_permissions: boolean;
}

/**
 * Proves the read/lock/mutation authority and schema used by `claimDeliveries` without observing
 * an alias or changing a row. NULL sentinels cannot match durable identities; PostgreSQL still
 * parses and authorizes every capacity, live-claim and fairness column on the hot path.
 */
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
    if (contract?.migration_applied !== true
        || contract.capacity_column_exact !== true
        || contract.capacity_constraint_valid !== true
        || contract.inflight_index_valid !== true
        || contract.claim_permissions !== true) {
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
    if (contract?.migration_applied !== true
        || contract.connection_token_exact !== true
        || contract.claim_permissions !== true) {
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

interface TerminalClaimSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraint_exact: boolean;
  readonly claim_permissions: boolean;
  readonly audit_permissions: boolean;
}

/**
 * Validates schema-032 and the exact digest+epoch+live-lease CAS predicate without observing a
 * session or changing/renewing a lease. NULL cannot match the NOT NULL session id, while
 * PostgreSQL still resolves every critical column, comparison and effective privilege.
 */
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
    if (contract?.migration_applied !== true || contract.columns_exact !== true
        || contract.constraint_exact !== true || contract.claim_permissions !== true
        || contract.audit_permissions !== true) {
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
    if (contract?.migration_applied !== true || contract.columns_exact !== true
        || contract.constraint_exact !== true || contract.request_index_exact !== true
        || contract.mutation_permissions !== true || contract.audit_permissions !== true) {
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
    if (contract?.migration_applied !== true || contract.columns_exact !== true
        || contract.constraint_exact !== true || contract.mutation_permissions !== true) {
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

interface ProfileRuntimeSchemaProbeRow {
  readonly migration_applied: boolean;
  readonly columns_exact: boolean;
  readonly constraints_exact: boolean;
  readonly functions_exact: boolean;
  readonly triggers_exact: boolean;
  readonly mutation_permissions: boolean;
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

/**
 * Schema-035 is behavioral evidence, not a best-effort UI cache. This probe checks the complete
 * frozen table/constraint/function/trigger topology and the privileges used by expectation writes,
 * delivery reads and adoption ACKs. It is read-only and uses impossible NULL keys, so readiness
 * cannot create evidence or observe an agent identity.
 */
export async function probeProfileRuntimePath(pool: DatabasePool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    await client.query("SET LOCAL lock_timeout='1000ms'");
    await client.query("SET LOCAL statement_timeout='2000ms'");
    const schema = await client.query<ProfileRuntimeSchemaProbeRow>(
      `WITH expected_columns(table_name,position,name,type_name,default_expression) AS (VALUES
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
      [profileDocumentsFunctionBody, profileAdoptionTriggerFunctionBody],
    );
    const contract = schema.rows[0];
    if (contract?.migration_applied !== true || contract.columns_exact !== true
        || contract.constraints_exact !== true || contract.functions_exact !== true
        || contract.triggers_exact !== true || contract.mutation_permissions !== true) {
      throw new Error('gateway schema-035 profile runtime contract is unavailable');
    }
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
  });
}

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

interface ConsolePublishIntentSchemaProbeRow {
  readonly migration_ledger_exact: boolean;
  readonly indexes_exact: boolean;
  readonly journal_permissions: boolean;
}

// Readiness binds the installed schema to the exact source recorded atomically by the migration
// runner. Keep this in lockstep with migration 037; the PostgreSQL focal test catches divergence.
const consolePublishIntentMigrationSha256 =
  '0daeb89c224e940600562ab162fba03c4facd4cb0b80b65f20feedc02b33f281';

/**
 * Proves schema-037's four bounded journal lookup paths from PostgreSQL catalogs. A matching
 * relation name is insufficient: access method, keys and expressions, ordering/null semantics,
 * predicate, validity and the atomic source ledger all have to match. The probe reads four
 * catalog rows under tight timeouts; it neither scans journal history nor mutates durable state.
 */
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
    if (contract?.migration_ledger_exact !== true || contract.indexes_exact !== true
        || contract.journal_permissions !== true) {
      throw new Error('gateway schema-037 console publish intent contract is unavailable');
    }
  });
}

export function registerHealthRoutes(app: FastifyInstance, options: HealthOptions): void {
  app.get('/health/live', async () => ({ status: 'live' }));
  app.get('/health/ready', async (_request, reply) => readiness(options, reply));
  const wakeTelemetry = options.wakePumpTelemetry;
  const consoleTelemetry = options.consolePublishTelemetry;
  if (wakeTelemetry !== undefined || consoleTelemetry !== undefined) {
    app.get('/metrics', async (_request, reply) => reply
      .header('cache-control', 'no-store')
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(`${wakeTelemetry === undefined ? '' : renderWakePumpMetrics(wakeTelemetry)}${
        consoleTelemetry === undefined ? '' : renderConsolePublishMetrics(consoleTelemetry)
      }`));
  }
}

/** Internal health/metrics app. Callers choose the bind; it contains no data or identity routes. */
export async function buildLoopbackHealthProbe(options: HealthOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });
  registerHealthRoutes(app, options);
  return app;
}

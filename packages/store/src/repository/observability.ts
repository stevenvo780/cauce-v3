import type { Tenant } from '@cauce/protocol';
import {
  agentWorkState, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, FLEET_ACTIVITY_QUERY, FLEET_ACTIVITY_FLAGS,
  FLEET_WORK_STATES, type FleetActivityFlag, type FleetWorkState
} from '../fleet-activity.js';
import { safeAuditSummary } from '../audit-summary.js';
import { StoreError } from './errors.js';
import type {
  OperationalDlqPage, OperationalDlqResolutionRequest, OperationalDlqResolutionResult
} from './observability/contracts.js';
import { UUID_PATTERN } from './observability/helpers.js';
import { ObservabilityChainSweepRepository } from './observability/chain-sweep.js';

export {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  deliveryLeaseCapMs, timeoutRetryBackoffSeconds,
  type DeliveryLeaseCap, type ObservabilityRetentionPolicy, type ObservabilityRetentionResult,
  type StaleDeliveryPolicy
} from './observability/policy.js';
export {
  disabledChainPolicy,
  type AgentFaninDisposition, type AgentResponseDisposition, type ChainPolicy,
  type ChainSilenceClosureReason, type ChainSilenceSweepOptions, type ChainSilenceSweepResult,
  type DeliveryRow, type LateRelayDisposition, type OperationalDlqItem, type OperationalDlqPage,
  type OperationalDlqResolutionRequest, type OperationalDlqResolutionResult
} from './observability/contracts.js';
export {
  agentDeploymentStatus, UUID_PATTERN, aliasPattern, originRelayTenant, tenantPattern, truncateUtf8
} from './observability/helpers.js';

export abstract class ObservabilityRepository extends ObservabilityChainSweepRepository {

  async listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options: { limit?: number; before?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
    }
    const before = options.before ?? null;
    if (before !== null && (
      !/^[1-9][0-9]{0,18}$/u.test(before)
      || BigInt(before) > 9_223_372_036_854_775_807n
    )) {
      throw new StoreError('invalid_input', 'audit cursor is invalid');
    }
    const result = await this.pool.query<{
      event_id: string;
      at: Date | string;
      tenant_id: string | null;
      actor_alias: string | null;
      action: string;
      decision: string;
      request_id: string | null;
      trace_id: string | null;
      metadata: unknown;
    }>(
      `SELECT audit.id AS event_id,audit.created_at AS at,audit.tenant_id,audit.actor_alias,
              audit.action,audit.decision,audit.request_id,audit.trace_id,audit.metadata
       FROM audit_events audit
       LEFT JOIN messages message ON message.id=audit.message_id
       WHERE (
         (audit.tenant_id=$1 AND audit.actor_alias=$2)
         OR (message.id IS NOT NULL AND EXISTS (
           SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
             AND source_member.room_id=message.room_id AND source_member.alias=$2
             AND source_member.enabled AND message.tenant_id=$1
         ))
         OR (audit.delivery_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM deliveries participant WHERE participant.id=audit.delivery_id
             AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2
         ))
       )
         AND ($3::bigint IS NULL OR audit.id < $3::bigint)
       ORDER BY audit.id DESC LIMIT $4`, [actorTenant, actorAlias, before, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const visible = result.rows.slice(0, limit);
    return {
      items: visible.map((row) => ({
        event_id: String(row.event_id),
        at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        tenant_id: row.tenant_id,
        actor_alias: row.actor_alias,
        action: row.action,
        decision: row.decision,
        request_id: row.request_id,
        trace_id: row.trace_id,
        summary: safeAuditSummary(row.action, row.metadata),
      })),
      next_cursor: hasMore && visible.length > 0
        ? String(visible[visible.length - 1]!.event_id)
        : null,
    };
  }

  /**
   * Actividad en vuelo de toda la flota visible para el actor, agregada por alias. Es la mitad
   * "qué está trabajando cada agente ahora" del panel pedido; la otra mitad (consumo de cuota)
   * vive en quotaSnapshot() con su propio observed_at porque las dos frescuras son
   * incomparables -- ésta es de hace milisegundos, la de cuota es una muestra fuera de banda de
   * hace minutos.
   *
   * Self-contained como topology()/listAgents(): valida el permiso acá mismo, así que la ruta
   * sólo necesita el chequeo de rol+permiso sobre el Principal (requireOperatorPermission).
   *
   * FLEET_ACTIVITY_QUERY es sólo lectura, sin locks y sin funciones de ventana a propósito
   * (ver el comentario en fleet-activity.ts): un panel quiere una foto, no una que congele el
   * despacho mientras la saca, y Postgres rechaza al parsear cualquier combinación de
   * FOR SHARE/FOR UPDATE con funciones de ventana.
   */
  async fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const thresholds = DEFAULT_FLEET_ACTIVITY_THRESHOLDS;
    const result = await this.pool.query<Record<string, unknown>>(FLEET_ACTIVITY_QUERY, [
      actorTenant, thresholds.ack_recent_seconds, thresholds.ack_lookback_seconds, thresholds.items_per_agent
    ]);

    const agents = result.rows.map((row) => {
      // lease_online sale de `(lease.lease_until > now())`: NULL cuando el LEFT JOIN no
      // encontró ninguna fila de lease (nunca se conectó), no cuando el lease está vencido.
      const leaseOnline = row.lease_online === null || row.lease_online === undefined
        ? null : row.lease_online === true;
      // NULL acá es "ningún ACK aplicado dentro de la ventana de búsqueda", la señal MÁS grave;
      // Number(null) daría 0 y lo pintaría como recién ackeado, exactamente al revés.
      const secondsSinceLastAck = row.seconds_since_last_ack === null || row.seconds_since_last_ack === undefined
        ? null : Number(row.seconds_since_last_ack);
      const inFlight = Number(row.in_flight ?? 0);
      const queued = Number(row.queued ?? 0);
      const overdueInFlight = Number(row.overdue_in_flight ?? 0);
      const registered = row.registered === true;

      const { work_state, flags } = agentWorkState(
        { registered, in_flight: inFlight, queued, overdue_in_flight: overdueInFlight, seconds_since_last_ack: secondsSinceLastAck, lease_online: leaseOnline },
        thresholds
      );

      return {
        tenant_id: row.tenant_id,
        alias: row.alias,
        display_name: row.display_name ?? null,
        harness_id: row.harness_id ?? null,
        registered,
        agent_enabled: row.agent_enabled === true,
        presence: {
          online: leaseOnline,
          instance_id: row.instance_id ?? null,
          // bigint: el driver de pg lo devuelve como string; el resto de este archivo ya
          // convierte epoch de la misma forma (ver acquireLease/heartbeat más arriba).
          epoch: row.epoch === null || row.epoch === undefined ? null : Number(row.epoch),
          last_heartbeat_at: row.last_heartbeat_at ?? null,
          lease_until: row.lease_until ?? null
        },
        work_state,
        flags,
        in_flight: inFlight,
        started: Number(row.started ?? 0),
        claimed_not_started: Number(row.claimed_not_started ?? 0),
        queued,
        queued_ready: Number(row.queued_ready ?? 0),
        retrying: Number(row.retrying ?? 0),
        overdue_in_flight: overdueInFlight,
        oldest_claimed_at: row.oldest_claimed_at ?? null,
        oldest_in_flight_seconds: row.oldest_in_flight_seconds === null || row.oldest_in_flight_seconds === undefined
          ? null : Number(row.oldest_in_flight_seconds),
        nearest_ack_deadline_at: row.nearest_ack_deadline_at ?? null,
        max_attempt: row.max_attempt === null || row.max_attempt === undefined ? null : Number(row.max_attempt),
        last_ack_at: row.last_ack_at ?? null,
        seconds_since_last_ack: secondsSinceLastAck,
        acks_recent: Number(row.acks_recent ?? 0),
        in_flight_items_truncated: row.in_flight_items_truncated === true,
        in_flight_items: Array.isArray(row.in_flight_items) ? row.in_flight_items : [],
        // Las salas del alias, ya resueltas por el SQL. `[]` es un valor legítimo -- registrado y
        // sin sala -- y la consola lo dibuja igual; no se colapsa a null ni se omite el campo,
        // porque "no tiene sala" y "el servidor no informa salas" se renderizan distinto.
        rooms: Array.isArray(row.rooms) ? (row.rooms as string[]) : []
      };
    });

    const byState = Object.fromEntries(FLEET_WORK_STATES.map((state) => [state, 0])) as Record<FleetWorkState, number>;
    const flagged = Object.fromEntries(FLEET_ACTIVITY_FLAGS.map((flag) => [flag, 0])) as Record<FleetActivityFlag, number>;
    const totals = agents.reduce((acc, agent) => {
      acc.agents += 1;
      byState[agent.work_state] += 1;
      for (const flag of agent.flags) flagged[flag] += 1;
      acc.in_flight += agent.in_flight;
      acc.queued += agent.queued;
      acc.retrying += agent.retrying;
      acc.overdue_in_flight += agent.overdue_in_flight;
      return acc;
    }, { agents: 0, in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0 });

    return {
      observed_at: new Date().toISOString(),
      thresholds,
      totals: { ...totals, by_state: byState, flagged },
      agents
    };
  }

  /**
   * Inventario DLQ operativo sin payloads ni ids externos. La base aplica control multi-tenant y
   * liga el cursor opaco a la identidad del operador; cambiar actor o reutilizar un cursor de otro
   * scope falla cerrado. No es una firma: un actor autorizado sólo puede alterar navegación dentro
   * de su scope. El orden keyset es estable ante reaperturas porque usa el
   * `created_at` inmutable de la carta, más target e id como desempates.
   */
  async listOperationalDlq(
    actorTenant: Tenant,
    actorAlias: string,
    limit = 200,
    cursor: string | null = null
  ): Promise<OperationalDlqPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'DLQ list limit must be between 1 and 500');
    }
    if (cursor !== null && (cursor.length < 2 || cursor.length > 1024
      || cursor.length % 2 !== 0 || !/^[a-f0-9]+$/.test(cursor))) {
      throw new StoreError('invalid_input', 'DLQ list cursor is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqPage }>(
      `SELECT cauce_list_dlq_030($1,$2,$3,$4) AS value`,
      [actorTenant, actorAlias, limit, cursor]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ list did not return a page');
    return value;
  }

  /** Exact, operator-audited closure of one classified incident without replay or side effects. */
  async resolveOperationalDlqWithoutReplay(
    actorTenant: Tenant,
    actorAlias: string,
    request: OperationalDlqResolutionRequest
  ): Promise<OperationalDlqResolutionResult> {
    const reason = request.reason.trim();
    if ((request.target !== 'delivery' && request.target !== 'outbox')
      || !UUID_PATTERN.test(request.id)
      || !/^[a-f0-9]{64}$/.test(request.evidenceSha256)
      || reason.length < 1 || reason.length > 1_000
      || [...reason].some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
      || typeof request.possibleDuplicateAcknowledged !== 'boolean'
      || typeof request.possibleNoDeliveryAcknowledged !== 'boolean') {
      throw new StoreError('invalid_input', 'DLQ no-replay resolution request is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqResolutionResult }>(
      `SELECT cauce_resolve_dlq_without_replay_030(
         $1,$2::uuid,$3,$4,$5,$6,$7,$8
       ) AS value`,
      [
        request.target, request.id, request.evidenceSha256, reason, actorTenant, actorAlias,
        request.possibleDuplicateAcknowledged, request.possibleNoDeliveryAcknowledged,
      ]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ no-replay resolution returned no receipt');
    return value;
  }

  async queueSnapshot(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT d.id AS delivery_id,d.message_id,d.recipient_tenant AS tenant_id,d.recipient_alias,
              m.tenant_id AS message_tenant_id,m.actor_alias,m.lane,d.status AS state,
              d.attempt AS attempts,d.max_attempts,d.available_at,d.last_error
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))
       ORDER BY d.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    // `failed` cuenta como dead letter porque ya tiene fila reproducible y debe figurar en el total.
    const counts = result.rows.reduce<{ pending: number; retrying: number; dead: number }>((value, row) => {
      if (row.state === 'retry') value.retrying += 1;
      if (row.state === 'dead' || row.state === 'failed') value.dead += 1;
      if (['pending', 'leased', 'accepted', 'started'].includes(String(row.state))) value.pending += 1;
      return value;
    }, { pending: 0, retrying: 0, dead: 0 });

    // Conteo total agregado con los mismos filtros de visibilidad que el listado.
    const totales = await this.pool.query<{ pending: string; retrying: string; dead: string; total: string }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started')) AS pending,
              count(*) FILTER (WHERE d.status = 'retry') AS retrying,
              count(*) FILTER (WHERE d.status IN ('dead','failed')) AS dead,
              count(*) AS total
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))`, [actorTenant, actorAlias]
    );
    const fila = totales.rows[0];
    const totals = {
      pending: Number(fila?.pending ?? 0),
      retrying: Number(fila?.retrying ?? 0),
      dead: Number(fila?.dead ?? 0),
    };
    // «Recortada» se decide comparando con el total, no con `items.length === limit`: si hubiera
    // exactamente `limit` entregas, esa comprobación diría que falta algo cuando no falta nada.
    const muestra_recortada = Number(fila?.total ?? 0) > result.rows.length;

    return {
      observed_at: new Date().toISOString(),
      ...counts,
      totals,
      muestra_recortada,
      items: result.rows,
    };
  }

}

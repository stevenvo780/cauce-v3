import { StoreError } from './repository/quotas.js';
import { terminal } from './repository/messages.js';
import { AgentNotificationsRepository } from './repository/agents/notifications.js';
import { postgresTextSafe } from './repository/deliveries.js';
import { visibleText } from './repository/outbox.js';
export {
  PublishIntentExpiredError, PublishIntentReconciliationRequired,
  type PublishOptions, type PublishResult
} from './repository/messages.js';
export { type ProfileRuntimeAdoptionAck } from './repository/agents.js';
export { failureSignature, type AgentChainProgressStage } from './repository/agents/fanin.js';
export { type AgentOutputRejectionCode } from './repository/agents/chain-control.js';
export { type NotificationVerdict } from './repository/agents/notifications.js';
export {
  type AckResult, type ClaimedDeliveryEnvelope, type DelegationMaterialization,
  type DelegationRejection, type DeliveryAdmission, type LeaseAcquireOptions,
  type LeaseResult, type LiveDeliveryClaim, type NotifyDenialCode
} from './repository/deliveries.js';
import type { DeliveryRow } from './repository/observability.js';
export {
  DEFAULT_QUOTA_THRESHOLDS, StoreError, windowSeverity, worstQuotaSeverity,
  type QuotaSampleIngestResult, type QuotaSamplePausedAccount, type QuotaSampleResumedAccount,
  type QuotaSampleUnboundGroup, type QuotaSeverity, type QuotaThresholds, type StoreErrorCode
} from './repository/quotas.js';
export {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  deliveryLeaseCapMs, timeoutRetryBackoffSeconds, type ChainSilenceClosureReason,
  type ChainSilenceSweepOptions, type ChainSilenceSweepResult, type DeliveryLeaseCap,
  type ObservabilityRetentionPolicy, type ObservabilityRetentionResult, type OperationalDlqItem,
  type OperationalDlqPage, type OperationalDlqResolutionRequest,
  type OperationalDlqResolutionResult, type StaleDeliveryPolicy
} from './repository/observability.js';
export { type JobClaim } from './repository/jobs.js';
export {
  type ClaimedOutboxEvent, type ConnectionSessionFence, type FencedWakeOutboxRecipient,
  type OutboxAck, type OutboxEvent, type OutboxRetryResult, type WakeOutboxClaimFence,
  type WakeOutboxRecipient
} from './repository/outbox.js';
export {
  PublishIntentRateLimitedError, type AgentTargetPermission, type AuthorizedAgentTarget
} from './repository/config.js';
import type { Tenant } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { withTransaction } from './db.js';
import { selectAccountForAlias, type AccountSelection } from './accounts.js';






/** Prefijo estable del motivo de una cancelación: es lo que permite contarlas sin heurística. */
const cancellationReasonPrefix = 'Cancelled by operator';
const maxCancellationReasonBytes = 500;

/**
 * Motivo con el que queda marcada una entrega cancelada.
 *
 * El prefijo es fijo y la nota del operador va después, recortada. Dos razones: `last_error` y
 * `dead_letters.reason` los lee un humano en la consola, y un texto libre sin techo puede venir
 * de un cliente. El NUL se saca porque PostgreSQL no lo acepta en `text` y el `INSERT`
 * abortaría la transacción entera de la cancelación.
 */
function cancellationReason(actorTenant: Tenant, actorAlias: string, reason?: string): string {
  const header = `${cancellationReasonPrefix} ${actorTenant}:${actorAlias}`;
  const note = visibleText(postgresTextSafe(reason));
  if (!note) return header;
  const trimmed = note.length > maxCancellationReasonBytes
    ? `${note.slice(0, maxCancellationReasonBytes)}…`
    : note;
  return `${header}: ${trimmed}`;
}

export class CauceRepository extends AgentNotificationsRepository {

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
    // 'failed' cuenta como dead letter porque desde este parche LO ES: `ackDelivery` le escribe
    // su fila y `replayDelivery` la acepta. Dejarla fuera del contador mantendría al operador
    // creyendo que no hay nada que revisar mientras el botón de replay ya está disponible: el
    // mismo desfase que hizo invisibles las 197 entregas de producción.
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

  /**
   * Autorización compartida por las DOS operaciones de operador sobre una entrega ajena:
   * `replayDelivery` y `cancelDelivery`. Es deliberado que sean la misma: las dos mueven el
   * estado terminal de una entrega que el operador no emitió, y tener dos criterios distintos
   * garantizaría que uno de los dos se quede viejo.
   *
   * Se responde `not_found` (nunca `forbidden`) para no confirmar la existencia de entregas
   * fuera del alcance del actor.
   */
  private async assertReplayAuthorization(
    client: DatabaseClient,
    actorTenant: Tenant,
    actorAlias: string,
    row: {
      recipient_tenant: Tenant; recipient_alias: string;
      tenant_id: Tenant; room_id: string; actor_alias: string;
    }
  ): Promise<void> {
    const denied = (): never => {
      throw new StoreError('not_found', 'delivery not found or not visible');
    };
    const actorControl = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.allow_control
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,role,tenant,room`,
      [actorTenant, actorAlias]
    );
    if (actorControl.rowCount === 0) denied();

    const sourceRoute = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
         AND membership.enabled AND tenant.enabled AND room.enabled AND role.allow_route
       FOR SHARE OF membership,role,tenant,room`,
      [row.tenant_id, row.room_id, row.actor_alias]
    );
    if (sourceRoute.rowCount === 0) denied();

    const recipient = await client.query(
      `SELECT 1 FROM memberships membership
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       ORDER BY membership.tenant_id,membership.room_id,membership.alias
       FOR SHARE OF membership,tenant,room`,
      [row.recipient_tenant, row.recipient_alias]
    );
    if (recipient.rowCount === 0) denied();

    if (row.tenant_id !== row.recipient_tenant) {
      const route = await client.query(
        `SELECT 1 FROM acl_edges edge
         JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
         JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
         WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
           AND edge.enabled AND edge.allow_route
           AND source_tenant.enabled AND target_tenant.enabled
           AND (source_tenant.is_hub OR target_tenant.is_hub)
         FOR SHARE OF edge,source_tenant,target_tenant`,
        [row.tenant_id, row.recipient_tenant]
      );
      if (route.rowCount === 0) denied();
    }

    if (row.recipient_tenant === actorTenant) return;
    if (row.tenant_id === actorTenant) {
      const sourceVisibility = await client.query(
        `SELECT 1 FROM memberships membership
         JOIN tenants tenant ON tenant.id=membership.tenant_id
         JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
         WHERE membership.tenant_id=$1 AND membership.room_id=$2 AND membership.alias=$3
           AND membership.enabled AND tenant.enabled AND room.enabled
         FOR SHARE OF membership,tenant,room`,
        [actorTenant, row.room_id, actorAlias]
      );
      if (sourceVisibility.rowCount !== 0) return;
    }

    const controlEdge = await client.query(
      `SELECT 1 FROM acl_edges edge
       JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
       JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
       WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
         AND edge.enabled AND edge.allow_control
         AND source_tenant.enabled AND target_tenant.enabled
         AND (source_tenant.is_hub OR target_tenant.is_hub)
       FOR SHARE OF edge,source_tenant,target_tenant`,
      [actorTenant, row.recipient_tenant]
    );
    if (controlEdge.rowCount === 0) denied();
  }

  /**
   * Reencola a mano una entrega que terminó en error.
   *
   * El filtro es `status IN ('dead','failed')` y no `status='dead'` porque los dos son finales de
   * ERROR y la diferencia entre ellos la elige el agente que falló (`ack.retryable`), no el
   * operador. Con el filtro viejo, 197 entregas de producción quedaron sin botón de rescate por
   * una decisión que tomó el proceso que se rompió. Ver el comentario largo de `ackDelivery`
   * junto al INSERT en `dead_letters`.
   *
   * El JOIN con `dead_letters` se conserva y sigue siendo el candado de idempotencia: es la fila
   * que se marca `resolved_at` acá dentro, en la misma transacción que crea el clon, y sin ella
   * dos operadores simultáneos crearían dos clones. La migración 018_terminal_recovery_backfill hace el backfill de las
   * entregas terminales que quedaron sin esa fila, incluidas las que un humano marcó `dead` a
   * mano en psql.
   */
  async replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; message_id: string; dead_letter_id: string;
        recipient_tenant: Tenant; recipient_alias: string; max_attempts: number;
        request_id: string; trace_id: string; tenant_id: Tenant; room_id: string; actor_alias: string;
        dead_letter_resolved_at: Date | null;
      }>(
        `SELECT d.id,d.message_id,dl.id AS dead_letter_id,d.recipient_tenant,d.recipient_alias,d.max_attempts,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
                dl.resolved_at AS dead_letter_resolved_at
         FROM deliveries d
         JOIN messages m ON m.id=d.message_id
         JOIN dead_letters dl ON dl.delivery_id=d.id
         WHERE d.id=$1 AND d.status IN ('dead','failed')
           AND EXISTS (
             SELECT 1 FROM memberships actor_member
             JOIN role_policies role ON role.role=actor_member.role
             JOIN tenants operator_tenant ON operator_tenant.id=actor_member.tenant_id
             JOIN rooms operator_room
               ON operator_room.id=actor_member.room_id AND operator_room.tenant_id=actor_member.tenant_id
             WHERE actor_member.tenant_id=$2 AND actor_member.alias=$3 AND actor_member.enabled
               AND operator_tenant.enabled AND operator_room.enabled AND role.allow_control
           )
           AND EXISTS (
             SELECT 1 FROM memberships source_actor
             JOIN role_policies source_role ON source_role.role=source_actor.role
             JOIN tenants source_tenant ON source_tenant.id=source_actor.tenant_id
             JOIN rooms source_room
               ON source_room.id=source_actor.room_id AND source_room.tenant_id=source_actor.tenant_id
             WHERE source_actor.tenant_id=m.tenant_id AND source_actor.room_id=m.room_id
               AND source_actor.alias=m.actor_alias AND source_actor.enabled
               AND source_role.allow_route AND source_tenant.enabled AND source_room.enabled
           )
           AND EXISTS (
             SELECT 1 FROM memberships recipient
             JOIN tenants recipient_tenant ON recipient_tenant.id=recipient.tenant_id
             JOIN rooms recipient_room
               ON recipient_room.id=recipient.room_id AND recipient_room.tenant_id=recipient.tenant_id
             WHERE recipient.tenant_id=d.recipient_tenant AND recipient.alias=d.recipient_alias
               AND recipient.enabled AND recipient_tenant.enabled AND recipient_room.enabled
           )
           AND (
             m.tenant_id=d.recipient_tenant
             OR EXISTS (
               SELECT 1 FROM acl_edges route_edge
               JOIN tenants source_tenant ON source_tenant.id=route_edge.from_tenant
               JOIN tenants target_tenant ON target_tenant.id=route_edge.to_tenant
               WHERE route_edge.from_tenant=m.tenant_id AND route_edge.to_tenant=d.recipient_tenant
                 AND route_edge.enabled AND route_edge.allow_route
                 AND source_tenant.enabled AND target_tenant.enabled
                 AND (source_tenant.is_hub OR target_tenant.is_hub)
             )
           )
           AND (
            d.recipient_tenant=$2
            OR EXISTS (
              SELECT 1 FROM memberships source_member
              JOIN tenants source_tenant ON source_tenant.id=source_member.tenant_id
              JOIN rooms source_room
                ON source_room.id=source_member.room_id AND source_room.tenant_id=source_member.tenant_id
              WHERE m.tenant_id=$2 AND source_member.tenant_id=$2
                AND source_member.room_id=m.room_id AND source_member.alias=$3 AND source_member.enabled
                AND source_tenant.enabled AND source_room.enabled
            )
            OR EXISTS (
              SELECT 1 FROM acl_edges edge
              JOIN tenants source_tenant ON source_tenant.id=edge.from_tenant
              JOIN tenants target_tenant ON target_tenant.id=edge.to_tenant
              WHERE edge.from_tenant=$2 AND edge.to_tenant=d.recipient_tenant
                AND edge.enabled AND edge.allow_control
                AND source_tenant.enabled AND target_tenant.enabled
                AND (source_tenant.is_hub OR target_tenant.is_hub)
            )
          )
         FOR UPDATE OF d,m,dl`,
        [deliveryId, actorTenant, actorAlias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'terminal delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);

      const existingReplay = await client.query(
        `SELECT 1
         FROM audit_events replay
         JOIN deliveries replayed_delivery ON replayed_delivery.id=replay.delivery_id
         JOIN messages replayed_message ON replayed_message.id=replay.message_id
         WHERE replay.action='delivery.replay' AND replay.decision='allow'
           AND replay.metadata->>'replayed_from_delivery_id'=$1
           AND replayed_delivery.message_id=replayed_message.id
         LIMIT 1`,
        [row.id]
      );
      if (existingReplay.rowCount) {
        throw new StoreError('conflict', 'delivery already has a durable replay clone');
      }

      const legacyReplay = row.dead_letter_resolved_at === null
        ? false
        : (await client.query(
          `SELECT 1 FROM adapter_outbox legacy
           WHERE legacy.tenant_id=$1 AND legacy.adapter='gateway' AND legacy.kind='wake'
             AND legacy.delivery_id=$2 AND legacy.message_id=$3 AND legacy.request_id=$4
             AND legacy.idempotency_key LIKE $5
             AND legacy.payload->>'recipient_alias'=$6
           LIMIT 1`,
          [
            row.recipient_tenant, row.id, row.message_id, row.request_id,
            `wake-replay:${row.id}:%`, row.recipient_alias
          ]
        )).rowCount === 1;
      if (row.dead_letter_resolved_at !== null && !legacyReplay) {
        throw new StoreError('not_found', 'terminal delivery has no open or legacy-replay dead letter');
      }

      const message = await client.query<{ id: string; request_id: string }>(
        `INSERT INTO messages(
           request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
           auth_session_id,auth_channel
         )
         SELECT gen_random_uuid(),trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                auth_session_id,auth_channel
         FROM messages WHERE id=$1
         RETURNING id,request_id`,
        [row.message_id]
      );
      const replayedMessage = message.rows[0];
      if (!replayedMessage) throw new Error('replay message insert returned no id');

      const delivery = await client.query<{ id: string }>(
        `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,max_attempts)
         VALUES($1,$2,$3,$4) RETURNING id`,
        [replayedMessage.id, row.recipient_tenant, row.recipient_alias, row.max_attempts]
      );
      const replayedDeliveryId = delivery.rows[0]?.id;
      if (!replayedDeliveryId) throw new Error('replay delivery insert returned no id');

      if (row.dead_letter_resolved_at === null) {
        const resolved = await client.query(
          `UPDATE dead_letters SET resolved_at=now() WHERE id=$1 AND resolved_at IS NULL`,
          [row.dead_letter_id]
        );
        if (resolved.rowCount !== 1) {
          throw new StoreError('conflict', 'dead letter was already resolved');
        }
      }

      await client.query(
        `INSERT INTO adapter_outbox(
           tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload
         )
         SELECT $1,'gateway','wake',$2,replayed.request_id,replayed.id,$3,replayed.trace_id,replayed.origin,
                jsonb_build_object('recipient_alias',$4::text,'reason','delivery_available')
         FROM messages replayed WHERE replayed.id=$5`,
        [
          row.recipient_tenant, `wake-replay:${replayedDeliveryId}`, replayedDeliveryId,
          row.recipient_alias, replayedMessage.id
        ]
      );
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.replay','allow',$3,$4,$5,$6,$7::jsonb)`,
        [
          actorTenant, actorAlias, replayedMessage.request_id, replayedMessage.id, replayedDeliveryId, row.trace_id,
          JSON.stringify({
            replayed_from_delivery_id: row.id,
            replayed_from_message_id: row.message_id,
            legacy_dead_letter_recovery: legacyReplay,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias
          })
        ]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake',
        JSON.stringify({ tenant_id: row.recipient_tenant, alias: row.recipient_alias })
      ]);
      return {
        delivery_id: replayedDeliveryId,
        replayed_from_delivery_id: row.id,
        state: 'pending',
        replayed: true
      };
    });
  }

  /**
   * CANCELACIÓN de una entrega en vuelo. Operación del operador, hermana de
   * `replayDelivery` y con exactamente su misma autorización.
   *
   * Proporciona una operación consistente y trazable de cancelación de entregas:
   *   1. Registra la entrega en `dead_letters` para trazabilidad y replay.
   *   2. Notifica el resultado a través de `insertOriginRelay`.
   *   3. Materializa la respuesta en el árbol de delegación para actualizar al padre y la agregación de fan-in.
   *
   * NO INVENTA UN ESTADO NUEVO. Termina en 'dead', por el mismo motivo por el que lo hace el
   * reaper (ver su comentario): toda la maquinaria de revisión manual ya apunta ahí, y un
   * 'cancelled' obligaría a ampliar el CHECK de `deliveries.status`, `DeliveryStateSchema`, las
   * series del dispatcher y cinco vistas de consola para terminar reimplementando el mismo botón
   * de replay. Lo que sí es propio es el rastro: motivo con prefijo estable y un `audit_events`
   * con acción `delivery.cancel`, para poder contar cancelaciones sin confundirlas con timeouts.
   *
   * NO MANDA NINGÚN FRAME AL ADAPTADOR, a propósito. El lado servidor queda consistente en una
   * sola transacción; el harness que siga corriendo morirá por su propio camino (techo de vida)
   * y su ACK tardío rebotará como `ownership_lost`, porque `ackDelivery` corta antes con
   * `terminal(row.status)`. Es la degradación correcta: no depende de que el adaptador esté vivo,
   * que es justamente la situación en la que hace falta cancelar.
   */
  async cancelDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
    reason?: string
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    const cancelReason = cancellationReason(actorTenant, actorAlias, reason);
    return withTransaction(this.pool, async (client) => {
      // Se traen las MISMAS columnas que arma el reaper porque abajo se llaman los mismos tres
      // helpers (`materializeAgentResponse`, `materializeAgentFanin`, `insertOriginRelay`) y
      // todos esperan un `DeliveryRow` completo. `FOR UPDATE OF d` sin función de ventana: ver
      // `sql-locking-clauses.test.ts`, PostgreSQL rechaza esa combinación al parsear.
      const selected = await client.query<DeliveryRow>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,
                d.max_attempts,d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,
                d.claim_token,d.ack_deadline_at,
                m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,
                m.priority,m.origin,m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1
         FOR UPDATE OF d`,
        [deliveryId]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found or not visible');
      await this.assertReplayAuthorization(client, actorTenant, actorAlias, row);
      // Una entrega ya terminal no se cancela: se replaya o se deja. Devolver `conflict` en vez
      // de "ok" es lo honesto, porque un segundo cancel que dijera que sí haría creer al operador
      // que interrumpió algo que en realidad ya había terminado (y quizá terminado BIEN).
      if (terminal(row.status)) {
        throw new StoreError('conflict', `delivery is already terminal (${row.status})`);
      }

      // Se limpian los campos de vallado además del estado. No es cosmético: mientras
      // `claim_token`/`consumer_epoch` sigan puestos, un adaptador con la garra en la mano puede
      // seguir renovándola, y el objetivo de cancelar es soltar el cupo del alias ya.
      const cancelled = await client.query(
        `UPDATE deliveries
           SET status='dead',terminal_at=now(),last_error=$2,last_ack_rank=3,
               cancelled_at=now(),
               claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
               consumer_instance_id=NULL,consumer_epoch=NULL,updated_at=now()
         WHERE id=$1 AND status NOT IN ('done','failed','dead')`,
        [row.id, cancelReason]
      );
      if (cancelled.rowCount !== 1) {
        throw new StoreError('conflict', 'delivery became terminal while being cancelled');
      }

      // (1) Rastro replayable. El `ON CONFLICT` cubre la entrega que ya tenía dead letter de una
      // vida anterior; el `resolved_at` lo pone `replayDelivery` cuando alguien la rescate.
      await client.query(
        `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
         VALUES($1,$2,$5,$3::jsonb,$4)
         ON CONFLICT(delivery_id) DO NOTHING`,
        [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, cancelReason]
      );

      // (2) y (3): el padre y el humano, por los mismos dos caminos que usa el reaper. A
      // diferencia del reaper, acá NO se atrapa el error de materialización: el reaper procesa un
      // lote y no puede dejar que una fila mate el tick entero, pero esto es un comando
      // interactivo de una sola entrega. Si el aviso al padre no se puede escribir, la
      // transacción entera se deshace y el operador ve el motivo, en vez de quedarse con una
      // cancelación a medias —que es exactamente el estado que produce el UPDATE manual—.
      const chainPolicy = await this.loadChainPolicy(client);
      const responseDisposition = await this.materializeAgentResponse(
        client, row, row.attempt, 'dead', chainPolicy, undefined, cancelReason, 'DELIVERY_CANCELLED'
      );
      const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
      const relayed = responseDisposition === 'not_child'
        && (row.body.type === 'agent.fanin' || !fanin.hasFanout);
      if (relayed) {
        await this.insertOriginRelay(
          client, row, 'dead', { error: cancelReason, error_code: 'DELIVERY_CANCELLED' }
        );
      }

      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,$2,'delivery.cancel','allow',$3,$4,$5,$6,$7::jsonb)`,
        [actorTenant, actorAlias, row.request_id, row.message_id, row.id, row.trace_id,
          JSON.stringify({
            cancelled_from_status: row.status,
            attempt: row.attempt,
            reason: cancelReason,
            recipient_tenant: row.recipient_tenant,
            recipient_alias: row.recipient_alias,
            parent_notice: responseDisposition,
            origin_relayed: relayed
          })]
      );
      return {
        delivery_id: row.id,
        state: 'dead',
        cancelled: true,
        cancelled_from_state: row.status,
        reason: cancelReason,
        parent_notice: responseDisposition,
        origin_relayed: relayed,
        // El operador tiene que saber que esto NO es irreversible: la fila de `dead_letters` que
        // se acaba de escribir es la que habilita el botón de replay.
        replayable: true
      };
    });
  }

  async listJobs(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS job_id,tenant_id,lane,kind,status,priority,attempts,claimed_by,claimed_at,created_at,updated_at
       FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [actorTenant, limit]
    );
    return { items: result.rows };
  }

  /**
   * Qué suscripción gasta el alias en su próxima ejecución (GET /v3/accounts/selection).
   *
   * `actorTenant`/`actorAlias` son la identidad mTLS AUTENTICADA y son TAMBIÉN el sujeto de la
   * consulta: no hay parámetro para preguntar por otro alias. Es deliberado y es la mitad de la
   * seguridad de esta ruta — la respuesta incluye el `credential_ref` de la cuenta, y aunque sea
   * un locator y no un secreto, decirle a un agente dónde busca su credencial OTRO agente es
   * exactamente el tipo de dato que no tiene por qué cruzar. Un alias sólo resuelve lo suyo.
   *
   * Nótese la diferencia con `getConfiguration()`, que NUNCA devuelve `credential_ref` ni a su
   * pagador (ver configuration.ts): aquello alimenta un navegador, esto alimenta al adaptador que
   * corre en el host que ya tiene el material montado. La migración 010 lo dice al describir el
   * locator: "the borrower receives a reference it can only dereference on a host that already
   * holds the material".
   */
  async selectAccount(actorTenant: Tenant, actorAlias: string, provider: string): Promise<AccountSelection> {
    // Mismo juego de caracteres que el CHECK de `provider_accounts.provider`. Se valida acá y no
    // sólo en la ruta para que ningún llamador futuro pueda meter una cadena arbitraria en el
    // parámetro de la consulta.
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(provider)) {
      throw new StoreError('invalid_input', `invalid provider name: ${provider}`);
    }
    return selectAccountForAlias(this.pool, {
      tenant_id: actorTenant, alias: actorAlias, provider
    });
  }
}

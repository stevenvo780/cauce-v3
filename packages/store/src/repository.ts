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

import type { DeliveryState } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { BaseRepository } from '../base.js';
import { StoreError } from '../errors.js';
import type {
  AgentFaninDisposition, AgentResponseDisposition, ChainPolicy, DeliveryRow, LateRelayDisposition
} from './contracts.js';
import {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  leaseCapInstantSql, leaseCapMsSql, positiveMs, timeoutRetryBackoffSeconds,
  type ObservabilityRetentionPolicy, type ObservabilityRetentionResult, type StaleDeliveryPolicy
} from './policy.js';

export abstract class ObservabilityMaintenanceRepository extends BaseRepository {

  protected abstract loadChainPolicy(client: DatabaseClient): Promise<ChainPolicy>;

  protected abstract materializeAgentResponse(
    client: DatabaseClient,
    row: DeliveryRow,
    attempt: number,
    outcome: DeliveryState,
    policy: ChainPolicy,
    result: Record<string, unknown> | undefined,
    error?: string,
    errorCode?: string,
    late?: { previousStatus: DeliveryState }
  ): Promise<AgentResponseDisposition>;

  protected abstract materializeAgentFanin(
    client: DatabaseClient,
    rootMessageId: string | undefined
  ): Promise<AgentFaninDisposition>;

  protected abstract rootMessageId(row: DeliveryRow): string | undefined;

  protected abstract insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: {
      result?: Record<string, unknown> | undefined;
      error?: string | undefined;
      error_code?: string | undefined;
    },
    late?: { previousStatus: DeliveryState; attempt: number }
  ): Promise<LateRelayDisposition>;

  async retryStaleDeliveries(
    staleMs: number,
    limit = 100,
    policy: StaleDeliveryPolicy = {}
  ): Promise<{ retried: number; dead: number; parked: number }> {
    const retryStartedDeliveries = policy.retryStartedDeliveries === true;
    const parkWithoutConsumer = policy.parkWithoutConsumer !== false;
    const noConsumerParkMaxAgeMs = positiveMs(
      policy.noConsumerParkMaxAgeMs, DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, 'no-consumer park age'
    );
    if (!Number.isSafeInteger(staleMs) || staleMs < 0) {
      throw new StoreError('conflict', 'stale timeout must be a non-negative integer of milliseconds');
    }
    const defaultCapMs = positiveMs(policy.leaseCapMs, DEFAULT_DELIVERY_LEASE_CAP_MS, 'lease cap');
    const graceMs = positiveMs(
      policy.leaseCapGraceMs, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, 'lease cap grace'
    );
    return withTransaction(this.pool, async (client) => {
      // Proyección escalar sin window functions para compatibilidad con FOR UPDATE OF d.
      // El techo se evalúa DOS veces (en la proyección y en el WHERE) con la misma expresión
      // literal a propósito: son escalares sobre la fila que el SELECT ya trae bajo lock, no
      // subconsultas y mucho menos funciones de ventana, así que conviven con `FOR UPDATE OF d`.
      const leaseCapExceeded = `${leaseCapInstantSql(`(${leaseCapMsSql('$3', '$4')})`)} <= now()`;
      const rows = await client.query<DeliveryRow & {
        execution_started: boolean;
        lease_cap_exceeded: boolean;
        lease_cap_ms: string;
        age_ms: string;
      }>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel,
                 (d.execution_started_at IS NOT NULL) AS execution_started,
                 (${leaseCapMsSql('$3', '$4')}) AS lease_cap_ms,
                 (EXTRACT(EPOCH FROM (now()-d.created_at))*1000)::bigint AS age_ms,
                 COALESCE(${leaseCapExceeded},false) AS lease_cap_exceeded
          FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('leased','accepted','started')
            AND (($1=0 OR COALESCE(d.ack_deadline_at,d.claim_expires_at,
                                   d.claimed_at+$1*interval '1 millisecond') <= now())
                 OR ${leaseCapExceeded})
         ORDER BY d.claimed_at FOR UPDATE OF d SKIP LOCKED LIMIT $2`,
        [staleMs, limit, defaultCapMs, graceMs]
      );
      const chainPolicy = await this.loadChainPolicy(client);
      // Quién tiene adaptador conectado AHORA. Va en una consulta aparte y no como subconsulta
      // del SELECT de arriba a propósito: ese SELECT lleva `FOR UPDATE OF d` y es el camino
      // caliente del reaper; la tabla de presencia tiene una fila por alias de la flota, así
      // que traerla entera cuesta menos que correlacionarla por fila.
      const consumidorVivo = new Set<string>();
      if (rows.rows.length > 0) {
        const presentes = await client.query<{ tenant_id: string; alias: string }>(
          'SELECT tenant_id,alias FROM connection_leases WHERE lease_until>now()'
        );
        for (const fila of presentes.rows) consumidorVivo.add(`${fila.tenant_id}\u0000${fila.alias}`);
      }
      let retried = 0;
      let dead = 0;
      let parked = 0;
      for (const row of rows.rows) {
        // El adaptador confirmó que el harness ARRANCÓ: obtuvo la reserva de sesión y estaba a
        // punto de invocarlo. Sólo con esa marca se retiene; "admitida y esperando el candado"
        // no cuenta y se reintenta como siempre.
        const heldForReview = row.execution_started && !retryStartedDeliveries;
        const attemptsExhausted = row.attempt >= row.max_attempts;
        const sinConsumidor = !consumidorVivo.has(
          `${row.recipient_tenant}\u0000${row.recipient_alias}`
        );
        // El techo manda sobre las otras dos condiciones y sobre la palanca de emergencia: una
        // entrega que estuvo horas renovando no se reintenta nunca, tenga o no la marca de
        // ejecución y esté o no prendido `retryStartedDeliveries`.
        const leaseCapExhausted = row.lease_cap_exceeded === true;
        // R3. Gastar los tres intentos contra un alias sin adaptador conectado no es reintentar:
        // no hubo ejecución. Se aparca y se le devuelve el intento. Las tres guardas son necesarias:
        //  - `!heldForReview`: si consta que arrancó, manda la retención; no se toca.
        //  - `!leaseCapExhausted`: el techo manda sobre todo lo demás.
        //  - `sinConsumidor`: con un adaptador vivo del otro lado el fallo SÍ es del destino y
        //    los intentos cuentan como siempre.
        // El horizonte de edad evita la entrega inmortal: pasado ese tiempo muere, y ahora deja
        // rastro en `audit_events`.
        const sinConsumidorAparcable = parkWithoutConsumer
          && attemptsExhausted
          && !heldForReview
          && !leaseCapExhausted
          && sinConsumidor
          && Number(row.age_ms) < noConsumerParkMaxAgeMs;
        if (sinConsumidorAparcable) {
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='pending',attempt=GREATEST(0,attempt-1),last_ack_rank=0,
              claimed_at=NULL,claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
              consumer_instance_id=NULL,consumer_epoch=NULL,execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',
              last_error='ACK timeout: no adapter connected; parked without spending an attempt',
              updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,'delivery.parked_no_consumer','allow',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: 'no_adapter_connected',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempt_refunded: true,
                age_ms: Number(row.age_ms),
                park_max_age_ms: noConsumerParkMaxAgeMs
              })]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-parked:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          parked += 1;
          continue;
        }
        if (attemptsExhausted || heldForReview || leaseCapExhausted) {
          // Cuando arrancó, ese es el motivo que le sirve al operador: le dice que la corrida
          // pudo haber terminado y que reencolar cuesta plata. El de intentos agotados es
          // secundario. El del techo va PRIMERO y con texto propio: "dejó de responder" y "no
          // deja de responder" son diagnósticos opuestos y confundirlos manda al operador a
          // buscar un adaptador caído que está perfectamente vivo.
          const reason = leaseCapExhausted
            ? `Lease cap exhausted: delivery renewed its claim past the ${row.lease_cap_ms} ms`
              + ' total execution ceiling; held for manual replay'
            : heldForReview
              ? 'ACK timeout: execution already started; held for manual replay'
              : 'ACK timeout: max attempts exhausted';
          await client.query(
            `UPDATE deliveries SET status='dead',terminal_at=now(),last_error=$2,updated_at=now()
             WHERE id=$1`, [row.id, reason]
          );
          await client.query(
            `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,$5,$3::jsonb,$4)
             ON CONFLICT(delivery_id) DO NOTHING`,
            [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt, reason]
          );
          let responseDisposition: AgentResponseDisposition = 'not_child';
          try {
            responseDisposition = await this.materializeAgentResponse(
              client,
              row,
              row.attempt,
              'dead',
              chainPolicy,
              undefined,
              reason
            );
          } catch (error) {
            // Delivery already transitioned to dead above.
            // If materialization fails (e.g., recipient membership issue in cross-tenant case),
            // log and continue. This prevents a single bad delivery from crashing the entire
            // reaper tick, which would block cleanup of all other alias deliveries.
            console.error(JSON.stringify({
              event: 'materialization_failed_in_reaper',
              delivery_id: row.id,
              recipient_alias: row.recipient_alias,
              recipient_tenant: row.recipient_tenant,
              error: error instanceof Error ? error.message : String(error)
            }));
          }
          const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
          if (responseDisposition === 'not_child'
            && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
            await this.insertOriginRelay(client, row, 'dead', { error: reason });
          }
          // Todo final terminal se audita; la acción distingue techo de lease y timeout.
          // Esa distinción conserva ambos conteos operativos.
          const action = leaseCapExhausted ? 'delivery.lease_cap' : 'delivery.ack_timeout';
          await client.query(
            `INSERT INTO audit_events(
               tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
             ) VALUES($1,$2,$8,'deny',$3,$4,$5,$6,$7::jsonb)`,
            [row.recipient_tenant, row.recipient_alias, row.request_id, row.message_id, row.id,
              row.trace_id, JSON.stringify({
                reason: leaseCapExhausted
                  ? 'lease_cap_exhausted'
                  : heldForReview ? 'execution_already_started' : 'max_attempts_exhausted',
                attempt: row.attempt,
                max_attempts: row.max_attempts,
                attempts_exhausted: attemptsExhausted,
                held_for_manual_replay: heldForReview || leaseCapExhausted,
                // Iba sólo en la rama del techo y sirve en las tres: la única pregunta que
                // importa al revisar una entrega muerta es si el harness llegó a correr.
                execution_started: row.execution_started,
                // Sin adaptador conectado y aun así muerta = superó el horizonte de aparcado.
                // Es la señal de que el destino lleva demasiado tiempo ausente.
                no_consumer: sinConsumidor,
                ...(leaseCapExhausted ? { lease_cap_ms: Number(row.lease_cap_ms) } : {})
              }), action]
          );
          // Morir también libera un cupo de agents.max_concurrent_deliveries: la entrega sale de
          // ('leased','accepted','started') igual que si hubiera terminado bien. La rama de retry
          // de acá abajo ya despertaba al destinatario; ésta no, y sin techo daba lo mismo porque
          // el reclamo previo se había llevado la cola entera de todas formas.
          //
          // Con techo sí importa: si las entregas en vuelo de un alias mueren todas por timeout,
          // el cupo queda libre, no va a llegar ningún ACK (por eso vencieron) y la cola pendiente
          // se quedaría quieta hasta que alguien publique un mensaje nuevo. El wake cuesta una fila
          // de outbox por entrega MUERTA — un evento raro, no uno por tick — y deja el invariante
          // parejo: toda salida del conjunto en vuelo despierta al destinatario.
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-dead:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' })]
          );
          dead += 1;
        } else {
          // Sólo se reintenta lo que nunca arrancó; el backoff evita solapar el proceso anterior.
          // La marca execution_started_at pertenece al intento vencido y se limpia antes del siguiente.
          const backoffSeconds = timeoutRetryBackoffSeconds(row.attempt);
          await client.query(
            `UPDATE deliveries SET status='retry',last_ack_rank=0,claimed_at=NULL,claim_expires_at=NULL,
              ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
              execution_started_at=NULL,
              available_at=now()+$2*interval '1 second',last_error='ACK timeout',updated_at=now()
             WHERE id=$1`, [row.id, backoffSeconds]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-timeout:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' }),
              backoffSeconds]
          );
          retried += 1;
        }
      }
      return { retried, dead, parked };
    });
  }

  /**
   * Cuatro DELETE independientes conservan ventanas y locks separados.
   * Cada DELETE usa `id IN (SELECT ... LIMIT n)` para acotar el lote sobre una base viva.
   */
  async pruneObservability(
    policy: ObservabilityRetentionPolicy = {}
  ): Promise<ObservabilityRetentionResult> {
    const ackRenewalMs = positiveMs(
      policy.ackRenewalMs, DEFAULT_RETENTION_ACK_RENEWAL_MS, 'ack renewal retention'
    );
    const ackMs = positiveMs(policy.ackMs, DEFAULT_RETENTION_ACK_MS, 'ack retention');
    const auditRenewalMs = positiveMs(
      policy.auditRenewalMs, DEFAULT_RETENTION_AUDIT_RENEWAL_MS, 'audit renewal retention'
    );
    const auditMs = positiveMs(policy.auditMs, DEFAULT_RETENTION_AUDIT_MS, 'audit retention');
    const batch = positiveMs(policy.batch, DEFAULT_RETENTION_BATCH, 'retention batch');
    const disposable = [...(policy.disposableAuditActions ?? DISPOSABLE_AUDIT_ACTIONS)];
    // Una ventana de renovaciones MÁS LARGA que la general no borraría nada de más, pero sí
    // volvería el barrido incomprensible al leer los números: la regla general ya se habría
    // llevado las renovaciones antes. Falla acá, que es donde se configura.
    if (ackRenewalMs > ackMs || auditRenewalMs > auditMs) {
      throw new StoreError(
        'conflict', 'renewal retention window cannot exceed the general retention window'
      );
    }
    const prune = async (sql: string, parameters: unknown[]): Promise<number> =>
      (await this.pool.query(sql, parameters)).rowCount ?? 0;
    return {
      ack_renewals: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE renewal AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackRenewalMs, batch]
      ),
      acks: await prune(
        `DELETE FROM delivery_acks WHERE id IN (
           SELECT id FROM delivery_acks
            WHERE created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [ackMs, batch]
      ),
      // Sólo las acciones de la lista blanca permiten podar renovaciones de audit.
      // lease_renewed identifica el backlog histórico sin columna ni backfill.
      audit_renewals: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[]) AND metadata->>'lease_renewed'='true'
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditRenewalMs, batch, disposable]
      ),
      // Lista BLANCA de acciones. Ver `DISPOSABLE_AUDIT_ACTIONS`: borrar `audit_events` por edad
      // a secas rompe el candado de idempotencia del replay y la marca de confianza de la
      // cadena agente-a-agente, en silencio y con semanas de retraso.
      audit_events: disposable.length === 0 ? 0 : await prune(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events
            WHERE action=ANY($3::text[])
              AND created_at < now()-$1*interval '1 millisecond' LIMIT $2)`,
        [auditMs, batch, disposable]
      )
    };
  }

}

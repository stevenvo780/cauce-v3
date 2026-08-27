import type { Ack, DeliveryState, ProfileRuntimeAdoptionEvidence, Tenant } from '@cauce/protocol';
import { isAmbiguousAckErrorCode } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { StoreError } from '../errors.js';
import { terminal } from '../messages.js';
import { textualReply } from '../outbox.js';
import {
  deliveryLeaseCapMs,
  type AgentResponseDisposition,
  type ChainPolicy,
  type DeliveryLeaseCap,
  type DeliveryRow,
  type LateRelayDisposition,
} from '../observability.js';
import {
  ackRank,
  agentNotifyEntries,
  agentOutputEntries,
  postgresJsonSafe,
  postgresTextSafe,
  profileRuntimeAdoptionEvidence,
  sanitizedAckResult,
  type AckResult,
  type AgentNotifyEntry,
  type AgentOutputEntry,
  type AgentOutputOutcome,
  type DelegationMaterialization,
  type DelegationRejection,
  type LateClaimProvenance,
  type LateResultRow,
  type OpenChainGate,
} from './contracts.js';
import { DeliveryClaimsRepository } from './claims.js';

export abstract class DeliveryAcksRepository extends DeliveryClaimsRepository {
  protected abstract recordProfileRuntimeAdoption(client: DatabaseClient, tenantId: Tenant, alias: string, row: DeliveryRow, ack: Ack, evidence: ProfileRuntimeAdoptionEvidence | undefined): Promise<boolean>;
  protected abstract delegationFeedbackForAck(client: DatabaseClient, deliveryId: string, attempt: number): Promise<Pick<AckResult, 'delegation_rejections' | 'delegation_materializations'>>;
  protected abstract materializeAgentOutputs(client: DatabaseClient, row: DeliveryRow, ack: Ack, outputs: AgentOutputEntry[], policy: ChainPolicy): Promise<AgentOutputOutcome>;
  protected abstract insertAck(client: DatabaseClient, row: DeliveryRow, ack: Ack, applied: boolean, persistedResult: Record<string, unknown> | undefined, renewal?: boolean): Promise<void>;
  protected abstract materializeAgentNotifications(client: DatabaseClient, row: DeliveryRow, ack: Ack, entries: AgentNotifyEntry[], ambiguousExecution: boolean): Promise<{ allowed: number; denied: number; errors: number }>;
  /**
   * Procesa el ACK de una entrega validando fences de exclusividad, límites de arrendamiento
   * y delegando a `lateTerminalSalvage` si el resultado es terminal pero la exclusividad venció.
   */
  async ackDelivery(
    deliveryId: string,
    tenantId: Tenant,
    alias: string,
    ack: Ack,
    ackDeadlineMs = 30_000,
    leaseCap: DeliveryLeaseCap = {}
  ): Promise<AckResult> {
    if (!ack.claim_token || !ack.attempt) {
      throw new StoreError('fenced', 'ACK requires claim_token and positive attempt');
    }
    if (!Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0) {
      throw new StoreError('conflict', 'ACK deadline must be a positive integer');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const selected = await client.query<
        DeliveryRow & LateResultRow & { claim_live: boolean; execution_started: boolean }
      >(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                d.late_result_at,d.cancelled_at,
                (d.ack_deadline_at>now()) AS claim_live,
                (d.execution_started_at IS NOT NULL) AS execution_started,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                 m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3 FOR UPDATE OF d`,
        [deliveryId, tenantId, alias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found for consumer');
      const safeAckResult = postgresJsonSafe(ack.result) as Record<string, unknown> | undefined;
      const outputs = agentOutputEntries(safeAckResult);
      const notifications = agentNotifyEntries(safeAckResult);
      const runtimeAdoption = profileRuntimeAdoptionEvidence(safeAckResult);
      const persistedResult = sanitizedAckResult(safeAckResult);
      const repeated = await client.query<{
        delivery_id: string;
        status: Ack['status'];
        instance_id: string;
        epoch: string;
        claim_token: string;
        attempt: number;
        applied: boolean;
      }>(
        `SELECT delivery_id,status,instance_id,epoch,claim_token,attempt,applied
         FROM delivery_acks WHERE event_id=$1 LIMIT 1`,
        [ack.event_id]
      );
      const repeatedAck = repeated.rows[0];
      if (repeatedAck) {
        const exactEvent = repeatedAck.delivery_id === deliveryId
          && repeatedAck.status === ack.status
          && repeatedAck.instance_id === ack.instance_id
          && Number(repeatedAck.epoch) === ack.epoch
          && repeatedAck.claim_token === ack.claim_token
          && repeatedAck.attempt === ack.attempt;
        if (!exactEvent) {
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'ownership_lost',
          };
        }
        // Replays terminales/accepted exactos terminan aquí; `started` sigue sólo con claim y lease vivos.
        // Ese receipt puede servir al cliente como prueba fresca de propiedad.
        if (repeatedAck.applied && ack.status !== 'started') {
          const feedback = terminal(ack.status)
            ? await this.delegationFeedbackForAck(client, deliveryId, ack.attempt)
            : {};
          return {
            delivery_id: deliveryId,
            status: row.status,
            applied: false,
            receipt: 'duplicate',
            ...feedback,
          };
        }
        // Un evento exacto antes rechazado se reevalúa: un reenvío aún puede rescatar el resultado.
        // Si sigue inválido conserva el mismo receipt; `insertAck` sólo eleva `applied` de false a true.
        // Así el primer rechazo no se vuelve irrevocable sin volver a mirar el contenido.
      }
      // Una fila terminal sólo admite el replay exacto aplicado resuelto arriba.
      // Un event_id nuevo no muta ni amplía el historial terminal, ni reconstruye feedback.
      if (row.status === 'done' || row.status === 'failed') {
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      if (row.claim_token === ack.claim_token && row.attempt === ack.attempt &&
          (row.consumer_instance_id !== ack.instance_id || Number(row.consumer_epoch) !== ack.epoch)) {
        throw new StoreError('fenced', 'ACK identity does not own this delivery claim');
      }
      const exactClaim = row.claim_token === ack.claim_token
        && row.attempt === ack.attempt
        && row.claim_live
        && ['leased', 'accepted', 'started'].includes(row.status);
      if (!exactClaim) {
        // La garra se perdió. El RESULTADO puede seguir valiendo: ver `lateTerminalSalvage`.
        const salvaged = await this.lateTerminalSalvage(
          client, tenantId, alias, row, ack, persistedResult, outputs, notifications
        );
        if (salvaged) return salvaged;
        if (!repeatedAck) await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const lease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
         AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
      );
      if (lease.rowCount !== 1
        || row.consumer_instance_id !== ack.instance_id
        || Number(row.consumer_epoch) !== ack.epoch) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: 'ownership_lost',
        };
      }
      const rank = ackRank(ack.status);
      // Punto durable de no retorno: el SDK espera este receipt antes de invocar.
      // Un crash posterior es ambiguo; COALESCE conserva el primer compromiso del intento.
      const executionStarted = ack.status === 'started' && ack.execution_started === true;
      const leaseCapMs = deliveryLeaseCapMs(row.body, leaseCap);
      // Latido de una entrega en cola ('accepted'): extiende el plazo respetando el leaseCap
      // sin alterar el estado ni registrar inicio de ejecución.
      if (ack.status === 'accepted' && row.status === 'accepted') {
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(execution_started_at,claimed_at) + $3*interval '1 millisecond'),
               updated_at=now()
           WHERE id=$1 AND status='accepted'`,
          [deliveryId, ackDeadlineMs, leaseCapMs]
        );
        if (!repeatedAck) await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              queued: true,
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'accepted',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      if (ack.status === 'started' && row.status === 'started') {
        // El ancla usa el valor posterior al UPDATE porque PostgreSQL evalúa SET sobre la fila vieja.
        // Debe coincidir con el instante que mira el reaper para no degradar el motivo a ACK timeout.
        // `LEAST` ignora NULL: una fila sin ancla no tiene techo.
        await client.query(
          `UPDATE deliveries
           SET ack_deadline_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               claim_expires_at=LEAST(
                 now()+$2*interval '1 millisecond',
                 COALESCE(CASE WHEN $3::boolean THEN COALESCE(execution_started_at,now())
                               ELSE execution_started_at END, claimed_at)
                   + $4*interval '1 millisecond'),
               execution_started_at=CASE WHEN $3::boolean
                 THEN COALESCE(execution_started_at,now()) ELSE execution_started_at END,
               updated_at=now()
           WHERE id=$1`,
          [deliveryId, ackDeadlineMs, executionStarted, leaseCapMs]
        );
        // Si un evento rechazado ahora se aplica, `insertAck` eleva false a true.
        // Para un duplicado ya aplicado sigue siendo un no-op exacto.
        await this.insertAck(client, row, ack, true, persistedResult, true);
        await client.query(
          `INSERT INTO audit_events(
             tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
           ) VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
          [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
            JSON.stringify({
              ack: ack.status,
              resulting_status: row.status,
              epoch: ack.epoch,
              attempt: ack.attempt,
              lease_renewed: true,
              ...(executionStarted ? { execution_started: true } : {}),
              ...(repeatedAck ? { duplicate_replay: true } : {})
            })]
        );
        return {
          delivery_id: deliveryId,
          status: 'started',
          applied: true,
          receipt: repeatedAck ? 'duplicate' : 'applied',
        };
      }
      if (terminal(row.status) || rank <= row.last_ack_rank) {
        await this.insertAck(client, row, ack, false, persistedResult);
        return {
          delivery_id: deliveryId,
          status: row.status,
          applied: false,
          receipt: terminal(row.status) ? 'ownership_lost' : 'superseded',
        };
      }

      let nextStatus: DeliveryState = ack.status;
      let nextRank = rank;
      let terminalAt = rank === 3 ? 'now()' : 'NULL';
      let terminalError = postgresTextSafe(ack.error);
      let terminalErrorCode = postgresTextSafe(ack.error_code);
      // Si el fallo es ambiguo pero nunca comenzó la ejecución (execution_started_at es null),
      // se permite reintento si quedan intentos disponibles; de lo contrario pasa a dead.
      const ambiguousFailure = ack.status === 'failed'
        && isAmbiguousAckErrorCode(ack.error_code);
      const ambiguousExecution = ambiguousFailure && row.execution_started;
      if (ambiguousExecution) {
        nextStatus = 'dead';
        terminalAt = 'now()';
      } else if (ack.status === 'failed' && (ack.retryable || ambiguousFailure)) {
        if (row.attempt < row.max_attempts) {
          nextStatus = 'retry';
          nextRank = 0;
          terminalAt = 'NULL';
        } else {
          nextStatus = 'dead';
          terminalAt = 'now()';
        }
      }
      if (nextStatus === 'done' && row.body.type === 'agent.fanin') {
        if (outputs.length > 0) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin cannot delegate new messages';
          terminalErrorCode = 'FANIN_REDELEGATION_FORBIDDEN';
        } else if (!textualReply(persistedResult)) {
          nextStatus = 'failed';
          terminalError = 'agent.fanin requires a non-empty final reply';
          terminalErrorCode = 'MISSING_FINAL_REPLY';
        }
      }
      const backoffSeconds = Math.min(60, 2 ** Math.max(0, row.attempt - 1));
      // El PRIMER 'started' ahora también corre el plazo, igual que las renovaciones. Antes no
      // lo movía y la base seguía contando desde el reclamo mientras el gateway, que sí lo
      // corre al ver el ACK aplicado, creía el cupo vivo más tiempo del real: las dos vistas de
      // la misma garra se iban separando por lo que hubiera tardado el arranque. Ahora el
      // instante de referencia es el mismo hecho (el ACK aplicado) en los dos lados.
      await client.query(
         `UPDATE deliveries SET status=$2,last_ack_rank=$3,last_error=$4,result=$5::jsonb,
            available_at=CASE WHEN $2='retry' THEN now()+$6*interval '1 second' ELSE available_at END,
             claimed_at=CASE WHEN $2='retry' THEN NULL ELSE claimed_at END,
             claim_expires_at=CASE WHEN $2='retry' THEN NULL
                                   WHEN $2='started' THEN LEAST(
                                     now()+$7*interval '1 millisecond',
                                     COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                   ELSE execution_started_at END, claimed_at)
                                       + $9*interval '1 millisecond')
                                   ELSE claim_expires_at END,
             ack_deadline_at=CASE WHEN $2='retry' THEN NULL
                                  WHEN $2='started' THEN LEAST(
                                    now()+$7*interval '1 millisecond',
                                    COALESCE(CASE WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                                  ELSE execution_started_at END, claimed_at)
                                      + $9*interval '1 millisecond')
                                  ELSE ack_deadline_at END,
             execution_started_at=CASE WHEN $2='retry' THEN NULL
                                       WHEN $8::boolean THEN COALESCE(execution_started_at,now())
                                       ELSE execution_started_at END,
             claim_token=CASE WHEN $2='retry' THEN NULL ELSE claim_token END,
             consumer_instance_id=CASE WHEN $2='retry' THEN NULL ELSE consumer_instance_id END,
            consumer_epoch=CASE WHEN $2='retry' THEN NULL ELSE consumer_epoch END,
            terminal_at=${terminalAt},updated_at=now() WHERE id=$1`,
        [deliveryId, nextStatus, nextRank, terminalError ?? null,
          persistedResult ? JSON.stringify(persistedResult) : null, backoffSeconds,
          ackDeadlineMs, executionStarted, leaseCapMs]
      );
      if (nextStatus === 'done') {
        await this.recordProfileRuntimeAdoption(
          client, tenantId, alias, row, ack, runtimeAdoption,
        );
      }
      if (nextStatus === 'retry') {
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
           ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
          [tenantId, `wake-retry:${deliveryId}:${row.attempt}`, row.request_id, row.message_id, deliveryId,
            row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
            JSON.stringify({ recipient_alias: alias, reason: 'delivery_available' }), backoffSeconds]
        );
      }
      // Todo error final deja rastro replayable en dead_letters, no sólo 'dead'.
      //
      // Mantener registro en dead_letters permite que `replayDelivery` funcione tanto
      // para entregas en estado 'failed' como 'dead'.
      //
      // La corrección NO es fusionar 'failed' con 'dead'. Los dos estados los consumen hoy, con
      // significados distintos, `terminal()`, el conteo de fan-in (`status IN ('done','failed',
      // 'dead')`), el CHECK de `deliveries.status`, `DeliveryStateSchema` del protocolo, la serie
      // `cauce_dispatcher_delivery_*` del dispatcher y cuatro vistas de la consola. Fusionarlos
      // borraría la única distinción útil que queda —"el agente declaró un error definitivo" vs
      // "el sistema se dio por vencido"— y dejaría una serie de métrica en cero para siempre, a
      // cambio de nada: lo que hace recuperable a una entrega no es su estado, es tener fila en
      // `dead_letters`. Así que se emite la fila para AMBOS finales de error y se relaja el
      // filtro de `replayDelivery`; el resto del sistema no se entera.
      //
      // `retryable` conserva su único trabajo legítimo: decidir si el bus REINTENTA solo. Deja de
      // decidir si un humano puede rescatar la entrega.
      if (nextStatus === 'dead' || nextStatus === 'failed') {
        await client.query(
          `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
           SELECT $1,$2,$3,m.body,$4 FROM messages m WHERE m.id=$5
           ON CONFLICT(delivery_id) DO NOTHING`,
          [deliveryId, tenantId,
            terminalError ?? terminalErrorCode
              ?? (nextStatus === 'dead'
                ? 'max attempts exhausted'
                : 'non-retryable failure without error text'),
            row.attempt, row.message_id]
        );
      }
      await this.insertAck(client, row, ack, true, persistedResult);
      let notified = { allowed: 0, denied: 0, errors: 0 };
      let delegationRejections: DelegationRejection[] = [];
      let delegationMaterializations: DelegationMaterialization[] = [];
      let chainGate: OpenChainGate | undefined;
      if (terminal(nextStatus)) {
        const policy = await this.loadChainPolicy(client);
        // El egress proactivo es efecto lateral terminal y no cuenta como delegación.
        // `ambiguousFailure` veta avisos cuando el resultado es incierto incluso sin marca de ejecución;
        // `ambiguousExecution` relajaría el veto al agotar intentos y podría afirmar efectos no probados.
        notified = await this.materializeAgentNotifications(
          client, row, ack, notifications, ambiguousFailure
        );
        let outputOutcome: AgentOutputOutcome = {
          materialized: 0, suspended: false, rejections: [], materializations: []
        };
        if (nextStatus === 'done' && row.body.type !== 'agent.fanin') {
          outputOutcome = await this.materializeAgentOutputs(client, row, ack, outputs, policy);
        }
        delegationRejections = [...outputOutcome.rejections]
          .sort((left, right) => left.output_index - right.output_index);
        delegationMaterializations = [...outputOutcome.materializations]
          .sort((left, right) => left.output_index - right.output_index);
        chainGate = outputOutcome.gate;
        const materializedOutputs = outputOutcome.materialized;
        // Delegar o suspender no termina la rama desde la perspectiva del padre.
        // Sólo la continuación agent.response autenticada puede devolver el terminal al padre.
        // Un gate humano abierto mantiene la cadena pendiente y no puede cerrarse con este ACK.
        const responseDisposition: AgentResponseDisposition = materializedOutputs > 0
          || outputOutcome.suspended
          ? 'deferred'
          : await this.materializeAgentResponse(
              client,
              row,
              ack.attempt,
              nextStatus,
              policy,
              persistedResult,
              terminalError,
              terminalErrorCode
            );
        const rootMessageId = this.rootMessageId(row);
        const fanin = await this.materializeAgentFanin(client, rootMessageId);
        if (responseDisposition === 'not_child'
          && (row.body.type === 'agent.fanin' || !fanin.hasFanout)) {
          await this.insertOriginRelay(client, row, nextStatus, {
            ...(persistedResult === undefined ? {} : { result: persistedResult }),
            ...(terminalError === undefined ? {} : { error: terminalError }),
            ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
          });
        }
      }
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
         VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
           JSON.stringify({
             ack: ack.status,
             resulting_status: nextStatus,
             epoch: ack.epoch,
             attempt: ack.attempt,
             ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode }),
             ...(ambiguousExecution ? { ambiguous_execution: true } : {}),
             // Distingue en auditoría el ambiguo ejecutado del reintentable que no llegó a correr.
             ...(ambiguousFailure && !row.execution_started
               ? { ambiguous_without_execution: true }
               : {}),
             ...(notified.allowed + notified.denied + notified.errors === 0
               ? {}
               : {
                 notifications_allowed: notified.allowed,
                 notifications_denied: notified.denied,
                 notifications_failed: notified.errors
               })
           })]
      );
      return {
        delivery_id: deliveryId,
        status: nextStatus,
        applied: true,
        receipt: 'applied',
        // Ausentes cuando no hay nada que decir: agregar claves vacías cambiaría los bytes que
        // el gateway devuelve a TODO ACK, y hay adaptadores viejos comparando la respuesta.
        ...(delegationRejections.length === 0
          ? {}
          : { delegation_rejections: delegationRejections }),
        ...(delegationMaterializations.length === 0
          ? {}
          : { delegation_materializations: delegationMaterializations }),
        ...(chainGate === undefined
          ? {}
          : { chain_gate: { gate_id: chainGate.id, question: chainGate.question } })
      };
    });
  }


  /**
   * Rescata un resultado terminal ('done' o 'failed' con texto) que llega tras expirar la exclusividad,
   * siempre que la entrega no tenga un resultado previo ni haya sido cancelada manualmente.
   */
  private async lateTerminalSalvage(
    client: DatabaseClient,
    tenantId: Tenant,
    alias: string,
    row: DeliveryRow & LateResultRow,
    ack: Ack,
    persistedResult: Record<string, unknown> | undefined,
    outputs: AgentOutputEntry[],
    notifications: AgentNotifyEntry[]
  ): Promise<AckResult | undefined> {
    // S1: sólo un terminal con respuesta visible.
    if (ack.status !== 'done' && ack.status !== 'failed') return undefined;
    const reply = textualReply(persistedResult);
    if (!reply) return undefined;
    // S2: un rescate tardío no puede materializar delegaciones.
    if (outputs.length > 0) return undefined;
    // S5: un único terminal; nunca reemplaza un resultado previo.
    if (row.status === 'done' || row.status === 'failed') return undefined;
    if (row.late_result_at !== null) return undefined;
    // Entregas canceladas por un operador no se rescatan para no duplicar respuestas hacia el padre.
    if (row.cancelled_at !== null) return undefined;
    // S6: `failed` sólo corrige una muerte ya declarada.
    if (ack.status === 'failed' && row.status !== 'dead') return undefined;
    // Un ACK que dice pertenecer a un intento que la entrega todavía no alcanzó no es tardío:
    // es imposible. Se rechaza sin mirar nada más.
    if (ack.attempt > row.attempt) return undefined;
    // S4: la instancia autenticada conserva un lease vivo.
    const lease = await client.query(
      `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
       AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
    );
    if (lease.rowCount !== 1) return undefined;
    // S3: la garra debe constar en la fila o en `delivery_acks`.
    const provenance = await this.lateClaimProvenance(client, row, ack);
    if (provenance === 'none') return undefined;

    const salvagedStatus: DeliveryState = ack.status === 'done' ? 'done' : 'dead';
    const terminalError = postgresTextSafe(ack.error);
    const terminalErrorCode = postgresTextSafe(ack.error_code);
    const previousStatus = row.status;

    // `last_ack_rank=3` deja la fila en rango terminal, así que un ACK de rango menor que
    // llegue después se lleva 'superseded' y no vuelve a entrar acá. Los plazos se anulan
    // porque ya no hay garra viva que puedan describir; `claim_token` y el consumidor se
    // CONSERVAN, que es la única traza de quién la tuvo al final.
    await client.query(
      `UPDATE deliveries
       SET status=$2,last_ack_rank=3,last_error=$3,result=$4::jsonb,
           terminal_at=COALESCE(terminal_at,now()),
           late_result_at=now(),late_result_attempt=$5,
           claim_expires_at=NULL,ack_deadline_at=NULL,updated_at=now()
       WHERE id=$1`,
      [row.id, salvagedStatus, terminalError ?? null,
        persistedResult ? JSON.stringify(persistedResult) : null, ack.attempt]
    );

    const relayDisposition = await this.undoDeathNotice(
      client, row, ack, salvagedStatus, previousStatus, persistedResult,
      terminalError, terminalErrorCode
    );

    await this.insertAck(client, row, ack, true, persistedResult);
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
       ) VALUES($1,$2,'delivery.late_result','allow',$3,$4,$5,$6,$7::jsonb)`,
      [tenantId, alias, row.request_id, row.message_id, row.id, row.trace_id,
        JSON.stringify({
          ack: ack.status,
          resulting_status: salvagedStatus,
          previous_status: previousStatus,
          epoch: ack.epoch,
          attempt: ack.attempt,
          delivery_attempt: row.attempt,
          claim_provenance: provenance,
          reply_characters: reply.length,
          // Audita efectos omitidos por S2 para medir sus falsos rechazos.
          skipped_delegations: outputs.length,
          skipped_notifications: notifications.length,
          origin_relay: relayDisposition,
          ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
        })]
    );
    return {
      delivery_id: row.id,
      status: salvagedStatus,
      applied: true,
      // Conserva el receipt del contrato `.strict()`; el rescate se distingue en auditoría
      // y columnas de deliveries, no en un valor que adaptadores anteriores rechazarían.
      receipt: 'applied',
    };
  }


  /**
   * Prueba que la garra existió: el token sólo vale si quedó registrado.
   * `current` coincide con deliveries; `applied` fue validado bajo propiedad viva.
   * `observed` quedó en delivery_acks y sólo vale con destinatario autenticado más lease S4 vivo.
   * La auditoría conserva la calidad de la prueba para poder endurecerla a `applied`.
   */
  private async lateClaimProvenance(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack
  ): Promise<LateClaimProvenance> {
    if (row.claim_token === ack.claim_token
      && row.attempt === ack.attempt
      && row.consumer_instance_id === ack.instance_id
      && Number(row.consumer_epoch) === ack.epoch) {
      return 'current';
    }
    const proof = await client.query<{ applied: boolean | null }>(
      `SELECT bool_or(applied) AS applied FROM delivery_acks
       WHERE delivery_id=$1 AND claim_token=$2 AND attempt=$3
         AND instance_id=$4 AND epoch=$5 AND event_id IS DISTINCT FROM $6`,
      [row.id, ack.claim_token, ack.attempt, ack.instance_id, ack.epoch, ack.event_id]
    );
    const applied = proof.rows[0]?.applied ?? null;
    if (applied === null) return 'none';
    return applied ? 'applied' : 'observed';
  }


  /**
   * Reconcilia los tres efectos de una muerte: entrega, dead-letter y aviso.
   *
   * `done` resuelve la dead-letter; `failed` conserva la fila con el error real.
   * El padre recibe una respuesta correctiva nueva porque el aviso anterior pudo ser leído.
   * Un relay humano pendiente se reescribe para emitir un único mensaje correcto.
   * Si ya salió, se crea `relay-late` con `LATE_RESULT_HUMAN_NOTICE`.
   * `FOR UPDATE` sobre el relay serializa la decisión contra el dispatcher.
   * Así nunca se ofrece replay de un done ni se manda una corrección humana sin contexto.
   */
  private async undoDeathNotice(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    salvagedStatus: DeliveryState,
    previousStatus: DeliveryState,
    persistedResult: Record<string, unknown> | undefined,
    terminalError: string | undefined,
    terminalErrorCode: string | undefined
  ): Promise<LateRelayDisposition> {
    if (salvagedStatus === 'done') {
      await client.query(
        `UPDATE dead_letters SET resolved_at=now()
         WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id]
      );
    } else if (terminalError !== undefined || terminalErrorCode !== undefined) {
      await client.query(
        `UPDATE dead_letters SET reason=$2 WHERE delivery_id=$1 AND resolved_at IS NULL`,
        [row.id, terminalError ?? terminalErrorCode]
      );
    }
    const policy = await this.loadChainPolicy(client);
    const responseDisposition = await this.materializeAgentResponse(
      client, row, ack.attempt, salvagedStatus, policy, persistedResult,
      terminalError, terminalErrorCode, { previousStatus }
    );
    const fanin = await this.materializeAgentFanin(client, this.rootMessageId(row));
    if (responseDisposition !== 'not_child'
      || (row.body.type !== 'agent.fanin' && fanin.hasFanout)) {
      return 'skipped';
    }
    return this.insertOriginRelay(client, row, salvagedStatus, {
      ...(persistedResult === undefined ? {} : { result: persistedResult }),
      ...(terminalError === undefined ? {} : { error: terminalError }),
      ...(terminalErrorCode === undefined ? {} : { error_code: terminalErrorCode })
    }, { previousStatus, attempt: ack.attempt });
  }
}

import type { Ack, Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withTransaction } from '../../db.js';
import { AgentNotificationsRepository } from '../agents/notifications.js';
import { postgresTextSafe } from '../deliveries.js';
import { terminal } from '../messages.js';
import type { DeliveryRow } from '../observability.js';
import { visibleText } from '../outbox.js';
import { StoreError } from '../quotas.js';


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

export abstract class DeliveryControlRepository extends AgentNotificationsRepository {
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

  /**
   * `renewal` separa el latido de la transición de estado, y esa distinción es la que hace
   * posible la retención por tipo: un ACK que sólo dice "sigo vivo" no tiene valor forense
   * pasadas unas horas, y es ~90% del volumen de la tabla. Uno que dice "pasé de accepted a
   * started" o "terminé" sí lo tiene y se conserva mucho más. Se marca acá, en el único lugar
   * que sabe con certeza cuál es cuál (la rama de renovación de `ackDelivery`), en vez de
   * inferirlo después con una función de ventana sobre la tabla entera.
   *
   * `DO UPDATE ... WHERE` en vez de `DO NOTHING`: el mismo evento puede ser rechazado primero y
   * aceptado después (un ACK terminal reenviado que la segunda vez cae en el rescate tardío, o
   * uno que falló por lease y se reintenta con el lease ya renovado). La fila tiene que quedar
   * diciendo la verdad. La cláusula sólo deja subir de `false` a `true`, nunca al revés, y
   * cuando el ACK se rechaza otra vez el UPDATE no se ejecuta: idéntico al `DO NOTHING` viejo.
   */
  protected override async insertAck(
    client: DatabaseClient,
    row: DeliveryRow,
    ack: Ack,
    applied: boolean,
    persistedResult: Record<string, unknown> | undefined,
    renewal = false
  ): Promise<void> {
    await client.query(
      `INSERT INTO delivery_acks(event_id,delivery_id,status,instance_id,epoch,claim_token,attempt,applied,renewal,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$10,$9::jsonb)
       ON CONFLICT(event_id) DO UPDATE
         SET applied=true,renewal=EXCLUDED.renewal,payload=EXCLUDED.payload
         WHERE delivery_acks.applied=false AND EXCLUDED.applied`,
      [ack.event_id, row.id, ack.status, ack.instance_id, ack.epoch, ack.claim_token, ack.attempt, applied,
        JSON.stringify({
          retryable: ack.retryable,
          ...(postgresTextSafe(ack.error) === undefined
            ? {}
            : { error: postgresTextSafe(ack.error) }),
          ...(postgresTextSafe(ack.error_code) === undefined
            ? {}
            : { error_code: postgresTextSafe(ack.error_code) }),
          ...(persistedResult === undefined ? {} : { result: persistedResult })
        }), renewal]
    );
  }
}

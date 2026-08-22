import { ArchiveX, Ban, Clock, RotateCcw, Rows3 } from 'lucide-react';
import { useState } from 'react';
import { useApi } from '../../api/context';
import type { DeliveryState, QueueItem } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';

function stateTone(state?: DeliveryState | null): 'done' | 'danger' | 'warning' | 'running' | 'unknown' {
  if (state === 'done') return 'done';
  if (state === 'dead' || state === 'failed') return 'danger';
  if (state === 'retry') return 'warning';
  if (state) return 'running';
  return 'unknown';
}

// Los dos finales de ERROR son replayables: 'failed' también deja fila en `dead_letters`. Antes el
// botón sólo aparecía en 'dead' y por eso 197 entregas de producción no tenían forma de rescate en
// la consola.
const replayableStates: ReadonlySet<string> = new Set(['dead', 'failed']);
// Cancelar aplica a lo que todavía está vivo: pendiente, en backoff o en manos de un adaptador.
const cancellableStates: ReadonlySet<string> = new Set(['pending', 'retry', 'leased', 'accepted', 'started']);

/**
 * **La tabla de entregas con su replay y su cancel** — extraída de `QueuesPage` el 2026-08-22.
 *
 * Steven pidió fundir «Queues, retries & DLQ» y que además el material de colas y cartas muertas se
 * vea desde la vista de mensajes. Las dos cosas juntas sólo se pueden cumplir de una manera: que
 * exista UNA implementación de esta tabla y que las dos pantallas la monten. Copiarla a Messages
 * habría creado el sexto par de vistas redundantes justo mientras se cierran los otros tres, y —lo
 * grave— el botón de replay habría quedado duplicado: el arreglo de 2026 que agregó `'failed'` a
 * `replayableStates` valdría en una copia y no en la otra, y nadie lo notaría hasta necesitar
 * rescatar una entrega desde la pantalla equivocada.
 *
 * `rows` llega por props y NO se pide acá: quien monta la tabla ya tiene el snapshot (la vista de
 * colas lo pide entero, la de mensajes lo tiene filtrado por conversación) y un `useResource`
 * interno significaría un segundo `GET /v3/console/queues` en la misma pantalla.
 *
 * `onChanged` es cómo el dueño del snapshot se entera de que hay que releerlo. La tabla NO muta
 * estado local para simular el efecto: pide la transición al servidor y avisa; la verdad vuelve del
 * siguiente fetch. Un replay «aplicado» pintado en el browser sin confirmación del servidor es
 * exactamente la clase de mentira que esta consola existe para no contar.
 */
export function DeliveryTable({ rows, canReplay, canCancel, onChanged, empty, caption, resaltada }: {
  rows: readonly QueueItem[];
  canReplay: boolean;
  canCancel: boolean;
  onChanged: () => void;
  empty?: string;
  caption?: string;
  /**
   * Entrega a la que llegó un enlace profundo (`/queues?delivery=`). La fila se marca con
   * `aria-current="true"` además de la clase: filtrar la tabla a una sola fila deja al lector de
   * pantalla sin forma de saber que ESA es la que se pidió, porque «una sola fila» no se anuncia.
   */
  resaltada?: string;
}) {
  const api = useApi();
  const [replaying, setReplaying] = useState<string>();
  const [cancelling, setCancelling] = useState<string>();
  const [notice, setNotice] = useState<string>();

  async function replay(deliveryId: string) {
    setReplaying(deliveryId);
    setNotice(undefined);
    try {
      const result = await api.replayDelivery(deliveryId);
      setNotice(result.replayed ? `Replay encolado para ${compactId(deliveryId)}` : `Replay no aplicado: ${compactId(deliveryId)}`);
      onChanged();
    } catch (error) {
      setNotice(`Replay falló: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    } finally {
      setReplaying(undefined);
    }
  }

  async function cancel(deliveryId: string) {
    setCancelling(deliveryId);
    setNotice(undefined);
    try {
      const result = await api.cancelDelivery(deliveryId);
      // Se dice explícitamente que sigue siendo replayable: la queja documentada del operador es
      // que cancelar a mano en la base era irreversible.
      setNotice(result.cancelled
        ? `Cancelada ${compactId(deliveryId)} (queda en DLQ, se puede replayar)`
        : `Cancelación no aplicada: ${compactId(deliveryId)}`);
      onChanged();
    } catch (error) {
      setNotice(`Cancelación falló: ${error instanceof Error ? error.message : 'UNKNOWN'}`);
    } finally {
      setCancelling(undefined);
    }
  }

  return (
    <>
      {notice ? <p className="notice" role="status">{notice}</p> : null}
      {rows.length === 0 ? <EmptyState>{empty ?? 'No hay deliveries informadas.'}</EmptyState> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">{caption ?? 'Colas, retries y dead letters'}</caption>
            <thead><tr><th>Delivery</th><th>Destino</th><th>Lane</th><th>Estado</th><th>Intentos</th><th>Disponible</th><th>Último error</th><th>Acción</th></tr></thead>
            <tbody>
              {rows.map((item, index) => {
                const state = safeDeliveryState(item.state);
                const deliveryId = item.delivery_id;
                const replayable = deliveryId != null && state != null && replayableStates.has(state);
                const cancellable = deliveryId != null && state != null && cancellableStates.has(state);
                const enfocada = resaltada != null && deliveryId === resaltada;
                return <tr
                  key={deliveryId ?? index}
                  className={enfocada ? 'fila-enfocada' : undefined}
                  aria-current={enfocada ? true : undefined}
                >
                  <td><span className="mono">{compactId(deliveryId)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                  <td><strong><Unknown value={item.recipient_alias} /></strong><small className="subline"><Unknown value={item.tenant_id} /></small></td>
                  <td><span className="inline-icon"><Rows3 size={15} aria-hidden="true" /><Unknown value={safeJobLane(item.lane)} /></span></td>
                  <td><Badge tone={stateTone(state)}><Unknown value={state} /></Badge></td>
                  <td><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                  <td><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} /></span></td>
                  <td className="error-copy"><Unknown value={item.last_error} /></td>
                  <td>
                    {replayable ? (
                      <button className="button small" type="button" onClick={() => void replay(deliveryId!)} disabled={!canReplay || replaying === deliveryId} aria-label={`Replay delivery ${deliveryId}`}>
                        <RotateCcw size={15} aria-hidden="true" />{replaying === deliveryId ? 'Enviando…' : 'Replay'}
                      </button>
                    ) : cancellable ? (
                      <button className="button small" type="button" onClick={() => void cancel(deliveryId!)} disabled={!canCancel || cancelling === deliveryId} aria-label={`Cancelar delivery ${deliveryId}`}>
                        <Ban size={15} aria-hidden="true" />{cancelling === deliveryId ? 'Cancelando…' : 'Cancelar'}
                      </button>
                    ) : <span className="muted"><ArchiveX size={15} aria-hidden="true" /> No aplica</span>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

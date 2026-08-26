import { ArchiveX, Ban, Clock, RotateCcw, Rows3, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { DeliveryState, QueueItem } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import { exactCancelReceipt, exactReplayReceipt } from './delivery-receipts';
import { leerUltimoError } from './ultimo-error';

/**
 * Los ocho estados de una entrega, en castellano. Eran los nombres de la columna `state` de la
 * base, en inglés y en mayúsculas, en una interfaz en castellano.
 */
const ESTADO_ENTREGA: Readonly<Record<DeliveryState, string>> = {
  pending: 'PENDIENTE',
  leased: 'TOMADA',
  accepted: 'ACEPTADA',
  started: 'EN CURSO',
  done: 'HECHA',
  failed: 'FALLÓ',
  retry: 'EN REINTENTO',
  dead: 'MUERTA',
};

/**
 * Estados en los que TODAVÍA no puede haber un último error, porque la entrega aún no falló.
 *
 * 🔴 Medido el 2026-08-23: una entrega `pending` mostraba «UNKNOWN» en naranja bajo «Último
 * error». «Todavía no hay error» NO es un desconocido — es la única noticia buena de la fila, y
 * pintarla del color de la alarma es lo que hace que las alarmas de verdad dejen de leerse.
 */
const SIN_FALLO_TODAVIA: ReadonlySet<string> = new Set(['pending', 'leased', 'accepted', 'started', 'done']);

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
 * QUÉ HACE CADA BOTÓN, EN UNA FRASE, ANTES DE APRETARLO.
 *
 * Salido del recorrido del 2026-08-23: «la consola no le explica qué hace ese botón ni le pide
 * confirmación antes de reinyectar a la flota». Las dos acciones mueven trabajo real de agentes
 * vivos —un replay hace que un adaptador vuelva a recibir el mensaje y pueda volver a ACTUAR— y la
 * consola las ofrecía como un enlace cualquiera, a un clic, sin decir qué pasa después.
 */
export const EXPLICACION_REPLAY =
  'Replay vuelve a encolar esta entrega: el adaptador del destinatario la recibe otra vez y puede '
  + 'volver a ejecutar lo que pida. No duplica el mensaje original ni borra la fila de dead letters.';
export const EXPLICACION_CANCEL =
  'Cancelar detiene esta entrega antes de que un adaptador la tome. Queda en dead letters y se '
  + 'puede replayar después: no es irreversible.';

interface Pendiente {
  accion: 'replay' | 'cancel';
  deliveryId: string;
  alias: string;
}

export type DeliverySnapshotRefresh =
  | { data: unknown; error?: undefined }
  | { data?: undefined; error: Error };

function addId(current: ReadonlySet<string>, deliveryId: string): ReadonlySet<string> {
  if (current.has(deliveryId)) return current;
  return new Set([...current, deliveryId]);
}

function removeId(current: ReadonlySet<string>, deliveryId: string): ReadonlySet<string> {
  if (!current.has(deliveryId)) return current;
  const next = new Set(current);
  next.delete(deliveryId);
  return next;
}

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
export function DeliveryTable({
  rows, canReplay, canCancel, onChanged, snapshotVersion, empty, caption, resaltada,
}: {
  rows: readonly QueueItem[];
  canReplay: boolean;
  canCancel: boolean;
  /** Resolves only after a new server read has either produced data or produced an error. */
  onChanged: () => Promise<DeliverySnapshotRefresh>;
  /** A later verified manual refresh also releases uncertainty left by an earlier failed read. */
  snapshotVersion?: string | null;
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
  const [replaying, setReplaying] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string>();
  const previousSnapshotVersion = useRef(snapshotVersion);
  /**
   * 🔴 Ninguna de las dos acciones sale al servidor con un solo clic.
   *
   * Es producción viva con clientes reales dentro: un replay reinyecta trabajo en la cola de un
   * agente que está corriendo. Antes de este cambio, «Replay» era un `<button>` que publicaba
   * directamente — y con siete dead letters seguidas, siete clics sin una sola pregunta.
   */
  const [pendiente, setPendiente] = useState<Pendiente>();

  useEffect(() => {
    if (previousSnapshotVersion.current === snapshotVersion) return;
    previousSnapshotVersion.current = snapshotVersion;
    // A changed version is evidence of a later successful server snapshot, including one loaded
    // from the page-level refresh after an earlier reconciliation request failed.
    setUncertain((current) => current.size === 0 ? current : new Set());
  }, [snapshotVersion]);

  async function rereadAfterUncertain(deliveryId: string): Promise<boolean> {
    setUncertain((current) => addId(current, deliveryId));
    try {
      const refreshed = await onChanged();
      if (refreshed.data === undefined) return false;
      setUncertain((current) => removeId(current, deliveryId));
      return true;
    } catch {
      return false;
    }
  }

  async function replay(deliveryId: string) {
    setReplaying((current) => addId(current, deliveryId));
    setNotice(undefined);
    try {
      const result = await api.replayDelivery(deliveryId);
      if (!exactReplayReceipt(result, deliveryId)) {
        throw new Error('el gateway no devolvió un recibo durable exacto del replay');
      }
      setNotice(`Replay encolado para ${compactId(deliveryId)}`);
      void onChanged().catch(() => undefined);
    } catch (error) {
      // Un error de red o un 2xx truncado puede ocurrir DESPUES del commit. Replay no tiene una
      // clave que el browser pueda reutilizar sin riesgo, asi que no se reintenta a ciegas: se
      // relee la fila y se declara el resultado incierto.
      const detail = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      setNotice(`Resultado incierto del reinyectado: ${detail}. Se debe releer la cola antes de volver a intentarlo; la acción queda bloqueada durante esa lectura.`);
      const verified = await rereadAfterUncertain(deliveryId);
      setNotice(`Resultado incierto del reinyectado: ${detail}. ${verified
        ? 'La cola ya se releyó; revisá el estado antes de decidir otra acción.'
        : 'No hubo una relectura verificable y la acción permanece bloqueada.'}`);
    } finally {
      setReplaying((current) => removeId(current, deliveryId));
    }
  }

  async function cancel(deliveryId: string) {
    setCancelling((current) => addId(current, deliveryId));
    setNotice(undefined);
    try {
      const result = await api.cancelDelivery(deliveryId);
      if (!exactCancelReceipt(result, deliveryId)) {
        throw new Error('el gateway no devolvió un recibo durable exacto de la cancelación');
      }
      // Se dice explícitamente que sigue siendo replayable: la queja documentada del operador es
      // que cancelar a mano en la base era irreversible.
      setNotice(`Cancelada ${compactId(deliveryId)} (queda en DLQ, se puede replayar)`);
      void onChanged().catch(() => undefined);
    } catch (error) {
      // Cancelar tambien puede haber confirmado antes de perder su respuesta. La unica autoridad
      // segura es la relectura; repetir el POST sin verla podria competir con el nuevo estado.
      const detail = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      setNotice(`Resultado incierto de la cancelación: ${detail}. Se debe releer la cola antes de volver a intentarlo; la acción queda bloqueada durante esa lectura.`);
      const verified = await rereadAfterUncertain(deliveryId);
      setNotice(`Resultado incierto de la cancelación: ${detail}. ${verified
        ? 'La cola ya se releyó; revisá el estado antes de decidir otra acción.'
        : 'No hubo una relectura verificable y la acción permanece bloqueada.'}`);
    } finally {
      setCancelling((current) => removeId(current, deliveryId));
    }
  }

  function confirmar() {
    if (!pendiente) return;
    const { accion, deliveryId } = pendiente;
    setPendiente(undefined);
    if (uncertain.has(deliveryId) || replaying.has(deliveryId) || cancelling.has(deliveryId)
        || (accion === 'replay' ? !canReplay : !canCancel)) return;
    void (accion === 'replay' ? replay(deliveryId) : cancel(deliveryId));
  }

  return (
    <>
      {notice ? <p className="notice" role="status">{notice}</p> : null}

      {/*
        La confirmación vive ARRIBA de la tabla y no dentro de la celda: en el teléfono la columna
        de acción está fuera de pantalla —hay que arrastrar la tabla en horizontal para llegar—, y
        una pregunta que aparece donde no se ve es una pregunta que nadie contesta.
      */}
      {pendiente ? (
        <div className="confirmacion-de-entrega" role="alertdialog" aria-label={`Confirmar ${pendiente.accion}`}>
          <p className="confirmacion-titulo">
            <TriangleAlert size={15} aria-hidden="true" />
            {pendiente.accion === 'replay'
              ? <>Reinyectar la entrega <span className="mono">{compactId(pendiente.deliveryId)}</span> a <strong>{pendiente.alias}</strong></>
              : <>Cancelar la entrega <span className="mono">{compactId(pendiente.deliveryId)}</span> de <strong>{pendiente.alias}</strong></>}
          </p>
          <p className="confirmacion-detalle">
            {pendiente.accion === 'replay' ? EXPLICACION_REPLAY : EXPLICACION_CANCEL}
          </p>
          <div className="confirmacion-acciones">
            <button className="button primary" type="button" onClick={confirmar}>
              {pendiente.accion === 'replay' ? 'Sí, reinyectar' : 'Sí, cancelar la entrega'}
            </button>
            <button className="button small secondary" type="button" onClick={() => setPendiente(undefined)}>
              No hacer nada
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? <EmptyState>{empty ?? 'No hay deliveries informadas.'}</EmptyState> : (
        <div className="table-wrap">
          <table className="tabla-entregas">
            <caption className="sr-only">{caption ?? 'Colas, retries y dead letters'}</caption>
            <thead><tr><th>Delivery</th><th>Destino</th><th>Lane</th><th>Estado</th><th>Intentos</th><th>Disponible</th><th>Último error</th><th>Acción</th></tr></thead>
            <tbody>
              {rows.map((item, index) => {
                const state = safeDeliveryState(item.state);
                const deliveryId = item.delivery_id;
                const replayable = deliveryId != null && state != null && replayableStates.has(state);
                const cancellable = deliveryId != null && state != null && cancellableStates.has(state);
                const enfocada = resaltada != null && deliveryId === resaltada;
                const alias = item.recipient_alias ?? 'UNKNOWN';
                const error = leerUltimoError(state, item.last_error);
                const replayInFlight = deliveryId != null && replaying.has(deliveryId);
                const cancelInFlight = deliveryId != null && cancelling.has(deliveryId);
                const outcomeUncertain = deliveryId != null && uncertain.has(deliveryId);
                return <tr
                  key={deliveryId ?? index}
                  className={enfocada ? 'fila-enfocada' : undefined}
                  aria-current={enfocada ? true : undefined}
                >
                  <td data-label="Delivery"><span className="mono">{compactId(deliveryId)}</span><small className="subline">msg {compactId(item.message_id)}</small></td>
                  <td data-label="Destino"><strong><Unknown value={item.recipient_alias} /></strong><small className="subline"><Unknown value={item.tenant_id} /></small></td>
                  <td data-label="Lane"><span className="inline-icon"><Rows3 size={15} aria-hidden="true" /><Unknown value={safeJobLane(item.lane)} /></span></td>
                  {/* El estado se dice en castellano (`ESTADO_ENTREGA`), igual que el resto de la
                      pantalla. Un valor que esta consola no conoce NO se inventa: sale UNKNOWN y el
                      `title=` dice qué mandó el servidor. */}
                  <td data-label="Estado"><Badge tone={stateTone(state)}><Unknown
                    value={state ? ESTADO_ENTREGA[state] : undefined}
                    motivo={item.state ? `El servidor mandó un estado que esta consola no conoce: ${String(item.state)}` : undefined}
                  /></Badge></td>
                  <td data-label="Intentos"><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                  <td data-label="Disponible"><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} relativo /></span></td>
                  {/*
                    «Sin error» NO es UNKNOWN. Ver `ultimo-error.ts`: 31 de las 38 filas de
                    producción pintaban un UNKNOWN ámbar sobre entregas terminadas BIEN, y el ojo
                    del operador iba ahí en vez de a las 7 dead letters. `SIN_FALLO_TODAVIA` cubre
                    el otro lado: una entrega que todavía no llegó a fallar dice «todavía no» y
                    explica por qué en el `title=`, en vez de un UNKNOWN que parece una avería.
                  */}
                  <td data-label="Último error" className="error-copy">
                    {error.clase === 'texto' ? error.texto
                      : error.clase === 'sin-error' ? <span className="sin-error">sin error</span>
                        : <Unknown
                          value={null}
                          ausente={state && SIN_FALLO_TODAVIA.has(state) ? 'todavia-no' : 'sin-dato'}
                          motivo={state && SIN_FALLO_TODAVIA.has(state)
                            ? 'Esta entrega no falló todavía, así que no hay ningún error que mostrar.'
                            : 'El servidor no informó ningún error para esta entrega.'}
                        />}
                  </td>
                  <td data-label="Acción">
                    {replayable ? (
                      <button className="button small" type="button" onClick={() => setPendiente({ accion: 'replay', deliveryId: deliveryId!, alias })} disabled={!canReplay || replayInFlight || outcomeUncertain} aria-label={`Replay delivery ${deliveryId}`}>
                        <RotateCcw size={15} aria-hidden="true" />{outcomeUncertain ? 'Revisión pendiente' : replayInFlight ? 'Enviando…' : 'Replay'}
                      </button>
                    ) : cancellable ? (
                      <button className="button small" type="button" onClick={() => setPendiente({ accion: 'cancel', deliveryId: deliveryId!, alias })} disabled={!canCancel || cancelInFlight || outcomeUncertain} aria-label={`Cancelar delivery ${deliveryId}`}>
                        <Ban size={15} aria-hidden="true" />{outcomeUncertain ? 'Revisión pendiente' : cancelInFlight ? 'Cancelando…' : 'Cancelar'}
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

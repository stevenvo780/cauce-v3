import { ArchiveX, Ban, Clock, RotateCcw, Rows3, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { DeliveryState, QueueItem } from '../../api/types';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState, safeJobLane } from '../../lib';
import { exactCancelReceipt, exactReplayReceipt } from './delivery-receipts';
import { ESTADO_ENTREGA } from './estado-de-entrega';
import { leerUltimoError } from './ultimo-error';

/**
 * States in which there STILL cannot be a last error. "No error yet" is NOT an unknown: painting
 * it in the alarm colour is what makes real alarms stop being read.
 */
const SIN_FALLO_TODAVIA: ReadonlySet<string> = new Set(['pending', 'leased', 'accepted', 'started', 'done']);

function stateTone(state?: DeliveryState | null): 'done' | 'danger' | 'warning' | 'running' | 'unknown' {
  if (state === 'done') return 'done';
  if (state === 'dead' || state === 'failed') return 'danger';
  if (state === 'retry') return 'warning';
  if (state) return 'running';
  return 'unknown';
}

// The two final error states are replayable: 'failed' and 'dead'.
const replayableStates: ReadonlySet<string> = new Set(['dead', 'failed']);
// Cancel applies to what is still alive: pending, in backoff, or in the adapter's hands.
const cancellableStates: ReadonlySet<string> = new Set(['pending', 'retry', 'leased', 'accepted', 'started']);

/** Explanation of each action before confirmation. */
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
 * Notices are indexed BY DELIVERY: with one shared notice, acting on a second row erased the
 * outcome of the first, including "uncertain, reread before deciding".
 */
function withNotice(current: ReadonlyMap<string, string>, deliveryId: string, text: string): ReadonlyMap<string, string> {
  const next = new Map(current);
  next.set(deliveryId, text);
  return next;
}

function withoutNotice(current: ReadonlyMap<string, string>, deliveryId: string): ReadonlyMap<string, string> {
  if (!current.has(deliveryId)) return current;
  const next = new Map(current);
  next.delete(deliveryId);
  return next;
}

/** Delivery table and replay/cancel control for queued messages. */
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
   * Delivery reached by a deep link (`/queues?delivery=`). The row is marked with
   * `aria-current="true"` beyond the class: filtering the table to a single row leaves the
   * screen reader no way to know THIS one is requested, since "a single row" is not announced.
   */
  resaltada?: string;
}) {
  const api = useApi();
  const [replaying, setReplaying] = useState<ReadonlySet<string>>(() => new Set());
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());
  const [uncertain, setUncertain] = useState<ReadonlySet<string>>(() => new Set());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(() => new Map());
  const previousSnapshotVersion = useRef(snapshotVersion);
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
    setNotices((current) => withoutNotice(current, deliveryId));
    try {
      const result = await api.replayDelivery(deliveryId);
      if (!exactReplayReceipt(result, deliveryId)) {
        throw new Error('el gateway no devolvió un recibo durable exacto del replay');
      }
      setNotices((current) => withNotice(current, deliveryId, `Replay encolado para ${compactId(deliveryId)}`));
      void onChanged().catch(() => undefined);
    } catch (error) {
      // A network error or a truncated 2xx can occur AFTER the commit. Replay has no key the
      // browser can safely reuse, so the retry is not done blindly: we reread the row and
      // declare the outcome uncertain.
      const detail = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const encabezado = `Resultado incierto del reinyectado de ${compactId(deliveryId)}: ${detail}.`;
      setNotices((current) => withNotice(current, deliveryId, `${encabezado} Se debe releer la cola antes de volver a intentarlo; la acción queda bloqueada durante esa lectura.`));
      const verified = await rereadAfterUncertain(deliveryId);
      setNotices((current) => withNotice(current, deliveryId, `${encabezado} ${verified
        ? 'La cola ya se releyó; revisá el estado antes de decidir otra acción.'
        : 'No hubo una relectura verificable y la acción permanece bloqueada.'}`));
    } finally {
      setReplaying((current) => removeId(current, deliveryId));
    }
  }

  async function cancel(deliveryId: string) {
    setCancelling((current) => addId(current, deliveryId));
    setNotices((current) => withoutNotice(current, deliveryId));
    try {
      const result = await api.cancelDelivery(deliveryId);
      if (!exactCancelReceipt(result, deliveryId)) {
        throw new Error('el gateway no devolvió un recibo durable exacto de la cancelación');
      }
      setNotices((current) => withNotice(current, deliveryId, `Cancelada ${compactId(deliveryId)} (queda en DLQ, se puede replayar)`));
      void onChanged().catch(() => undefined);
    } catch (error) {
      // Cancel may also have confirmed before losing its response. The only safe authority is the
      // reread; reissuing the POST without it could race the new state.
      const detail = error instanceof Error ? error.message : 'el servidor no dijo por qué';
      const encabezado = `Resultado incierto de la cancelación de ${compactId(deliveryId)}: ${detail}.`;
      setNotices((current) => withNotice(current, deliveryId, `${encabezado} Se debe releer la cola antes de volver a intentarlo; la acción queda bloqueada durante esa lectura.`));
      const verified = await rereadAfterUncertain(deliveryId);
      setNotices((current) => withNotice(current, deliveryId, `${encabezado} ${verified
        ? 'La cola ya se releyó; revisá el estado antes de decidir otra acción.'
        : 'No hubo una relectura verificable y la acción permanece bloqueada.'}`));
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
      {/* One line per delivery acted on, and each one names its own: the phone stacks the table and
          the action column is not where an operator looks for the outcome of what they just did. */}
      {[...notices].map(([deliveryId, texto]) => (
        <p className="notice" role="status" key={deliveryId}>{texto}</p>
      ))}

      {/*
        The confirmation lives ABOVE the table, not inside the cell: on the phone the action column
        is off-screen —you have to drag the table horizontally to reach it—, and a question appearing
        where it cannot be seen is a question nobody answers.
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
            <button className="button small secondary" type="button" onClick={() => { setPendiente(undefined); }}>
              No hacer nada
            </button>
          </div>
        </div>
      ) : null}

      {rows.length === 0 ? <EmptyState>{empty ?? 'No hay deliveries informadas.'}</EmptyState> : (
        <Desplazable etiqueta={caption ?? 'Colas, retries y dead letters'}>
          <table className="tabla-entregas">
            <caption className="sr-only">{caption ?? 'Colas, retries y dead letters'}</caption>
            <thead><tr><th>Delivery</th><th>Destino</th><th>Carril</th><th>Estado</th><th>Intentos</th><th>Disponible</th><th>Último error</th><th>Acción</th></tr></thead>
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
                  <td data-label="Carril"><span className="inline-icon"><Rows3 size={15} aria-hidden="true" /><Unknown value={safeJobLane(item.lane)} /></span></td>
                  {/* The status label is shown in Spanish (`ESTADO_ENTREGA`), like the rest of the
                      screen. A value this console does not know is NOT invented: UNKNOWN is shown
                      and the `title=` says what the server sent. */}
                  <td data-label="Estado"><Badge tone={stateTone(state)}><Unknown
                    value={state ? ESTADO_ENTREGA[state] : undefined}
                    motivo={item.state ? `El servidor mandó un estado que esta consola no conoce: ${item.state}` : undefined}
                  /></Badge></td>
                  <td data-label="Intentos"><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                  <td data-label="Disponible"><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} relativo /></span></td>
                  {/* "No error" is not UNKNOWN; SIN_FALLO_TODAVIA covers deliveries that have not yet failed. */}
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
                      <button className="button small" type="button" onClick={() => { setPendiente({ accion: 'replay', deliveryId, alias }); }} disabled={!canReplay || replayInFlight || outcomeUncertain} aria-label={`Replay delivery ${deliveryId}`}>
                        <RotateCcw size={15} aria-hidden="true" />{outcomeUncertain ? 'Revisión pendiente' : replayInFlight ? 'Enviando…' : 'Replay'}
                      </button>
                    ) : cancellable ? (
                      <button className="button small" type="button" onClick={() => { setPendiente({ accion: 'cancel', deliveryId, alias }); }} disabled={!canCancel || cancelInFlight || outcomeUncertain} aria-label={`Cancelar delivery ${deliveryId}`}>
                        <Ban size={15} aria-hidden="true" />{outcomeUncertain ? 'Revisión pendiente' : cancelInFlight ? 'Cancelando…' : 'Cancelar'}
                      </button>
                    ) : <span className="muted"><ArchiveX size={15} aria-hidden="true" /> No aplica</span>}
                  </td>
                </tr>;
              })}
            </tbody>
          </table>
        </Desplazable>
      )}
    </>
  );
}

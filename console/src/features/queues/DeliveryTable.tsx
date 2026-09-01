import { ArchiveX, Ban, Clock, RotateCcw, Rows3, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import type { QueueItem } from '../../api/types';
import { Badge, Desplazable, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeJobLane } from '../../lib';
import {
  cancelDeliverySafely, replayDeliverySafely, rereadProvesDeliveryEffect,
  type DeliveryReconciliation, type DeliverySnapshotRefresh,
} from '../deliveries/delivery-actions';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { leerUltimoError } from './ultimo-error';

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

export type { DeliverySnapshotRefresh } from '../deliveries/delivery-actions';

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

function withUncertainty(
  current: ReadonlyMap<string, DeliveryReconciliation>,
  reconciliation: DeliveryReconciliation,
): ReadonlyMap<string, DeliveryReconciliation> {
  const next = new Map(current);
  next.set(reconciliation.deliveryId, reconciliation);
  return next;
}

function withoutUncertainty(
  current: ReadonlyMap<string, DeliveryReconciliation>,
  deliveryId: string,
): ReadonlyMap<string, DeliveryReconciliation> {
  if (!current.has(deliveryId)) return current;
  const next = new Map(current);
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
  const [uncertain, setUncertain] = useState<ReadonlyMap<string, DeliveryReconciliation>>(() => new Map());
  const [notices, setNotices] = useState<ReadonlyMap<string, string>>(() => new Map());
  const previousSnapshot = useRef({ rows, version: snapshotVersion });
  const [pendiente, setPendiente] = useState<Pendiente>();

  useEffect(() => {
    const changed = previousSnapshot.current.version !== snapshotVersion
      || previousSnapshot.current.rows !== rows;
    previousSnapshot.current = { rows, version: snapshotVersion };
    if (!changed || uncertain.size === 0) return;
    const snapshot = { items: rows };
    const proven = [...uncertain.values()].filter((reconciliation) => (
      rereadProvesDeliveryEffect(reconciliation, snapshot)
    ));
    if (proven.length === 0) return;
    setUncertain((current) => {
      const next = new Map(current);
      for (const reconciliation of proven) next.delete(reconciliation.deliveryId);
      return next;
    });
    setNotices((current) => {
      let next = current;
      for (const reconciliation of proven) {
        const action = reconciliation.action === 'replay' ? 'el replay' : 'la cancelación';
        next = withNotice(
          next,
          reconciliation.deliveryId,
          `Una relectura posterior demostró ${action} de ${compactId(reconciliation.deliveryId)}; no se repetirá el POST.`,
        );
      }
      return next;
    });
  }, [rows, snapshotVersion, uncertain]);

  async function replay(deliveryId: string) {
    setReplaying((current) => addId(current, deliveryId));
    setNotices((current) => withoutNotice(current, deliveryId));
    try {
      const outcome = await replayDeliverySafely({
        api,
        deliveryId,
        reread: onChanged,
        onUncertain: (notice, reconciliation) => {
          setUncertain((current) => withUncertainty(current, reconciliation));
          setNotices((current) => withNotice(current, deliveryId, notice));
        },
      });
      if (outcome.kind === 'uncertain' && outcome.effectProven) {
        setUncertain((current) => withoutUncertainty(current, deliveryId));
      }
      setNotices((current) => withNotice(current, deliveryId, outcome.notice));
    } finally {
      setReplaying((current) => removeId(current, deliveryId));
    }
  }

  async function cancel(deliveryId: string) {
    setCancelling((current) => addId(current, deliveryId));
    setNotices((current) => withoutNotice(current, deliveryId));
    try {
      const outcome = await cancelDeliverySafely({
        api,
        deliveryId,
        reread: onChanged,
        onUncertain: (notice, reconciliation) => {
          setUncertain((current) => withUncertainty(current, reconciliation));
          setNotices((current) => withNotice(current, deliveryId, notice));
        },
      });
      if (outcome.kind === 'uncertain' && outcome.effectProven) {
        setUncertain((current) => withoutUncertainty(current, deliveryId));
      }
      setNotices((current) => withNotice(current, deliveryId, outcome.notice));
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
                const policy = deliveryPolicy(item.state);
                const state = policy.state;
                const deliveryId = item.delivery_id;
                const replayable = deliveryId != null && policy.replayable;
                const cancellable = deliveryId != null && policy.cancellable;
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
                  {/* The status label is shown in Spanish, like the rest of the
                      screen. A value this console does not know is NOT invented: UNKNOWN is shown
                      and the `title=` says what the server sent. */}
                  <td data-label="Estado"><Badge tone={policy.tone}><Unknown
                    value={policy.known ? policy.label : undefined}
                    motivo={item.state && !policy.known ? `El servidor mandó un estado que esta consola no conoce: ${item.state}` : undefined}
                  /></Badge></td>
                  <td data-label="Intentos"><Unknown value={item.attempts} /> / <Unknown value={item.max_attempts} /></td>
                  <td data-label="Disponible"><span className="inline-icon"><Clock size={15} aria-hidden="true" /><Time value={item.available_at} relativo /></span></td>
                  {/* "No error" is not UNKNOWN when the lifecycle policy says no failure is expected. */}
                  <td data-label="Último error" className="error-copy">
                    {error.clase === 'texto' ? error.texto
                      : error.clase === 'sin-error' ? <span className="sin-error">sin error</span>
                        : <Unknown
                          value={null}
                          ausente={policy.errorExpectation === 'absent' ? 'todavia-no' : 'sin-dato'}
                          motivo={policy.errorExpectation === 'absent'
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

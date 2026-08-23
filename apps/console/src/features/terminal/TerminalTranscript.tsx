import { ArrowDownLeft, ArrowUpRight, CheckCircle2, CircleDashed, Clock3, Scissors } from 'lucide-react';
import type { DeliveryState, DeliveryView } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState } from '../../lib';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada } from './cuerpo-del-mensaje';
import type { TranscriptItem } from './session';

function deliveryTone(state?: DeliveryState): 'done' | 'danger' | 'warning' | 'running' | 'unknown' {
  if (state === 'done') return 'done';
  if (state === 'dead' || state === 'failed') return 'danger';
  if (state === 'retry') return 'warning';
  return state ? 'running' : 'unknown';
}

function DeliveryProgress({ delivery, onSelect }: { delivery: DeliveryView; onSelect: () => void }) {
  const state = safeDeliveryState(delivery.status);
  const events = delivery.timeline ?? [];
  const last = events.at(-1);
  return (
    <button className="transcript-delivery" type="button" data-delivery-id={delivery.delivery_id ?? undefined} onClick={onSelect}>
      <span className="delivery-state-icon" aria-hidden="true">
        {state === 'done' ? <CheckCircle2 size={14} /> : state ? <CircleDashed size={14} /> : <Clock3 size={14} />}
      </span>
      <Badge tone={deliveryTone(state)}><Unknown value={state} /></Badge>
      <span className="mono">{compactId(delivery.delivery_id)}</span>
      <span>{events.length} ACK · intento {delivery.attempt ?? last?.attempt ?? 'UNKNOWN'}</span>
    </button>
  );
}

/**
 * El historial de una conversación, en burbujas.
 *
 * 🔴 **Por qué la selección va por `message_id` y no por `delivery_id`.** Hasta el 2026-08-23 la
 * burbuja se marcaba con `data-selected={delivery?.delivery_id === selectedDeliveryId || undefined}`.
 * Medido en producción abriendo el hilo de zeus SIN dar un solo clic: 51 burbujas y DIEZ con
 * `data-selected="true"`, con su anillo azul puesto (posiciones 2, 4, 6, 8, 14, 15, 16, 18, 30 y
 * 47). El motivo es de una línea: los mensajes de salida NO tienen entrega para este par, así que
 * `delivery?.delivery_id` es `undefined`; cuando además nadie ha seleccionado nada,
 * `selectedDeliveryId` también es `undefined`, y `undefined === undefined` es `true`. La consola
 * marcaba como «elegidas por el operador» exactamente las burbujas de las que menos sabía.
 *
 * Ahora se compara el id del MENSAJE y sólo cuando hay uno: sin selección no hay ninguna burbuja
 * marcada, que es lo que un operador que no tocó nada tiene derecho a ver. El identificador de
 * mensaje es además el único que TODAS las burbujas tienen —la mitad del hilo no tiene entrega—,
 * y por eso clicar una burbuja de salida ahora sí hace algo: antes no había nada que clicar.
 */
export function TerminalTranscript({ items, selectedMessageId, onSelectItem }: {
  items: TranscriptItem[];
  /** Id del mensaje elegido. `undefined` significa NINGUNO; nunca «todos». */
  selectedMessageId?: string;
  onSelectItem: (item: TranscriptItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="terminal-transcript-empty">
        <EmptyState>
          No hay mensajes de servidor para esta combinación agente/room. Enviá una instrucción o esperá el próximo polling.
        </EmptyState>
      </div>
    );
  }

  const latestMessageId = items.at(-1)?.message.message_id;
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Feed con {items.length} mensajes. Último: {compactId(latestMessageId)}
      </div>
      <div className="terminal-transcript" aria-label="Historial de la sesión">
        {items.map((item, index) => {
          const { message, direction, delivery } = item;
          const recortado = previsualizacionRecortada(message.body_preview);
          return (
            <article
              className={`transcript-entry ${direction}`}
              key={message.message_id ?? `${direction}-${index}`}
              data-selected={(selectedMessageId != null && message.message_id === selectedMessageId) || undefined}
            >
              <header>
                <span className="transcript-direction">
                  {direction === 'input' ? <ArrowUpRight size={15} aria-hidden="true" /> : <ArrowDownLeft size={15} aria-hidden="true" />}
                  {direction === 'input' ? 'Operador → agente' : 'Agente → room'}
                </span>
                <Time value={message.created_at} />
              </header>
              <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}{recortado ? '…' : null}</p>
              {/*
                El corte se ROTULA. El servidor manda `left(body,240)` y sin esta línea la burbuja
                presentaba un mensaje cortado a mitad de palabra con la misma cara que uno entero.
              */}
              {recortado ? (
                <p className="transcript-truncado">
                  <Scissors size={12} aria-hidden="true" />
                  <span>
                    El servidor publica sólo los primeros {CARACTERES_DE_PREVISUALIZACION} caracteres en la lista:
                    esto puede estar recortado. El cuerpo entero se pide desde el detalle.
                  </span>
                </p>
              ) : null}
              <footer>
                <span className="mono">msg {compactId(message.message_id)}</span>
                <span className="mono">trace {compactId(message.trace_id)}</span>
              </footer>
              {delivery ? (
                <DeliveryProgress delivery={delivery} onSelect={() => onSelectItem(item)} />
              ) : (
                /*
                 * Antes esto era un `<span>` inerte: la mitad del hilo —todo lo que el agente
                 * escribió— no se podía seleccionar, y clicarlo no cambiaba el detalle. Ahora es
                 * el mismo botón que la fila de entrega, con el mismo efecto.
                 */
                <button
                  className="transcript-output-note"
                  type="button"
                  onClick={() => onSelectItem(item)}
                >Salida observada desde el feed durable del room · ver detalle</button>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

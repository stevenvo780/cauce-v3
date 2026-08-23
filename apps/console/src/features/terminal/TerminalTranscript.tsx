import { ArrowDownLeft, ArrowUpRight, CheckCircle2, CircleDashed, Clock3 } from 'lucide-react';
import type { DeliveryState, DeliveryView } from '../../api/types';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId, safeDeliveryState } from '../../lib';
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
      <span>{events.length} ACK · intento {delivery.attempt ?? last?.attempt ?? 'sin dato'}</span>
    </button>
  );
}

export function TerminalTranscript({ items, selectedDeliveryId, onSelectDelivery }: {
  items: TranscriptItem[];
  selectedDeliveryId?: string;
  onSelectDelivery: (delivery: DeliveryView) => void;
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
        {items.map(({ message, direction, delivery }, index) => (
          <article
            className={`transcript-entry ${direction}`}
            key={message.message_id ?? `${direction}-${index}`}
            data-selected={delivery?.delivery_id === selectedDeliveryId || undefined}
          >
            <header>
              <span className="transcript-direction">
                {direction === 'input' ? <ArrowUpRight size={15} aria-hidden="true" /> : <ArrowDownLeft size={15} aria-hidden="true" />}
                {direction === 'input' ? 'Operador → agente' : 'Agente → room'}
              </span>
              <Time value={message.created_at} />
            </header>
            <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}</p>
            <footer>
              <span className="mono">msg {compactId(message.message_id)}</span>
              <span className="mono">trace {compactId(message.trace_id)}</span>
            </footer>
            {delivery ? (
              <DeliveryProgress delivery={delivery} onSelect={() => onSelectDelivery(delivery)} />
            ) : <span className="transcript-output-note">Salida observada desde el feed durable del room.</span>}
          </article>
        ))}
      </div>
    </>
  );
}

import { ArrowRight, CheckCircle2, CircleDashed, Clock3, Scissors } from 'lucide-react';
import type { DeliveryView } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId } from '../../lib';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada } from './cuerpo-del-mensaje';
import type { TranscriptItem } from './session';

function DeliveryProgress({ delivery, onSelect, compact, disabled }: { delivery: DeliveryView; onSelect: () => void; compact?: boolean; disabled?: boolean }) {
  const policy = deliveryPolicy(delivery.status);
  const events = delivery.timeline ?? [];
  const last = events.at(-1);
  return (
    <button className="transcript-delivery" type="button" disabled={disabled} data-delivery-id={delivery.delivery_id ?? undefined} onClick={onSelect}>
      <span className="delivery-state-icon" aria-hidden="true">
        {policy.state === 'done' ? <CheckCircle2 size={14} /> : policy.known ? <CircleDashed size={14} /> : <Clock3 size={14} />}
      </span>
      <Badge tone={policy.tone}><Unknown
        value={policy.known ? policy.label : undefined}
        motivo={delivery.status && !policy.known
          ? `El servidor mandó un estado que esta consola no conoce: ${delivery.status}`
          : undefined}
      /></Badge>
      {compact ? <span>{disabled ? 'Detalle no disponible: mensaje sin identificador' : 'Ver detalle'}</span> : <>
        <span className="mono">{compactId(delivery.delivery_id)}</span>
        <span>{events.length} ACK · intento {delivery.attempt ?? last?.attempt ?? 'sin dato'}</span>
      </>}
    </button>
  );
}

/**
 * Rendering component for the terminal transcript and conversation history.
 */
export function TerminalTranscript({ items, selectedMessageId, onSelectItem, presentation = 'terminal' }: {
  items: TranscriptItem[];
  presentation?: 'chat' | 'terminal';
  /** Id of the selected message. `undefined` means NONE; never "all". */
  selectedMessageId?: string;
  onSelectItem: (item: TranscriptItem) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="terminal-transcript-empty">
        <EmptyState>
          {presentation === 'chat' ? 'No hay mensajes de este agente en la ventana recibida. Podés escribirle para iniciar o retomar la conversación.' : 'No hay mensajes de servidor para este agente. Publicá desde Mensajes o esperá el próximo polling.'}
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
              key={message.message_id ?? `${direction}-${String(index)}`}
              data-selected={(selectedMessageId != null && message.message_id === selectedMessageId) || undefined}
            >
              <header>
                <span className="transcript-direction">
                  <AgentAvatar alias={message.actor_alias ?? '?'} tenantId={message.tenant_id ?? ''} />
                  <span>{message.actor_alias ?? 'Emisor sin dato'}</span>
                  <ArrowRight size={14} aria-hidden="true" /><span className="sr-only">hacia</span>
                  <span>{direction === 'input' ? delivery?.recipient_alias ?? 'Destino sin dato' : message.room_id ?? 'Sala sin dato'}</span>
                </span>
                <Time value={message.created_at} />
              </header>
              <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}{recortado ? '…' : null}</p>
              {/*
                The truncation is LABELED. The server sends `left(body,240)` and without this line
                the bubble showed a message cut mid-word with the same look as a full one.
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
              {presentation === 'terminal' ? <footer>
                <span className="mono">msg {compactId(message.message_id)}</span>
                <span className="mono">trace {compactId(message.trace_id)}</span>
              </footer> : null}
              {delivery ? (
                <DeliveryProgress compact={presentation === 'chat'} disabled={presentation === 'chat' && !message.message_id} delivery={delivery} onSelect={() => { onSelectItem(item); }} />
              ) : (
                /*
                 * Before this was an inert `<span>`: half the thread —everything the agent wrote—
                 * could not be selected, and clicking it did not change the detail. Now it is the
                 * same button as the delivery row, with the same effect.
                 */
                <button
                  className="transcript-output-note"
                  type="button"
                  disabled={presentation === 'chat' && !message.message_id}
                  onClick={() => { onSelectItem(item); }}
                >{presentation === 'chat' ? message.message_id ? 'Ver detalle del mensaje' : 'Detalle no disponible: mensaje sin identificador' : 'Salida observada desde el feed durable del room · ver detalle'}</button>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
}

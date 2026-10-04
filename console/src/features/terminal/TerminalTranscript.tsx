import { Fragment } from 'react';
import { ArrowRight, CheckCircle2, CircleDashed, Clock3, Scissors } from 'lucide-react';
import type { DeliveryView } from '../../api/types';
import { AgentAvatar } from '../../components/AgentAvatar';
import { Badge, EmptyState, Time, Unknown } from '../../components/ui';
import { compactId } from '../../lib';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { CARACTERES_DE_PREVISUALIZACION, previsualizacionRecortada } from './cuerpo-del-mensaje';
import type { TranscriptItem } from './session';
import { humanAuthor } from './message-author';
import type { CanonicalReply } from '../messages/use-canonical-reply';

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

function CanonicalResponse({ reply, stale, onRetry, chatBubble = false }: {
  reply: CanonicalReply;
  stale?: boolean;
  onRetry?: () => void;
  chatBubble?: boolean;
}) {
  return (
    <section className="canonical-reply" aria-label={`Respuesta canónica de ${reply.tenantId}:${reply.alias}`} data-delivery-id={reply.deliveryId}>
      {!chatBubble ? <p className="eyebrow">Respuesta de {reply.tenantId}:{reply.alias}</p> : null}
      {reply.reply === undefined ? <p>Respuesta canónica no disponible en este gateway.</p>
        : reply.reply === null || reply.reply === '' ? <p>Sin respuesta canónica disponible.</p>
          : <p style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{reply.reply}</p>}
      {reply.chainOpen === true ? <p role="status">Respuesta provisional · cadena en curso</p>
        : reply.chainOpen === false && ['done', 'failed', 'dead'].includes(reply.status ?? '')
          ? <p>Respuesta consolidada</p>
          : reply.chainOpen === false
            ? <p>La cadena informa cierre, pero aún no hay un estado terminal comprobado.</p>
            : <p>Estado de la cadena no informado · no se demuestra que haya cerrado.</p>}
      {stale ? <p role="status">Dato desactualizado; la última lectura falló.</p> : null}
      {(reply.chainOpen === undefined
        || (!reply.chainOpen && !['done', 'failed', 'dead'].includes(reply.status ?? '')))
        && onRetry
        ? <button className="button small secondary" type="button" onClick={onRetry}>Releer respuesta</button>
        : null}
    </section>
  );
}

/**
 * Rendering component for the terminal transcript and conversation history.
 */
export function TerminalTranscript({ items, selectedMessageId, onSelectItem, presentation = 'terminal', canonicalReply, canonicalReplyStale, onCanonicalReplyRetry }: {
  items: TranscriptItem[];
  presentation?: 'chat' | 'terminal';
  /** Id of the selected message. `undefined` means NONE; never "all". */
  selectedMessageId?: string;
  onSelectItem: (item: TranscriptItem) => void;
  canonicalReply?: CanonicalReply;
  canonicalReplyStale?: boolean;
  onCanonicalReplyRetry?: () => void;
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
          const author = humanAuthor(message);
          const authorLabel = author?.display_name ?? (author ? 'Persona autenticada' : message.actor_alias ?? 'Emisor sin dato');
          const humanChat = presentation === 'chat' && direction === 'input' && author !== undefined;
          const response = canonicalReply && delivery !== undefined
            && canonicalReply.messageId === message.message_id
            && canonicalReply.deliveryId === delivery.delivery_id
            && canonicalReply.tenantId === delivery.recipient_tenant
            && canonicalReply.alias === delivery.recipient_alias
            ? <CanonicalResponse reply={canonicalReply} stale={canonicalReplyStale} onRetry={onCanonicalReplyRetry} chatBubble={humanChat} />
            : null;
          return (
            <Fragment key={message.message_id ?? `${direction}-${String(index)}`}>
              <article
                className={`transcript-entry ${direction}`}
                data-selected={(selectedMessageId != null && message.message_id === selectedMessageId) || undefined}
                data-message-id={message.message_id ?? undefined}
              >
                <header>
                  <span className="transcript-direction">
                    <AgentAvatar alias={authorLabel} tenantId={message.tenant_id ?? ''} />
                    <span title={author ? `Persona autenticada · identidad técnica: ${message.actor_alias ?? 'sin dato'}` : 'Identidad técnica; autor humano no registrado'}>{authorLabel}</span>
                    {humanChat ? <span className="sr-only">Persona autenticada</span> : <>
                      <ArrowRight size={14} aria-hidden="true" /><span className="sr-only">hacia</span>
                      <span>{direction === 'input' ? delivery?.recipient_alias ?? 'Destino sin dato' : message.room_id ?? 'Sala sin dato'}</span>
                    </>}
                  </span>
                  <Time value={message.created_at} />
                </header>
                <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}{recortado ? '…' : null}</p>
                {!humanChat ? response : null}
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
                {humanChat ? (
                  <details className="chat-agent-details">
                    <summary>Detalles del mensaje{delivery ? ` · ${deliveryPolicy(delivery.status).label}` : ''}</summary>
                    <p>Identidad técnica: {message.tenant_id ?? 'sin dato'}:{message.actor_alias ?? 'sin dato'} · destino: {delivery?.recipient_tenant ?? 'sin dato'}:{delivery?.recipient_alias ?? 'sin dato'}</p>
                    {delivery ? <DeliveryProgress compact disabled={!message.message_id} delivery={delivery} onSelect={() => { onSelectItem(item); }} /> : null}
                  </details>
                ) : delivery ? (
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
              {humanChat && response && canonicalReply ? (
                <article className="transcript-entry output" data-reply-to={message.message_id} aria-label={`Mensaje de ${canonicalReply.alias}`}>
                  <header>
                    <span className="transcript-direction">
                      <AgentAvatar alias={canonicalReply.alias} tenantId={canonicalReply.tenantId} />
                      <span>{canonicalReply.alias}</span><span className="sr-only">Agente</span>
                    </span>
                  </header>
                  {response}
                </article>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </>
  );
}

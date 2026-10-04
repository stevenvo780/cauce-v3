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

interface StructuredBody {
  type: string;
  value: Record<string, unknown>;
}

function structuredBody(preview: string | null | undefined): StructuredBody | undefined {
  if (typeof preview !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(preview);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    if (typeof value.type !== 'string' || !value.type.trim()) return undefined;
    return { type: value.type, value };
  } catch {
    return undefined;
  }
}

const STRUCTURED_LABELS = new Map([
  ['system.gate.probe', 'Comprobación de conexión'],
  ['agent.message', 'Mensaje entre agentes'],
  ['agent.response', 'Respuesta entre agentes'],
  ['agent.fanin', 'Resumen de respuestas de agentes'],
  ['agent.notify', 'Notificación del agente'],
]);

function structuredLabel(type: string): string {
  return STRUCTURED_LABELS.get(type) ?? 'Mensaje estructurado';
}

function structuredDescription(type: string): string | undefined {
  if (type === 'system.gate.probe') return 'Solicitud para comprobar la disponibilidad del agente.';
  return undefined;
}

function displayField(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return 'Valor estructurado';
  }
}

function formatTimeout(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (value % 1_000 === 0) return `${String(value / 1_000)} segundos`;
  return `${String(value)} ms`;
}

function StructuredMessage({ body }: { body: StructuredBody }) {
  const timeout = body.type === 'system.gate.probe' ? formatTimeout(body.value.timeout_ms) : undefined;
  const fields = Object.entries(body.value).filter(([key]) => key !== 'type' && key !== 'nonce'
    && !(body.type === 'system.gate.probe' && key === 'timeout_ms' && timeout !== undefined));
  return (
    <section className="chat-structured-message" role="group" aria-label={structuredLabel(body.type)}>
      <header><strong>{structuredLabel(body.type)}</strong></header>
      {structuredLabel(body.type) === 'Mensaje estructurado' ? <p>Tipo: {body.type}</p> : null}
      {structuredDescription(body.type) ? <p>{structuredDescription(body.type)}</p> : null}
      {fields.length > 0 ? (
        <dl>{fields.map(([key, value]) => <div key={key}>
          <dt>{key.replaceAll('_', ' ')}</dt><dd>{displayField(value)}</dd>
        </div>)}</dl>
      ) : null}
      {timeout ? <dl><div><dt>Plazo</dt><dd>{timeout}</dd></div></dl> : null}
      <details>
        <summary>Detalle técnico</summary>
        <pre>{JSON.stringify(body.value, null, 2)}</pre>
      </details>
    </section>
  );
}

function DeliveryCheck({ delivery, responseReceived = false }: { delivery: DeliveryView; responseReceived?: boolean }) {
  const status = delivery.status ?? [...(delivery.timeline ?? [])].reverse()
    .find((event) => event.status !== 'published')?.status;
  const published = delivery.timeline?.some((event) => event.status === 'published') === true;
  let label: string;
  let checks: 0 | 1 | 2;
  let tone: 'neutral' | 'positive' | 'danger';
  if (status === 'accepted') {
    label = 'El agente aceptó la entrega'; checks = 1; tone = 'positive';
  } else if (status === 'started') {
    label = 'El agente inició la ejecución'; checks = 1; tone = 'positive';
  } else if (status === 'done') {
    label = responseReceived ? 'El agente terminó; respuesta recibida' : 'El agente terminó; respuesta no disponible';
    checks = responseReceived ? 2 : 1; tone = 'positive';
  } else if (status === 'failed') {
    label = 'La ejecución falló'; checks = 0; tone = 'danger';
  } else if (status === 'dead') {
    label = 'La entrega quedó detenida'; checks = 0; tone = 'danger';
  } else if (status === 'retry') {
    label = 'Cauce reintentará la entrega'; checks = published ? 1 : 0; tone = 'neutral';
  } else if (status === 'pending' || status === 'leased') {
    label = published ? 'Publicado · esperando aceptación del agente' : 'Esperando estado durable de la entrega';
    checks = published ? 1 : 0; tone = 'neutral';
  } else if (published) {
    label = 'Publicado en Cauce'; checks = 1; tone = 'neutral';
  } else {
    label = 'Estado de entrega no disponible'; checks = 0; tone = 'neutral';
  }
  return (
    <span className={`chat-delivery-check chat-delivery-check-${tone}`} role="status" aria-label={`Entrega: ${label}`} title={label}>
      {checks > 0 ? <span aria-hidden="true" data-checks={checks}>
        {checks === 2 ? '✓✓' : '✓'}
      </span> : <span aria-hidden="true">!</span>}
      {checks === 0 ? <span>{label}</span> : null}
    </span>
  );
}

function CanonicalReplyDetails({ reply, stale, onRetry }: {
  reply: CanonicalReply;
  stale?: boolean;
  onRetry?: () => void;
}) {
  const terminal = ['done', 'failed', 'dead'].includes(reply.status ?? '');
  const availability = typeof reply.reply === 'string' && reply.reply.trim().length > 0
    ? 'Respuesta recibida'
    : reply.reply === null || (typeof reply.reply === 'string' && reply.reply.trim().length === 0)
      ? 'Respuesta vacía' : 'Respuesta no disponible';
  const chain = reply.chainOpen === true ? 'Cadena en curso'
    : reply.chainOpen === false && terminal ? `Cadena cerrada · ${deliveryPolicy(reply.status).label}`
      : reply.chainOpen === false ? 'El gateway indica cierre; falta confirmar estado terminal'
        : 'Estado de cierre no informado';
  return (
    <div className="chat-reply-status">
      <p>{availability}</p>
      <p>{chain}</p>
      {stale ? <p role="status">La última lectura está desactualizada.</p> : null}
      {(reply.chainOpen === undefined || (!reply.chainOpen && !terminal)) && onRetry
        ? <button className="button small secondary" type="button" onClick={onRetry}>Releer respuesta</button>
        : null}
    </div>
  );
}

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
          const estructura = presentation === 'chat' ? structuredBody(message.body_preview) : undefined;
          const author = humanAuthor(message);
          const authorLabel = author?.display_name ?? (author ? 'Persona autenticada' : message.actor_alias ?? 'Emisor sin dato');
          const humanChat = presentation === 'chat' && direction === 'input' && author !== undefined;
          const matchingReply = canonicalReply && delivery !== undefined
            && canonicalReply.messageId === message.message_id
            && canonicalReply.deliveryId === delivery.delivery_id
            && canonicalReply.tenantId === delivery.recipient_tenant
            && canonicalReply.alias === delivery.recipient_alias
            ? canonicalReply : undefined;
          const responseReceived = typeof matchingReply?.reply === 'string' && matchingReply.reply.trim().length > 0;
          const response = matchingReply && (!humanChat || responseReceived)
            ? <CanonicalResponse reply={matchingReply} stale={canonicalReplyStale} onRetry={onCanonicalReplyRetry} chatBubble={humanChat} />
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
                  {humanChat && delivery ? <DeliveryCheck delivery={delivery} responseReceived={responseReceived} /> : null}
                </header>
                {estructura
                  ? <StructuredMessage body={estructura} />
                  : <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}{recortado ? '…' : null}</p>}
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
                    {matchingReply ? <CanonicalReplyDetails reply={matchingReply} stale={canonicalReplyStale} onRetry={onCanonicalReplyRetry} /> : null}
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

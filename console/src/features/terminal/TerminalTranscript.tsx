import { Fragment } from 'react';
import { ArrowRight, Scissors } from 'lucide-react';
import { MessageActions } from '../messages/MessageActions';
import { MessageDeliveryCheck } from '../messages/MessageDeliveryCheck';
import { AgentAvatar } from '../../components/AgentAvatar';
import { EmptyState, Time } from '../../components/ui';
import { compactId } from '../../lib';
import { previsualizacionRecortada } from './cuerpo-del-mensaje';
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
    </section>
  );
}

function CanonicalResponse({ reply }: { reply: CanonicalReply }) {
  return (
    <section className="canonical-reply" aria-label={`Respuesta canónica de ${reply.tenantId}:${reply.alias}`} data-delivery-id={reply.deliveryId}>
      <p style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{reply.reply}</p>
    </section>
  );
}

export function TerminalTranscript({ items, selectedMessageId, onSelectItem, canonicalReply, canonicalReplyStale, onCanonicalReplyRetry }: {
  items: TranscriptItem[];
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
          No hay mensajes de este agente en la ventana recibida. Podés escribirle para iniciar o retomar la conversación.
        </EmptyState>
      </div>
    );
  }

  const latestMessageId = items.at(-1)?.message.message_id;
  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Historial con {items.length} mensajes. Último: {compactId(latestMessageId)}
      </div>
      <div className="terminal-transcript" aria-label="Historial de la sesión">
        {items.map((item, index) => {
          const { message, direction, delivery } = item;
          const recortado = previsualizacionRecortada(message.body_preview);
          const estructura = structuredBody(message.body_preview);
          const author = humanAuthor(message);
          const authorLabel = author?.display_name ?? (author ? 'Persona autenticada' : message.actor_alias ?? 'Emisor sin dato');
          const humanChat = direction === 'input' && author !== undefined;
          const matchingReply = canonicalReply && delivery !== undefined
            && canonicalReply.messageId === message.message_id
            && canonicalReply.deliveryId === delivery.delivery_id
            && canonicalReply.tenantId === delivery.recipient_tenant
            && canonicalReply.alias === delivery.recipient_alias
            ? canonicalReply : undefined;
          const responseReceived = typeof matchingReply?.reply === 'string' && matchingReply.reply.trim().length > 0;
          const consolidated = matchingReply?.chainOpen === false
            && ['done', 'failed', 'dead'].includes(matchingReply.status ?? '');
          const response = matchingReply && responseReceived && consolidated
            ? <CanonicalResponse reply={matchingReply} /> : null;
          return (
            <Fragment key={message.message_id ?? `${direction}-${String(index)}`}>
              <article
                className={`transcript-entry ${direction}`}
                data-selected={(selectedMessageId != null && message.message_id === selectedMessageId) || undefined}
                data-message-id={message.message_id ?? undefined}
                onContextMenu={(event) => {
                  event.preventDefault();
                  if (message.message_id) onSelectItem(item);
                }}
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
                  {direction === 'input' && delivery ? <MessageDeliveryCheck delivery={delivery} /> : null}
                  <MessageActions disabled={!message.message_id} onDetail={() => { onSelectItem(item); }}
                    onRetry={matchingReply && (!consolidated || canonicalReplyStale) ? onCanonicalReplyRetry : undefined} />
                </header>
                {estructura
                  ? <StructuredMessage body={estructura} />
                  : <p>{message.body_preview ?? 'Contenido no incluido por el servidor.'}{recortado ? '…' : null}</p>}
                {!humanChat ? response : null}
                {recortado ? <p className="transcript-truncado"><Scissors size={12} aria-hidden="true" /><span>Vista previa recortada</span></p> : null}
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

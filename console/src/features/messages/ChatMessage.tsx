import { Scissors } from 'lucide-react';
import { useEffect, useState, type HTMLAttributes, type MouseEvent, type ReactNode } from 'react';
import { AgentOrb } from '../../components/AgentOrb';
import { cn } from '../../cn';
import { timestampExacto } from '../../lib';
import type { LiveState } from '../live/agent-state';
import { clientMailboxRecipientLabel, isClientMailboxDelivery } from '../deliveries/client-mailbox';
import { previsualizacionRecortada } from '../terminal/cuerpo-del-mensaje';
import { humanAuthor, messageAuthorPresentation } from '../terminal/message-author';
import type { TranscriptItem } from '../terminal/session';
import { MessageActions } from './MessageActions';
import { MessageAttachments } from './MessageAttachments';
import { MessageDeliveryCheck } from './MessageDeliveryCheck';
import { messageAttachmentList, messageMediaKind } from './message-attachment-list';
import { optimisticMessageOf } from './optimistic-message';
import { RichText } from './RichText';
import { replyConsolidated, replyFor } from './thread-model';
import type { CanonicalReply } from './use-canonical-reply';

/** What the console holds of a message's full body: requested, read, or failed. */
export type FullBody = { estado: 'pidiendo' } | { estado: 'listo'; texto: string } | { estado: 'fallo'; motivo: string };

interface StructuredBody {
  type: string;
  value: Record<string, unknown>;
}

const STRUCTURED_LABELS = new Map([
  ['system.gate.probe', 'Comprobación de conexión'],
  ['agent.message', 'Mensaje entre agentes'],
  ['agent.response', 'Respuesta entre agentes'],
  ['agent.fanin', 'Resumen de respuestas de agentes'],
  ['agent.notify', 'Notificación del agente'],
]);

function structuredBody(preview: string | null | undefined): StructuredBody | undefined {
  if (typeof preview !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(preview);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = parsed as Record<string, unknown>;
    return typeof value.type === 'string' && value.type.trim() ? { type: value.type, value } : undefined;
  } catch {
    return undefined;
  }
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
  return value % 1_000 === 0 ? `${String(value / 1_000)} segundos` : `${String(value)} ms`;
}

function StructuredMessage({ body }: { body: StructuredBody }) {
  const label = STRUCTURED_LABELS.get(body.type) ?? 'Mensaje estructurado';
  const probe = body.type === 'system.gate.probe';
  const timeout = probe ? formatTimeout(body.value.timeout_ms) : undefined;
  const fields = Object.entries(body.value).filter(([key]) => key !== 'type' && key !== 'nonce'
    && !(probe && key === 'timeout_ms' && timeout !== undefined));
  if (timeout) fields.push(['Plazo', timeout]);
  return (
    <section role="group" aria-label={label} className="grid min-w-0 gap-2 rounded-xl border border-line bg-subtle p-3 text-[13px]">
      <strong className="font-semibold text-fg">{label}</strong>
      {label === 'Mensaje estructurado' ? <p className="m-0 text-fg-2">Tipo: {body.type}</p> : null}
      {probe ? <p className="m-0 text-fg-2">Solicitud para comprobar la disponibilidad del agente.</p> : null}
      {fields.length > 0 ? (
        <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          {fields.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted first-letter:uppercase">{key.replaceAll('_', ' ')}</dt>
              <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">{displayField(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

const clock = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' });

function MessageTime({ value }: { value: string | null | undefined }) {
  const time = Date.parse(value ?? '');
  if (Number.isNaN(time)) return null;
  return <time dateTime={value ?? undefined} title={timestampExacto(value)}>{clock.format(time)}</time>;
}

function LocalMessageFile({ file }: { file: File }) {
  const [url, setUrl] = useState<string>();
  const kind = messageMediaKind(file.type);
  useEffect(() => {
    if (kind === 'document') return;
    const preview = URL.createObjectURL(file);
    setUrl(preview);
    return () => { URL.revokeObjectURL(preview); };
  }, [file, kind]);
  return <li>
    {url && kind === 'image' ? <img className="size-9 shrink-0 rounded-md object-cover" src={url} alt={`Adjunto local: ${file.name}`} /> : null}
    {url && kind === 'video' ? <video className="h-9 w-[min(160px,42vw)] shrink-0" src={url} controls playsInline preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    {url && kind === 'audio' ? <audio className="h-9 w-[min(160px,42vw)] shrink-0" src={url} controls preload="metadata" aria-label={`Vista previa de ${file.name}`} /> : null}
    <span>{file.name}</span>
  </li>;
}

function previewText(preview: string | null | undefined, truncated: boolean): string {
  if (typeof preview !== 'string') return 'Contenido no incluido por el servidor.';
  if (preview.trim().length === 0) return 'Mensaje sin contenido textual.';
  return `${preview}${truncated ? '…' : ''}`;
}

function TruncatedNote({ body, onExpand }: { body?: FullBody; onExpand?: () => void }) {
  return (
    <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      <Scissors size={12} aria-hidden="true" />
      <span>Vista previa recortada</span>
      {onExpand ? (
        <button type="button" onClick={onExpand} disabled={body?.estado === 'pidiendo'}
          className="cursor-pointer border-0 bg-transparent p-0 text-xs font-medium text-brand-ink hover:underline disabled:cursor-wait disabled:opacity-60">
          {body?.estado === 'pidiendo' ? 'Leyendo…' : 'Mostrar todo'}
        </button>
      ) : null}
      {body?.estado === 'fallo' ? <span className="text-danger-ink">{body.motivo}</span> : null}
    </p>
  );
}

function AgentRow({ seed, name, state, time, startsGroup, children, ...rest }: {
  seed: string;
  name: ReactNode;
  state?: LiveState;
  time?: string | null;
  startsGroup: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLElement> & Record<`data-${string}`, unknown>) {
  return (
    <article {...rest} className={cn('group/msg flex gap-3 rounded-xl data-[selected]:bg-brand-soft/50 data-[selected]:ring-1 data-[selected]:ring-brand/30', startsGroup ? 'mt-5' : 'mt-1.5')}>
      <div className="w-7 shrink-0 pt-0.5">{startsGroup ? <AgentOrb seed={seed} state={state} size={28} /> : null}</div>
      <div className="grid min-w-0 flex-1 gap-2">
        {startsGroup ? (
          <header className="flex items-baseline gap-2 text-[13px] leading-none">
            <span className="font-semibold text-fg">{name}</span>
            <span className="text-xs text-muted"><MessageTime value={time} /></span>
          </header>
        ) : null}
        {children}
      </div>
    </article>
  );
}

export function ChatMessage({ item, ownSubject, startsGroup, selected, fullBody, agentState, canonicalReply, canonicalReplyStale, onSelect, onExpand, onReplyRetry }: {
  item: TranscriptItem;
  /** The signed-in human: their own messages need no author line. */
  ownSubject?: string | null;
  startsGroup: boolean;
  selected: boolean;
  fullBody?: FullBody;
  agentState?: LiveState;
  canonicalReply?: CanonicalReply;
  canonicalReplyStale?: boolean;
  onSelect: (item: TranscriptItem, opener?: HTMLElement | null) => void;
  onExpand: (messageId: string) => void;
  onReplyRetry?: () => void;
}) {
  const { message, direction, delivery } = item;
  const optimistic = optimisticMessageOf(item);
  const id = message.message_id ?? undefined;
  const hasText = typeof message.body_preview === 'string' && message.body_preview.trim().length > 0;
  const full = fullBody?.estado === 'listo' ? fullBody.texto : undefined;
  const truncated = !optimistic && hasText && full === undefined && previsualizacionRecortada(message.body_preview);
  const structured = full === undefined ? structuredBody(message.body_preview) : undefined;
  const showText = full !== undefined || hasText || messageAttachmentList(message.attachments).length === 0;
  const text = full ?? previewText(message.body_preview, truncated);
  const matching = replyFor(item, canonicalReply);
  const deliveryState = optimistic?.state === 'published' && delivery?.status === 'pending'
    && matching?.status && !canonicalReplyStale ? { ...delivery, status: matching.status } : delivery;
  const retry = matching && (!replyConsolidated(matching) || canonicalReplyStale) ? onReplyRetry : undefined;
  const actions = <MessageActions disabled={!id} onDetail={(opener) => { onSelect(item, opener); }} onRetry={retry} />;
  const common = {
    'data-direction': direction,
    'data-message-id': id,
    'data-selected': selected || undefined,
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      if (id) onSelect(item);
    },
  };
  const truncation = truncated ? <TruncatedNote body={fullBody} onExpand={id ? () => { onExpand(id); } : undefined} /> : null;

  if (direction === 'output') {
    const alias = message.actor_alias ?? 'Emisor sin dato';
    return (
      <AgentRow {...common} seed={`${message.tenant_id ?? ''}/${alias}`} state={agentState} startsGroup={startsGroup}
        time={message.created_at} name={<span title="Identidad técnica; autor humano no registrado">{alias}</span>}>
        {structured ? <StructuredMessage body={structured} /> : showText ? <RichText text={text} /> : null}
        <MessageAttachments messageId={message.message_id} files={message.attachments} />
        {truncation}
        <div className="-ml-1 flex h-7 items-center gap-1 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/msg:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">
          {actions}
        </div>
      </AgentRow>
    );
  }

  const author = humanAuthor(message);
  const { label: authorLabel, title: authorTitle, clientDeclarationNotice } = messageAuthorPresentation(message);
  const own = Boolean(author && ownSubject && author.subject_id === ownSubject);
  const mailbox = isClientMailboxDelivery(delivery);
  const failed = !mailbox && (delivery?.status === 'failed' || delivery?.status === 'dead');
  const destination = mailbox ? (
    <span data-mailbox-destination="" title={`Buzón: ${delivery.recipient_alias ?? 'sin dirección'}`}>
      <span>{clientMailboxRecipientLabel(delivery)}</span>
      {delivery.recipient_alias ? <small className="font-mono"> ({delivery.recipient_alias})</small> : null}
    </span>
  ) : delivery?.recipient_alias ?? 'Destino sin dato';
  return (
    <article {...common} className={cn('group/msg flex flex-col items-end', startsGroup ? 'mt-5' : 'mt-1.5')}>
      {own ? <span className="sr-only">{authorLabel}</span> : startsGroup ? (
        <div className="mb-1 px-1 text-xs text-muted">
          <span title={authorTitle}>{authorLabel}</span>
          {clientDeclarationNotice ? <span className="sr-only">{clientDeclarationNotice}</span> : null}
          {author ? <span className="sr-only">Persona autenticada</span> : <><span aria-hidden="true"> → </span><span className="sr-only">hacia</span>{destination}</>}
        </div>
      ) : null}
      {structured ? <div className="w-full max-w-[min(85%,36rem)]"><StructuredMessage body={structured} /></div> : showText ? (
        <div className="max-w-[min(85%,36rem)] rounded-[20px] bg-muted-bg px-4 py-2.5 text-[14px] leading-relaxed text-fg [overflow-wrap:anywhere] group-data-[selected]/msg:ring-2 group-data-[selected]/msg:ring-brand/40">
          <p className="m-0 whitespace-pre-wrap">{text}</p>
        </div>
      ) : null}
      <div className="flex max-w-[min(85%,36rem)] justify-end"><MessageAttachments messageId={message.message_id} files={optimistic?.files.length ? undefined : message.attachments} /></div>
      {optimistic?.files.length ? (
        <ul className="m-0 grid min-w-0 list-none gap-1.5 p-0" aria-label="Archivos del mensaje">
          {optimistic.files.map((file, index) => <LocalMessageFile key={index} file={file} />)}
        </ul>
      ) : null}
      {truncation ? <div className="mt-1 px-1">{truncation}</div> : null}
      <div className="mt-1 flex items-center gap-2 px-1 text-[11px] text-muted">
        <span className="opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/msg:opacity-100 [@media(hover:hover)]:focus-within:opacity-100">{actions}</span>
        <MessageTime value={message.created_at} />
        {optimistic && optimistic.state !== 'published' ? (
          <span role="status" aria-label={`Publicación: ${optimistic.state === 'sending' ? 'Enviando' : 'Sin confirmar'}`}>
            <span aria-hidden="true">{optimistic.state === 'sending' ? '◷' : '!'}</span>
            {optimistic.state === 'failed' ? ' Sin confirmar' : null}
          </span>
        ) : deliveryState ? <MessageDeliveryCheck delivery={deliveryState} /> : null}
        {failed && id ? (
          <button type="button" onClick={() => { onSelect(item); }}
            className="cursor-pointer border-0 bg-transparent p-0 text-[11px] font-medium text-danger-ink underline-offset-2 hover:underline">
            Ver detalle
          </button>
        ) : null}
      </div>
    </article>
  );
}

export function ChatReply({ reply, startsGroup, agentState }: { reply: CanonicalReply; startsGroup: boolean; agentState?: LiveState }) {
  return (
    <AgentRow seed={`${reply.tenantId}/${reply.alias}`} name={reply.alias} state={agentState} startsGroup={startsGroup}
      data-direction="output" data-reply-to={reply.messageId} aria-label={`Mensaje de ${reply.alias}`}>
      <section aria-label={`Respuesta canónica de ${reply.tenantId}:${reply.alias}`} data-delivery-id={reply.deliveryId} className="grid gap-2">
        {reply.reply?.trim() ? <RichText text={reply.reply} /> : null}
        {reply.replyAttachmentDeliveryId !== undefined && reply.replyAttachmentAttempt !== undefined
          ? <MessageAttachments messageId={reply.messageId} files={reply.replyAttachments}
            replySource={{ deliveryId: reply.replyAttachmentDeliveryId, attempt: reply.replyAttachmentAttempt }} /> : null}
      </section>
    </AgentRow>
  );
}

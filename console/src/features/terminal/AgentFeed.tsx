import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import type { MessagePage } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { cn } from '../../cn';
import { Time } from '../../components/ui';
import type { FleetAgent } from './fleet';
import { humanAuthor } from './message-author';
import { transcriptForSession } from './session';

/** Read-only recent traffic of one agent, from the roster's own message window. It never writes. */
export function AgentFeed({ agent, messages }: { agent: FleetAgent; messages: Resource<MessagePage> }) {
  const items = useMemo(() => transcriptForSession(messages.data, { agent }), [messages.data, agent]);
  const end = useRef<HTMLLIElement>(null);
  const last = items.at(-1)?.message.message_id;
  useEffect(() => {
    // jsdom and some embedded webviews do not implement scrollIntoView.
    const node: Partial<Pick<HTMLElement, 'scrollIntoView'>> | null = end.current;
    node?.scrollIntoView?.({ block: 'end' });
  }, [last]);

  if (messages.loading && !messages.data) return <p className="m-0 p-4 text-[13px] text-muted" role="status">Leyendo mensajes…</p>;
  if (messages.error && !messages.data) return <p className="m-0 p-4 text-[13px] text-danger-ink" role="alert">No se pudieron leer los mensajes: {messages.error.message}</p>;
  if (items.length === 0) {
    return <p className="m-0 p-4 text-[13px] text-muted">Sin mensajes de {agent.alias} en la ventana que devolvió el servidor.</p>;
  }
  return (
    <ol aria-label={`Mensajes recientes de ${agent.alias}`} className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
      {items.map(({ message, direction }, index) => {
        const author = humanAuthor(message);
        const who = author?.display_name ?? (author ? 'Persona autenticada' : message.actor_alias ?? 'Emisor sin dato');
        const Icon = direction === 'input' ? ArrowDownLeft : ArrowUpRight;
        const preview = message.body_preview?.trim();
        return (
          <li key={message.message_id ?? `${direction}-${String(index)}`} className="flex gap-2.5 border-b border-line px-4 py-2.5">
            <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full', direction === 'input' ? 'bg-info-soft text-info-ink' : 'bg-ok-soft text-ok-ink')}>
              <Icon size={12} aria-hidden="true" />
              <span className="sr-only">{direction === 'input' ? 'Recibido' : 'Emitido'}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 flex items-baseline gap-2 text-xs text-muted">
                <span className="truncate font-medium text-fg-2">{who}</span>
                <Time value={message.created_at} />
              </p>
              <p className="m-0 mt-0.5 line-clamp-4 max-w-[80ch] text-[13px] break-words whitespace-pre-wrap text-fg">{preview === undefined || preview === '' ? 'Mensaje sin contenido textual.' : preview}</p>
            </div>
          </li>
        );
      })}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

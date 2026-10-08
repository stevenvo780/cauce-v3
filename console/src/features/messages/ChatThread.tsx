import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentOrb } from '../../components/AgentOrb';
import { bloomOrb } from '../../components/orb-bloom';
import type { LiveState } from '../live/agent-state';
import type { TranscriptItem } from '../terminal/session';
import { ChatMessage, ChatReply, type ComposeFn, type FullBody } from './ChatMessage';
import { replyFor, threadRows, typingState, type ThreadRow } from './thread-model';

const SETTLED = new Set(['done', 'failed', 'dead']);
import type { CanonicalReply } from './use-canonical-reply';

const SUGGESTIONS = ['¿En qué estás trabajando?', 'Resumime tu último turno', '¿Qué te bloquea?'];

function EmptyThread({ seed, alias, state, onSuggestion }: {
  seed: string; alias: string; state?: LiveState; onSuggestion?: (text: string) => void;
}) {
  return (
    <div className="grid min-h-[50dvh] place-content-center justify-items-center gap-4 py-10 text-center">
      <AgentOrb seed={seed} state={state} size={56} sleeping={state === undefined || state === 'idle' || state === 'down'} />
      <div className="grid gap-1">
        <h3 className="m-0 text-lg font-semibold tracking-tight text-fg">Empezá la conversación con {alias}</h3>
        <p className="m-0 text-[13px] text-muted">No hay mensajes con este agente en la ventana recibida.</p>
      </div>
      {onSuggestion ? (
        <div className="flex flex-wrap justify-center gap-2">
          {SUGGESTIONS.map((text) => (
            <button key={text} type="button" onClick={() => { onSuggestion(text); }}
              className="cursor-pointer rounded-full border border-line bg-surface px-3.5 py-1.5 text-[13px] text-fg-2 transition-colors hover:border-line-strong hover:bg-subtle hover:text-fg">
              {text}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TypingBubble({ seed, alias, state }: { seed: string; alias: string; state: 'thinking' | 'receiving' }) {
  const label = state === 'thinking' ? 'pensando…' : 'recibiendo…';
  return (
    <div className="mt-5 flex items-center gap-3" data-typing={state}>
      <AgentOrb seed={seed} state={state} size={28} />
      <div className="flex items-center gap-2.5 rounded-2xl bg-subtle px-3.5 py-2 text-muted" role="status" aria-label={`${alias} está ${label}`}>
        <span className="flex items-center gap-1" aria-hidden="true">
          <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
        </span>
        <span className="text-[13px]" aria-hidden="true">{label}</span>
      </div>
    </div>
  );
}

export function ChatThread({ items, ownSubject, alias, seed, agentState, selectedMessageId, fullBodies, canonicalReply, canonicalReplies, canonicalReplyStale, onSelectItem, onExpand, onCanonicalReplyRetry, onSuggestion, onCompose }: {
  items: TranscriptItem[];
  ownSubject?: string | null;
  alias: string;
  seed: string;
  agentState?: LiveState;
  /** `undefined` means none is selected, never "all". */
  selectedMessageId?: string;
  fullBodies: Record<string, FullBody>;
  canonicalReply?: CanonicalReply;
  canonicalReplies?: readonly CanonicalReply[];
  canonicalReplyStale?: boolean;
  onSelectItem: (item: TranscriptItem, opener?: HTMLElement | null) => void;
  onExpand: (messageId: string) => void;
  onCanonicalReplyRetry?: () => void;
  onSuggestion?: (text: string) => void;
  onCompose?: ComposeFn;
}) {
  const replies = useMemo(() => canonicalReply ? [canonicalReply, ...(canonicalReplies ?? [])] : canonicalReplies, [canonicalReply, canonicalReplies]);
  const rows = useMemo(() => threadRows(items, replies), [items, replies]);
  const typing = typingState({ items, reply: replies, live: agentState });
  const seen = useRef<Set<string> | null>(null);
  seen.current ??= new Set(rows.map((row) => row.key));
  // History that loads after the first paint (replies to roots already settled, older pages) is
  // not news: it enters still and makes no orb bloom, so switching chats does not replay a burst.
  const mountedAt = useRef(Date.now());
  const settledRoots = useRef<Set<string> | null>(null);
  settledRoots.current ??= new Set(rows.filter((row) => row.kind === 'message' && SETTLED.has(row.item.delivery?.status ?? '')).map((row) => row.key));
  const quiet = useCallback((row: ThreadRow) => (row.kind === 'reply' ? settledRoots.current?.has(row.key.replace(/-reply$/u, '')) === true
    : row.kind === 'message' && Date.parse(row.item.message.created_at ?? '') < mountedAt.current - 60_000), []);
  const [settled, setSettled] = useState(false);
  useEffect(() => { setSettled(true); }, []);
  useEffect(() => {
    const known = seen.current;
    if (!known) return;
    const added = rows.filter((row) => row.kind !== 'day' && !known.has(row.key));
    for (const row of added) known.add(row.key);
    const fresh = added.filter((row) => !quiet(row));
    if (fresh.some((row) => row.kind === 'reply')) bloomOrb(seed, 'sparkle');
    else if (fresh.some((row) => row.kind === 'message' && row.side === 'agent')) bloomOrb(seed);
  }, [rows, seed, quiet]);
  if (items.length === 0) return <EmptyThread seed={seed} alias={alias} state={agentState} onSuggestion={onSuggestion} />;

  const last = [...rows].reverse().find((row) => row.kind !== 'day');
  const lastAuthor = last?.kind === 'reply' ? last.reply.alias
    : last?.kind === 'message' ? last.item.message.author?.display_name ?? last.item.message.actor_alias ?? undefined : undefined;
  return (
    <>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        Historial con {items.length} mensajes.{lastAuthor ? ` Último de ${lastAuthor}.` : ''}
      </p>
      <div role="log" aria-live="off" aria-label="Historial de la conversación" className="thread-log flex flex-col pb-2" data-settled={settled || undefined}>
        {rows.map((row) => {
          if (row.kind === 'day') {
            return (
              <div key={row.key} role="separator" aria-label={row.label} className="mt-6 mb-1 flex items-center gap-3 text-[11px] font-medium text-muted first:mt-0">
                <span className="h-px flex-1 bg-line" /><span className="first-letter:uppercase">{row.label}</span><span className="h-px flex-1 bg-line" />
              </div>
            );
          }
          if (row.kind === 'reply') return <ChatReply key={row.key} reply={row.reply} startsGroup={row.startsGroup} agentState={agentState} onCompose={onCompose} quiet={quiet(row)} />;
          const id = row.item.message.message_id ?? undefined;
          return (
            <ChatMessage
              key={row.key}
              item={row.item}
              ownSubject={ownSubject}
              startsGroup={row.startsGroup}
              selected={selectedMessageId !== undefined && id === selectedMessageId}
              fullBody={id ? fullBodies[id] : undefined}
              agentState={agentState}
              canonicalReply={replyFor(row.item, replies)}
              canonicalReplyStale={Boolean(replyFor(row.item, canonicalReply)) && canonicalReplyStale}
              onSelect={onSelectItem}
              onExpand={onExpand}
              onCompose={onCompose}
              quiet={quiet(row)}
              onReplyRetry={onCanonicalReplyRetry}
            />
          );
        })}
        {typing ? <TypingBubble seed={seed} alias={alias} state={typing} /> : null}
      </div>
    </>
  );
}

import { CircleAlert, Send, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { BOTTOM_BAR_VIEWPORT } from '../../breakpoints';
import { cn } from '../../cn';
import { AgentOrb } from '../../components/AgentOrb';
import { onNavClick } from '../../router';
import { useMediaQuery } from '../../shell/use-media-query';
import type { LiveState } from '../live/agent-state';
import type { OfficeDialogModel } from './use-office-chat';

/** Height the on-screen keyboard takes from the bottom of the layout viewport. */
function useKeyboardInset(active: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) return undefined;
    const update = () => { setInset(Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop))); };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [active]);
  return inset;
}

const BOX = 'relative border-[3px] border-fg bg-surface text-fg shadow-[inset_0_0_0_2px_var(--color-surface),inset_0_0_0_4px_var(--color-line),0_4px_0_0_rgba(0,0,0,0.22)]';

/** RPG-style talk box at the bottom of the office; on phones it rides above the keyboard. */
export function OfficeDialog({ model, state, onClose }: { model: OfficeDialogModel; state: LiveState; onClose: () => void }) {
  const phone = useMediaQuery(BOTTOM_BAR_VIEWPORT);
  const keyboard = useKeyboardInset(phone);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const sending = model.status?.tone === 'sending';
  const canSend = !model.blocked && !sending && model.draft.trim().length > 0;

  useEffect(() => { if (!model.blocked) input.current?.focus({ preventScroll: true }); }, [model.id, model.blocked]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      className={phone ? 'fixed inset-x-0 z-40 px-2 pb-2' : 'absolute right-16 bottom-2 left-2 z-20'}
      style={phone ? { bottom: keyboard > 0 ? keyboard : 'calc(56px + env(safe-area-inset-bottom))' } : undefined}
    >
      <div className={cn(BOX, 'mx-auto max-w-3xl px-3 pt-4 pb-3')}>
        <div className="absolute -top-3.5 left-3 flex items-center gap-1.5 border-2 border-fg bg-fg py-0.5 pr-2.5 pl-1 text-surface">
          <AgentOrb seed={model.id} state={state} size={20} />
          <h2 id={titleId} className="m-0 text-xs font-bold tracking-wide uppercase">{model.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar la charla"
          title="Cerrar (Esc)"
          className="absolute top-1 right-1 grid size-8 cursor-pointer place-items-center rounded-sm border-0 bg-transparent text-muted hover:bg-subtle hover:text-fg pointer-coarse:size-11"
        >
          <X size={16} aria-hidden="true" />
        </button>

        <ol aria-label="Últimos mensajes" aria-live="polite" className="m-0 mt-1 grid list-none gap-1 p-0 pr-8 text-[13px] leading-snug">
          {model.lines.length === 0 ? <li className="text-muted">Todavía no se escribieron. Decile algo.</li> : null}
          {model.lines.map((line) => (
            <li key={line.id} className="line-clamp-2 break-words">
              <strong className={line.mine ? 'text-brand-ink' : 'text-fg'}>{line.who}:</strong> <span className="text-fg-2">{line.text}</span>
            </li>
          ))}
          {model.thinking ? (
            <li className="text-muted">
              <strong className="text-fg">{model.name}</strong> está pensando<span className="inline-block w-4 animate-pulse">…</span>
            </li>
          ) : null}
        </ol>
        {model.hint ? <p className="m-0 mt-2 text-xs text-muted">{model.hint}</p> : null}

        {model.blocked ? (
          <p role="note" className="m-0 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2">
            <CircleAlert size={14} aria-hidden="true" className="shrink-0 text-warn-ink" />
            <span className="min-w-0 flex-1">{model.blocked}</span>
            <a href={model.chatHref} onClick={(event) => { onNavClick(event, model.chatHref); }} className="font-medium text-brand-ink">Abrir chat</a>
          </p>
        ) : (
          <form
            className="mt-3 flex items-center gap-2"
            onSubmit={(event) => { event.preventDefault(); if (canSend) model.send(); }}
          >
            <input
              ref={input}
              type="text"
              value={model.draft}
              onChange={(event) => { model.setDraft(event.target.value); }}
              aria-label={`Mensaje para ${model.name}`}
              placeholder={`Escribile a ${model.name}…`}
              enterKeyHint="send"
              autoComplete="off"
              className="h-9 min-w-0 flex-1 border-2 border-line bg-subtle px-2.5 text-[13px] text-fg outline-none placeholder:text-muted focus:border-brand pointer-coarse:h-11 pointer-coarse:text-base"
            />
            <button
              type="submit"
              disabled={!canSend}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 border-2 border-fg bg-brand px-3 text-[13px] font-semibold text-on-brand hover:bg-brand-hover disabled:cursor-default disabled:opacity-50 pointer-coarse:h-11"
            >
              <Send size={14} aria-hidden="true" />
              {sending ? 'Enviando…' : 'Enviar'}
            </button>
          </form>
        )}
        <p role="status" className={cn('m-0 mt-1.5 min-h-4 text-xs', model.status?.tone === 'failed' ? 'text-danger-ink' : 'text-muted')}>
          {model.status && model.status.tone !== 'sending' ? model.status.text : null}
        </p>
      </div>
    </section>
  );
}

import { Crosshair, FileText, IdCard, MessageCircle, MessageSquare, SquareTerminal, X } from 'lucide-react';
import { useEffect, useId, type KeyboardEvent } from 'react';
import { cn } from '../../cn';
import { AgentOrb } from '../../components/AgentOrb';
import { onNavClick } from '../../router';
import { LIVE_STATE_META } from '../live/agent-state';
import { HUD_BUTTON, HUD_ON, HUD_PANEL, HUD_TEXT, STATE_PIXEL } from './hud-style';
import type { OfficeAgent } from './office-agent';
import { BubbleIcon } from './PixelGlyph';
import type { IconName } from './sprites';

interface EmoteChoice { icon: IconName; label: string }

/** What the operator can send with a click; the agent answers with the same icon over their head. */
const EMOTES: readonly EmoteChoice[] = [
  { icon: 'wave', label: 'Saludar' },
  { icon: 'coffee', label: 'Invitar un café' },
  { icon: 'star', label: 'Felicitar' },
  { icon: 'heart', label: 'Dar ánimo' },
];

/** The selected agent as a game card: who, what they are doing and why, and what you can do with them. */
export function AgentCard({ agent, place, following, onClose, onTalk, onSheet, onEmote, onFollow }: {
  agent: OfficeAgent;
  /** Where the agent is right now: a building name. */
  place: string | null;
  following: boolean;
  onClose: () => void;
  onTalk?: () => void;
  onSheet?: () => void;
  onEmote: (icon: IconName) => void;
  onFollow: () => void;
}) {
  const titleId = useId();
  const cut = agent.id.indexOf('/');
  const tenant = encodeURIComponent(agent.id.slice(0, cut));
  const alias = encodeURIComponent(agent.id.slice(cut + 1));
  const links = agent.visitor ? [] : [
    { href: `/messages/${tenant}/${alias}`, label: 'Abrir chat', icon: MessageSquare },
    { href: `/terminal/${tenant}/${alias}`, label: 'Abrir terminal', icon: SquareTerminal },
    { href: `/messages/${tenant}/${alias}?view=context`, label: 'Perfil y contexto', icon: FileText },
  ];
  useEffect(() => {
    const onWindowKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return;
      if (target?.closest('[role="dialog"]') && !target.closest(`[aria-labelledby="${titleId}"]`)) return;
      onClose();
    };
    window.addEventListener('keydown', onWindowKey);
    return () => { window.removeEventListener('keydown', onWindowKey); };
  }, [onClose, titleId]);
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
      className={cn(HUD_PANEL, 'pointer-events-auto w-[min(23rem,calc(100vw-1rem))] p-2.5')}
    >
      <header className="flex items-start gap-2.5">
        <span className="grid size-11 shrink-0 place-items-center border-2 border-[#0e0f17] bg-[#333c57]">
          <AgentOrb seed={agent.id} state={agent.state} size={34} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className={cn(HUD_TEXT, 'm-0 truncate text-[13px]')}>{agent.name}</h2>
          <p className={cn(HUD_TEXT, 'm-0 mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-[#94b0c2]')}>
            <span className="inline-flex items-center gap-1 text-[#f4f4f4]">
              <span aria-hidden="true" className="size-2 border border-[#0e0f17]" style={{ backgroundColor: STATE_PIXEL[agent.state] }} />
              {LIVE_STATE_META[agent.state].label}
            </span>
            {agent.team && !agent.visitor ? <span className="truncate">{agent.team.label}</span> : null}
            {place && place !== agent.team?.label ? <span className="truncate">en {place}</span> : null}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar la tarjeta" title="Cerrar (Esc)" className={cn(HUD_BUTTON, 'size-8')}>
          <X size={14} aria-hidden="true" />
        </button>
      </header>
      <p className="m-0 mt-2 line-clamp-3 text-[12px] leading-snug text-[#c5d3dc]">{agent.reason}</p>
      <div className="mt-2.5 flex flex-wrap gap-1">
        {onTalk ? (
          <button type="button" onClick={onTalk} className={cn(HUD_BUTTON, HUD_TEXT, HUD_ON, 'h-8 px-2.5')}>
            <MessageCircle size={13} aria-hidden="true" /> Hablar
          </button>
        ) : null}
        {links.map(({ href, label, icon: Icon }) => (
          <a key={label} href={href} aria-label={label} title={label} onClick={(event) => { onNavClick(event, href); }} className={cn(HUD_BUTTON, 'size-8 no-underline')}>
            <Icon size={14} aria-hidden="true" />
          </a>
        ))}
        {onSheet ? (
          <button type="button" onClick={onSheet} className={cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2.5')}>
            <IdCard size={13} aria-hidden="true" /> Ficha
          </button>
        ) : null}
        <button
          type="button"
          aria-pressed={following}
          onClick={onFollow}
          title="La cámara lo sigue de edificio en edificio"
          className={cn(HUD_BUTTON, HUD_TEXT, 'h-8 px-2.5', following ? HUD_ON : null)}
        >
          <Crosshair size={13} aria-hidden="true" /> Seguir
        </button>
      </div>
      <div role="group" aria-label="Gestos" className="mt-2 flex items-center gap-1 border-t-2 border-[#333c57] pt-2">
        {EMOTES.map((choice) => (
          <button
            key={choice.icon}
            type="button"
            aria-label={choice.label}
            title={choice.label}
            onClick={() => { onEmote(choice.icon); }}
            className={cn(HUD_BUTTON, 'size-8')}
          >
            <BubbleIcon name={choice.icon} />
          </button>
        ))}
      </div>
    </section>
  );
}

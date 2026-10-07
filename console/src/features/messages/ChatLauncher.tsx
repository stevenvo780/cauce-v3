import { AlertTriangle, ArrowRight, Clock3, Search, Star, Users, type LucideIcon } from 'lucide-react';
import {
  useCallback, useEffect, useId, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react';
import { AgentOrb, OrbView } from '../../components/AgentOrb';
import { AgentContextMenu, AgentKebab } from '../../components/agent-actions/AgentActionsMenu';
import { useAgentAppearance, useAgentPreferences, usePreferencesSettled } from '../../components/agent-actions/preferences-context';
import { ErrorState } from '../../components/ui';
import { cn } from '../../cn';
import { plural } from '../../lib';
import { orbHues } from '../../orb-hues';
import { navigate } from '../../router';
import { agentHref } from '../../shell/agent-href';
import { useFleet } from '../../shell/fleet-context';
import { useMediaQuery } from '../../shell/use-media-query';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { LIVE_STATE_META, type LiveState } from '../live/agent-state';
import {
  SECTION_TITLE, lastMessages, launcherSections, needsAttention, nextCardIndex, sinceShort,
  type ArrowKey, type LastMessage, type LauncherSectionId,
} from './chat-launcher-model';
import type { SaludDeCola } from './queue-health';
import type { AgenteDeMensajeria } from './roster';
import './chat-launcher.css';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const ARROWS = new Set<string>(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const WORKING = new Set<LiveState>(['thinking', 'receiving', 'delegating']);
const SECTION_ICON: Record<LauncherSectionId, LucideIcon> = {
  favoritos: Star, recientes: Clock3, atencion: AlertTriangle, todos: Users, resultados: Search,
};

type StartViewTransition = (update: () => void) => unknown;

const keyOf = (agent: AgenteDeMensajeria) => `${agent.tenantId}/${agent.alias}`;

function counters(salud: SaludDeCola | undefined): { text: string; tone: keyof typeof TONE_CLASS }[] {
  if (!salud) return [];
  const list: { text: string; tone: keyof typeof TONE_CLASS }[] = [];
  if (salud.muertas) list.push({ text: plural(salud.muertas, 'muerta', 'muertas'), tone: 'danger' });
  if (salud.reintentos) list.push({ text: `${String(salud.reintentos)} en reintento`, tone: 'warn' });
  if (salud.enCurso) list.push({ text: `${String(salud.enCurso)} en curso`, tone: 'info' });
  if (salud.pendientes) list.push({ text: `${String(salud.pendientes)} en cola`, tone: 'neutral' });
  return list;
}

function isEditable(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], .xterm') !== null;
}

interface CardProps {
  agent: AgenteDeMensajeria;
  index: number;
  state: LiveState;
  /** Why the live view chose that state; the preview falls back to it when there is no message. */
  reason?: string;
  last?: LastMessage;
  salud?: SaludDeCola;
  layout: 'tile' | 'row' | 'bubble';
  highlighted: boolean;
  onOpen: (agent: AgenteDeMensajeria, card: HTMLAnchorElement) => void;
  onFocus: (index: number) => void;
}

function LauncherCard({ agent, index, state, reason, last, salud, layout, highlighted, onOpen, onFocus }: CardProps) {
  const key = keyOf(agent);
  const appearance = useAgentAppearance(key);
  const [hue] = orbHues(key, appearance?.hue);
  const meta = LIVE_STATE_META[state];
  const tone = TONE_CLASS[STATE_TONE[state]];
  const href = agentHref('messages', agent);
  const time = last ? sinceShort(last.createdAt) : undefined;
  const chips = counters(salud);
  const label = [`${agent.alias}, ${agent.tenantId}`, meta.label, ...chips.map((chip) => chip.text), time ? `último mensaje ${time}` : '']
    .filter(Boolean).join(' · ');
  const style = { '--i': index, '--h1': hue } as CSSProperties;
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(agent, event.currentTarget);
  };
  const pill = (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium', tone.pill)} data-live-state={state}>
      <span className={cn('size-1.5 rounded-full', tone.dot)} aria-hidden="true" />{meta.label}
    </span>
  );
  const preview = last?.text ? (
    <>{last.from ? <span className="text-fg-2">{last.from}: </span> : null}{last.text}</>
  ) : <span className="italic">{reason ?? 'Sin mensajes recientes'}</span>;
  const badges = (
    <>
      {pill}
      {chips[0] ? <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums', TONE_CLASS[chips[0].tone].pill)}>{chips[0].text}</span> : null}
      {chips.length > 1 ? (
        <span className="shrink-0 rounded-full bg-muted-bg px-1.5 py-0.5 text-[11px] font-medium text-muted tabular-nums" title={chips.slice(1).map((chip) => chip.text).join(' · ')}>
          +{chips.length - 1}
        </span>
      ) : null}
    </>
  );
  const common = {
    href,
    style,
    'aria-label': label,
    'data-launcher-card': '',
    'data-agent-id': agent.id,
    'data-highlighted': highlighted || undefined,
    onClick: click,
    onFocus: () => { onFocus(index); },
    onMouseMove: () => { if (!highlighted) onFocus(index); },
  };

  if (layout === 'bubble') {
    return (
      <a {...common} style={{ ...style, '--glow-x': '-4px', '--glow-y': '-6px' } as CSSProperties}
        className="cl-card grid w-[84px] justify-items-center gap-1.5 rounded-2xl border border-transparent px-1 pt-2 pb-1.5 text-center no-underline">
        <span className="relative">
          <AgentOrb seed={key} state={state} size={52} />
          <span className={cn('absolute right-0.5 bottom-0.5 size-3 rounded-full ring-2 ring-surface', tone.dot)} aria-hidden="true" />
        </span>
        <span className="cl-alias max-w-full truncate text-[13px] font-medium text-fg">{agent.alias}</span>
        <span className="max-w-full truncate text-[10px] text-muted">{time ?? agent.tenantId}</span>
      </a>
    );
  }

  if (layout === 'row') {
    return (
      <a {...common} className="cl-card flex items-center gap-3 rounded-2xl border border-line bg-surface py-2.5 pr-12 pl-3 no-underline">
        <span className="relative">
          <AgentOrb seed={key} state={state} size={44} />
          <span className={cn('absolute right-0 bottom-0 size-3 rounded-full ring-2 ring-surface', tone.dot)} aria-hidden="true" />
        </span>
        <span className="grid min-w-0 flex-1 gap-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="cl-alias truncate text-[15px] font-semibold text-fg">{agent.alias}</span>
            <span className="truncate text-xs text-muted">{agent.tenantId}</span>
            {time ? <time dateTime={last?.createdAt} className="ml-auto shrink-0 text-[11px] text-muted">{time}</time> : null}
          </span>
          <span className="truncate text-[13px] text-muted">{preview}</span>
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">{badges}</span>
        </span>
      </a>
    );
  }

  return (
    <a {...common} className="cl-card flex h-full flex-col gap-2.5 rounded-2xl border border-line bg-surface p-3.5 no-underline shadow-card">
      <span className="flex items-center gap-3">
        <AgentOrb seed={key} state={state} size={48} />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="cl-alias truncate text-[15px] font-semibold tracking-tight text-fg">{agent.alias}</span>
            {time ? <time dateTime={last?.createdAt} className="ml-auto shrink-0 text-[11px] text-muted">{time}</time> : null}
          </span>
          <span className="truncate text-xs text-muted">{agent.tenantId}</span>
        </span>
      </span>
      <span className="truncate text-[13px] text-muted">{preview}</span>
      <span className="mt-auto flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap">
        {badges}
        <ArrowRight size={15} aria-hidden="true" className="cl-go ml-auto shrink-0 text-brand-ink" />
      </span>
    </a>
  );
}

function SkeletonGrid({ phone }: { phone: boolean }) {
  return (
    <ul aria-hidden="true" className={cn('m-0 grid list-none gap-3 p-0', phone ? 'grid-cols-1' : 'grid-cols-[repeat(auto-fill,minmax(232px,1fr))]')}>
      {Array.from({ length: phone ? 6 : 8 }, (_, index) => (
        <li key={index} className="cl-fade flex items-center gap-3 rounded-2xl border border-line bg-surface p-4" style={{ '--i': index } as CSSProperties}>
          <span className="skeleton size-12 shrink-0 rounded-full" />
          <span className="grid flex-1 gap-2">
            <span className="skeleton h-3 rounded-full" style={{ width: `${String(72 - (index % 4) * 11)}%` }} />
            <span className="skeleton h-2.5 w-2/5 rounded-full" />
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The landing of the Chat section: a quick picker that opens a conversation in one gesture. */
export function ChatLauncher({ phone }: { phone: boolean }) {
  const { agents, live, salud, messages, loading, error, reload } = useFleet();
  const favorites = useAgentPreferences()?.favorites;
  const settled = usePreferencesSettled();
  const reduced = useMediaQuery(REDUCED_MOTION);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const [announcement, setAnnouncement] = useState('');
  const [launching, setLaunching] = useState<string>();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const headingId = useId();

  const stateOf = useCallback((agent: AgenteDeMensajeria): LiveState => (
    live.get(agent.id)?.state ?? (agent.leaseState === 'online' ? 'idle' : 'down')
  ), [live]);
  const last = useMemo(() => lastMessages(messages.data, agents), [messages.data, agents]);
  const sections = useMemo(
    () => launcherSections({ agents, stateOf, salud, last, favorites, query }),
    [agents, stateOf, salud, last, favorites, query],
  );
  const flat = useMemo(() => sections.flatMap((section) => section.agents), [sections]);
  const current = flat.length === 0 ? -1 : Math.min(active, flat.length - 1);
  const working = agents.filter((agent) => WORKING.has(stateOf(agent)));
  const attention = agents.filter((agent) => needsAttention(stateOf(agent), salud[agent.id])).length;

  useEffect(() => {
    if (!phone) searchRef.current?.focus({ preventScroll: true });
  }, [phone]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || isEditable(event.target)) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, []);

  const open = useCallback((agent: AgenteDeMensajeria, card?: HTMLAnchorElement | null) => {
    const href = agentHref('messages', agent);
    const transitions = document as Document & { startViewTransition?: StartViewTransition };
    if (card && !reduced && typeof transitions.startViewTransition === 'function') {
      card.querySelector<HTMLElement>('.agent-orb')?.style.setProperty('view-transition-name', 'chat-orb');
      card.querySelector<HTMLElement>('.cl-alias')?.style.setProperty('view-transition-name', 'chat-alias');
      const root = document.documentElement;
      root.dataset.chatLaunch = '';
      window.setTimeout(() => { delete root.dataset.chatLaunch; }, 1200);
    }
    setLaunching(agent.id);
    navigate(href);
  }, [reduced]);

  const cards = () => Array.from(listRef.current?.querySelectorAll<HTMLAnchorElement>('[data-launcher-card]') ?? []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Keys inside a card's menu bubble here through the portal; the menu owns them.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    const fromSearch = event.target === searchRef.current;
    if (fromSearch && event.key === 'Enter') {
      const agent = flat[Math.max(current, 0)] as AgenteDeMensajeria | undefined;
      if (!agent) return;
      event.preventDefault();
      open(agent, cards()[Math.max(current, 0)]);
      return;
    }
    if (fromSearch && event.key === 'Escape' && query) {
      event.preventDefault();
      setQuery('');
      setActive(-1);
      return;
    }
    if (!ARROWS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    if (fromSearch && query && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
    const links = cards();
    const next = nextCardIndex(links.map((link) => link.getBoundingClientRect()), current, event.key as ArrowKey);
    if (next < 0) return;
    event.preventDefault();
    if (!fromSearch && next === current && event.key === 'ArrowUp') {
      searchRef.current?.focus();
      return;
    }
    setActive(next);
    const target = links[next] as HTMLAnchorElement | undefined;
    const agent = flat[next] as AgenteDeMensajeria | undefined;
    if (!target || !agent) return;
    if (fromSearch) (target as Partial<HTMLElement>).scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    else target.focus();
    setAnnouncement(`${agent.alias}, ${LIVE_STATE_META[stateOf(agent)].label}. Enter para abrir.`);
  };

  let offset = 0;
  const body = (loading && agents.length === 0) || (!settled && agents.length > 0) ? (
    <>
      <p className="sr-only" role="status">Cargando agentes…</p>
      <SkeletonGrid phone={phone} />
    </>
  ) : error && agents.length === 0 ? (
    <ErrorState error={error} onRetry={reload} />
  ) : flat.length === 0 ? (
    <div className="cl-fade grid justify-items-center gap-3 py-14 text-center">
      <OrbView seed="cauce/vacio" state="idle" size={56} sleeping look={{ style: 'orb', hue: 250 }} />
      <p className="m-0 text-sm text-muted">
        {query ? <>Ningún agente coincide con «<strong className="text-fg">{query.trim()}</strong>».</> : 'Todavía no hay agentes en la flota.'}
      </p>
    </div>
  ) : (
    <ul ref={listRef} aria-label={phone ? 'Agentes' : 'Agentes para chatear'} className="m-0 flex list-none flex-wrap gap-x-6 gap-y-7 p-0">
      {sections.map((section, sectionIndex) => {
        const Icon = SECTION_ICON[section.id];
        const start = offset;
        offset += section.agents.length;
        const bubbles = phone && section.id === 'recientes' && section.agents.length >= 3;
        const compact = !phone && section.agents.length < 4;
        const titleId = `${headingId}-${section.id}`;
        return (
          <li key={section.id} className={compact ? 'max-w-full min-w-0' : 'min-w-0 basis-full'}>
            <section aria-labelledby={titleId}>
              <h2 id={titleId} className="cl-fade m-0 mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
                style={{ '--i': sectionIndex + 2 } as CSSProperties}>
                <Icon size={13} aria-hidden="true" className={section.id === 'atencion' ? 'text-warn-ink' : section.id === 'favoritos' ? 'text-warn' : undefined} />
                {SECTION_TITLE[section.id]}
                <span className="rounded-full bg-muted-bg px-1.5 py-px text-[10px] tabular-nums">{section.agents.length}</span>
                <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" aria-hidden="true" />
              </h2>
              <ul aria-label={SECTION_TITLE[section.id]} className={cn(
                'm-0 list-none p-0',
                bubbles ? 'cl-strip -mx-4 flex gap-1 overflow-x-auto px-3 pb-1'
                  : phone ? 'grid gap-2' : compact ? 'grid grid-cols-[repeat(var(--n),minmax(0,244px))] gap-3 max-[700px]:grid-cols-1'
                    : 'grid grid-cols-[repeat(auto-fill,minmax(232px,1fr))] gap-3',
              )} style={{ '--n': section.agents.length } as CSSProperties}>
                {section.agents.map((agent, index) => (
                  <AgentContextMenu key={agent.id} agent={agent} render={<li />} className={cn('group relative', bubbles && 'shrink-0')}>
                    <LauncherCard
                      agent={agent}
                      index={start + index}
                      state={stateOf(agent)}
                      reason={live.get(agent.id)?.reason}
                      last={last.get(agent.id)}
                      salud={salud[agent.id]}
                      layout={bubbles ? 'bubble' : phone ? 'row' : 'tile'}
                      highlighted={current === start + index || launching === agent.id}
                      onOpen={open}
                      onFocus={setActive}
                    />
                    {phone && !bubbles ? <AgentKebab agent={agent} className="absolute top-1/2 right-2 size-9 -translate-y-1/2" /> : null}
                  </AgentContextMenu>
                ))}
              </ul>
            </section>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div
      onKeyDown={onKeyDown}
      className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-surface"
    >
      <div className="cl-aurora" aria-hidden="true"><span className="cl-blob-a" /><span className="cl-blob-b" /><span className="cl-blob-c" /></div>
      <header className={cn('relative mx-auto w-full max-w-[1120px]', phone ? 'px-4 pt-5 pb-3' : 'px-8 pt-14 pb-5 max-[1100px]:pt-10')}>
        <h1 className={cn('cl-fade m-0 font-semibold tracking-tight', phone ? 'text-2xl' : 'text-[34px] leading-tight')}>
          {phone ? 'Chats' : <>¿Con quién <span className="cl-accent">trabajamos hoy?</span></>}
        </h1>
        {agents.length > 0 ? (
          <p className="cl-fade m-0 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted" style={{ '--i': 1 } as CSSProperties}>
            {working.length > 0 ? (
              <span className="flex items-center gap-2">
                <span className="flex -space-x-2" aria-hidden="true">
                  {working.slice(0, 5).map((agent, index) => (
                    <span key={agent.id} className="cl-bob rounded-full ring-2 ring-surface" style={{ '--i': index } as CSSProperties}>
                      <AgentOrb seed={keyOf(agent)} state={stateOf(agent)} size={20} />
                    </span>
                  ))}
                </span>
                <span><strong className="font-semibold text-fg">{working.length}</strong> trabajando ahora</span>
              </span>
            ) : null}
            {phone ? null : <span>{plural(agents.length, 'agente', 'agentes')}</span>}
            {attention > 0 ? <span className="text-warn-ink">{attention} {attention === 1 ? 'necesita' : 'necesitan'} atención</span> : null}
          </p>
        ) : null}
      </header>
      <div className={cn('sticky top-0 z-10 mx-auto w-full max-w-[1120px]', phone ? 'px-4 pt-1 pb-3' : 'px-8 pt-2 pb-5')}>
        <label className="cl-search cl-fade block bg-surface/85 shadow-card backdrop-blur" style={{ '--i': 2 } as CSSProperties}>
          <span className="sr-only">Buscar un agente para chatear</span>
          <Search size={phone ? 18 : 20} aria-hidden="true" className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            enterKeyHint="go"
            autoComplete="off"
            spellCheck={false}
            aria-keyshortcuts="/"
            onChange={(event) => { setQuery(event.target.value); setActive(event.target.value.trim() ? 0 : -1); }}
            placeholder={phone ? 'Buscar agente o tenant' : 'Buscá por alias o tenant y apretá Enter'}
            className={cn('w-full rounded-2xl border border-line bg-transparent pr-4 text-fg', phone ? 'h-12 pl-11 text-[15px]' : 'h-14 pl-12 text-[17px]')}
          />
          {phone || query ? null : (
            <span className="pointer-events-none absolute top-1/2 right-4 hidden -translate-y-1/2 items-center gap-1.5 text-[11px] text-muted min-[900px]:flex" aria-hidden="true">
              <kbd className="rounded border border-line bg-subtle px-1.5 py-px font-sans">↑↓←→</kbd> moverte
              <kbd className="ml-1 rounded border border-line bg-subtle px-1.5 py-px font-sans">Enter</kbd> abrir
            </span>
          )}
        </label>
        {!phone && query && flat[current] ? (
          <p className="m-0 mt-2 pl-1 text-xs text-muted">
            <kbd className="rounded border border-line bg-subtle px-1 py-px font-sans">Enter</kbd> abre el chat con <strong className="text-fg">{flat[current].alias}</strong>
          </p>
        ) : null}
        {messages.error && !query ? (
          <p className="m-0 mt-2 text-xs text-muted">Sin vista previa de mensajes: {messages.error.message}</p>
        ) : null}
      </div>
      <div className={cn('relative mx-auto w-full max-w-[1120px]', phone ? 'px-4 pb-6' : 'px-8 pb-12')}>{body}</div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>
    </div>
  );
}

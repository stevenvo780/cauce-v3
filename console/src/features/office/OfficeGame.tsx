import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { pixelIconName } from '@cauce/protocol/agent-preferences';
import { FloatingTooltip } from '../../components/ui';
import { AgentActionItems } from '../../components/agent-actions/AgentActionsMenu';
import { MENU_POPUP } from '../../components/kit';
import { cn } from '../../cn';
import { useMediaQuery } from '../../shell/use-media-query';
import { LIVE_STATE_META } from '../live/agent-state';
import { actorInputs } from './actor-inputs';
import { AgentCard } from './AgentCard';
import { AgentTip } from './AgentTip';
import { stepZoom, type Inset } from './camera';
import { createPlanMemory, nextPhaseEnd, planCampus, type PlanGroup } from './campus-plan';
import { CampusMap } from './CampusMap';
import { useNight } from './daylight';
import { agentRefOf, clientPointOf, hintSeen, rememberHint, useFrameSize, useHeight, useMaximized } from './frame';
import { dotsByAgent } from './group-dots';
import { HOTBAR_KEYS, Hotbar, type HotbarSlot } from './Hotbar';
import { SHARED_IDS, SHARED_LABELS } from './interior-shared';
import { CAMPUS } from './level';
import type { OfficeAgent } from './office-agent';
import { DirectionPad, OfficeControls, OfficeHint } from './OfficeControls';
import type { Speech } from './speech';
import { TalkPrompt } from './TalkPrompt';
import { TubeFeed } from './TubeFeed';
import { useOfficeEngine } from './use-office-engine';
import { useOfficeInput } from './use-office-input';
import { useOfficeLooks } from './use-office-looks';
import { useSlots } from './use-office-slots';
import { SHARED_ORDER, buildWorldMap, groupLevelId, type WorldMap } from './world-map';

export type { OfficeAgent } from './office-agent';

interface OfficeGameProps {
  agents: readonly OfficeAgent[];
  /** Every group of the topology, in its order: each one gets a house, members or not. */
  groups: readonly PlanGroup[];
  selectedId: string | null;
  /** The full sheet is open over the right edge; the card steps aside. */
  sheetOpen: boolean;
  highlight: ReadonlySet<string> | null;
  onSelect: (id: string) => void;
  onDeselect: () => void;
  onSheet: (id: string) => void;
  label: string;
  onTalk?: (id: string) => void;
  talk?: { id: string; panel: ReactNode } | null;
  speech?: ReadonlyMap<string, Speech>;
  hues?: ReadonlyMap<string, number>;
  /** The page's own bar: title, verdict, state counters; it rides on top of the game. */
  hud: ReactNode;
  /** The page's wall clock, ms: it paces the campus plan as well as the relative times. */
  now: number;
}

const HINT_MS = 12_000;
const SHEET_RESERVE = 412;
const PANEL_RESERVE = 224;
const CONTROLS_RESERVE = 60;
const optionId = (id: string) => `office-agent-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

export function OfficeGame({ agents, groups, selectedId, sheetOpen, highlight, onSelect, onDeselect, onSheet, label, onTalk, talk = null, speech, hues, hud, now }: OfficeGameProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLButtonElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);
  const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
  const coarse = useMediaQuery('(pointer: coarse)');
  const wide = useMediaQuery('(min-width: 761px)');
  const escapeBlocked = useRef(false);
  const [maximized, toggleMaximized] = useMaximized(frameRef, escapeBlocked);
  const box = useFrameSize(frameRef);
  const topHeight = useHeight(topRef);
  const bottomHeight = useHeight(bottomRef);
  const night = useNight();

  const ordered = useMemo(() => [...agents].sort((a, b) => a.id.localeCompare(b.id)), [agents]);
  const memory = useRef(createPlanMemory());
  const [phaseAt, setPhaseAt] = useState(0);
  const clock = Math.max(now, phaseAt) / 1000;
  const campusPlan = useMemo(() => planCampus(memory.current, ordered, groups, clock), [ordered, groups, clock]);
  const lastMap = useRef<WorldMap | null>(null);
  const map = useMemo(() => {
    const built = buildWorldMap(campusPlan.plan, lastMap.current);
    lastMap.current = built;
    return built;
  }, [campusPlan.plan]);
  useEffect(() => {
    const left = nextPhaseEnd(memory.current, Date.now() / 1000);
    if (left === null) return undefined;
    const timer = window.setTimeout(() => { setPhaseAt(Date.now()); }, left * 1000 + 80);
    return () => { window.clearTimeout(timer); };
  }, [campusPlan]);

  const visitorIds = useMemo(() => ordered.filter((agent) => agent.visitor).map((agent) => agent.id), [ordered]);
  const waitOf = useSlots(visitorIds);
  const inputs = useMemo(() => actorInputs(ordered, campusPlan.homeOf, campusPlan.deskOf, waitOf), [ordered, campusPlan, waitOf]);
  const names = useMemo(() => new Map(ordered.map((agent) => [agent.id, agent.glyph && pixelIconName(agent.glyph) === undefined ? `${agent.glyph} ${agent.name}` : agent.name])), [ordered]);
  const stats = useMemo(() => {
    const out = new Map<string, { members: number; alerts: number }>();
    const bump = (id: string, alert: boolean) => {
      const entry = out.get(id) ?? { members: 0, alerts: 0 };
      entry.members += 1;
      if (alert) entry.alerts += 1;
      out.set(id, entry);
    };
    for (const agent of ordered) {
      if (agent.visitor) continue;
      const trouble = agent.state === 'down' || agent.state === 'blocked';
      bump(campusPlan.homeOf.get(agent.id) ?? '', trouble);
      if (agent.state === 'down') bump(SHARED_IDS.shop, true);
    }
    return out;
  }, [ordered, campusPlan]);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [siteHover, setSiteHoverState] = useState<{ id: string; anchor: DOMRect } | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [paseo, setPaseoState] = useState(false);
  const [hint, setHint] = useState(() => !hintSeen());
  const [mapOpen, setMapOpen] = useState<boolean | null>(null);
  const [tubesOpen, setTubesOpen] = useState<boolean | null>(null);
  const [followId, setFollowId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const dpr = box.dpr;
  const view = useMemo(() => ({ width: Math.round(box.width * dpr), height: Math.round(box.height * dpr) }), [box.width, box.height, dpr]);

  const props = useMemo(() => ({
    selected: selectedId, hovered: hoverId ?? cursorId, highlight, names, speech, groups: dotsByAgent(ordered, hues), stats, talkId: talk?.id ?? null,
  }), [selectedId, hoverId, cursorId, highlight, names, speech, ordered, hues, stats, talk]);
  const { engine, level, nearby, edges, occupancy, feed, kick } = useOfficeEngine({ canvasRef, map, inputs, reducedMotion, night, props });
  useOfficeLooks(engine.scenes, ordered, kick);
  const narrow = box.width < 600;
  const showMapDefault = !coarse && box.width >= 1100;
  const showMap = mapOpen ?? showMapDefault;
  const showTubes = tubesOpen ?? false;
  const panels = showMap || showTubes ? PANEL_RESERVE : CONTROLS_RESERVE;
  const inset = useMemo<Inset>(() => ({
    top: (topHeight + 12) * dpr,
    bottom: (bottomHeight + 12) * dpr,
    right: (sheetOpen && wide ? Math.min(box.width, SHEET_RESERVE) : narrow ? 0 : panels) * dpr,
    left: 0,
  }), [topHeight, bottomHeight, dpr, sheetOpen, wide, box.width, narrow, panels]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = view.width;
    canvas.height = view.height;
    engine.resize(view, dpr, inset);
    kick();
  }, [engine, view, dpr, inset, kick]);

  const dismissHint = useCallback(() => {
    setHint((shown) => {
      if (shown) rememberHint();
      return false;
    });
  }, []);
  useEffect(() => {
    if (!hint) return undefined;
    const timer = window.setTimeout(dismissHint, HINT_MS);
    return () => { window.clearTimeout(timer); };
  }, [hint, dismissHint]);

  const setPaseo = useCallback((on: boolean) => {
    setPaseoState(on);
    engine.setPaseo(on);
    if (on) {
      setCursorId(null);
      setAnchor(null);
      dismissHint();
    }
    kick();
  }, [engine, kick, dismissHint]);

  useEffect(() => {
    if (selectedId) engine.focusActor(selectedId, true);
    else engine.follow = null;
    kick();
  }, [engine, selectedId, kick]);
  useEffect(() => {
    engine.follow = followId && followId === selectedId ? followId : null;
  }, [engine, followId, selectedId]);

  const slots = useMemo<HotbarSlot[]>(() => {
    const out: HotbarSlot[] = [{ id: CAMPUS, kind: 'campus', name: 'Campus', hue: -1, people: occupancy.get(CAMPUS) ?? 0, alerts: 0, works: false }];
    for (const group of campusPlan.groups) {
      if (group.phase?.kind === 'demolish') continue;
      const id = groupLevelId(group.id);
      out.push({ id, kind: 'group', name: group.label, hue: group.hue, people: stats.get(id)?.members ?? 0, alerts: stats.get(id)?.alerts ?? 0, works: group.phase?.kind === 'build' });
    }
    for (const kind of SHARED_ORDER) {
      const id = SHARED_IDS[kind];
      out.push({ id, kind, name: SHARED_LABELS[kind], hue: -1, people: occupancy.get(id) ?? 0, alerts: kind === 'shop' ? stats.get(id)?.alerts ?? 0 : 0, works: false });
    }
    return out;
  }, [campusPlan, stats, occupancy]);

  const go = useCallback((id: string) => {
    engine.go(id);
    dismissHint();
    kick();
  }, [engine, dismissHint, kick]);

  const onKey = (key: string): boolean => {
    if (/^[1-9]$/.test(key)) {
      const slot = slots[Number(key) - 1] as HotbarSlot | undefined;
      if (slot && Number(key) <= HOTBAR_KEYS) go(slot.id);
      return Boolean(slot);
    }
    if (key === '[' || key === ']' || key === 'PageUp' || key === 'PageDown') {
      const index = slots.findIndex((slot) => slot.id === level);
      const step = key === '[' || key === 'PageUp' ? -1 : 1;
      go(slots[(index + step + slots.length) % slots.length].id);
      return true;
    }
    if (key === 'm') { setMapOpen((open) => !(open ?? showMapDefault)); return true; }
    if (key === 't') { setTubesOpen((open) => !(open ?? false)); return true; }
    return false;
  };

  const input = useOfficeInput({
    engine, canvasRef, listRef, kick, dpr, paseo, setPaseo, cursorId, setCursorId,
    setHover: (id, box) => { setHoverId(id); setAnchor(box); },
    setSiteHover: (id, box) => { setSiteHoverState(id && box ? { id, anchor: box } : null); },
    setGrabbing, selectedId, agentIds: ordered.map((agent) => agent.id), onSelect, onDeselect, onTalk, onKey, dismissHint,
  });

  const frameKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === listRef.current || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
    if (/^[1-9]$/.test(event.key) && onKey(event.key)) event.preventDefault();
  };

  const campus = level === CAMPUS;
  const selected = selectedId ? ordered.find((agent) => agent.id === selectedId) : undefined;
  const talkId = talk?.id ?? null;
  const tip = hoverId ?? cursorId;
  const tipAgent = tip ? ordered.find((agent) => agent.id === tip) : undefined;
  const talkTo = nearby && nearby !== selectedId && nearby !== talkId ? ordered.find((agent) => agent.id === nearby) : undefined;
  const menuAgent = menuFor && !ordered.find((agent) => agent.id === menuFor)?.visitor ? agentRefOf(menuFor) : null;
  const placeOf = (id: string) => {
    const actor = engine.world.actors.get(id);
    if (!actor) return null;
    return actor.level === CAMPUS ? 'el campus' : slots.find((slot) => slot.id === actor.level)?.name ?? null;
  };
  const site = siteHover ? engine.world.map.campus.siteOf.get(siteHover.id) : undefined;
  const siteSlot = site ? slots.find((slot) => slot.id === site.id) : undefined;
  const holdsEscape = Boolean(talk) || Boolean(selected);
  useEffect(() => { escapeBlocked.current = holdsEscape; }, [holdsEscape]);

  useEffect(() => {
    const prompt = promptRef.current;
    const box = nearby ? engine.boxOf(nearby) : null;
    if (!prompt || !box) return;
    prompt.style.transform = `translate(${String(Math.round((box.left + box.right) / 2 / dpr))}px, ${String(Math.round(box.top / dpr))}px) translate(-50%, calc(-100% - 22px))`;
  });

  return (
    <div
      ref={frameRef}
      onKeyDown={frameKeys}
      data-nivel={level}
      className={maximized ? 'fixed inset-0 z-[70] overflow-hidden bg-[#1a1c2c]' : 'relative h-full w-full overflow-hidden bg-[#1a1c2c]'}
    >
      <ContextMenu.Root open={menuAgent !== null} onOpenChange={(open, details) => {
        if (!open) { setMenuFor(null); return; }
        const point = clientPointOf(details.event);
        const id = point ? engine.pick(input.toScreen(point)) : null;
        if (id) setMenuFor(id);
      }}>
        <ContextMenu.Trigger
          ref={listRef}
          role="listbox"
          aria-label={label}
          aria-activedescendant={cursorId ? optionId(cursorId) : undefined}
          tabIndex={0}
          onKeyDown={input.onKeyDown}
          onKeyUp={input.onKeyUp}
          onBlur={() => { setCursorId(null); setAnchor(null); engine.keys.clear(); }}
          className="absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-[#ffcd75] focus-visible:ring-inset"
        >
          <canvas
            ref={canvasRef}
            aria-hidden="true"
            className={cn('block size-full touch-none select-none [image-rendering:pixelated]', grabbing ? 'cursor-grabbing' : hoverId || siteHover ? 'cursor-pointer' : 'cursor-grab')}
            onPointerDown={input.onPointerDown}
            onPointerMove={input.onPointerMove}
            onPointerUp={(event) => { input.onPointerEnd(event, false); }}
            onPointerCancel={(event) => { input.onPointerEnd(event, true); }}
            onPointerLeave={() => { setHoverId(null); setAnchor(null); setSiteHoverState(null); engine.hoveredSite = null; }}
            onContextMenu={(event) => { if (coarse) event.preventDefault(); }}
          />
          {ordered.map((agent) => (
            <div key={agent.id} id={optionId(agent.id)} role="option" aria-selected={agent.id === selectedId} className="sr-only" onClick={() => { onSelect(agent.id); }}>
              {agent.name}: {LIVE_STATE_META[agent.state].label}. {agent.reason}{agent.visitor || !agent.team ? '' : ` Grupo: ${agent.team.label}.`}
            </div>
          ))}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50 outline-none">
            <ContextMenu.Popup className={cn(MENU_POPUP, 'menu-pop w-64')}>
              {menuAgent ? <AgentActionItems agent={menuAgent} omit={['office']} /> : null}
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <p className="sr-only" aria-live="polite">{campus ? 'Estás en el campus.' : `Estás en ${slots.find((slot) => slot.id === level)?.name ?? 'un edificio'}.`}</p>
      <div ref={topRef} className="pointer-events-none absolute inset-x-2 top-2 z-10 flex flex-col items-stretch gap-1.5">{hud}</div>
      <div className="pointer-events-none absolute right-2 z-10 flex flex-col items-end gap-1.5" style={{ top: topHeight + 12, bottom: bottomHeight + 12 }}>
        <CampusMap canvasRef={mapRef} open={showMap} engine={engine} level={level} stats={stats} onGo={go} kick={kick} />
        {narrow && !showTubes ? null : (
          <TubeFeed feed={feed} names={names} open={showTubes} now={now} onToggle={() => { setTubesOpen(!showTubes); }} onPick={(id) => { onSelect(id); }} />
        )}
        <div className="mt-auto">
          <OfficeControls
            canZoomIn={!edges.atMax}
            canZoomOut={!edges.atMin}
            paseo={paseo}
            campus={campus}
            map={showMap}
            compact={narrow}
            tubes={narrow ? { open: showTubes, onToggle: () => { setTubesOpen(!showTubes); } } : undefined}
            onZoomIn={() => { input.zoomTo(stepZoom(engine.target.zoom, 1, engine.limits)); }}
            onZoomOut={() => { input.zoomTo(stepZoom(engine.target.zoom, -1, engine.limits)); }}
            onFit={() => { engine.fit(); kick(); }}
            onCenterMe={() => { engine.centerMe(); kick(); }}
            onTogglePaseo={() => { setPaseo(!paseo); }}
            onToggleMap={() => { setMapOpen(!showMap); }}
            maximized={maximized}
            onToggleMaximized={toggleMaximized}
          />
        </div>
      </div>
      <div className="pointer-events-none absolute left-2 z-10 flex max-w-[calc(100%-4.5rem)] flex-col items-start gap-1.5" style={{ top: topHeight + 12 }}>
        {hint && !talk ? <OfficeHint touch={coarse} onClose={dismissHint} /> : null}
        {agents.length === 0 ? (
          <p className="pointer-events-auto m-0 max-w-xs border-2 border-[#0e0f17] bg-[#1a1c2c]/95 p-2.5 text-[12px] leading-snug text-[#c5d3dc]">
            No hay ningún agente en la oficina: ni configurado, ni con entregas abiertas, ni con lease reciente. Los edificios de cada grupo ya están en pie.
          </p>
        ) : null}
      </div>
      {coarse && paseo ? (
        <div className="absolute left-2 z-10" style={{ bottom: bottomHeight + 12 }}>
          <DirectionPad onHold={(dir, held) => {
            if (held) engine.pad.add(dir); else engine.pad.delete(dir);
            engine.following = true;
            kick();
          }}
          />
        </div>
      ) : null}
      {selected && !sheetOpen && !talk ? (
        <div className="pointer-events-none absolute left-2 z-20" style={{ bottom: bottomHeight + 12 }}>
          <AgentCard
            agent={selected}
            place={placeOf(selected.id)}
            following={followId === selected.id}
            onClose={onDeselect}
            onTalk={onTalk ? () => { onTalk(selected.id); } : undefined}
            onSheet={selected.visitor ? undefined : () => { onSheet(selected.id); }}
            onEmote={(icon) => { engine.emote(selected.id, icon); kick(); }}
            onFollow={() => { setFollowId(followId === selected.id ? null : selected.id); }}
          />
        </div>
      ) : null}
      <div ref={bottomRef} className="pointer-events-none absolute inset-x-2 bottom-2 z-10 flex justify-center">
        {talk ? null : <Hotbar slots={slots} current={level} onGo={go} compact={narrow} />}
      </div>
      {talk ? <div className="contents">{talk.panel}</div> : null}
      <TalkPrompt buttonRef={promptRef} name={talkTo?.name ?? null} coarse={coarse} onTalk={() => { if (talkTo) (onTalk ?? onSelect)(talkTo.id); }} />
      <FloatingTooltip anchor={anchor} open={Boolean(tipAgent && anchor)}>
        {tipAgent ? <AgentTip agent={tipAgent} /> : null}
      </FloatingTooltip>
      <FloatingTooltip anchor={siteHover?.anchor ?? null} open={Boolean(siteSlot && siteHover)}>
        {siteSlot ? (
          <>
            <strong>{siteSlot.name}</strong>
            <span className="mt-1 block text-xs">{siteSlot.kind === 'group' ? `${String(siteSlot.people)} ${siteSlot.people === 1 ? 'agente trabaja' : 'agentes trabajan'} acá` : `${String(siteSlot.people)} adentro ahora`}</span>
            {siteSlot.alerts > 0 ? <span className="mt-0.5 block text-xs text-danger-ink">{siteSlot.alerts} {siteSlot.alerts === 1 ? 'necesita' : 'necesitan'} atención</span> : null}
            <p>Clic para entrar.</p>
          </>
        ) : null}
      </FloatingTooltip>
    </div>
  );
}

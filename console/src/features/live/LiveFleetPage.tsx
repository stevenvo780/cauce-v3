import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { ErrorState, LoadingState } from '../../components/ui';
import { PageHelp } from '../../components/PageHelp';
import { cn } from '../../cn';
import { redirect, useRouteSearch } from '../../router';
import { useFleet } from '../../shell/fleet-context';
import { useMediaQuery } from '../../shell/use-media-query';
import { STATE_TONE, TONE_CLASS } from '../../status-tone';
import { useAgentPreferences } from '../../components/agent-actions/preferences-context';
import { HudAlerts, HudFreshness, HudStates, type AlertItem } from '../office/HudBar';
import { HUD_BUTTON, HUD_PANEL, HUD_TEXT } from '../office/hud-style';
import { OfficeDialog } from '../office/OfficeDialog';
import { OfficeGame, type OfficeAgent } from '../office/OfficeGame';
import { groupDirectory, membershipsOf } from '../office/teams';
import { useOfficeChat } from '../office/use-office-chat';
import { RECENT_VISITOR_MS, useMcpVisitors } from '../office/visitors';
import { ORDEN_VIVO, formatAckAge, sortByUrgency } from './activity';
import { AgentSheet } from './AgentSheet';
import {
  BURST_MS, LIVE_STATE_META, agentKey, buildLiveViews, detectPulses, fleetVerdict, humanSeconds, rememberFleet, stateTally,
  type FleetMemory, type LiveState, type PulseMap,
} from './agent-state';
import { projectLiveFleet } from './live-projection';

/** Three missed reads and the picture stops proving anything; never less than this window. */
const STALE_AFTER_MS = 15_000;
const AWAKE_SECONDS = 15 * 60;
const PROBLEMS: ReadonlySet<LiveState> = new Set(['down', 'blocked']);
/** Poll periods the operator can pick; 0 pauses the shared activity poll. */
const REFRESH_OPTIONS = [
  { ms: 2_000, label: '2 s' },
  { ms: 5_000, label: '5 s' },
  { ms: 15_000, label: '15 s' },
  { ms: 0, label: 'En pausa' },
] as const;

function usePulses(snapshot: ReturnType<typeof projectLiveFleet>['snapshot']): PulseMap {
  const memory = useRef<FleetMemory>({});
  const [pulses, setPulses] = useState<PulseMap>({});
  useEffect(() => {
    if (!snapshot) return;
    const at = Date.now();
    const fresh = detectPulses(memory.current, snapshot, at);
    memory.current = rememberFleet(snapshot, at);
    setPulses((current) => {
      const merged: PulseMap = {};
      for (const [key, list] of Object.entries(current)) {
        const alive = list.filter((pulse) => at - pulse.atMs < BURST_MS);
        if (alive.length > 0) merged[key] = alive;
      }
      for (const [key, list] of Object.entries(fresh)) merged[key] = [...(merged[key] ?? []), ...list];
      return merged;
    });
  }, [snapshot]);
  return pulses;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);
  return now;
}

export function LiveFleetPage() {
  const fleet = useFleet();
  const { activity, topology, activityIntervalMs } = fleet;
  const staleAfterMs = activityIntervalMs === 0 ? STALE_AFTER_MS : Math.max(STALE_AFTER_MS, activityIntervalMs * 3);
  const now = useNow();
  const search = new URLSearchParams(useRouteSearch());
  const selectedKey = search.get('agente');
  const sheetWanted = search.get('ficha') === '1';
  const [filter, setFilter] = useState<ReadonlySet<LiveState>>(new Set());
  const [talkKey, setTalkKey] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const narrow = useMediaQuery('(max-width: 760px)');
  const visitors = useMcpVisitors();
  const chat = useOfficeChat(talkKey, visitors);

  const { snapshot } = useMemo(() => projectLiveFleet(activity.data, topology.data), [activity.data, topology.data]);
  const pulses = usePulses(snapshot);

  const { views, edges } = useMemo(() => {
    const visible = new Set((snapshot?.agents ?? []).map((agent) => `${agent.tenant_id}/${agent.alias}`));
    const built = buildLiveViews(activity.data, pulses, now);
    return { views: built.views.filter((view) => visible.has(view.key)), edges: built.edges };
  }, [activity.data, snapshot, pulses, now]);

  const tally = useMemo(() => stateTally(views), [views]);
  const estados = useMemo(() => new Map(views.map((view) => [view.key, view.state])), [views]);
  const observedAt = snapshot?.observed_at ?? undefined;
  const verdict = useMemo(
    () => fleetVerdict(views, { error: activity.error, observedAt, nowMs: now, staleAfterMs }),
    [views, activity.error, observedAt, now, staleAfterMs],
  );
  const highlight = useMemo(
    () => (filter.size === 0 ? null : new Set(views.filter((view) => filter.has(view.state)).map((view) => view.key))),
    [views, filter],
  );

  const appearances = useAgentPreferences()?.appearances;
  const directory = useMemo(() => groupDirectory(topology.data), [topology.data]);
  const groups = useMemo(() => [...directory.order.keys()].map((id) => ({ id, label: directory.labels.get(id) ?? id, hue: directory.hues.get(id) ?? 0 })), [directory]);
  const memberships = useMemo(() => membershipsOf(fleet.agents, directory), [fleet.agents, directory]);
  const sendsOf = useMemo(() => {
    const out = new Map<string, { to: string; id: string }[]>();
    for (const edge of edges) out.set(edge.from, [...(out.get(edge.from) ?? []), { to: edge.to, id: edge.deliveryId ?? `${edge.from}>${edge.to}` }]);
    return out;
  }, [edges]);
  const officeAgents = useMemo<OfficeAgent[]>(() => views.map((view): OfficeAgent => ({
    id: view.key, name: view.alias, state: view.state, reason: view.reason, delegatesTo: view.delegatesTo, sends: sendsOf.get(view.key) ?? [],
    glyph: appearances?.get(view.key)?.glyph, hue: appearances?.get(view.key)?.hue, style: appearances?.get(view.key)?.style,
    awake: view.state === 'idle' && typeof view.secondsSinceLastAck === 'number' && view.secondsSinceLastAck < AWAKE_SECONDS,
    team: memberships.get(view.key)?.team, groups: memberships.get(view.key)?.groups,
  })).concat(visitors.map((visitor): OfficeAgent => {
    const last = visitor.lastPublicationAt ? Date.parse(visitor.lastPublicationAt) : NaN;
    return {
      id: visitor.id, name: `${visitor.label} · MCP`, state: 'idle', delegatesTo: [], visitor: true,
      awake: now - last < RECENT_VISITOR_MS,
      reason: `Cliente MCP: ${Number.isNaN(last) ? 'no publicó nada todavía' : `publicó hace ${humanSeconds((now - last) / 1000)}`}; presencia no verificable.`,
    };
  })), [views, sendsOf, appearances, memberships, visitors, now]);

  const urgent = useMemo<AlertItem[]>(() => {
    const lookback = snapshot?.thresholds?.ack_lookback_seconds;
    return sortByUrgency((snapshot?.agents ?? []).filter((agent) => PROBLEMS.has(estados.get(agentKey(agent)) ?? 'idle')), estados).map((agent) => {
      const key = agentKey(agent);
      const state = estados.get(key) ?? 'down';
      const ack = formatAckAge(agent.seconds_since_last_ack, lookback);
      return { key, name: agent.display_name ?? agent.alias, state, title: `${key}: ${LIVE_STATE_META[state].hint} Último ACK ${ack}.`, detail: ack };
    });
  }, [snapshot, estados]);

  const select = (key: string) => {
    if (visitors.some((visitor) => visitor.id === key)) { setTalkKey(key); return; }
    redirect(`/live?agente=${encodeURIComponent(key)}`);
  };
  const deselect = () => { redirect('/live'); };
  const talkTo = (key: string) => {
    if (selectedKey) deselect();
    setTalkKey(key);
  };
  const toggle = (state: LiveState) => {
    setFilter((current) => {
      const next = new Set(current);
      if (next.has(state)) next.delete(state); else next.add(state);
      return next;
    });
  };

  if (activity.error && !activity.data) {
    return (
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        <ErrorState error={activity.error} onRetry={() => { void activity.reload(); }} reintentando={activity.loading} />
      </div>
    );
  }
  if (!snapshot || (!topology.data && !topology.error)) {
    return <div className="flex-1 overflow-y-auto p-4 sm:p-6"><LoadingState label="Leyendo la actividad de la flota…" /></div>;
  }

  const problems = tally.down + tally.blocked;
  const connected = views.length - tally.down;
  const unknown = verdict.tone === 'desconocido';
  const selected = views.find((view) => view.key === selectedKey) ?? null;
  const talking = officeAgents.find((agent) => agent.id === talkKey);
  const summary = `Oficina con ${String(views.length)} agentes: ${ORDEN_VIVO
    .filter((state) => tally[state] > 0)
    .map((state) => `${String(tally[state])} ${LIVE_STATE_META[state].label.toLowerCase()}`)
    .join(', ')}. Flechas para recorrerlos y Enter para abrir uno; 1 a 9 cambian de edificio, WASD mueve la vista, + y − acercan, 0 encuadra y P activa el modo paseo.`;

  const states = <HudStates order={ORDEN_VIVO} tally={tally} filter={filter} onToggle={toggle} onClear={() => { setFilter(new Set()); }} />;
  const freshness = (
    <HudFreshness at={observedAt ?? null} loading={activity.loading} onRefresh={fleet.reload}
      interval={{ value: activityIntervalMs, onChange: fleet.setActivityIntervalMs, options: REFRESH_OPTIONS }} />
  );
  const hud = (
    <>
      <header className={cn(HUD_PANEL, 'pointer-events-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 p-1.5')}>
        <div className="flex items-center gap-1 [&_button]:text-[#94b0c2] [&_button:hover]:bg-[#333c57] [&_button:hover]:text-[#f4f4f4]">
          <h1 className={cn(HUD_TEXT, 'm-0 pl-1 text-[14px] text-[#ffcd75]')}>Oficina</h1>
          <PageHelp
            title="Oficina"
            description="Un campus en pixel art: cada grupo tiene su edificio y cada persona es un agente. Entrá a un edificio con un clic, con la barra de abajo o con las teclas 1 a 9. Trabajan en su escritorio; cuando le pasan trabajo a alguien de otro edificio mandan una cápsula por los tubos neumáticos y quien la recibe se levanta a buscarla a su estación. Los libres van a la Cafetería o al Parque y sólo duermen en la Residencia si llevan mucho rato sin trabajo; los caídos van al Taller y los trabados piden ayuda en su mesa. Los clientes MCP esperan en Recepción y hablarles les deja una nota en su buzón. Las ventanas encendidas dicen quién trabaja; los grupos nuevos se construyen y los que se borran se demuelen. El estado sale del trabajo que avanza (o no), no del latido."
          >
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
              {ORDEN_VIVO.map((state) => (
                <div key={state} className="contents">
                  <dt className={cn('font-medium', TONE_CLASS[STATE_TONE[state]].ink)}>{LIVE_STATE_META[state].label}</dt>
                  <dd className="m-0">{LIVE_STATE_META[state].hint}</dd>
                </div>
              ))}
            </dl>
          </PageHelp>
        </div>
        <p className="m-0 flex min-w-0 items-center gap-1.5 text-[12px] font-medium" role="status" aria-label="Veredicto de la flota" data-tone={verdict.tone}>
          <span aria-hidden="true" className={cn('size-2.5 shrink-0 border-2 border-[#0e0f17]', unknown ? 'bg-[#ffcd75]' : problems > 0 ? 'bg-[#b13e53]' : 'bg-[#38b764]')} />
          {unknown ? (
            <span className="text-[#ffcd75]" title={verdict.apoyo}>{verdict.frase}</span>
          ) : problems > 0 ? (
            <span className="truncate text-[#c5d3dc]">
              <button
                type="button"
                className="cursor-pointer border-0 bg-transparent p-0 font-bold text-[#ff8a7a] underline-offset-2 hover:underline"
                title={verdict.culpables.map((culprit) => `${culprit.alias}: ${culprit.motivo}`).join('\n')}
                onClick={() => { setFilter(new Set(PROBLEMS)); }}
              >
                {problems} {problems === 1 ? 'necesita' : 'necesitan'} atención
              </button>
              {' · '}{connected} {connected === 1 ? 'conectado' : 'conectados'}
            </span>
          ) : (
            <span className="truncate text-[#c5d3dc]">Todo en orden · {connected} {connected === 1 ? 'conectado' : 'conectados'}</span>
          )}
        </p>
        {narrow ? (
          <button type="button" aria-expanded={moreOpen} onClick={() => { setMoreOpen(!moreOpen); }} className={cn(HUD_BUTTON, HUD_TEXT, 'ml-auto h-8 px-2 text-[10px]')}>
            Estados <ChevronDown size={11} aria-hidden="true" className={moreOpen ? 'rotate-180' : undefined} />
          </button>
        ) : (
          <>
            <div className="min-w-0 flex-1">{states}</div>
            <div className="ml-auto">{freshness}</div>
          </>
        )}
        {narrow && moreOpen ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-1.5">
            {states}
            {freshness}
          </div>
        ) : null}
      </header>
      <HudAlerts items={urgent} selectedKey={selected?.key ?? null} onOpen={select} />
    </>
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <section aria-label="Oficina" data-objeto-principal="oficina" className="relative min-h-0 flex-1">
        <OfficeGame
          agents={officeAgents}
          groups={groups}
          selectedId={selected?.key ?? null}
          sheetOpen={Boolean(selected && sheetWanted)}
          highlight={highlight}
          onSelect={select}
          onDeselect={deselect}
          onSheet={(key) => { redirect(`/live?agente=${encodeURIComponent(key)}&ficha=1`); }}
          label={summary}
          onTalk={talkTo}
          speech={chat.speech}
          hues={directory.hues}
          hud={hud}
          now={now}
          talk={talkKey && chat.dialog && talking ? {
            id: talkKey,
            panel: <OfficeDialog model={chat.dialog} state={talking.state} onClose={() => { setTalkKey(null); }} />,
          } : null}
        />
      </section>
      <AgentSheet
        view={selected && sheetWanted ? selected : null}
        status={fleet.status}
        onClose={() => { if (selected) select(selected.key); else deselect(); }}
        onTalk={selected ? () => { talkTo(selected.key); } : undefined}
      />
    </div>
  );
}

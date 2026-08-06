import { Pause, Play, Radio } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetActivitySnapshot } from '../../api/types';
import { Badge, ErrorState, LoadingState, Metric, PageHeader, Panel, Time } from '../../components/ui';
import { UNKNOWN } from '../../lib';
import { AgentAvatar } from './AgentAvatar';
import {
  BURST_MS,
  LIVE_STATES,
  LIVE_STATE_META,
  buildLiveViews,
  detectPulses,
  humanSeconds,
  rememberFleet,
  stateTally,
  type DelegationEdge,
  type FleetMemory,
  type LiveAgentView,
  type LiveState,
  type PulseMap,
} from './agent-state';
import { LiveHypergraph } from './LiveHypergraph';
import './live.css';
import './live-hypergraph.css';

const INTERVALS = [
  { value: 2000, label: 'cada 2 s' },
  { value: 4000, label: 'cada 4 s' },
  { value: 10000, label: 'cada 10 s' },
  { value: 30000, label: 'cada 30 s' },
  { value: 0, label: 'en pausa' },
];

const STATE_ACCENT: Record<LiveState, string> = {
  down: 'var(--red)',
  blocked: 'var(--amber)',
  delegating: 'var(--violet)',
  responding: 'var(--lime)',
  receiving: 'var(--blue)',
  thinking: 'var(--mint)',
  idle: 'var(--faint)',
};

interface Point { x: number; y: number }

/** Arco dibujado: dos puntos ya resueltos en píxeles del escenario, más su arista de origen. */
interface DrawnLink { edge: DelegationEdge; from: Point; to: Point; id: string }

function cardAnchor(element: HTMLElement, stage: HTMLElement): Point {
  const card = element.getBoundingClientRect();
  const base = stage.getBoundingClientRect();
  return { x: card.left - base.left + card.width / 2, y: card.top - base.top + card.height / 2 };
}

/**
 * Curva entre dos tarjetas. Se desplaza perpendicularmente al segmento para que dos aristas
 * opuestas (a→b y b→a) no se dibujen una encima de la otra, y para que el arco no atraviese la
 * tarjeta de origen.
 */
function arcPath(from: Point, to: Point): { d: string; mid: Point } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy) || 1;
  const bow = Math.min(90, distance * 0.28);
  const control = { x: (from.x + to.x) / 2 - (dy / distance) * bow, y: (from.y + to.y) / 2 + (dx / distance) * bow };
  const mid = {
    x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y,
  };
  return { d: `M${from.x} ${from.y} Q${control.x} ${control.y} ${to.x} ${to.y}`, mid };
}

export function LiveFleetPage() {
  const api = useApi();
  const activity = useResource('live-fleet-activity', () => api.getFleetActivity());
  // La topología aporta las SALAS, que la actividad no trae. Se lee aparte y una sola vez: cambia
  // cuando alguien toca la configuración, no cada cuatro segundos como la actividad. Si falla, el
  // hipergrafo desaparece y la lista de muñecos sigue funcionando igual.
  const topology = useResource('live-topology', () => api.getTopology());
  const [intervalMs, setIntervalMs] = useState(4000);
  const [selected, setSelected] = useState<string>();
  const [stateFilter, setStateFilter] = useState<LiveState>();
  const [now, setNow] = useState(() => Date.now());

  const snapshot = activity.data;

  // --- Detección de transiciones -------------------------------------------------------------
  // Los pulsos ("acaba de entrarle trabajo", "acaba de cerrar un turno") NO vienen del servidor:
  // salen de comparar este snapshot con el anterior, del lado del cliente. La memoria del
  // snapshot previo va en un ref (no debe provocar render por sí sola) y los pulsos en estado,
  // porque sí tienen que repintar los muñecos en cuanto se detectan.
  const memoryRef = useRef<FleetMemory>({});
  const [pulses, setPulses] = useState<PulseMap>({});

  const observedAt = snapshot?.observed_at ?? undefined;
  useEffect(() => {
    if (!snapshot) return;
    const at = Date.now();
    const fresh = detectPulses(memoryRef.current, snapshot, at);
    memoryRef.current = rememberFleet(snapshot, at);
    setPulses((current) => {
      const merged: PulseMap = {};
      for (const [key, list] of Object.entries(current)) {
        const alive = list.filter((pulse) => at - pulse.atMs < BURST_MS);
        if (alive.length > 0) merged[key] = alive;
      }
      for (const [key, list] of Object.entries(fresh)) merged[key] = [...(merged[key] ?? []), ...list];
      return merged;
    });
    // Se depende de `observedAt` y no del objeto: dos snapshots idénticos no deben recalcular.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observedAt]);

  // Reloj propio: los estados transitorios tienen que apagarse solos aunque no llegue un
  // snapshot nuevo, o un agente quedaría "respondiendo" para siempre.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const { reload } = activity;
  useEffect(() => {
    if (intervalMs <= 0) return undefined;
    const timer = window.setInterval(reload, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, reload]);

  const { views, edges } = useMemo(
    () => buildLiveViews(snapshot, pulses, now),
    [snapshot, pulses, now],
  );
  const tally = useMemo(() => stateTally(views), [views]);

  const byTenant = useMemo(() => {
    const groups = new Map<string, LiveAgentView[]>();
    for (const view of views) groups.set(view.tenantId, [...(groups.get(view.tenantId) ?? []), view]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [views]);

  // --- Arcos de delegación -------------------------------------------------------------------
  const stageRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<DrawnLink[]>([]);

  const registerCard = useCallback((key: string, element: HTMLElement | null) => {
    if (element) cardRefs.current.set(key, element);
    else cardRefs.current.delete(key);
  }, []);

  const measure = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const drawn: DrawnLink[] = [];
    edges.forEach((edge, index) => {
      const from = cardRefs.current.get(edge.from);
      const to = cardRefs.current.get(edge.to);
      if (!from || !to) return;
      drawn.push({
        edge,
        id: `${edge.from}->${edge.to}#${edge.deliveryId ?? index}`,
        from: cardAnchor(from, stage),
        to: cardAnchor(to, stage),
      });
    });
    setLinks(drawn);
  }, [edges]);

  useLayoutEffect(() => {
    measure();
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const linkedKeys = useMemo(() => {
    if (!selected) return new Set<string>();
    const related = new Set<string>();
    for (const edge of edges) {
      if (edge.from === selected) related.add(edge.to);
      if (edge.to === selected) related.add(edge.from);
    }
    return related;
  }, [edges, selected]);

  const detail = views.find((view) => view.key === selected);
  const feedState = activity.error ? 'error' : intervalMs <= 0 ? 'paused' : 'live';

  if (activity.loading && !snapshot) return <LoadingState label="Leyendo la actividad de la flota…" />;
  if (activity.error && !snapshot) return <ErrorState error={activity.error} onRetry={activity.reload} />;

  return (
    <div className="live-page">
      <PageHeader
        eyebrow="Flota"
        title="Sala de máquinas"
        description="Los 16 alias de la flota, cada uno con su muñeco. Quién trabaja, quién delega y quién está trabado se lee sin abrir una sola fila."
      />

      <div className="live-toolbar">
        <span className="live-feed-state" data-feed={feedState}>
          <span className="live-feed-dot" aria-hidden="true" />
          {feedState === 'error' ? 'Feed caído' : feedState === 'paused' ? 'En pausa' : 'En vivo'}
        </span>
        <label>
          Refresco
          <select
            value={intervalMs}
            onChange={(event) => setIntervalMs(Number(event.target.value))}
            aria-label="Intervalo de refresco"
          >
            {INTERVALS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <button type="button" className="button secondary" onClick={activity.reload}>
          {intervalMs <= 0 ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          Refrescar ahora
        </button>
        <span className="muted">Servidor: <Time value={snapshot?.observed_at} /></span>
        {activity.error ? <span className="notice error">Última lectura falló: {activity.error.message}. Se muestra el snapshot anterior.</span> : null}
      </div>

      <p className="live-transport-note">
        <Radio size={12} aria-hidden="true" /> El gateway no publica websocket ni SSE para la consola
        (<code>/v3/ws</code> es el bus de los agentes, no un canal de lectura). Esto es <strong>polling</strong> sobre
        <code> GET /v3/console/activity</code>, y por eso el intervalo se elige a mano y se muestra la hora del servidor.
      </p>

      <div className="live-tally">
        {LIVE_STATES.map((state) => {
          const meta = LIVE_STATE_META[state];
          return (
            <button
              key={state}
              type="button"
              className="live-tally-chip"
              style={{ ['--accent' as string]: STATE_ACCENT[state] }}
              data-empty={tally[state] === 0 ? 'true' : undefined}
              aria-pressed={stateFilter === state}
              onClick={() => setStateFilter((current) => (current === state ? undefined : state))}
              title={meta.hint}
            >
              <span className="live-tally-swatch" aria-hidden="true" />
              {meta.label} <strong>{tally[state]}</strong>
            </button>
          );
        })}
      </div>

      <Panel
        title="Quién le habla a quién, ahora"
        subtitle="Los mismos muñecos, colocados en su sala. Cada flecha es una delegación con entrega en vuelo real; si no hay flecha, nadie se está pasando trabajo."
      >
        <LiveHypergraph
          topology={topology.data}
          views={views}
          edges={edges}
          focusKey={selected ?? null}
          onFocus={(key) => setSelected(key ?? undefined)}
          onOpen={(view) => setSelected(view.key)}
        />
      </Panel>

      <div className="live-stage" ref={stageRef}>
        <svg className="live-links" aria-hidden="true">
          {links.map((link) => {
            const { d, mid } = arcPath(link.from, link.to);
            return (
              <g key={link.id}>
                <path className="live-link-path" d={d} />
                <circle className="live-link-runner" cx={mid.x} cy={mid.y} r="3.5">
                  <animateMotion dur="1.6s" repeatCount="indefinite" path={d} />
                </circle>
                <circle className="live-link-head" cx={link.to.x} cy={link.to.y} r="3" />
              </g>
            );
          })}
        </svg>

        {byTenant.map(([tenant, group]) => (
          <section className="live-tenant" key={tenant}>
            <h2 className="live-tenant-title">
              {tenant} <span>{group.length} {group.length === 1 ? 'agente' : 'agentes'}</span>
            </h2>
            <div className="live-grid">
              {group.map((view) => {
                const meta = LIVE_STATE_META[view.state];
                const dimmed = stateFilter !== undefined && view.state !== stateFilter;
                return (
                  <button
                    key={view.key}
                    type="button"
                    ref={(element) => registerCard(view.key, element)}
                    className="live-card"
                    data-state={view.state}
                    data-dimmed={dimmed ? 'true' : undefined}
                    data-linked={linkedKeys.has(view.key) ? 'true' : undefined}
                    style={{ ['--accent' as string]: STATE_ACCENT[view.state] }}
                    onClick={() => setSelected((current) => (current === view.key ? undefined : view.key))}
                    aria-pressed={selected === view.key}
                    title={view.reason}
                  >
                    {view.delegatesTo.length > 0 ? (
                      <span className="live-card-fanout">→ {view.delegatesTo.length}</span>
                    ) : null}
                    <AgentAvatar
                      state={view.state}
                      overloaded={view.overloaded}
                      label={`${view.alias}: ${meta.label}. ${view.reason}`}
                    />
                    <p className="live-card-alias">{view.alias}</p>
                    <span className="live-card-state">{meta.label}</span>
                    <span className="live-card-harness">{view.harnessId ?? UNKNOWN}</span>
                    <span className="live-card-numbers">
                      <span>vuelo <b>{view.inFlight}</b></span>
                      <span>cola <b>{view.queued}</b></span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      {detail ? (
        <Panel title={`${detail.tenantId} / ${detail.alias}`} subtitle={detail.displayName ?? undefined} className="live-detail">
          <div className="live-detail-head">
            <AgentAvatar state={detail.state} overloaded={detail.overloaded} label={LIVE_STATE_META[detail.state].label} />
            <div>
              <Badge tone={LIVE_STATE_META[detail.state].tone === 'danger' ? 'danger' : LIVE_STATE_META[detail.state].tone === 'positive' ? 'online' : 'info'}>
                {LIVE_STATE_META[detail.state].label}
              </Badge>
              <p className="live-reason">{detail.reason}</p>
            </div>
          </div>
          <dl>
            <dt>Arnés</dt><dd>{detail.harnessId ?? UNKNOWN}</dd>
            <dt>En vuelo / cola</dt><dd>{detail.inFlight} / {detail.queued}</dd>
            <dt>Más viejo en vuelo</dt>
            <dd>{typeof detail.oldestInFlightSeconds === 'number' ? humanSeconds(detail.oldestInFlightSeconds) : UNKNOWN}</dd>
            <dt>Último ACK</dt>
            <dd>
              {detail.secondsSinceLastAck === null || detail.secondsSinceLastAck === undefined
                ? <span className="unknown">sin ACK dentro de la ventana de búsqueda</span>
                : `hace ${humanSeconds(detail.secondsSinceLastAck)}`}
            </dd>
            <dt>Delega a</dt>
            <dd>{detail.delegatesTo.length > 0 ? detail.delegatesTo.join(', ') : <span className="unknown">nadie ahora mismo</span>}</dd>
            <dt>Trabaja para</dt>
            <dd>{detail.delegatedFrom.length > 0 ? detail.delegatedFrom.join(', ') : <span className="unknown">nadie ahora mismo</span>}</dd>
            <dt>Lease vence</dt><dd><Time value={detail.agent.presence?.lease_until} /></dd>
          </dl>
          {detail.flags.length > 0 ? (
            <div className="live-flags">
              {detail.flags.map((flag) => <Badge key={flag} tone="warning">{flag}</Badge>)}
            </div>
          ) : null}
          <p className="muted">
            Un lease vigente no prueba que el agente responda: el estado de arriba sale del trabajo que
            avanza (o no), no del latido.
          </p>
        </Panel>
      ) : null}

      <Panel title="Los siete estados" subtitle="Qué significa cada muñeco, y contra qué campo del servidor se puede contrastar.">
        <div className="live-legend">
          {LIVE_STATES.map((state) => (
            <div className="live-legend-item" key={state}>
              <AgentAvatar state={state} label="" />
              <div>
                <strong>{LIVE_STATE_META[state].label}</strong>
                <span>{LIVE_STATE_META[state].hint}</span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div className="metric-grid">
        <Metric label="Agentes" value={snapshot?.totals?.agents} detail="registrados y visibles para este operador" />
        <Metric label="En vuelo" value={snapshot?.totals?.in_flight} detail="entregas tomadas ahora mismo" />
        <Metric label="Delegaciones vivas" value={edges.length} detail="entregas de un agente en manos de otro" tone={edges.length > 0 ? 'positive' : 'neutral'} />
        <Metric
          label="En problemas"
          value={tally.blocked + tally.down}
          tone={tally.blocked + tally.down > 0 ? 'danger' : 'positive'}
          detail="bloqueados más caídos"
        />
      </div>
    </div>
  );
}

export type { FleetActivitySnapshot };

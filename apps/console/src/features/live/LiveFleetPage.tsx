import { Pause, Play, Radio } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetActivitySnapshot } from '../../api/types';
import { Badge, ErrorState, LoadingState, Metric, PageHeader, Panel, Time } from '../../components/ui';
import { UNKNOWN } from '../../lib';
import { ActivityExplainers, FleetActivityTable, FleetSignals } from '../activity/ActivityPage';
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
  type FleetMemory,
  type LiveState,
  type PulseMap,
} from './agent-state';
import { LiveHypergraph } from './LiveHypergraph';
import './live.css';
import './live-hypergraph.css';

/**
 * Sala de máquinas: la única vista de lo que la flota está haciendo ahora mismo.
 *
 * Antes esta página dibujaba la flota **dos veces** — el hipergrafo arriba y, debajo, la misma
 * quincena de muñecos agrupados por tenant con sus propios arcos de delegación — y además existía
 * una ruta aparte, "Actividad de la flota", que leía el mismo `GET /v3/console/activity` y lo
 * mostraba como tabla. Tres caras de un solo dato, dos pollings y dos entradas de menú.
 *
 * Ahora hay **un solo dibujo** (el hipergrafo, que es el que responde *quién le habla a quién*) y
 * **una sola tabla** (que responde *cuánto lleva y si avanza*, con búsqueda por alias, que es lo
 * único que un dibujo hace peor que una lista). La grilla por tenant no aportaba ninguna de las
 * dos cosas: se eliminó junto con sus arcos, sus refs de medición y su CSS.
 */

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

  /**
   * Filtro por estado: `null` = sin filtro.
   *
   * Los chips de arriba filtraban la grilla de tarjetas, que ya no existe. En vez de dejarlos
   * decorativos —un control que no hace nada es peor que no tenerlo— ahora acotan **las dos**
   * mitades a la vez: atenúan los muñecos que no son de ese estado y reducen las filas de la
   * tabla a los mismos alias. Un solo filtro para una sola página.
   */
  const spotlight = useMemo<Set<string> | null>(() => {
    if (stateFilter === undefined) return null;
    return new Set(views.filter((view) => view.state === stateFilter).map((view) => view.key));
  }, [views, stateFilter]);

  const detail = views.find((view) => view.key === selected);
  const feedState = activity.error ? 'error' : intervalMs <= 0 ? 'paused' : 'live';

  if (activity.loading && !snapshot) return <LoadingState label="Leyendo la actividad de la flota…" />;
  if (activity.error && !snapshot) return <ErrorState error={activity.error} onRetry={activity.reload} />;

  return (
    <div className="live-page">
      {/*
        El recuento sale del snapshot, NO de un número escrito a mano.
        Estaba fijo en 16 mientras la página dibujaba 15 muñecos, contaba 15 filas y el propio
        `aria-label` del grafo decía 15: cuatro números a la vista y uno distinto de los otros
        tres. Una cabecera que se contradice con el dibujo que tiene justo debajo hace desconfiar
        del resto de la pantalla, y con datos reales ese desfase se produce solo cada vez que
        alguien da de alta o de baja un alias.
      */}
      <PageHeader
        eyebrow="Flota"
        title="Sala de máquinas"
        description={`Los ${views.length} alias de la flota, cada uno con su muñeco. Quién trabaja, quién delega y quién está trabado se lee sin abrir una sola fila.`}
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

      {/* Una sola fila de contadores para toda la página. Antes había cuatro `Metric` acá y otros
          cuatro casi iguales en la ruta "Actividad de la flota"; son el mismo `totals`. */}
      <div className="metrics-grid">
        <Metric label="Agentes visibles" value={snapshot?.totals?.agents} detail="propio tenant + ACL allow_read" />
        <Metric label="En vuelo" value={snapshot?.totals?.in_flight} tone="warning" detail="leased + accepted + started" />
        <Metric label="En cola" value={snapshot?.totals?.queued} detail="pending + retry" />
        <Metric label="Vencidas en vuelo" value={snapshot?.totals?.overdue_in_flight} tone="danger" detail="ack_deadline_at ya pasó" />
        <Metric label="Delegaciones vivas" value={edges.length} detail="entregas de un agente en manos de otro" tone={edges.length > 0 ? 'positive' : 'neutral'} />
      </div>

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
          spotlight={spotlight}
          loadingTopology={topology.loading && !topology.data}
          onFocus={(key) => setSelected(key ?? undefined)}
          onOpen={(view) => setSelected(view.key)}
        />
      </Panel>

      {/* La lista. No vuelve a dibujar delegaciones — para eso está el grafo de arriba. Lo que
          aporta es lo que un dibujo no da: buscar un alias por nombre y abrir su detalle. */}
      <FleetActivityTable
        snapshot={snapshot}
        selectedKey={selected ?? null}
        onlyKeys={spotlight}
        filterLabel={stateFilter ? LIVE_STATE_META[stateFilter].label : undefined}
        onSelect={(key) => setSelected(key ?? undefined)}
      />

      <FleetSignals snapshot={snapshot} />

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

      <ActivityExplainers thresholds={snapshot?.thresholds} />
    </div>
  );
}

export type { FleetActivitySnapshot };

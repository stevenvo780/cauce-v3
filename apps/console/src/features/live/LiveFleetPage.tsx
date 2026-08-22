import { Pause, Play, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetActivitySnapshot } from '../../api/types';
import {
  ErrorState, FloatingTooltip, LoadingState, PageHeader, Panel, Time, Tooltip,
} from '../../components/ui';
import { formatDurationSeconds } from '../../lib';
import { ActivityExplainers, FleetActivityTable, FleetSignals } from '../activity/ActivityPage';
import { AclEdgeList } from '../topology/AclEdgeList';
import { TenantCards } from '../topology/TenantCards';
import { AgentDrawer, type DrawerTab } from './AgentDrawer';
import { AgentTooltipCard } from './AgentTooltipCard';
import { FleetVerdict } from './FleetVerdict';
import {
  BURST_MS,
  LIVE_STATES,
  LIVE_STATE_META,
  buildLiveViews,
  detectPulses,
  fleetVerdict,
  humanOrigins,
  rememberFleet,
  stateTally,
  type FleetMemory,
  type LiveAgentView,
  type LiveState,
  type PulseMap,
} from './agent-state';
import { LiveHypergraph, type HypergraphLayer } from './LiveHypergraph';
import './live.css';
import './live-hypergraph.css';

/**
 * «La flota ahora»: la única vista de lo que la flota está haciendo en este momento.
 *
 * Absorbió a "Fleet & presencia" y a "Tenants & ACL", que eran dos entradas de menú más para
 * responder preguntas que sólo tienen sentido *sobre un agente que ya estás mirando* —cómo está
 * conectado, con quién tiene permiso de hablar—. Ahora son una pestaña del cajón y un desplegable
 * de esta misma página, y el mapa no se pierde de vista para consultarlas. El menú pasó de trece
 * entradas a once.
 *
 * La jerarquía de arriba abajo ES el diseño, y responde en ese orden a *¿tengo que hacer algo?*:
 *   1. el veredicto, en una frase que se lee en tres segundos;
 *   2. la cinta de triage, ordenada por urgencia;
 *   3. el mapa, que es el centro;
 *   4. la lista, para lo que un dibujo hace peor (buscar un alias, leer una duración exacta).
 */

const INTERVALS = [
  { value: 2000, label: 'cada 2 s' },
  { value: 4000, label: 'cada 4 s' },
  { value: 10000, label: 'cada 10 s' },
  { value: 30000, label: 'cada 30 s' },
  { value: 0, label: 'en pausa' },
];

/**
 * Orden de la cinta de triage: de lo que exige acción a lo que no.
 *
 * Deliberadamente distinto del orden de `LIVE_STATES`, que es la PRECEDENCIA con la que se decide
 * el estado de un agente (`down` gana a todo) y no una jerarquía de atención. Ahí `responding` va
 * antes que `receiving` porque es un pulso transitorio que tiene que ganarle al estado estable;
 * acá va al final, porque "acaba de cerrar un turno" es la mejor noticia de la fila.
 */
const TALLY_ORDER: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'responding', 'idle',
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

/**
 * Cuántos intervalos de refresco pueden pasar antes de que el dato deje de acreditar nada.
 *
 * Tres, no uno: un refresco perdido es normal en una red real y degradar el veredicto por eso
 * sería un guardia que grita en falso, que a la larga tapa el fallo verdadero. Tres seguidos ya no
 * es ruido. Con el feed en pausa se usa el intervalo más lento, porque pausar es una decisión del
 * operador y no un síntoma.
 */
const STALE_FACTOR = 3;

/** Lo que la nota borrada explicaba, ahora colgado del punto «En vivo» donde sí se busca. */
const FEED_HINT = (
  <>
    <p>
      <strong>Esto es polling</strong>, no un canal en vivo: el gateway no publica websocket ni SSE
      para la consola (<code>/v3/ws</code> es el bus de los agentes, no un canal de lectura).
    </p>
    <p>
      Por eso el intervalo se elige a mano y por eso se muestra la hora del servidor: lo que ves
      es tan fresco como diga esa hora, ni un segundo más.
    </p>
  </>
);

interface TooltipTarget {
  anchor: DOMRect;
  view: LiveAgentView | null;
  alias: string;
}

export function LiveFleetPage() {
  const api = useApi();
  const activity = useResource('live-fleet-activity', () => api.getFleetActivity());
  // La topología aporta las SALAS, la capa de permisos, el selector de cliente y el desplegable
  // "Permisos y salas": las cuatro cosas de UNA sola lectura, fuera del polling. Cambia cuando
  // alguien toca la configuración, no cada cuatro segundos.
  const topology = useResource('live-topology', () => api.getTopology());
  const [intervalMs, setIntervalMs] = useState(4000);
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [stateFilter, setStateFilter] = useState<LiveState>();
  const [query, setQuery] = useState('');
  const [tenantFilter, setTenantFilter] = useState('todos');
  const [layer, setLayer] = useState<HypergraphLayer>('ahora');
  const [tip, setTip] = useState<TooltipTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const snapshot = activity.data;

  // --- Estado del cajón, con enlace profundo -------------------------------------------------
  const [drawer, setDrawer] = useState<{ key: string; tab: DrawerTab; trace?: string } | null>(
    () => leerQuery(),
  );

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [observedAt]);

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
  const origins = useMemo(() => humanOrigins(snapshot), [snapshot]);

  // --- Acotamiento por cliente ---------------------------------------------------------------
  const tenants = useMemo(() => {
    const vistos = new Set<string>();
    for (const view of views) vistos.add(view.tenantId);
    for (const tenant of topology.data?.tenants ?? []) if (tenant.id) vistos.add(tenant.id);
    return [...vistos].sort();
  }, [views, topology.data]);

  const alcance = useMemo(
    () => (tenantFilter === 'todos' ? views : views.filter((view) => view.tenantId === tenantFilter)),
    [views, tenantFilter],
  );

  /**
   * Un SOLO conjunto de alias resaltados para el mapa y la tabla a la vez.
   *
   * Los tres controles (chip de estado, buscador, cliente) se combinan en vez de pisarse: si están
   * los tres puestos, se ve la intersección. Un filtro que anula a otro en silencio es peor que no
   * tenerlo, porque el operador cree estar mirando algo que no está mirando.
   */
  const spotlight = useMemo<Set<string> | null>(() => {
    const aguja = query.trim().toLowerCase();
    const acotado = tenantFilter !== 'todos';
    if (stateFilter === undefined && !aguja && !acotado) return null;
    return new Set(
      views
        .filter((view) => stateFilter === undefined || view.state === stateFilter)
        .filter((view) => !acotado || view.tenantId === tenantFilter)
        .filter((view) => !aguja
          || `${view.tenantId} ${view.alias} ${view.displayName ?? ''} ${view.harnessId ?? ''}`
            .toLowerCase().includes(aguja))
        .map((view) => view.key),
    );
  }, [views, stateFilter, query, tenantFilter]);

  // `placed.filter(p => !p.view)` del grafo, calculado acá porque la cinta lo necesita: alias que
  // la topología declara y la actividad no reporta. No es un octavo estado del union: es su ausencia.
  const sinReportar = useMemo(() => {
    const conActividad = new Set(views.map((view) => view.key));
    let total = 0;
    for (const tenant of topology.data?.tenants ?? []) {
      const vistos = new Set<string>();
      for (const room of tenant.rooms ?? []) {
        for (const member of room.members ?? []) {
          if (!member.alias || !tenant.id) continue;
          const key = `${tenant.id}/${member.alias}`;
          if (vistos.has(key) || conActividad.has(key)) continue;
          vistos.add(key);
          total += 1;
        }
      }
    }
    return total;
  }, [views, topology.data]);

  const staleAfterMs = (intervalMs > 0 ? intervalMs : 30000) * STALE_FACTOR;
  const verdict = useMemo(
    () => fleetVerdict(alcance, { error: activity.error, observedAt, nowMs: now, staleAfterMs }),
    [alcance, activity.error, observedAt, now, staleAfterMs],
  );

  const detail = views.find((view) => view.key === drawer?.key);
  const feedState = activity.error ? 'error' : intervalMs <= 0 ? 'paused' : 'live';
  const edadSegundos = observedAt ? Math.max(0, (now - Date.parse(observedAt)) / 1000) : null;

  const abrirCajon = useCallback((key: string, tab: DrawerTab = 'ahora', trace?: string) => {
    setDrawer({ key, tab, trace });
    setSelected(key);
    escribirQuery(key, tab, trace);
  }, []);

  const cerrarCajon = useCallback(() => {
    setDrawer(null);
    escribirQuery(undefined);
  }, []);

  const enfocarCulpable = useCallback((key: string) => {
    setStateFilter(undefined);
    setSelected(key);
    // El chip no abre el cajón: lleva el ojo al muñeco. Abrir un panel encima del mapa por hacer
    // clic en un resumen sería quitarle al operador la vista de conjunto justo cuando la pidió.
    document.querySelector(`[data-agent-key="${cssEscape(key)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  if (activity.loading && !snapshot) return <LoadingState label="Leyendo la actividad de la flota…" />;
  if (activity.error && !snapshot) return <ErrorState error={activity.error} onRetry={activity.reload} />;

  return (
    <div className={`live-page${drawer && detail ? ' has-drawer' : ''}`}>
      <div className="live-main">
        <PageHeader
          eyebrow="Flota"
          title="La flota ahora"
          description={`Los ${alcance.length} alias que podés ver, qué tienen entre manos y quién se lo pidió.`}
        />

        <div className="live-toolbar">
          <Tooltip label={FEED_HINT} focusable={false}>
            <span className="live-feed-state" data-feed={feedState}>
              <span className="live-feed-dot" aria-hidden="true" />
              {feedState === 'error' ? 'Feed caído' : feedState === 'paused' ? 'En pausa' : 'En vivo'}
            </span>
          </Tooltip>

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

          {/* La EDAD del dato, no sólo su hora. "14:02:11" obliga a restar de cabeza contra un
              reloj que no está en pantalla; "hace 4 s" se lee de un vistazo, que es lo que hace
              falta para saber si lo que estás mirando todavía vale. */}
          <span className="muted live-age">
            Servidor: <Time value={observedAt} />
            {edadSegundos !== null ? <strong> · hace {formatDurationSeconds(edadSegundos)}</strong> : null}
          </span>

          <label className="live-search">
            <Search size={15} aria-hidden="true" />
            <span className="sr-only">Buscar un alias</span>
            <input
              type="search"
              value={query}
              placeholder="Buscar alias…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          {/* El selector sólo aparece si hay más de un cliente que acotar. Con uno solo sería un
              control que no hace nada, así que en su lugar se declara el alcance y ya. */}
          {tenants.length > 1 ? (
            <label>
              Cliente
              <select value={tenantFilter} onChange={(event) => setTenantFilter(event.target.value)}>
                <option value="todos">todos ({tenants.length})</option>
                {tenants.map((tenant) => <option key={tenant} value={tenant}>{tenant}</option>)}
              </select>
            </label>
          ) : tenants.length === 1 ? (
            <span className="badge badge-info">Vista acotada a {tenants[0]}</span>
          ) : null}

          {activity.error ? (
            <span className="notice error">
              Última lectura falló: {activity.error.message}. Se muestra el snapshot anterior.
            </span>
          ) : null}
        </div>

        <FleetVerdict
          verdict={verdict}
          totals={snapshot?.totals}
          onCulprit={(culprit) => enfocarCulpable(culprit.key)}
        />

        {/* La cinta de triage: los siete chips ordenados por urgencia de izquierda a derecha, más
            un octavo que sólo existe cuando hay a quién contar. */}
        <div className="live-tally">
          {TALLY_ORDER.map((state) => {
            const meta = LIVE_STATE_META[state];
            return (
              <Tooltip key={state} label={meta.hint} focusable={false}>
                <button
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
              </Tooltip>
            );
          })}
          {sinReportar > 0 ? (
            <Tooltip
              focusable={false}
              label="La topología los declara y la actividad no dice nada de ellos: UNKNOWN. No se asume que estén sanos, y tampoco se los acusa de estar caídos."
            >
              <span className="live-tally-chip is-unreported">
                <span className="live-tally-swatch" aria-hidden="true" />
                Sin reportar <strong>{sinReportar}</strong>
              </span>
            </Tooltip>
          ) : null}
        </div>

        <Panel
          title="Quién le habla a quién, ahora"
          subtitle="Los mismos muñecos, en su sala. En «Ahora» cada flecha es una entrega en vuelo real; en «Permisos», quién tiene derecho a hablarle a quién. Nunca las dos capas a la vez: no significan lo mismo."
        >
          <div className="live-layer-switch" role="group" aria-label="Capa del mapa">
            {(['ahora', 'permisos'] as const).map((option) => (
              <button
                key={option}
                type="button"
                className="live-layer-button"
                aria-pressed={layer === option}
                onClick={() => setLayer(option)}
              >
                {option === 'ahora' ? 'Ahora' : 'Permisos'}
              </button>
            ))}
          </div>

          {/* Estado vacío, diseñado PRIMERO: el estado normal medido de esta flota es una entrega
              en vuelo y cero en cola. Si la pantalla sólo se ve bien cuando hay incendio, se ve mal
              casi siempre. */}
          {layer === 'ahora' && edges.length === 0 && views.length > 0 ? (
            <p className="live-empty-calm">
              <strong>La flota está libre.</strong> Nadie tiene trabajo entre manos ahora mismo — eso
              no es una avería.
              {typeof snapshot?.totals?.in_flight === 'number'
                ? ` Hay ${snapshot.totals.in_flight} en vuelo y ${snapshot.totals.queued ?? 0} esperando turno.`
                : null}
            </p>
          ) : null}

          <LiveHypergraph
            topology={topology.data}
            views={views}
            edges={edges}
            serverEdges={snapshot?.edges}
            thresholds={snapshot?.thresholds}
            origins={origins}
            layer={layer}
            focusKey={hovered ?? selected ?? null}
            spotlight={spotlight}
            loadingTopology={topology.loading && !topology.data}
            onFocus={(key) => setHovered(key ?? undefined)}
            onOpen={(view) => abrirCajon(view.key)}
            onHover={(key, anchor, view, alias) => {
              setTip(key && anchor ? { anchor, view, alias } : null);
            }}
          />
        </Panel>

        <FleetActivityTable
          snapshot={snapshot}
          selectedKey={selected ?? null}
          onlyKeys={spotlight}
          filterLabel={stateFilter ? LIVE_STATE_META[stateFilter].label : undefined}
          onSelect={(key) => setHovered(key ?? undefined)}
          onOpen={(key) => abrirCajon(key)}
        />

        {/* Lo explicativo se pliega. Es información que hace falta la primera vez y estorba las
            cien siguientes; dejarla siempre abierta era parte de por qué la vista se sentía larga. */}
        <details className="live-fold">
          <summary>Señales activas y cómo leer los números</summary>
          <FleetSignals snapshot={snapshot} />
          <ActivityExplainers thresholds={snapshot?.thresholds} />
        </details>

        <details className="live-fold">
          <summary>Permisos y salas</summary>
          {/* Comparten el `useResource('live-topology')` que el mapa ya pidió: cero fetch nuevo.
              Esto era la ruta "Tenants & ACL" entera. */}
          <TenantCards tenants={topology.data?.tenants ?? []} />
          <AclEdgeList edges={topology.data?.acl_edges ?? []} />
        </details>

        <Panel title="Cómo se lee un muñeco" subtitle="Primero la distinción que más se confunde, y después los siete estados.">
          <p className="live-legend-lead">
            <strong>Libre</strong> no es <strong>caído</strong> ni es <strong>sin reportar</strong>.
            Libre es un agente conectado y sin trabajo, que es el estado normal de casi toda la
            flota casi todo el tiempo. Caído es que el lease venció. Sin reportar es que la
            topología lo declara y la actividad no dice nada de él — no se asume que esté sano, y
            tampoco se lo acusa de estar roto.
          </p>
          <div className="live-legend">
            {LIVE_STATES.map((state) => (
              <div className="live-legend-item" key={state}>
                <span className="live-legend-swatch" style={{ ['--accent' as string]: STATE_ACCENT[state] }} aria-hidden="true" />
                <div>
                  <strong>{LIVE_STATE_META[state].label}</strong>
                  <span>{LIVE_STATE_META[state].hint}</span>
                </div>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      {drawer && detail ? (
        <AgentDrawer
          view={detail}
          tab={drawer.tab}
          traceId={drawer.trace}
          onTab={(tab) => { setDrawer((current) => (current ? { ...current, tab } : current)); escribirQuery(drawer.key, tab, drawer.trace); }}
          onTrace={(trace) => { setDrawer((current) => (current ? { ...current, trace } : current)); escribirQuery(drawer.key, drawer.tab, trace); }}
          onClose={cerrarCajon}
        />
      ) : null}

      {/* UN solo globo para los quince muñecos, montado en `document.body`: dentro del `<svg>` lo
          recortaría el `overflow` del contenedor con scroll justo en los nodos del borde. */}
      <FloatingTooltip anchor={tip?.anchor ?? null} open={tip !== null}>
        {tip ? <AgentTooltipCard view={tip.view} alias={tip.alias} /> : null}
      </FloatingTooltip>
    </div>
  );
}

/**
 * El enlace profundo va con `replaceState`, NUNCA con `pushState`.
 *
 * Este cajón se abre y se cierra decenas de veces en una sesión de triage. Con `pushState`, el
 * botón "atrás" del navegador dejaría de servir para volver a la pantalla anterior y pasaría a
 * recorrer, uno por uno, cada agente que se miró de pasada.
 */
function escribirQuery(key?: string, tab?: DrawerTab, trace?: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!key) {
    url.searchParams.delete('agente');
    url.searchParams.delete('pestana');
    url.searchParams.delete('trace');
  } else {
    url.searchParams.set('agente', key);
    url.searchParams.set('pestana', tab ?? 'ahora');
    if (trace) url.searchParams.set('trace', trace);
    else url.searchParams.delete('trace');
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
}

function leerQuery(): { key: string; tab: DrawerTab; trace?: string } | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get('agente');
  if (!key) return null;
  const tab = params.get('pestana');
  const valida: DrawerTab[] = ['ahora', 'conexion', 'entregas', 'cadena'];
  return {
    key,
    tab: valida.includes(tab as DrawerTab) ? tab as DrawerTab : 'ahora',
    trace: params.get('trace') ?? undefined,
  };
}

/** `CSS.escape` no existe en jsdom; el alias puede traer puntos y barras. */
function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export type { FleetActivitySnapshot };

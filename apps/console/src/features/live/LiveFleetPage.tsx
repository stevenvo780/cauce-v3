import { Pause, Play, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { FleetActivitySnapshot, TenantNode, TopologySnapshot } from '../../api/types';
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
 * el estado de un agente (`down` gana a todo) y no una jerarquía de atención. Ahí `settled` va
 * antes que `receiving` porque es un pulso transitorio que tiene que ganarle al estado estable;
 * acá va casi al final, porque "una entrega dejó de estar en vuelo" no pide nada por sí solo.
 */
const TALLY_ORDER: readonly LiveState[] = [
  'down', 'blocked', 'delegating', 'receiving', 'thinking', 'settled', 'idle',
];

const STATE_ACCENT: Record<LiveState, string> = {
  down: 'var(--red)',
  blocked: 'var(--amber)',
  delegating: 'var(--violet)',
  // Gris, no verde. El chip cuenta entregas que salieron de vuelo con desenlace desconocido; con
  // el --lime de antes, la fila anunciaba como buena noticia lo que también cubre a las que se
  // murieron por deadline.
  settled: 'var(--muted)',
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

/**
 * Id de la sala sintética donde van los alias del registro que no tienen ninguna membresía.
 *
 * Lleva `__` a los dos lados a propósito: `rooms.id` en la base es un identificador tipo
 * `grp.miguel` y ninguno puede colisionar con esto, así que un recuadro «sin sala» nunca se
 * confunde con una sala real ni la pisa en el layout.
 */
const SIN_SALA = '__sin_sala__';

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

  /**
   * Los roles a medio redactar, POR ALIAS (`tenant/alias`), fuera del cajón.
   *
   * La pestaña «Rol» se desmonta al cambiar de pestaña y al cerrar el cajón —los dos gestos que
   * un operador hace justamente mientras redacta, para ir a mirar qué está haciendo el bot—, así
   * que el borrador no puede vivir dentro de ella: se perdía entero y sin aviso. Indexado por
   * alias porque el texto es de un bot concreto: pasar a otro agente tiene que empezar en blanco,
   * nunca heredar el rol que se estaba escribiendo para el anterior.
   */
  const [borradoresRol, setBorradoresRol] = useState<Record<string, string>>({});

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
   * El acotamiento por cliente llega hasta el DIBUJO, no sólo hasta el veredicto.
   *
   * Antes el mapa recibía `views` entera y la topología entera: con «Cliente = Miguel» seguían
   * dibujados los muñecos de los otros cuatro clientes, con su globo completo y con clic que abría
   * el cajón con sus entregas. El único rastro del filtro era el atenuado, que además se apagaba
   * en cuanto el puntero rozaba cualquier nodo. La cabecera decía «los 3 alias que podés ver»
   * mientras en el mismo pantallazo había quince muñecos: la frase contradecía al dibujo.
   *
   * Se filtra la TOPOLOGÍA y no sólo las vistas porque el mapa coloca los nodos desde la topología:
   * pasarle sólo las vistas acotadas dejaría a los alias ajenos dibujados como «sin reportar», que
   * es otra mentira —sí se sabe cómo están, sólo que no se están mirando—.
   */
  const topologiaEnAlcance = useMemo(() => {
    const completa = topology.data;
    if (!completa || tenantFilter === 'todos') return completa;
    return {
      ...completa,
      tenants: (completa.tenants ?? []).filter((tenant) => tenant.id === tenantFilter),
      acl_edges: (completa.acl_edges ?? []).filter(
        (edge) => edge.from_tenant === tenantFilter || edge.to_tenant === tenantFilter,
      ),
    };
  }, [topology.data, tenantFilter]);

  /**
   * EL DIBUJO SALE DEL REGISTRO DE AGENTES, NO DE LAS MEMBRESÍAS.
   *
   * Este `useMemo` es la corrección de un defecto arquitectónico, no un ajuste de presentación, y
   * conviene dejar escrito el fallo entero porque desde la pantalla era imposible de adivinar.
   *
   * Esta página hace DOS lecturas y hasta ahora nadie las reconciliaba:
   *
   *   - `GET /v3/console/topology`  → decide QUIÉN se dibuja y en qué sala. Sale de `memberships`.
   *   - `GET /v3/console/activity`  → decide CÓMO está cada uno. Su universo es
   *     `agents ∪ entregas-abiertas ∪ connection_leases`.
   *
   * El "join" ocurría en el navegador (`LiveHypergraph` colocaba un muñeco por cada MIEMBRO y le
   * pintaba encima `view?.state ?? 'unknown'`) y era ASIMÉTRICO en las dos direcciones:
   *
   *   - membresía SIN actividad  → muñeco dibujado y pintado «sin reportar». Así se veía
   *     `quota-collector`, que es un principal `operator` y no un agente: no está en `agents` y
   *     nunca lo estuvo, pero tenía membresía y por eso salía en el mapa de la flota.
   *   - actividad SIN membresía  → el muñeco NO se dibujaba. Caía en `sinSala`, que era una lista
   *     de nombres al pie. Así desapareció `gaia`: se dio de alta en `agents` y no se veía en
   *     ninguna parte, mientras el operador miraba fijo la pantalla que debía mostrarla.
   *
   * Y el mismo defecto explicaba el tercer síntoma: los cuatro alias retirados seguían dibujados
   * porque su baja se hizo en `agents` y sus membresías quedaron habilitadas. Tres fuentes de
   * verdad para "quién es la flota", y la que mandaba en el dibujo era la que nadie tocaba.
   *
   * La regla, ahora, es una sola y se puede decir en una frase: **se dibuja un muñeco por cada
   * participante que reporta actividad —cuyo núcleo es la tabla `agents`— y la membresía sólo
   * decide DENTRO DE QUÉ RECUADRO va**. Consecuencias, todas deliberadas:
   *
   *   - un alias del registro sin ninguna membresía se dibuja igual, en un recuadro «sin sala».
   *     No se esconde: "registrado y sin sala" es un dato operativo, y esconderlo fue el fallo;
   *   - una membresía sin participante deja de existir para el mapa. No se puede pintar el estado
   *     de algo que el plano de estado no conoce, y «sin reportar» era una respuesta inventada;
   *   - dar de baja un alias vuelve a tener UN solo gesto que importa para esta vista: sacarlo del
   *     registro de agentes. Lo que quede en `memberships` ya no puede resucitarlo en el dibujo.
   *
   * El recuadro sale de `view.rooms` cuando el servidor lo informa (ver el LATERAL de
   * `FLEET_ACTIVITY_QUERY`); si ese campo no viene —gateway anterior—, se invierte el índice de
   * la topología (`alias → sala`), que es la MISMA información leída al revés. Los dos caminos dan
   * el mismo dibujo, así que la consola puede desplegarse sola, sin tocar el gateway.
   */
  const topologiaDelMapa = useMemo<TopologySnapshot | undefined>(() => {
    const base = topologiaEnAlcance;
    if (!base) return base;

    // alias → sala, invirtiendo la topología. Es el respaldo para cuando `view.rooms` no viene.
    const salaDeclarada = new Map<string, string>();
    for (const tenant of base.tenants ?? []) {
      for (const room of tenant.rooms ?? []) {
        for (const member of room.members ?? []) {
          if (!member.alias || !room.id || !tenant.id) continue;
          const key = `${tenant.id}/${member.alias}`;
          if (!salaDeclarada.has(key)) salaDeclarada.set(key, room.id);
        }
      }
    }

    const salasPorTenant = new Map<string, Map<string, string[]>>();
    const etiquetaSala = new Map<string, string | null>();
    for (const tenant of base.tenants ?? []) {
      for (const room of tenant.rooms ?? []) {
        if (room.id) etiquetaSala.set(`${tenant.id}/${room.id}`, room.label ?? room.id);
      }
    }

    for (const view of alcance) {
      const declaradas = view.rooms ?? [];
      const sala = declaradas[0] ?? salaDeclarada.get(view.key) ?? SIN_SALA;
      const porSala = salasPorTenant.get(view.tenantId) ?? new Map<string, string[]>();
      const miembros = porSala.get(sala) ?? [];
      miembros.push(view.alias);
      porSala.set(sala, miembros);
      salasPorTenant.set(view.tenantId, porSala);
    }

    const etiquetaTenant = new Map<string, string | null>(
      (base.tenants ?? []).map((tenant) => [tenant.id ?? '', tenant.label ?? tenant.id ?? null]),
    );

    const tenants: TenantNode[] = [...salasPorTenant.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tenantId, porSala]) => ({
        id: tenantId,
        label: etiquetaTenant.get(tenantId) ?? tenantId,
        rooms: [...porSala.entries()]
          // Las salas declaradas primero y en orden estable: el layout es determinista y no
          // queremos que el dibujo salte de sitio porque cambió el orden de llegada de un alias.
          .sort(([left], [right]) => Number(left === SIN_SALA) - Number(right === SIN_SALA)
            || left.localeCompare(right))
          .map(([roomId, miembros]) => ({
            id: roomId,
            label: roomId === SIN_SALA
              ? 'sin sala'
              : etiquetaSala.get(`${tenantId}/${roomId}`) ?? roomId,
            // `enabled: true` NO es una afirmación sobre la membresía: es el campo que el layout
            // usa para atenuar, y acá el muñeco ya trae su propio estado desde la actividad. La
            // decisión de registro (`agent_enabled`) la pinta `liveState()`, no esto.
            members: [...miembros].sort().map((alias) => ({ alias, enabled: true })),
          })),
      }));

    return { ...base, tenants };
  }, [topologiaEnAlcance, alcance]);

  // Las flechas también se acotan: una delegación cuyo emisor o receptor está fuera del alcance no
  // se puede dibujar sin sacar del cajón al muñeco que se acaba de esconder.
  const edgesEnAlcance = useMemo(() => {
    if (tenantFilter === 'todos') return edges;
    const dentro = new Set(alcance.map((view) => view.key));
    return edges.filter((edge) => dentro.has(edge.from) && dentro.has(edge.to));
  }, [edges, alcance, tenantFilter]);

  // Cuántos alias quedan FUERA del recorte. Se declara en pantalla: un mapa que esconde sin
  // decirlo miente por omisión, y desde el dibujo no hay forma de notarlo.
  const fueraDeAlcance = views.length - alcance.length;

  // La cinta cuenta lo mismo que el veredicto y que el mapa. Contando `views` enteras, con un
  // cliente elegido, los chips seguían sumando agentes que la página decía no estar mostrando.
  const tally = useMemo(() => stateTally(alcance), [alcance]);

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

  /**
   * Membresías que el registro de agentes NO conoce. Ya no son muñecos: son DERIVA.
   *
   * Antes esto contaba «los que el mapa dibuja y la actividad no reporta», porque el mapa se
   * dibujaba desde las membresías. Ahora el mapa se dibuja desde el registro, así que esta cuenta
   * cambió de significado sin cambiar de fórmula: es la diferencia simétrica entre `memberships` y
   * `agents`, es decir la medida exacta del defecto que hizo falta arreglar. Se deja en pantalla
   * a propósito — si vuelve a subir, alguien dio de alta o de baja tocando una sola de las dos
   * tablas, y este número lo dice el mismo día y no dentro de un mes.
   */
  const sinReportar = useMemo(() => {
    const conActividad = new Set(views.map((view) => view.key));
    let total = 0;
    for (const tenant of topologiaEnAlcance?.tenants ?? []) {
      const vistos = new Set<string>();
      for (const room of tenant.rooms ?? []) {
        for (const member of room.members ?? []) {
          if (!member.alias || !tenant.id) continue;
          // Sólo las membresías HABILITADAS. Una deshabilitada es una baja que alguien dio a
          // propósito y que la base conserva porque el historial de mensajes la referencia; no
          // es deriva, y contarla convertiría cada retiro correcto en una alarma permanente.
          if (member.enabled === false) continue;
          const key = `${tenant.id}/${member.alias}`;
          if (vistos.has(key) || conActividad.has(key)) continue;
          vistos.add(key);
          total += 1;
        }
      }
    }
    return total;
  }, [views, topologiaEnAlcance]);

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

  /**
   * «Refrescar ahora» vuelve a leer las DOS fuentes.
   *
   * La topología está fuera del polling porque cambia cuando alguien toca la configuración, no
   * cada cuatro segundos — pero eso dejaba un fallo sin salida: si `GET /v3/console/topology`
   * fallaba al montar, no había un solo control en la página capaz de reintentarlo. El botón
   * llamaba únicamente a `activity.reload`, y las dos vistas que sí exponían ese fallo (Fleet y
   * Tenants & ACL) se borraron en este mismo cambio. La única recuperación era recargar el
   * navegador, sin un mensaje que lo sugiriera.
   */
  const { reload: recargarTopologia } = topology;
  const refrescarTodo = useCallback(() => {
    reload();
    recargarTopologia();
  }, [reload, recargarTopologia]);

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
          // La cabecera tiene que describir lo que HAY EN PANTALLA. Con un cliente elegido decía
          // «los N alias que podés ver» contando sólo los suyos mientras el mapa dibujaba los de
          // todos: la frase y el dibujo se contradecían en el mismo pantallazo.
          description={tenantFilter === 'todos'
            ? `Los ${alcance.length} alias que podés ver, qué tienen entre manos y quién se lo pidió.`
            : `Los ${alcance.length} alias de ${tenantFilter}, qué tienen entre manos y quién se lo pidió.`
              + ' Todo lo de abajo —veredicto, cinta, mapa y lista— está acotado a este cliente.'}
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

          <button type="button" className="button secondary" onClick={refrescarTodo}>
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

          {/* El fallo de la topología tiene que VERSE y tiene que poder reintentarse desde acá.
              Sin este aviso, un `GET /v3/console/topology` caído dejaba la página con el mapa
              vacío, «Permisos y salas» vacío, el selector de Cliente desaparecido y «Sin
              reportar» en cero, todo con la misma cara que tiene una flota sin salas declaradas. */}
          {topology.error ? (
            <span className="notice error">
              No se pudo leer la topología: {topology.error.message}. Sin ella no hay salas, ni
              mapa, ni selector de cliente, ni «sin reportar» — no es que no existan.
              <button type="button" className="button small secondary" onClick={recargarTopologia}>
                Reintentar la topología
              </button>
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
              label="Alias con membresía en una sala que NO están en el registro de agentes. No se dibujan en el mapa —no se puede pintar el estado de algo que el plano de estado no conoce— y no son una avería por sí solos: los principales de operador (por ejemplo el recolector de cuotas) viven así a propósito. Si este número sube tras un alta o una baja, es que se tocó una sola de las dos tablas."
            >
              <span className="live-tally-chip is-unreported">
                <span className="live-tally-swatch" aria-hidden="true" />
                Fuera del registro <strong>{sinReportar}</strong>
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

          {/* El recorte se DECLARA. Esconder muñecos sin decirlo convierte un mapa acotado en un
              mapa incompleto, y desde el dibujo las dos cosas se ven idénticas. En la capa de
              permisos hay además una omisión propia que hay que nombrar: los cruces ACL hacia los
              otros clientes salen del dibujo junto con ellos. */}
          {fueraDeAlcance > 0 ? (
            <p className="notice" data-testid="aviso-recorte">
              Mapa acotado a <strong>{tenantFilter}</strong>: {fueraDeAlcance} alias de otros
              clientes, sus salas y las flechas que los tocan no se dibujan.
              {layer === 'permisos' ? ' Tampoco se ven las aristas ACL hacia ellos.' : ''}
              {' '}Elegí «todos» en Cliente para verlos.
            </p>
          ) : null}

          {/* Estado vacío, diseñado PRIMERO: el estado normal medido de esta flota es una entrega
              en vuelo y cero en cola. Si la pantalla sólo se ve bien cuando hay incendio, se ve mal
              casi siempre. Se mide sobre el ALCANCE, no sobre la flota entera: con un cliente
              elegido, "la flota está libre" tenía que hablar de lo que se está mirando. */}
          {layer === 'ahora' && edgesEnAlcance.length === 0 && alcance.length > 0 ? (
            <p className="live-empty-calm">
              <strong>{tenantFilter === 'todos' ? 'La flota está libre.' : `Nadie de ${tenantFilter} tiene trabajo entre manos.`}</strong>
              {' '}Nadie tiene trabajo entre manos ahora mismo — eso no es una avería.
              {tenantFilter === 'todos' && typeof snapshot?.totals?.in_flight === 'number'
                ? ` Hay ${snapshot.totals.in_flight} en vuelo y ${snapshot.totals.queued ?? 0} esperando turno.`
                : null}
            </p>
          ) : null}

          <LiveHypergraph
            topology={topologiaDelMapa}
            views={alcance}
            edges={edgesEnAlcance}
            serverEdges={snapshot?.edges}
            thresholds={snapshot?.thresholds}
            origins={origins}
            layer={layer}
            focusKey={hovered ?? selected ?? null}
            spotlight={spotlight}
            loadingTopology={topology.loading && !topology.data}
            topologyError={topology.error ?? null}
            onRetryTopology={recargarTopologia}
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
              Esto era la ruta "Tenants & ACL" entera. Va sobre la topología ACOTADA, igual que el
              mapa: si el selector de Cliente no acotara también esto, el desplegable seguiría
              contando salas y permisos que la cabecera dice no estar mostrando. */}
          <TenantCards tenants={topologiaEnAlcance?.tenants ?? []} />
          <AclEdgeList edges={topologiaEnAlcance?.acl_edges ?? []} />
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
          borradorRol={borradoresRol[drawer.key]}
          onBorradorRol={(texto) => setBorradoresRol((actuales) => {
            // Descartar el borrador borra la entrada en vez de dejarla vacía: una cadena vacía
            // guardada significaría «quiero dejar a este alias sin rol», que no es lo mismo.
            if (texto === undefined) {
              const resto = { ...actuales };
              delete resto[drawer.key];
              return resto;
            }
            return { ...actuales, [drawer.key]: texto };
          })}
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
  const valida: DrawerTab[] = ['ahora', 'conexion', 'entregas', 'cadena', 'rol'];
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

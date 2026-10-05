import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { useResource } from '../../api/use-resource';
import type {
  FleetActivitySnapshot, TenantNode, TopologySnapshot,
} from '../../api/types';
import {
  ErrorState, FloatingTooltip, LoadingState, PageHeader,
} from '../../components/ui';
import { FleetActivityTable } from './FleetActivityTable';
import { AgentDrawer, type ContextFocusTarget, type DrawerTab } from './AgentDrawer';
import { AgentTooltipCard } from './AgentTooltipCard';
import { FleetVerdict } from './FleetVerdict';
import {
  BURST_MS,
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
import { derivaDelRegistro } from './deriva';
import { projectLiveFleet } from './live-projection';
import { LiveHypergraph, type HypergraphLayer } from './LiveHypergraph';
import { LiveFleetToolbar } from './LiveFleetToolbar';
import { LiveFleetTally } from './LiveFleetTally';
import { LiveFleetLegend } from './LiveFleetLegend';
import './live.css';
import './live-hypergraph.css';

/**
 * How many refresh intervals may pass before the data stops attesting anything.
 */
const STALE_FACTOR = 3;

/**
 * Identifier of the synthetic room where record aliases without any membership go.
 */
const SIN_SALA = '__sin_sala__';

interface TooltipTarget {
  anchor: DOMRect;
  view: LiveAgentView | null;
  alias: string;
}

export function LiveFleetPage() {
  const api = useApi();
  const activity = useResource('live-fleet-activity', () => api.getFleetActivity());
  const topology = useResource('live-topology', () => api.getTopology());
  const configuracion = useResource('live-configuracion', () => api.getConfiguration());
  const [intervalMs, setIntervalMs] = useState(4000);
  const [selected, setSelected] = useState<string>();
  const [hovered, setHovered] = useState<string>();
  const [stateFilter, setStateFilter] = useState<LiveState>();
  const [query, setQuery] = useState('');
  const [requestedTenantFilter, setTenantFilter] = useState('todos');
  const [layer, setLayer] = useState<HypergraphLayer>('ahora');
  const [tip, setTip] = useState<TooltipTarget | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const { snapshot, topology: liveTopology } = useMemo(
    () => projectLiveFleet(activity.data, topology.data), [activity.data, topology.data],
  );

  const [drawer, setDrawer] = useState<{
    key: string; tab: DrawerTab; contextFocusTarget?: ContextFocusTarget;
  } | null>(
    () => leerQuery(),
  );

  useEffect(() => {
    if (!drawer || typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('agente') === drawer.key && params.get('pestana') === 'perfil') {
      escribirQuery(drawer.key, 'rol');
    }
  }, [drawer]);

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
  }, [snapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, []);

  const { reload } = activity;
  usePolling(reload, intervalMs);

  const { views, edges } = useMemo(
    () => {
      const original = buildLiveViews(activity.data, pulses, now);
      const visible = new Set((snapshot?.agents ?? []).map((agent) => `${agent.tenant_id}/${agent.alias}`));
      return {
        views: original.views.filter((view) => visible.has(view.key)),
        edges: original.edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)),
      };
    },
    [activity.data, snapshot, pulses, now],
  );
  const origins = useMemo(() => {
    const visible = new Set(views.map((view) => view.key));
    return humanOrigins(activity.data).filter((origin) => visible.has(origin.agentKey));
  }, [activity.data, views]);

  const tenants = useMemo(() => {
    const vistos = new Set<string>();
    for (const view of views) vistos.add(view.tenantId);
    for (const tenant of topology.data?.tenants ?? []) if (tenant.id) vistos.add(tenant.id);
    return [...vistos].sort();
  }, [views, topology.data]);

  const tenantFilter = tenants.includes(requestedTenantFilter) ? requestedTenantFilter : 'todos';

  const alcance = useMemo(
    () => (tenantFilter === 'todos' ? views : views.filter((view) => view.tenantId === tenantFilter)),
    [views, tenantFilter],
  );

  const topologiaEnAlcance = useMemo(() => {
    const completa = liveTopology;
    if (!completa || tenantFilter === 'todos') return completa;
    return {
      ...completa,
      tenants: (completa.tenants ?? []).filter((tenant) => tenant.id === tenantFilter),
      acl_edges: (completa.acl_edges ?? []).filter(
        (edge) => edge.from_tenant === tenantFilter || edge.to_tenant === tenantFilter,
      ),
    };
  }, [liveTopology, tenantFilter]);

  const topologiaDelMapa = useMemo<TopologySnapshot | undefined>(() => {
    const base = topologiaEnAlcance;
    if (!base) return base;

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
      if (!tenant.id) continue;
      for (const room of tenant.rooms ?? []) {
        if (room.id) etiquetaSala.set(`${tenant.id}/${room.id}`, room.label ?? room.id);
      }
    }

    for (const view of alcance) {
      const declaradas = view.rooms;
      const primeraDeclarada = declaradas.length > 0 ? declaradas[0] : undefined;
      const sala = primeraDeclarada ?? salaDeclarada.get(view.key) ?? SIN_SALA;
      const porSala = salasPorTenant.get(view.tenantId) ?? new Map<string, string[]>();
      const miembros = porSala.get(sala) ?? [];
      miembros.push(view.alias);
      porSala.set(sala, miembros);
      salasPorTenant.set(view.tenantId, porSala);
    }

    const etiquetaTenant = new Map<string, string | null>(
      (base.tenants ?? []).map((tenant) => [tenant.id ?? '', tenant.label ?? tenant.id ?? null]),
    );

    const tenantsNodes: TenantNode[] = [...salasPorTenant.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tenantId, porSala]) => ({
        id: tenantId,
        label: etiquetaTenant.get(tenantId) ?? tenantId,
        rooms: [...porSala.entries()]
          .sort(([left], [right]) => Number(left === SIN_SALA) - Number(right === SIN_SALA)
            || left.localeCompare(right))
          .map(([roomId, miembros]) => ({
            id: roomId,
            label: roomId === SIN_SALA
              ? 'sin sala'
              : etiquetaSala.get(`${tenantId}/${roomId}`) ?? roomId,
            members: [...miembros].sort().map((alias) => ({ alias, enabled: true })),
          })),
      }));

    return { ...base, tenants: tenantsNodes };
  }, [topologiaEnAlcance, alcance]);

  const edgesEnAlcance = useMemo(() => {
    if (tenantFilter === 'todos') return edges;
    const dentro = new Set(alcance.map((view) => view.key));
    return edges.filter((edge) => dentro.has(edge.from) && dentro.has(edge.to));
  }, [edges, alcance, tenantFilter]);

  const fueraDeAlcance = views.length - alcance.length;
  const tally = useMemo(() => stateTally(alcance), [alcance]);

  const estadosVivos = useMemo(
    () => new Map(views.map((view) => [view.key, view.state])),
    [views],
  );

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

  const deriva = useMemo(
    () => derivaDelRegistro(alcance, topologiaEnAlcance),
    [alcance, topologiaEnAlcance],
  );

  const resumenDePermisos = useMemo(() => {
    if (topology.error && !topology.data) return 'no se pudo leer';
    const tenantsList = topologiaEnAlcance?.tenants ?? [];
    if (tenantsList.length === 0) return 'sin datos';
    const salas = tenantsList.reduce((total, tenant) => total + (tenant.rooms ?? []).length, 0);
    const permisos = (topologiaEnAlcance?.acl_edges ?? []).length;
    return `${String(tenantsList.length)} ${tenantsList.length === 1 ? 'cliente' : 'clientes'}, `
      + `${String(salas)} ${salas === 1 ? 'sala' : 'salas'}, ${String(permisos)} ${permisos === 1 ? 'permiso' : 'permisos'}`;
  }, [topologiaEnAlcance, topology.data, topology.error]);

  const staleAfterMs = (intervalMs > 0 ? intervalMs : 30000) * STALE_FACTOR;
  const verdict = useMemo(
    () => fleetVerdict(alcance, { error: activity.error, observedAt, nowMs: now, staleAfterMs }),
    [alcance, activity.error, observedAt, now, staleAfterMs],
  );

  const detail = views.find((view) => view.key === drawer?.key);
  const feedState = activity.error ? 'error' : intervalMs <= 0 ? 'paused' : verdict.tone === 'desconocido' ? 'stale' : 'live';
  const edadSegundos = observedAt ? Math.max(0, (now - Date.parse(observedAt)) / 1000) : null;

  const abrirCajon = useCallback((
    key: string, tab: DrawerTab = 'ahora', contextFocusTarget?: ContextFocusTarget,
  ) => {
    setDrawer({ key, tab, ...(contextFocusTarget === undefined ? {} : { contextFocusTarget }) });
    setSelected(key);
    escribirQuery(key, tab);
  }, []);

  const cerrarCajon = useCallback(() => {
    setDrawer(null);
    setSelected(undefined);
    escribirQuery(undefined);
  }, []);

  const { reload: recargarTopologia } = topology;
  const refrescarTodo = useCallback(() => {
    void reload();
    void recargarTopologia();
  }, [reload, recargarTopologia]);

  const [culpablePendiente, setCulpablePendiente] = useState<string | null>(null);
  const activityListRef = useRef<HTMLDetailsElement>(null);

  const enfocarCulpable = useCallback((key: string) => {
    setStateFilter(undefined);
    setQuery('');
    setSelected(key);
    setCulpablePendiente(key);
  }, []);

  useEffect(() => {
    if (culpablePendiente === null) return;
    setCulpablePendiente(null);
    if (activityListRef.current) activityListRef.current.open = true;
    document.querySelector(`tr[data-agent-key="${cssEscape(culpablePendiente)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [culpablePendiente]);

  if (activity.error && !snapshot) {
    return <ErrorState error={activity.error} onRetry={activity.reload} reintentando={activity.loading} />;
  }
  if (activity.loading && !snapshot) return <LoadingState label="Leyendo la actividad de la flota…" />;

  const capas = (
    <div className="live-layer-switch" role="group" aria-label="Capa del mapa">
      {(['ahora', 'permisos'] as const).map((option) => (
        <button
          key={option}
          type="button"
          className="live-layer-button"
          aria-pressed={layer === option}
          onClick={() => { setLayer(option); }}
        >
          {option === 'ahora' ? 'Ahora' : 'Permisos'}
        </button>
      ))}
    </div>
  );
  const veredictoFlota = (
    <FleetVerdict
      verdict={verdict}
      totals={snapshot?.totals}
      onCulprit={(culprit) => { enfocarCulpable(culprit.key); }}
    />
  );
  const resumenTriage = (
    <LiveFleetTally
      tally={tally}
      stateFilter={stateFilter}
      setStateFilter={setStateFilter}
      deriva={deriva}
    />
  );
  const mapa = (
    <section className="panel live-mapa" aria-label="Mapa de la flota" data-objeto-principal="mapa-de-flota">
      <header className="live-mapa-header">
        <h2 className="live-mapa-titulo">Actividad</h2>
        {capas}
      </header>

      {fueraDeAlcance > 0 ? (
        <p className="notice" data-testid="aviso-recorte">
          Mapa acotado a <strong>{tenantFilter}</strong>: {fueraDeAlcance} alias de otros
          clientes, sus salas y las flechas que los tocan no se dibujan.
          {layer === 'permisos' ? ' Tampoco se ven las aristas ACL hacia ellos.' : ''}
          {' '}Elegí «todos» en Cliente para verlos.
        </p>
      ) : null}

      {layer === 'ahora' && edgesEnAlcance.length === 0 && alcance.length > 0 ? (
        <p className="live-empty-calm">No hay delegaciones entre agentes en este momento.</p>
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
        onFocus={(key) => { setHovered(key ?? undefined); }}
        onOpen={(view) => { abrirCajon(view.key); }}
        onHover={(key, anchor, view, alias) => {
          setTip(key && anchor ? { anchor, view, alias } : null);
        }}
      />
    </section>
  );
  const tablaActividad = (
    <FleetActivityTable
      snapshot={snapshot}
      selectedKey={selected ?? null}
      onlyKeys={spotlight}
      filterLabel={stateFilter ? LIVE_STATE_META[stateFilter].label : undefined}
      estados={estadosVivos}
      onSelect={(key) => { setHovered(key ?? undefined); }}
      onOpen={(key) => { abrirCajon(key); }}
    />
  );

  return (
    <div className={`live-page${drawer && detail ? ' has-drawer' : ''}`
      + (drawer && detail && (drawer.tab === 'rol' || drawer.tab === 'ficheros') ? ' cajon-ancho' : '')}>
      <div className="live-main">
        <div className="live-heading">
          <PageHeader eyebrow="" title="La flota ahora" description={tenantFilter === 'todos'
            ? `Los ${String(alcance.length)} alias que podés ver, su actividad y permisos.`
            : `Los ${String(alcance.length)} alias de ${tenantFilter}, su actividad y permisos.`} />
          {veredictoFlota}
        </div>
        <LiveFleetToolbar
          feedState={feedState}
          intervalMs={intervalMs}
          setIntervalMs={setIntervalMs}
          refrescarTodo={refrescarTodo}
          observedAt={observedAt}
          edadSegundos={edadSegundos}
          query={query}
          setQuery={setQuery}
          tenants={tenants}
          tenantFilter={tenantFilter}
          setTenantFilter={setTenantFilter}
          activityError={activity.error}
          topologyError={topology.error}
          recargarTopologia={recargarTopologia}
        />
        {mapa}
        <div className="live-filter-controls">
          <details className="live-state-filters">
            <summary>Filtrar por estado</summary>
            {resumenTriage}
          </details>
          {stateFilter ? (
            <button type="button" className="button small secondary" onClick={() => { setStateFilter(undefined); }}>
              {LIVE_STATE_META[stateFilter].label} · Quitar filtro
            </button>
          ) : null}
        </div>
        <LiveFleetLegend
          snapshot={snapshot}
          topologiaEnAlcance={topologiaEnAlcance}
          resumenDePermisos={resumenDePermisos}
          configuracion={configuracion}
          onAbrirPerfil={(key) => { abrirCajon(key, 'rol', 'campos'); }}
        />
        <details className="live-fold live-agent-list" ref={activityListRef}>
          <summary>Agentes · {String(alcance.length)}</summary>
          {tablaActividad}
        </details>
      </div>

      {drawer && detail ? (
        <AgentDrawer
          view={detail}
          tab={drawer.tab}
          configuracion={configuracion}
          contextFocusTarget={drawer.contextFocusTarget}
          onTab={(tab, contextFocusTarget) => {
            setDrawer((current) => (current
              ? { key: current.key, tab, ...(contextFocusTarget === undefined ? {} : { contextFocusTarget }) }
              : current));
            escribirQuery(drawer.key, tab);
          }}
          onClose={cerrarCajon}
        />
      ) : null}

      <FloatingTooltip anchor={tip?.anchor ?? null} open={tip !== null}>
        {tip ? <AgentTooltipCard view={tip.view} alias={tip.alias} /> : null}
      </FloatingTooltip>
    </div>
  );
}

function escribirQuery(key?: string, tab?: DrawerTab): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  if (!key) {
    url.searchParams.delete('agente');
    url.searchParams.delete('pestana');
    url.searchParams.delete('trace');
  } else {
    url.searchParams.set('agente', key);
    url.searchParams.set('pestana', tab ?? 'ahora');
    url.searchParams.delete('trace');
  }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
}

function leerQuery(): {
  key: string; tab: DrawerTab; contextFocusTarget?: ContextFocusTarget;
} | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const key = params.get('agente');
  if (!key) return null;
  const tab = params.get('pestana');
  if (tab === 'perfil') return { key, tab: 'rol', contextFocusTarget: 'campos' };
  const valida: DrawerTab[] = ['ahora', 'conexion', 'entregas', 'rol', 'ficheros'];
  return {
    key,
    tab: valida.includes(tab as DrawerTab) ? tab as DrawerTab : 'ahora',
  };
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

export type { FleetActivitySnapshot };

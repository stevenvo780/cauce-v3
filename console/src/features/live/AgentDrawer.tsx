import { ExternalLink, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useApi } from '../../api/context';
import { useResource, type Resource } from '../../api/use-resource';
import type {
  AgentDocumentKind, AgentPerfilCampos, ConfigurationSnapshot, FleetActivityItem,
} from '../../api/types';
import { Badge, EmptyState, Time, Unknown, ViewTabs } from '../../components/ui';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { UNKNOWN, compactId, safeJobLane } from '../../lib';
import { onNavClick } from '../../router';
import { queueDeliveryPath } from '../deliveries/delivery-links';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { AgentAvatar } from './AgentAvatar';
import { ContextoTab } from './ContextoTab';
import { FicherosTab, type BorradorDeFichero } from './FicherosTab';
import { LIVE_STATE_META, humanSeconds, type LiveAgentView, type OrigenEncargo } from './agent-state';

/**
 * The side drawer: diagnose without leaving the current view.
 *
 * This is why "Fleet" and "Tenants & ACL" can disappear from the menu without losing a single
 * data point. Everything that used to force a jump to another route —and with it, losing the
 * filter, the scroll, and the thread— happens here, on top of the same page: the map stays
 * visible and keeps refreshing behind it. That continuity is half of the value; the other half is
 * that there is no longer a choice between "see the fleet" and "see one".
 *
 * What it does NOT have, and that is not an oversight: **no destructive action**. The original
 * proposal put retry and cancel buttons in here. A view that auto-refreshes every four seconds
 * and reorders itself by urgency is the worst possible place for a destructive button: between
 * reading the row and clicking it, the row may have moved. Each delivery instead carries a link
 * to Queues with the delivery already highlighted, where that button lives surrounded by its own
 * confirmation.
 */

export type DrawerTab = 'ahora' | 'conexion' | 'entregas' | 'rol' | 'ficheros';
export type ContextFocusTarget = 'campos' | 'manual';

/**
 * Context editing has one visible home. The tab id stays `rol` because pasted deep links already
 * use it; the retired `perfil` query value is normalized by `LiveFleetPage` to this same tab.
 */
const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: 'ahora', label: 'Ahora' },
  { id: 'conexion', label: 'Conexión' },
  { id: 'entregas', label: 'Entregas' },
  { id: 'rol', label: 'Contexto' },
  { id: 'ficheros', label: 'Ficheros' },
];

interface AgentDrawerProps {
  view: LiveAgentView;
  tab: DrawerTab;
  configuracion: Resource<ConfigurationSnapshot>;
  /** Two editable drafts —profile and files—; the `role_brief` projection is read-only. */
  borradorPerfil?: Partial<AgentPerfilCampos>;
  onBorradorPerfil: (campos: Partial<AgentPerfilCampos> | undefined) => void;
  borradoresFicheros?: Partial<Record<AgentDocumentKind, BorradorDeFichero>>;
  onBorradorFichero: (kind: AgentDocumentKind, borrador: BorradorDeFichero | undefined) => void;
  profileWriteInFlight: boolean;
  onProfileWriteInFlightChange: (inFlight: boolean) => void;
  runtimeRefreshRevision: number;
  onRuntimeRefresh: () => void;
  contextFocusTarget?: ContextFocusTarget;
  onTab: (tab: DrawerTab, contextFocusTarget?: ContextFocusTarget) => void;
  onClose: () => void;
}

export function AgentDrawer({
  view, tab, configuracion, borradorPerfil, onBorradorPerfil,
  borradoresFicheros, onBorradorFichero, profileWriteInFlight,
  onProfileWriteInFlightChange, runtimeRefreshRevision, onRuntimeRefresh,
  contextFocusTarget, onTab, onClose,
}: AgentDrawerProps) {
  const cajon = useRef<HTMLElement>(null);
  const cerrar = useRef<HTMLButtonElement>(null);
  const focoDeVuelta = useRef<HTMLElement | null>(
    typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );

  useEffect(() => {
    const pagina = cajon.current?.closest('.live-page');
    const contenido = pagina?.parentElement?.id === 'main-content' ? pagina.parentElement : null;
    const superficies = new Set<Element>(
      document.querySelectorAll('.skip-link, .sidebar, .topbar, .live-main'),
    );
    if (contenido && pagina) {
      for (const hermano of contenido.children) {
        if (hermano !== pagina) superficies.add(hermano);
      }
    }
    const inertizadas = [...superficies].filter((superficie) => !superficie.hasAttribute('inert'));
    const devolverFocoA = focoDeVuelta.current;
    for (const superficie of inertizadas) superficie.setAttribute('inert', '');
    cerrar.current?.focus();
    return () => {
      for (const superficie of inertizadas) superficie.removeAttribute('inert');
      if (devolverFocoA?.isConnected) devolverFocoA.focus({ preventScroll: true });
    };
  }, []);

  // Esc closes from anywhere. A panel that can only be closed with the little X forces you to hunt
  // for it with the mouse each time, and this drawer is opened and closed many times in a row when triaging.
  useEffect(() => {
    const alPulsar = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', alPulsar);
    return () => { document.removeEventListener('keydown', alPulsar); };
  }, [onClose]);

  const atraparFoco = useFocusTrap(cajon);
  const meta = LIVE_STATE_META[view.state];

  return (
    <aside
      className="agent-drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`Detalle de ${view.alias}`}
      ref={cajon}
      onKeyDown={atraparFoco}
    >
      <header className="agent-drawer-head">
        <div className="agent-drawer-identity">
          <AgentAvatar state={view.state} overloaded={view.overloaded} label={meta.label} />
          <div>
            <h2>{view.alias}</h2>
            <p className="muted">{view.tenantId}{view.displayName ? ` · ${view.displayName}` : ''}</p>
          </div>
        </div>
        <button ref={cerrar} type="button" className="button small secondary" onClick={onClose} aria-label="Cerrar el detalle">
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <ViewTabs
        tabs={DRAWER_TABS}
        active={tab}
        onSelect={onTab}
        label="Secciones del detalle"
        variant="panel"
        panelId="agent-drawer-panel"
      />

      <div
        className="agent-drawer-body"
        id="agent-drawer-panel"
        role="tabpanel"
        aria-labelledby={`view-tab-${tab}`}
      >
        {tab === 'ahora' ? <TabAhora view={view} /> : null}
        {tab === 'conexion' ? <TabConexion view={view} /> : null}
        {tab === 'entregas' ? <TabEntregas view={view} /> : null}
        {/* `key` por alias evita que las lecturas de un bot sobrevivan al cambio de agente. Los
            borradores editables viven fuera, ya indexados por alias. */}
        {tab === 'rol' ? (
          <ContextoTab
            key={view.key}
            tenantId={view.tenantId}
            alias={view.alias}
            configuracion={configuracion}
            borradorPerfil={borradorPerfil}
            onBorradorPerfil={onBorradorPerfil}
            borradoresFicheros={borradoresFicheros}
            onBorradorFichero={onBorradorFichero}
            focusTarget={contextFocusTarget}
            profileWriteInFlight={profileWriteInFlight}
            onProfileWriteInFlightChange={onProfileWriteInFlightChange}
            runtimeRefreshRevision={runtimeRefreshRevision}
            onRuntimeRefresh={onRuntimeRefresh}
          />
        ) : null}
        {tab === 'ficheros' ? (
          <FicherosTab
            key={`${view.key}/${String(runtimeRefreshRevision)}`}
            tenantId={view.tenantId}
            alias={view.alias}
            borradores={borradoresFicheros}
            onBorrador={onBorradorFichero}
            mode="inventory"
            onOpenContext={() => { onTab('rol', 'manual'); }}
          />
        ) : null}
      </div>

      <footer className="agent-drawer-foot">
        <a
          className="button small secondary"
          href={`/terminal/${encodeURIComponent(view.tenantId)}/${encodeURIComponent(view.alias)}`}
          onClick={(event) => { onNavClick(event, `/terminal/${encodeURIComponent(view.tenantId)}/${encodeURIComponent(view.alias)}`); }}
        >
          <ExternalLink size={14} aria-hidden="true" /> Abrir este agente en Terminal
        </a>
      </footer>
    </aside>
  );
}

/** The detail that already existed on the page, moved as is: the site moves, not the content. */
function TabAhora({ view }: { view: LiveAgentView }) {
  const meta = LIVE_STATE_META[view.state];
  return (
    <div className="live-detail">
      <Badge tone={meta.tone === 'danger' ? 'danger' : meta.tone === 'positive' ? 'online' : 'info'}>
        {meta.label}
      </Badge>
      <p className="live-reason">{view.reason}</p>
      <dl>
        <dt>Arnés</dt><dd>{view.harnessId ?? UNKNOWN}</dd>
        <dt>En vuelo / cola</dt><dd>{view.inFlight} / {view.queued}</dd>
        <dt>Más viejo en vuelo</dt>
        <dd>{typeof view.oldestInFlightSeconds === 'number' ? humanSeconds(view.oldestInFlightSeconds) : UNKNOWN}</dd>
        <dt>Último ACK</dt>
        <dd>
          {view.secondsSinceLastAck === null || view.secondsSinceLastAck === undefined
            ? <span className="unknown">sin ACK dentro de la ventana de búsqueda</span>
            : `hace ${humanSeconds(view.secondsSinceLastAck)}`}
        </dd>
        <dt>Delega a</dt>
        <dd>{view.delegatesTo.length > 0 ? view.delegatesTo.join(', ') : <span className="unknown">nadie ahora mismo</span>}</dd>
        <dt>Trabaja para</dt>
        <dd>{view.delegatedFrom.length > 0 ? view.delegatedFrom.join(', ') : <span className="unknown">nadie ahora mismo</span>}</dd>
        <dt>Lease vence</dt><dd><Time value={view.agent.presence?.lease_until} /></dd>
      </dl>
      {view.flags.length > 0 ? (
        <div className="live-flags">{view.flags.map((flag) => <Badge key={flag} tone="warning">{flag}</Badge>)}</div>
      ) : null}
      <p className="muted">
        Un lease vigente no prueba que el agente responda: el estado de arriba sale del trabajo que
        avanza (o no), no del latido.
      </p>
    </div>
  );
}

/**
 * What used to be the whole "Fleet" route, in a single tab.
 *
 * Four of its five exclusive columns —epoch, instance_id, heartbeat, and lease— already came in
 * `activity.agents[].presence`, so absorbing them costs no new fetch. The fifth, `capabilities`,
 * is the only one that needs `/v3/status`, which is why that fetch lives INSIDE this tab: it is
 * only paid when it is opened. A whole menu route for five columns, four of which were already
 * on the table, was the clearest example of "too many views".
 */
function TabConexion({ view }: { view: LiveAgentView }) {
  const api = useApi();
  // Lazy by construction: this component only mounts when the tab is open.
  const status = useResource(`drawer-status-${view.key}`, () => api.getStatus());
  const presence = view.agent.presence;

  const capabilities = status.data?.presence
    ?.find((lease) => lease.tenant_id === view.tenantId && lease.alias === view.alias)
    ?.capabilities ?? null;

  return (
    <div className="live-detail">
      <dl>
        <dt>Epoch</dt><dd><span className="mono"><Unknown value={presence?.epoch} /></span></dd>
        <dt>Instancia</dt><dd><span className="mono"><Unknown value={presence?.instance_id} /></span></dd>
        <dt>Último latido</dt><dd><Time value={presence?.last_heartbeat_at} /></dd>
        <dt>Lease vence</dt><dd><Time value={presence?.lease_until} /></dd>
        <dt>Salas</dt>
        <dd>
          {view.rooms.length > 0
            ? <div className="chip-list">{view.rooms.map((room) => <span className="chip" key={room}>{room}</span>)}</div>
            : <span className="unknown">el servidor no informa las salas en esta lectura</span>}
        </dd>
        <dt>Habilitado</dt><dd><Unknown value={view.agent.agent_enabled} /></dd>
        <dt>En el registro</dt>
        <dd>{view.agent.registered === false
          ? <span className="unknown">no: apareció por entregas o por lease, no por el registro</span>
          : <Unknown value={view.agent.registered} />}</dd>
        <dt>Arnés</dt><dd>{view.harnessId ?? UNKNOWN}</dd>
        <dt>Capacidades</dt>
        <dd>
          {status.loading && !status.data ? <span className="muted">leyendo /v3/status…</span>
            : status.error ? <span className="unknown">no se pudo leer /v3/status: {status.error.message}</span>
              : capabilities?.length
                ? <div className="chip-list">{capabilities.map((cap) => <span className="chip" key={cap}>{cap}</span>)}</div>
                : <span className="unknown">sin dato</span>}
        </dd>
      </dl>
      <p className="muted">
        Todo esto habla de la CONEXIÓN, no del trabajo. Un epoch fresco y un lease vigente son
        perfectamente compatibles con un agente que no contesta: para eso está la pestaña «Ahora».
      </p>
    </div>
  );
}

function TabEntregas({ view }: { view: LiveAgentView }) {
  const items = view.agent.in_flight_items ?? [];
  if (items.length === 0) {
    return <EmptyState>Ninguna entrega en vuelo. No hay nada que este agente tenga tomado ahora mismo.</EmptyState>;
  }
  return (
    <div className="drawer-deliveries">
      {/* `view.origenes` va índice a índice con `in_flight_items`: es la MISMA lectura del origen
          que usa el mapa para decidir si dibuja una flecha, así que la tarjeta y el dibujo no
          pueden contarse historias distintas del mismo encargo. */}
      {items.map((item, index) => (
        <DeliveryCard item={item} key={item.delivery_id ?? index} origen={view.origenes[index]} />
      ))}
      {view.agent.in_flight_items_truncated ? (
        <p className="notice">
          Se muestran las {items.length} más antiguas de {view.inFlight}: el resto comparte el mismo
          diagnóstico y no aporta una fuente nueva.
        </p>
      ) : null}
    </div>
  );
}

function DeliveryCard({ item, origen }: {
  item: FleetActivityItem;
  origen: OrigenEncargo | undefined;
}) {
  const policy = deliveryPolicy(item.status);
  const queuePath = queueDeliveryPath(item.delivery_id);
  return (
    <article className="drawer-delivery">
      <header>
        <span className="mono">{compactId(item.delivery_id)}</span>
        <Badge tone={policy.tone}><Unknown
          value={policy.known ? policy.label : undefined}
          motivo={item.status && !policy.known
            ? `El servidor mandó un estado que esta consola no conoce: ${item.status}`
            : undefined}
        /></Badge>
      </header>
      <dl>
        <dt>Mensaje</dt><dd><span className="mono">{compactId(item.message_id)}</span></dd>
        <dt>Se lo pidió</dt>
        <dd>{textoOrigen(origen)}</dd>
        <dt>Carril</dt><dd><Unknown value={safeJobLane(item.lane)} /></dd>
        <dt>Intento</dt><dd><Unknown value={item.attempt} /></dd>
        <dt>Deadline de ACK</dt><dd><Time value={item.ack_deadline_at} /></dd>
      </dl>
      <div className="drawer-delivery-actions">
        {/* Enlace, no botón: en esta vista no se destruye nada. Ver la cabecera del fichero. */}
        {queuePath ? <a
          className="button small secondary"
          href={queuePath}
          onClick={(event) => { onNavClick(event, queuePath); }}
        >
          Ver en Queues
        </a> : null}
      </div>
    </article>
  );
}

/**
 * The sender of ONE delivery.
 *
 * It used to be decided here with `item.origin_adapter !== 'bus'`, and that read lied by
 * construction: `origin` is copied whole at every hop, so a delegation from `zeus` to `kant`
 * born five hops back in Telegram read as "a person, via telegram". Now the classification is
 * the same one that drives the map arrows (`origenDeItem`), computed once with the fleet's alias
 * list in front.
 */
function textoOrigen(origen: OrigenEncargo | undefined): string {
  if (!origen || origen.tipo === 'desconocido') return UNKNOWN;
  if (origen.tipo === 'puente') return `una persona, por ${origen.adapter}`;
  const donde = origen.tenant ? ` (${origen.tenant})` : '';
  return origen.tipo === 'agente'
    ? `${origen.alias}${donde}, otro agente`
    : `${origen.alias}${donde}, que no es un alias de la flota`;
}

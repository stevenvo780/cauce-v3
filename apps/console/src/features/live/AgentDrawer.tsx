import { ExternalLink, X } from 'lucide-react';
import { useEffect } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import type { AgentPerfilCampos, FleetActivityItem } from '../../api/types';
import { Badge, EmptyState, Time, Tooltip, Unknown } from '../../components/ui';
import { UNKNOWN, compactId, safeDeliveryState, safeJobLane } from '../../lib';
import { onNavClick } from '../../navigation';
import { AgentAvatar } from './AgentAvatar';
import { ChainPanel } from './ChainPanel';
import { DirectivaTab } from './DirectivaTab';
import { FicherosTab } from './FicherosTab';
import { PerfilTab } from './PerfilTab';
import { LIVE_STATE_META, humanSeconds, type LiveAgentView, type OrigenEncargo } from './agent-state';

/**
 * El cajón lateral: diagnosticar sin cambiar de vista.
 *
 * Es el motivo por el que "Fleet" y "Tenants & ACL" pueden desaparecer del menú sin perder un solo
 * dato. Todo lo que antes obligaba a saltar a otra ruta —y con ello a perder el filtro, el scroll
 * y el hilo— ocurre acá, encima de la misma página: el mapa sigue visible y sigue refrescándose
 * detrás. Esa continuidad es la mitad del valor; la otra mitad es que ya no hay que elegir entre
 * "ver la flota" y "ver a uno".
 *
 * Lo que NO tiene, y no es un olvido: **ninguna acción destructiva**. La propuesta original traía
 * botones de reintento y cancelación acá dentro. Una vista que se auto-refresca cada cuatro
 * segundos y se reordena sola por urgencia es el peor sitio posible para poner un botón que
 * destruye: entre que se lee la fila y se hace clic, la fila pudo haberse movido. Cada entrega
 * lleva en cambio un enlace a Queues con la entrega ya señalada, donde ese botón vive rodeado de
 * su propia confirmación.
 */

export type DrawerTab = 'ahora' | 'conexion' | 'entregas' | 'cadena' | 'rol' | 'perfil' | 'ficheros';

/**
 * «Directiva» va acá y no en una vista propia: es el sitio donde el operador YA mira al bot, y el
 * texto que gobierna a ese bot es el que explica lo que hace en las otras cuatro pestañas.
 *
 * Se llamaba «Rol» mientras enseñaba una sola capa. Ahora enseña las tres —rol declarado, manual
 * del sitio y memoria—, y seguir llamándola «Rol» sería nombrar la pestaña por la única capa que
 * ya se veía. El identificador de la pestaña sigue siendo `rol` a propósito: es lo que va en el
 * enlace profundo `?tab=rol` y romperlo invalidaría los enlaces que ya se pegaron por ahí.
 */
const DRAWER_TABS: { id: DrawerTab; label: string }[] = [
  { id: 'ahora', label: 'Ahora' },
  { id: 'conexion', label: 'Conexión' },
  { id: 'entregas', label: 'Entregas' },
  { id: 'cadena', label: 'Cadena' },
  { id: 'rol', label: 'Directiva' },
  /*
   * «Perfil» va ENTRE «Directiva» y «Ficheros» porque ése es el orden real del dato: la directiva
   * es lo que el alias tiene hoy, el perfil es lo que se escribe, y los ficheros son donde acaba.
   * Es la única pestaña del cajón desde la que se puede cambiar lo que el agente lee al arrancar
   * — hasta ahora eso sólo se podía tocando la base a mano.
   */
  { id: 'perfil', label: 'Perfil' },
  /*
   * «Ficheros» va JUNTO a «Directiva» y no en una vista aparte, por lo mismo que «Directiva» vive
   * en este cajón: el `role_brief` y el `CLAUDE.md` son dos capas de lo que gobierna al MISMO
   * bot. Tenerlas en dos sitios distintos de la consola es lo que hizo que nadie notara durante
   * meses que la autonomía estaba escrita por duplicado en los 14 alias. Steven pidió un solo
   * sitio; esto es ese sitio.
   */
  { id: 'ficheros', label: 'Ficheros' },
];

export interface AgentDrawerProps {
  view: LiveAgentView;
  tab: DrawerTab;
  traceId?: string;
  /**
   * El rol a medio redactar de ESTE alias, si lo hay. No lo guarda la pestaña «Rol» sino la
   * página, porque el borrador tiene que sobrevivir a lo que desmonta la pestaña: pasar a
   * «Entregas» a mirar qué hace el bot mientras se le redacta el rol, y volver, era perder el
   * texto sin un solo aviso. `undefined` = este alias no tiene borrador.
   */
  borradorRol?: string;
  onBorradorRol: (texto: string | undefined) => void;
  /** Mismo motivo que el del rol: cambiar de pestaña desmonta la pestaña, no el borrador. */
  borradorPerfil?: Partial<AgentPerfilCampos>;
  onBorradorPerfil: (campos: Partial<AgentPerfilCampos> | undefined) => void;
  onTab: (tab: DrawerTab) => void;
  onTrace: (traceId: string | undefined) => void;
  onClose: () => void;
}

export function AgentDrawer({
  view, tab, traceId, borradorRol, onBorradorRol, borradorPerfil, onBorradorPerfil,
  onTab, onTrace, onClose,
}: AgentDrawerProps) {
  // Esc cierra desde donde sea. Un panel que sólo se cierra con la crucecita obliga a buscarla con
  // el ratón cada vez, y este cajón se abre y se cierra muchas veces seguidas al triar.
  useEffect(() => {
    const alPulsar = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  }, [onClose]);

  const meta = LIVE_STATE_META[view.state];

  return (
    <aside
      className="agent-drawer"
      role="complementary"
      aria-label={`Detalle de ${view.alias}`}
    >
      <header className="agent-drawer-head">
        <div className="agent-drawer-identity">
          <AgentAvatar state={view.state} overloaded={view.overloaded} label={meta.label} />
          <div>
            <h2>{view.alias}</h2>
            <p className="muted">{view.tenantId}{view.displayName ? ` · ${view.displayName}` : ''}</p>
          </div>
        </div>
        <button type="button" className="button small secondary" onClick={onClose} aria-label="Cerrar el detalle">
          <X size={15} aria-hidden="true" />
        </button>
      </header>

      <div className="agent-drawer-tabs" role="tablist" aria-label="Secciones del detalle">
        {DRAWER_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className="agent-drawer-tab"
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className="agent-drawer-body" role="tabpanel">
        {tab === 'ahora' ? <TabAhora view={view} /> : null}
        {tab === 'conexion' ? <TabConexion view={view} /> : null}
        {tab === 'entregas' ? <TabEntregas view={view} onTrace={(id) => { onTrace(id); onTab('cadena'); }} /> : null}
        {tab === 'cadena' ? <TabCadena view={view} traceId={traceId} onTrace={onTrace} /> : null}
        {/* `key` por alias: sin él, cambiar de agente con la pestaña abierta dejaría en pantalla el
            aviso del guardado anterior, referido a OTRO bot. El borrador ya viene de fuera y está
            indexado por alias, así que cambiar de agente empieza limpio por construcción y volver
            al primero recupera lo que se estaba escribiendo. */}
        {tab === 'rol' ? (
          <DirectivaTab
            key={view.key}
            tenantId={view.tenantId}
            alias={view.alias}
            borrador={borradorRol}
            onBorrador={onBorradorRol}
          />
        ) : null}
        {tab === 'perfil' ? (
          <PerfilTab
            key={view.key}
            tenantId={view.tenantId}
            alias={view.alias}
            borrador={borradorPerfil}
            onBorrador={onBorradorPerfil}
          />
        ) : null}
        {tab === 'ficheros' ? <FicherosTab key={view.key} tenantId={view.tenantId} alias={view.alias} /> : null}
      </div>

      <footer className="agent-drawer-foot">
        <a
          className="button small secondary"
          href={`/fleet/${encodeURIComponent(view.tenantId)}/${encodeURIComponent(view.alias)}`}
          onClick={(event) => onNavClick(event, `/fleet/${encodeURIComponent(view.tenantId)}/${encodeURIComponent(view.alias)}`)}
        >
          <ExternalLink size={14} aria-hidden="true" /> Abrir la Terminal acotada a este agente
        </a>
      </footer>
    </aside>
  );
}

/** El detalle que ya existía en la página, movido tal cual: se mueve el sitio, no el contenido. */
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
 * Lo que era la ruta "Fleet" entera, en una pestaña.
 *
 * Cuatro de sus cinco columnas exclusivas —epoch, instance_id, heartbeat y lease— ya venían en
 * `activity.agents[].presence`, así que absorberlas no cuesta un solo fetch nuevo. La quinta,
 * `capabilities`, es la única que necesita `/v3/status`, y por eso ese fetch vive DENTRO de esta
 * pestaña: sólo se paga al abrirla. Una ruta de menú entera para cinco columnas, cuatro de las
 * cuales ya estaban sobre la mesa, era el ejemplo más claro de "demasiadas vistas".
 */
function TabConexion({ view }: { view: LiveAgentView }) {
  const api = useApi();
  // Perezoso por construcción: este componente sólo se monta cuando la pestaña está abierta.
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

function TabEntregas({ view, onTrace }: { view: LiveAgentView; onTrace: (traceId: string) => void }) {
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
        <DeliveryCard item={item} key={item.delivery_id ?? index} origen={view.origenes[index]} onTrace={onTrace} />
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

function DeliveryCard({ item, origen, onTrace }: {
  item: FleetActivityItem;
  origen: OrigenEncargo | undefined;
  onTrace: (traceId: string) => void;
}) {
  return (
    <article className="drawer-delivery">
      <header>
        <span className="mono">{compactId(item.delivery_id)}</span>
        <Badge tone="info"><Unknown value={safeDeliveryState(item.status)} /></Badge>
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
        <a
          className="button small secondary"
          href={`/queues?delivery=${encodeURIComponent(item.delivery_id ?? '')}`}
          onClick={(event) => onNavClick(event, `/queues?delivery=${encodeURIComponent(item.delivery_id ?? '')}`)}
        >
          Ver en Queues
        </a>
        {item.trace_id ? (
          <button type="button" className="button small secondary" onClick={() => onTrace(item.trace_id as string)}>
            Seguir la cadena
          </button>
        ) : null}
      </div>
    </article>
  );
}

/**
 * El remitente de UNA entrega.
 *
 * Antes se decidía acá con `item.origin_adapter !== 'bus'`, y esa lectura mentía por construcción:
 * `origin` se copia entero en cada salto, así que una delegación de `zeus` a `kant` nacida hace
 * cinco saltos en Telegram se leía como «una persona, por telegram». Ahora la clasificación es la
 * misma que gobierna las flechas del mapa (`origenDeItem`), calculada una sola vez con la lista de
 * alias de la flota delante.
 */
function textoOrigen(origen: OrigenEncargo | undefined): string {
  if (!origen || origen.tipo === 'desconocido') return UNKNOWN;
  if (origen.tipo === 'puente') return `una persona, por ${origen.adapter}`;
  const donde = origen.tenant ? ` (${origen.tenant})` : '';
  return origen.tipo === 'agente'
    ? `${origen.alias}${donde}, otro agente`
    : `${origen.alias}${donde}, que no es un alias de la flota`;
}

function TabCadena({ view, traceId, onTrace }: {
  view: LiveAgentView;
  traceId?: string;
  onTrace: (traceId: string | undefined) => void;
}) {
  const traces = [...new Set((view.agent.in_flight_items ?? [])
    .map((item) => item.trace_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0))];

  if (traces.length === 0 && !traceId) {
    return (
      <EmptyState>
        Este agente no tiene ninguna entrega en vuelo con trace, así que no hay cadena que seguir.
      </EmptyState>
    );
  }

  return (
    <div className="drawer-chain">
      {traces.length > 1 || (traces.length > 0 && !traceId) ? (
        <div className="chip-list">
          {traces.map((id) => (
            <button
              key={id}
              type="button"
              className={`chip chip-button${traceId === id ? ' is-active' : ''}`}
              onClick={() => onTrace(id)}
            >
              <Tooltip label={<>Sigue esta cadena salto a salto: quién delegó a quién, qué ramas siguen vivas y cuáles se rechazaron.</>} focusable={false}>
                <span className="mono">{compactId(id)}</span>
              </Tooltip>
            </button>
          ))}
        </div>
      ) : null}
      {traceId ? <ChainPanel traceId={traceId} /> : (
        <EmptyState>Elegí una cadena de las de arriba para seguirla salto a salto.</EmptyState>
      )}
    </div>
  );
}

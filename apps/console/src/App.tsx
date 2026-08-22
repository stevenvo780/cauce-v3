import {
  Activity,
  BatteryCharging,
  Bot,
  Boxes,
  CreditCard,
  GitFork,
  History,
  Settings2,
  ListRestart,
  MessageSquareText,
  RadioTower,
  ShieldCheck,
  Gauge,
  Sparkles,
  TerminalSquare,
} from 'lucide-react';
import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import { AuthGate, SessionBadge, UnmanagedAuthBanner } from './features/auth/AuthGate';
import type { AuthGateState } from './features/auth/auth-session';
import { LiveFleetPage } from './features/live/LiveFleetPage';
import { FleetAgentDetailPage } from './features/fleet/FleetAgentDetailPage';
import { QuotasPage } from './features/quotas/QuotasPage';
import { TopologyPage } from './features/topology/TopologyPage';
import { MessagesPage } from './features/messages/MessagesPage';
import { QueuesPage } from './features/queues/QueuesPage';
import { JobsPage } from './features/jobs/JobsPage';
import { AdaptersPage } from './features/adapters/AdaptersPage';
import { AuditPage } from './features/audit/AuditPage';
import { TerminalPage } from './features/terminal/TerminalPage';
import { ConfigPage } from './features/config/ConfigPage';
import { AccountsPage } from './features/accounts/AccountsPage';
import { ObservabilityPage } from './features/observability/ObservabilityPage';
import { useApi } from './api/context';
import { useResource } from './api/use-resource';
import { permissionState } from './lib';
import { useTerminalRelayStatus } from './features/terminal/relay-status';
import {
  configNavAvailability,
  onNavClick,
  redirect,
  terminalNavAvailability,
  type NavEntryAvailability,
} from './navigation';

interface Route {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  component: ComponentType;
}

/**
 * El menú.
 *
 * **"Actividad de la flota"** dejó de existir en 2026-08-06: leía el mismo
 * `GET /v3/console/activity` que "Sala de máquinas" y lo dibujaba como tabla. Su tabla —que sí
 * aporta, porque permite buscar un alias por nombre y abrir el detalle de cada entrega— vive ahora
 * dentro de "Sala de máquinas", alimentada por el snapshot que esa página ya tenía. Antes eran dos
 * entradas de menú y dos pollings del mismo endpoint.
 *
 * **"Licencias y consumo"** dejó de existir en 2026-08-06: repetía el panel de recolectores, el
 * porcentaje libre por cuenta y los grupos de cuota sin cuenta atada que ya estaban en "Consumo de
 * cuotas", y las dos entradas se llamaban casi igual. Ahora hay una sola, **"Cuotas y licencias"**,
 * que responde entera la pregunta que ninguna de las dos respondía sola —*a esta cuenta le queda
 * saldo, y quién la está usando*—, porque el saldo estaba en una y el dueño en la otra. `/licenses`
 * redirige a `/quotas` (ver `ROUTE_ALIASES`): un enlace guardado que se rompe es un defecto.
 *
 * **"Matriz agente × cuenta"** dejó de existir en 2026-08-06: era la tercera ruta que dibujaba el
 * mismo inventario de cuentas —sus columnas eran las filas de la tabla de "Cuentas de IA"—, salía
 * del mismo `GET /v3/console/config` y escribía por el mismo `POST /v3/console/config/changes`.
 * Vive ahora dentro de **"Cuentas de IA"**, como la segunda mitad de la misma pantalla y sin volver
 * a pedir el snapshot: un solo `useResource` alimenta las dos mitades. `/assignments` redirige a
 * `/accounts`.
 *
 * **"Origin relays"** dejó de existir en 2026-08-06: `GET /v3/console/observability` ya traía los
 * relays y "Observability" los escupía como volcado JSON, o sea el mismo dato dibujado dos veces y
 * peor en una de las dos. La tabla —la buena— vive ahora en **"Observabilidad y relays"**, y se
 * sigue alimentando de `GET /v3/console/origin-relays`, no del snapshot: la ruta dedicada aplica la
 * fachada `visibleOriginRelays` y el snapshot NO (medido en `services/gateway/src/app.ts`), así que
 * el volcado mostraba relays de otros tenants. `/relays` redirige a `/observability`.
 *
 * **"Fleet & presencia"** y **"Tenants & ACL"** dejaron el menú el 2026-08-22, y con ellas la
 * consola pasó de trece entradas a **once**.
 *
 * "Fleet" no aportaba un solo dato de TRABAJO: cruzaba topología con leases, así que un agente con
 * el lease impecable y cuarenta y una entregas colgadas salía verde — exactamente el fallo que la
 * consola existe para no cometer. Sus cinco columnas exclusivas viven ahora en la pestaña
 * "Conexión" del cajón de "La flota ahora", y cuatro de las cinco (epoch, instancia, latido, lease)
 * ya venían dentro del snapshot de actividad que esa página pedía igual: absorberlas no costó un
 * fetch nuevo.
 *
 * "Tenants & ACL" dibujaba el mismo hipergrafo de salas que la sala de máquinas. La objeción que
 * estaba escrita ACÁ —que las flechas no significan lo mismo, una es una entrega en vuelo y la otra
 * una arista ACL— sigue siendo cierta y por eso NO se fundieron las dos capas: se puso un
 * conmutador. "Ahora" y "Permisos" nunca se dibujan a la vez, comparten salas y posiciones, y así
 * comparar *quién puede* con *quién está* se hace con los ojos en vez de con dos pestañas del
 * navegador. Sus dos tablas se extrajeron a `TenantCards` y `AclEdgeList` y se reusan tal cual.
 *
 * Los dos módulos siguen existiendo y siguen siendo alcanzables por URL: `/fleet` y `/topology`
 * redirigen a `/live` (ver `ROUTE_ALIASES`), y `/fleet/:tenant/:alias` —que es el detalle de un
 * bot, no una lista— sigue abriendo el workspace de terminal como siempre.
 *
 * Lo que NO se unificó: "Cuotas y licencias" y "Cuentas de IA". La primera es de lectura y depende
 * del recolector externo; la segunda escribe el registro y tiene que funcionar aunque el recolector
 * esté caído.
 */
const routes: Route[] = [
  { id: 'live', label: 'La flota ahora', icon: Sparkles, component: LiveFleetPage },
  { id: 'quotas', label: 'Cuotas y licencias', icon: BatteryCharging, component: QuotasPage },
  { id: 'accounts', label: 'Cuentas de IA', icon: CreditCard, component: AccountsPage },
  { id: 'messages', label: 'Messages', icon: MessageSquareText, component: MessagesPage },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, component: QueuesPage },
  { id: 'jobs', label: 'Jobs', icon: Boxes, component: JobsPage },
  { id: 'adapters', label: 'Adapters', icon: Bot, component: AdaptersPage },
  { id: 'audit', label: 'Audit', icon: History, component: AuditPage },
  { id: 'observability', label: 'Observabilidad y relays', icon: Gauge, component: ObservabilityPage },
  { id: 'config', label: 'Configuration', icon: Settings2, component: ConfigPage },
  { id: 'terminal', label: 'Ultimate Terminal', icon: TerminalSquare, component: TerminalPage },
  /**
   * Entrada OCULTA (sin `label`, excluida del render del menú).
   *
   * `/fleet` como lista dejó de existir, pero `/fleet/:tenant/:alias` NO: es el detalle de un bot
   * y sigue siendo el destino del pie del cajón. Sin esta entrada, `matchRoute` no reconocería el
   * id y la ruta caería al fallback, o sea que abrir un agente desde el cajón llevaría a la
   * portada. Es la clase de defecto que sólo se descubre haciendo clic.
   */
  { id: 'fleet', label: '', icon: RadioTower, component: FleetRouteNotice },
  /** Ídem: la vista de topología salió del menú, no del producto. Ver TopologyPage.tsx. */
  { id: 'topology', label: '', icon: GitFork, component: TopologyPage },
];

/** Lo que se dibuja en la barra lateral: las entradas con rótulo. Once, no trece. */
const MENU = routes.filter((route) => route.label !== '');

/**
 * Rutas retiradas que siguen vivas en marcadores, en enlaces pegados en un chat y en el historial
 * del navegador. No pueden caer en el `fallback` a "Sala de máquinas": eso deja al operador en una
 * página que no pidió, sin una palabra que explique adónde se fue la que buscaba. Se resuelven a su
 * heredera y la barra de direcciones se reescribe con `replaceState`, así el botón "atrás" tampoco
 * vuelve a la ruta muerta.
 */
const ROUTE_ALIASES: Record<string, string> = {
  /** Fusionada con "Consumo de cuotas" en "Cuotas y licencias" — 2026-08-06. */
  licenses: 'quotas',
  /** "Matriz agente × cuenta" pasó a ser la segunda mitad de "Cuentas de IA" — 2026-08-06. */
  assignments: 'accounts',
  /** "Origin relays" pasó a ser la tabla de "Observabilidad y relays" — 2026-08-06. */
  relays: 'observability',
  /**
   * "Actividad de la flota" se fundió en "Sala de máquinas" el 2026-08-06 (commit `f0f18ae`) pero
   * quedó sin alias: `/activity` caía al `fallback` y mostraba la sala con la barra de direcciones
   * todavía diciendo `/activity`. Es el mismo defecto que este mapa existe para evitar.
   */
  activity: 'live',
  /**
   * "Fleet & presencia" dejó de existir el 2026-08-22. No aportaba un solo dato de TRABAJO —un
   * agente con el lease perfecto y 41 entregas colgadas lo pintaba verde— y su `agentStateBadge`
   * era copia literal de `presenceBadge` de activity, con el comentario que lo admitía. Sus cinco
   * columnas viven en la pestaña «Conexión» del cajón, y cuatro de ellas ya venían en el mismo
   * snapshot que la vista pedía igual: absorberlas no costó un fetch nuevo.
   *
   * Su métrica "En cola" (pending + retry + claimed, de /v3/status) SE RETIRA en vez de mudarse:
   * contradecía a la de activity (pending + retry). Dos rótulos iguales con dos números distintos
   * en la misma consola es peor que no tener ninguno.
   *
   * OJO: este alias sólo aplica a `/fleet` a secas. `/fleet/:tenant/:alias` sigue resolviendo al
   * detalle del bot — ver `matchRoute`.
   */
  fleet: 'live',
  /** "Tenants & ACL" es ahora la capa «Permisos» del mapa y el desplegable de la misma página. */
  topology: 'live',
};

/**
 * Lo que queda de `/fleet` cuando la URL no alcanza para identificar a un bot.
 *
 * `/fleet` a secas redirige a `/live`, y `/fleet/:tenant/:alias` abre el detalle. Entre medio está
 * `/fleet/:tenant`, que no es ninguna de las dos cosas: nombra un cliente, no un agente. Antes caía
 * en la lista de la flota; ahora esa lista no existe, y mandarlo al fallback sin decir nada dejaría
 * al operador en una página que no pidió — el mismo defecto que `ROUTE_ALIASES` existe para evitar.
 */
function FleetRouteNotice() {
  return (
    <div className="state-card">
      <div>
        <strong>Esa dirección ya no identifica a nadie</strong>
        <p>
          La lista de la flota es ahora <a href="/live" onClick={(event) => onNavClick(event, '/live')}>La flota ahora</a>.
          El detalle de un bot sigue viviendo en <span className="mono">/fleet/:cliente/:alias</span>, con los dos datos.
        </p>
      </div>
    </div>
  );
}

interface RouteMatch {
  id: string;
  /** Segmentos posteriores al id de ruta, ej. `#/fleet/:tenant/:alias` → ['tenant', 'alias']. */
  params: string[];
  /** Id tal como venía en la URL cuando era un alias retirado; `undefined` si la ruta es canónica. */
  aliasedFrom?: string;
}

/** Snapshot crudo para useSyncExternalStore: debe ser un primitivo estable, no un objeto recién creado. */
function currentPath(): string {
  return window.location.pathname.replace(/^\//, '');
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchRoute(path: string): RouteMatch {
  const segments = path.split('/').filter(Boolean).map(decodeSegment);
  const requested = segments[0] ?? '';
  /**
   * El alias de `fleet` sólo vale para la LISTA. Con dos segmentos o más, `/fleet/:tenant/:alias`
   * es el detalle de un bot y tiene que seguir resolviendo ahí: redirigirlo a `/live` rompería el
   * pie del cajón, el enlace "volver" del propio detalle y cualquier marcador a un agente.
   */
  const alias = segments.length > 1 && requested === 'fleet' ? undefined : ROUTE_ALIASES[requested];
  const id = alias ?? requested;
  return routes.some((route) => route.id === id)
    ? { id, params: segments.slice(1), aliasedFrom: alias ? requested : undefined }
    : { id: 'live', params: [] };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

export function App() {
  return <AuthGate>{(gate) => <ConsoleShell gate={gate} />}</AuthGate>;
}

function ConsoleShell({ gate }: { gate: AuthGateState }) {
  const path = useSyncExternalStore(subscribe, currentPath, () => 'live');
  /**
   * El menú tiene que decir la verdad ANTES del clic. Las dos funciones que deciden esto ya
   * existían —`terminalNavAvailability` desde el commit 0a1d0e3 y `useTerminalRelayStatus`, cuyo
   * propio comentario dice "e.g. the sidebar entry"— y NUNCA se habían conectado a la barra
   * lateral: estaban escritas, probadas y muertas. Medido el 2026-08-22 contra producción con la
   * sesión real de Miguel: `/v3/console/config` devuelve 403 `control permission is required`,
   * y el menú se la ofrecía igual.
   *
   * `console-access` comparte clave de caché con las páginas que ya lo piden, así que esto no
   * agrega una petición por navegación.
   */
  const api = useApi();
  const access = useResource('console-access', () => api.getConsoleAccess());
  const relay = useTerminalRelayStatus();
  const navAvailability = (id: string): NavEntryAvailability => {
    if (id === 'terminal') return terminalNavAvailability(relay);
    if (id === 'config') return configNavAvailability(permissionState(access.data, 'config.write'));
    return { hidden: false, disabled: false };
  };
  const { id: routeId, params, aliasedFrom } = matchRoute(path);
  const route = routes.find((candidate) => candidate.id === routeId) ?? routes[0];

  // La vista correcta ya se eligió arriba (`matchRoute` resuelve el alias); esto sólo pone la barra
  // de direcciones de acuerdo con lo que se está viendo. Si fallara, la página igual es la buena.
  useEffect(() => {
    if (!aliasedFrom) return;
    redirect(`/${routeId}`);
  }, [aliasedFrom, routeId]);

  const Page = route.component;
  // Único sub-detalle soportado hoy: /fleet/:tenant/:alias reutiliza el workspace de terminal.
  // Se comprueba contra el primer segmento CRUDO y no contra `routeId`: ahora `fleet` es también
  // un alias hacia `live`, así que preguntarle al id resuelto daría siempre `false`.
  const requestedSegment = path.split('/').filter(Boolean).map(decodeSegment)[0] ?? '';
  const fleetAgentTarget = requestedSegment === 'fleet' && params.length >= 2
    ? { tenantId: params[0], alias: params[1] }
    : undefined;

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Activity size={22} /></span>
          <div><strong>Cauce</strong><small>V3 Console</small></div>
        </div>
        <nav aria-label="Navegación principal">
          <ul>
            {MENU.map((item) => {
              const Icon = item.icon;
              const disponible = navAvailability(item.id);
              if (disponible.hidden) return null;
              return (
                <li key={item.id}>
                  <a
                    href={`/${item.id}`}
                    onClick={(event) => onNavClick(event, `/${item.id}`, disponible.reason)}
                    aria-current={route.id === item.id ? 'page' : undefined}
                    aria-disabled={disponible.disabled ? true : undefined}
                    className={disponible.disabled ? 'nav-inerte' : undefined}
                    title={disponible.reason}
                  >
                    <Icon size={18} aria-hidden={true} />
                    <span>{item.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="authority-note">
          <ShieldCheck size={18} aria-hidden="true" />
          <p><strong>Autoridad: servidor</strong><span>Cookie HttpOnly esperada</span></p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div><span className="live-dot" aria-hidden="true" /> Control plane client</div>
          <div className="topbar-meta">
            {import.meta.env.VITE_USE_MOCKS === 'true' ? <span className="mock-flag">MOCK API</span> : null}
            <SessionBadge state={gate.state} status={gate.status} busy={gate.busy} onLogout={() => void gate.logout()} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {gate.status === 'unmanaged' ? <UnmanagedAuthBanner /> : null}
          {fleetAgentTarget
            ? <FleetAgentDetailPage tenantId={fleetAgentTarget.tenantId} alias={fleetAgentTarget.alias} />
            : <Page />}
        </main>
      </div>
    </div>
  );
}

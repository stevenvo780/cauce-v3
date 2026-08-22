import {
  Activity,
  Boxes,
  RadioTower,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useSyncExternalStore, type ComponentType } from 'react';
import { AuthGate, SessionBadge, UnmanagedAuthBanner } from './features/auth/AuthGate';
import type { AuthGateState } from './features/auth/auth-session';
import { LiveFleetPage } from './features/live/LiveFleetPage';
import { FleetAgentDetailPage } from './features/fleet/FleetAgentDetailPage';
import { MessagesPage } from './features/messages/MessagesPage';
import { QueuesPage } from './features/queues/QueuesPage';
import { LandingPage } from './features/landing/LandingPage';
import { JobsRetiredNotice } from './features/landing/JobsRetiredNotice';
import { TerminalPage } from './features/terminal/TerminalPage';
import { ConfigPage } from './features/config/ConfigPage';
import { AccountsPage } from './features/accounts/AccountsPage';
import { ObservabilityPage } from './features/observability/ObservabilityPage';
import { NAV_ENTRIES, useNavAvailability } from './nav';
import { onNavClick, redirect } from './navigation';

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
 * `/fleet` y `/topology` redirigen a `/live` (ver `ROUTE_ALIASES`), y `/fleet/:tenant/:alias` —que
 * es el detalle de un bot, no una lista— sigue abriendo el workspace de terminal como siempre.
 *
 * **"Cuotas y licencias" SÍ se unificó con "Cuentas de IA" el 2026-08-22**, al revés de lo que
 * decía este comentario. La objeción escrita acá —una es de lectura y depende del recolector
 * externo, la otra escribe el registro y tiene que funcionar con el recolector caído— se resolvió
 * sin volver a partir el menú: son dos PESTAÑAS de "Cuentas y cuotas" (`/accounts`), y el registro
 * se sigue pudiendo escribir aunque la pestaña de consumo no tenga datos. Las dos pedían el mismo
 * `GET /v3/console/config` con la misma clave de caché y las dos pintaban un panel titulado
 * literalmente «Inventario de cuentas».
 *
 * **"Jobs" y "Adapters" dejaron el menú el 2026-08-22.**
 *
 * "Jobs" se retiró contra la base de PRODUCCIÓN, no contra una opinión: la tabla `jobs` tenía
 * `n_tup_ins = 0` y `n_live_tup = 0` con las estadísticas nunca reseteadas, o sea CERO filas en
 * toda la vida de la base, mientras el dispatcher acumulaba 373.146 `seq_scan` sobre ella. Su
 * único escritor era el formulario de la propia vista. Ver `JobsRetiredNotice`.
 *
 * "Adapters" no se retiró: se mudó. `GET /v3/console/adapters` lista TIPOS de arnés —seis filas que
 * casi nunca cambian—, no agentes, y eso es un dato de referencia, no una vista de trabajo. Vive
 * plegado en la portada (`HarnessStrip`) y la API sigue intacta porque también la piden "Ultimate
 * Terminal" y el detalle de un bot. `/adapters` redirige a `/`.
 *
 * **La portada (`/`) es nueva y no compite con "La flota ahora".** Resume —flota, colas, cuotas,
 * alertas, y qué responde cada vista— y enlaza; `/live` sigue siendo la vista viva con el
 * hipergrafo y el cajón. Ninguna de las dos dibuja lo que dibuja la otra.
 *
 * **"Audit" se fundió en "Señales y auditoría" el 2026-08-22**: es su pestaña «Auditoría», y cada
 * relay trae un botón que la abre filtrada por su `trace_id`. El propio comentario de
 * `ObservabilityPage` ya decía que esas dos claves bajaban a la tabla «para cruzarlos contra
 * Audit», o sea que la consola documentaba una investigación partida en dos pantallas por
 * accidente.
 *
 * **"Messages" pasó a llamarse "Mensajes" el 2026-08-22** —misma ruta, mismo componente— y dejó de
 * ser un formulario para ser una conversación por agente.
 *
 * 🔴 **El resultado de las cinco reformas es UN menú de ocho entradas: la portada más siete.** El
 * recuento no se escribe a mano en ningún rótulo (`rotuloDeVistas` lo deriva) y las invariantes que
 * lo sostienen —cada entrada resuelve a una vista real, ningún alias apunta a otro alias, ningún id
 * de ruta queda tapado por un alias— viven en `App.invariantes.test.tsx`, como tabla y no como
 * casos sueltos.
 */
/**
 * Qué componente dibuja cada entrada CON rótulo. El rótulo, el icono y la pregunta que responde
 * cada vista viven en `NAV_ENTRIES` (`./nav`), que es también lo que lee la portada: eran dos
 * listas escritas a mano y ya habían divergido —«Configuration» contra «Configuración y altas»—
 * el mismo día en que se escribieron.
 */
const PAGES: Record<string, ComponentType> = {
  '': LandingPage,
  live: LiveFleetPage,
  accounts: AccountsPage,
  messages: MessagesPage,
  queues: QueuesPage,
  observability: ObservabilityPage,
  config: ConfigPage,
  terminal: TerminalPage,
};

const routes: Route[] = [
  ...NAV_ENTRIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    component: PAGES[entry.id],
  })),
  /**
   * Entrada OCULTA (sin `label`, excluida del render del menú).
   *
   * `/fleet` como lista dejó de existir, pero `/fleet/:tenant/:alias` NO: es el detalle de un bot
   * y sigue siendo el destino del pie del cajón. Sin esta entrada, `matchRoute` no reconocería el
   * id y la ruta caería al fallback, o sea que abrir un agente desde el cajón llevaría a la
   * portada. Es la clase de defecto que sólo se descubre haciendo clic.
   */
  { id: 'fleet', label: '', icon: RadioTower, component: FleetRouteNotice },
  /**
   * Entrada OCULTA: `/jobs` no tiene heredera, así que tampoco tiene alias. Ver
   * `JobsRetiredNotice` para la medición que la retiró y para por qué es un aviso y no una
   * redirección muda.
   */
  { id: 'jobs', label: '', icon: Boxes, component: JobsRetiredNotice },
];

/**
 * Lo que se dibuja en la barra lateral: las entradas con rótulo. Ocho —la portada más siete—,
 * cuando el 2026-08-06 eran trece. El número NO se escribe en ningún rótulo: se deriva de la lista
 * (ver `rotuloDeVistas`), porque un recuento a mano envejece en silencio.
 */
const MENU = routes.filter((route) => route.label !== '');

/**
 * Rutas retiradas que siguen vivas en marcadores, en enlaces pegados en un chat y en el historial
 * del navegador. No pueden caer en el `fallback` a "Sala de máquinas": eso deja al operador en una
 * página que no pidió, sin una palabra que explique adónde se fue la que buscaba. Se resuelven a su
 * heredera y la barra de direcciones se reescribe con `replaceState`, así el botón "atrás" tampoco
 * vuelve a la ruta muerta.
 */
const ROUTE_ALIASES: Record<string, string> = {
  /**
   * "Licencias y consumo" se fundió en "Cuotas y licencias" (`/quotas`) el 2026-08-06, y el
   * 2026-08-22 "Cuotas y licencias" se fundió a su vez en "Cuentas y cuotas" (`/accounts`).
   *
   * 🔴 Apunta DIRECTO a `accounts`, no a `quotas`. `matchRoute` resuelve este mapa **una sola vez**:
   * `licenses` → `quotas` habría devuelto un id que ya no existe entre las rutas, y la entrada
   * habría caído al fallback de "La flota ahora" sin decir una palabra. Un alias encadenado no es
   * un alias: es un 404 silencioso con otra cara.
   */
  licenses: 'accounts',
  /**
   * "Cuotas y licencias" es la pestaña «Consumo» de "Cuentas y cuotas" desde el 2026-08-22. Las dos
   * vistas pedían el MISMO `GET /v3/console/config` con la MISMA clave de caché y las dos pintaban
   * un panel titulado literalmente «Inventario de cuentas». Ver `AccountsPage`.
   */
  quotas: 'accounts',
  /** "Matriz agente × cuenta" pasó a ser la segunda mitad de "Cuentas de IA" — 2026-08-06. */
  assignments: 'accounts',
  /**
   * "Audit" es la pestaña «Auditoría» de "Señales y auditoría" desde el 2026-08-22. El propio
   * comentario de `ObservabilityPage` decía que `request_id` y `trace_id` bajaban a la tabla de
   * relays «para cruzarlos contra Audit»: la consola documentaba que la investigación normal cruza
   * las dos pantallas, y obligaba a hacerlo con dos pestañas del navegador. Ahora es un botón.
   *
   * Gana `observability` y no `audit` porque `/relays` ya redirige a `observability` desde el
   * 2026-08-06, y encadenar `relays` → `observability` → `audit` no funciona (ver `licenses`).
   */
  audit: 'observability',
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
  /**
   * "Tenants & ACL" es ahora la capa «Permisos» del mapa y el desplegable de la misma página.
   *
   * 🔴 Hasta el 2026-08-22 convivía con una entrada OCULTA `{ id: 'topology', component:
   * TopologyPage }` unas líneas más arriba, y `TopologyPage.tsx` prometía por escrito que la vista
   * «sigue siendo alcanzable… para quien tenga la URL guardada». No lo era: `matchRoute` consulta
   * este mapa ANTES de mirar `routes`, así que este alias ganaba siempre y la entrada nunca se
   * podía resolver. Un componente inalcanzable con un comentario que jura lo contrario es peor que
   * no tenerlo. Se retiró la entrada muerta y se dejó el alias, que es lo que producción hace y lo
   * que su prueba exige.
   */
  topology: 'live',
  /**
   * "Adapters" pasó a ser la tira plegable de la portada el 2026-08-22. Acá SÍ corresponde alias y
   * no aviso —al revés que en `/jobs`—: su contenido no desapareció, se mudó, así que quien abre el
   * marcador llega exactamente a donde está lo que buscaba. La regla es esa y no otra: alias cuando
   * hay heredera, aviso cuando no la hay.
   */
  adapters: '',
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
  /**
   * `alias !== undefined`, NO `alias ?`. Desde que la portada vive en `''`, un alias puede resolver
   * a la cadena vacía —es el caso de `/adapters`— y una comprobación por veracidad la trataría como
   * "no hubo alias": la página correcta se dibujaría igual, pero la barra de direcciones seguiría
   * diciendo `/adapters` para siempre. Es exactamente el defecto que `ROUTE_ALIASES` existe para
   * evitar, colado por la puerta de atrás de un valor falsy.
   */
  return routes.some((route) => route.id === id)
    ? { id, params: segments.slice(1), aliasedFrom: alias !== undefined ? requested : undefined }
    : { id: '', params: [] };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

export function App() {
  return <AuthGate>{(gate) => <ConsoleShell gate={gate} />}</AuthGate>;
}

function ConsoleShell({ gate }: { gate: AuthGateState }) {
  // El snapshot de servidor es la portada, que es también el fallback de `matchRoute`.
  const path = useSyncExternalStore(subscribe, currentPath, () => '');
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
  const navAvailability = useNavAvailability();
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

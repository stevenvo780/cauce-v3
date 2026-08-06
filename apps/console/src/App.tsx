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
import { FleetPage } from './features/fleet/FleetPage';
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
 * Lo que NO se unificó, y por qué: "Sala de máquinas" y "Tenants & ACL" dibujan los dos un
 * hipergrafo de salas, pero responden preguntas distintas — *quién le está pasando trabajo a quién
 * ahora* (cambia cada cuatro segundos) contra *quién tiene permiso de hablarle a quién* (cambia
 * cuando alguien edita la configuración). Las flechas no significan lo mismo: una es una entrega en
 * vuelo, la otra es una arista ACL. Fundirlas obligaría a elegir cuál de las dos preguntas se
 * responde peor. Tampoco se fundieron "Cuotas y licencias" y "Cuentas de IA": la primera es de
 * lectura y depende del recolector externo; la segunda escribe el registro y tiene que funcionar
 * aunque el recolector esté caído.
 */
const routes: Route[] = [
  { id: 'live', label: 'Sala de máquinas', icon: Sparkles, component: LiveFleetPage },
  { id: 'fleet', label: 'Fleet', icon: RadioTower, component: FleetPage },
  { id: 'quotas', label: 'Cuotas y licencias', icon: BatteryCharging, component: QuotasPage },
  { id: 'accounts', label: 'Cuentas de IA', icon: CreditCard, component: AccountsPage },
  { id: 'topology', label: 'Tenants & ACL', icon: GitFork, component: TopologyPage },
  { id: 'messages', label: 'Messages', icon: MessageSquareText, component: MessagesPage },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, component: QueuesPage },
  { id: 'jobs', label: 'Jobs', icon: Boxes, component: JobsPage },
  { id: 'adapters', label: 'Adapters', icon: Bot, component: AdaptersPage },
  { id: 'audit', label: 'Audit', icon: History, component: AuditPage },
  { id: 'observability', label: 'Observabilidad y relays', icon: Gauge, component: ObservabilityPage },
  { id: 'config', label: 'Configuration', icon: Settings2, component: ConfigPage },
  { id: 'terminal', label: 'Ultimate Terminal', icon: TerminalSquare, component: TerminalPage },
];

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
};

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
  const alias = ROUTE_ALIASES[requested];
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
  const { id: routeId, params, aliasedFrom } = matchRoute(path);
  const route = routes.find((candidate) => candidate.id === routeId) ?? routes[0];

  // La vista correcta ya se eligió arriba (`matchRoute` resuelve el alias); esto sólo pone la barra
  // de direcciones de acuerdo con lo que se está viendo. Si fallara, la página igual es la buena.
  useEffect(() => {
    if (!aliasedFrom) return;
    redirect(`/${routeId}`);
  }, [aliasedFrom, routeId]);

  const Page = route.component;
  // Único sub-detalle soportado hoy: /fleet/:tenant/:alias reutiliza el workspace de terminal, no FleetPage.
  const fleetAgentTarget = routeId === 'fleet' && params.length >= 2
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
            {routes.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.id}>
                  <a
                    href={`/${item.id}`}
                    onClick={(event) => onNavClick(event, `/${item.id}`)}
                    aria-current={route.id === item.id ? 'page' : undefined}
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

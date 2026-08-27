import {
  Activity,
  Boxes,
  ShieldCheck,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useSyncExternalStore, type ComponentType } from 'react';
import { AuthGate, SessionBadge, UnmanagedAuthBanner } from './features/auth/AuthGate';
import type { AuthGateState } from './features/auth/auth-session';
import { LandingPage } from './features/landing/LandingPage';
import { NAV_ENTRIES, useNavAvailability } from './nav';
import { onNavClick, redirect } from './navigation';

/**
 * Every operational view used to be imported into the landing bundle. That made opening the
 * login/landing path download and parse terminal, topology, configuration and observability code
 * before the operator chose a view (the main minified chunk exceeded 1.1 MiB). Keep the landing
 * page immediate and make each route a real code-split boundary.
 *
 * The wrapper is intentionally a function component rather than storing React.lazy directly in
 * ROUTE_TABLE: the route invariant checks that every declared destination is callable, which has
 * caught unreachable routes before, while LazyExoticComponent is represented as an object.
 */
function deferredPage(
  load: () => Promise<{ default: ComponentType }>,
): ComponentType {
  const Deferred = lazy(load);
  return function DeferredRoutePage() {
    return (
      <Suspense fallback={<p className="muted" role="status">Cargando vista…</p>}>
        <Deferred />
      </Suspense>
    );
  };
}

const LiveFleetPage = deferredPage(async () => ({
  default: (await import('./features/live/LiveFleetPage')).LiveFleetPage,
}));
const AccountsPage = deferredPage(async () => ({
  default: (await import('./features/accounts/AccountsPage')).AccountsPage,
}));
const MessagesPage = deferredPage(async () => ({
  default: (await import('./features/messages/MessagesPage')).MessagesPage,
}));
const QueuesPage = deferredPage(async () => ({
  default: (await import('./features/queues/QueuesPage')).QueuesPage,
}));
const ObservabilityPage = deferredPage(async () => ({
  default: (await import('./features/observability/ObservabilityPage')).ObservabilityPage,
}));
const ConfigPage = deferredPage(async () => ({
  default: (await import('./features/config/ConfigPage')).ConfigPage,
}));
const TerminalPage = deferredPage(async () => ({
  default: (await import('./features/terminal/TerminalPage')).TerminalPage,
}));
import { HelpPage } from './features/help/HelpPage';
const FleetAgentDetailPage = lazy(async () => ({
  default: (await import('./features/fleet/FleetAgentDetailPage')).FleetAgentDetailPage,
}));

interface Route {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  component: ComponentType;
}

/**
 * Definición y mapeo de rutas principales de la consola.
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
  ayuda: HelpPage,
};

const routes: Route[] = [
  ...NAV_ENTRIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    icon: entry.icon,
    component: PAGES[entry.id],
  })),
  { id: 'ayuda', label: '', icon: Boxes, component: PAGES.ayuda },
];

/** Entradas visibles en la barra lateral de navegación. */
const MENU = routes.filter((route) => route.label !== '');

/**
 * Redirecciones de rutas obsoletas o consolidadas hacia sus vistas canónicas.
 */
const ROUTE_ALIASES: Record<string, string> = {
  licenses: 'accounts',
  quotas: 'accounts',
  assignments: 'accounts',
  audit: 'observability',
  relays: 'observability',
  activity: 'live',
  fleet: 'live',
  topology: 'live',
  help: 'ayuda',
};

/**
 * Tablas de rutas y alias exportadas para verificación de navegación e invariantes en tests.
 */
export const ROUTE_TABLE: readonly Readonly<Route>[] = routes;
export const ROUTE_ALIAS_TABLE: Readonly<Record<string, string>> = ROUTE_ALIASES;

/**
 * Una URL que la consola no declara no se convierte silenciosamente en una vista válida. Conservar
 * la dirección permite corregir un marcador o reportar el enlace exacto que quedó obsoleto.
 */
function RouteNotFound({ path }: { path: string }) {
  return (
    <div className="state-card" role="alert">
      <div className="state-card-texto">
        <h1>Ruta no encontrada</h1>
        <p>
          La consola no declara <code>{path}</code>. No se mostró otra vista en su lugar porque eso
          ocultaría un enlace roto.
        </p>
        <p>
          <a href="/" onClick={(event) => onNavClick(event, '/')}>Ir a la portada</a>
          {' · '}
          <a href="/live" onClick={(event) => onNavClick(event, '/live')}>Abrir la flota</a>
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
  /** Dirección original que no corresponde a ninguna vista declarada. */
  notFoundPath?: string;
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
  // `/fleet/:tenant/:alias` apunta al detalle del agente; `/fleet` general redirige según alias.
  const alias = segments.length > 1 && requested === 'fleet' ? undefined : ROUTE_ALIASES[requested];
  const id = alias ?? requested;
  const params = segments.slice(1);
  // `/fleet/:tenant/:alias` es el único subdetalle declarado.
  const detalleFleet = requested === 'fleet' && alias === undefined && params.length === 2;
  const existe = detalleFleet || routes.some((route) => route.id === id);
  const aridadInvalida = params.length > 0 && !detalleFleet;
  return existe && !aridadInvalida
    ? { id, params, aliasedFrom: alias !== undefined ? requested : undefined }
    : { id: requested, params, notFoundPath: `/${path}` };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

export function App() {
  return <AuthGate>{(gate) => <ConsoleShell gate={gate} />}</AuthGate>;
}

function ConsoleShell({ gate }: { gate: AuthGateState }) {
  const path = useSyncExternalStore(subscribe, currentPath, () => '');
  const navAvailability = useNavAvailability();
  const { id: routeId, params, aliasedFrom, notFoundPath } = matchRoute(path);
  const route = routes.find((candidate) => candidate.id === routeId);

  useEffect(() => {
    if (!aliasedFrom) return;
    redirect(`/${routeId}`);
  }, [aliasedFrom, routeId]);

  const Page = route?.component;
  // Sub-detalle /fleet/:tenant/:alias reutiliza el workspace de terminal.
  const requestedSegment = path.split('/').filter(Boolean).map(decodeSegment)[0] ?? '';
  const fleetAgentTarget = !notFoundPath && requestedSegment === 'fleet' && params.length === 2
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
                    aria-current={!notFoundPath && route?.id === item.id ? 'page' : undefined}
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
          {notFoundPath
            ? <RouteNotFound path={notFoundPath} />
            : fleetAgentTarget
            ? (
              <Suspense fallback={<p className="muted" role="status">Cargando agente…</p>}>
                <FleetAgentDetailPage
                  tenantId={fleetAgentTarget.tenantId}
                  alias={fleetAgentTarget.alias}
                />
              </Suspense>
            )
            : Page ? <Page /> : null}
        </main>
      </div>
    </div>
  );
}

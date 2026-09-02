import {
  Activity,
  Boxes,
  PanelLeftClose,
  PanelLeftOpen,
  ShieldCheck,
} from 'lucide-react';
import {
  lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type ComponentType,
} from 'react';
import { ConsoleAccessProvider } from './api/console-access';
import { AuthGate, SessionBadge, UnmanagedAuthBanner } from './features/auth/AuthGate';
import type { AuthGateState } from './features/auth/auth-session';
import { LandingPage } from './features/landing/LandingPage';
import { NAV_ENTRIES, useNavAvailability } from './nav';
import { onNavClick, redirect } from './router';

/**
 * Every operational view used to be imported into the landing bundle. That made opening the
 * login/landing path download and parse terminal, topology, configuration and observability code
 * before the operator chose a view (the main minified chunk exceeded 1.1 MiB). Keep the landing
 * page immediate and make each route a real code-split boundary.
 *
 * The wrapper is a function component rather than React.lazy stored directly in ROUTE_TABLE: the
 * route invariant checks that every declared destination is callable, and LazyExoticComponent is
 * an object.
 */
function deferredPage<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  const Deferred = lazy(load);
  return function DeferredRoutePage(props: P) {
    return (
      <Suspense fallback={<p className="muted" role="status">Cargando vista…</p>}>
        <Deferred {...props} />
      </Suspense>
    );
  };
}

/** Optional state carried by routed views: audit tab or an exact Terminal agent identity. */
interface RoutePageProps {
  initialTab?: 'senales' | 'auditoria';
  tenantId?: string;
  alias?: string;
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
import { TerminalRelayProvider } from './features/terminal/relay-status';

interface Route {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  component: ComponentType<RoutePageProps>;
}

const PAGES: Record<string, ComponentType<RoutePageProps>> = {
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

/** Entries visible in the navigation sidebar. */
const MENU = routes.filter((route) => route.label !== '');

/** Redirects of obsolete or consolidated routes to their canonical views. */
/* Routes that accept segments past the id, with their exact arity. A view that navigates to a
   subroute not declared here ends up at "Route not found", and no test catches it: theirs assert
   on `pathname`, which looks the same when the destination does not exist. */
const SUBDETALLES: Partial<Record<string, number>> = { fleet: 2, messages: 2, terminal: 2 };

const ROUTE_ALIASES: Partial<Record<string, string>> = {
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

/** Route and alias tables exported for navigation verification and invariant tests. */
export const ROUTE_TABLE: readonly Readonly<Route>[] = routes;
export const ROUTE_ALIAS_TABLE: Readonly<Record<string, string>> = ROUTE_ALIASES as Record<string, string>;

/**
 * A URL the console does not declare does not silently become a valid view. Preserving the
 * address lets us fix a bookmark or report the exact link that became obsolete.
 */
function RouteNotFound({ path }: { path: string }) {
  return (
    <div className="state-card" role="alert">
      <div className="state-card-texto">
        <h1>{NOT_FOUND_TITLE}</h1>
        <p>
          La consola no declara <code>{path}</code>. No se mostró otra vista en su lugar porque eso
          ocultaría un enlace roto.
        </p>
        <p>
          <a href="/" onClick={(event) => { onNavClick(event, '/'); }}>Ir a la portada</a>
          {' · '}
          <a href="/live" onClick={(event) => { onNavClick(event, '/live'); }}>Abrir la flota</a>
        </p>
      </div>
    </div>
  );
}

interface RouteMatch {
  id: string;
  /** Segments past the route id, e.g. `/terminal/:tenant/:alias` → ['tenant', 'alias']. */
  params: string[];
  /** Id as it appeared in the URL when it was a removed alias; `undefined` if the route is canonical. */
  aliasedFrom?: string;
  /** Original address that does not match any declared view. */
  notFoundPath?: string;
}

/** Raw snapshot for useSyncExternalStore: must be a stable primitive, not a freshly-created object. */
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
  const aridad = SUBDETALLES[requested];
  const params = segments.slice(1);
  const detalleFleetLegado = requested === 'fleet' && params.length === aridad;
  const alias = detalleFleetLegado
    ? 'terminal'
    : segments.length > 1 && aridad !== undefined ? undefined : ROUTE_ALIASES[requested];
  const id = alias ?? requested;
  const subdetalle = aridad !== undefined && alias === undefined && params.length === aridad;
  const existe = detalleFleetLegado || subdetalle || routes.some((route) => route.id === id);
  const aridadInvalida = params.length > 0 && !subdetalle && !detalleFleetLegado;
  return existe && !aridadInvalida
    ? { id, params, aliasedFrom: alias !== undefined ? requested : undefined }
    : { id: requested, params, notFoundPath: `/${path}` };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => { window.removeEventListener('popstate', callback); };
}

/** Rail (78px, icons only) or full bar (248px, with labels). */
type SidebarState = 'rail' | 'expanded';

const SIDEBAR_SHORTCUT = 'Alt+Shift+B';
const NAV_ID = 'nav-principal';
/** Breakpoints from `responsive.css`: the viewport forces the rail, and below that the bar moves below. */
const RAIL_VIEWPORT = '(max-width: 1100px)';
const BOTTOM_BAR_VIEWPORT = '(max-width: 760px)';
const CONSOLE_TITLE = 'Cauce V3 Console';
const NOT_FOUND_TITLE = 'Ruta no encontrada';

function useMediaQuery(query: string): boolean {
  const subscribeToQuery = useCallback((onChange: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => { list.removeEventListener('change', onChange); };
  }, [query]);
  return useSyncExternalStore(subscribeToQuery, () => window.matchMedia(query).matches, () => false);
}

export function App() {
  return (
    <AuthGate>{(gate) => (
      <ConsoleAccessProvider>
        <TerminalRelayProvider><ConsoleShell gate={gate} /></TerminalRelayProvider>
      </ConsoleAccessProvider>
    )}</AuthGate>
  );
}

function ConsoleShell({ gate }: { gate: AuthGateState }) {
  const path = useSyncExternalStore(subscribe, currentPath, () => '');
  const navAvailability = useNavAvailability();
  const { id: routeId, params, aliasedFrom, notFoundPath } = matchRoute(path);
  const route = routes.find((candidate) => candidate.id === routeId);
  const bottomBar = useMediaQuery(BOTTOM_BAR_VIEWPORT);
  const narrowViewport = useMediaQuery(RAIL_VIEWPORT);
  const [preference, setPreference] = useState<SidebarState>('expanded');
  const mainRef = useRef<HTMLElement>(null);
  const focusedRoute = useRef<string | null>(null);
  // With the bottom bar there is no rail; between 761 and 1100 the viewport decides and the choice has no say.
  const rail = !bottomBar && (narrowViewport || preference === 'rail');
  const collapsible = !narrowViewport;

  const toggleSidebar = useCallback(() => {
    setPreference((prev) => (prev === 'rail' ? 'expanded' : 'rail'));
  }, []);

  useEffect(() => {
    if (!collapsible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'KeyB' || !event.altKey || !event.shiftKey) return;
      if (event.ctrlKey || event.metaKey) return;
      // Whoever is typing —or the terminal, which passes Alt+… to the shell— keeps its keys.
      const target = event.target;
      if (target instanceof Element
        && target.closest('input, textarea, select, [contenteditable="true"], .xterm')) return;
      event.preventDefault();
      toggleSidebar();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); };
  }, [collapsible, toggleSidebar]);

  useEffect(() => {
    if (!aliasedFrom) return;
    const detalle = params.map((param) => encodeURIComponent(param)).join('/');
    redirect(`/${routeId}${detalle ? `/${detalle}` : ''}`);
  }, [aliasedFrom, params, routeId]);

  /* The rewrite of `/audit` to `/observability` used to take the requested tab with it. The intent
     survives it —the view is still loading— and is dropped on leaving the route. */
  const auditoriaPedida = useRef(false);
  if (aliasedFrom === 'audit') auditoriaPedida.current = true;
  else if (routeId !== 'observability') auditoriaPedida.current = false;

  const Page = route?.component;
  const terminalTarget = !notFoundPath && routeId === 'terminal' && params.length === 2
    ? { tenantId: params[0], alias: params[1] }
    : undefined;
  const terminalTargetAlias = terminalTarget?.alias;
  const viewTitle = notFoundPath ? NOT_FOUND_TITLE : terminalTargetAlias ?? route?.label;

  useEffect(() => {
    document.title = viewTitle ? `${viewTitle} · ${CONSOLE_TITLE}` : CONSOLE_TITLE;
  }, [viewTitle]);

  useEffect(() => {
    // The first paint does not steal focus: only the route change is announced.
    const key = `${routeId}\u0000${notFoundPath ?? ''}\u0000${terminalTargetAlias ?? ''}`;
    if (focusedRoute.current === null) { focusedRoute.current = key; return; }
    if (focusedRoute.current === key) return;
    focusedRoute.current = key;
    mainRef.current?.focus({ preventScroll: true });
  }, [routeId, notFoundPath, terminalTargetAlias]);

  return (
    <div className="app-shell" data-sidebar={rail ? 'rail' : 'expanded'}>
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Activity size={22} /></span>
          <div><strong>Cauce</strong><small>V3 Console</small></div>
        </div>
        {collapsible ? (
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggleSidebar}
            aria-expanded={!rail}
            aria-controls={NAV_ID}
            aria-keyshortcuts={SIDEBAR_SHORTCUT}
            aria-label={rail ? 'Desplegar barra lateral' : 'Plegar barra lateral'}
            title={`${rail ? 'Desplegar' : 'Plegar'} barra lateral (${SIDEBAR_SHORTCUT})`}
          >
            {rail ? <PanelLeftOpen size={18} aria-hidden={true} /> : <PanelLeftClose size={18} aria-hidden={true} />}
            <span>{rail ? 'Desplegar barra lateral' : 'Plegar barra lateral'}</span>
          </button>
        ) : null}
        <nav id={NAV_ID} aria-label="Navegación principal">
          <ul>
            {MENU.map((item) => {
              const Icon = item.icon;
              const disponible = navAvailability(item.id);
              if (disponible.hidden) return null;
              return (
                <li key={item.id}>
                  <a
                    href={`/${item.id}`}
                    onClick={(event) => { onNavClick(event, `/${item.id}`, disponible.reason); }}
                    aria-current={!notFoundPath && route?.id === item.id ? 'page' : undefined}
                    aria-disabled={disponible.disabled ? true : undefined}
                    className={disponible.disabled ? 'nav-inerte' : undefined}
                    // On the rail, CSS hides the label: without `aria-label` the link is left anonymous.
                    aria-label={item.label}
                    title={disponible.reason ?? (rail ? item.label : undefined)}
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
        <main id="main-content" ref={mainRef} tabIndex={-1}>
          {gate.status === 'unmanaged' ? <UnmanagedAuthBanner /> : null}
          {notFoundPath
            ? <RouteNotFound path={notFoundPath} />
            : Page
            ? (
              <Page
                initialTab={auditoriaPedida.current ? 'auditoria' : undefined}
                tenantId={terminalTarget?.tenantId}
                alias={terminalTarget?.alias}
              />
            )
            : null}
        </main>
      </div>
    </div>
  );
}

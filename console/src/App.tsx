import {
  Activity,
  PanelLeftClose,
  PanelLeftOpen,
  ArrowLeft,
} from 'lucide-react';
import {
  lazy, Suspense, useCallback, useEffect, useRef, useState, useSyncExternalStore,
  type ComponentType,
} from 'react';
import { ConsoleAccessProvider } from './api/console-access';
import { BOTTOM_BAR_VIEWPORT, RAIL_VIEWPORT } from './breakpoints';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConsoleNavigation } from './components/ConsoleNavigation';
import { useNavigationHint } from './components/use-navigation-hint';
import { ConversationDrafts, ConversationDraftStore } from './features/messages/conversation-drafts';
import { AuthGate, UnmanagedAuthBanner } from './features/auth/AuthGate';
import { AccountMenu } from './features/auth/AccountMenu';
import type { AuthGateState } from './features/auth/auth-session';
import { NAV_ENTRIES } from './nav';
import { onNavClick, redirect, useRouteSegments } from './router';

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

/** Optional state carried by routed views: the audit tab and the segments past the route id. */
interface RoutePageProps {
  initialTab?: 'senales' | 'auditoria';
  params?: readonly string[];
}

const LandingPage = deferredPage(async () => ({
  default: (await import('./features/landing/LandingPage')).LandingPage,
}));
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
const HelpPage = deferredPage(async () => ({
  default: (await import('./features/help/HelpPage')).HelpPage,
}));
import { TerminalRelayProvider } from './features/terminal/relay-status';

interface Route {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  component: ComponentType<RoutePageProps>;
  arity?: number;
}

const DEEP_ROUTE_ARITY: Partial<Record<string, number>> = { messages: 2, terminal: 2 };

const PAGES: Record<string, ComponentType<RoutePageProps>> = {
  overview: LandingPage,
  live: LiveFleetPage,
  accounts: AccountsPage,
  messages: MessagesPage,
  queues: QueuesPage,
  observability: ObservabilityPage,
  config: ConfigPage,
  terminal: TerminalPage,
  ayuda: HelpPage,
};

const routes: Route[] = NAV_ENTRIES.map((entry) => ({
  id: entry.id,
  label: entry.label,
  icon: entry.icon,
  component: PAGES[entry.id],
  arity: DEEP_ROUTE_ARITY[entry.id],
}));

/** Redirects of obsolete or consolidated routes to their canonical views. */
const ROUTE_ALIASES: Partial<Record<string, string>> = {
  '': 'messages',
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

/** Retired DETAIL routes: only their deep form redirects, at the arity of the heir that absorbed it. */
const LEGACY_DETAIL_REDIRECTS: Partial<Record<string, string>> = { fleet: 'terminal' };

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
          <a href="/messages" onClick={(event) => { onNavClick(event, '/messages'); }}>Abrir conversaciones</a>
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

/** ONE map resolves a deep address —`LEGACY_DETAIL_REDIRECTS`— and another a bare one. A segment
    count that is neither zero (the bare id is always valid) nor the route's `arity` fails closed,
    so a link to an undeclared subroute is an explicit 404 and never another view. */
function matchRoute(segments: readonly string[]): RouteMatch {
  const requested = segments[0] ?? '';
  const params = segments.slice(1);
  const target = params.length > 0 ? LEGACY_DETAIL_REDIRECTS[requested] : ROUTE_ALIASES[requested];
  const id = target ?? requested;
  const route = routes.find((candidate) => candidate.id === id);
  const arityMatches = params.length === 0 || params.length === route?.arity;
  return route && arityMatches
    ? { id, params, aliasedFrom: target !== undefined ? requested : undefined }
    : { id: requested, params, notFoundPath: `/${segments.join('/')}` };
}

/** Rail (78px, icons only) or full bar (212px, with labels). */
type SidebarState = 'rail' | 'expanded';

const SIDEBAR_SHORTCUT = 'Alt+Shift+B';
const NAV_ID = 'nav-principal';
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
  const segments = useRouteSegments();
  const path = segments.join('/');
  const { id: routeId, params, aliasedFrom, notFoundPath } = matchRoute(segments);
  const route = routes.find((candidate) => candidate.id === routeId);
  const bottomBar = useMediaQuery(BOTTOM_BAR_VIEWPORT);
  const navigationHint = useNavigationHint(bottomBar, path);
  const narrowViewport = useMediaQuery(RAIL_VIEWPORT);
  const [drafts] = useState(() => new ConversationDraftStore());
  const lastConversation = useRef('/messages');
  if (routeId === 'messages' && !notFoundPath) lastConversation.current = window.location.pathname;
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
    if (aliasedFrom === undefined) return;
    const detalle = params.map((param) => encodeURIComponent(param)).join('/');
    redirect(`/${routeId}${detalle ? `/${detalle}` : ''}`);
  }, [aliasedFrom, params, routeId]);

  /* The rewrite of `/audit` to `/observability` used to take the requested tab with it. The intent
     survives it —the view is still loading— and is dropped on leaving the route. */
  const auditoriaPedida = useRef(false);
  if (aliasedFrom === 'audit') auditoriaPedida.current = true;
  else if (routeId !== 'observability') auditoriaPedida.current = false;

  const Page = route?.component;
  const terminalTargetAlias = !notFoundPath && routeId === 'terminal' ? params[1] : undefined;
  const viewTitle = notFoundPath ? NOT_FOUND_TITLE : terminalTargetAlias ?? route?.label;
  const boundaryLabel = route?.label ?? 'Esta vista';

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
    <ConversationDrafts.Provider value={drafts}>
    <div className="app-shell" data-sidebar={rail ? 'rail' : 'expanded'} data-view={routeId === 'messages' ? 'chat' : 'tools'}>
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <aside className="sidebar" {...navigationHint.bindings}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><Activity size={22} /></span>
          <div><strong>Cauce</strong><small>Tu equipo de agentes</small></div>
        </div>
        <ConsoleNavigation key={path} id={NAV_ID} rail={rail} routeId={notFoundPath ? '' : routeId} />
        <AccountMenu routeKey={`${routeId}/${params.join('/')}`} gate={gate} />
        {navigationHint.hint}
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
          </button>
        ) : null}
      </aside>
      <div className="workspace">
        {routeId !== 'messages' ? <header className="topbar" data-route={routeId}>
          <a className="back-to-chat" aria-label="Volver a la conversación" href={lastConversation.current} onClick={(event) => { onNavClick(event, lastConversation.current); }}><ArrowLeft size={16} aria-hidden="true" /><span>Volver a la conversación</span></a>
          {routeId === 'terminal' ? <div id="terminal-topbar-tools" className="terminal-topbar-tools" /> : null}
        </header> : null}
        <main id="main-content" data-route={routeId} ref={mainRef} tabIndex={-1}>
          {import.meta.env.VITE_USE_MOCKS === 'true' || gate.status === 'unmanaged' ? <div className="shell-notices">
            {import.meta.env.VITE_USE_MOCKS === 'true' ? <span className="mock-flag" role="status">MOCK API</span> : null}
            {gate.status === 'unmanaged' ? <UnmanagedAuthBanner /> : null}
          </div> : null}
          {notFoundPath
            ? <RouteNotFound path={notFoundPath} />
            : Page
            ? (
              <ErrorBoundary label={boundaryLabel} resetKey={path}>
                <Page initialTab={auditoriaPedida.current ? 'auditoria' : undefined} params={params} />
              </ErrorBoundary>
            )
            : null}
        </main>
      </div>
    </div>
    </ConversationDrafts.Provider>
  );
}

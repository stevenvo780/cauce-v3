import {
  lazy, Suspense, useEffect, useRef, useState,
  type ComponentType,
} from 'react';
import { ConsoleAccessProvider } from './api/console-access';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConversationDrafts, ConversationDraftStore } from './features/messages/conversation-drafts';
import { AuthGate, UnmanagedAuthBanner } from './features/auth/AuthGate';
import { AccountMenu } from './features/auth/AccountMenu';
import type { AuthGateState } from './features/auth/auth-session';
import { NAV_ENTRIES } from './nav';
import { onNavClick, redirect, useRouteSearch, useRouteSegments } from './router';
import { AppShell } from './shell/AppShell';
import { FleetProvider } from './shell/fleet';
import { fleetAgentId } from './features/terminal/fleet';

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
const CONSOLE_TITLE = 'Cauce';
const NOT_FOUND_TITLE = 'Ruta no encontrada';

export function App() {
  return (
    <AuthGate>{(gate) => (
      <ConsoleAccessProvider>
        <TerminalRelayProvider>
          <CSPProvider disableStyleElements>
            <FleetProvider><ConsoleShell gate={gate} /></FleetProvider>
          </CSPProvider>
        </TerminalRelayProvider>
      </ConsoleAccessProvider>
    )}</AuthGate>
  );
}

function ConsoleShell({ gate }: { gate: AuthGateState }) {
  const segments = useRouteSegments();
  const path = segments.join('/');
  const { id: routeId, params, aliasedFrom, notFoundPath } = matchRoute(segments);
  const route = routes.find((candidate) => candidate.id === routeId);
  const search = useRouteSearch();
  const [drafts] = useState(() => new ConversationDraftStore());
  const mainRef = useRef<HTMLElement>(null);
  const focusedRoute = useRef<string | null>(null);

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

  const liveAgent = routeId === 'live' ? new URLSearchParams(search).get('agente') ?? undefined : undefined;
  const activeAgentId = !notFoundPath && params.length === 2
    ? fleetAgentId(params[0], params[1])
    : liveAgent?.includes('/') ? fleetAgentId(liveAgent.slice(0, liveAgent.indexOf('/')), liveAgent.slice(liveAgent.indexOf('/') + 1)) : undefined;
  const fullBleed = routeId === 'messages' || routeId === 'terminal' || routeId === 'live';
  const mocks = import.meta.env.VITE_USE_MOCKS === 'true';

  return (
    <ConversationDrafts.Provider value={drafts}>
      <AppShell
        routeId={notFoundPath ? '' : routeId}
        activeAgentId={activeAgentId}
        bounded={!notFoundPath && (routeId === 'messages' || routeId === 'terminal')}
        account={(
          <div className="grid w-full gap-1">
            {mocks ? <span className="mock-flag mx-auto rounded-full bg-warn-soft px-2 py-0.5 text-[10px] font-semibold tracking-wide text-warn-ink" role="status">MOCK API</span> : null}
            <AccountMenu routeKey={`${routeId}/${params.join('/')}`} gate={gate} />
          </div>
        )}
        notices={gate.status === 'unmanaged' ? <UnmanagedAuthBanner /> : null}
      >
        <main
          id="main-content"
          data-route={routeId}
          ref={mainRef}
          tabIndex={-1}
          className={fullBleed
            ? 'flex min-h-0 w-full flex-1 flex-col max-[760px]:pb-[calc(56px+env(safe-area-inset-bottom))] max-[760px]:has-[[data-keyboard-open]]:pb-0'
            : 'mx-auto w-full max-w-[1400px] flex-1 px-4 pt-4 pb-[calc(72px+env(safe-area-inset-bottom))] min-[761px]:px-8 min-[761px]:pt-6 min-[761px]:pb-10'}
        >
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
      </AppShell>
    </ConversationDrafts.Provider>
  );
}

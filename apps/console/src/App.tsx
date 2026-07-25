import {
  Activity,
  Bot,
  Boxes,
  CreditCard,
  GitFork,
  Grid3x3,
  History,
  Settings2,
  ListRestart,
  MessageSquareText,
  SendToBack,
  RadioTower,
  ShieldCheck,
  Gauge,
  TerminalSquare,
  LogIn,
  LogOut,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ComponentType } from 'react';
import { useApi } from './api/context';
import type { ConsoleAuthState } from './api/types';
import { FleetAgentDetailPage } from './features/fleet/FleetAgentDetailPage';
import { FleetPage } from './features/fleet/FleetPage';
import { TopologyPage } from './features/topology/TopologyPage';
import { MessagesPage } from './features/messages/MessagesPage';
import { QueuesPage } from './features/queues/QueuesPage';
import { JobsPage } from './features/jobs/JobsPage';
import { AdaptersPage } from './features/adapters/AdaptersPage';
import { AuditPage } from './features/audit/AuditPage';
import { TerminalPage } from './features/terminal/TerminalPage';
import { RelaysPage } from './features/relays/RelaysPage';
import { ConfigPage } from './features/config/ConfigPage';
import { AccountsPage } from './features/accounts/AccountsPage';
import { AssignmentMatrixPage } from './features/accounts/AssignmentMatrixPage';
import { ObservabilityPage } from './features/observability/ObservabilityPage';

interface Route {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  component: ComponentType;
}

const routes: Route[] = [
  { id: 'fleet', label: 'Fleet', icon: RadioTower, component: FleetPage },
  { id: 'topology', label: 'Tenants & ACL', icon: GitFork, component: TopologyPage },
  { id: 'messages', label: 'Messages', icon: MessageSquareText, component: MessagesPage },
  { id: 'queues', label: 'Queues & DLQ', icon: ListRestart, component: QueuesPage },
  { id: 'jobs', label: 'Jobs', icon: Boxes, component: JobsPage },
  { id: 'adapters', label: 'Adapters', icon: Bot, component: AdaptersPage },
  { id: 'relays', label: 'Origin relays', icon: SendToBack, component: RelaysPage },
  { id: 'audit', label: 'Audit', icon: History, component: AuditPage },
  { id: 'observability', label: 'Observability', icon: Gauge, component: ObservabilityPage },
  { id: 'accounts', label: 'Cuentas de IA', icon: CreditCard, component: AccountsPage },
  { id: 'assignments', label: 'Matriz agente × cuenta', icon: Grid3x3, component: AssignmentMatrixPage },
  { id: 'config', label: 'Configuration', icon: Settings2, component: ConfigPage },
  { id: 'terminal', label: 'Ultimate Terminal', icon: TerminalSquare, component: TerminalPage },
];

interface RouteMatch {
  id: string;
  /** Segmentos posteriores al id de ruta, ej. `#/fleet/:tenant/:alias` → ['tenant', 'alias']. */
  params: string[];
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
  const id = segments[0] ?? '';
  return routes.some((route) => route.id === id)
    ? { id, params: segments.slice(1) }
    : { id: 'fleet', params: [] };
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('popstate', callback);
  return () => window.removeEventListener('popstate', callback);
}

function AuthStatus() {
  const api = useApi();
  const [state, setState] = useState<ConsoleAuthState>();
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getAuthSession().then((next) => {
      if (active) setState(next);
    }).catch(() => {
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [api]);

  if (error) return <span className="auth-state auth-unknown">Auth no disponible</span>;
  if (!state) return <span className="auth-state">Verificando sesión…</span>;
  if (state.authenticated === null) return <span className="auth-state auth-unknown">Auth administrada por gateway</span>;
  if (!state.authenticated) {
    return <a className="button small auth-action" href={api.getLoginUrl()}><LogIn size={14} aria-hidden="true" /> Iniciar sesión</a>;
  }
  return (
    <div className="auth-state authenticated">
      <span><strong>Sesión OIDC</strong>{state.subject ?? 'Identidad verificada'}</span>
      <button className="button small secondary" type="button" onClick={() => {
        void api.logout().then(() => setState({ authenticated: false })).catch(() => setError(true));
      }}><LogOut size={14} aria-hidden="true" /> Cerrar sesión</button>
    </div>
  );
}

export function App() {
  const path = useSyncExternalStore(subscribe, currentPath, () => 'fleet');
  const { id: routeId, params } = matchRoute(path);
  const route = routes.find((candidate) => candidate.id === routeId) ?? routes[0];
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
                  <a href={`/${item.id}`} aria-current={route.id === item.id ? 'page' : undefined}>
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
            <AuthStatus />
          </div>
        </header>
        <main id="main-content" tabIndex={-1}>
          {fleetAgentTarget
            ? <FleetAgentDetailPage tenantId={fleetAgentTarget.tenantId} alias={fleetAgentTarget.alias} />
            : <Page />}
        </main>
      </div>
    </div>
  );
}

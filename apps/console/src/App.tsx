import {
  Activity,
  Bot,
  Boxes,
  GitFork,
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
  { id: 'config', label: 'Configuration', icon: Settings2, component: ConfigPage },
  { id: 'terminal', label: 'Ultimate Terminal', icon: TerminalSquare, component: TerminalPage },
];

function currentRoute(): string {
  const value = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return routes.some((route) => route.id === value) ? value : 'fleet';
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
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
  const routeId = useSyncExternalStore(subscribe, currentRoute, () => 'fleet');
  const route = routes.find((candidate) => candidate.id === routeId) ?? routes[0];
  const Page = route.component;

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
                  <a href={`#/${item.id}`} aria-current={route.id === item.id ? 'page' : undefined}>
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
          <Page />
        </main>
      </div>
    </div>
  );
}

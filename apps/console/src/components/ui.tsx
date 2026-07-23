import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConsoleAccess, ConsolePermission } from '../api/types';
import { display, permissionState, timestamp, UNKNOWN } from '../lib';

export function PageHeader({ eyebrow, title, description, actions }: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({ title, subtitle, children, className = '' }: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`.trim()}>
      {title || subtitle ? (
        <header className="panel-header">
          {title ? <h2>{title}</h2> : null}
          {subtitle ? <p>{subtitle}</p> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Metric({ label, value, tone = 'neutral', detail }: {
  label: string;
  value: unknown;
  tone?: 'neutral' | 'positive' | 'warning' | 'danger';
  detail?: string;
}) {
  return (
    <article className={`metric metric-${tone}`}>
      <p>{label}</p>
      <strong>{display(value)}</strong>
      {detail ? <span>{detail}</span> : null}
    </article>
  );
}

export function Badge({ children, tone = 'unknown' }: {
  children: ReactNode;
  tone?: 'online' | 'done' | 'running' | 'warning' | 'danger' | 'offline' | 'unknown' | 'info';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Unknown({ value }: { value: unknown }) {
  const text = display(value);
  return <span className={text === UNKNOWN ? 'unknown' : undefined}>{text}</span>;
}

export function Time({ value }: { value: unknown }) {
  const formatted = timestamp(value);
  return (
    <time className={formatted === UNKNOWN ? 'unknown' : undefined} dateTime={typeof value === 'string' ? value : undefined}>
      {formatted}
    </time>
  );
}

export function LoadingState({ label = 'Cargando datos del servidor…' }: { label?: string }) {
  return (
    <div className="state-card" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div className="state-card state-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>No se pudo leer Cauce V3</strong>
        <p>{error.message || UNKNOWN}</p>
      </div>
      <button type="button" className="button secondary" onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" /> Reintentar
      </button>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function RefreshButton({ onClick, loading = false }: { onClick: () => void; loading?: boolean }) {
  return (
    <button type="button" className="button secondary" onClick={onClick} disabled={loading}>
      <RefreshCw size={16} aria-hidden="true" /> {loading ? 'Actualizando…' : 'Actualizar'}
    </button>
  );
}

export function PermissionBadge({ access, permission }: { access?: ConsoleAccess; permission: ConsolePermission }) {
  const state = permissionState(access, permission);
  const label = state === 'allowed' ? 'ALLOW' : state === 'denied' ? 'DENY' : 'UNKNOWN';
  return (
    <span className="permission-line">
      <span>RBAC <span className="mono">{permission}</span></span>
      <Badge tone={state === 'allowed' ? 'online' : state === 'denied' ? 'danger' : 'unknown'}>{label}</Badge>
      <span className="muted">Roles: {access?.roles?.length ? access.roles.join(', ') : UNKNOWN}</span>
    </span>
  );
}

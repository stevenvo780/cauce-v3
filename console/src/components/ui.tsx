import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { TIEMPO_MAXIMO_MS } from '../api/client';
import type { ConsoleAccess, ConsolePermission } from '../api/types';
import { display, haceCuanto, permissionState, timestamp, timestampExacto, NO_APLICA, TODAVIA_NO, UNKNOWN } from '../lib';

// Re-export so the rest of the console keeps importing its visual vocabulary from a single place.
export { FloatingTooltip, Tooltip, TOOLTIP_DELAY_MS } from './Tooltip';
export type { FloatingTooltipProps, TooltipPlacement, TooltipProps } from './Tooltip';

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

/**
 * A value from the server, or the exact word used to say it is not there.
 *
 * `ausente` exists because "I don't know", "not yet due" and "not applicable" are NOT the same:
 * the console used to say them all the same way. The LOGIC is untouched —still an absence, still
 * not a permission, still carrying the `.unknown` class so it shows. What gets chosen is the word.
 *
 *  - `sin-dato` (default) — there was never a value or it could not be read.
 *  - `todavia-no` — the value does not exist yet because the event has not occurred: a `pending`
 *    delivery has no "last error" because it has not failed yet, and painting it orange as if it
 *    were an unknown is exactly the false positive that raises the threshold and blinds the rest.
 *  - `no-aplica` — it does not exist for this row. A dash, in muted grey and not amber: there is
 *    nothing to claim.
 */
export function Unknown({ value, ausente = 'sin-dato', motivo }: {
  value: unknown;
  ausente?: 'sin-dato' | 'todavia-no' | 'no-aplica';
  /** Hangs off `title=` when the value is missing: why it is missing, if known. */
  motivo?: string;
}) {
  const text = display(value);
  if (text !== UNKNOWN) return <span>{text}</span>;
  const palabra = ausente === 'todavia-no' ? TODAVIA_NO : ausente === 'no-aplica' ? NO_APLICA : UNKNOWN;
  return (
    <span
      className={ausente === 'no-aplica' ? 'muted' : 'unknown'}
      title={motivo}
      // The dash is decorative for the listener: it is the phrase that gets announced, not the character.
      aria-label={ausente === 'no-aplica' ? 'no aplica' : undefined}
    >
      {palabra}
    </span>
  );
}

/**
 * A timestamp from the server. No seconds on display, with the exact instant in the `title=`.
 *
 * `relativo` is for columns whose real question is *how long ago*: a wall clock there forces
 * mental subtraction. The absolute date is never lost — it goes into the `title=` along with the
 * seconds and the timezone, where seconds do serve to cross-check against a log.
 */
export function Time({ value, relativo = false }: { value: unknown; relativo?: boolean }) {
  const formatted = timestamp(value);
  const exacto = timestampExacto(value);
  const relativa = relativo ? haceCuanto(value) : undefined;
  const visible = relativa ?? formatted;
  return (
    <time
      className={formatted === UNKNOWN ? 'unknown' : undefined}
      dateTime={typeof value === 'string' ? value : undefined}
      title={formatted === UNKNOWN ? undefined : relativa ? exacto : exacto}
    >
      {visible}
    </time>
  );
}

/**
 * From what point a loading label stops being informative and becomes a mute spinner.
 *
 * Not a matter of taste: the reference measured against a starved production (90% steal time)
 * is `/v3/console/activity` at 0.8 s and `/v3/console/messages` at 4.9 s. Twelve seconds do not
 * interrupt any healthy read and arrive well before the `TIEMPO_MAXIMO_MS` cutoff, which is
 * exactly what is needed to be able to announce it.
 */
export const PACIENCIA_MS = 12_000;

/**
 * Loading state card with a long-wait notice and a configurable timeout.
 */
export function LoadingState({ label = 'Cargando datos del servidor…', paciencia = PACIENCIA_MS }: {
  label?: string;
  /** Only for tests and for whoever has a legitimately longer wait. `0` turns it off. */
  paciencia?: number;
}) {
  const [tardando, setTardando] = useState(false);
  useEffect(() => {
    setTardando(false);
    if (!(paciencia > 0)) return undefined;
    const reloj = setTimeout(() => { setTardando(true); }, paciencia);
    return () => { clearTimeout(reloj); };
  }, [paciencia]);

  return (
    <div className="state-card" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <div className="state-card-texto">
        <p>{label}</p>
        {tardando ? (
          <p className="state-card-lento">
            Está tardando más de lo normal: el gateway va lento. La espera se corta sola a los{' '}
            {Math.round(TIEMPO_MAXIMO_MS / 1000)} s y vas a poder reintentar.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorState({ error, onRetry, reintentando = false }: {
  error: Error;
  onRetry: () => void;
  /** Indicates whether a read request is in flight. */
  reintentando?: boolean;
}) {
  return (
    <div className="state-card state-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>No se pudo leer Cauce V3</strong>
        <p>{error.message || UNKNOWN}</p>
        {reintentando ? (
          <p className="state-card-lento">
            Hay una lectura en curso. Si el servidor tampoco contesta a ésta, se corta a los{' '}
            {Math.round(TIEMPO_MAXIMO_MS / 1000)} s y este mensaje se queda.
          </p>
        ) : null}
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

/**
 * Accessible tabs component to switch views within a page.
 */
export function ViewTabs<T extends string>({ tabs, active, onSelect, label }: {
  tabs: readonly { id: T; label: string; badge?: ReactNode }[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
}) {
  return (
    <div className="view-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`view-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={`view-panel-${tab.id}`}
          className="view-tab"
          onClick={() => { onSelect(tab.id); }}
        >
          {tab.label}
          {tab.badge == null ? null : <span className="view-tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * The panel of a tab.
 *
 * `hidden` exists for merges that carry **forms** inside tabs: unmounting the inactive panel drops
 * the React state, so starting an account signup, going to check consumption and coming back
 * left the form blank. An operator-entered value that disappears when switching tabs is a
 * regression the merge has no business causing.
 *
 * It is hidden with the `hidden` attribute, not `display:none` in a class, because `hidden` pulls
 * the panel out of the accessibility tree: a screen reader does not announce the contents of the
 * tab that is not open, and `getByRole` cannot find it either — which forces tests to actually
 * open the tab instead of stumbling onto a hidden node by accident.
 *
 * Whoever has no state to preserve (or whose content costs a request) keeps mounting the panel
 * conditionally: see `ObservabilityPage`, which only mounts the audit when asked.
 */
export function ViewTabPanel({ id, labelledBy, hidden = false, children }: {
  id: string;
  labelledBy?: string;
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div id={`view-panel-${id}`} role="tabpanel" tabIndex={hidden ? -1 : 0} hidden={hidden} aria-labelledby={labelledBy ?? `view-tab-${id}`} className="view-tab-panel">
      {children}
    </div>
  );
}

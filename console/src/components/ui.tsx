import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { TIEMPO_MAXIMO_MS } from '../api/client';
import type { ConsoleAccess, ConsolePermission } from '../api/types';
import { display, haceCuanto, permissionState, timestamp, timestampExacto, NO_APLICA, TODAVIA_NO, UNKNOWN } from '../lib';
import { cn } from '../cn';
import { TONE_CLASS, type Tone } from '../status-tone';
import { Button, Spinner, StateCard } from './kit';
import { PageHelp } from './PageHelp';
import { useRovingTabs } from './use-roving-tabs';

// Re-export so the rest of the console keeps importing its visual vocabulary from a single place.
export { FloatingTooltip, Tooltip } from './Tooltip';
export { Desplazable } from './Desplazable';
export type { FloatingTooltipProps, TooltipPlacement, TooltipProps } from './Tooltip';

export function PageHeader({ eyebrow, title, description, notes, actions }: {
  eyebrow: string;
  title: string;
  description: string;
  notes?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex items-end justify-between gap-x-6 gap-y-3 sm:flex-wrap">
      <div className="min-w-0 max-sm:flex-1">
        <p className="m-0 text-xs font-semibold tracking-wide text-brand-ink">{eyebrow}</p>
        <div className="mt-0.5 flex items-center gap-2">
          <h1 className="m-0 text-[22px] font-semibold tracking-tight text-fg">{title}</h1>
          <PageHelp title={title} description={description}>{notes}</PageHelp>
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center justify-end gap-2 max-sm:shrink-0">{actions}</div> : null}
    </header>
  );
}

export const BADGE_TONE = {
  online: 'ok', done: 'ok', running: 'info', info: 'info', warning: 'warn', danger: 'danger', offline: 'neutral', unknown: 'neutral',
} as const satisfies Record<string, Tone>;

export function Badge({ children, tone = 'unknown' }: { children: ReactNode; tone?: keyof typeof BADGE_TONE }) {
  return (
    <span data-tone={tone}
      className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap', TONE_CLASS[BADGE_TONE[tone]].pill)}>
      {children}
    </span>
  );
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
    <StateCard role="status" aria-live="polite">
      <Spinner />
      <div className="grid gap-1">
        <p>{label}</p>
        {tardando ? (
          <p className="text-xs text-muted">
            Está tardando más de lo normal: el gateway va lento. La espera se corta sola a los{' '}
            {Math.round(TIEMPO_MAXIMO_MS / 1000)} s y vas a poder reintentar.
          </p>
        ) : null}
      </div>
    </StateCard>
  );
}

export function ErrorState({ error, onRetry, reintentando = false }: {
  error: Error;
  onRetry: () => void;
  /** Indicates whether a read request is in flight. */
  reintentando?: boolean;
}) {
  return (
    <StateCard tone="danger" role="alert">
      <AlertTriangle aria-hidden="true" />
      <div>
        <strong>No se pudo leer Cauce V3</strong>
        <p>{error.message || UNKNOWN}</p>
        {reintentando ? (
          <p className="text-xs text-muted">
            Hay una lectura en curso. Si el servidor tampoco contesta a ésta, se corta a los{' '}
            {Math.round(TIEMPO_MAXIMO_MS / 1000)} s y este mensaje se queda.
          </p>
        ) : null}
      </div>
      <Button onClick={onRetry}>
        <RefreshCw size={16} aria-hidden="true" /> Reintentar
      </Button>
    </StateCard>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="m-0 rounded-lg border border-dashed border-line-strong p-6 text-center text-[13px] text-muted">{children}</p>;
}

export function RefreshButton({ onClick, loading = false, compact = false }: {
  onClick: () => void;
  loading?: boolean;
  compact?: boolean;
}) {
  const label = loading ? 'Actualizando…' : 'Actualizar';
  return (
    <Button
      onClick={onClick}
      disabled={loading}
      {...(compact ? { 'aria-label': label, title: label } : {})}
    >
      <RefreshCw size={16} aria-hidden="true" />{compact ? <span className="sr-only">{label}</span> : label}
    </Button>
  );
}

export function PermissionBadge({ access, permission }: { access?: ConsoleAccess; permission: ConsolePermission }) {
  const state = permissionState(access, permission);
  const label = state === 'allowed' ? 'ALLOW' : state === 'denied' ? 'DENY' : 'UNKNOWN';
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span>RBAC <span className="mono">{permission}</span></span>
      <Badge tone={state === 'allowed' ? 'online' : state === 'denied' ? 'danger' : 'unknown'}>{label}</Badge>
      <span className="muted">Roles: {access?.roles?.length ? access.roles.join(', ') : UNKNOWN}</span>
    </span>
  );
}

/**
 * Accessible tabs component to switch views within a page.
 */
interface ViewTab<T extends string> {
  id: T;
  label: ReactNode;
  badge?: ReactNode;
}

export function ViewTabs<T extends string>({
  tabs, active, onSelect, label, variant = 'page', panelId,
}: {
  tabs: readonly ViewTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  label: string;
  variant?: 'page' | 'panel' | 'chip';
  panelId?: string;
}) {
  const roving = useRovingTabs(tabs.length, (index) => { onSelect(tabs[index].id); });
  return (
    <div
      className={cn(
        'flex max-w-full items-center overflow-x-auto',
        variant === 'page' && 'mb-4 gap-1 border-b border-line',
        variant === 'panel' && 'mb-3 inline-flex gap-0.5 rounded-lg bg-muted-bg p-0.5',
        variant === 'chip' && 'mb-3 flex-wrap gap-1.5',
      )}
      role="tablist"
      aria-label={label}
      data-variant={variant}
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`view-tab-${tab.id}`}
          aria-selected={active === tab.id}
          aria-controls={panelId ?? `view-panel-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={cn(
            'inline-flex shrink-0 cursor-pointer items-center gap-1.5 border-0 bg-transparent text-[13px] font-medium whitespace-nowrap text-muted transition-colors hover:text-fg',
            variant === 'page' && '-mb-px border-b-2 border-transparent px-3 py-2 aria-selected:border-brand aria-selected:text-fg',
            variant === 'panel' && 'rounded-md px-3 py-1 aria-selected:bg-surface aria-selected:text-fg aria-selected:shadow-card',
            variant === 'chip' && 'rounded-full border border-line px-3 py-1 aria-selected:border-transparent aria-selected:bg-brand-soft aria-selected:text-brand-ink',
          )}
          ref={roving.tabRef(index)}
          onClick={() => { onSelect(tab.id); }}
          onKeyDown={(event) => { roving.onKeyDown(event, index); }}
        >
          {tab.label}
          {tab.badge == null ? null : <span className="rounded-full bg-muted-bg px-1.5 text-[11px] tabular-nums text-fg-2">{tab.badge}</span>}
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
    <div id={`view-panel-${id}`} role="tabpanel" tabIndex={hidden ? -1 : 0} hidden={hidden} aria-labelledby={labelledBy ?? `view-tab-${id}`} className="outline-none">
      {children}
    </div>
  );
}

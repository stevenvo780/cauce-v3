import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConsoleAccess, ConsolePermission } from '../api/types';
import { display, haceCuanto, permissionState, timestamp, timestampExacto, NO_APLICA, TODAVIA_NO, UNKNOWN } from '../lib';

// Re-export para que el resto de la consola siga importando su vocabulario visual de un solo sitio.
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
 * Un valor del servidor, o la palabra exacta con la que se dice que no está.
 *
 * `ausente` existe porque «no lo sé», «todavía no toca» y «no aplica» NO son lo mismo y la consola
 * los decía todos igual. La LÓGICA no se toca: sigue siendo una ausencia, sigue sin ser un permiso
 * y sigue llevando la clase `.unknown` para que se vea. Lo que se elige es la palabra.
 *
 *  - `sin-dato` (por defecto) — nunca hubo dato o no se pudo leer.
 *  - `todavia-no` — el dato aún no existe porque el hecho no ocurrió: una entrega `pending` no
 *    tiene «último error» porque todavía no falló, y pintar eso de naranja como si fuera un
 *    desconocido es exactamente el falso positivo que sube el umbral y ciega al resto.
 *  - `no-aplica` — no existe para esta fila. Un guión, en gris apagado y no en ámbar: no
 *    tiene nada que reclamar.
 */
export function Unknown({ value, ausente = 'sin-dato', motivo }: {
  value: unknown;
  ausente?: 'sin-dato' | 'todavia-no' | 'no-aplica';
  /** Se cuelga del `title=` cuando el valor falta: por qué falta, si se sabe. */
  motivo?: string;
}) {
  const text = display(value);
  if (text !== UNKNOWN) return <span>{text}</span>;
  const palabra = ausente === 'todavia-no' ? TODAVIA_NO : ausente === 'no-aplica' ? NO_APLICA : UNKNOWN;
  return (
    <span
      className={ausente === 'no-aplica' ? 'muted' : 'unknown'}
      title={motivo}
      // El guión es decorativo para quien escucha: se anuncia la frase, no el carácter.
      aria-label={ausente === 'no-aplica' ? 'no aplica' : undefined}
    >
      {palabra}
    </span>
  );
}

/**
 * Una fecha del servidor. Sin segundos a la vista, con el instante exacto en el `title=`.
 *
 * `relativo` es para las columnas cuya pregunta real es *cuánto hace*: ahí un reloj de pared
 * obliga a restar de cabeza. La fecha absoluta no se pierde nunca — va al `title=` junto con los
 * segundos y la zona, que es donde los segundos sí sirven para cruzar contra un registro.
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
      title={formatted === UNKNOWN ? undefined : relativa ? `${exacto}` : exacto}
    >
      {visible}
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

/**
 * **Pestañas de vista** — el mecanismo con el que la consola dejó de tener dos entradas de menú
 * para el mismo hecho.
 *
 * El 2026-08-22 se fundieron tres pares de vistas redundantes (`/audit` dentro de
 * `/observability`; `/quotas` y `/licenses` dentro de `/accounts`). Fundir NO puede significar
 * apilar dos páginas una debajo de la otra: eso deja una pantalla de cuatro metros que se lee peor
 * que las dos separadas. Cada fusión reparte su contenido en pestañas, y lo que es común a todas
 * —las métricas del mismo instante, la cabecera, el botón de refresco— queda FUERA de las
 * pestañas, visible siempre.
 *
 * Se implementa con `role="tablist"`/`role="tab"` y `aria-selected` en vez de con enlaces: la
 * pestaña no cambia de ruta, y una `<a>` que no navega es una mentira para quien usa lector de
 * pantalla. `aria-controls` apunta al panel, que lleva `role="tabpanel"` y `tabIndex={0}` para que
 * el contenido sea alcanzable con teclado cuando desborda.
 */
export function ViewTabs<T extends string>({ tabs, active, onSelect, label }: {
  tabs: ReadonlyArray<{ id: T; label: string; badge?: ReactNode }>;
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
          onClick={() => onSelect(tab.id)}
        >
          {tab.label}
          {tab.badge == null ? null : <span className="view-tab-badge">{tab.badge}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * El panel de una pestaña.
 *
 * `hidden` existe para las fusiones que llevan **formularios** dentro de las pestañas: desmontar el
 * panel inactivo tira el estado de React, o sea que empezar un alta de cuenta, ir a mirar el
 * consumo y volver dejaba el formulario en blanco. Un dato escrito por el operador que desaparece
 * al cambiar de pestaña es una regresión que la fusión no tiene por qué causar.
 *
 * Se oculta con el atributo `hidden` y no con `display:none` en una clase, porque `hidden` saca el
 * panel del árbol de accesibilidad: un lector de pantalla no anuncia el contenido de la pestaña que
 * no está abierta, y `getByRole` tampoco lo encuentra — lo que hace que las pruebas tengan que
 * abrir la pestaña de verdad en vez de encontrar por casualidad el nodo escondido.
 *
 * Quien no tenga estado que preservar (o cuyo contenido cueste una petición) sigue montando el
 * panel condicionalmente: ver `ObservabilityPage`, que no monta la auditoría hasta que se la pide.
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

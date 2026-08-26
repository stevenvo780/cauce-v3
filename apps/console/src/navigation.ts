import type { MouseEvent } from 'react';
import type { TerminalRelayState } from './features/terminal/relay-status';

/**
 * Navega sin recargar la página. `pushState` no dispara `popstate` por sí solo, así que hay
 * que emitirlo a mano para que el router —que se suscribe a `popstate`— se entere del cambio.
 */
export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Reemplaza la entrada actual del historial en vez de apilar una nueva. Es lo que corresponde para
 * una ruta retirada que redirige a su heredera: con `pushState` el botón "atrás" volvería a la ruta
 * muerta, que redirige de nuevo hacia adelante, y el operador quedaría atrapado sin poder salir.
 */
export function redirect(path: string): void {
  if (window.location.pathname === path) return;
  window.history.replaceState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Los enlaces conservan su `href` real para que sigan funcionando el clic del medio, ctrl+clic,
 * "abrir en pestaña nueva" y el menú contextual. Solo se intercepta el clic izquierdo limpio,
 * que es el único que debería quedarse dentro de la aplicación.
 *
 * `disabledReason`: si está presente, la entrada está deshabilitada (ver
 * `terminalNavAvailability` más abajo) y el clic no debe navegar bajo ninguna circunstancia —
 * ni siquiera con un modificador — porque el destino no tiene nada real detrás.
 */
export function onNavClick(event: MouseEvent<HTMLAnchorElement>, path: string, disabledReason?: string): void {
  if (event.defaultPrevented) return;
  if (disabledReason) {
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

/** Cómo debe presentarse una entrada de menú cuya disponibilidad depende de un backend opcional. */
export interface NavEntryAvailability {
  /** `true`: no renderizar la entrada. */
  hidden: boolean;
  /** `true`: renderizarla inerte (sin navegar) con `reason` como explicación. */
  disabled: boolean;
  /** Motivo de una sola línea, presente siempre que `disabled` sea `true`. */
  reason?: string;
}

/**
 * La entrada "Ultimate Terminal" del menú nunca debe mostrarse como si el canal PTY existiera
 * cuando el relay es opt-in y no está desplegado en este stack (ver commit `0a1d0e3`). Se elige
 * deshabilitar en vez de esconder: un operador frente a un menú más corto no puede distinguir
 * "no está desplegado acá" de "no tengo este permiso", mientras que una entrada visible pero
 * inerte que declara el motivo es la respuesta honesta que pide la tarea. La página en sí sigue
 * siendo alcanzable por URL directa y sigue funcionando en modo feed durable sin PTY; lo único
 * que se apaga es la promesa implícita de "esto tiene una terminal interactiva funcionando".
 */
export function terminalNavAvailability(relay: TerminalRelayState): NavEntryAvailability {
  if (relay.status !== 'unavailable') return { hidden: false, disabled: false };
  return { hidden: false, disabled: true, reason: relay.reason };
}

export const CONFIG_SIN_CONTROL_REASON =
  'Tu cuenta no tiene permiso de control sobre esta flota: Configuración es del dueño del bus.';

export const CONFIG_WRITE_NO_ACREDITADO_REASON =
  'No se pudo acreditar config.write; la vista permanece disponible en solo lectura y no permite cambios ni restauraciones.';

/**
 * La entrada "Configuration" apuntaba a una vista que devuelve 403 para todo el que no tenga
 * `config.write` — o sea, para todos los tenants cliente. Miguel (Miguel:janus) entraba, veía el
 * menú completo, hacía clic y recibía un error: exactamente la queja de "hay muchas vistas y
 * algunas no existen". El permiso NO se toca; lo que se arregla es la promesa del menú.
 *
 * Misma decisión que en `terminalNavAvailability` y por la misma razón: se DESHABILITA en vez de
 * esconder. Un menú más corto no distingue "acá no está desplegado" de "no tengo permiso"; una
 * entrada visible pero inerte que dice el motivo sí. Con el permiso `unknown` -no se pudo leer el
 * RBAC- la entrada queda HABILITADA porque leer y navegar no mutan nada; la propia página conserva
 * los datos visibles pero bloquea toda escritura hasta poder acreditar `config.write`.
 */
export function configNavAvailability(state: 'allowed' | 'denied' | 'unknown'): NavEntryAvailability {
  if (state !== 'denied') return { hidden: false, disabled: false };
  return { hidden: false, disabled: true, reason: CONFIG_SIN_CONTROL_REASON };
}

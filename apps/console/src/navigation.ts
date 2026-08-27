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
 * Determina la disponibilidad en navegación para la entrada de terminal según el estado del relay.
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
 * Determina la disponibilidad en navegación para la entrada de configuración según permisos de control.
 */
export function configNavAvailability(state: 'allowed' | 'denied' | 'unknown'): NavEntryAvailability {
  if (state !== 'denied') return { hidden: false, disabled: false };
  return { hidden: false, disabled: true, reason: CONFIG_SIN_CONTROL_REASON };
}

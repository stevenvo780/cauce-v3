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

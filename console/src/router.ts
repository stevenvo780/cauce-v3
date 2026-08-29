import type { MouseEvent } from 'react';
import type { TerminalRelayState } from './features/terminal/relay-status';

/**
 * Navigates without reloading the page. `pushState` does not trigger `popstate` on its own, so we
 * must dispatch it by hand so the router —which subscribes to `popstate`— notices the change.
 */
export function navigate(path: string): void {
  if (window.location.pathname === path) return;
  window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Replaces the current history entry instead of stacking a new one. This is what fits a retired
 * route that redirects to its heir: with `pushState`, the "back" button would return to the dead
 * route, which redirects forward again, and the operator would get stuck unable to leave.
 */
export function redirect(path: string): void {
  if (window.location.pathname === path) return;
  window.history.replaceState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Links keep their real `href` so middle-click, ctrl+click, "open in new tab" and the context
 * menu continue to work. Only the plain left-click is intercepted, because that is the only one
 * that should stay inside the app.
 *
 * `disabledReason`: if present, the entry is disabled (see `terminalNavAvailability` below) and
 * the click must not navigate under any circumstance — not even with a modifier — because the
 * destination has nothing real behind it.
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

/** How a menu entry whose availability depends on an optional backend should be presented. */
export interface NavEntryAvailability {
  /** `true`: do not render the entry. */
  hidden: boolean;
  /** `true`: render it inert (without navigating) with `reason` as the explanation. */
  disabled: boolean;
  /** Single-line reason, present whenever `disabled` is `true`. */
  reason?: string;
}

/**
 * Determines the navigation availability for the terminal entry based on the relay's state.
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
 * Determines the navigation availability for the configuration entry based on control permissions.
 */
export function configNavAvailability(state: 'allowed' | 'denied' | 'unknown'): NavEntryAvailability {
  if (state !== 'denied') return { hidden: false, disabled: false };
  return { hidden: false, disabled: true, reason: CONFIG_SIN_CONTROL_REASON };
}

import type { MouseEvent } from 'react';

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
 */
export function onNavClick(event: MouseEvent<HTMLAnchorElement>, path: string): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
}

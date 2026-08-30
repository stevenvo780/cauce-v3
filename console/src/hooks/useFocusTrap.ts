import type { KeyboardEvent, RefObject } from 'react';

// A disabled field is not a candidate: `.focus()` on it does nothing, so counting it as the last
// one leaves the wrap without effect and the next Tab walks out to the `inert` page behind.
const FOCUSABLE_SELECTOR = 'button:not([disabled]), summary, [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>) {
  return (evento: KeyboardEvent<HTMLElement>) => {
    if (evento.key !== 'Tab') return;
    const focos = containerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (!focos || focos.length === 0) return;
    const primero = focos[0];
    const ultimo = focos[focos.length - 1];
    if (!evento.shiftKey && document.activeElement === ultimo) {
      evento.preventDefault();
      primero.focus();
    }
    if (evento.shiftKey && document.activeElement === primero) {
      evento.preventDefault();
      ultimo.focus();
    }
  };
}

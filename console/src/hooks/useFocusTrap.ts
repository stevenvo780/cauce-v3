import type { KeyboardEvent, RefObject } from 'react';

const FOCUSABLE_SELECTOR = 'button:not([disabled]), summary, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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

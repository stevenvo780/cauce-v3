import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createId } from '../lib';

/**
 * La primitiva que no existía.
 *
 * La consola no tenía **ninguna**: donde hacía falta explicar algo se usaba `title`, que es lo
 * único peor que no explicar nada — no se estiliza, no aparece al tabular, tarda un segundo largo
 * en salir y en un `<svg>` ni siquiera se puede leer con el teclado. La queja del dueño ("sin
 * tooltips, poco claras") es sobre la vista entera, así que esto tiene que servir para las tres
 * cosas a la vez: una palabra en un párrafo, la cabecera de una columna y un muñeco dibujado en
 * SVG.
 *
 * Dos razones para que el globo se monte con `createPortal` en `document.body` y NUNCA dentro del
 * `<svg>`:
 *  - un `<foreignObject>` lo recorta el `overflow` de `.lhg-scroll`, así que el texto del nodo del
 *    borde derecho quedaría cortado justo cuando más se lo necesita;
 *  - dentro del SVG hereda el `transform` del nodo y el escalado del `viewBox`, o sea que el
 *    tamaño de letra dependería de cuántos alias tenga la flota.
 *
 * El `title` nativo se CONSERVA en los sitios donde ya existía: es el respaldo del lector de
 * pantalla y del usuario que no llega con el ratón. Esto se suma, no lo reemplaza.
 */

/** Retraso antes de abrir con el ratón. Sin él, barrer la pantalla dispara diez globos seguidos. */
export const TOOLTIP_DELAY_MS = 120;

export type TooltipPlacement = 'top' | 'bottom';

export interface FloatingTooltipProps {
  /** Rectángulo del disparador en coordenadas de viewport (`getBoundingClientRect()`). */
  anchor: DOMRect | null;
  open: boolean;
  children: ReactNode;
  /** Debe coincidir con el `aria-describedby` del disparador. */
  id?: string;
  placement?: TooltipPlacement;
}

/**
 * El globo, controlado desde afuera. Es el que usan los nodos del grafo: el SVG no puede
 * envolver a un nodo en un `<span>`, así que emite su rectángulo por `onHover` y la página
 * mantiene UN solo globo para todos los muñecos.
 */
export function FloatingTooltip({ anchor, open, children, id, placement = 'top' }: FloatingTooltipProps) {
  if (!open || !anchor || typeof document === 'undefined') return null;
  const arriba = placement === 'top';
  const style = {
    position: 'fixed' as const,
    left: `${Math.round(anchor.left + anchor.width / 2)}px`,
    top: `${Math.round(arriba ? anchor.top - 10 : anchor.bottom + 10)}px`,
    transform: arriba ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
  };
  return createPortal(
    <div className="tooltip-bubble" id={id} role="tooltip" data-placement={placement} style={style}>
      {children}
    </div>,
    document.body,
  );
}

export interface TooltipProps {
  /** Lo que se explica. Acepta nodos: varias líneas, `<strong>`, cifras. */
  label: ReactNode;
  children: ReactNode;
  placement?: TooltipPlacement;
  /**
   * `false` cuando lo que se envuelve YA es enfocable (un `<button>`, un enlace). El envoltorio
   * deja de tomar foco y se apoya en que el evento `focus` del hijo burbujea hasta acá: dos
   * paradas de tabulador para un solo control es peor accesibilidad, no mejor.
   */
  focusable?: boolean;
  className?: string;
}

/**
 * Envoltorio HTML. Abre con el ratón **y con el foco de teclado**, cierra con Esc.
 *
 * Que abra con el foco no es un extra: la vista se navega con Tab y un globo que sólo responde al
 * ratón deja fuera exactamente la mitad del contenido explicativo que este componente existe para
 * dar.
 */
export function Tooltip({ label, children, placement = 'top', focusable = true, className }: TooltipProps) {
  const id = useMemo(() => createId('tooltip'), []);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const host = useRef<HTMLSpanElement>(null);
  const timer = useRef<number>(0);

  const cerrar = useCallback(() => {
    window.clearTimeout(timer.current);
    setAnchor(null);
  }, []);

  const abrir = useCallback((retraso: number) => {
    window.clearTimeout(timer.current);
    const medir = () => setAnchor(host.current?.getBoundingClientRect() ?? null);
    if (retraso <= 0) medir();
    else timer.current = window.setTimeout(medir, retraso);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Esc cierra desde donde sea que esté el foco. Se engancha sólo mientras hay globo abierto:
  // un oyente global permanente por cada tooltip de la página es un coste que no hace falta pagar.
  useEffect(() => {
    if (!anchor) return undefined;
    const alPulsar = (event: KeyboardEvent) => { if (event.key === 'Escape') cerrar(); };
    document.addEventListener('keydown', alPulsar);
    return () => document.removeEventListener('keydown', alPulsar);
  }, [anchor, cerrar]);

  return (
    <span
      ref={host}
      className={`tooltip-anchor${className ? ` ${className}` : ''}`}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={anchor ? id : undefined}
      onMouseEnter={() => abrir(TOOLTIP_DELAY_MS)}
      onMouseLeave={cerrar}
      // El teclado no tiene "pasar por encima sin querer", así que no hay nada que amortiguar.
      onFocus={() => abrir(0)}
      onBlur={cerrar}
    >
      {children}
      <FloatingTooltip anchor={anchor} open={anchor !== null} id={id} placement={placement}>
        {label}
      </FloatingTooltip>
    </span>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createId } from '../lib';

/**
 * The primitive that did not exist.
 *
 * The console had **none**: where something needed explaining it used `title`, which is the
 * only thing worse than not explaining — it cannot be styled, it does not appear on tab focus,
 * it takes a long second to show up, and inside an `<svg>` it cannot even be read with the
 * keyboard. The owner's complaint ("no tooltips, unclear") is about the entire view, so
 * this must serve all three at once: a word in a paragraph, a column header, and a puppet
 * drawn in SVG.
 *
 * Two reasons the bubble is mounted with `createPortal` to `document.body` and NEVER inside
 * the `<svg>`:
 *  - a `<foreignObject>` is clipped by the `overflow` of `.lhg-scroll`, so the text of the
 *    right-edge node would be cut off exactly when it is most needed;
 *  - inside the SVG it inherits the node's `transform` and the `viewBox` scaling, meaning the
 *    font size would depend on how many aliases the fleet has.
 *
 * The native `title` is PRESERVED where it already existed: it is the screen-reader and
 * mouse-less user's fallback. This adds to it; it does not replace it.
 */

/** Delay before opening with the mouse. Without it, sweeping the screen triggers ten bubbles in a row. */
export const TOOLTIP_DELAY_MS = 120;

export type TooltipPlacement = 'top' | 'bottom';

export interface FloatingTooltipProps {
  /** Trigger's rectangle in viewport coordinates (`getBoundingClientRect()`). */
  anchor: DOMRect | null;
  open: boolean;
  children: ReactNode;
  /** Must match the trigger's `aria-describedby`. */
  id?: string;
  placement?: TooltipPlacement;
}

/**
 * The bubble, controlled from outside. It is the one used by the graph nodes: the SVG cannot
 * wrap a node in a `<span>`, so it emits its rectangle via `onHover` and the page keeps ONE
 * single bubble for all the puppets.
 */
export function FloatingTooltip({ anchor, open, children, id, placement = 'top' }: FloatingTooltipProps) {
  if (!open || !anchor || typeof document === 'undefined') return null;
  const arriba = placement === 'top';
  const style = {
    position: 'fixed' as const,
    left: `${String(Math.round(anchor.left + anchor.width / 2))}px`,
    top: `${String(Math.round(arriba ? anchor.top - 10 : anchor.bottom + 10))}px`,
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
  /** What gets explained. Accepts nodes: multiple lines, `<strong>`, figures. */
  label: ReactNode;
  children: ReactNode;
  placement?: TooltipPlacement;
  /**
   * `false` when what is wrapped is ALREADY focusable (a `<button>`, a link). The wrapper stops
   * taking focus and relies on the child's `focus` event bubbling up here: two tab stops for a
   * single control is worse accessibility, not better.
   */
  focusable?: boolean;
  className?: string;
}

/**
 * HTML wrapper. Opens with the mouse **and with keyboard focus**, closes with Esc.
 *
 * Opening on focus is not a bonus: the view is navigated with Tab and a bubble that only
 * responds to the mouse leaves out exactly half of the explanatory content this component
 * exists to provide.
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
    const medir = () => { setAnchor(host.current?.getBoundingClientRect() ?? null); };
    if (retraso <= 0) medir();
    else timer.current = window.setTimeout(medir, retraso);
  }, []);

  useEffect(() => () => { window.clearTimeout(timer.current); }, []);

  // Esc closes from wherever the focus is. It is only attached while a bubble is open: a
  // permanent global listener for every tooltip on the page is a cost we don't need to pay.
  useEffect(() => {
    if (!anchor) return undefined;
    const alPulsar = (event: KeyboardEvent) => { if (event.key === 'Escape') cerrar(); };
    document.addEventListener('keydown', alPulsar);
    return () => { document.removeEventListener('keydown', alPulsar); };
  }, [anchor, cerrar]);

  return (
    <span
      ref={host}
      className={`tooltip-anchor${className ? ` ${className}` : ''}`}
      tabIndex={focusable ? 0 : undefined}
      aria-describedby={anchor ? id : undefined}
      onMouseEnter={() => { abrir(TOOLTIP_DELAY_MS); }}
      onMouseLeave={cerrar}
      // The keyboard has no "hover by accident", so there is nothing to dampen.
      onFocus={() => { abrir(0); }}
      onBlur={cerrar}
    >
      {children}
      <FloatingTooltip anchor={anchor} open={anchor !== null} id={id} placement={placement}>
        {label}
      </FloatingTooltip>
    </span>
  );
}

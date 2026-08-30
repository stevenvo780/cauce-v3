import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A box that scrolls sideways, reachable by keyboard while —and only while— it really overflows.
 *
 * `overflow-x: auto` on a plain `div` hides content from anyone without a pointer: the box takes
 * no focus, so the arrow keys never reach it and there is no way to see what is cut. Measured in
 * Chrome, the fleet table hid 738 px at 360, 306 at 1100 and 136 at 1440, all of it unreachable.
 *
 * The tab stop appears only while the overflow exists, so the widths where the table fits do not
 * pay a stop for nothing; that is also why this measures instead of declaring `tabIndex` always.
 */
export function Desplazable({ etiqueta, className = 'table-wrap', children }: {
  /** Names the region: without it the tab stop announces itself as an unnamed group. */
  etiqueta: string;
  className?: string;
  children: ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [desborda, setDesborda] = useState(false);

  useLayoutEffect(() => {
    const nodo = caja.current;
    if (!nodo) return undefined;
    const medir = () => { setDesborda(nodo.scrollWidth - nodo.clientWidth > 1); };
    medir();
    // Same reading as the rest of the console: without an observer the initial measurement stands,
    // which is never worse than declaring nothing.
    if (typeof ResizeObserver !== 'function') return undefined;
    const observador = new ResizeObserver(medir);
    observador.observe(nodo);
    for (const hijo of nodo.children) observador.observe(hijo);
    return () => { observador.disconnect(); };
  });

  return (
    <div
      ref={caja}
      className={className}
      {...(desborda ? { tabIndex: 0, role: 'group', 'aria-label': etiqueta } : {})}
    >
      {children}
    </div>
  );
}

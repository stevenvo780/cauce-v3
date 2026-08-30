import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A sideways-scrolling box, keyboard-reachable while —and only while— it overflows: a plain `div`
 * with `overflow-x:auto` takes no focus, so the arrows never reach what it cuts (measured in
 * Chrome, 738 px stranded at 360). A width where it fits pays no stop; `etiqueta` names the one it does.
 */
export function Desplazable({ etiqueta, className = 'table-wrap', children }: {
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
    // Without an observer the first measurement stands, which is never worse than declaring nothing.
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

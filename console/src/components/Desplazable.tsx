import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A scrolling box is keyboard-reachable while —and only while— its content overflows. A plain `div`
 * with `overflow:auto` takes no focus, so arrows cannot reach the clipped content. A box that fits
 * pays no tab stop; `etiqueta` names the one that does.
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
    const medir = () => {
      setDesborda(nodo.scrollWidth - nodo.clientWidth > 1 || nodo.scrollHeight - nodo.clientHeight > 1);
    };
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
      onKeyDown={desborda ? (event) => {
        if (event.target !== event.currentTarget || !caja.current) return;
        const node = caja.current;
        const paso = Math.max(48, Math.round(node.clientWidth * 0.8));
        const pasoVertical = Math.max(48, Math.round(node.clientHeight * 0.8));
        const horizontal = node.scrollWidth - node.clientWidth > 1;
        const vertical = node.scrollHeight - node.clientHeight > 1;
        let before: number;
        let after: number;
        if (event.key === 'ArrowRight') { if (!horizontal) return; before = node.scrollLeft; node.scrollLeft += paso; after = node.scrollLeft; }
        else if (event.key === 'ArrowLeft') { if (!horizontal) return; before = node.scrollLeft; node.scrollLeft -= paso; after = node.scrollLeft; }
        else if (event.key === 'ArrowDown') { if (!vertical) return; before = node.scrollTop; node.scrollTop += 48; after = node.scrollTop; }
        else if (event.key === 'ArrowUp') { if (!vertical) return; before = node.scrollTop; node.scrollTop -= 48; after = node.scrollTop; }
        else if (event.key === 'PageDown') { if (!vertical) return; before = node.scrollTop; node.scrollTop += pasoVertical; after = node.scrollTop; }
        else if (event.key === 'PageUp') { if (!vertical) return; before = node.scrollTop; node.scrollTop -= pasoVertical; after = node.scrollTop; }
        else if (event.key === 'Home') { if (!horizontal) return; before = node.scrollLeft; node.scrollLeft = 0; after = node.scrollLeft; }
        else if (event.key === 'End') { if (!horizontal) return; before = node.scrollLeft; node.scrollLeft = node.scrollWidth; after = node.scrollLeft; }
        else return;
        if (before !== after) event.preventDefault();
      } : undefined}
    >
      {children}
    </div>
  );
}

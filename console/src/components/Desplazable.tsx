import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A scrolling box is keyboard-reachable while —and only while— its content overflows. A plain `div`
 * with `overflow:auto` takes no focus, so arrows cannot reach the clipped content. A box that fits
 * pays no tab stop; `etiqueta` names the one that does.
 */
export function Desplazable({ etiqueta, className = 'max-w-full overflow-x-auto rounded-lg border border-line', children }: {
  etiqueta: string;
  className?: string;
  children: ReactNode;
}) {
  const caja = useRef<HTMLDivElement>(null);
  const [eje, setEje] = useState({ horizontal: false, vertical: false });
  const desborda = eje.horizontal || eje.vertical;

  useLayoutEffect(() => {
    const nodo = caja.current;
    if (!nodo) return undefined;
    const medir = () => {
      const horizontal = nodo.scrollWidth - nodo.clientWidth > 1;
      const vertical = nodo.scrollHeight - nodo.clientHeight > 1;
      setEje((previo) => (
        previo.horizontal === horizontal && previo.vertical === vertical ? previo : { horizontal, vertical }
      ));
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
    <div className="grid gap-1">
      {eje.horizontal ? (
        <p className="m-0 text-xs text-muted" role="note">Desplaza a la derecha para ver el resto de las columnas.</p>
      ) : null}
      <div className="relative min-w-0">
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
        {eje.horizontal ? <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent" /> : null}
      </div>
    </div>
  );
}

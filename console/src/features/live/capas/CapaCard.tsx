import type { ReactNode } from 'react';

interface CapaCardProps {
  icono: ReactNode;
  numero: number;
  titulo: string;
  fin: string;
  fuente: string;
  porque: string;
  actions?: ReactNode;
  children: ReactNode;
}

/** One of the three directive layers: what it is for, where it comes from, and what it holds. */
export function CapaCard({ icono, numero, titulo, fin, fuente, porque, actions, children }: CapaCardProps) {
  return (
    <section aria-label={`Capa ${String(numero)}: ${titulo.toLowerCase()}`}
      className="grid min-w-0 gap-3 rounded-xl border border-line bg-surface p-4 shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-ink">{icono}</span>
          <div className="min-w-0">
            <h3 className="m-0 text-sm font-semibold tracking-tight">Capa {numero} · {titulo}</h3>
            <p className="m-0 text-xs font-medium text-fg-2">{fin}</p>
            <p className="m-0 mt-0.5 font-mono text-[11px] break-words text-muted">{fuente}</p>
            <details className="mt-1 text-xs text-muted">
              <summary className="cursor-pointer">¿por qué esta capa?</summary>
              <p className="m-0 mt-1 max-w-prose">{porque}</p>
            </details>
          </div>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

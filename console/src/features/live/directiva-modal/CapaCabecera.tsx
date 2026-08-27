import type { ReactNode } from 'react';

interface CapaCabeceraProps {
  icono: ReactNode;
  numero: number;
  titulo: string;
  fin: string;
  fuente: string;
  porque: string;
}

export function CapaCabecera({ icono, numero, titulo, fin, fuente, porque }: CapaCabeceraProps) {
  return (
    <header className="directiva-capa-head">
      <span className="directiva-capa-icono" aria-hidden="true">{icono}</span>
      <div>
        <h3>Capa {numero} · {titulo}</h3>
        <p className="directiva-capa-fin">{fin}</p>
        <p className="directiva-capa-fuente">{fuente}</p>
        <details className="directiva-porque-caja">
          <summary>¿por qué esta capa?</summary>
          <p className="directiva-porque">{porque}</p>
        </details>
      </div>
    </header>
  );
}

import { KeyRound } from 'lucide-react';
import type { DenegacionExplicada } from './denegaciones';

export function NegativaPty({ negativa }: { negativa: DenegacionExplicada }) {
  return (
    <div
      role="alert"
      data-negativa=""
      data-codigo={negativa.codigo}
      data-consola={negativa.esDefectoDeLaConsola ? true : undefined}
      className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[13px] text-danger-ink"
    >
      <strong className="font-semibold">{negativa.titulo}</strong>
      <p className="m-0 mt-0.5 text-fg-2">{negativa.porQue}</p>
      {negativa.quienLoLevanta ? (
        <p className="m-0 mt-1 flex items-center gap-1 text-xs text-muted">
          <KeyRound size={12} aria-hidden="true" /> Lo levanta: {negativa.quienLoLevanta}
        </p>
      ) : null}
    </div>
  );
}

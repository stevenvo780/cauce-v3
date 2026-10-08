import { AlertTriangle } from 'lucide-react';
import { Notice } from '../../components/kit';
import { LoadingState } from '../../components/ui';

/** Bare /terminal: the sidebar roster owns agent selection, so this only says where to pick one. */
export function TerminalHome({ agentCount, loading, error }: {
  agentCount: number;
  loading: boolean;
  error?: Error;
}) {
  if (loading && agentCount === 0) return <LoadingState label="Leyendo la flota del servidor…" />;
  if (error && agentCount === 0) {
    return (
      <Notice tone="danger" role="alert" className="m-4 flex items-start gap-2">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span><strong>La flota no se pudo leer.</strong> No es que no haya agentes. {error.message}</span>
      </Notice>
    );
  }
  return (
    <div className="grid flex-1 place-content-center p-6 text-center">
      <h2 className="m-0 text-base font-semibold tracking-tight">Elegí un agente en la barra lateral</h2>
      <p className="m-0 mt-1 text-[13px] text-muted">
        {agentCount === 0 ? 'La flota no tiene agentes todavía.' : 'Su TUI y su shell se abren desde acá.'}
      </p>
    </div>
  );
}

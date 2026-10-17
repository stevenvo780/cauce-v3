import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Notice } from '../../components/kit';
import { LoadingState } from '../../components/ui';

/** Bare /terminal: the sidebar roster owns agent selection, so this only says where to pick one. */
export function TerminalHome({ agentCount, loading, error, onRefresh }: {
  agentCount: number;
  loading: boolean;
  error?: Error;
  onRefresh?: () => void;
}) {
  if (loading && agentCount === 0) return <LoadingState label="Leyendo la flota del servidor…" />;
  if (error && agentCount === 0) {
    return (
      <Notice tone="danger" role="alert" className="m-4 flex flex-wrap items-start gap-2">
        <AlertTriangle size={16} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1"><strong>La flota no se pudo leer.</strong> No es que no haya agentes. {error.message}</span>
        {onRefresh ? <Button size="sm" onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" />Reintentar</Button> : null}
      </Notice>
    );
  }
  return (
    <div className="grid flex-1 place-content-center p-6 text-center">
      <h2 className="m-0 text-base font-semibold tracking-tight">Elegí un agente en la barra lateral</h2>
      <p className="m-0 mt-1 text-[13px] text-muted">
        {agentCount === 0
          ? 'La flota no tiene agentes todavía. Registra el primero en Ajustes, sección Agentes, y después elegilo aquí.'
          : 'Su TUI y su shell se abren desde acá.'}
      </p>
    </div>
  );
}

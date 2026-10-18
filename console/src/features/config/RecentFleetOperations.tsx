import { useCallback, useEffect, useState } from 'react';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { ActionButton } from '../../components/action-button';
import { Button, Notice, SectionCard } from '../../components/kit';
import { AgentFleetOperation, OperationLine } from './AgentFleetOperation';
import { operationTitle, partitionOperations } from './fleet-operation-text';

const LIMIT = 50;

type Load = { state: 'loading' } | { state: 'unavailable' } | { state: 'ready'; operations: FleetOperation[] };

export function RecentFleetOperations() {
  const api = useApi();
  const access = useConsoleAccess();
  const canWrite = !access.loading && !access.error && access.data?.permissions?.includes('config.write') === true;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [expanded, setExpanded] = useState<string>();

  const read = useCallback(async (isCurrent: () => boolean): Promise<Error | undefined> => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const operations = await api.listRecentFleetOperations(LIMIT);
      if (isCurrent()) setLoad(operations ? { state: 'ready', operations } : { state: 'unavailable' });
      return undefined;
    } catch (failure) {
      const err = failure instanceof Error ? failure : new Error('No se pudieron leer las operaciones.');
      if (isCurrent()) {
        setError(err.message);
        setLoad((previous) => previous.state === 'loading' ? { state: 'ready', operations: [] } : previous);
      }
      return isCurrent() ? err : undefined;
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void read(() => active);
    return () => { active = false; };
  }, [read]);

  const replace = (next: FleetOperation) => {
    setLoad((previous) => previous.state === 'ready'
      ? { state: 'ready', operations: previous.operations.map((row) => row.id === next.id ? next : row) } : previous);
  };

  const control = async (operation: FleetOperation, action: 'cancel' | 'resume') => {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = action === 'cancel' ? await api.cancelFleetOperation(operation.id, operation.version)
        : await api.resumeFleetOperation(operation.id, operation.version);
      replace(next);
      setNotice(action === 'cancel' ? `${operationTitle(operation)}: cancelada.` : `${operationTitle(operation)}: reanudada.`);
    } catch (failure) {
      const fresh = await api.listRecentFleetOperations(LIMIT).catch(() => undefined);
      if (fresh) setLoad({ state: 'ready', operations: fresh });
      setError(failure instanceof Error ? failure.message : 'No se pudo completar la acción.');
    } finally {
      setBusy(false);
    }
  };

  if (load.state === 'unavailable') {
    return <p className="m-0 text-xs text-muted">Este servidor no publica las operaciones de flota recientes.</p>;
  }
  const operations = load.state === 'ready' ? load.operations : [];
  const { attention, finished } = partitionOperations(operations);
  const renderRow = (operation: FleetOperation) => <li key={operation.id} className="grid gap-3 rounded-lg border border-line p-3">
    <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
      <OperationLine operation={operation} />
      <Button size="sm" aria-expanded={expanded === operation.id}
        aria-label={`${expanded === operation.id ? 'Ocultar' : 'Ver'} detalle de ${operationTitle(operation)}`}
        onClick={() => { setExpanded(expanded === operation.id ? undefined : operation.id); }}>
        {expanded === operation.id ? 'Ocultar' : 'Ver detalle'}<ChevronDown size={14} aria-hidden="true" className={expanded === operation.id ? 'rotate-180' : undefined} />
      </Button>
    </div>
    {expanded === operation.id ? <AgentFleetOperation operation={operation} busy={busy || !canWrite} current={canWrite}
      onAuthRefreshed={replace} control={(action) => { void control(operation, action); }} /> : null}
  </li>;
  return <SectionCard level={3} title="Operaciones de flota recientes"
    description="Primero lo que necesita tu acción o está en curso. Lo terminado queda agrupado abajo."
    actions={<ActionButton size="sm" label="Releer" disabled={busy} announceError={false} icon={<RefreshCw size={14} aria-hidden="true" />} action={async () => {
      const err = await read(() => true);
      return err ? { error: err } : undefined;
    }} />}>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {notice ? <Notice tone="ok" role="status">{notice}</Notice> : null}
    {load.state === 'loading' ? <p className="m-0 text-xs text-muted">Leyendo operaciones…</p>
      : !operations.length ? (error ? null : <p className="m-0 text-xs text-muted">No hay operaciones recientes. Cuando se cree, detenga o reanude un agente, grupo o espacio, la operación aparecerá aquí.</p>)
        : <div className="grid gap-3">
          {attention.length ? <ul className="m-0 grid list-none gap-2 p-0" aria-label="Operaciones que necesitan atención">{attention.map(renderRow)}</ul>
            : <p className="m-0 text-xs text-muted">Ninguna operación necesita tu acción ahora.</p>}
          {finished.length ? <details className="rounded-lg border border-line">
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Terminadas ({finished.length})</summary>
            <ul className="m-0 grid list-none gap-2 p-3 pt-1">{finished.map(renderRow)}</ul>
          </details> : null}
        </div>}
  </SectionCard>;
}

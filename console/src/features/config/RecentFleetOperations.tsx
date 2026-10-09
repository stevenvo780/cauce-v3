import { useCallback, useEffect, useState } from 'react';
import type { FleetOperation, FleetTarget } from '@cauce/protocol/fleet-operation';
import { RefreshCw } from 'lucide-react';
import { useConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import { Button, Notice, SectionCard } from '../../components/kit';
import { Time } from '../../components/ui';
import { cancellable, operationSummary, resumable } from './fleet-operation-text';

const LIMIT = 50;

function fleetTargetText(target: FleetTarget): string {
  if (target.resource === 'agent') return `${target.tenant_id}/${target.alias}`;
  if (target.resource === 'room') return `${target.tenant_id}/${target.room_id} (grupo)`;
  return `${target.tenant_id} (espacio)`;
}

type Load = { state: 'loading' } | { state: 'unavailable' } | { state: 'ready'; operations: FleetOperation[] };

/** The latest fleet operations across every target, with the same cancel/resume controls as a single agent's panel. */
export function RecentFleetOperations() {
  const api = useApi();
  const access = useConsoleAccess();
  const canWrite = !access.loading && !access.error && access.data?.permissions?.includes('config.write') === true;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const read = useCallback(async (isCurrent: () => boolean) => {
    setBusy(true); setError(undefined);
    try {
      const operations = await api.listRecentFleetOperations(LIMIT);
      if (isCurrent()) setLoad(operations ? { state: 'ready', operations } : { state: 'unavailable' });
    } catch (failure) {
      if (isCurrent()) { setError(failure instanceof Error ? failure.message : 'No se pudieron leer las operaciones.'); setLoad((previous) => previous.state === 'loading' ? { state: 'ready', operations: [] } : previous); }
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    void read(() => active);
    return () => { active = false; };
  }, [read]);

  const control = async (operation: FleetOperation, action: 'cancel' | 'resume') => {
    setBusy(true); setError(undefined);
    try {
      const next = action === 'cancel' ? await api.cancelFleetOperation(operation.id, operation.version)
        : await api.resumeFleetOperation(operation.id, operation.version);
      setLoad((previous) => previous.state === 'ready'
        ? { state: 'ready', operations: previous.operations.map((row) => row.id === next.id ? next : row) } : previous);
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
  return <SectionCard level={3} title="Operaciones de flota recientes"
    description="Las últimas operaciones sobre agentes, grupos y espacios, de la más nueva a la más vieja."
    actions={<Button size="sm" disabled={busy} onClick={() => { void read(() => true); }}><RefreshCw size={14} aria-hidden="true" />Releer</Button>}>
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    {load.state === 'loading' ? <p className="m-0 text-xs text-muted">Leyendo…</p>
      : !operations.length ? (error ? null : <p className="m-0 text-xs text-muted">No hay operaciones recientes.</p>)
        : <ul className="m-0 grid list-none gap-2 p-0">
          {operations.map((operation) => <li key={operation.id}
            className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
            <div className="grid min-w-0 gap-0.5">
              <span className="break-words text-sm font-semibold">{fleetTargetText(operation.target)}</span>
              <span className="break-words text-xs text-muted">{operationSummary(operation)}</span>
              <span className="text-xs text-muted"><Time value={operation.created_at} relativo /></span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" disabled={!canWrite || busy || !resumable(operation)}
                aria-label={`Reanudar ${fleetTargetText(operation.target)}`}
                onClick={() => { void control(operation, 'resume'); }}>Reanudar</Button>
              <Button size="sm" disabled={!canWrite || busy || !cancellable(operation)}
                aria-label={`Cancelar ${fleetTargetText(operation.target)}`}
                onClick={() => { void control(operation, 'cancel'); }}>Cancelar</Button>
            </div>
          </li>)}
        </ul>}
  </SectionCard>;
}

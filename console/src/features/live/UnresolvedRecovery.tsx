import { useState } from 'react';
import type { ConsoleFleetOperation } from '@cauce/protocol/console-fleet-operation';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';
import { navigate } from '../../router';
import { operationErrorHuman, operationTitle, STATUS, STEPS } from '../config/fleet-operation-text';
import { prepareAgentHref } from '../config/use-agent-route';
import { recoveryError } from './recovery-problem';
import { isExhaustedRestoration, isRestoredUpdate } from './unresolved-recovery-state';

export function UnresolvedRecovery({ operation, tenantId, alias, onClose, onResolved, onChanged }: {
  operation: ConsoleFleetOperation; tenantId: string; alias: string; onClose: () => void;
  onResolved?: () => void; onChanged?: (operation: ConsoleFleetOperation) => void;
}) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = operation.error?.step ?? operation.steps.find(row => ['running', 'failed', 'waiting'].includes(row.status))?.name;
  const restored = isRestoredUpdate(operation);
  const exhausted = isExhaustedRestoration(operation);

  async function act(action: 'cancel' | 'resume') {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const next = await (action === 'resume' ? api.resumeFleetOperation(operation.id, operation.version)
        : api.cancelFleetOperation(operation.id, operation.version));
      if (next.status === 'cancelled' || next.status === 'succeeded') onResolved?.();
      else onChanged?.(next);
    } catch (failure) {
      setError(recoveryError(failure, 'No se pudo cambiar la operación. Ábrela en Ejecución para revisarla.'));
    } finally { setBusy(false); }
  }

  return <Notice tone="warn" role="alert">
    {restored ? <p>La actualización falló y se restauró el estado anterior de {alias}. Ya no queda nada por reparar: solo hay que cerrar ese aviso para poder reiniciar.</p>
      : <p>Resuelve esta operación antes de reiniciar: {operationTitle(operation)}.</p>}
    <p className="wrap-anywhere">Operación {operation.id} · Estado: {STATUS[operation.status]} · Paso: {step ? STEPS[step] : 'Sin paso activo acreditado'}.</p>
    {operation.error ? <p>{operationErrorHuman(operation.error).message}</p> : null}
    {exhausted && operation.error ? <p>{operationErrorHuman(operation.error).next}</p> : null}
    {restored ? <p>Al cerrarlo se vuelve a comprobar la conversación del agente antes de pedirte confirmar el reinicio.</p> : null}
    {!restored && !exhausted ? <p>Abre la ficha de Ejecución para revisar o cancelar la operación y poder continuar.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <div className="mt-2 flex flex-wrap gap-2">
      {restored ? <Button size="sm" disabled={busy} onClick={() => { void act('cancel'); }}>{busy ? 'Cerrando…' : 'Cerrar la actualización y continuar'}</Button> : null}
      {exhausted ? <>
        <Button size="sm" disabled={busy} onClick={() => { void act('resume'); }}>Reintentar</Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => { void act('cancel'); }}>Cancelar la actualización</Button>
      </> : null}
      <Button size="sm" onClick={() => { navigate(prepareAgentHref(tenantId, alias)); }}>Ver operación</Button>
      <Button size="sm" onClick={onClose}>Cerrar</Button>
    </div>
  </Notice>;
}

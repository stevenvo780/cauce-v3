import type { ConsoleFleetOperation } from '@cauce/protocol/console-fleet-operation';
import { Button, Notice } from '../../components/kit';
import { navigate } from '../../router';
import { operationErrorHuman, operationTitle, STATUS, STEPS } from '../config/fleet-operation-text';
import { prepareAgentHref } from '../config/use-agent-route';

export function UnresolvedRecovery({ operation, tenantId, alias, onClose }: {
  operation: ConsoleFleetOperation; tenantId: string; alias: string; onClose: () => void;
}) {
  const step = operation.error?.step ?? operation.steps.find(row => ['running', 'failed', 'waiting'].includes(row.status))?.name;
  return <Notice tone="warn" role="alert">
    <p>Resuelve esta operación antes de reiniciar: {operationTitle(operation)}.</p>
    <p className="wrap-anywhere">Operación {operation.id} · Estado: {STATUS[operation.status]} · Paso: {step ? STEPS[step] : 'Sin paso activo acreditado'}.</p>
    {operation.error ? <p>{operationErrorHuman(operation.error).message}</p> : null}
    <p>Abre la ficha de Ejecución para revisar o cancelar la operación y poder continuar.</p>
    <div className="mt-2 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => { navigate(prepareAgentHref(tenantId, alias)); }}>Ver operación</Button>
      <Button size="sm" onClick={onClose}>Cerrar</Button>
    </div>
  </Notice>;
}

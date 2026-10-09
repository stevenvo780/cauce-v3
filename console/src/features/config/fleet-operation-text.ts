import type { FleetOperation, FleetOperationPreview } from '@cauce/protocol/fleet-operation';
import { FLEET_ACTION_LABELS } from './agent-lifecycle-model';

export const STATUS = { queued: 'En cola', running: 'En ejecución', awaiting_auth: 'Esperando autenticación',
  cancelling: 'Cancelación en curso', cancelled: 'Cancelada', failed: 'Fallida', succeeded: 'Completada' };
export const STEPS = { prepare: 'Preparación', artifacts: 'Artefactos', credentials: 'Credenciales', runtime: 'Runtime',
  authenticate: 'Autenticación', profile: 'Perfil', verify: 'Verificación', admission: 'Admisión', fence: 'Cierre de entregas',
  stop: 'Detención', revoke: 'Revocación', purge: 'Purga' };
export const STEP_STATUS = { pending: 'Pendiente', running: 'En ejecución', waiting: 'En espera', succeeded: 'Acreditado', failed: 'Fallido', compensated: 'Compensado' };
export const ERRORS: Record<NonNullable<FleetOperation['error']>['code'], string> = {
  AUTHORITY_REVOKED: 'La autoridad que respaldaba la operación fue revocada.',
  REVISION_CONFLICT: 'La configuración cambió mientras corría la operación.',
  HOST_UNAVAILABLE: 'La computadora del agente no respondió o no está disponible.',
  DEPENDENCIES_PRESENT: 'Quedan dependencias que impiden continuar.',
  STEP_FAILED: 'El ejecutor no pudo completar este paso.',
  PROVIDER_AUTH_REQUIRED: 'El proveedor pide autenticarse de nuevo.',
  UNSUPPORTED_RUNTIME: 'El runtime del agente no admite esta operación.',
  VERIFICATION_FAILED: 'El ejecutor no pudo comprobar el efecto del paso.',
  CANCELLED: 'La operación se canceló.',
};
const TABLES: Record<string, string> = { agent_profiles: 'perfil del agente', agent_appearances: 'apariencia', agent_account_bindings: 'cuentas vinculadas',
  agent_sealing_keys: 'llaves de sellado', alias_routing_ceiling: 'techos de ruteo', egress_destinations: 'destinos de salida',
  console_agent_favorites: 'favoritos', memberships: 'membresías', messages: 'mensajes', deliveries: 'entregas', rooms: 'grupo' };

/** One line per operation for history lists: action, status and, when it failed, where and why. */
export function operationSummary(operation: FleetOperation): string {
  const error = operation.error;
  return `${FLEET_ACTION_LABELS[operation.kind]} · ${STATUS[operation.status]}`
    + (error && operation.status === 'failed' ? ` · ${error.step ? `${STEPS[error.step]}: ` : ''}${ERRORS[error.code]}` : '');
}

export function purgeEntries(preview: FleetOperationPreview, action: 'delete' | 'preserve' | 'blocked'): string[] {
  return preview.dependencies.flatMap((entry) => {
    const [kind, verb, table] = entry.type.split('.');
    if (kind !== 'purge' || verb !== action || !table) return [];
    const count = typeof entry.identity.kind === 'string' ? entry.identity.kind.replace(' rows', '') : '?';
    return [`${TABLES[table] ?? table} (${count})`];
  });
}

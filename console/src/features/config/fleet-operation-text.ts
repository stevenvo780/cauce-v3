import type { FleetOperation, FleetOperationPreview } from '@cauce/protocol/fleet-operation';
import { FLEET_FAILURE_TEXT } from './fleet-failure-text';

export const STATUS = { queued: 'En cola', running: 'En ejecución', awaiting_auth: 'Esperando autenticación',
  cancelling: 'Cancelación en curso', cancelled: 'Cancelada', failed: 'Fallida', succeeded: 'Completada' };
export const STEPS = { prepare: 'Preparar el cambio', artifacts: 'Archivos', credentials: 'Cuenta', runtime: 'Entorno',
  authenticate: 'Inicio de sesión', profile: 'Aplicar el perfil', verify: 'Comprobación', admission: 'Activar mensajes', fence: 'Cerrar mensajes anteriores',
  stop: 'Detener el agente', revoke: 'Retirar accesos', purge: 'Borrado final' };
export const STEP_STATUS = { pending: 'Pendiente', running: 'En ejecución', waiting: 'En espera', succeeded: 'Acreditado', failed: 'Fallido', compensated: 'Compensado' };
export const ERRORS: Record<NonNullable<FleetOperation['error']>['code'], string> = {
  AUTHORITY_REVOKED: 'La autoridad que respaldaba la operación fue revocada.',
  REVISION_CONFLICT: 'La configuración cambió mientras corría la operación.',
  HOST_UNAVAILABLE: 'La computadora del agente no respondió o no está disponible.',
  RUNTIME_DRIFT: 'El contenedor del agente quedó con una imagen anterior.',
  DEPENDENCIES_PRESENT: 'Quedan dependencias que impiden continuar.',
  STEP_FAILED: 'El ejecutor no pudo completar este paso.',
  PROVIDER_AUTH_REQUIRED: 'El proveedor pide autenticarse de nuevo.',
  UNSUPPORTED_RUNTIME: 'El entorno de ejecución del agente no admite esta operación.',
  VERIFICATION_FAILED: 'El ejecutor no pudo comprobar el efecto del paso.',
  CANCELLED: 'La operación se canceló.',
};
const TABLES: Record<string, string> = { agent_profiles: 'perfil del agente', agent_appearances: 'apariencia', agent_account_bindings: 'cuentas vinculadas',
  agent_sealing_keys: 'llaves de sellado', alias_routing_ceiling: 'techos de ruteo', egress_destinations: 'destinos de aviso',
  egress_contacts: 'contactos de aviso', console_agent_favorites: 'favoritos', memberships: 'membresías en grupos', messages: 'mensajes', deliveries: 'entregas',
  rooms: 'grupos', tenants: 'espacio', agents: 'agentes', acl_edges: 'permisos entre clientes', audit_events: 'auditoría',
  adapter_outbox: 'avisos en espera de envío', dead_letters: 'avisos sin entregar', outbox_dead_letters: 'avisos sin entregar',
  delivery_lane_fairness: 'reparto de entregas', agent_output_materializations: 'resultados guardados', channel_bridge_cursors: 'puentes de canal',
  egress_notifications: 'avisos de salida', telegram_egress_effects: 'avisos de Telegram', agent_chain_closures: 'cierres de cadenas',
  agent_failure_notice_events: 'avisos de fallo', agent_failure_notices: 'avisos de fallo', idempotency_keys: 'claves ya usadas',
  terminal_sessions: 'sesiones de terminal', connection_leases: 'conexiones activas', terminal_control_holds: 'controles de terminal',
  agent_profiles_history: 'historial del equipo' };

export type OperationTone = 'ok' | 'info' | 'warn' | 'danger' | 'neutral';

export interface OperationStatusMeta { label: string; tone: OperationTone; attention: boolean; finished: boolean }

export const OPERATION_STATUS_META: Record<FleetOperation['status'], OperationStatusMeta> = {
  queued: { label: 'En cola', tone: 'neutral', attention: true, finished: false },
  running: { label: 'En curso', tone: 'info', attention: true, finished: false },
  awaiting_auth: { label: 'Esperando tu acción', tone: 'warn', attention: true, finished: false },
  cancelling: { label: 'Cancelando', tone: 'warn', attention: true, finished: false },
  failed: { label: 'Falló', tone: 'danger', attention: true, finished: true },
  cancelled: { label: 'Cancelada', tone: 'neutral', attention: false, finished: true },
  succeeded: { label: 'Terminada', tone: 'ok', attention: false, finished: true },
};

/** Signing in recreates a container left on an older image, so drift on a login wait only needs the login. */
export function isRuntimeDrift(operation: FleetOperation | undefined): boolean {
  return operation?.error?.code === 'RUNTIME_DRIFT' && operation.status !== 'awaiting_auth';
}

export function operationStatusMeta(operation: FleetOperation): OperationStatusMeta {
  const meta = OPERATION_STATUS_META[operation.status];
  if (operation.status === 'cancelling' && operation.kind === 'update') return { ...meta, label: 'Restaurando el estado anterior' };
  return isRuntimeDrift(operation) ? { ...meta, label: 'Requiere preparación', tone: 'danger' } : meta;
}

export function operationTargetName(operation: FleetOperation): string {
  const target = operation.target;
  if (target.resource === 'agent') return target.alias;
  if (target.resource === 'room') return target.room_id;
  return target.tenant_id;
}

const AGENT_VERB: Record<FleetOperation['kind'], string> = {
  create: 'Preparar a', update: 'Actualizar a', start: 'Iniciar a', stop: 'Detener a',
  retire: 'Retirar a', restore: 'Restaurar a', purge: 'Eliminar definitivamente a', recover: 'Recuperar la TUI de',
};
const GROUP_VERB: Record<FleetOperation['kind'], string> = {
  create: 'Preparar el grupo', update: 'Actualizar el grupo', start: 'Iniciar el grupo', stop: 'Detener el grupo',
  retire: 'Retirar el grupo', restore: 'Restaurar el grupo', purge: 'Eliminar definitivamente el grupo', recover: 'Recuperar el grupo',
};
const SPACE_VERB: Record<FleetOperation['kind'], string> = {
  create: 'Preparar el espacio', update: 'Actualizar el espacio', start: 'Iniciar el espacio', stop: 'Detener el espacio',
  retire: 'Retirar el espacio', restore: 'Restaurar el espacio', purge: 'Eliminar definitivamente el espacio', recover: 'Recuperar el espacio',
};

/** Human title of an operation: «Preparar a Hades en server2», «Retirar a Teseo». */
export function operationTitle(operation: FleetOperation, hostId?: string): string {
  const target = operation.target;
  const name = operationTargetName(operation);
  const base = target.resource === 'agent' ? `${AGENT_VERB[operation.kind]} ${name}`
    : target.resource === 'room' ? `${GROUP_VERB[operation.kind]} ${name}`
      : `${SPACE_VERB[operation.kind]} ${name}`;
  return hostId ? `${base} en ${hostId}` : base;
}

export interface OperationErrorHuman { message: string; next: string }

const ERROR_NEXT: Record<NonNullable<FleetOperation['error']>['code'], string> = {
  PROVIDER_AUTH_REQUIRED: 'Inicia sesión para continuar.',
  STEP_FAILED: 'Reintenta desde el paso que falló; si se repite, cancela y revisa la computadora.',
  HOST_UNAVAILABLE: 'Espera a que la computadora vuelva y reintenta, o cancela.',
  RUNTIME_DRIFT: 'Cancela esta operación y pulsa Preparar para recrearlo; luego inicia sesión.',
  AUTHORITY_REVOKED: 'Cancela y vuelve a lanzarla con un permiso vigente.',
  REVISION_CONFLICT: 'Cancela y vuelve a lanzarla con la configuración actual.',
  DEPENDENCIES_PRESENT: 'Resuelve las dependencias que quedan y reintenta.',
  UNSUPPORTED_RUNTIME: 'Cancela: este agente no admite esta operación por esta vía.',
  VERIFICATION_FAILED: 'Reintenta; si se repite, revisa la computadora del agente.',
  CANCELLED: '',
};

/** Human message and next action for an operation error. The raw code never belongs here. */
export function operationErrorHuman(error: NonNullable<FleetOperation['error']>): OperationErrorHuman {
  if (error.reason) return FLEET_FAILURE_TEXT[error.reason];
  const fallback = ERRORS[error.code];
  if (error.code === 'STEP_FAILED' && !error.retryable) {
    return { message: fallback, next: 'No se puede reintentar: cancela y lanza una operación nueva.' };
  }
  return { message: fallback, next: ERROR_NEXT[error.code] };
}

export function stepProgress(operation: FleetOperation): { current: number; total: number; done: number; label?: string } {
  const total = operation.steps.length;
  const active = operation.steps.find((step) => step.status === 'running' || step.status === 'waiting' || step.status === 'failed');
  const done = operation.steps.filter((step) => step.status === 'succeeded' || step.status === 'compensated').length;
  const current = active ? operation.steps.indexOf(active) + 1 : Math.min(done + 1, Math.max(total, 1));
  return { current: total ? current : 0, total, done, label: active ? STEPS[active.name] : undefined };
}

const REMOVED_NOUN: Record<string, { one: string; many: string }> = {
  container: { one: 'el contenedor', many: 'contenedores' },
  volume: { one: 'el volumen', many: 'volúmenes' },
  directory: { one: 'el directorio', many: 'directorios' },
  network: { one: 'la red', many: 'redes' },
  unit: { one: 'la unidad systemd', many: 'unidades systemd' },
  file: { one: 'el archivo', many: 'archivos' },
};

/** Physical outcome in words: «Borró el contenedor cauce-x y 2 volúmenes». */
export function physicalResult(operation: FleetOperation): string | undefined {
  const recovered = operation.steps.find(step => step.name === 'verify' && step.status === 'succeeded')?.evidence?.recovery;
  if (operation.kind === 'recover' && recovered) return ['resumed', 'recreated'].includes(recovered.session.state)
    ? 'Reanudó la misma conversación y conservó el contenedor y el adaptador.' : 'Consultó la conversación sin reiniciar el agente.';
  const removed = operation.steps.flatMap((step) => step.status === 'succeeded' ? step.evidence?.removed ?? [] : []);
  const purgeStep = operation.steps.find((step) => step.name === 'purge');
  if (!removed.length) {
    if (operation.kind === 'purge' && operation.status === 'succeeded') {
      return purgeStep?.status === 'succeeded' && purgeStep.evidence?.removed
        ? 'No borró contenedores ni volúmenes, unidades ni rutas.'
        : 'Terminó sin detallar qué recursos borró.';
    }
    return undefined;
  }
  const byType = new Map<string, string[]>();
  for (const item of removed) byType.set(item.type, [...(byType.get(item.type) ?? []), item.name]);
  const parts = [...byType.entries()].map(([type, names]) => {
    const noun = REMOVED_NOUN[type] ?? { one: 'el recurso', many: 'recursos' };
    return names.length === 1 ? `${noun.one} ${names[0]}` : `${String(names.length)} ${noun.many}`;
  });
  const joined = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} y ${parts.at(-1) ?? ''}` : parts[0];
  return `Borró ${joined}.`;
}

/** One sentence that says what happened or what is missing. */
export function operationHeadline(operation: FleetOperation, hostId?: string): string {
  const title = operationTitle(operation, hostId);
  const progress = stepProgress(operation);
  if (operation.error && isRuntimeDrift(operation)) {
    const human = operationErrorHuman(operation.error);
    return `${human.message} ${human.next}`;
  }
  if (operation.status === 'awaiting_auth') {
    return operation.target.resource === 'agent'
      ? `${operationTargetName(operation)} está esperando que inicies sesión en su proveedor.`
      : 'Está esperando que inicies sesión en el proveedor.';
  }
  if (operation.status === 'queued') return `${title} está en cola. Empezará en cuanto el ejecutor tenga turno.`;
  if (operation.status === 'running') {
    return progress.total
      ? `${title} está en curso. Hecho: ${String(progress.done)} de ${String(progress.total)}${progress.label ? ` · Ahora: ${progress.label}` : ' pasos'}.`
      : `${title} está en curso.`;
  }
  if (operation.status === 'cancelling') {
    const pending = operation.kind === 'update' ? 'Restaurando el estado anterior del agente.'
      : `Cancelando: ${title.charAt(0).toLowerCase()}${title.slice(1)}.`;
    const human = operation.error ? operationErrorHuman(operation.error) : undefined;
    const next = operation.kind === 'update' ? 'La restauración se reintenta automáticamente mientras siga pendiente.' : human?.next;
    return human ? `${pending} ${human.message} ${next ?? ''}`.trim() : pending;
  }
  if (operation.status === 'cancelled') return `${title} se canceló. No se siguieron aplicando pasos.`;
  if (operation.status === 'succeeded') {
    const physical = physicalResult(operation);
    return physical ? `${title} terminó bien. ${physical}` : `${title} terminó bien.`;
  }
  const error = operation.error;
  if (error) {
    const human = operationErrorHuman(error);
    if (operation.kind === 'update' && operation.steps.some(step => step.status === 'compensated')) {
      return `La actualización falló y se restauró el estado anterior. ${human.message} Cierra esta operación y prepara una actualización nueva.`;
    }
    return `Falló${error.step ? ` en ${STEPS[error.step]}` : ''}: ${human.message} ${human.next}`.trim();
  }
  return `${title}: ${OPERATION_STATUS_META[operation.status].label}.`;
}

export function needsAttention(operation: FleetOperation): boolean {
  return OPERATION_STATUS_META[operation.status].attention;
}

export function isFinished(operation: FleetOperation): boolean {
  return operation.status === 'succeeded' || operation.status === 'cancelled';
}

export function partitionOperations(operations: readonly FleetOperation[]): { attention: FleetOperation[]; finished: FleetOperation[] } {
  return {
    attention: operations.filter((operation) => needsAttention(operation)),
    finished: operations.filter((operation) => isFinished(operation)),
  };
}

/** One line per operation for history lists: human title, state and, when it failed, why. */
export function operationSummary(operation: FleetOperation): string {
  const error = operation.error;
  return `${operationTitle(operation)} · ${OPERATION_STATUS_META[operation.status].label}`
    + (error && (operation.status === 'failed' || isRuntimeDrift(operation)) ? ` · ${operationErrorHuman(error).message}` : '');
}

export function purgeEntries(preview: FleetOperationPreview, action: 'delete' | 'preserve' | 'blocked'): string[] {
  return preview.dependencies.flatMap((entry) => {
    const [kind, verb, table] = entry.type.split('.');
    if (kind !== 'purge' || verb !== action || !table) return [];
    const count = typeof entry.identity.kind === 'string' ? entry.identity.kind.replace(' rows', '') : '?';
    return [`${TABLES[table] ?? 'historial del equipo'} (${count})`];
  });
}

export interface PurgeBlocker { table: string; label: string; count: string }

export function purgeBlockers(preview: FleetOperationPreview): PurgeBlocker[] {
  return preview.dependencies.flatMap((entry) => {
    const [kind, verb, table] = entry.type.split('.');
    if (kind !== 'purge' || verb !== 'blocked' || !table) return [];
    const count = typeof entry.identity.kind === 'string' ? entry.identity.kind.replace(' rows', '') : '?';
    return [{ table, label: TABLES[table] ?? 'trabajo activo del equipo', count }];
  });
}

type OperationKind = FleetOperation['kind'];
const UNRESOLVED_STATUSES: readonly FleetOperation['status'][] = ['failed', 'queued', 'running', 'awaiting_auth', 'cancelling'];
const KIND_NOUNS: Record<OperationKind, string> = { create: 'preparación', update: 'actualización', start: 'inicio', stop: 'detención',
  retire: 'retiro', restore: 'restauración', purge: 'eliminación definitiva', recover: 'recuperación' };
const KIND_VERBS: Record<OperationKind, string> = { create: 'preparar', update: 'actualizar', start: 'iniciar', stop: 'detener',
  retire: 'retirar', restore: 'restaurar', purge: 'eliminar definitivamente', recover: 'recuperar' };

export function isUnresolved(operation: FleetOperation | undefined): operation is FleetOperation {
  return !!operation && UNRESOLVED_STATUSES.includes(operation.status);
}

export function isUnpreparedMaintenance(operation: FleetOperation | undefined): boolean {
  return operation?.kind === 'update' && operation.target.resource === 'agent'
    && operation.actor.actor_subject?.startsWith('host:') === true && operation.desired_revision === null
    && (operation.status === 'queued' || operation.status === 'running')
    && operation.steps.every(step => step.status === 'pending');
}

/** An unresolved operation of ANOTHER kind: the server refuses to enqueue the intended action until it is cancelled. */
export function blockingOperation(operation: FleetOperation | undefined, intended: OperationKind): FleetOperation | undefined {
  return isUnresolved(operation) && !isUnpreparedMaintenance(operation) && operation.kind !== intended ? operation : undefined;
}

export function blockingText(operation: FleetOperation | undefined, intended: OperationKind): string {
  return `Hay una operación${operation ? ` de ${KIND_NOUNS[operation.kind]}` : ' de flota'} sin terminar; cancélala para poder ${KIND_VERBS[intended]}.`;
}

const CAPABILITY_REASON: Record<string, string> = {
  executor_unconfigured: 'ninguna computadora de esta empresa está conectada y lista para ejecutar agentes, o el ejecutor de flota no está configurado. Conecta una en «Computadoras» o pide a un administrador que configure el ejecutor, y vuelve a leer las capacidades',
  unsupported_schema: 'el ejecutor de flota publicado usa un esquema que esta consola no admite. Actualiza la consola o el ejecutor y vuelve a leer las capacidades',
};

/** Why the fleet capability denies an action, in Spanish; an unknown code stays visible for support. */
export function fleetCapabilityReasonText(reason: string | undefined): string {
  if (!reason) return 'el servidor no detalló el motivo. Vuelve a leer las capacidades; si persiste, pide revisar la configuración del ejecutor';
  return CAPABILITY_REASON[reason] ?? `el servidor informó un motivo que esta consola no reconoce. Vuelve a leer las capacidades; si persiste, pide revisar la configuración del ejecutor. Código: ${reason}`;
}

export const STALE_RESUME_TEXT = 'La configuración cambió desde que se lanzó; cancélala y vuelve a lanzarla.';
export const isStaleResume = (message: string) => /revision changed;?\s*preview the operation again/iu.test(message);

const REFUSALS: readonly (readonly [RegExp, string])[] = [
  [/provider account has no current payer consent/iu, 'La cuenta principal no está habilitada o su pagador no consiente este uso. Habilítala tras «Iniciar sesión» en «Mis cuotas» o en el agente y vuelve a previsualizar.'],
  [/requires exact complete durable placement/iu, 'El registro de un agente de este alcance no tiene la ubicación completa que el ejecutor de flota necesita: se instaló antes de la flota y hay que adoptarlo antes de operarlo desde la consola.'],
  [/no registered host transport|approved source and destination coordinator|controller host is unavailable/iu, 'La computadora elegida no está conectada al coordinador de flota. Elige una computadora conectada o conéctala en «Computadoras».'],
  [/outside the configured host authority|outside the approved host templates|outside the approved runtime capability/iu, 'La ubicación no coincide con una plantilla aprobada de esa computadora. Elige la plantilla de ejecución y una cuenta principal que la computadora admita.'],
  [/requires an explicit provider account/iu, 'Elige la cuenta principal de ejecución.'],
  [/fleet action is unavailable/iu, 'El ejecutor de flota no admite esta acción ahora. Vuelve a leer las capacidades.'],
  [/delivery source principal has no physical runtime/iu, 'Este agente es un principal del sistema sin ejecución propia: no se opera con la flota.'],
];

/** Server refusals of preview/enqueue/control, in Spanish; anything else passes through. */
export function fleetErrorText(message: string, operation: FleetOperation | undefined, intended: OperationKind): string {
  if (/already has an unresolved fleet operation/iu.test(message)) {
    return blockingText(isUnresolved(operation) && !isUnpreparedMaintenance(operation) ? operation : undefined, intended);
  }
  if (isStaleResume(message)) return STALE_RESUME_TEXT;
  return REFUSALS.find(([pattern]) => pattern.test(message))?.[1] ?? message;
}

export function cancellable(operation: FleetOperation): boolean {
  return ['queued', 'running', 'awaiting_auth', 'failed'].includes(operation.status);
}
export function resumable(operation: FleetOperation): boolean {
  return !isRuntimeDrift(operation)
    && (operation.status === 'awaiting_auth' || (operation.status === 'failed' && operation.error?.retryable === true));
}

import type { FleetRecoveryPreflight, FleetRecoveryReason } from '@cauce/protocol/fleet-recovery';

export type RecoveryProblem = Exclude<FleetRecoveryPreflight, { status: 'ready' }>;

export function recoveryProblem(reason: FleetRecoveryReason | 'executor_unavailable', nextAction?: 'update' | 'stop_start'): RecoveryProblem {
  if (reason === 'runtime_mounts_differ' || reason === 'runtime_without_shared_tui' && nextAction !== 'stop_start') return {
    status: 'update_required', reason_code: reason, next_action: 'update',
    reason: `${reason === 'runtime_mounts_differ' ? 'El contenedor usa archivos de una versión anterior.'
      : 'La ejecución se inició sin la TUI compartida que permite la política actual.'} Actualiza la ejecución y vuelve a reiniciar para reanudar la misma conversación.` };
  const messages = {
    shared_tui_disabled: 'La política de este equipo no permite una TUI compartida.',
    harness_unsupported: 'Este tipo de agente no permite reanudar una TUI compartida.',
    runtime_without_shared_tui: 'La sesión de esta ejecución no ofrece una TUI compartida que se pueda reanudar.',
    executor_unavailable: 'El equipo no permite comprobar el reinicio con su versión actual. Actualiza su CLI para habilitar esta comprobación.',
  };
  return { status: 'unsupported', reason_code: reason, next_action: 'stop_start',
    reason: `${messages[reason]} Puedes detener y arrancar el agente mediante sus operaciones habituales; estas acciones no acreditan reanudar esta conversación.` };
}

export function recoveryError(failure: unknown, fallback: string): string {
  const message = failure instanceof Error ? failure.message : fallback;
  if (message === 'target already has an unresolved fleet operation') return 'Hay una operación de flota sin resolver. Abre la ficha de Ejecución para revisarla o cancelarla antes de reiniciar.';
  if (message === 'fleet action is unavailable') return 'El equipo no admite esta acción con su política actual. Comprueba su ejecución y las acciones disponibles.';
  if (message === 'fleet effect failed: container runtime mounts differ') return recoveryProblem('runtime_mounts_differ').reason;
  return message;
}

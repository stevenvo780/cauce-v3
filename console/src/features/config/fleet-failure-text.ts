import type { FleetError } from '@cauce/protocol/fleet-operation';

export const FLEET_FAILURE_TEXT: Record<NonNullable<FleetError['reason']>, { message: string; next: string }> = {
  runtime_mounts_differ: { message: 'Los montajes de la ejecución no coinciden con la versión aprobada.',
    next: 'Actualiza la ejecución y vuelve a comprobar su estado antes de reiniciar.' },
  shared_tui_disabled: { message: 'La política de este equipo no permite una TUI compartida.',
    next: 'Revisa la política del equipo o utiliza sus operaciones Detener y Arrancar.' },
  harness_unsupported: { message: 'Este tipo de agente no permite recuperar una TUI compartida.',
    next: 'Utiliza las operaciones Detener y Arrancar de su ficha de Ejecución.' },
  runtime_without_shared_tui: { message: 'La ejecución actual no tiene una TUI compartida reanudable.',
    next: 'Actualiza la ejecución y vuelve a comprobar si la conversación se puede reanudar.' },
  runtime_identity_mismatch: { message: 'La ejecución activa no coincide con la identidad del SDK o con el transporte autorizado.',
    next: 'Actualiza el ejecutor del equipo y vuelve a comprobar la operación antes de reintentar.' },
  runtime_security_mismatch: { message: 'La ejecución no cumple las comprobaciones de propiedad o aislamiento autorizadas.',
    next: 'Revisa la configuración y la identidad del equipo; la operación permanece bloqueada.' },
  runtime_bundle_changed: { message: 'Los archivos o la imagen de la ejecución no coinciden con la versión aprobada.',
    next: 'Actualiza el ejecutor y la ejecución con una versión aprobada antes de reintentar.' },
  runtime_stop_unverified: { message: 'No se pudo acreditar que la ejecución anterior se haya detenido.',
    next: 'Comprueba la detención en la ficha de Ejecución antes de arrancar o volver a intentarlo.' },
  provider_functional_proof_failed: { message: 'El proveedor no superó la comprobación funcional del agente.',
    next: 'Revisa su cuenta y su autenticación; después vuelve a comprobar la operación.' },
};

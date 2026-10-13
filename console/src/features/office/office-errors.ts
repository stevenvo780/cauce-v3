import { ApiError } from '../../api/client/core';
import { failureCode, spanishWithReason, type Failure } from '../../api/error-message';
import type { ConsoleAuthorityRole } from '../../api/types';
import { canManageCompany } from '../auth/company-authority';

export function describeOfficeError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 504) return cause.message;
    const detail = cause.message.trim();
    if (cause.status === 400 && detail === 'invalid office layout') {
      return 'El plano contiene datos que el servidor no acepta. Revisa las posiciones y tamaños de las salas antes de volver a guardarlo.';
    }
    if (cause.status === 403 && (detail === 'company office authority is required' || detail === 'insufficient permissions')) {
      return 'Tu sesión no tiene autoridad para leer o cambiar el plano de esta empresa. Pide acceso a un administrador de la empresa.';
    }
    if (cause.status === 409 && detail === 'office layout version changed; reload and retry') {
      return 'Otro operador cambió el plano mientras editabas. Relee el plano y vuelve a guardar; se conserva el borrador.';
    }
    if (cause.status === 400) {
      return spanishWithReason('El plano contiene datos que el servidor no acepta. Revisa las posiciones y tamaños de las salas antes de volver a guardarlo.', detail);
    }
    if (cause.status === 401) return spanishWithReason('Tu sesión terminó. Vuelve a entrar para continuar.', detail);
    if (cause.status === 403) {
      return spanishWithReason('Tu sesión no tiene autoridad para leer o cambiar el plano de esta empresa. Pide acceso a un administrador de la empresa.', detail);
    }
    if (cause.status === 404) return spanishWithReason('El plano ya no está disponible. Relee la oficina y vuelve a intentarlo.', detail);
    if (cause.status === 409) {
      return spanishWithReason('Otro operador cambió el plano mientras editabas. Relee el plano y vuelve a guardar; se conserva el borrador.', detail);
    }
    if (cause.status === 429) return spanishWithReason('Hay demasiadas solicitudes. Espera un momento e inténtalo de nuevo.', detail);
    if (cause.status >= 500) return spanishWithReason('El servidor no pudo leer o guardar el plano. Inténtalo más tarde.', detail);
    return spanishWithReason('No se pudo leer o guardar el plano.', detail);
  }
  return cause instanceof Error ? cause.message : 'No se pudo leer o guardar el plano.';
}

/** A plan read or write failure: the Spanish action with the server reason, and its stable code. */
export function officeFailure(cause: unknown): Failure {
  return { message: describeOfficeError(cause), code: failureCode(cause) };
}

/** Why the plan cannot be saved right now, or undefined when only the lack of changes stops it. */
export function planSaveUnavailableReason({ role, layoutError, draft }: {
  role: ConsoleAuthorityRole | undefined; layoutError: boolean; draft: boolean;
}): string | undefined {
  if (role !== undefined && !canManageCompany(role)) {
    return 'Tu rol permite ver el plano, pero no cambiarlo. Pide a un propietario o administrador de la empresa que lo edite.';
  }
  if (layoutError && !draft) return 'Sin una lectura vigente del plano no se puede editar ni guardar. Relee el plano.';
  return undefined;
}

import { ApiError } from '../../api/client/core';
import type { ConsoleAuthorityRole } from '../../api/types';

/** Provider accounts spend the payer's money: only the owner and the platform manage them. */
export function canManageQuotaAccounts(role: ConsoleAuthorityRole | undefined): boolean {
  return role === 'company_owner' || role === 'platform_admin';
}

const AUTOMATIC_PAUSE = /^quota_exhausted:(.*)$/u;

/** Window name of an automatic pause reason, or undefined when the reason was typed by a person. */
export function automaticPauseWindow(reason: string | null): string | undefined {
  return AUTOMATIC_PAUSE.exec(reason ?? '')?.[1];
}

export function pauseReasonText(reason: string | null): string {
  const window = automaticPauseWindow(reason);
  if (window === undefined) return reason ?? '';
  return window ? `Pausada por cuota agotada en ${window}` : 'Pausada por cuota agotada';
}

const STATUS_MESSAGE: Record<number, string> = {
  401: 'Tu sesión terminó. Vuelve a entrar para continuar.',
  403: 'Tu rol no permite esta acción.',
  404: 'Ya no existe el recurso. Actualiza la lista.',
  409: 'Otro cambio llegó antes, o el recurso aún tiene dependencias. Relee y vuelve a intentarlo.',
  400: 'El servidor rechazó los datos enviados. Revísalos e inténtalo de nuevo.',
  422: 'El servidor rechazó los datos enviados. Revísalos e inténtalo de nuevo.',
  429: 'Hay demasiadas solicitudes. Espera un momento e inténtalo de nuevo.',
  502: 'El servidor no pudo completar la operación. Inténtalo más tarde.',
  503: 'Este servidor no puede atender la operación ahora. Inténtalo más tarde.',
};

export const QUOTA_HOST_UNAVAILABLE_MESSAGE = 'El ordenador no responde; reintenta cuando vuelva a estar en línea.';

/** Server messages on quota routes are not localized: the console maps status and codes without showing them. */
export function describeQuotaError(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 409 && cause.code === 'quota_host_unavailable') return QUOTA_HOST_UNAVAILABLE_MESSAGE;
  if (cause.status === 504) return cause.message;
  return STATUS_MESSAGE[cause.status] ?? fallback;
}

export function describeQuotaEnvironmentError(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 403 && cause.message === 'quota account or host is unavailable in the acting company') {
    return 'La cuenta o la computadora no está disponible para esta empresa, o tu sesión no tiene permiso. Comprueba los recursos y tu rol antes de continuar.';
  }
  if (cause.status === 409 && (cause.code === 'quota_host_unavailable'
      || cause.message === 'quota executor is unavailable for this host and provider')) {
    return 'El ejecutor de cuotas de la computadora no está disponible. Revisa su conexión y el proveedor, actualiza el estado y vuelve a intentarlo.';
  }
  if (cause.status === 500) {
    return 'El servidor no confirmó el estado del entorno. Actualiza cuotas y entornos para comprobar el resultado antes de repetir la operación.';
  }
  return describeQuotaError(cause, fallback);
}

const OPERATION_ERROR: Record<string, string> = {
  AUTH_EXPIRED: 'La autenticación venció. Autentica la cuenta de nuevo.',
  AUTHORITY_REVOKED: 'La persona que lo pidió perdió permiso. Repite la operación con un rol vigente.',
  PROVIDER_UNAVAILABLE: 'El proveedor no respondió. Inténtalo más tarde.',
  HOST_UNAVAILABLE: 'La computadora del entorno no está disponible. Revisa su conexión.',
  RUNTIME_UNAVAILABLE: 'El CLI del proveedor no está disponible en esa computadora.',
  SCOPE_CHANGED: 'El agente cambió de ordenador o de configuración; vuelve a consultar.',
  EXPIRED: 'La consulta caducó sin respuesta del ordenador; vuelve a consultar.',
  SESSION_CONFLICT: 'Ya hay una sesión de autenticación activa. Espera a que termine o relee el entorno.',
  SESSION_EXPIRED: 'La sesión de autenticación venció. Inicia la autenticación de nuevo.',
  STEP_FAILED: 'Un paso de la operación falló. Revisa la salida e inténtalo de nuevo.',
  FUNCTIONAL_CHECK_FAILED: 'La comprobación posterior falló. Autentica de nuevo y reintenta la consulta.',
};

export function describeOperationError(code: string): string {
  return OPERATION_ERROR[code] ?? 'La operación falló. Reintenta; si se repite, revisa el entorno.';
}

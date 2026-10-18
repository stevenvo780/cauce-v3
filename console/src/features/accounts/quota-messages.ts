import { ApiError } from '../../api/client/core';
import { failureCode, spanishWithReason, type Failure } from '../../api/error-message';
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

const FIELD_LABEL: Record<string, string> = {
  provider: 'proveedor', label: 'nombre', host_id: 'ordenador', account_id: 'cuenta', expected_version: 'versión',
  idempotency_key: 'clave de la operación', paused_until: 'pausa hasta', paused_reason: 'motivo de pausa', enabled: 'habilitada',
};

/** The 400 of quota routes names the rejected fields after `invalid quota request:`. */
function rejectedFields(message: string): string | undefined {
  const fields = /^invalid quota request: (.+)$/u.exec(message)?.[1]?.split(', ').map(field => FIELD_LABEL[field] ?? field);
  return fields?.length ? `El servidor rechazó ${fields.length === 1 ? 'el campo' : 'los campos'} ${fields.join(', ')}. Revísalo e inténtalo de nuevo.` : undefined;
}

/** Server messages on quota routes are not localized: the console maps status and codes without showing them. */
export function describeQuotaError(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 409 && cause.code === 'quota_host_unavailable') return QUOTA_HOST_UNAVAILABLE_MESSAGE;
  if (cause.status === 409 && cause.code === 'conflict'
    && cause.message === 'quota account version changed or the change is not allowed') {
    return 'No se guardó la cuenta: su versión cambió o el cambio no está permitido. Pulsa «Actualizar cuotas y entornos» y revisa los datos antes de reintentar. Si estás habilitando una cuenta nueva, primero pulsa «Iniciar sesión» en su tarjeta de «Mis cuotas».';
  }
  if (cause.status === 400) return rejectedFields(cause.message) ?? STATUS_MESSAGE[400];
  if (cause.status === 504) return cause.message;
  return STATUS_MESSAGE[cause.status] ?? fallback;
}

/**
 * Reading quota accounts in the office and the agent sheet: the Spanish action, the concrete reason of
 * a 4xx refusal (generic HTTP phrases are dropped) and the stable code. A 5xx sentence stays hidden.
 */
export function quotaReadFailure(cause: unknown, fallback: string): Failure {
  const message = cause instanceof ApiError && cause.status === 504 ? fallback : describeQuotaError(cause, fallback);
  const refusal = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.code !== 'quota_host_unavailable';
  return { message: refusal ? spanishWithReason(message, cause.message) : message, code: failureCode(cause) };
}

export function describeQuotaEnvironmentError(cause: unknown, fallback: string): string {
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.status === 409 && cause.code === 'conflict'
    && /quota executor is unavailable for this host and provider/iu.test(cause.message)) {
    return 'El ejecutor de cuotas no está disponible para ese ordenador y proveedor. Revisa la conexión del ordenador y que el proveedor esté habilitado antes de repetir la operación.';
  }
  if (cause.status === 403 && cause.code === 'forbidden'
    && /quota account or host is unavailable in the acting company/iu.test(cause.message)) {
    return 'La cuenta o el ordenador no están disponibles en la empresa seleccionada. Actualiza la lista y comprueba la empresa antes de crear el entorno.';
  }
  if (cause.status === 500) {
    return 'El servidor no confirmó el estado del entorno. Actualiza cuotas y entornos para comprobar el resultado antes de repetir la operación.';
  }
  const message = describeQuotaError(cause, fallback);
  if ((cause.status === 403 || cause.status === 409)
    && !/^quota (?:account|environment) (?:version changed|changed)/iu.test(cause.message)) {
    return spanishWithReason(message, cause.message);
  }
  return message;
}

const OPERATION_ERROR: Record<string, string> = {
  AUTH_CANCELLED: 'Inicio de sesión cancelado. Puedes volver a iniciarlo desde la tarjeta de la cuenta.',
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

export function describeKnownOperationError(code: string): string | undefined {
  return OPERATION_ERROR[code];
}

export function describeOperationError(code: string): string {
  return describeKnownOperationError(code) ?? 'La operación falló. Reintenta; si se repite, revisa el entorno.';
}

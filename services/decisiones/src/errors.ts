/** Every failure the service reports has one of these codes; the HTTP status follows from it. */
export type DecisionErrorCode =
  | 'solicitud_invalida'
  | 'plantilla_desconocida'
  | 'plantilla_deshabilitada'
  | 'state_demasiado_grande'
  | 'no_autenticado'
  | 'no_autorizado'
  | 'limite_excedido'
  | 'cupo_diario_agotado'
  | 'servicio_ocupado'
  | 'jev_sin_credencial'
  | 'jev_credencial_rechazada'
  | 'jev_solicitud_rechazada'
  | 'jev_limite'
  | 'jev_sobrecargado'
  | 'jev_error'
  | 'jev_red'
  | 'jev_timeout'
  | 'jev_respuesta_invalida';

const STATUS: Readonly<Record<DecisionErrorCode, number>> = {
  solicitud_invalida: 400,
  plantilla_desconocida: 404,
  plantilla_deshabilitada: 403,
  state_demasiado_grande: 413,
  no_autenticado: 401,
  no_autorizado: 403,
  limite_excedido: 429,
  cupo_diario_agotado: 429,
  servicio_ocupado: 429,
  jev_sin_credencial: 503,
  jev_credencial_rechazada: 502,
  jev_solicitud_rechazada: 502,
  jev_limite: 503,
  jev_sobrecargado: 503,
  jev_error: 502,
  jev_red: 503,
  jev_timeout: 504,
  jev_respuesta_invalida: 502,
};

/** What the caller should do when no decision could be made; resolved from the template. */
export interface FallbackOutcome {
  readonly decision: string;
  readonly valor: string | null;
  readonly motivo: string;
  readonly caer_a_llm: boolean;
}

export interface DecisionErrorDetails {
  readonly retryAfterMs?: number;
  /** HTTP requests already sent to Jev when the failure happened, for the audit line. */
  readonly requests?: number;
  readonly respaldo?: FallbackOutcome;
}

export class DecisionError extends Error {
  readonly status: number;

  constructor(
    readonly code: DecisionErrorCode,
    message: string,
    readonly details: DecisionErrorDetails = {},
  ) {
    super(message);
    this.name = 'DecisionError';
    this.status = STATUS[code];
  }

  withFallback(respaldo: FallbackOutcome): DecisionError {
    return new DecisionError(this.code, this.message, { ...this.details, respaldo });
  }

  toBody(): Record<string, unknown> {
    return {
      error: this.code,
      mensaje: this.message,
      ...(this.details.respaldo === undefined ? {} : { respaldo: this.details.respaldo }),
    };
  }
}

export function invalid(message: string): DecisionError {
  return new DecisionError('solicitud_invalida', message);
}

export function isJevFailure(code: DecisionErrorCode): boolean {
  return code.startsWith('jev_');
}

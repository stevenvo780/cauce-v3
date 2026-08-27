/**
 * Evaluación de límites y disciplina de delegación entre agentes.
 */

import {
  MAX_DELEGATION_REJECTION_TARGET_CHARS,
  type DelegationRejectionCode as ProtocolDelegationRejectionCode
} from '@cauce/protocol';

/**
 * Códigos de rechazo aplicables a intentos de delegación entre agentes.
 */
export type DelegationRejectionCode = ProtocolDelegationRejectionCode;

/** Códigos que 019 agrega al dominio durable de `agent_output_materializations.rejection_code`. */
export const DELEGATION_DISCIPLINE_REJECTION_CODES = [
  'fanout_exceeded',
  'edge_repeat_exceeded',
  'root_budget_exhausted',
  'chain_gated',
  'human_gate_opened'
] as const;

/** Directiva reservada: pedirle algo a una persona NO es delegar en un agente. */
export const HUMAN_GATE_TARGET = '@human';

export interface DelegationCaps {
  /** Interruptor maestro: apagado, `materializeAgentOutputs` se comporta como antes de 019. */
  enabled: boolean;
  /** Abanico máximo por TURNO INTERNO. No aplica al turno raíz (ver `fanoutCapForTurn`). */
  maxFanoutPerTurn: number;
  /** Cuántas veces puede recorrerse la MISMA arista (emisor -> destino) dentro de una raíz. */
  maxEdgeRepeatsPerRoot: number;
  /** Combustible total de la raíz: delegaciones materializadas de toda la cadena. */
  maxDelegationsPerRoot: number;
}

/** Mismos valores que los DEFAULT de la migración 019. */
export const DEFAULT_DELEGATION_CAPS: DelegationCaps = {
  enabled: true,
  maxFanoutPerTurn: 6,
  maxEdgeRepeatsPerRoot: 3,
  maxDelegationsPerRoot: 64
};

export const DISABLED_DELEGATION_CAPS: DelegationCaps = {
  ...DEFAULT_DELEGATION_CAPS,
  enabled: false
};

/**
 * Normaliza y acota los límites de delegación leídos de configuración o base de datos.
 */
export function sanitizedDelegationCaps(value: Partial<Record<keyof DelegationCaps, unknown>>): DelegationCaps {
  const integer = (raw: unknown, fallback: number, min: number, max: number): number =>
    typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= min
      ? Math.min(raw, max)
      : fallback;
  return {
    enabled: value.enabled === true,
    maxFanoutPerTurn: integer(value.maxFanoutPerTurn, DEFAULT_DELEGATION_CAPS.maxFanoutPerTurn, 1, 100),
    maxEdgeRepeatsPerRoot: integer(
      value.maxEdgeRepeatsPerRoot, DEFAULT_DELEGATION_CAPS.maxEdgeRepeatsPerRoot, 1, 1_000
    ),
    maxDelegationsPerRoot: integer(
      value.maxDelegationsPerRoot, DEFAULT_DELEGATION_CAPS.maxDelegationsPerRoot, 1, 10_000
    )
  };
}

/**
 * Devuelve el tope de abanico aplicable al turno según el nivel de saltos (hopCount >= 2).
 */
export function fanoutCapForTurn(caps: DelegationCaps, hopCount: number): number | undefined {
  if (!caps.enabled) return undefined;
  if (!Number.isSafeInteger(hopCount) || hopCount < 2) return undefined;
  return caps.maxFanoutPerTurn;
}

/**
 * Recorta el identificador de destino de un rechazo al límite máximo admitido por el protocolo.
 */
export function boundedRejectionTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_DELEGATION_REJECTION_TARGET_CHARS) return value;
  return `${value.slice(0, MAX_DELEGATION_REJECTION_TARGET_CHARS - 1)}…`;
}

export interface RejectionContext {
  /** `tenant/alias` del destino, cuando se llegó a resolver. */
  target?: string;
  hopCount?: number;
  hopBudget?: number;
  cap?: number;
  /** Pregunta del gate abierto, para que el rechazo diga qué está esperando la cadena. */
  question?: string;
  gateId?: string;
}

export interface RejectionNotice {
  code: DelegationRejectionCode;
  /** Qué pasó, en una oración. */
  reason: string;
  /** Qué hacer en vez de reintentar. Esta es la parte que evita el reintento ciego. */
  guidance: string;
}

/**
 * Genera el aviso estructurado de rechazo con motivo y orientación correctiva.
 */
export function describeDelegationRejection(
  code: DelegationRejectionCode,
  context: RejectionContext = {}
): RejectionNotice {
  const target = context.target ?? 'el destino pedido';
  switch (code) {
    case 'fanout_exceeded':
      return {
        code,
        reason: `Abanico agotado: este turno ya delegó ${context.cap ?? 0} veces, que es el máximo`
          + ' por turno interno, y la delegación hacia ' + target + ' no se emitió.',
        guidance: 'No reintentes. Elegí las delegaciones imprescindibles y mandá esas; el resto'
          + ' hacelo vos o pedilo en un turno posterior, cuando vuelvan las respuestas.'
      };
    case 'edge_repeat_exceeded':
      return {
        code,
        reason: `Ya le pasaste esta misma tarea a ${target} ${context.cap ?? 0} veces dentro de`
          + ' esta cadena; el store no emite una más.',
        guidance: 'Repetir el mismo pase no está avanzando el trabajo. Resolvelo vos con lo que'
          + ' ya tenés, o devolvé el resultado parcial hacia arriba explicando qué falta.'
      };
    case 'root_budget_exhausted':
      return {
        code,
        reason: `Esta cadena ya consumió su presupuesto de ${context.cap ?? 0} delegaciones`
          + ' y no admite ninguna más.',
        guidance: 'Cerrá con lo que tengas: devolvé una respuesta final aunque sea parcial y'
          + ' decí explícitamente qué quedó sin hacer. Abrir una cadena nueva para lo mismo'
          + ' repite el problema.'
      };
    case 'chain_gated':
      return {
        code,
        reason: 'La cadena está suspendida esperando una respuesta humana'
          + (context.question ? `: «${context.question}»` : '')
          + (context.gateId ? ` (gate ${context.gateId})` : '') + '.',
        guidance: 'No delegues ni reintentes mientras el gate esté abierto. Cuando la persona'
          + ' conteste vas a recibir una entrega de reanudación con la respuesta.'
      };
    case 'human_gate_opened':
      return {
        code,
        reason: 'La pregunta se registró como gate humano'
          + (context.gateId ? ` (${context.gateId})` : '')
          + ', no como delegación: ningún agente puede contestar por una persona.',
        guidance: 'Quedate quieto. Tu rama está suspendida, no fallada, y se reanuda sola con'
          + ' una entrega nueva cuando la persona conteste.'
      };
    case 'cycle_detected':
      return {
        code,
        reason: `${target} ya está en la cadena de antepasados de esta tarea: devolvérsela`
          + ' cerraría un ciclo.',
        guidance: 'Mandale el trabajo a un alias que todavía no participó, o resolvelo vos.'
      };
    case 'hop_budget_exhausted':
      return {
        code,
        reason: `Presupuesto de saltos agotado (${context.hopCount ?? '?'} de`
          + ` ${context.hopBudget ?? '?'}).`,
        guidance: 'Terminá acá y devolvé lo que tengas hacia arriba.'
      };
    case 'ambiguous_alias':
      return {
        code,
        reason: `El alias «${target}» existe en más de un tenant alcanzable desde acá.`,
        guidance: 'Volvé a mandarlo nombrando el alias exacto que corresponde; si no sabés cuál'
          + ' es, preguntá en vez de adivinar.'
      };
    case 'unroutable_alias':
      return {
        code,
        reason: `No hay ruta hacia «${target}» desde este alias (no existe, está deshabilitado,`
          + ' es vos mismo, o no hay arista entre los tenants).',
        guidance: 'Revisá routing_targets antes de delegar y usá un alias de esa lista.'
      };
    case 'invalid_output':
    default:
      return {
        code: 'invalid_output',
        reason: 'La salida no cumple el contrato de `messages` (destino o cuerpo inválido, vacío'
          + ' o demasiado grande).',
        guidance: 'Corregí la forma del mensaje; reintentarlo igual va a fallar igual.'
      };
  }
}

/** Texto plano de un rechazo, para audit y para el cuerpo de un relay. */
export function rejectionText(notice: RejectionNotice): string {
  return `${notice.reason} ${notice.guidance}`;
}

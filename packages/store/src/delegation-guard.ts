/**
 * Limits and discipline evaluation for agent-to-agent delegation.
 */

import {
  MAX_DELEGATION_REJECTION_TARGET_CHARS,
  type DelegationRejectionCode as ProtocolDelegationRejectionCode
} from '@cauce/protocol';

/**
 * Rejection codes applicable to attempts at agent-to-agent delegation.
 */
export type DelegationRejectionCode = ProtocolDelegationRejectionCode;

/** Reserved directive: asking a person for something is NOT delegating to an agent. */
export const HUMAN_GATE_TARGET = '@human';

export interface DelegationCaps {
  /** Master switch: off, `materializeAgentOutputs` behaves as before 019. */
  enabled: boolean;
  /** Maximum fanout per INTERNAL TURN. Does not apply to the root turn (see `fanoutCapForTurn`). */
  maxFanoutPerTurn: number;
  /** How many times the SAME edge (sender -> target) may be traversed within one root. */
  maxEdgeRepeatsPerRoot: number;
  /** Total fuel for the root: delegations materialized across the whole chain. */
  maxDelegationsPerRoot: number;
}

/** Same values as the DEFAULTS in migration 019. */
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
 * Normalizes and bounds the delegation limits read from configuration or the database.
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
 * Returns the fanout cap applicable to the turn depending on the hop level (hopCount >= 2).
 */
export function fanoutCapForTurn(caps: DelegationCaps, hopCount: number): number | undefined {
  if (!caps.enabled) return undefined;
  if (!Number.isSafeInteger(hopCount) || hopCount < 2) return undefined;
  return caps.maxFanoutPerTurn;
}

/**
 * Trims a rejection's target identifier to the maximum size admitted by the protocol.
 */
export function boundedRejectionTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= MAX_DELEGATION_REJECTION_TARGET_CHARS) return value;
  return `${value.slice(0, MAX_DELEGATION_REJECTION_TARGET_CHARS - 1)}…`;
}

export interface RejectionContext {
  /** `tenant/alias` of the target, if it was resolved. */
  target?: string;
  hopCount?: number;
  hopBudget?: number;
  cap?: number;
  /** Question of the open gate, so the rejection says what the chain is waiting on. */
  question?: string;
  gateId?: string;
}

export interface RejectionNotice {
  code: DelegationRejectionCode;
  /** What happened, in one sentence. */
  reason: string;
  /** What to do instead of retrying. This is the part that prevents blind retries. */
  guidance: string;
}

/**
 * Generates the structured rejection notice with reason and corrective guidance.
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

/** Plain-text rejection, for audit and for a relay body. */
export function rejectionText(notice: RejectionNotice): string {
  return `${notice.reason} ${notice.guidance}`;
}

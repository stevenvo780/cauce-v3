import type {
  Ack, ChainGateNotice, DelegationMaterializationNotice, DelegationRejectionNotice,
  DeliveryEnvelope, DeliveryState, ProfileRuntimeAdoptionEvidence, Tenant,
} from '@cauce/protocol';
import { NOTIFY_KINDS, ProfileRuntimeAdoptionEvidenceSchema } from '@cauce/protocol';
import { objectRecord, visibleText } from '../outbox.js';

export interface LeaseResult {
  acquired: boolean;
  epoch?: number;
  /** Opaque per-hello fence. Present on every successful acquisition/resume. */
  connection_token?: string;
  lease_expires_at: string;
  active_instance_id?: string;
}


export interface DeliveryAdmission {
  /**
   * Capacidad general DURABLE del consumidor, compartida por HTTP, WebSocket, reconexiones e
   * instancias de gateway. Si se omite, manda `agents.max_concurrent_deliveries`.
   */
  readonly generalCapacity?: number;
  /**
   * Capacidad ADICIONAL durable que sólo puede ocupar prioridad autenticada de persona. No es un
   * cupo nuevo por llamada: se descuentan todas las garras vivas del alias bajo el mismo lock.
   */
  readonly humanReservedCapacity?: number;
  /** Techo TOTAL de filas devueltas por esta llamada; `limit + reserva` si se omite. */
  readonly maxClaims?: number;
  /** Runtime gate: reject aliases absent from the durable agent inventory. */
  readonly requireDeclaredCapacity?: boolean;
  /**
   * Cuántos reclamos humanos seguidos antes de dejar pasar un trabajo no humano. Evita que una
   * ráfaga de mensajes humanos mate de hambre al trabajo de máquina. Por defecto toma el
   * mismo valor que `interactiveBurst` (3), que es el que ya usaba la alternancia de carriles.
   */
  readonly humanBurst?: number;
}


export interface LiveDeliveryClaim {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly ack_deadline_at: string;
  /** Hecho derivado de prioridad trusted-at-ingress, nunca del body controlado por el productor. */
  readonly human_originated: boolean;
}


/**
 * Alias del esquema del frame: impide que store y adaptador diverjan en campos.
 */
export type DelegationRejection = DelegationRejectionNotice;
export type DelegationMaterialization = DelegationMaterializationNotice;
export interface LateResultRow {
  late_result_at: Date | null;
  /** Momento de cancelación manual por operador; previene rescate tardío si está presente. */
  cancelled_at: Date | null;
}
export type LateClaimProvenance = 'current' | 'applied' | 'observed' | 'none';
export interface AckResult {
  delivery_id: string;
  status: DeliveryState;
  applied: boolean;
  receipt: 'applied' | 'duplicate' | 'superseded' | 'ownership_lost';
  /** Presente sólo cuando alguna salida `messages` no se convirtió en entrega. */
  delegation_rejections?: DelegationRejection[];
  /** Salidas materializadas con la identidad exacta de la entrega hija; nunca incluye bodies. */
  delegation_materializations?: DelegationMaterialization[];
  /**
   * La rama quedó suspendida esperando a una persona; hay un gate abierto que la reanudará.
   *
   * El tipo sale del esquema del frame a propósito: los dos campos que siguen VIAJAN al adaptador
   * dentro de `ack_result`, así que cambiarles la forma acá sin cambiar el esquema allá tiene que
   * romper el build. Eso es precisamente lo que no pasó cuando se agregaron.
   */
  chain_gate?: ChainGateNotice;
}
export interface AgentOutputOutcome {
  materialized: number;
  /**
   * La rama abrió un gate humano: NO debe devolver su respuesta hacia arriba, porque no terminó
   * — está esperando. Es la diferencia entre "suspendida" y "fallada", y es lo que evita que un
   * gate se convierta en una entrega muerta.
   */
  suspended: boolean;
  rejections: DelegationRejection[];
  materializations: DelegationMaterialization[];
  /** El gate vigente de la raíz, si esta materialización se topó con uno o abrió uno. */
  gate?: OpenChainGate;
}
export interface OpenChainGate {
  id: string;
  question: string;
}
export interface ClaimedDeliveryEnvelope extends DeliveryEnvelope {
  event_id: string;
}
export interface LeaseAcquireOptions {
  /** Explicitly fence a still-live consumer. Omit for the default no-takeover behavior. */
  takeover?: boolean;
  /** Resume the same stable instance/epoch after a transport interruption. */
  resume?: boolean;
  /** Maximum age of the previous lease for a same-instance resume. */
  resumeWindowMs?: number;
  /** Refuse the lease atomically unless the consumer has a valid durable capacity row. */
  requireDeclaredCapacity?: boolean;
  requireEnabledAgent?: boolean;
}
export function ackRank(status: Ack['status']): number {
  if (status === 'accepted') return 1;
  if (status === 'started') return 2;
  return 3;
}
export const maxAgentOutputMessages = 100;
const maxAgentOutputBodyBytes = 64 * 1024;
const maxAgentOutputAggregateBytes = 256 * 1024;
const maxNotifyDirectives = 4;
export const maxNotifyBodyBytes = 4 * 1024;
const maxNotifyAggregateBytes = 8 * 1024;
export const notifyKinds = new Set<string>(NOTIFY_KINDS);
export const handlePattern = /^[a-z][a-z0-9_.-]{0,63}$/u;
export interface AgentOutputEntry {
  index: number;
  target: unknown;
  body: unknown;
  rejection?: 'invalid_output';
}
export interface RoutingTarget {
  tenant_id: Tenant;
  alias: string;
  online: boolean;
}
export type NotifyDenialCode =
  | 'notify_permission_denied'
  | 'unknown_destination'
  | 'destination_disabled'
  | 'kind_not_allowed'
  | 'cold_contact'
  | 'rate_limited'
  | 'root_quota_exhausted'
  | 'quiet_hours'
  | 'invalid_output'
  | 'body_too_large'
  | 'ambiguous_execution';
export interface AgentNotifyEntry {
  index: number;
  handle: string;
  kind: string;
  body: string;
  forcedDenial?: NotifyDenialCode;
}
const nulCharacter = String.fromCharCode(0);
export function postgresJsonSafe(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll(nulCharacter, '');
  if (Array.isArray(value)) return value.map(postgresJsonSafe);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, child]) => [key, postgresJsonSafe(child)])
    );
  }
  return value;
}
export function postgresTextSafe(value: string | undefined): string | undefined {
  return value?.replaceAll(nulCharacter, '');
}
export function profileRuntimeAdoptionEvidence(
  result: Record<string, unknown> | undefined,
): ProfileRuntimeAdoptionEvidence | undefined {
  const parsed = ProfileRuntimeAdoptionEvidenceSchema.safeParse(result?.profile_adoption);
  if (!parsed.success) return undefined;
  return {
    ...parsed.data,
    documents: [...parsed.data.documents].sort((left, right) =>
      left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
  };
}
export function agentOutputEntries(result: Record<string, unknown> | undefined): AgentOutputEntry[] {
  const output = objectRecord(result?.output);
  if (!output || output.messages === undefined) return [];
  if (!Array.isArray(output.messages)) {
    return [{ index: 0, target: undefined, body: undefined, rejection: 'invalid_output' }];
  }
  if (output.messages.length > maxAgentOutputMessages) {
    return [{ index: 0, target: undefined, body: undefined, rejection: 'invalid_output' }];
  }
  const entries = output.messages.map((value, index) => {
    const entry = objectRecord(value);
    if (!entry || typeof entry.to !== 'string'
      || typeof entry.body !== 'string' || !visibleText(entry.body)
      || Buffer.byteLength(entry.body, 'utf8') > maxAgentOutputBodyBytes) {
      return {
        index,
        target: entry?.to,
        body: entry?.body,
        rejection: 'invalid_output' as const
      };
    }
    return { index, target: entry.to, body: entry.body };
  });
  const aggregateBytes = entries.reduce(
    (total, entry) => total + (typeof entry.body === 'string'
      ? Buffer.byteLength(entry.body, 'utf8')
      : 0),
    0
  );
  return aggregateBytes > maxAgentOutputAggregateBytes
    ? entries.map((entry) => ({ ...entry, rejection: 'invalid_output' as const }))
    : entries;
}
function boundedHandle(value: unknown): string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 ? value : 'invalid';
}
export function agentNotifyEntries(result: Record<string, unknown> | undefined): AgentNotifyEntry[] {
  const output = objectRecord(result?.output);
  if (!output || output.notify === undefined) return [];
  const invalid = (index: number, handle: unknown, kind: unknown): AgentNotifyEntry => ({
    index,
    handle: boundedHandle(handle),
    kind: typeof kind === 'string' && notifyKinds.has(kind) ? kind : 'alert',
    body: '',
    forcedDenial: 'invalid_output'
  });
  if (!Array.isArray(output.notify)) return [invalid(0, undefined, undefined)];
  // One bounded denial row records the whole over-limit batch; fanning it out
  // would let a malformed output write as many rows as it asked for.
  if (output.notify.length > maxNotifyDirectives) return [invalid(0, undefined, undefined)];
  const entries = output.notify.map((value, index): AgentNotifyEntry => {
    const entry = objectRecord(value);
    if (!entry || typeof entry.to !== 'string' || !handlePattern.test(entry.to)
      || typeof entry.kind !== 'string' || !notifyKinds.has(entry.kind)
      || typeof entry.body !== 'string' || !visibleText(entry.body)) {
      return invalid(index, entry?.to, entry?.kind);
    }
    if (Buffer.byteLength(entry.body, 'utf8') > maxNotifyBodyBytes) {
      return { index, handle: entry.to, kind: entry.kind, body: '', forcedDenial: 'body_too_large' };
    }
    return { index, handle: entry.to, kind: entry.kind, body: entry.body };
  });
  const aggregateBytes = entries.reduce(
    (total, entry) => total + Buffer.byteLength(entry.body, 'utf8'),
    0
  );
  return aggregateBytes > maxNotifyAggregateBytes
    ? entries.map((entry) => ({ ...entry, body: '', forcedDenial: 'body_too_large' as const }))
    : entries;
}
export function sanitizedAckResult(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!result) return result;
  const withoutProfileAdoption = { ...result };
  delete withoutProfileAdoption.profile_adoption;
  const normalized = Object.keys(withoutProfileAdoption).length === 0
    ? undefined
    : withoutProfileAdoption;
  const output = objectRecord(normalized?.output);
  if (!normalized || !output) return normalized;
  const hasMessages = Object.prototype.hasOwnProperty.call(output, 'messages');
  const hasNotify = Object.prototype.hasOwnProperty.call(output, 'notify');
  if (!hasMessages && !hasNotify) return normalized;
  // Absence is preserved on purpose: injecting a key an output never had would
  // change the bytes persisted in delivery_acks.payload and in the relay payload.
  return {
    ...normalized,
    output: {
      ...output,
      ...(hasMessages ? { messages: [] } : {}),
      ...(hasNotify ? { notify: [] } : {})
    }
  };
}

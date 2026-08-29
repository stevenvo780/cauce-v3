import type {
  Ack, ChainGateNotice, DelegationMaterializationNotice, DelegationRejectionNotice,
  DeliveryEnvelope, DeliveryState, ProfileRuntimeAdoptionEvidence, Tenant,
} from '@cauce/protocol';
import {
  EgressHandleSchema, MAX_NOTIFY_BODY_BYTES, NOTIFY_KINDS, ProfileRuntimeAdoptionEvidenceSchema,
} from '@cauce/protocol';
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
   * General DURABLE consumer capacity, shared by HTTP, WebSocket, reconnects and gateway
   * instances. If omitted, `agents.max_concurrent_deliveries` applies.
   */
  readonly generalCapacity?: number;
  /**
   * Additional DURABLE capacity that only authenticated person-priority can occupy. It is not a
   * new quota per call: every live claw of the alias under the same lock is deducted from it.
   */
  readonly humanReservedCapacity?: number;
  /** Total CAP of rows returned by this call; `limit + reserve` if omitted. */
  readonly maxClaims?: number;
  /** Runtime gate: reject aliases absent from the durable agent inventory. */
  readonly requireDeclaredCapacity?: boolean;
  /**
   * How many human claims in a row before letting non-human work through. Prevents a burst of
   * human messages from starving machine work. Defaults to the same value as `interactiveBurst`
   * (3), which is what the lane alternation already used.
   */
  readonly humanBurst?: number;
}


export interface LiveDeliveryClaim {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly ack_deadline_at: string;
  /** Fact derived from trusted-at-ingress priority, never from the producer-controlled body. */
  readonly human_originated: boolean;
}


/**
 * Frame-schema alias: prevents store and adapter from diverging on fields.
 */
export type DelegationRejection = DelegationRejectionNotice;
export type DelegationMaterialization = DelegationMaterializationNotice;
export interface LateResultRow {
  late_result_at: Date | null;
  /** Moment of manual cancellation by the operator; prevents late rescue if present. */
  cancelled_at: Date | null;
}
export type LateClaimProvenance = 'current' | 'applied' | 'observed' | 'none';
export interface AckResult {
  delivery_id: string;
  status: DeliveryState;
  applied: boolean;
  receipt: 'applied' | 'duplicate' | 'superseded' | 'ownership_lost';
  /** Present only when some `messages` output did not become a delivery. */
  delegation_rejections?: DelegationRejection[];
  /** Outputs materialised with the exact identity of the child delivery; never includes bodies. */
  delegation_materializations?: DelegationMaterialization[];
  /**
   * The branch was suspended waiting on a person; an open gate will resume it.
   *
   * The type comes from the frame schema on purpose: the two fields below TRAVEL to the adapter
   * inside `ack_result`, so changing their shape here without changing the schema there must
   * break the build. That is precisely what did not happen when they were added.
   */
  chain_gate?: ChainGateNotice;
}
export interface AgentOutputOutcome {
  materialized: number;
  /**
   * The branch opened a human gate: it must NOT return its response upward, because it did not
   * finish — it is waiting. It is the difference between "suspended" and "failed", and it is what
   * stops a gate from becoming a dead delivery.
   */
  suspended: boolean;
  rejections: DelegationRejection[];
  materializations: DelegationMaterialization[];
  /** The root's active gate, if this materialisation ran into one or opened one. */
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
export const maxNotifyBodyBytes = MAX_NOTIFY_BODY_BYTES;
const maxNotifyAggregateBytes = 8 * 1024;
export const notifyKinds = new Set<string>(NOTIFY_KINDS);
export function isEgressHandle(value: string): boolean {
  return EgressHandleSchema.safeParse(value).success;
}
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
    if (!entry || typeof entry.to !== 'string' || !isEgressHandle(entry.to)
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

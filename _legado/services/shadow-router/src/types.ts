import type { Tenant } from '@cauce/protocol';

export type ShadowDirection = 'v2-to-v3' | 'v3-to-v2';
export type ShadowMode = 'shadow' | 'compare' | 'cutover';
export type ShadowMappingStatus = 'processing' | 'shadowed' | 'compared' | 'delivered' | 'blocked' | 'failed';

export interface ShadowCorrelation {
  request_id: string;
  trace_id: string;
  message_id?: string;
  conversation_key?: string;
}

export interface ShadowEnvelope {
  direction: ShadowDirection;
  source_event_id: string;
  tenant_id: Tenant;
  correlation: ShadowCorrelation;
  payload: Record<string, unknown>;
  baseline?: unknown;
  expects_human_reply: boolean;
}

export interface ShadowMapping {
  direction: ShadowDirection;
  source_event_id: string;
  tenant_id: Tenant;
  mode: ShadowMode;
  target_event_id: string;
  correlation: ShadowCorrelation;
  status: ShadowMappingStatus;
  created: boolean;
}

export interface ShadowVerdict {
  verdict: 'match' | 'mismatch' | 'no_baseline';
  baseline_hash?: string;
  candidate_hash: string;
  metadata: Record<string, unknown>;
}

export interface ShadowMappingRepository {
  begin(envelope: ShadowEnvelope, mode: ShadowMode, signal?: AbortSignal): Promise<ShadowMapping>;
  complete(mapping: ShadowMapping, status: ShadowMappingStatus, signal?: AbortSignal): Promise<void>;
  recordVerdict(mapping: ShadowMapping, verdict: ShadowVerdict, signal?: AbortSignal): Promise<void>;
  reserveHumanReply(
    mapping: ShadowMapping,
    correlationKey: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

export interface ShadowTargetRequest {
  target_event_id: string;
  source_event_id: string;
  tenant_id: Tenant;
  direction: ShadowDirection;
  correlation: ShadowCorrelation;
  payload: Record<string, unknown>;
  allow_human_reply: boolean;
  allow_harness: boolean;
}

export interface ShadowTargetResult {
  output?: unknown;
  target_message_id?: string;
}

export interface ShadowTarget {
  preview(request: ShadowTargetRequest, signal?: AbortSignal): Promise<ShadowTargetResult>;
  deliver(request: ShadowTargetRequest, signal?: AbortSignal): Promise<ShadowTargetResult>;
}

export interface ShadowTargetRegistry {
  forDirection(direction: ShadowDirection): ShadowTarget | undefined;
}

export interface ShadowInboxLease {
  id: string;
  direction: ShadowDirection;
  source_event_id: string;
  tenant_id: Tenant;
  mode: ShadowMode;
  envelope: ShadowEnvelope;
  /** Prospective attempt number; durable `attempts` advances only at observed settlement. */
  attempt: number;
  max_attempts: number;
  claim_token: string;
}

export interface ShadowInboxHealth {
  readonly pending: number;
  readonly failed: number;
  readonly dead: number;
  readonly processing: number;
  readonly owned_processing: number;
  readonly orphaned_processing: number;
  readonly oldest_ready_seconds: number;
}

export interface ShadowInboxRepository {
  enqueue(
    envelope: ShadowEnvelope,
    mode: ShadowMode,
    signal?: AbortSignal,
  ): Promise<{ id: string; duplicate: boolean }>;
  claim(workerId: string, limit: number, leaseMs: number, signal?: AbortSignal): Promise<ShadowInboxLease[]>;
  /** Durably arms idempotent dispatch immediately before the target method boundary. */
  markTargetStarted(lease: ShadowInboxLease, signal?: AbortSignal): Promise<void>;
  completeInbox(lease: ShadowInboxLease, signal?: AbortSignal): Promise<void>;
  retryInbox(
    lease: ShadowInboxLease,
    delayMs: number,
    error: string,
    signal?: AbortSignal,
  ): Promise<'retry' | 'dead' | 'done'>;
  /** Return a lease whose target was provably never invoked; the attempt is not consumed. */
  releaseUnstartedInbox(lease: ShadowInboxLease, reason: string, signal?: AbortSignal): Promise<void>;
  /** Stop advertising a fenced DB lease as actively owned after all bounded settlement failed. */
  abandonLocalInboxClaim(lease: ShadowInboxLease): void;
  health(signal?: AbortSignal): Promise<ShadowInboxHealth>;
}

export type ShadowMetric =
  | 'ingress_accepted' | 'ingress_duplicate' | 'ingress_denied' | 'ingress_conflict'
  | 'shadowed' | 'compared_match' | 'compared_mismatch' | 'cutover_delivered'
  | 'human_reply_blocked' | 'failed';

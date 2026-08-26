import { createHash } from 'node:crypto';
import { TenantSchema } from '@cauce/protocol';
import { ShadowRouteExecutionError } from './errors.js';
import type {
  ShadowCorrelation, ShadowDirection, ShadowEnvelope, ShadowMappingRepository,
  ShadowMetric, ShadowMode, ShadowTargetRegistry, ShadowTargetRequest, ShadowVerdict
} from './types.js';

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max ||
      [...value].some((character) => character.charCodeAt(0) < 32)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function direction(value: unknown): ShadowDirection {
  if (value !== 'v2-to-v3' && value !== 'v3-to-v2') throw new Error('direction is invalid');
  return value;
}

function correlation(value: unknown): ShadowCorrelation {
  const row = object(value, 'correlation');
  return {
    request_id: text(row.request_id, 'correlation.request_id'),
    trace_id: text(row.trace_id, 'correlation.trace_id'),
    ...(row.message_id === undefined ? {} : { message_id: text(row.message_id, 'correlation.message_id') }),
    ...(row.conversation_key === undefined
      ? {} : { conversation_key: text(row.conversation_key, 'correlation.conversation_key') })
  };
}

export function parseShadowEnvelope(value: unknown, expectedDirection?: ShadowDirection): ShadowEnvelope {
  const row = object(value, 'shadow envelope');
  const parsedDirection = direction(row.direction);
  if (expectedDirection && parsedDirection !== expectedDirection) throw new Error('endpoint direction mismatch');
  return {
    direction: parsedDirection,
    source_event_id: text(row.source_event_id, 'source_event_id', 512),
    tenant_id: TenantSchema.parse(row.tenant_id),
    correlation: correlation(row.correlation),
    payload: object(row.payload, 'payload'),
    ...(row.baseline === undefined ? {} : { baseline: row.baseline }),
    expects_human_reply: row.expects_human_reply === true
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex');
}

function bytes(value: unknown): number {
  return Math.min(1_000_000_000, Buffer.byteLength(JSON.stringify(value) ?? 'undefined'));
}

export function compareRedacted(baseline: unknown, candidate: unknown): ShadowVerdict {
  const candidateHash = digest(candidate);
  if (baseline === undefined) {
    return {
      verdict: 'no_baseline',
      candidate_hash: candidateHash,
      metadata: { candidate_bytes: bytes(candidate) }
    };
  }
  const baselineHash = digest(baseline);
  return {
    verdict: baselineHash === candidateHash ? 'match' : 'mismatch',
    baseline_hash: baselineHash,
    candidate_hash: candidateHash,
    metadata: { baseline_bytes: bytes(baseline), candidate_bytes: bytes(candidate) }
  };
}

export interface ShadowRouterOptions {
  mode?: ShadowMode;
  cutoverDirection?: ShadowDirection;
  allowedTenants: ReadonlySet<string>;
  repository: ShadowMappingRepository;
  targets: ShadowTargetRegistry;
  onMetric?: (metric: ShadowMetric) => void;
}

export interface ShadowRouteResult {
  target_event_id: string;
  status: 'shadowed' | 'compared' | 'delivered' | 'blocked';
  duplicate: boolean;
  human_reply: boolean;
  /** Whether this invocation crossed the target method boundary. */
  target_invoked: boolean;
  verdict?: ShadowVerdict['verdict'];
}

export interface ShadowRouteHooks {
  /** Persist the inbox attempt immediately before invoking preview/deliver. */
  beforeTarget?: (signal?: AbortSignal) => Promise<void>;
}

export class ShadowRouter {
  readonly mode: ShadowMode;
  private readonly cutoverDirection: ShadowDirection | undefined;
  private readonly allowedTenants: ReadonlySet<string>;
  private readonly repository: ShadowMappingRepository;
  private readonly targets: ShadowTargetRegistry;
  private readonly onMetric: (metric: ShadowMetric) => void;

  constructor(options: ShadowRouterOptions) {
    this.mode = options.mode ?? 'shadow';
    this.cutoverDirection = options.cutoverDirection;
    this.allowedTenants = options.allowedTenants;
    this.repository = options.repository;
    this.targets = options.targets;
    this.onMetric = options.onMetric ?? (() => undefined);
    if (this.allowedTenants.size === 0) throw new Error('shadow router tenant allowlist is required');
    if (this.mode === 'cutover' && !this.cutoverDirection) throw new Error('cutover direction must be explicit');
    if (this.mode !== 'cutover' && this.cutoverDirection) throw new Error('cutover direction is only valid in cutover mode');
  }

  async route(
    input: ShadowEnvelope,
    signal?: AbortSignal,
    hooks: ShadowRouteHooks = {},
  ): Promise<ShadowRouteResult> {
    let targetInvoked = false;
    try {
      signal?.throwIfAborted();
      const envelope = parseShadowEnvelope(input);
      if (!this.allowedTenants.has(envelope.tenant_id)) throw new Error('tenant is not allowed');
      if (this.mode === 'cutover' && envelope.direction !== this.cutoverDirection) {
        throw new Error('direction is not enabled for cutover');
      }
      const target = this.targets.forDirection(envelope.direction);
      if (!target) throw new Error('target is unavailable');
      const mapping = await this.repository.begin(envelope, this.mode, signal);
      if (mapping.status !== 'processing' && mapping.status !== 'failed') {
        return {
          target_event_id: mapping.target_event_id,
          status: mapping.status === 'shadowed' || mapping.status === 'compared' || mapping.status === 'delivered'
            ? mapping.status : 'blocked',
          duplicate: true,
          human_reply: mapping.status === 'delivered' && envelope.expects_human_reply,
          target_invoked: false,
        };
      }
      const request: ShadowTargetRequest = {
        target_event_id: mapping.target_event_id,
        source_event_id: envelope.source_event_id,
        tenant_id: envelope.tenant_id,
        direction: envelope.direction,
        correlation: envelope.correlation,
        payload: envelope.payload,
        allow_human_reply: false,
        allow_harness: false
      };
      try {
        if (this.mode === 'shadow') {
          await hooks.beforeTarget?.(signal);
          targetInvoked = true;
          await target.preview(request, signal);
          signal?.throwIfAborted();
          await this.repository.complete(mapping, 'shadowed', signal);
          this.onMetric('shadowed');
          return {
            target_event_id: mapping.target_event_id,
            status: 'shadowed',
            duplicate: false,
            human_reply: false,
            target_invoked: true,
          };
        }
        if (this.mode === 'compare') {
          await hooks.beforeTarget?.(signal);
          targetInvoked = true;
          const preview = await target.preview(request, signal);
          signal?.throwIfAborted();
          const verdict = compareRedacted(envelope.baseline, preview.output);
          await this.repository.recordVerdict(mapping, verdict, signal);
          await this.repository.complete(mapping, 'compared', signal);
          this.onMetric(verdict.verdict === 'match' ? 'compared_match' : 'compared_mismatch');
          return {
            target_event_id: mapping.target_event_id,
            status: 'compared',
            duplicate: false,
            human_reply: false,
            target_invoked: true,
            verdict: verdict.verdict
          };
        }
        let allowHumanReply = false;
        if (envelope.expects_human_reply) {
          const key = envelope.correlation.conversation_key ?? envelope.correlation.request_id;
          allowHumanReply = await this.repository.reserveHumanReply(mapping, key, signal);
          if (!allowHumanReply) {
            await this.repository.complete(mapping, 'blocked', signal);
            this.onMetric('human_reply_blocked');
            return {
              target_event_id: mapping.target_event_id,
              status: 'blocked',
              duplicate: true,
              human_reply: false,
              target_invoked: false,
            };
          }
        }
        await hooks.beforeTarget?.(signal);
        targetInvoked = true;
        await target.deliver(
          { ...request, allow_human_reply: allowHumanReply, allow_harness: true },
          signal,
        );
        signal?.throwIfAborted();
        await this.repository.complete(mapping, 'delivered', signal);
        this.onMetric('cutover_delivered');
        return {
          target_event_id: mapping.target_event_id,
          status: 'delivered',
          duplicate: false,
          human_reply: allowHumanReply,
          target_invoked: true,
        };
      } catch (error) {
        await this.repository.complete(mapping, 'failed', signal);
        this.onMetric('failed');
        throw error;
      }
    } catch (error) {
      throw new ShadowRouteExecutionError(error, targetInvoked);
    }
  }
}

import { describe, expect, it } from 'vitest';
import { ShadowRouter } from '../src/router.js';
import { MapShadowTargetRegistry } from '../src/target.js';
import type {
  ShadowEnvelope, ShadowMapping, ShadowMappingRepository, ShadowMappingStatus, ShadowMode,
  ShadowTarget, ShadowTargetRequest, ShadowTargetResult, ShadowVerdict
} from '../src/types.js';

const TENANT = 'Steven';

function envelope(overrides: Partial<ShadowEnvelope> = {}): ShadowEnvelope {
  return {
    direction: 'v2-to-v3',
    source_event_id: 'v2-event-1',
    tenant_id: TENANT,
    correlation: {
      request_id: 'request-1',
      trace_id: 'trace-1',
      message_id: 'message-1',
      conversation_key: 'conversation-1'
    },
    payload: { text: 'synthetic input' },
    expects_human_reply: true,
    ...overrides
  };
}

class MemoryMappingRepository implements ShadowMappingRepository {
  readonly mappings = new Map<string, ShadowMapping>();
  readonly verdicts: ShadowVerdict[] = [];
  readonly replyGuards = new Map<string, string>();
  sequence = 0;

  async begin(input: ShadowEnvelope, mode: ShadowMode): Promise<ShadowMapping> {
    const key = `${input.direction}:${input.source_event_id}`;
    const existing = this.mappings.get(key);
    if (existing) return { ...existing, created: false };
    this.sequence += 1;
    const mapping: ShadowMapping = {
      direction: input.direction,
      source_event_id: input.source_event_id,
      tenant_id: input.tenant_id,
      mode,
      target_event_id: `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`,
      correlation: input.correlation,
      status: 'processing',
      created: true
    };
    this.mappings.set(key, mapping);
    return mapping;
  }

  async complete(mapping: ShadowMapping, status: ShadowMappingStatus): Promise<void> {
    const key = `${mapping.direction}:${mapping.source_event_id}`;
    this.mappings.set(key, { ...mapping, status, created: false });
  }

  async recordVerdict(_mapping: ShadowMapping, verdict: ShadowVerdict): Promise<void> {
    this.verdicts.push(verdict);
  }

  async reserveHumanReply(mapping: ShadowMapping, correlationKey: string): Promise<boolean> {
    const key = `${mapping.tenant_id}:${correlationKey}`;
    const existing = this.replyGuards.get(key);
    if (existing) return existing === mapping.target_event_id;
    this.replyGuards.set(key, mapping.target_event_id);
    return true;
  }
}

class FakeIngressTarget implements ShadowTarget {
  readonly previews: ShadowTargetRequest[] = [];
  readonly deliveries: ShadowTargetRequest[] = [];
  readonly deliveredIds = new Set<string>();

  constructor(readonly output: unknown = { answer: 'candidate' }) {}

  async preview(request: ShadowTargetRequest): Promise<ShadowTargetResult> {
    this.previews.push(request);
    return { output: this.output };
  }

  async deliver(request: ShadowTargetRequest): Promise<ShadowTargetResult> {
    if (!this.deliveredIds.has(request.target_event_id)) {
      this.deliveries.push(request);
      this.deliveredIds.add(request.target_event_id);
    }
    return { target_message_id: request.target_event_id };
  }
}

function router(
  mode: ShadowMode,
  repository: MemoryMappingRepository,
  v3: FakeIngressTarget,
  v2 = new FakeIngressTarget()
): ShadowRouter {
  return new ShadowRouter({
    mode,
    ...(mode === 'cutover' ? { cutoverDirection: 'v2-to-v3' as const } : {}),
    allowedTenants: new Set([TENANT]),
    repository,
    targets: new MapShadowTargetRegistry([['v2-to-v3', v3], ['v3-to-v2', v2]])
  });
}

describe('identity-free shadow routing', () => {
  it('defaults to shadow/read-only and never invokes human or harness side effects', async () => {
    const repository = new MemoryMappingRepository();
    const target = new FakeIngressTarget();
    const instance = new ShadowRouter({
      allowedTenants: new Set([TENANT]),
      repository,
      targets: new MapShadowTargetRegistry([['v2-to-v3', target]])
    });

    const result = await instance.route(envelope());

    expect(result).toMatchObject({ status: 'shadowed', human_reply: false, target_invoked: true });
    expect(target.previews).toHaveLength(1);
    expect(target.previews[0]).toMatchObject({ allow_human_reply: false, allow_harness: false });
    expect(target.deliveries).toHaveLength(0);
  });

  it('records only redacted compare hashes and preserves correlation', async () => {
    const repository = new MemoryMappingRepository();
    const output = { answer: 'same' };
    const target = new FakeIngressTarget(output);
    const input = envelope({ baseline: output, expects_human_reply: false });

    const result = await router('compare', repository, target).route(input);

    expect(result.verdict).toBe('match');
    expect(repository.verdicts[0]).toMatchObject({ verdict: 'match' });
    expect(JSON.stringify(repository.verdicts[0])).not.toContain('same');
    expect(target.previews[0]?.correlation).toEqual(input.correlation);
    expect(target.deliveries).toHaveLength(0);
  });

  it('maps explicit cutover once and sends one human reply for duplicates', async () => {
    const repository = new MemoryMappingRepository();
    const target = new FakeIngressTarget();
    const instance = router('cutover', repository, target);
    const input = envelope();

    const first = await instance.route(input);
    const duplicate = await instance.route(input);

    expect(first).toMatchObject({
      status: 'delivered', human_reply: true, duplicate: false, target_invoked: true,
    });
    expect(duplicate).toMatchObject({ status: 'delivered', duplicate: true, target_invoked: false });
    expect(duplicate.target_event_id).toBe(first.target_event_id);
    expect(target.deliveries).toHaveLength(1);
    expect(target.deliveries[0]).toMatchObject({
      allow_human_reply: true,
      allow_harness: true,
      correlation: input.correlation
    });
  });

  it('blocks a second source event for the same human correlation', async () => {
    const repository = new MemoryMappingRepository();
    const target = new FakeIngressTarget();
    const instance = router('cutover', repository, target);
    await instance.route(envelope());

    const second = await instance.route(envelope({ source_event_id: 'v2-event-2' }));

    expect(second).toMatchObject({ status: 'blocked', human_reply: false, target_invoked: false });
    expect(target.deliveries).toHaveLength(1);
  });

  it('routes V3 to a fake V2 ingress without changing correlation', async () => {
    const repository = new MemoryMappingRepository();
    const fakeV2Ingress = new FakeIngressTarget();
    const instance = new ShadowRouter({
      mode: 'cutover',
      cutoverDirection: 'v3-to-v2',
      allowedTenants: new Set([TENANT]),
      repository,
      targets: new MapShadowTargetRegistry([['v3-to-v2', fakeV2Ingress]])
    });
    const input = envelope({ direction: 'v3-to-v2', source_event_id: 'v3-event-1' });

    await instance.route(input);

    expect(fakeV2Ingress.deliveries).toHaveLength(1);
    expect(fakeV2Ingress.deliveries[0]?.correlation).toEqual(input.correlation);
  });

  it('fails closed for a tenant outside the allowlist', async () => {
    const repository = new MemoryMappingRepository();
    const target = new FakeIngressTarget();
    await expect(router('shadow', repository, target).route(
      envelope({ tenant_id: 'Isa' })
    )).rejects.toThrow('tenant is not allowed');
    expect(target.previews).toHaveLength(0);
    expect(target.deliveries).toHaveLength(0);
  });
});

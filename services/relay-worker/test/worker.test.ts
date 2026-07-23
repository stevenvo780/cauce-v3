import { describe, expect, it } from 'vitest';
import { FakeOriginTransport, MapOriginTransportRegistry } from '../src/transports.js';
import { OriginRelayWorker } from '../src/worker.js';
import type { OriginRelayAck, OriginRelayEvent, OriginRelayRepository } from '../src/types.js';

function relayEvent(adapter: string, eventId: string): OriginRelayEvent {
  return {
    event_id: eventId,
    attempt: 1,
    max_attempts: 3,
    claim_token: `claim-${eventId}`,
    tenant_id: 'Steven',
    adapter,
    request_id: `req-${eventId}`,
    message_id: `msg-${eventId}`,
    delivery_id: null,
    trace_id: `trace-${eventId}`,
    origin: { adapter, channel: 'dm', conversation_id: 'conversation-1', relay: [], metadata: {} },
    payload: { outcome: 'done', result: { text: 'reply' } }
  };
}

/**
 * Repository double that mirrors the store's OPTIONAL adapter filter
 * (`AND ($5::text IS NULL OR adapter=$5)`): a claim only returns events whose
 * adapter matches the requested scope. A worker that never scopes a claim to
 * 'telegram' therefore never leases the telegram event — exactly the G1 guarantee.
 * An UNSCOPED claim (the pre-fix bug) would instead have to be modelled as
 * returning every pending event, which is why the fixed worker must always pass
 * an explicit adapter.
 */
class AdapterScopedRepository implements OriginRelayRepository {
  readonly claimScopes: string[] = [];
  readonly acknowledgements: OriginRelayAck[] = [];
  private readonly pending: Map<string, OriginRelayEvent[]>;

  constructor(pending: Iterable<readonly [string, OriginRelayEvent[]]>) {
    this.pending = new Map([...pending].map(([adapter, events]) => [adapter, [...events]]));
  }

  async claim(_workerId: string, limit: number, _leaseMs: number, adapter: string): Promise<OriginRelayEvent[]> {
    this.claimScopes.push(adapter);
    const queue = this.pending.get(adapter) ?? [];
    return queue.splice(0, limit);
  }

  async ack(acknowledgement: OriginRelayAck): Promise<void> {
    this.acknowledgements.push(acknowledgement);
  }
}

describe('origin relay worker adapter scoping (G1)', () => {
  it('never claims a telegram origin_relay event when only webhook-x is configured', async () => {
    const telegram = relayEvent('telegram', 'telegram-1');
    const repository = new AdapterScopedRepository([
      ['telegram', [telegram]],
      ['webhook-x', []]
    ]);
    const transport = new FakeOriginTransport();
    const worker = new OriginRelayWorker({
      repository,
      transports: new MapOriginTransportRegistry([['webhook-x', transport]])
    });

    const processed = await worker.runOnce();

    // The worker only ever scopes its claim to the adapters it serves.
    expect(repository.claimScopes).toEqual(['webhook-x']);
    expect(repository.claimScopes).not.toContain('telegram');
    // Nothing processed, nothing sent, and — crucially — the telegram event is
    // neither claimed nor DLQ'd (no ACK): it stays available for the bridge.
    expect(processed).toBe(0);
    expect(transport.effects).toEqual([]);
    expect(repository.acknowledgements).toEqual([]);
  });

  it('claims and delivers only the adapters it serves', async () => {
    const own = relayEvent('webhook-x', 'webhook-x-1');
    const foreign = relayEvent('telegram', 'telegram-2');
    const repository = new AdapterScopedRepository([
      ['webhook-x', [own]],
      ['telegram', [foreign]]
    ]);
    const transport = new FakeOriginTransport();
    const worker = new OriginRelayWorker({
      repository,
      transports: new MapOriginTransportRegistry([['webhook-x', transport]])
    });

    const processed = await worker.runOnce();

    expect(processed).toBe(1);
    expect(repository.claimScopes).toEqual(['webhook-x']);
    expect(transport.effects.map((event) => event.event_id)).toEqual(['webhook-x-1']);
    expect(repository.acknowledgements).toEqual([
      { event_id: 'webhook-x-1', attempt: 1, claim_token: 'claim-webhook-x-1', status: 'sent' }
    ]);
    // The telegram event queued under its own adapter was never scoped/claimed.
    expect(repository.claimScopes).not.toContain('telegram');
  });

  it('scopes each configured adapter and still excludes telegram', async () => {
    const a = relayEvent('webhook-x', 'wx-1');
    const b = relayEvent('webhook-y', 'wy-1');
    const telegram = relayEvent('telegram', 'tg-3');
    const repository = new AdapterScopedRepository([
      ['webhook-x', [a]],
      ['webhook-y', [b]],
      ['telegram', [telegram]]
    ]);
    const transport = new FakeOriginTransport();
    const worker = new OriginRelayWorker({
      repository,
      transports: new MapOriginTransportRegistry([
        ['webhook-x', transport],
        ['webhook-y', transport]
      ])
    });

    const processed = await worker.runOnce();

    expect(processed).toBe(2);
    expect([...repository.claimScopes].sort()).toEqual(['webhook-x', 'webhook-y']);
    expect(repository.claimScopes).not.toContain('telegram');
    expect(transport.effects.map((event) => event.event_id).sort()).toEqual(['wx-1', 'wy-1']);
  });
});

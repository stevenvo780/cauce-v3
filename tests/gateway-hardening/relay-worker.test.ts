import { describe, expect, it, vi } from 'vitest';
import {
  FakeOriginTransport, HttpWebhookOriginTransport, MapOriginTransportRegistry,
  OriginRelayWorker, OriginTransportError,
  type OriginRelayAck, type OriginRelayEvent, type OriginRelayRepository
} from '../../services/relay-worker/src/index.js';
import { ids } from './helpers.js';

function relay(attempt = 1, maxAttempts = 3): OriginRelayEvent {
  return {
    event_id: ids.event,
    attempt,
    max_attempts: maxAttempts,
    claim_token: attempt === 1 ? ids.claim : ids.claimTwo,
    tenant_id: 'Pablo',
    adapter: 'webhook',
    request_id: ids.request,
    message_id: ids.message,
    delivery_id: ids.delivery,
    trace_id: 'trace-relay',
    origin: {
      adapter: 'webhook', channel: 'dm', conversation_id: 'conversation-1', relay: [], metadata: {}
    },
    payload: { outcome: 'done', result: { text: 'reply' } }
  };
}

class QueueRepository implements OriginRelayRepository {
  readonly acknowledgements: OriginRelayAck[] = [];

  constructor(private readonly batches: OriginRelayEvent[][]) {}

  async claim(): Promise<OriginRelayEvent[]> {
    return this.batches.shift() ?? [];
  }

  async ack(acknowledgement: OriginRelayAck): Promise<void> {
    this.acknowledgements.push(acknowledgement);
  }
}

describe('origin relay worker', () => {
  it('moves pending to sent with exactly one downstream effect', async () => {
    const repository = new QueueRepository([[relay()], []]);
    const transport = new FakeOriginTransport();
    const worker = new OriginRelayWorker({
      repository,
      transports: new MapOriginTransportRegistry([['webhook', transport]]),
      leaseMs: 1_000
    });

    expect(await worker.runOnce()).toBe(1);
    expect(await worker.runOnce()).toBe(0);
    expect(transport.effects).toHaveLength(1);
    expect(repository.acknowledgements).toEqual([{
      event_id: ids.event, attempt: 1, claim_token: ids.claim, status: 'sent'
    }]);
  });

  it('retries a transient failure and ACKs DLQ after exhaustion', async () => {
    const repository = new QueueRepository([[relay(1, 2)], [relay(2, 2)]]);
    const transport = new FakeOriginTransport([
      new OriginTransportError('temporary one', true),
      new OriginTransportError('temporary two', true)
    ]);
    const worker = new OriginRelayWorker({
      repository,
      transports: new MapOriginTransportRegistry([['webhook', transport]]),
      leaseMs: 1_000,
      baseRetryMs: 10,
      maxAttempts: 2
    });

    await worker.runOnce();
    await worker.runOnce();

    expect(repository.acknowledgements).toEqual([
      expect.objectContaining({ event_id: ids.event, attempt: 1, status: 'retry', retry_after_ms: 10 }),
      expect.objectContaining({ event_id: ids.event, attempt: 2, status: 'dead' })
    ]);
    expect(transport.effects).toHaveLength(0);
  });

  it('allowlists HTTPS webhooks and obtains only a signature from the provider', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(null, {
        status: 204,
        headers: { 'x-provider-message-id': 'remote-1' }
      });
    });
    const provider = {
      endpoint: vi.fn(async () => 'https://hooks.test/cauce'),
      sign: vi.fn(async () => ({ header: 'x-cauce-signature', value: 'opaque-signature' }))
    };
    const transport = new HttpWebhookOriginTransport({
      provider,
      allowedOrigins: ['https://hooks.test'],
      fetcher,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }]
    });

    await expect(transport.send(relay())).resolves.toEqual({ provider_message_id: 'remote-1' });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: 'error',
      headers: {
        'idempotency-key': ids.event,
        'x-cauce-signature': 'opaque-signature'
      }
    });

    provider.endpoint.mockResolvedValueOnce('https://169.254.169.254/metadata');
    await expect(transport.send(relay())).rejects.toMatchObject({ retryable: false });
    expect(fetcher).toHaveBeenCalledOnce();

    const dnsRebinding = new HttpWebhookOriginTransport({
      provider,
      allowedOrigins: ['https://hooks.test'],
      fetcher,
      resolver: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    await expect(dnsRebinding.send(relay())).rejects.toThrow('non-public address');
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

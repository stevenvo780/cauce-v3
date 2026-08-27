import { describe, expect, it } from 'vitest';
import { HttpWebhookOriginTransport, MapOriginTransportRegistry } from '../src/transports.js';
import type { OriginRelayEvent } from '../src/types.js';

const event: OriginRelayEvent = {
  event_id: 'event-timeout', attempt: 1, max_attempts: 3, claim_token: 'claim',
  tenant_id: 'Steven', adapter: 'webhook-x', request_id: 'request', message_id: 'message',
  delivery_id: null, trace_id: 'trace',
  origin: { adapter: 'webhook-x', channel: 'dm', conversation_id: 'conversation', relay: [], metadata: {} },
  payload: { outcome: 'done' }
};

describe('HTTP origin transport total deadline', () => {
  it('bounds a provider that never resolves before any remote request can start', async () => {
    let fetched = false;
    const transport = new HttpWebhookOriginTransport({
      provider: {
        endpoint: async () => await new Promise<string>(() => undefined),
        sign: async () => ({ header: 'x-signature', value: 'unused' })
      },
      allowedOrigins: ['https://example.com'],
      timeoutMs: 20,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      fetcher: async () => { fetched = true; return new Response('{}'); }
    });

    await expect(transport.send(event)).rejects.toThrow('deadline exceeded');
    expect(fetched).toBe(false);
  });

  it('classifies DNS transport failures as retryable and private answers as terminal', async () => {
    const options = {
      provider: {
        endpoint: async () => 'https://example.com/hook',
        sign: async () => ({ header: 'x-signature', value: 'signature' })
      },
      allowedOrigins: ['https://example.com'], timeoutMs: 1_000,
      fetcher: async () => new Response('{}')
    };
    const dnsFailure = new HttpWebhookOriginTransport({
      ...options, resolver: async () => { throw new Error('temporary resolver failure'); }
    });
    await expect(dnsFailure.send(event)).rejects.toMatchObject({ retryable: true });

    const privateAnswer = new HttpWebhookOriginTransport({
      ...options, resolver: async () => [{ address: '127.0.0.1', family: 4 }]
    });
    await expect(privateAnswer.send(event)).rejects.toMatchObject({ retryable: false });
  });

  it('reserves telegram exclusively for telegram-bridge', () => {
    expect(() => new MapOriginTransportRegistry([['telegram', { async send() { return {}; } }]]))
      .toThrow('reserved for telegram-bridge');
  });
});

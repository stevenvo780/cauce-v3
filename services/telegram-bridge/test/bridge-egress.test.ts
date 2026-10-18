import { describe, expect, it } from 'vitest';
import { TelegramEgressWorker } from '../src/egress.js';
import { TelegramHttpClient } from '../src/telegram.js';
import {
  config, FakeTelegram,
  MemoryEgressRepository, relay, noopActivity, noopObserver
} from './bridge-fixtures.js';

describe('Telegram fenced egress', () => {
  it('claims one fresh outbox lease and renews it before each remote effect', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));

    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', api]])
    }).runOnce();

    expect(repository.claimLimits).toEqual([1]);
    expect(repository.renewCalls).toBeGreaterThanOrEqual(5);
    expect(api.sends).toHaveLength(2);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });

  it('does not call Telegram after renewal is fenced', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    const metrics: string[] = [];
    repository.renewAllowed = false;

    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', api]]),
      onMetric: (metric) => metrics.push(metric)
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements).toHaveLength(0);
    expect(metrics).toContain('egress_fenced');
    expect(metrics).not.toContain('egress_sent');
  });

  it('honors fake Telegram HTTP 429 retry_after', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response(JSON.stringify({
        ok: false, error_code: 429, parameters: { retry_after: 7 }
      }), { status: 429, headers: { 'content-type': 'application/json' } })
    });
    const repository = new MemoryEgressRepository(relay());
    const worker = new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', client]]), baseRetryMs: 10
    });

    await worker.runOnce();

    expect(repository.acknowledgements).toEqual([
      expect.objectContaining({ status: 'retry', retry_after_ms: 7_000 })
    ]);
    expect([...repository.effects.values()][0]?.state).toBe('prepared');
  });

  it('treats an unreadable 2xx send response as remotely ambiguous, not a safe retry', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response('not-json', { status: 200 })
    });
    const repository = new MemoryEgressRepository(relay());
    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', client]])
    }).runOnce();

    expect([...repository.effects.values()][0]?.state).toBe('ambiguous');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'retry')).toBe(false);
  });

  it('ACKs a multi-chunk event sent only after every chunk is durably sent', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));
    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(2);
    expect([...repository.effects.values()].map((effect) => effect.state)).toEqual(['sent', 'sent']);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 2 });
  });

  it('fails closed on a cross-tenant origin', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({ tenant_id: 'Isa' }));
    await new TelegramEgressWorker({
      activity: noopActivity(), observer: noopObserver(),
      repository, aliases: [config()], apis: new Map([['Steven/kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements[0]?.status).toBe('dead');
  });
});

describe('Telegram egress tenant identity', () => {
  it.each(['North', 'South'])('uses the exact tenant API for the shared alias in %s', async tenant => {
    const north = new FakeTelegram(); const south = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({ tenant_id: tenant }));
    const aliases = ['North', 'South'].map(tenant_id => config({ tenant_id, recipients: [{ tenant_id, alias: 'kant' }] }));
    await new TelegramEgressWorker({ repository, aliases, apis: new Map([['North/kant', north], ['South/kant', south]]),
      activity: noopActivity(), observer: noopObserver() }).runOnce();
    expect(north.sends).toHaveLength(tenant === 'North' ? 1 : 0);
    expect(south.sends).toHaveLength(tenant === 'South' ? 1 : 0);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });
});

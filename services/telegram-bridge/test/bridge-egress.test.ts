import { describe, expect, it } from 'vitest';
import { TelegramActivityIndicator } from '../src/activity.js';
import { TelegramEgressWorker } from '../src/egress.js';
import { TelegramApiError, TelegramHttpClient } from '../src/telegram.js';
import {
  config, FailingActivityTelegram, FakeTelegram, GROUP_CHAT_ID, groupRelay,
  legacyGroupConfig, MemoryEgressRepository, proactiveRelay, RejectingSendTelegram, relay
} from './bridge-fixtures.js';

describe('Telegram fenced egress', () => {
  it('claims one fresh outbox lease and renews it before each remote effect', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]), batchSize: 20
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
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      onMetric: (metric) => metrics.push(metric)
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements).toHaveLength(0);
    expect(metrics).toContain('egress_fenced');
    expect(metrics).not.toContain('egress_sent');
  });

  it('does not count or rewrite a remote send whose durable ACK is fenced', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay());
    const metrics: string[] = [];
    repository.failAck = true;

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]]),
      onMetric: (metric) => metrics.push(metric)
    }).runOnce();

    expect(api.sends).toHaveLength(1);
    expect([...repository.effects.values()][0]?.state).toBe('sent');
    expect(repository.acknowledgements).toHaveLength(0);
    expect(metrics).toContain('egress_fenced');
    expect(metrics).not.toContain('egress_sent');
    expect(metrics).not.toContain('egress_retry');
  });

  it('sends an interim relay ACK without finishing the original Telegram activity', async () => {
    const api = new FakeTelegram();
    const finishes: Array<{ outcome: string }> = [];
    const repository = new MemoryEgressRepository(relay({
      payload: {
        relay_kind: 'ack',
        terminal: false,
        outcome: 'ack',
        result: {
          output: {
            reply: 'Recibido; estoy trabajando en ello.',
            messages: [],
            status: 'done',
            retryable: false,
            artifacts: []
          }
        }
      }
    }));

    await new TelegramEgressWorker({
      repository,
      aliases: [config()],
      apis: new Map([['kant', api]]),
      activity: {
        begin: () => undefined,
        finish: (_target, outcome) => finishes.push({ outcome }),
        stop: () => undefined
      }
    }).runOnce();

    expect(api.sends).toEqual([{
      chat: '201',
      text: 'Recibido; estoy trabajando en ello.',
      options: { parse_mode: 'html' },
      arity: 3
    }]);
    expect(repository.acknowledgements.at(-1)).toMatchObject({
      status: 'sent',
      effect_count: 1
    });
    expect(finishes).toEqual([]);

    repository.outboxState = 'failed';
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    expect(api.sends).toHaveLength(1);
    expect(repository.acknowledgements.at(-1)).toMatchObject({
      status: 'sent',
      effect_count: 1
    });
  });

  it('delivers MISSING_FINAL_REPLY through the durable effect ledger with a safe human notice', async () => {
    const api = new FakeTelegram();
    const finishes: Array<{ outcome: string }> = [];
    const metrics: string[] = [];
    const repository = new MemoryEgressRepository(relay({
      payload: {
        outcome: 'failed',
        text: 'SENTINEL_PAYLOAD_TEXT',
        content: 'SENTINEL_PAYLOAD_CONTENT',
        message: 'SENTINEL_PAYLOAD_MESSAGE',
        error: 'SENTINEL_INTERNAL_ERROR',
        error_code: 'MISSING_FINAL_REPLY',
        result: {
          reply: 'SENTINEL_RESULT_REPLY',
          text: 'SENTINEL_RESULT_TEXT',
          content: 'SENTINEL_RESULT_CONTENT',
          message: 'SENTINEL_RESULT_MESSAGE',
          error: 'SENTINEL_RESULT_ERROR',
          artifacts: [
            { name: 'result-sentinel', uri: 'https://sentinel.invalid/result-private' }
          ],
          output: {
            reply: 'SENTINEL_OUTPUT_REPLY',
            text: 'SENTINEL_OUTPUT_TEXT',
            content: 'SENTINEL_OUTPUT_CONTENT',
            message: 'SENTINEL_OUTPUT_MESSAGE',
            error: 'SENTINEL_OUTPUT_ERROR',
            messages: [],
            status: 'done',
            retryable: false,
            artifacts: [
              { name: 'data-sentinel.txt', uri: 'data:text/plain;base64,U0VOVElORUxfREFUQQ==' },
              { name: 'http-sentinel', uri: 'https://sentinel.invalid/private' },
              { name: 'file-sentinel', uri: 'file:///run/secrets/sentinel' }
            ]
          }
        },
        reply: 'SENTINEL_PAYLOAD_REPLY',
        artifacts: [
          { name: 'payload-sentinel', uri: 'file:///run/secrets/payload-sentinel' }
        ]
      }
    }));

    await new TelegramEgressWorker({
      repository,
      aliases: [config()],
      apis: new Map([['kant', api]]),
      onMetric: (metric) => metrics.push(metric),
      activity: {
        begin: () => undefined,
        finish: (_target, outcome) => finishes.push({ outcome }),
        stop: () => undefined
      }
    }).runOnce();

    expect(api.sends).toEqual([{
      chat: '201',
      text: 'No pude completar una respuesta para este turno. Volvé a preguntarme para intentarlo de nuevo.',
      options: { parse_mode: 'html' },
      arity: 3
    }]);
    expect([...repository.effects.values()]).toEqual([
      expect.objectContaining({ state: 'sent', chunk_index: 0, chunk_count: 1 })
    ]);
    expect(repository.acknowledgements).toEqual([
      expect.objectContaining({
        status: 'sent',
        effect_count: 1
      })
    ]);
    expect(finishes).toEqual([{ outcome: 'failed' }]);
    expect(metrics).not.toContain('egress_attachment_listed');
    expect(JSON.stringify(api.sends)).not.toContain('SENTINEL');
  });

  it('dead-letters a rejected safe MISSING_FINAL_REPLY effect without leaking its internal diagnostic', async () => {
    const api = new RejectingSendTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: {
        outcome: 'failed',
        error: 'internal stack detail that must not be shown',
        error_code: 'MISSING_FINAL_REPLY'
      }
    }));

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect([...repository.effects.values()]).toEqual([
      expect.objectContaining({ state: 'dead', chunk_index: 0, chunk_count: 1 })
    ]);
    expect(repository.acknowledgements.at(-1)).toMatchObject({
      status: 'dead', error: 'message rejected'
    });
    expect([...repository.effects.values()][0]?.diagnostic).toBe('message rejected');
  });

  it('sends the reply from a realistic AdapterClient ACK payload', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: {
        result: {
          output: {
            reply: 'adapter reply',
            messages: [{ to: 'argos', body: 'relay-only content' }],
            status: 'done',
            retryable: false,
            artifacts: []
          }
        }
      }
    }));

    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toEqual([{ chat: '201', text: 'adapter reply', options: { parse_mode: 'html' }, arity: 3 }]);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 1 });
  });

  it('keeps a sent ACK when terminal reaction delivery fails', async () => {
    const api = new FailingActivityTelegram();
    const activity = new TelegramActivityIndicator();
    const repository = new MemoryEgressRepository(relay({
      payload: { outcome: 'done', result: { text: 'durable response' } }
    }));

    await new TelegramEgressWorker({
      repository,
      aliases: [config()],
      apis: new Map([['kant', api]]),
      activity
    }).runOnce();
    await activity.whenIdle();

    expect(api.sends).toEqual([{ chat: '201', text: 'durable response', options: { parse_mode: 'html' }, arity: 3 }]);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 1 });
    activity.stop();
  });

  it.each(['failed', 'dead'] as const)(
    'marks an agent %s outcome as failed only after its response is durably relayed',
    async (outcome) => {
      const api = new FakeTelegram();
      const activity = new TelegramActivityIndicator();
      const repository = new MemoryEgressRepository(relay({
        payload: { outcome, error: `${outcome} result` }
      }));

      await new TelegramEgressWorker({
        repository,
        aliases: [config()],
        apis: new Map([['kant', api]]),
        activity
      }).runOnce();
      await activity.whenIdle();

      expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
      expect(api.reactions.at(-1)).toEqual({ chat: '201', message: '301', reaction: '👎' });
      activity.stop();
    }
  );

  it('marks a durable egress dead-letter with a failure reaction', async () => {
    const api = new RejectingSendTelegram();
    const activity = new TelegramActivityIndicator();
    const repository = new MemoryEgressRepository(relay());

    await new TelegramEgressWorker({
      repository,
      aliases: [config()],
      apis: new Map([['kant', api]]),
      activity
    }).runOnce();
    await activity.whenIdle();

    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(api.reactions.at(-1)).toEqual({ chat: '201', message: '301', reaction: '👎' });
    activity.stop();
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
      repository, aliases: [config()], apis: new Map([['kant', client]]), baseRetryMs: 10
    });

    await worker.runOnce();

    expect(repository.acknowledgements).toEqual([
      expect.objectContaining({ status: 'retry', retry_after_ms: 7_000 })
    ]);
    expect([...repository.effects.values()][0]?.state).toBe('prepared');
  });

  it('marks a known non-retryable rejection dead instead of leaving it replayable', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response(JSON.stringify({ ok: false, error_code: 400 }), {
        status: 400, headers: { 'content-type': 'application/json' }
      })
    });
    const repository = new MemoryEgressRepository(relay());
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', client]])
    }).runOnce();

    expect([...repository.effects.values()][0]?.state).toBe('dead');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
  });

  it('treats an unreadable 2xx send response as remotely ambiguous, not a safe retry', async () => {
    const client = new TelegramHttpClient({
      token: '123456:abcdefghijklmnopqrstuvwxyz_ABCDE',
      apiBase: 'https://telegram.invalid',
      fetcher: async () => new Response('not-json', { status: 200 })
    });
    const repository = new MemoryEgressRepository(relay());
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', client]])
    }).runOnce();

    expect([...repository.effects.values()][0]?.state).toBe('ambiguous');
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'retry')).toBe(false);
  });

  it('keeps a multi-chunk partial send dead unless every chunk is confirmed sent', async () => {
    class FlakyChunkTelegram extends FakeTelegram {
      calls = 0;
      override async sendText() {
        this.calls += 1;
        if (this.calls === 2) throw new TelegramApiError('network outcome unknown', false, undefined, false);
        return { message_id: String(this.calls) };
      }
    }
    const api = new FlakyChunkTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect([...repository.effects.values()].map((effect) => effect.state)).toEqual(['sent', 'ambiguous']);
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
    expect(repository.acknowledgements.some((ack) => ack.status === 'sent')).toBe(false);
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();
    expect(api.calls).toBe(2);
  });

  it('ACKs a multi-chunk event sent only after every chunk is durably sent', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({
      payload: { result: { text: `${'a'.repeat(4_096)}b` } }
    }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(2);
    expect([...repository.effects.values()].map((effect) => effect.state)).toEqual(['sent', 'sent']);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent', effect_count: 2 });
  });

  it('fails closed on a cross-tenant origin', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(relay({ tenant_id: 'Isa' }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements[0]?.status).toBe('dead');
  });
});

describe('Telegram group egress', () => {
  it('dead-letters into a group the alias has explicitly turned off, symmetric with ingress P1', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(groupRelay());

    await new TelegramEgressWorker({
      repository,
      aliases: [config({
        alias: 'kant',
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{ chat_id: String(GROUP_CHAT_ID), mode: 'off', session_scope: 'user', reply_to_origin: true, threads: [] }]
      })],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements.at(-1)).toMatchObject({
      status: 'dead', error: 'Telegram origin is not authorized for this tenant and alias'
    });
  });

  it('dead-letters into a group a scoped alias never declared, even though it is in allowed_chat_ids', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(groupRelay());

    await new TelegramEgressWorker({
      repository,
      aliases: [config({
        alias: 'kant',
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [] // scoped, default-deny: no entry for GROUP_CHAT_ID
      })],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements.at(-1)?.status).toBe('dead');
  });

  it('a legacy alias (chats never declared) keeps sending into a group via allowed_chat_ids alone', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(groupRelay());

    await new TelegramEgressWorker({
      repository,
      aliases: [legacyGroupConfig({ alias: 'kant', allowed_chat_ids: [String(GROUP_CHAT_ID)] })],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toEqual([{ chat: String(GROUP_CHAT_ID), text: 'done', options: { parse_mode: 'html' }, arity: 3 }]);
    expect(repository.acknowledgements.at(-1)?.status).toBe('sent');
  });

  it('threads a multi-chunk reply: message_thread_id on every chunk, reply_to_message_id only on the first', async () => {
    const api = new FakeTelegram();
    const longText = 'x'.repeat(5_000); // exceeds the 4_096 chunk size, forcing a second chunk
    const repository = new MemoryEgressRepository(groupRelay({
      origin: {
        adapter: 'telegram', channel: 'telegram', conversation_id: String(GROUP_CHAT_ID),
        external_message_id: '301', relay: [], metadata: { bridge_alias: 'kant', thread_id: '42' }
      },
      payload: { result: { text: longText } }
    }));

    await new TelegramEgressWorker({
      repository,
      aliases: [config({
        alias: 'kant',
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{ chat_id: String(GROUP_CHAT_ID), mode: 'always', session_scope: 'user', reply_to_origin: true, threads: [] }]
      })],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(2);
    expect(api.sends[0]?.options).toEqual({ message_thread_id: '42', reply_to_message_id: '301', parse_mode: 'html' });
    expect(api.sends[1]?.options).toEqual({ message_thread_id: '42', parse_mode: 'html' });
  });

  it('omits reply_to_message_id when the chat policy has reply_to_origin: false', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(groupRelay());

    await new TelegramEgressWorker({
      repository,
      aliases: [config({
        alias: 'kant',
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{ chat_id: String(GROUP_CHAT_ID), mode: 'always', session_scope: 'user', reply_to_origin: false, threads: [] }]
      })],
      apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toEqual([{ chat: String(GROUP_CHAT_ID), text: 'done', options: { parse_mode: 'html' }, arity: 3 }]);
  });
});

describe('Telegram proactive egress', () => {
  it('delivers a proactive relay without touching the inbound activity reaction', async () => {
    const api = new FakeTelegram();
    const finishes: Array<{ outcome: string }> = [];
    const repository = new MemoryEgressRepository(proactiveRelay());

    await new TelegramEgressWorker({
      repository,
      aliases: [config()],
      apis: new Map([['kant', api]]),
      activity: {
        begin: () => undefined,
        finish: (_target, outcome) => finishes.push({ outcome }),
        stop: () => undefined
      }
    }).runOnce();

    expect(api.sends).toEqual([{ chat: '201', text: 'terminé la tarea larga', options: { parse_mode: 'html' }, arity: 3 }]);
    expect(repository.acknowledgements.at(-1)).toMatchObject({ status: 'sent' });
    // No inbound message exists, so no reaction may be placed on one.
    expect(finishes).toEqual([]);
  });

  it('dead-letters a proactive relay that claims to answer an inbound message', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(proactiveRelay({ external_message_id: '301' }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements[0]?.status).toBe('dead');
  });

  it('keeps allowed_chat_ids as an independent second key', async () => {
    const api = new FakeTelegram();
    const repository = new MemoryEgressRepository(proactiveRelay({ conversation_id: '999' }));
    await new TelegramEgressWorker({
      repository, aliases: [config()], apis: new Map([['kant', api]])
    }).runOnce();

    expect(api.sends).toHaveLength(0);
    expect(repository.acknowledgements[0]?.status).toBe('dead');
  });
});

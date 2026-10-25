import { describe, expect, it } from 'vitest';
import { parseTelegramBridgeConfig } from '../src/config.js';
import { telegramTextChunks } from '../src/egress.js';
import { TelegramPoller } from '../src/poller.js';
import {
  config, DeduplicatingIngress, FakeTelegram, MemoryCursorRepository, TENANT, noopActivity, noopObserver
} from './bridge-fixtures.js';

describe('Telegram single-recipient configuration', () => {
  it('accepts only the bot alias itself as the sole ingress recipient', () => {
    expect(parseTelegramBridgeConfig({ aliases: [config()] }).aliases[0]?.recipients)
      .toEqual([{ tenant_id: TENANT, alias: 'kant' }]);

    expect(() => parseTelegramBridgeConfig({
      aliases: [config({ recipients: [{ tenant_id: TENANT, alias: 'argos' }] })]
    })).toThrow('Telegram ingress requires exactly one self recipient');
    expect(() => parseTelegramBridgeConfig({
      aliases: [config({
        recipients: [
          { tenant_id: TENANT, alias: 'kant' },
          { tenant_id: TENANT, alias: 'argos' }
        ]
      })]
    })).toThrow('Telegram ingress requires exactly one self recipient');
  });
});

describe('Telegram egress text extraction', () => {
  it('uses the exact AdapterClient StructuredOutput reply and preserves sanitizing and chunking', () => {
    const reply = ` \u0000${'a'.repeat(4_096)}b\u0000 `;

    expect(telegramTextChunks({
      result: {
        output: {
          reply,
          messages: [{ to: 'argos', body: 'relay-only content' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    })).toEqual(['a'.repeat(4_096), 'b']);
  });

  it('returns no chunks for an empty StructuredOutput reply, while preserving an explicit error', () => {
    const emptyOutput = {
      reply: '',
      messages: [],
      status: 'done',
      retryable: false,
      artifacts: []
    };

    expect(telegramTextChunks({ result: { output: emptyOutput } }))
      .toEqual([]);
    expect(telegramTextChunks({ result: { output: emptyOutput }, error: 'adapter failed' }))
      .toEqual(['Error: adapter failed']);
    expect(telegramTextChunks({
      result: { output: { ...emptyOutput, reply: ' \u0000 ' } }, error: 'adapter failed'
    })).toEqual(['Error: adapter failed']);
  });

  it('does not treat zero-width, combining-mark-only, or control-only replies as visible Telegram content', () => {
    expect(telegramTextChunks({
      result: { output: { reply: '\u200B\u2060\u0000' } },
      error: 'MISSING_FINAL_REPLY'
    })).toEqual(['Error: MISSING_FINAL_REPLY']);
    expect(telegramTextChunks({
      result: { output: { reply: '\u200B\u2060\u0000' } }
    })).toEqual([]);
    for (const reply of ['\u034F', '\uFE0F', '\u0301', '\u20DD']) {
      expect(telegramTextChunks({ result: { output: { reply } } }))
        .toEqual([]);
    }
    expect(telegramTextChunks({
      result: { output: { reply: 'a\u0301' } }
    })).toEqual(['a\u0301']);
  });

  it('uses one fixed MISSING_FINAL_REPLY notice and ignores every text and artifact source', () => {
    expect(telegramTextChunks({
      result: {
        reply: 'SENTINEL_RESULT_REPLY',
        text: 'SENTINEL_RESULT_TEXT',
        content: 'SENTINEL_RESULT_CONTENT',
        message: 'SENTINEL_RESULT_MESSAGE',
        error: 'SENTINEL_RESULT_ERROR',
        artifacts: [{ uri: 'https://sentinel.invalid/result', name: 'result-sentinel' }],
        output: {
          reply: 'SENTINEL_OUTPUT_REPLY',
          text: 'SENTINEL_OUTPUT_TEXT',
          content: 'SENTINEL_OUTPUT_CONTENT',
          message: 'SENTINEL_OUTPUT_MESSAGE',
          error: 'SENTINEL_OUTPUT_ERROR',
          artifacts: [{ uri: 'data:text/plain;base64,U0VOVElORUxfREFUQQ==', name: 'sentinel.txt' }]
        }
      },
      reply: 'SENTINEL_PAYLOAD_REPLY',
      text: 'SENTINEL_PAYLOAD_TEXT',
      content: 'SENTINEL_PAYLOAD_CONTENT',
      message: 'SENTINEL_PAYLOAD_MESSAGE',
      error: 'SENTINEL_INTERNAL_ERROR',
      artifacts: [{ uri: 'file:///run/secrets/payload-sentinel', name: 'payload-sentinel' }],
      error_code: 'MISSING_FINAL_REPLY'
    }, '\nSENTINEL_FOOTER')).toEqual([
      'No pude completar una respuesta para este turno. Vuelve a preguntarme para intentarlo de nuevo.'
    ]);
  });

  it('preserves result.text compatibility and never derives text from messages or tool payloads', () => {
    expect(telegramTextChunks({ result: { text: 'legacy reply' } })).toEqual(['legacy reply']);
    expect(telegramTextChunks({
      result: { output: { reply: { text: 'not a string' } }, reply: 42, text: 'legacy reply' }
    })).toEqual(['legacy reply']);
    expect(telegramTextChunks({
      result: {
        output: {
          reply: null,
          messages: [{ to: 'argos', body: 'must not be sent to Telegram' }],
          status: 'done',
          retryable: false,
          artifacts: []
        },
        tool: { content: 'must not be sent to Telegram' }
      }
    })).toEqual([]);
  });
});

describe('Telegram durable polling (core)', () => {
  it('downloads a Telegram photo before publishing it to the addressed agent', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    const photo = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const api = new FakeTelegram([{
      update_id: 4,
      message: {
        message_id: 104,
        from: { id: 101 },
        chat: { id: 201, type: 'private' },
        photo: [{ file_id: 'photo-id', file_size: photo.length }]
      }
    }]);
    api.files.set('photo-id', {
      file_id: 'photo-id', file_path: 'photos/photo-id.jpg', file_size: photo.length
    });
    api.filePayloads.set('photos/photo-id.jpg', photo);

    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(), botId: '900001', api, repository, ingress
    }).runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.body.attachments_v1).toEqual([expect.objectContaining({
      kind: 'image', name: 'photo-id.jpg', mime_type: 'image/jpeg', file_size: photo.length,
      content_base64: photo.toString('base64')
    })]);
    expect(repository.next).toBe(5);
  });

  it('denies a wrong chat without publishing but durably consumes the update', async () => {
    const repository = new MemoryCursorRepository();
    const ingress = new DeduplicatingIngress();
    await new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(), botId: '900001', api: new FakeTelegram([{
        update_id: 3,
        message: {
          message_id: 103,
          from: { id: 101 },
          chat: { id: 999, type: 'private' },
          text: 'message-3'
        }
      }]), repository, ingress
    }).runOnce();

    expect(ingress.calls).toHaveLength(0);
    expect(repository.next).toBe(4);
  });
});

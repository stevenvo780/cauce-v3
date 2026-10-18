import { describe, expect, it } from 'vitest';
import type { FleetDirectory } from '../src/addressing.js';
import { TelegramPoller } from '../src/poller.js';
import type {
  BridgeMetric, TelegramAliasConfig, TelegramChatPolicyConfig, TelegramEntity, TelegramMessage,
  TelegramUpdate
} from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, GROUP_CHAT_ID, MemoryCursorRepository,
  noopActivity, noopObserver
} from './bridge-fixtures.js';

function jpeg(size: number): Buffer {
  const payload = Buffer.alloc(size);
  payload.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return payload;
}

function album(
  api: FakeTelegram,
  updateId: number,
  groupId: string | undefined,
  options: {
    caption?: string; entities?: TelegramEntity[]; thread?: number;
    extra?: Partial<TelegramMessage>; chatId?: number; fromId?: number;
  } = {}
): TelegramUpdate {
  const { caption, entities, thread, extra = {}, chatId = GROUP_CHAT_ID, fromId = 101 } = options;
  const fileId = `alb-${String(updateId)}`;
  const path = `photos/${fileId}.jpg`;
  api.files.set(fileId, { file_id: fileId, file_path: path, file_size: 32 });
  api.filePayloads.set(path, jpeg(32));
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: fromId },
      chat: { id: chatId, type: chatId < 0 ? 'supergroup' : 'private' },
      ...(groupId === undefined ? {} : { media_group_id: groupId }),
      ...(thread === undefined ? {} : { message_thread_id: thread, is_topic_message: true }),
      ...(caption === undefined ? {} : { caption }),
      ...(entities === undefined ? {} : { caption_entities: entities }),
      photo: [{ file_id: fileId, file_size: 32 }],
      ...extra
    }
  };
}

interface Corrida {
  readonly metrics: BridgeMetric[];
  readonly publicaciones: (number | undefined)[];
}

/**
 * Four members with a mention plus a two-member tail, run until the cursor stops moving.
 *
 * `tailGroupId` is the whole experiment: with the album's own id the tail is a continuation the
 * poller could serve out of its memory, with any other id it is an unrelated album resolved from
 * scratch. Both must end the same way, which is what makes the second run the negative control.
 */
async function corre(tailGroupId: string, tailOptions: Parameters<typeof album>[3]): Promise<Corrida> {
  const api = new FakeTelegram();
  api.updates.push(
    album(api, 50, 'ALB', {
      caption: '@kant_bot mirá', entities: [{ type: 'mention', offset: 0, length: 9 }]
    }),
    album(api, 51, 'ALB'), album(api, 52, 'ALB'), album(api, 53, 'ALB'),
    album(api, 54, tailGroupId, tailOptions), album(api, 55, tailGroupId, tailOptions)
  );
  const metrics: BridgeMetric[] = [];
  const ingress = new DeduplicatingIngress();
  const bridge = new TelegramPoller({
    activity: noopActivity(), observer: noopObserver(),
    config: config({
      allowed_chat_ids: [String(GROUP_CHAT_ID)],
      bot_username: 'kant_bot',
      chats: [{
        chat_id: String(GROUP_CHAT_ID), mode: 'mention', session_scope: 'user', reply_to_origin: true,
        threads: [{ thread_id: '77', mode: 'off', session_scope: 'user', reply_to_origin: true }]
      }]
    }),
    botId: '900001', api, repository: new MemoryCursorRepository(), ingress,
    onMetric: (metric) => metrics.push(metric)
  });

  for (let cycle = 0; cycle < 3; cycle += 1) await bridge.runOnce();

  return {
    metrics,
    publicaciones: ingress.calls.map((call) => (call.body.attachments_v1 as unknown[] | undefined)?.length)
  };
}

describe('la cola de un álbum no hereda la autorización de la cabecera', () => {
  it('un tramo que declara un hilo apagado se rechaza aunque lleve el media_group_id del álbum', async () => {
    const recuerdo = await corre('ALB', { thread: 77 });
    const control = await corre('OTRO', { thread: 77 });

    expect(recuerdo.metrics).toEqual(['updates_allowed', 'updates_chat_disabled', 'updates_chat_disabled']);
    expect(recuerdo.publicaciones).toEqual([4]);
    expect(recuerdo).toEqual(control);
  });

  it('un tramo enviado por un bot en línea no atraviesa la guarda anti-eco por ser continuación', async () => {
    const recuerdo = await corre('ALB', { extra: { via_bot: { id: 4242, is_bot: true } } });
    const control = await corre('OTRO', { extra: { via_bot: { id: 4242, is_bot: true } } });

    expect(recuerdo.metrics).toEqual(['updates_allowed', 'updates_via_bot', 'updates_via_bot']);
    expect(recuerdo.publicaciones).toEqual([4]);
    expect(recuerdo).toEqual(control);
  });

  it('un tramo sin epígrafe del mismo álbum sí se publica: la única negativa que el recuerdo cubre', async () => {
    const recuerdo = await corre('ALB', {});

    expect(recuerdo.metrics).toEqual(['updates_allowed', 'updates_allowed']);
    expect(recuerdo.publicaciones).toEqual([4, 2]);
  });
});

const MENCION: TelegramEntity[] = [{ type: 'mention', offset: 0, length: 9 }];

function chatMencion(chatId: number, threads: TelegramChatPolicyConfig['threads'] = []): TelegramChatPolicyConfig {
  return {
    chat_id: String(chatId), mode: 'mention', session_scope: 'user', reply_to_origin: true, threads
  };
}

interface Lote {
  readonly metrics: BridgeMetric[];
  readonly publicaciones: (number | undefined)[][];
  /** `[update_id de la clave de idempotencia, external_message_id]` de cada publicación. */
  readonly identidades: (string | number | undefined)[][];
  readonly suprimidos: (string | number)[][];
  /** Lo que el agente lee de cada publicación. */
  readonly prompts: (string | undefined)[];
}

interface Flota {
  readonly fleet?: FleetDirectory;
  readonly participants?: (chatId: string, threadId: string) => ReadonlySet<string>;
}

async function lote(
  updates: (api: FakeTelegram) => TelegramUpdate[],
  overrides: Partial<TelegramAliasConfig>,
  flota: Flota = {}
): Promise<Lote> {
  const api = new FakeTelegram();
  api.updates.push(...updates(api));
  const metrics: BridgeMetric[] = [];
  const suprimidos: (string | number)[][] = [];
  const ingress = new DeduplicatingIngress();
  const bridge = new TelegramPoller({
    activity: noopActivity(), observer: noopObserver(),
    config: config({ allowed_chat_ids: [String(GROUP_CHAT_ID)], bot_username: 'kant_bot', ...overrides }),
    botId: '900001', api, repository: new MemoryCursorRepository(), ingress, ...flota,
    onMetric: (metric) => metrics.push(metric),
    onSuppressed: (record) => suprimidos.push([record.update_id, record.reason])
  });

  for (let cycle = 0; cycle < 3; cycle += 1) await bridge.runOnce();

  return {
    metrics,
    publicaciones: ingress.calls.map((call) =>
      [call.update_id, (call.body.attachments_v1 as unknown[] | undefined)?.length]),
    identidades: ingress.calls.map((call) => [call.update_id, call.origin.external_message_id]),
    suprimidos,
    prompts: ingress.calls.map((call) => call.body.prompt as string | undefined)
  };
}

describe('dentro del lote cada miembro se juzga en su propio mensaje', () => {
  it('los miembros que declaran un hilo apagado se suprimen con su motivo real y el álbum viaja sin ellos', async () => {
    const intra = await lote((api) => [
      album(api, 50, 'INTRA', { caption: '@kant_bot mirá', entities: MENCION }),
      album(api, 51, 'INTRA', { thread: 77 }),
      album(api, 52, 'INTRA', { thread: 77 }),
      album(api, 53, 'INTRA')
    ], {
      chats: [chatMencion(GROUP_CHAT_ID, [
        { thread_id: '77', mode: 'off', session_scope: 'user', reply_to_origin: true }
      ])]
    });

    expect(intra.suprimidos).toEqual([[51, 'chat_disabled'], [52, 'chat_disabled']]);
    expect(intra.metrics).toEqual(['updates_chat_disabled', 'updates_chat_disabled', 'updates_allowed']);
    expect(intra.publicaciones).toEqual([[50, 2]]);
  });
});

describe('un miembro ajeno con epígrafe no tumba a los miembros permitidos', () => {
  it('publica el miembro de la lista blanca y deja rastro del ajeno', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 60, 'MIX', { caption: 'legítimo', chatId: -999_999, fromId: 66_666 }),
      album(api, 61, 'MIX', { chatId: 201 })
    );
    const ingress = new DeduplicatingIngress();
    const suppressed: { chat_id: string; update_id: number; reason: string }[] = [];
    const repository = new MemoryCursorRepository();
    const bridge = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config(), botId: '900001', api, repository, ingress,
      onSuppressed: (record) => suppressed.push(record)
    });

    await bridge.runOnce();
    await bridge.runOnce();

    expect(ingress.calls).toHaveLength(1);
    expect(ingress.calls[0]?.update_id).toBe(61);
    expect(ingress.calls[0]?.origin.conversation_id).toBe('201');
    expect(ingress.calls[0]?.body.attachments_v1).toHaveLength(1);
    expect(suppressed).toMatchObject([{ chat_id: '-999999', update_id: 60, reason: 'chat_not_allowed' }]);
    expect(repository.next).toBe(62);
  });
});

import { describe, expect, it } from 'vitest';
import type { FleetDirectory } from '../src/addressing.js';
import { TelegramPoller } from '../src/poller.js';
import type {
  BridgeMetric, TelegramAliasConfig, TelegramChatPolicyConfig, TelegramEntity, TelegramMessage,
  TelegramUpdate
} from '../src/types.js';
import {
  config, DeduplicatingIngress, FakeTelegram, GROUP_CHAT_ID, groupUpdate, MemoryCursorRepository,
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

  it('un tramo firmado por un canal sigue siendo un remitente anónimo', async () => {
    const recuerdo = await corre('ALB', { extra: { sender_chat: { id: -777 } } });
    const control = await corre('OTRO', { extra: { sender_chat: { id: -777 } } });

    expect(recuerdo.metrics).toEqual(['updates_allowed', 'updates_denied', 'updates_denied']);
    expect(recuerdo.publicaciones).toEqual([4]);
    expect(recuerdo).toEqual(control);
  });

  it('un tramo sin epígrafe del mismo álbum sí se publica: la única negativa que el recuerdo cubre', async () => {
    const recuerdo = await corre('ALB', {});

    expect(recuerdo.metrics).toEqual(['updates_allowed', 'updates_allowed']);
    expect(recuerdo.publicaciones).toEqual([4, 2]);
  });
});

describe('el recuerdo sólo cubre la continuación inmediata', () => {
  it('un update ajeno entre las dos mitades borra el recuerdo y la cola queda suprimida con rastro', async () => {
    const api = new FakeTelegram();
    api.updates.push(
      album(api, 50, 'SEIS', {
        caption: '@kant_bot mirá', entities: [{ type: 'mention', offset: 0, length: 9 }]
      }),
      album(api, 51, 'SEIS'), album(api, 52, 'SEIS'), album(api, 53, 'SEIS'),
      groupUpdate(54, { text: 'hola' }),
      album(api, 55, 'SEIS'), album(api, 56, 'SEIS')
    );
    const metrics: BridgeMetric[] = [];
    const suppressed: { update_id: number; reason: string }[] = [];
    const ingress = new DeduplicatingIngress();
    const bridge = new TelegramPoller({
      activity: noopActivity(), observer: noopObserver(),
      config: config({
        allowed_chat_ids: [String(GROUP_CHAT_ID)],
        bot_username: 'kant_bot',
        chats: [{
          chat_id: String(GROUP_CHAT_ID), mode: 'mention', session_scope: 'user',
          reply_to_origin: true, threads: []
        }]
      }),
      botId: '900001', api, repository: new MemoryCursorRepository(), ingress,
      onMetric: (metric) => metrics.push(metric),
      onSuppressed: (record) => suppressed.push(record)
    });

    for (let cycle = 0; cycle < 3; cycle += 1) await bridge.runOnce();

    expect(ingress.calls.map((call) => (call.body.attachments_v1 as unknown[] | undefined)?.length)).toEqual([4]);
    expect(metrics).toEqual([
      'updates_allowed', 'updates_unaddressed', 'updates_unaddressed', 'updates_unaddressed'
    ]);
    expect(suppressed.map((record) => record.update_id)).toEqual([54, 55, 56]);
  });
});

const MENCION: TelegramEntity[] = [{ type: 'mention', offset: 0, length: 9 }];
const OTRO_GRUPO = -5002;

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

/** Each is a member the single-update path refuses BEFORE it can reach the missing-caption rule. */
const IMPOSTORES: readonly { extra: Partial<TelegramMessage>; motivo: string }[] = [
  { extra: { via_bot: { id: 4242, is_bot: true } }, motivo: 'via_bot' },
  { extra: { sender_chat: { id: -777 } }, motivo: 'anonymous_sender' },
  { extra: { from: { id: 101, is_bot: true } }, motivo: 'bot_author' }
];

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

  it('un miembro suplantado del lote se rechaza con el mismo motivo que fuera del álbum', async () => {
    for (const { extra, motivo } of IMPOSTORES) {
      const chats = { chats: [chatMencion(GROUP_CHAT_ID)] };
      const enAlbum = await lote((api) => [
        album(api, 50, 'X', { caption: '@kant_bot mirá', entities: MENCION }),
        album(api, 51, 'X', { extra }), album(api, 52, 'X', { extra })
      ], chats);
      const sueltos = await lote((api) => [
        album(api, 60, undefined, { caption: '@kant_bot mirá', entities: MENCION }),
        album(api, 61, undefined, { extra }), album(api, 62, undefined, { extra })
      ], chats);

      expect(enAlbum.suprimidos).toEqual([[51, motivo], [52, motivo]]);
      expect(sueltos.suprimidos).toEqual([[61, motivo], [62, motivo]]);
      expect(enAlbum.metrics.filter((metric) => metric !== 'updates_allowed'))
        .toEqual(sueltos.metrics.filter((metric) => metric !== 'updates_allowed'));
      expect(enAlbum.publicaciones).toEqual([[50, 1]]);
    }
  });

  it('un miembro de otro chat permitido deja constancia de que no es del álbum, no de "user_denied"', async () => {
    const mixto = await lote((api) => [
      album(api, 50, 'DOS', { caption: '@kant_bot mirá', entities: MENCION }),
      album(api, 51, 'DOS', { chatId: OTRO_GRUPO })
    ], {
      allowed_chat_ids: [String(GROUP_CHAT_ID), String(OTRO_GRUPO)],
      chats: [chatMencion(GROUP_CHAT_ID), chatMencion(OTRO_GRUPO)]
    });

    expect(mixto.suprimidos).toEqual([[51, 'album_mismatch']]);
    expect(mixto.publicaciones).toEqual([[50, 1]]);
  });
});

const FLOTA: Flota = {
  fleet: {
    byUsername: new Map([['kant_bot', 'kant'], ['otro_bot', 'otro']]),
    byBotId: new Map([['900001', 'kant'], ['900002', 'otro']])
  },
  participants: () => new Set(['kant'])
};

describe('un miembro dirigido a otro alias de la flota no viaja bajo el epígrafe del primario', () => {
  it('se suprime con el mismo motivo que fuera del álbum', async () => {
    const chats = { chats: [chatMencion(GROUP_CHAT_ID)] };
    const enAlbum = await lote((api) => [
      album(api, 50, 'UNS', { caption: '@kant_bot mirá', entities: MENCION }),
      album(api, 51, 'UNS', { caption: '@otro_bot tomá esto', entities: MENCION })
    ], chats, FLOTA);
    const sueltos = await lote((api) => [
      album(api, 60, undefined, { caption: '@kant_bot mirá', entities: MENCION }),
      album(api, 61, undefined, { caption: '@otro_bot tomá esto', entities: MENCION })
    ], chats, FLOTA);

    expect(enAlbum.suprimidos).toEqual([[51, 'mention_unserved']]);
    expect(sueltos.suprimidos).toEqual([[61, 'mention_unserved']]);
    expect(enAlbum.publicaciones).toEqual([[50, 1]]);
    expect(sueltos.publicaciones).toEqual([[60, 1]]);
  });
});

describe('ningún epígrafe del álbum se pierde por caber en un solo mensaje', () => {
  it('los epígrafes de los miembros dirigidos viajan en el cuerpo, en orden de update', async () => {
    const dos = await lote((api) => [
      album(api, 50, 'MC', { caption: '@kant_bot uno', entities: MENCION }),
      album(api, 51, 'MC'),
      album(api, 52, 'MC', { caption: '@kant_bot dos', entities: MENCION })
    ], { chats: [chatMencion(GROUP_CHAT_ID)] });

    expect(dos.publicaciones).toEqual([[50, 3]]);
    expect(dos.prompts).toEqual(['@kant_bot uno\n\n@kant_bot dos']);
    expect(dos.suprimidos).toEqual([]);
  });

  it('cuando la unión no cabe en un epígrafe, cada miembro se publica con el suyo entero', async () => {
    const largo = `@kant_bot ${'x'.repeat(1_000)}`;
    const dos = await lote((api) => [
      album(api, 50, 'MCL', { caption: largo, entities: MENCION }),
      album(api, 51, 'MCL', { caption: largo, entities: MENCION })
    ], { chats: [chatMencion(GROUP_CHAT_ID)] });

    expect(dos.publicaciones).toEqual([[50, 1], [51, 1]]);
    expect(dos.prompts).toEqual([largo, largo]);
  });
});

describe('el primario nombra al álbum en la clave de idempotencia y en el origen', () => {
  it('el epígrafe no viene primero y aun así ambas identidades apuntan al mismo update', async () => {
    const album2 = await lote((api) => [
      album(api, 50, 'NOMBRE'),
      album(api, 51, 'NOMBRE', { caption: '@kant_bot mirá', entities: MENCION }),
      album(api, 52, 'NOMBRE')
    ], { chats: [chatMencion(GROUP_CHAT_ID)] });

    expect(album2.identidades).toEqual([[51, '151']]);
    expect(album2.publicaciones).toEqual([[51, 3]]);
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

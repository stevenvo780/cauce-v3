import { describe, expect, it } from 'vitest';
import type { AddressingInput, AddressingSelf, FleetDirectory } from '../src/addressing.js';
import { resolveAddressing } from '../src/addressing.js';
import type { TelegramChatPolicy, TelegramEntity, TelegramMessage } from '../src/types.js';

const SELF: AddressingSelf = {
  bot_id: '900001',
  alias: 'jarvis',
  tenant_id: 'Steven',
  username: 'jarvis_cauce_bot'
};

const FLEET: FleetDirectory = {
  byUsername: new Map([
    ['jarvis_cauce_bot', 'Steven/jarvis'],
    ['kant_cauce_bot', 'Steven/kant'],
    ['socrates_cauce_bot', 'Steven/socrates']
  ]),
  byBotId: new Map([
    ['900001', 'Steven/jarvis'],
    ['900002', 'Steven/kant'],
    ['900003', 'Steven/socrates']
  ])
};

const GROUP: TelegramChatPolicy = {
  chat_id: '-5044661837',
  thread_id: '0',
  mode: 'mention',
  allowed_user_ids: undefined,
  session_scope: 'chat',
  reply_to_origin: true
};

function policy(overrides: Partial<TelegramChatPolicy> = {}): TelegramChatPolicy {
  return { ...GROUP, ...overrides };
}

// exactOptionalPropertyTypes forbids passing an explicit undefined to an optional key, and several
// cases need exactly that to test the absence of the field (a message without an author, one
// without text but with a caption). The helper accepts undefined and removes it before constructing.
type MessageOverrides = { [K in keyof TelegramMessage]?: TelegramMessage[K] | undefined };

function message(overrides: MessageOverrides = {}): TelegramMessage {
  const base = {
    message_id: 500,
    from: { id: 101, is_bot: false, username: 'steven', first_name: 'Steven' },
    chat: { id: -5044661837, type: 'supergroup' },
    text: 'sin destinatario',
    ...overrides
  } as TelegramMessage;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) Reflect.deleteProperty(base, key);
  }
  return base;
}

/** Build `text` + `entities` so offsets are always consistent with the string. */
function mention(prefix: string, handle: string, suffix = ' dale'): Partial<TelegramMessage> {
  const text = `${prefix}@${handle}${suffix}`;
  const entities: TelegramEntity[] = [{ type: 'mention', offset: prefix.length, length: handle.length + 1 }];
  return { text, entities };
}

function command(prefix: string, raw: string, suffix = ''): Partial<TelegramMessage> {
  const text = `${prefix}${raw}${suffix}`;
  const entities: TelegramEntity[] = [{ type: 'bot_command', offset: prefix.length, length: raw.length }];
  return { text, entities };
}

function resolve(overrides: Partial<AddressingInput> = {}): ReturnType<typeof resolveAddressing> {
  return resolveAddressing({
    message: message(),
    self: SELF,
    fleet: FLEET,
    policy: GROUP,
    ...overrides
  });
}

describe('addressing precedence', () => {
  it('P0.a denies a message with no usable author id', () => {
    expect(resolve({ message: message({ from: undefined }) }))
      .toMatchObject({ addressed: false, reason: 'no_author' });
    expect(resolve({ message: message({ from: { id: 0 } }) }))
      .toMatchObject({ addressed: false, reason: 'no_author' });
    expect(resolve({ message: message({ from: { id: 1.5 } }) }))
      .toMatchObject({ addressed: false, reason: 'no_author' });
  });

  it('P0.b allows any private message without inspecting anything else', () => {
    const decision = resolve({
      message: message({ chat: { id: 101, type: 'private' }, text: 'hola' }),
      policy: undefined
    });
    expect(decision).toMatchObject({ addressed: true, reason: 'private', bucket: 'private' });
  });

  it('P0.d denies a bot author even when it mentions this bot (anti-echo)', () => {
    // The loop this prevents: an agent answers in the group with text containing "@jarvis",
    // Telegram emits a mention entity, and jarvis wakes up to answer its own peer forever.
    expect(resolve({
      message: message({ from: { id: 900002, is_bot: true }, ...mention('', 'jarvis_cauce_bot') })
    })).toMatchObject({ addressed: false, reason: 'bot_author' });
  });

  it('P0.f denies a user outside the per-chat allowlist even when mentioned directly', () => {
    expect(resolve({
      message: message(mention('', 'jarvis_cauce_bot')),
      policy: policy({ allowed_user_ids: ['202'] })
    })).toMatchObject({ addressed: false, reason: 'user_denied' });
  });

  it('P2 allows a mention of self anywhere in the text', () => {
    const decision = resolve({ message: message(mention('oye ', 'jarvis_cauce_bot')) });
    expect(decision).toMatchObject({ addressed: true, reason: 'mention', bucket: 'mention' });
  });

  it('P3 suppresses the echo when only another fleet alias is mentioned', () => {
    expect(resolve({ message: message(mention('', 'kant_cauce_bot')) }))
      .toMatchObject({ addressed: false, reason: 'other_bot_mentioned' });
  });

  it('P5 allows a reply to this bot own message', () => {
    expect(resolve({
      message: message({
        reply_to_message: { message_id: 480, from: { id: 900001, is_bot: true, username: 'jarvis_cauce_bot' } }
      })
    })).toMatchObject({ addressed: true, reason: 'reply', bucket: 'reply' });
  });

  it('P8 allows a bare /command only for the declared host', () => {
    expect(resolve({
      message: message(command('', '/status')),
      policy: policy({ default_alias: 'jarvis' })
    })).toMatchObject({ addressed: true, reason: 'command' });
    expect(resolve({ message: message(command('', '/status')) }))
      .toMatchObject({ addressed: false, reason: 'not_addressed' });
  });
});

describe('echo suppression across a shared group', () => {
  it('wakes exactly one bot when a human names one of three', () => {
    const humanMessage = message(mention('', 'jarvis_cauce_bot', ' revisá el deploy'));
    const fleet = [
      { bot_id: '900001', alias: 'jarvis', tenant_id: 'Steven', username: 'jarvis_cauce_bot' },
      { bot_id: '900002', alias: 'kant', tenant_id: 'Steven', username: 'kant_cauce_bot' },
      { bot_id: '900003', alias: 'socrates', tenant_id: 'Miguel', username: 'socrates_cauce_bot' }
    ];
    const decisions = fleet.map((self) =>
      resolveAddressing({ message: humanMessage, self, fleet: FLEET, policy: GROUP }));
    expect(decisions.map((entry) => entry.addressed)).toEqual([true, false, false]);
    expect(decisions.slice(1).map((entry) => entry.reason)).toEqual(['other_bot_mentioned', 'other_bot_mentioned']);
  });
});

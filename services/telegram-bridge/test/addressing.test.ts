import { describe, expect, it } from 'vitest';
import type { AddressingInput, AddressingSelf, FleetDirectory } from '../src/addressing.js';
import { addressingBucket, resolveAddressing, telegramThreadId } from '../src/addressing.js';
import type { TelegramChatPolicy, TelegramEntity, TelegramMessage } from '../src/types.js';

const SELF: AddressingSelf = {
  bot_id: '900001',
  alias: 'jarvis',
  tenant_id: 'Steven',
  username: 'jarvis_cauce_bot'
};

const FLEET: FleetDirectory = {
  byUsername: new Map([
    ['jarvis_cauce_bot', 'jarvis'],
    ['kant_cauce_bot', 'kant'],
    ['socrates_cauce_bot', 'socrates']
  ]),
  byBotId: new Map([
    ['900001', 'jarvis'],
    ['900002', 'kant'],
    ['900003', 'socrates']
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

// exactOptionalPropertyTypes prohibe pasar undefined explicito a una clave opcional, y varios
// casos necesitan justamente eso para probar la ausencia del campo (un mensaje sin autor, uno
// sin texto pero con caption). El helper acepta el undefined y lo borra antes de construir.
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
    if (value === undefined) delete (base as unknown as Record<string, unknown>)[key];
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

  it('P0.b treats a positive chat id with no chat.type as private', () => {
    // parseUpdate validates nothing inside `message`, and the legacy allowed() filter never looked
    // at chat.type. A DM must not become deniable because a field the bridge does not control is
    // missing; private chat ids are always positive.
    expect(resolve({
      message: message({ chat: { id: 101 } as TelegramMessage['chat'], text: 'hola' }),
      policy: undefined
    })).toMatchObject({ addressed: true, reason: 'private' });
  });

  it('P0.b2 keeps a group publishing while the alias has not opted into `chats`', () => {
    // The rollout invariant: shipping this code before the config lands cannot mute a live group.
    expect(resolve({ policy: undefined, groupRouting: 'legacy' }))
      .toMatchObject({ addressed: true, reason: 'legacy', bucket: 'legacy', thread_id: '0' });
    // Legacy routing bypasses every new guard, exactly as the pre-routing poller did.
    expect(resolve({
      message: message({ via_bot: { id: 777, is_bot: true } }),
      policy: undefined,
      groupRouting: 'legacy'
    })).toMatchObject({ addressed: true, reason: 'legacy' });
  });

  it('P0.b2 does not apply once the alias declares a policy for the chat', () => {
    expect(resolve({ groupRouting: 'legacy' }))
      .toMatchObject({ addressed: false, reason: 'not_addressed' });
  });

  it('defaults to scoped routing when the caller omits the flag', () => {
    expect(resolve({ policy: undefined }))
      .toMatchObject({ addressed: false, reason: 'chat_not_configured' });
  });

  it('P0.b keeps private DMs sent through an inline bot working (via_bot regression)', () => {
    // poller.allowed() never looked at via_bot or is_bot. Applying the anti-echo guard to private
    // chats would silently drop every @gif / @wiki style result the human forwards into the DM.
    expect(resolve({
      message: message({ chat: { id: 101, type: 'private' }, via_bot: { id: 777, is_bot: true } }),
      policy: undefined
    })).toMatchObject({ addressed: true, reason: 'private' });
  });

  it('P0.c denies anonymous admins and channel posts in groups', () => {
    expect(resolve({ message: message({ sender_chat: { id: -100 } }) }))
      .toMatchObject({ addressed: false, reason: 'anonymous_sender' });
  });

  it('P0.d denies a bot author even when it mentions this bot (anti-echo)', () => {
    // The loop this prevents: an agent answers in the group with text containing "@jarvis",
    // Telegram emits a mention entity, and jarvis wakes up to answer its own peer forever.
    expect(resolve({
      message: message({ from: { id: 900002, is_bot: true }, ...mention('', 'jarvis_cauce_bot') })
    })).toMatchObject({ addressed: false, reason: 'bot_author' });
  });

  it('P0.d2 denies an inline-bot message in a group under its own reason', () => {
    // Separate from `bot_author` so a human using @gif in the group does not pollute the anti-echo
    // signal, which is the counter an operator watches for a runaway bot loop.
    expect(resolve({ message: message({ via_bot: { id: 777, is_bot: true } }) }))
      .toMatchObject({ addressed: false, reason: 'via_bot' });
  });

  it('P0.e denies a group with no policy entry', () => {
    expect(resolve({ policy: undefined })).toMatchObject({ addressed: false, reason: 'chat_not_configured' });
  });

  it('P0.f denies a user outside the per-chat allowlist even when mentioned directly', () => {
    expect(resolve({
      message: message(mention('', 'jarvis_cauce_bot')),
      policy: policy({ allowed_user_ids: ['202'] })
    })).toMatchObject({ addressed: false, reason: 'user_denied' });
  });

  it('P1 denies a chat whose mode is off', () => {
    expect(resolve({
      message: message(mention('', 'jarvis_cauce_bot')),
      policy: policy({ mode: 'off' })
    })).toMatchObject({ addressed: false, reason: 'chat_disabled' });
  });

  it('P2 allows a mention of self anywhere in the text', () => {
    const decision = resolve({ message: message(mention('oye ', 'jarvis_cauce_bot')) });
    expect(decision).toMatchObject({ addressed: true, reason: 'mention', bucket: 'mention' });
  });

  it('P2 allows a text_mention that carries this bot id', () => {
    expect(resolve({
      message: message({
        text: 'Jarvis mira esto',
        entities: [{ type: 'text_mention', offset: 0, length: 6, user: { id: 900001, is_bot: true } }]
      })
    })).toMatchObject({ addressed: true, reason: 'mention' });
  });

  it('P2 allows /cmd@self and reports it as a command', () => {
    expect(resolve({ message: message(command('', '/status@jarvis_cauce_bot')) }))
      .toMatchObject({ addressed: true, reason: 'command', bucket: 'command' });
  });

  it('P2 answers a multi-mention', () => {
    const first = '@jarvis_cauce_bot';
    const second = '@kant_cauce_bot';
    const text = `${first} y ${second}, opinen`;
    const entities: TelegramEntity[] = [
      { type: 'mention', offset: 0, length: first.length },
      { type: 'mention', offset: text.indexOf(second), length: second.length }
    ];
    const decision = resolve({ message: message({ text, entities }) });
    expect(decision).toMatchObject({ addressed: true, reason: 'mention' });
  });

  it('P3 suppresses the echo when only another fleet alias is mentioned', () => {
    expect(resolve({ message: message(mention('', 'kant_cauce_bot')) }))
      .toMatchObject({ addressed: false, reason: 'other_bot_mentioned' });
  });

  it('P3 only suppresses against aliases that actually serve this chat', () => {
    // The bug this closes: `fleet.byUsername` covers the whole file, so naming an alias that is
    // not in this group used to silence every alias that IS in it — nobody answered at all.
    const toAbsentPeer = message(mention('', 'socrates_cauce_bot'));
    const present = new Set(['jarvis', 'kant']);
    expect(resolve({ message: toAbsentPeer, participants: present, policy: policy({ default_alias: 'jarvis' }) }))
      .toMatchObject({ addressed: true, reason: 'default_alias' });
    // With no ambient host nobody answers, but the silence is now reported as its own reason
    // instead of hiding inside the generic `not_addressed` bucket.
    expect(resolve({ message: toAbsentPeer, participants: present }))
      .toMatchObject({ addressed: false, reason: 'mention_unserved' });
    // A peer that does serve the chat still suppresses this bot, which is the whole feature.
    expect(resolve({ message: message(mention('', 'kant_cauce_bot')), participants: present }))
      .toMatchObject({ addressed: false, reason: 'other_bot_mentioned' });
  });

  it('P3 treats a peer whose entry is off as unable to serve the chat', () => {
    // `participants` is built from effectiveChatPolicy, so an `off` peer is simply absent from it.
    expect(resolve({
      message: message(mention('', 'kant_cauce_bot')),
      participants: new Set(['jarvis']),
      policy: policy({ mode: 'always' })
    })).toMatchObject({ addressed: true, reason: 'always' });
  });

  it('P3 suppresses a command aimed at another fleet alias', () => {
    expect(resolve({ message: message(command('', '/status@socrates_cauce_bot')) }))
      .toMatchObject({ addressed: false, reason: 'other_bot_mentioned' });
  });

  it('P4 denies a message opening with a mention of a human or a foreign bot', () => {
    expect(resolve({ message: message(mention('', 'miguel')) }))
      .toMatchObject({ addressed: false, reason: 'foreign_mention' });
    expect(resolve({ message: message(mention('', 'some_other_bot')) }))
      .toMatchObject({ addressed: false, reason: 'foreign_mention' });
    expect(resolve({
      message: message({
        text: 'Miguel mirá',
        entities: [{ type: 'text_mention', offset: 0, length: 6, user: { id: 555 } }]
      })
    })).toMatchObject({ addressed: false, reason: 'foreign_mention' });
  });

  it('P4 does not fire when the foreign mention is not the opening entity', () => {
    // Mid-sentence mentions of third parties are ordinary conversation, not addressing.
    expect(resolve({
      message: message(mention('che ', 'miguel')),
      policy: policy({ default_alias: 'jarvis' })
    })).toMatchObject({ addressed: true, reason: 'default_alias' });
  });

  it('P5 allows a reply to this bot own message', () => {
    expect(resolve({
      message: message({
        reply_to_message: { message_id: 480, from: { id: 900001, is_bot: true, username: 'jarvis_cauce_bot' } }
      })
    })).toMatchObject({ addressed: true, reason: 'reply', bucket: 'reply' });
  });

  it('P5 compares bot ids as strings (number vs string regression)', () => {
    // getMe returns String(id) while the wire carries a number; a raw === would never match.
    expect(resolve({
      self: { ...SELF, bot_id: '900001' },
      message: message({ reply_to_message: { message_id: 480, from: { id: 900001, is_bot: true } } })
    })).toMatchObject({ addressed: true, reason: 'reply' });
  });

  it('P6 stays quiet when the reply targets another fleet bot', () => {
    expect(resolve({
      message: message({
        reply_to_message: { message_id: 480, from: { id: 900002, is_bot: true, username: 'kant_cauce_bot' } }
      })
    })).toMatchObject({ addressed: false, reason: 'other_bot_replied' });
  });

  it('P6 ignores a reply to a human and keeps evaluating', () => {
    expect(resolve({
      message: message({ reply_to_message: { message_id: 480, from: { id: 202, is_bot: false } } }),
      policy: policy({ mode: 'always' })
    })).toMatchObject({ addressed: true, reason: 'always' });
  });

  it('P7 allows an unaddressed message when mode is always', () => {
    expect(resolve({ policy: policy({ mode: 'always' }) }))
      .toMatchObject({ addressed: true, reason: 'always', bucket: 'ambient' });
  });

  it('P8 allows a bare /command only for the declared host', () => {
    expect(resolve({
      message: message(command('', '/status')),
      policy: policy({ default_alias: 'jarvis' })
    })).toMatchObject({ addressed: true, reason: 'command' });
    expect(resolve({ message: message(command('', '/status')) }))
      .toMatchObject({ addressed: false, reason: 'not_addressed' });
  });

  it('P9 allows the declared host of the scope', () => {
    expect(resolve({ policy: policy({ default_alias: 'jarvis' }) }))
      .toMatchObject({ addressed: true, reason: 'default_alias', bucket: 'ambient' });
  });

  it('P10 stays silent by default', () => {
    expect(resolve()).toMatchObject({ addressed: false, reason: 'not_addressed' });
  });
});

describe('entity extraction', () => {
  it('slices mention offsets as UTF-16 code units', () => {
    // Two astral emoji occupy 4 UTF-16 units. Cutting by code points would shift the slice and
    // route the message to the wrong bot (or to nobody).
    const text = '🙂🙂 @jarvis_cauce_bot dale';
    expect(text.slice(5, 5 + 18)).toBe('@jarvis_cauce_bot ');
    expect(resolveAddressing({
      message: message({ text, entities: [{ type: 'mention', offset: 5, length: 17 }] }),
      self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: true, reason: 'mention' });
  });

  it('discards malformed entities without throwing', () => {
    const entities = [
      { type: 'mention', offset: -1, length: 5 },
      { type: 'mention', offset: 0, length: 1_000 },
      { type: 'mention', offset: 1.5, length: 4 },
      { type: 'mention', offset: 0, length: 0 },
      { type: 'mention', offset: 0, length: Number.NaN }
    ] as unknown as TelegramEntity[];
    expect(resolveAddressing({
      message: message({ text: '@jarvis_cauce_bot', entities }),
      self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: false, reason: 'not_addressed' });
  });

  it('reads mentions from a caption as well as from text', () => {
    expect(resolveAddressing({
      message: message({
        text: undefined,
        caption: 'mirá @jarvis_cauce_bot',
        caption_entities: [{ type: 'mention', offset: 5, length: 17 }]
      }),
      self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: true, reason: 'mention' });
  });

  it('does not let decorative entities consume the addressing budget', () => {
    // Regression: the budget counted EVERY entity, so an ordinary formatted message (bold, code,
    // links, custom emoji) pushed a real mention past it. The bot then stayed silent — or worse,
    // with an ambient host configured, the wrong bot answered a message addressed to this one.
    const prefix = 'x'.repeat(40);
    const text = `${prefix} @jarvis_cauce_bot dale`;
    const entities: TelegramEntity[] = Array.from({ length: 40 }, (_, index) => ({
      type: index % 2 === 0 ? 'bold' : 'custom_emoji', offset: index, length: 1
    }));
    entities.push({ type: 'mention', offset: prefix.length + 1, length: 17 });
    expect(resolveAddressing({
      message: message({ text, entities }), self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: true, reason: 'mention' });
  });

  it('anchors the leading-mention rule on the first addressing entity', () => {
    // A decorative entity at offset 0 used to claim the "first entity" slot, so P4 stopped firing
    // and the ambient host answered a message opening with a mention of a human.
    const text = '@miguel mirá esto';
    const entities: TelegramEntity[] = [
      { type: 'bold', offset: 0, length: 1 },
      { type: 'mention', offset: 0, length: 7 }
    ];
    expect(resolveAddressing({
      message: message({ text, entities }),
      self: SELF,
      fleet: FLEET,
      policy: { ...GROUP, default_alias: 'jarvis' }
    })).toMatchObject({ addressed: false, reason: 'foreign_mention' });
  });

  it('stops after the addressing-entity budget so a spam message cannot burn CPU', () => {
    const handles = Array.from({ length: 40 }, () => '@nobody_at_all');
    const text = handles.join(' ');
    const entities = handles.map((handle, index) => ({
      type: 'mention', offset: index * (handle.length + 1), length: handle.length
    }));
    // The self mention sits past the 16-entity budget and is therefore never seen.
    const withSelf = `${text} @jarvis_cauce_bot`;
    entities.push({ type: 'mention', offset: text.length + 1, length: 17 });
    expect(resolveAddressing({
      message: message({ text: withSelf, entities }),
      self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: false, reason: 'foreign_mention' });
  });

  it('ignores a mention whose slice is not a valid @username', () => {
    expect(resolveAddressing({
      message: message({ text: 'jarvis_cauce_bot', entities: [{ type: 'mention', offset: 0, length: 16 }] }),
      self: SELF, fleet: FLEET, policy: GROUP
    })).toMatchObject({ addressed: false, reason: 'not_addressed' });
  });
});

describe('thread identity', () => {
  it('only reports a thread for real topic messages', () => {
    expect(telegramThreadId(message({ message_thread_id: 42 }))).toBe('0');
    expect(telegramThreadId(message({ message_thread_id: 42, is_topic_message: true }))).toBe('42');
  });

  it('rejects non-integer, negative and absent topic ids', () => {
    expect(telegramThreadId(message({ message_thread_id: 1.5, is_topic_message: true }))).toBe('0');
    expect(telegramThreadId(message({ message_thread_id: -3, is_topic_message: true }))).toBe('0');
    expect(telegramThreadId(message({ is_topic_message: true }))).toBe('0');
    expect(telegramThreadId(message({ message_thread_id: 1e30, is_topic_message: true }))).toBe('0');
  });

  it('carries the thread id into the decision', () => {
    const decision = resolve({
      message: message({ message_thread_id: 42, is_topic_message: true, ...mention('', 'jarvis_cauce_bot') })
    });
    expect(decision.thread_id).toBe('42');
  });
});

describe('addressing buckets', () => {
  it('collapses every config dependent reason into ambient', () => {
    // Only the bucket may enter the hashed publish payload, so it must not encode anything that
    // can differ between two attempts at the same update_id. `always`/`default_alias` depend on
    // the deployed config, which a redeploy can change mid-retry.
    expect(addressingBucket('always')).toBe('ambient');
    expect(addressingBucket('default_alias')).toBe('ambient');
    expect(addressingBucket('mention')).toBe('mention');
    expect(addressingBucket('command')).toBe('command');
    expect(addressingBucket('reply')).toBe('reply');
    expect(addressingBucket('private')).toBe('private');
    expect(addressingBucket('legacy')).toBe('legacy');
  });

  it('keeps the bucket stable when the ambient host changes under the same update', () => {
    const addressed = message(mention('', 'jarvis_cauce_bot'));
    const first = resolve({ message: addressed, policy: policy({ default_alias: 'jarvis' }) });
    const second = resolve({ message: addressed, policy: policy({ mode: 'always' }) });
    expect(first.addressed && first.bucket).toBe('mention');
    expect(second.addressed && second.bucket).toBe('mention');
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

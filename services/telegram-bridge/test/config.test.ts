import { describe, expect, it } from 'vitest';
import {
  chatParticipants, effectiveChatPolicy, fleetDirectory, fleetParticipationGaps, groupRouting,
  parseTelegramBridgeConfig
} from '../src/config.js';
import type { TelegramBridgeConfig } from '../src/types.js';

/**
 * Coverage for the config layer, where the production invariants of the group-routing
 * feature actually live. The pure `addressing.ts` resolver has its own test file; this one
 * exercises the boot-time gates (`parseTelegramBridgeConfig`'s cross-alias assertions) and
 * the pure helpers `main.ts` wires into the poller/egress (`effectiveChatPolicy`,
 * `chatParticipants`, `fleetDirectory`, `fleetParticipationGaps`, `groupRouting`).
 */

const TENANT = 'Steven';
const CHAT_ID = '-5001';

function rawAlias(alias: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias,
    tenant_id: TENANT,
    room_id: 'grp.steven',
    token_file: `/synthetic/${alias}.token`,
    v2_shutdown_marker_file: `/synthetic/${alias}.marker`,
    allowed_user_ids: ['101'],
    allowed_chat_ids: [CHAT_ID],
    recipients: [{ tenant_id: TENANT, alias }],
    poll_timeout_seconds: 25,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

function build(aliases: Record<string, unknown>[]): TelegramBridgeConfig {
  return parseTelegramBridgeConfig({ aliases });
}

describe('groupRouting', () => {
  it('is legacy when chats is absent and scoped when present, even empty', () => {
    const config = build([
      rawAlias('kant'),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] })
    ]);
    const first = config.aliases[0];
    const second = config.aliases[1];
    if (!first || !second) throw new Error('Aliases not found');
    expect(groupRouting(first)).toBe('legacy');
    expect(groupRouting(second)).toBe('scoped');
  });
});

describe('effectiveChatPolicy', () => {
  it('returns undefined when a scoped alias never declared the chat', () => {
    const config = build([rawAlias('kant', { bot_username: 'kant_bot', chats: [] })]);
    const first = config.aliases[0];
    if (!first) throw new Error('Alias not found');
    expect(effectiveChatPolicy(first, CHAT_ID, '0')).toBeUndefined();
  });

  it('merges a thread override on top of the chat entry, inheriting fields the thread omits', () => {
    const config = build([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{
        chat_id: CHAT_ID,
        mode: 'always',
        default_alias: 'kant',
        threads: [{ thread_id: '42', mode: 'mention' }]
      }]
    })]);
    const alias = config.aliases[0];
    if (!alias) throw new Error('Alias not found');
    expect(effectiveChatPolicy(alias, CHAT_ID, '0')).toMatchObject({ mode: 'always', default_alias: 'kant' });
    // Thread 42 narrows mode but does not mention default_alias, so it inherits the chat's host.
    expect(effectiveChatPolicy(alias, CHAT_ID, '42')).toMatchObject({ mode: 'mention', default_alias: 'kant' });
    // An undeclared thread falls back to the chat-level policy untouched.
    expect(effectiveChatPolicy(alias, CHAT_ID, '99')).toMatchObject({ mode: 'always', default_alias: 'kant' });
  });

  it('lets a thread override clear an inherited host with default_alias: null', () => {
    const config = build([rawAlias('kant', {
      bot_username: 'kant_bot',
      chats: [{
        chat_id: CHAT_ID,
        default_alias: 'kant',
        threads: [{ thread_id: '42', default_alias: null }]
      }]
    })]);
    const alias = config.aliases[0];
    if (!alias) throw new Error('Alias not found');
    expect(effectiveChatPolicy(alias, CHAT_ID, '0')).toMatchObject({ default_alias: 'kant' });
    expect(effectiveChatPolicy(alias, CHAT_ID, '42')).not.toHaveProperty('default_alias');
  });
});

describe('parseTelegramBridgeConfig: assertSingleAmbientHost', () => {
  it('rejects two aliases eligible to answer the same unaddressed (chat, thread)', () => {
    expect(() => build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] })
    ])).toThrow(/at most one alias may answer unaddressed messages/);
  });

  it('rejects a chat-level always host colliding with a default_alias another alias declares on a thread', () => {
    expect(() => build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', {
        bot_username: 'argos_bot',
        chats: [{
          chat_id: CHAT_ID, mode: 'mention',
          threads: [{ thread_id: '7', default_alias: 'argos' }]
        }]
      })
    ])).toThrow(/at most one alias may answer unaddressed messages in chat -5001 thread 7/);
  });

  it('accepts a single ambient host per scope', () => {
    expect(() => build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'mention' }] })
    ])).not.toThrow();
  });
});

describe('parseTelegramBridgeConfig: assertFleetUsernames', () => {
  it('does not require bot_username from an alias that never declares chats', () => {
    expect(() => build([
      rawAlias('kant'),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] })
    ])).not.toThrow();
  });

  it('rejects an alias that declares chats without a bot_username', () => {
    expect(() => build([
      rawAlias('kant', { chats: [{ chat_id: CHAT_ID }] })
    ])).toThrow(/kant must declare bot_username because it declares chats/);
  });

  it('rejects duplicate bot_username values across aliases', () => {
    expect(() => build([
      rawAlias('kant', { bot_username: 'shared_bot', chats: [] }),
      rawAlias('argos', { bot_username: 'shared_bot', chats: [] })
    ])).toThrow(/bot_username values must be unique/);
  });
});

describe('chatParticipants', () => {
  it('counts a scoped alias only for the chats it actually serves, and a legacy alias via allowed_chat_ids', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'off' }] }),
      rawAlias('jarvis') // legacy: no `chats` key, but CHAT_ID is in its allowed_chat_ids
    ]);
    const participants = chatParticipants(config, CHAT_ID, '0');
    expect(participants.has('kant')).toBe(true);
    expect(participants.has('argos')).toBe(false); // mode: off never serves the scope
    expect(participants.has('jarvis')).toBe(true); // legacy participation via allowed_chat_ids
  });

  it('excludes a scoped alias that opted into routing but never declared this chat', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] }) // scoped, default-deny, no entry for CHAT_ID
    ]);
    const participants = chatParticipants(config, CHAT_ID, '0');
    expect(participants.has('kant')).toBe(true);
    expect(participants.has('argos')).toBe(false);
  });
});

describe('fleetParticipationGaps', () => {
  it('reports an alias that shares a chat with a running alias but is not itself running', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'mention' }] })
    ]);
    const firstAlias = config.aliases[0];
    if (!firstAlias) throw new Error('Alias not found');
    const selected = [firstAlias]; // only kant is selected to run
    expect(fleetParticipationGaps(config, selected)).toEqual([{ alias: 'argos', chat_id: CHAT_ID }]);
  });

  it('reports nothing when every declared participant of a running chat is running', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'mention' }] })
    ]);
    expect(fleetParticipationGaps(config, config.aliases)).toEqual([]);
  });

  it('reports nothing for an alias whose chats do not overlap any running alias', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID }] }),
      rawAlias('argos', {
        bot_username: 'argos_bot',
        allowed_chat_ids: ['-9999'],
        chats: [{ chat_id: '-9999' }]
      })
    ]);
    const firstAlias = config.aliases[0];
    if (!firstAlias) throw new Error('Alias not found');
    expect(fleetParticipationGaps(config, [firstAlias])).toEqual([]);
  });
});

describe('fleetDirectory', () => {
  it('builds byUsername from the whole file and byBotId only from the supplied live map', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] })
    ]);
    const directory = fleetDirectory(config, new Map([['kant', '900001']]));
    // Both usernames are present, even though only kant is "running" in this deployment: an
    // incremental start must still be able to suppress a mention of argos.
    expect(directory.byUsername.get('kant_bot')).toBe('kant');
    expect(directory.byUsername.get('argos_bot')).toBe('argos');
    expect(directory.byBotId.get('900001')).toBe('kant');
    expect(directory.byBotId.size).toBe(1);
  });
});

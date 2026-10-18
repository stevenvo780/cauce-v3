import { describe, expect, it } from 'vitest';
import {
  chatParticipants, effectiveChatPolicy, fleetDirectory, groupRouting,
  parseTelegramBridgeConfig
} from '../src/config.js';
import type { TelegramBridgeConfig } from '../src/types.js';
import { selectTelegramAliases } from '../src/identity.js';

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
  const tenant = (overrides.tenant_id as string | undefined) ?? TENANT;
  return {
    alias,
    tenant_id: tenant,
    room_id: 'grp.steven',
    token_file: `/synthetic/${tenant}/${alias}.token`,
    v2_shutdown_marker_file: `/synthetic/${tenant}/${alias}.marker`,
    allowed_user_ids: ['101'],
    allowed_chat_ids: [CHAT_ID],
    recipients: [{ tenant_id: tenant, alias }],
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
});

describe('parseTelegramBridgeConfig: assertSingleAmbientHost', () => {
  it('rejects two aliases eligible to answer the same unaddressed (chat, thread)', () => {
    expect(() => build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [{ chat_id: CHAT_ID, mode: 'always' }] })
    ])).toThrow(/at most one alias may answer unaddressed messages/);
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
    expect(participants.has('Steven/kant')).toBe(true);
    expect(participants.has('Steven/argos')).toBe(false); // mode: off never serves the scope
    expect(participants.has('Steven/jarvis')).toBe(true); // legacy participation via allowed_chat_ids
  });
});

describe('fleetDirectory', () => {
  it('builds byUsername from the whole file and byBotId only from the supplied live map', () => {
    const config = build([
      rawAlias('kant', { bot_username: 'kant_bot', chats: [] }),
      rawAlias('argos', { bot_username: 'argos_bot', chats: [] })
    ]);
    const directory = fleetDirectory(config, new Map([['Steven/kant', '900001']]));
    // Both usernames are present, even though only kant is "running" in this deployment: an
    // incremental start must still be able to suppress a mention of argos.
    expect(directory.byUsername.get('kant_bot')).toBe('Steven/kant');
    expect(directory.byUsername.get('argos_bot')).toBe('Steven/argos');
    expect(directory.byBotId.get('900001')).toBe('Steven/kant');
    expect(directory.byBotId.size).toBe(1);
  });
});

describe('parseTelegramBridgeConfig: multi-tenant token isolation', () => {
  it('accepts identical alias names in different tenants in one bridge configuration', () => {
    expect(() => build([
      rawAlias('zeus', {
        tenant_id: 'Steven',
        token_file: '/synthetic/Steven/zeus.token',
        recipients: [{ tenant_id: 'Steven', alias: 'zeus' }]
      }),
      rawAlias('zeus', {
        tenant_id: 'Hospital',
        room_id: 'grp.hospital',
        token_file: '/synthetic/Hospital/zeus.token',
        recipients: [{ tenant_id: 'Hospital', alias: 'zeus' }]
      })
    ])).not.toThrow();
  });

  it('rejects sharing token_file across aliases (insecure token sharing)', () => {
    expect(() => build([
      rawAlias('zeus', {
        tenant_id: 'Steven',
        token_file: '/synthetic/Steven/zeus.token',
        recipients: [{ tenant_id: 'Steven', alias: 'zeus' }]
      }),
      rawAlias('argos', {
        tenant_id: 'Steven',
        token_file: '/synthetic/Steven/zeus.token',
        recipients: [{ tenant_id: 'Steven', alias: 'argos' }]
      })
    ])).toThrow('token_file values must be unique across aliases');
  });

  it('supports separate bridge configurations for different tenants with identical alias names', () => {
    const configSteven = build([
      rawAlias('zeus', {
        tenant_id: 'Steven',
        token_file: '/run/cauce-telegram/Steven/zeus.token',
        recipients: [{ tenant_id: 'Steven', alias: 'zeus' }]
      })
    ]);
    const configHospital = build([
      rawAlias('zeus', {
        tenant_id: 'Hospital',
        room_id: 'grp.hospital',
        token_file: '/run/cauce-telegram/Hospital/zeus.token',
        recipients: [{ tenant_id: 'Hospital', alias: 'zeus' }]
      })
    ]);
    expect(configSteven.aliases[0]?.tenant_id).toBe('Steven');
    expect(configHospital.aliases[0]?.tenant_id).toBe('Hospital');
    expect(configSteven.aliases[0]?.alias).toBe(configHospital.aliases[0]?.alias);
    expect(configSteven.aliases[0]?.token_file).not.toBe(configHospital.aliases[0]?.token_file);
  });

});

describe('shared bridge selection', () => {
  it('requires a qualified selector for a repeated alias', () => {
    const config = build(['North', 'South'].map(tenant_id => rawAlias('zeus', { tenant_id })));
    expect(() => selectTelegramAliases(config.aliases, 'zeus')).toThrow('ambiguous');
    expect(selectTelegramAliases(config.aliases, 'South/zeus')).toEqual([config.aliases[1]]);
    expect(selectTelegramAliases(config.aliases)).toHaveLength(2);
  });
  it('rejects a duplicate identity or shared shutdown marker independently', () => {
    expect(() => build([rawAlias('zeus'), rawAlias('zeus', { token_file: '/different/token', v2_shutdown_marker_file: '/different/marker' })]))
      .toThrow('tenant and alias pairs must be unique');
    expect(() => build(['North', 'South'].map(tenant_id => rawAlias('zeus', { tenant_id, v2_shutdown_marker_file: '/shared/marker' }))))
      .toThrow('shutdown marker paths must be unique');
  });
});

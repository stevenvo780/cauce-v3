import { describe, expect, it } from 'vitest';
import { parseTelegramBridgeConfig } from '../src/config.js';

function rawAlias(alias: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alias,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    token_file: `/synthetic/${alias}.token`,
    v2_shutdown_marker_file: `/synthetic/${alias}.marker`,
    allowed_user_ids: ['101', '202'],
    allowed_chat_ids: ['201'],
    recipients: [{ tenant_id: 'Steven', alias }],
    poll_timeout_seconds: 25,
    poll_lease_ms: 60_000,
    ...overrides
  };
}

describe('operator_commands config', () => {
  it('stays off when the keys are absent, so existing configs do not change behaviour', () => {
    const config = parseTelegramBridgeConfig({ aliases: [rawAlias('kant')] });
    const alias = config.aliases[0];
    expect(alias?.operator_commands).toBe(false);
    expect(alias?.operator_user_ids).toBeUndefined();
  });

  it('rejects operator_commands without an allowlisted operator_user_ids', () => {
    expect(() => parseTelegramBridgeConfig({
      aliases: [rawAlias('kant', { operator_commands: true })]
    })).toThrow(/operator_user_ids/u);
    expect(() => parseTelegramBridgeConfig({
      aliases: [rawAlias('kant', { operator_commands: true, operator_user_ids: [] })]
    })).toThrow(/operator_user_ids/u);
  });

  it('rejects operator_user_ids that are not a subset of allowed_user_ids', () => {
    expect(() => parseTelegramBridgeConfig({
      aliases: [rawAlias('kant', {
        operator_commands: true,
        operator_user_ids: ['999']
      })]
    })).toThrow(/subset of allowed_user_ids/u);
  });

  it('rejects operator_user_ids when operator_commands is not enabled', () => {
    expect(() => parseTelegramBridgeConfig({
      aliases: [rawAlias('kant', { operator_user_ids: ['101'] })]
    })).toThrow(/operator_commands/u);
  });

  it('accepts the pair and keeps operator_user_ids as a subset', () => {
    const config = parseTelegramBridgeConfig({
      aliases: [rawAlias('kant', {
        operator_commands: true,
        operator_user_ids: ['101']
      })]
    });
    const alias = config.aliases[0];
    expect(alias?.operator_commands).toBe(true);
    expect(alias?.operator_user_ids).toEqual(['101']);
  });
});

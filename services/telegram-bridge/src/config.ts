import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TenantSchema } from '@cauce/protocol';
import type { BridgeRecipient, TelegramAliasConfig, TelegramBridgeConfig } from './types.js';

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, pattern: RegExp, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function absolutePath(value: unknown, name: string): string {
  const path = text(value, name, /^\S+$/, 1_024);
  if (!isAbsolute(path)) throw new Error(`${name} must be absolute`);
  return path;
}

function idList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) throw new Error(`${name} must be a non-empty array`);
  const result = value.map((entry) => text(entry, name, /^-?[1-9][0-9]{0,19}$/, 20));
  if (new Set(result).size !== result.length) throw new Error(`${name} contains duplicates`);
  return result;
}

function positiveInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`${name} is invalid`);
  return Number(value);
}

function recipient(value: unknown): BridgeRecipient {
  const row = object(value, 'recipient');
  const tenant = TenantSchema.parse(row.tenant_id);
  return {
    tenant_id: tenant,
    alias: text(row.alias, 'recipient.alias', /^[a-z][a-z0-9_-]{0,63}$/, 64)
  };
}

function aliasConfig(value: unknown): TelegramAliasConfig {
  const row = object(value, 'telegram alias');
  if ('token' in row || 'bot_token' in row) throw new Error('inline Telegram tokens are forbidden');
  const alias = text(row.alias, 'alias', /^[a-z][a-z0-9_-]{0,63}$/, 64);
  const tenant = TenantSchema.parse(row.tenant_id);
  if (!Array.isArray(row.recipients) || row.recipients.length === 0 || row.recipients.length > 100) {
    throw new Error('recipients must be a non-empty array');
  }
  const recipients = row.recipients.map(recipient);
  const soleRecipient = recipients[0];
  if (recipients.length !== 1 ||
      soleRecipient?.tenant_id !== tenant ||
      soleRecipient.alias !== alias) {
    throw new Error('Telegram ingress requires exactly one self recipient');
  }
  const pollTimeoutSeconds = positiveInteger(row.poll_timeout_seconds, 25, 1, 50, 'poll_timeout_seconds');
  const pollLeaseMs = positiveInteger(row.poll_lease_ms, 60_000, 10_000, 300_000, 'poll_lease_ms');
  if (pollLeaseMs < pollTimeoutSeconds * 1_000 + 5_000) {
    throw new Error('poll_lease_ms must exceed the long-poll timeout by at least 5 seconds');
  }
  return {
    alias,
    tenant_id: tenant,
    room_id: text(row.room_id, 'room_id', /^[A-Za-z0-9._:-]{1,128}$/, 128),
    token_file: absolutePath(row.token_file, 'token_file'),
    v2_shutdown_marker_file: absolutePath(row.v2_shutdown_marker_file, 'v2_shutdown_marker_file'),
    allowed_user_ids: idList(row.allowed_user_ids, 'allowed_user_ids'),
    allowed_chat_ids: idList(row.allowed_chat_ids, 'allowed_chat_ids'),
    recipients,
    poll_timeout_seconds: pollTimeoutSeconds,
    poll_lease_ms: pollLeaseMs
  };
}

export function parseTelegramBridgeConfig(value: unknown): TelegramBridgeConfig {
  const root = object(value, 'Telegram bridge config');
  if (!Array.isArray(root.aliases) || root.aliases.length === 0 || root.aliases.length > 100) {
    throw new Error('aliases must be a non-empty array');
  }
  const aliases = root.aliases.map(aliasConfig);
  if (new Set(aliases.map((entry) => entry.alias)).size !== aliases.length) throw new Error('alias names must be unique');
  if (new Set(aliases.map((entry) => `${entry.tenant_id}:${entry.alias}`)).size !== aliases.length) {
    throw new Error('tenant/alias pairs must be unique');
  }
  return { aliases };
}

export async function loadTelegramBridgeConfig(path: string): Promise<TelegramBridgeConfig> {
  if (!isAbsolute(path)) throw new Error('CAUCE_TELEGRAM_CONFIG_FILE must be absolute');
  return parseTelegramBridgeConfig(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

export async function readTelegramToken(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Telegram token file must be a regular file');
  if ((info.mode & 0o777) !== 0o600) throw new Error('Telegram token file permissions must be 0600');
  if (typeof process.geteuid === 'function' && info.uid !== process.geteuid()) {
    throw new Error('Telegram token file must be owned by the service user');
  }
  const token = (await readFile(path, 'utf8')).trim();
  if (!/^[0-9]{6,20}:[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('Telegram token file is invalid');
  return token;
}

export async function assertV2PollerDisabled(config: TelegramAliasConfig): Promise<void> {
  const info = await lstat(config.v2_shutdown_marker_file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o022) !== 0) {
    throw new Error(`V2 shutdown marker for ${config.alias} is not a protected regular file`);
  }
  const expected = `v2-poller-disabled:${config.alias}`;
  if ((await readFile(config.v2_shutdown_marker_file, 'utf8')).trim() !== expected) {
    throw new Error(`V2 poller shutdown is not confirmed for ${config.alias}`);
  }
}

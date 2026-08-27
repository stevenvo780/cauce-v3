import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TenantSchema } from '@cauce/protocol';
import type { FleetDirectory, GroupRouting } from './addressing.js';
import type {
  BridgeRecipient, SessionScope, TelegramAliasConfig, TelegramBridgeConfig, TelegramChatMode,
  TelegramChatPolicy, TelegramChatPolicyConfig, TelegramThreadPolicyConfig
} from './types.js';

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

const CHAT_MODES: readonly TelegramChatMode[] = ['mention', 'always', 'off'];
const SESSION_SCOPES: readonly SessionScope[] = ['user', 'chat', 'thread'];

function boolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function chatMode(value: unknown): TelegramChatMode {
  if (value === undefined) return 'mention';
  const mode = CHAT_MODES.find((entry) => entry === value);
  if (!mode) throw new Error('chats[].mode is invalid');
  return mode;
}

function sessionScope(value: unknown, fallback: SessionScope | undefined): SessionScope | undefined {
  if (value === undefined) return fallback;
  const scope = SESSION_SCOPES.find((entry) => entry === value);
  if (!scope) throw new Error('session_scope is invalid');
  return scope;
}

/**
 * `default_alias` may only ever nominate the alias that owns the entry.
 *
 * Nothing in the resolver compares it against another alias (P11 tests it against `self.alias`),
 * so `"default_alias": "kant"` inside jarvis's block would be silently inert and would leave the
 * group mute. Rejecting it at load time turns a plausible operator typo into a boot failure.
 */
function defaultAlias(value: unknown, owner: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const alias = text(value, 'default_alias', /^[a-z][a-z0-9_-]{0,63}$/, 64);
  if (alias !== owner) throw new Error('default_alias must name the alias that declares it');
  return alias;
}

function narrowedUserIds(value: unknown, parent: readonly string[], name: string): string[] | undefined {
  if (value === undefined) return undefined;
  const ids = idList(value, name);
  for (const entry of ids) {
    if (!parent.includes(entry)) throw new Error(`${name} must be a subset of allowed_user_ids`);
  }
  return ids;
}

function threadPolicy(
  value: unknown,
  owner: string,
  chatUserIds: readonly string[]
): TelegramThreadPolicyConfig {
  const row = object(value, 'chats[].threads[]');
  const allowed = narrowedUserIds(row.allowed_user_ids, chatUserIds, 'threads[].allowed_user_ids');
  const scope = sessionScope(row.session_scope, undefined);
  const host = defaultAlias(row.default_alias, owner);
  const mode = row.mode === undefined ? undefined : chatMode(row.mode);
  if (mode === 'off' && typeof host === 'string') {
    throw new Error('threads[].default_alias cannot be set while mode is off');
  }
  return {
    thread_id: text(row.thread_id, 'threads[].thread_id', /^[1-9][0-9]{0,15}$/, 16),
    ...(mode === undefined ? {} : { mode }),
    ...(allowed === undefined ? {} : { allowed_user_ids: allowed }),
    ...(host === undefined ? {} : { default_alias: host }),
    ...(scope === undefined ? {} : { session_scope: scope }),
    ...(row.reply_to_origin === undefined
      ? {} : { reply_to_origin: boolean(row.reply_to_origin, true, 'threads[].reply_to_origin') })
  };
}

function chatPolicy(
  value: unknown,
  owner: string,
  aliasUserIds: readonly string[],
  allowedChatIds: readonly string[]
): TelegramChatPolicyConfig {
  const row = object(value, 'chats[]');
  const chatId = text(row.chat_id, 'chats[].chat_id', /^-[1-9][0-9]{0,19}$/, 20);
  // Group and supergroup ids are always negative. A positive id here would name a private chat,
  // which P0.b answers before ever consulting a policy — the entry would be inert on ingress while
  // `egressAuthorized` still honoured it, so a `mode:'off'` DM would run the harness and then
  // dead-letter its answer. Rejecting the shape removes the asymmetry instead of documenting it.
  if (!allowedChatIds.includes(chatId)) throw new Error('chats[].chat_id must be listed in allowed_chat_ids');
  const allowed = narrowedUserIds(row.allowed_user_ids, aliasUserIds, 'chats[].allowed_user_ids');
  const mode = chatMode(row.mode);
  const host = defaultAlias(row.default_alias, owner);
  if (mode === 'off' && typeof host === 'string') {
    throw new Error('chats[].default_alias cannot be set while mode is off');
  }
  if (!Array.isArray(row.threads ?? [])) throw new Error('chats[].threads must be an array');
  const rawThreads = (row.threads ?? []) as unknown[];
  if (rawThreads.length > 200) throw new Error('chats[].threads is too large');
  const threads = rawThreads.map((entry) => threadPolicy(entry, owner, allowed ?? aliasUserIds));
  if (new Set(threads.map((entry) => entry.thread_id)).size !== threads.length) {
    throw new Error('chats[].threads contains duplicate thread_id');
  }
  return {
    chat_id: chatId,
    mode,
    ...(allowed === undefined ? {} : { allowed_user_ids: allowed }),
    ...(host === undefined ? {} : { default_alias: host }),
    session_scope: sessionScope(row.session_scope, 'user') ?? 'user',
    reply_to_origin: boolean(row.reply_to_origin, true, 'chats[].reply_to_origin'),
    threads
  };
}

/**
 * Group routing mode of an alias.
 *
 * The ABSENCE of the `chats` key is the signal, not its emptiness: an operator who writes
 * `"chats": []` has explicitly opted the alias into default-deny (a deliberately group-mute bot),
 * whereas an alias that predates this feature simply has no key and must keep working untouched.
 */
export function groupRouting(config: Pick<TelegramAliasConfig, 'chats'>): GroupRouting {
  return config.chats === undefined ? 'legacy' : 'scoped';
}

/**
 * Merge the chat entry with the matching thread override into the policy the resolver consumes.
 * Returns undefined when the alias declares no participation in the chat, which is the
 * default-deny signal for every group of a `scoped` alias.
 */
export function effectiveChatPolicy(
  config: Pick<TelegramAliasConfig, 'chats'>,
  chatId: string,
  threadId: string
): TelegramChatPolicy | undefined {
  const chat = config.chats?.find((entry) => entry.chat_id === chatId);
  if (!chat) return undefined;
  const thread = threadId === '0' ? undefined : chat.threads.find((entry) => entry.thread_id === threadId);
  const host = thread !== undefined && 'default_alias' in thread ? thread.default_alias : chat.default_alias;
  return {
    chat_id: chatId,
    thread_id: threadId,
    mode: thread?.mode ?? chat.mode,
    allowed_user_ids: thread?.allowed_user_ids ?? chat.allowed_user_ids,
    ...(typeof host === 'string' ? { default_alias: host } : {}),
    session_scope: thread?.session_scope ?? chat.session_scope,
    reply_to_origin: thread?.reply_to_origin ?? chat.reply_to_origin
  };
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
  const allowedUserIds = idList(row.allowed_user_ids, 'allowed_user_ids');
  const allowedChatIds = idList(row.allowed_chat_ids, 'allowed_chat_ids');
  // An ABSENT `chats` key keeps the alias on legacy group routing; present (even empty) opts it
  // into default-deny. The distinction is what lets the code ship before the config.
  let chats: TelegramChatPolicyConfig[] | undefined;
  if (row.chats !== undefined) {
    if (!Array.isArray(row.chats)) throw new Error('chats must be an array');
    const rawChats = row.chats as unknown[];
    if (rawChats.length > 200) throw new Error('chats is too large');
    chats = rawChats.map((entry) => chatPolicy(entry, alias, allowedUserIds, allowedChatIds));
    if (new Set(chats.map((entry) => entry.chat_id)).size !== chats.length) {
      throw new Error('chats contains duplicate chat_id');
    }
  }
  return {
    alias,
    tenant_id: tenant,
    room_id: text(row.room_id, 'room_id', /^[A-Za-z0-9._:-]{1,128}$/, 128),
    token_file: absolutePath(row.token_file, 'token_file'),
    v2_shutdown_marker_file: absolutePath(row.v2_shutdown_marker_file, 'v2_shutdown_marker_file'),
    ...(row.bot_username === undefined
      ? {} : { bot_username: text(row.bot_username, 'bot_username', /^[A-Za-z][A-Za-z0-9_]{4,31}$/, 32) }),
    allowed_user_ids: allowedUserIds,
    allowed_chat_ids: allowedChatIds,
    ...(chats === undefined ? {} : { chats }),
    recipients,
    poll_timeout_seconds: pollTimeoutSeconds,
    poll_lease_ms: pollLeaseMs
  };
}

/** Every (chat, thread) scope declared anywhere in the file, so cross-alias rules can be checked. */
function declaredScopes(aliases: readonly TelegramAliasConfig[]): Map<string, Set<string>> {
  const scopes = new Map<string, Set<string>>();
  for (const alias of aliases) {
    for (const chat of alias.chats ?? []) {
      const threads = scopes.get(chat.chat_id) ?? new Set<string>(['0']);
      for (const thread of chat.threads) threads.add(thread.thread_id);
      scopes.set(chat.chat_id, threads);
    }
  }
  return scopes;
}

/**
 * A bot answers a message that names nobody only when it is the ambient host of the scope:
 * `mode:'always'` or `default_alias === self`. If two aliases are ambient-eligible for the same
 * (chat, thread), every unaddressed message wakes both of them — which is precisely the
 * "every bot answers everything" bug this block exists to remove, reachable purely by config.
 */
function assertSingleAmbientHost(aliases: readonly TelegramAliasConfig[]): void {
  for (const [chatId, threads] of declaredScopes(aliases)) {
    for (const threadId of threads) {
      const hosts = aliases.filter((alias) => {
        const policy = effectiveChatPolicy(alias, chatId, threadId);
        if (!policy || policy.mode === 'off') return false;
        return policy.mode === 'always' || policy.default_alias === alias.alias;
      });
      if (hosts.length > 1) {
        throw new Error(
          `at most one alias may answer unaddressed messages in chat ${chatId} thread ${threadId}`
        );
      }
    }
  }
}

/**
 * Mention routing needs a username for every bot that can answer in a shared chat: P3 ("a fleet
 * member that serves this scope was named, stay quiet") is unreachable for an alias whose username
 * is unknown.
 *
 * The requirement is scoped to aliases that declare `chats`, ensuring an alias with no shared
 * chats does not require a bot username.
 */
function assertFleetUsernames(aliases: readonly TelegramAliasConfig[]): void {
  const usernames = new Set<string>();
  for (const alias of aliases) {
    if (alias.bot_username === undefined) {
      if ((alias.chats ?? []).length > 0) {
        throw new Error(`${alias.alias} must declare bot_username because it declares chats`);
      }
      continue;
    }
    const lowered = alias.bot_username.toLowerCase();
    if (usernames.has(lowered)) throw new Error('bot_username values must be unique');
    usernames.add(lowered);
  }
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
  assertFleetUsernames(aliases);
  assertSingleAmbientHost(aliases);
  return { aliases };
}

/**
 * Directory used by the addressing resolver. `byUsername` is built from the COMPLETE file so that
 * an incremental start still suppresses correctly; `byBotId` only ever holds aliases whose
 * identity was verified against `getMe` in this process.
 */
export function fleetDirectory(
  config: TelegramBridgeConfig,
  botIds: ReadonlyMap<string, string> = new Map()
): FleetDirectory {
  const byUsername = new Map<string, string>();
  for (const alias of config.aliases) {
    if (alias.bot_username !== undefined) byUsername.set(alias.bot_username.toLowerCase(), alias.alias);
  }
  const byBotId = new Map<string, string>();
  for (const [alias, botId] of botIds) byBotId.set(botId, alias);
  return { byUsername, byBotId };
}

/**
 * Aliases that can actually answer in a given (chat, thread), from the COMPLETE file.
 *
 * This is the set P3 suppresses against. Building it from real participation instead of from the
 * whole fleet is what stops a mention of an alias that is not in the group from silencing every
 * alias that is. A `legacy` alias counts as a participant of any chat in its coarse allowlist,
 * because a legacy alias does answer everything there.
 */
export function chatParticipants(
  config: TelegramBridgeConfig,
  chatId: string,
  threadId: string
): ReadonlySet<string> {
  const participants = new Set<string>();
  for (const alias of config.aliases) {
    if (alias.chats === undefined) {
      if (alias.allowed_chat_ids.includes(chatId)) participants.add(alias.alias);
      continue;
    }
    const policy = effectiveChatPolicy(alias, chatId, threadId);
    if (policy !== undefined && policy.mode !== 'off') participants.add(alias.alias);
  }
  return participants;
}

/**
 * Identifies configured participants in shared chats that are not currently running in `selected`,
 * allowing the caller to log diagnostic warnings without crashing DM polling loops.
 */
export function fleetParticipationGaps(
  config: TelegramBridgeConfig,
  selected: readonly TelegramAliasConfig[]
): { alias: string; chat_id: string }[] {
  const running = new Set(selected.map((entry) => entry.alias));
  const chats = new Set(selected.flatMap((entry) => (entry.chats ?? []).map((chat) => chat.chat_id)));
  const gaps: { alias: string; chat_id: string }[] = [];
  for (const alias of config.aliases) {
    if (running.has(alias.alias)) continue;
    for (const chat of alias.chats ?? []) {
      if (chats.has(chat.chat_id)) gaps.push({ alias: alias.alias, chat_id: chat.chat_id });
    }
  }
  return gaps;
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

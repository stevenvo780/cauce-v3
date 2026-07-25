import { CauceRepository, createPool } from '@cauce/store';
import { TelegramActivityIndicator } from './activity.js';
import {
  assertV2PollerDisabled, chatParticipants, fleetDirectory, fleetParticipationGaps,
  loadTelegramBridgeConfig, readTelegramToken
} from './config.js';
import { TelegramEgressWorker } from './egress.js';
import { startTelegramHealthServer, TelegramBridgeMetrics } from './health.js';
import { StoreTelegramIngress } from './ingress.js';
import { TelegramPoller } from './poller.js';
import { PostgresTelegramBridgeRepository } from './repository.js';
import { TelegramHttpClient } from './telegram.js';
import type { TelegramAliasConfig, TelegramApi } from './types.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positivePort(value: string | undefined): number {
  const port = Number(value ?? '8084');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
  return port;
}

function selected(configs: readonly TelegramAliasConfig[]): TelegramAliasConfig[] {
  const selector = process.env.CAUCE_TELEGRAM_ALIASES;
  if (!selector) return [...configs];
  const names = new Set(selector.split(',').map((value) => value.trim()).filter(Boolean));
  const result = configs.filter((entry) => names.has(entry.alias));
  if (result.length !== names.size || result.length === 0) throw new Error('CAUCE_TELEGRAM_ALIASES contains an unknown alias');
  return result;
}

const pool = createPool(required('DATABASE_URL'));
const repository = new PostgresTelegramBridgeRepository(pool);
const ingress = new StoreTelegramIngress(new CauceRepository(pool));
const metrics = new TelegramBridgeMetrics();
const controller = new AbortController();
const activity = new TelegramActivityIndicator();
let started = 0;
const health = startTelegramHealthServer(positivePort(process.env.PORT), pool, metrics, () => started);

/**
 * A group-configuration problem is reported and worked around; it never stops the process.
 *
 * The twelve DMs are the live product. An earlier version threw on both of the conditions below,
 * which meant the documented per-alias rollback (drop one alias from CAUCE_TELEGRAM_ALIASES and
 * restart) and a username rename in BotFather each turned into a crash loop that took every DM
 * down with it. Both are now degradations with a durable, structured trace.
 */
function degraded(reason: string, detail: Record<string, unknown>): void {
  metrics.increment('group_config_degraded');
  console.error(JSON.stringify({ event: 'telegram_group_config_degraded', reason, ...detail }));
}

try {
  const config = await loadTelegramBridgeConfig(required('CAUCE_TELEGRAM_CONFIG_FILE'));
  const aliases = selected(config.aliases);
  // A partial fleet in a shared chat leaves mentions of the missing alias unanswered. The resolver
  // already handles it (P3 suppresses only against declared participants, and an unserved mention
  // falls through to the ambient host), so this is a warning, not a boot failure.
  for (const gap of fleetParticipationGaps(config, aliases)) {
    degraded('alias_not_running_in_shared_chat', gap);
  }
  const apis = new Map<string, TelegramApi>();
  const identities = new Map<string, string>();
  const usernames = new Map<string, string>();
  const running: TelegramAliasConfig[] = [];
  for (const alias of aliases) {
    await assertV2PollerDisabled(alias);
    const api = new TelegramHttpClient({ token: await readTelegramToken(alias.token_file) });
    const identity = await api.getIdentity();
    // A wrong bot_username makes a bot fail to recognise its own mentions and makes its peers
    // suppress against a username that does not exist. That is a reason to take this alias out of
    // group routing (its DMs are unaffected), not to refuse to start the fleet.
    const mismatched = alias.bot_username !== undefined &&
      identity.username?.toLowerCase() !== alias.bot_username.toLowerCase();
    if (mismatched) {
      degraded('bot_username_mismatch', { alias: alias.alias, groups_disabled: true });
    }
    await repository.initializeCursor(identity.id, alias.tenant_id, alias.alias);
    apis.set(alias.alias, api);
    identities.set(alias.alias, identity.id);
    // Prefer the verified `getMe` username over the declared one: it is the name Telegram will
    // actually put in the mention entities.
    const username = identity.username ?? alias.bot_username;
    if (username !== undefined) usernames.set(alias.alias, username);
    // `chats: []` (present but empty) is the explicit default-deny mode, so a mismatched alias
    // stops serving groups while every private chat keeps working untouched.
    running.push(mismatched ? { ...alias, chats: [] } : alias);
    started += 1;
  }
  // Built from the COMPLETE file so suppression stays correct even during an incremental start.
  const fleet = fleetDirectory(config, identities);
  const pollers = running.map((alias) => new TelegramPoller({
    config: alias,
    botId: identities.get(alias.alias) ?? '',
    api: apis.get(alias.alias) as TelegramApi,
    repository,
    ingress,
    activity,
    fleet,
    participants: (chatId, threadId) => chatParticipants(config, chatId, threadId),
    ...(usernames.has(alias.alias) ? { botUsername: usernames.get(alias.alias) as string } : {}),
    onMetric: (metric) => metrics.increment(metric)
  }));
  const egress = new TelegramEgressWorker({
    repository,
    aliases: running,
    apis,
    activity,
    onMetric: (metric) => metrics.increment(metric)
  });
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await Promise.all([...pollers.map((poller) => poller.run(controller.signal)), egress.run(controller.signal)]);
} finally {
  controller.abort();
  activity.stop();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await pool.end();
}

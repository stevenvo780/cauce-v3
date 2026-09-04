import { integerEnv, logEvent, portEnv, requiredEnv, type LogField } from '@cauce/protocol';
import { CauceRepository, createPool } from '@cauce/store';
import { TelegramActivityIndicator } from './activity.js';
import {
  assertV2PollerDisabled, chatParticipants, fleetDirectory, fleetParticipationGaps,
  loadTelegramBridgeConfig, readTelegramToken
} from './config.js';
import { TelegramEgressWorker } from './egress.js';
import { startTelegramHealthServer, TelegramBridgeMetrics } from './health.js';
import { StoreTelegramIngress } from './ingress.js';
import { OPERATOR_BOT_COMMANDS } from './operator-commands/menu.js';
import { createStoreOperatorActions } from './operator-commands/store-actions.js';
import { TelegramPoller } from './poller.js';
import { PostgresTelegramBridgeRepository } from './repository.js';
import { boundedTelegramRequestTimeoutMs, TelegramBridgeProgress } from './progress.js';
import { TelegramHttpClient } from './telegram.js';
import { transcriptionConfig } from './transcription.js';
import type { TelegramAliasConfig, TelegramApi } from './types.js';

function selected(configs: readonly TelegramAliasConfig[]): TelegramAliasConfig[] {
  const selector = process.env.CAUCE_TELEGRAM_ALIASES;
  if (!selector) return [...configs];
  const names = new Set(selector.split(',').map((value) => value.trim()).filter(Boolean));
  const result = configs.filter((entry) => names.has(entry.alias));
  if (result.length !== names.size || result.length === 0) throw new Error('CAUCE_TELEGRAM_ALIASES contains an unknown alias');
  return result;
}

/**
 * Read BEFORE opening the pool: a malformed URL kills the process at startup instead of being
 * discovered only when someone sends a voice note. Absent = transcription off, which is the
 * behaviour the bridge has always had.
 */
const transcription = transcriptionConfig();
logEvent('telegram_transcription_config', {
  enabled: transcription !== undefined,
  ...(transcription === undefined ? {} : { model: transcription.model, language: transcription.language })
});

const pool = createPool(requiredEnv(process.env, 'DATABASE_URL'));
const store = new CauceRepository(pool);
const repository = new PostgresTelegramBridgeRepository(pool);
const ingress = new StoreTelegramIngress(store);
const operatorActions = createStoreOperatorActions(store, repository);
const metrics = new TelegramBridgeMetrics();
const progress = new TelegramBridgeProgress();
const controller = new AbortController();
const activity = new TelegramActivityIndicator();
const egressLeaseMs = integerEnv(process.env, 'CAUCE_TELEGRAM_EGRESS_LEASE_MS', { fallback: 90_000 });
if (egressLeaseMs < 10_000) throw new Error('CAUCE_TELEGRAM_EGRESS_LEASE_MS must be at least 10000');
const pollStaleMs = integerEnv(process.env, 'CAUCE_TELEGRAM_UPDATE_STALE_MS', { fallback: 180_000 });
const egressStaleMs = integerEnv(process.env, 'CAUCE_TELEGRAM_EGRESS_STALE_MS', { fallback: 180_000 });
let health: ReturnType<typeof startTelegramHealthServer> | undefined;

/**
 * A group-configuration problem is reported and degraded with a structured trace rather than halting the process.
 */
function degraded(reason: string, detail: Readonly<Record<string, LogField>>): void {
  metrics.increment('group_config_degraded');
  logEvent('telegram_group_config_degraded', { reason, ...detail });
}

try {
  const config = await loadTelegramBridgeConfig(requiredEnv(process.env, 'CAUCE_TELEGRAM_CONFIG_FILE'));
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
    // Every Telegram request must finish before both the poll lease and the egress lease lose
    // their fencing window. Long update processing is renewed separately by the poller.
    const requestTimeoutMs = boundedTelegramRequestTimeoutMs(alias.poll_lease_ms, egressLeaseMs);
    if (pollStaleMs < requestTimeoutMs + 5_000 || egressStaleMs < requestTimeoutMs + 5_000) {
      throw new Error('Telegram loop stale deadlines must exceed the total request deadline by 5000ms');
    }
    const api = new TelegramHttpClient({
      token: await readTelegramToken(alias.token_file), requestTimeoutMs
    });
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
    if (alias.operator_commands === true) {
      try {
        await api.setMyCommands(OPERATOR_BOT_COMMANDS, { type: 'all_private_chats' });
      } catch {
        degraded('operator_command_menu', { alias: alias.alias });
      }
    }
    progress.registerPoller(alias.alias, pollStaleMs);
  }
  progress.registerEgress(egressStaleMs);
  // Do not advertise a live endpoint while configuration, V2 exclusion, bot identity or cursor
  // binding is still incomplete. A connection refusal during startup is more truthful than a
  // green process-only healthcheck.
  health = startTelegramHealthServer(portEnv(process.env, 'PORT', 8084), pool, metrics, progress);
  // Built from the COMPLETE file so suppression stays correct even during an incremental start.
  const fleet = fleetDirectory(config, identities);
  const pollers = running.map((alias) => {
    const api = apis.get(alias.alias);
    if (api === undefined) {
      throw new Error(`Missing Telegram API instance for alias ${alias.alias}`);
    }
    const username = usernames.get(alias.alias);
    return new TelegramPoller({
      config: alias,
      botId: identities.get(alias.alias) ?? '',
      api,
      repository,
      ingress,
      activity,
      fleet,
      participants: (chatId, threadId) => chatParticipants(config, chatId, threadId),
      ...(username !== undefined ? { botUsername: username } : {}),
      ...(transcription === undefined ? {} : { transcription }),
      operatorActions,
      onMetric: (metric) => { metrics.increment(metric); },
      observer: progress
    });
  });
  const egress = new TelegramEgressWorker({
    repository,
    aliases: running,
    apis,
    activity,
    leaseMs: egressLeaseMs,
    onMetric: (metric) => { metrics.increment(metric); },
    observer: progress
  });
  const stop = (): void => { controller.abort(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await Promise.all([...pollers.map((poller) => poller.run(controller.signal)), egress.run(controller.signal)]);
} finally {
  controller.abort();
  activity.stop();
  if (health !== undefined) {
    const healthServer = health;
    await new Promise<void>((resolve) => { healthServer.close(() => { resolve(); }); });
  }
  await pool.end();
}

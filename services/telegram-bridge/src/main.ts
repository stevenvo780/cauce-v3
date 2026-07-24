import { CauceRepository, createPool } from '@cauce/store';
import { TelegramActivityIndicator } from './activity.js';
import { assertV2PollerDisabled, loadTelegramBridgeConfig, readTelegramToken } from './config.js';
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

try {
  const config = await loadTelegramBridgeConfig(required('CAUCE_TELEGRAM_CONFIG_FILE'));
  const aliases = selected(config.aliases);
  const apis = new Map<string, TelegramApi>();
  const pollers: TelegramPoller[] = [];
  for (const alias of aliases) {
    await assertV2PollerDisabled(alias);
    const api = new TelegramHttpClient({ token: await readTelegramToken(alias.token_file) });
    const identity = await api.getIdentity();
    await repository.initializeCursor(identity.id, alias.tenant_id, alias.alias);
    apis.set(alias.alias, api);
    pollers.push(new TelegramPoller({
      config: alias,
      botId: identity.id,
      api,
      repository,
      ingress,
      activity,
      onMetric: (metric) => metrics.increment(metric)
    }));
    started += 1;
  }
  const egress = new TelegramEgressWorker({
    repository,
    aliases,
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

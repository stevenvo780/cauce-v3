import { createPool } from '@cauce/store';
import {
  ShadowRouterMetrics, shutdownShadowIngressServer, startShadowIngressServer,
} from './http.js';
import { PostgresShadowRepository } from './repository.js';
import { ShadowRouter } from './router.js';
import { MapShadowTargetRegistry, UnixSocketShadowTarget } from './target.js';
import type { ShadowDirection, ShadowMode } from './types.js';
import { ShadowRouterWorker } from './worker.js';
import { ShadowRouterProgress } from './progress.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function mode(): { mode: ShadowMode; cutoverDirection?: ShadowDirection } {
  const configured = process.env.SHADOW_ROUTER_MODE ?? 'shadow';
  if (configured !== 'shadow' && configured !== 'compare' && configured !== 'cutover') {
    throw new Error('SHADOW_ROUTER_MODE is invalid');
  }
  if (configured !== 'cutover') {
    if (process.env.SHADOW_ROUTER_CUTOVER_DIRECTION || process.env.SHADOW_ROUTER_ENABLE_CUTOVER) {
      throw new Error('cutover settings are forbidden outside cutover mode');
    }
    return { mode: configured };
  }
  if (process.env.SHADOW_ROUTER_ENABLE_CUTOVER !== 'I_UNDERSTAND_ONE_ACTIVE_PATH') {
    throw new Error('cutover requires the explicit enable interlock');
  }
  const direction = process.env.SHADOW_ROUTER_CUTOVER_DIRECTION;
  if (direction !== 'v2-to-v3' && direction !== 'v3-to-v2') throw new Error('cutover direction is invalid');
  return { mode: configured, cutoverDirection: direction };
}

function tenants(): Set<string> {
  const result = new Set(required('SHADOW_ROUTER_TENANTS').split(',').map((value) => value.trim()).filter(Boolean));
  if (result.size === 0) throw new Error('SHADOW_ROUTER_TENANTS must not be empty');
  return result;
}

function healthStaleMs(): number {
  const value = Number(process.env.SHADOW_ROUTER_HEALTH_STALE_MS ?? 30_000);
  if (!Number.isSafeInteger(value) || value < 20_000) {
    throw new Error('SHADOW_ROUTER_HEALTH_STALE_MS must be an integer of at least 20000');
  }
  return value;
}

function shutdownMs(): number {
  const value = Number(process.env.SHADOW_ROUTER_SHUTDOWN_MS ?? 5_000);
  if (!Number.isSafeInteger(value) || value < 2_000 || value > 60_000) {
    throw new Error('SHADOW_ROUTER_SHUTDOWN_MS must be an integer between 2000 and 60000');
  }
  return value;
}

const selected = mode();
const allowedTenants = tenants();
const healthStalenessMs = healthStaleMs();
const shutdownBudgetMs = shutdownMs();
const databaseUrl = required('DATABASE_URL');
const ingressSocket = required('SHADOW_ROUTER_SOCKET');
const v2Socket = required('SHADOW_ROUTER_V2_SOCKET');
const v3Socket = required('SHADOW_ROUTER_V3_SOCKET');
const metrics = new ShadowRouterMetrics();
const progress = new ShadowRouterProgress(healthStalenessMs);
const controller = new AbortController();
let stopping = false;
let shutdownWatchdog: NodeJS.Timeout | undefined;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  progress.stopping();
  controller.abort(new Error('shadow router stopping'));
  shutdownWatchdog = setTimeout(() => {
    console.error(JSON.stringify({ event: 'shadow_router_shutdown_timeout' }));
    process.exit(1);
  }, shutdownBudgetMs);
  shutdownWatchdog.unref();
};
// Install handlers before allocating the pool/listener. A SIGTERM during startup must not leave a
// stale Unix socket or skip the same bounded pool teardown used in steady state.
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

const pool = createPool(databaseUrl);
const repository = new PostgresShadowRepository(pool);
const targets = new MapShadowTargetRegistry([
  ['v2-to-v3', new UnixSocketShadowTarget(v3Socket)],
  ['v3-to-v2', new UnixSocketShadowTarget(v2Socket)]
]);
const router = new ShadowRouter({
  ...selected,
  allowedTenants,
  repository,
  targets,
  onMetric: (metric) => metrics.increment(metric)
});
const worker = new ShadowRouterWorker({
  repository,
  router,
  progress,
  onLoopError: (reason) => console.error(JSON.stringify({ event: 'shadow_router_loop_error', reason })),
});
let server: Awaited<ReturnType<typeof startShadowIngressServer>> | undefined;

try {
  server = await startShadowIngressServer({
    socketPath: ingressSocket,
    mode: selected.mode,
    allowedTenants,
    repository,
    metrics,
    progress,
    signal: controller.signal,
  });
  await worker.run(controller.signal);
} finally {
  stop();
  try {
    if (server) await shutdownShadowIngressServer(server);
    await pool.end();
  } finally {
    if (shutdownWatchdog) clearTimeout(shutdownWatchdog);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

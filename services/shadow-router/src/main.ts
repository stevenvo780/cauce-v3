import { createPool } from '@cauce/store';
import { ShadowRouterMetrics, startShadowIngressServer } from './http.js';
import { PostgresShadowRepository } from './repository.js';
import { ShadowRouter } from './router.js';
import { MapShadowTargetRegistry, UnixSocketShadowTarget } from './target.js';
import type { ShadowDirection, ShadowMode } from './types.js';
import { ShadowRouterWorker } from './worker.js';

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

const selected = mode();
const allowedTenants = tenants();
const pool = createPool(required('DATABASE_URL'));
const repository = new PostgresShadowRepository(pool);
const metrics = new ShadowRouterMetrics();
const targets = new MapShadowTargetRegistry([
  ['v2-to-v3', new UnixSocketShadowTarget(required('SHADOW_ROUTER_V3_SOCKET'))],
  ['v3-to-v2', new UnixSocketShadowTarget(required('SHADOW_ROUTER_V2_SOCKET'))]
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
  onMetric: (metric) => metrics.increment(metric)
});
const server = await startShadowIngressServer({
  socketPath: required('SHADOW_ROUTER_SOCKET'),
  mode: selected.mode,
  allowedTenants,
  repository,
  pool,
  metrics
});
const controller = new AbortController();
const stop = (): void => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  await worker.run(controller.signal);
} finally {
  controller.abort();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
}

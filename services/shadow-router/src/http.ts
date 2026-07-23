import { chmod, lstat, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, isAbsolute } from 'node:path';
import type { DatabasePool } from '@cauce/store';
import { parseShadowEnvelope } from './router.js';
import type {
  ShadowDirection, ShadowInboxRepository, ShadowMetric, ShadowMode
} from './types.js';

const METRICS: readonly ShadowMetric[] = [
  'ingress_accepted', 'ingress_duplicate', 'ingress_denied', 'shadowed',
  'compared_match', 'compared_mismatch', 'cutover_delivered', 'human_reply_blocked', 'failed'
];

export class ShadowRouterMetrics {
  private readonly counters = new Map<ShadowMetric, number>();

  increment(metric: ShadowMetric): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }

  render(): string {
    return `${[
      '# HELP cauce_shadow_router_events_total Shadow router outcomes without identifying labels.',
      '# TYPE cauce_shadow_router_events_total counter',
      ...METRICS.map((metric) =>
        `cauce_shadow_router_events_total{result="${metric}"} ${this.counters.get(metric) ?? 0}`)
    ].join('\n')}\n`;
  }
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 262_144) throw new Error('request body exceeds limit');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

export interface ShadowIngressServerOptions {
  socketPath: string;
  mode: ShadowMode;
  allowedTenants: ReadonlySet<string>;
  repository: ShadowInboxRepository;
  pool: DatabasePool;
  metrics: ShadowRouterMetrics;
}

async function assertSocketPath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('shadow router socket path must be absolute');
  const parent = await stat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
    throw new Error('shadow router socket parent must be a private directory');
  }
  try {
    await lstat(path);
    throw new Error('shadow router socket already exists');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export async function startShadowIngressServer(options: ShadowIngressServerOptions): Promise<Server> {
  await assertSocketPath(options.socketPath);
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health/live') {
        json(response, 200, { status: 'live', mode: options.mode });
        return;
      }
      if (request.method === 'GET' && request.url === '/health/ready') {
        try {
          await options.pool.query('SELECT 1');
          json(response, 200, { status: 'ready', mode: options.mode });
        } catch {
          json(response, 503, { status: 'not_ready' });
        }
        return;
      }
      if (request.method === 'GET' && request.url === '/metrics') {
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(options.metrics.render());
        return;
      }
      const expected: ShadowDirection | undefined = request.url === '/ingress/v2'
        ? 'v2-to-v3' : request.url === '/ingress/v3' ? 'v3-to-v2' : undefined;
      if (request.method !== 'POST' || !expected) {
        response.writeHead(404).end();
        return;
      }
      if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
        options.metrics.increment('ingress_denied');
        json(response, 415, { error: 'content_type_required' });
        return;
      }
      const envelope = parseShadowEnvelope(await body(request), expected);
      if (!options.allowedTenants.has(envelope.tenant_id)) {
        options.metrics.increment('ingress_denied');
        json(response, 403, { error: 'tenant_denied' });
        return;
      }
      const result = await options.repository.enqueue(envelope, options.mode);
      options.metrics.increment(result.duplicate ? 'ingress_duplicate' : 'ingress_accepted');
      json(response, result.duplicate ? 200 : 202, result);
    } catch {
      options.metrics.increment('ingress_denied');
      json(response, 400, { error: 'invalid_request' });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(options.socketPath, 0o600);
  server.once('close', () => { void unlink(options.socketPath).catch(() => undefined); });
  return server;
}

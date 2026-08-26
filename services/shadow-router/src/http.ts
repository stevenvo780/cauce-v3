import { chmod, lstat, stat, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, isAbsolute } from 'node:path';
import { parseShadowEnvelope } from './router.js';
import { ShadowInboxIdempotencyConflictError } from './errors.js';
import type {
  ShadowDirection, ShadowInboxRepository, ShadowMetric, ShadowMode
} from './types.js';
import type { ShadowRouterProgress } from './progress.js';

const METRICS: readonly ShadowMetric[] = [
  'ingress_accepted', 'ingress_duplicate', 'ingress_denied', 'ingress_conflict', 'shadowed',
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

async function body(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    signal.throwIfAborted();
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > 262_144) throw new Error('request body exceeds limit');
    chunks.push(bytes);
  }
  signal.throwIfAborted();
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function json(response: ServerResponse, status: number, value: Record<string, unknown>): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
}

export interface ShadowIngressServerOptions {
  socketPath: string;
  mode: ShadowMode;
  allowedTenants: ReadonlySet<string>;
  repository: ShadowInboxRepository;
  metrics: ShadowRouterMetrics;
  progress: ShadowRouterProgress;
  signal?: AbortSignal;
}

const shutdowns = new WeakMap<Server, () => Promise<void>>();

/** Stop accepting work immediately, terminate active HTTP streams and wait for socket closure. */
export function shutdownShadowIngressServer(server: Server): Promise<void> {
  const shutdown = shutdowns.get(server);
  if (shutdown) return shutdown();
  if (!server.listening) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
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
    const requestController = new AbortController();
    const abortRequest = (): void => requestController.abort(new Error('shadow ingress request closed'));
    request.once('aborted', abortRequest);
    const abortUnfinishedResponse = (): void => {
      if (!response.writableEnded) abortRequest();
    };
    response.once('close', abortUnfinishedResponse);
    const signal = options.signal === undefined
      ? requestController.signal
      : AbortSignal.any([options.signal, requestController.signal]);
    try {
      if (request.method === 'GET' && request.url === '/health/live') {
        const progress = options.progress.snapshot();
        json(response, progress.live ? 200 : 503, {
          status: progress.live ? 'live' : 'not_live', mode: options.mode, reason: progress.reason,
        });
        return;
      }
      if (request.method === 'GET' && request.url === '/health/ready') {
        try {
          const inbox = await options.repository.health(signal);
          const progress = options.progress.snapshot();
          const reason = inbox.dead > 0
            ? 'dead_inbox'
            : inbox.failed > 0
              ? 'retry_backlog'
              : inbox.orphaned_processing > 0 ? 'orphaned_processing' : progress.reason;
          const ready = reason === 'ready';
          json(response, ready ? 200 : 503, {
            status: ready ? 'ready' : 'not_ready', mode: options.mode, reason,
            inbox,
          });
        } catch {
          if (signal.aborted) return;
          json(response, 503, { status: 'not_ready', reason: 'database' });
        }
        return;
      }
      if (request.method === 'GET' && request.url === '/metrics') {
        try {
          const inbox = await options.repository.health(signal);
          const backlog = [
            '# HELP cauce_shadow_router_inbox Current durable inbox rows by non-terminal status.',
            '# TYPE cauce_shadow_router_inbox gauge',
            `cauce_shadow_router_inbox{status="pending"} ${inbox.pending}`,
            `cauce_shadow_router_inbox{status="failed"} ${inbox.failed}`,
            `cauce_shadow_router_inbox{status="dead"} ${inbox.dead}`,
            `cauce_shadow_router_inbox{status="processing"} ${inbox.processing}`,
            '# HELP cauce_shadow_router_processing_owned Current processing rows owned by this boot.',
            '# TYPE cauce_shadow_router_processing_owned gauge',
            `cauce_shadow_router_processing_owned{ownership="local"} ${inbox.owned_processing}`,
            `cauce_shadow_router_processing_owned{ownership="orphaned"} ${inbox.orphaned_processing}`,
            '# HELP cauce_shadow_router_oldest_ready_seconds Age of the oldest currently claimable inbox row.',
            '# TYPE cauce_shadow_router_oldest_ready_seconds gauge',
            `cauce_shadow_router_oldest_ready_seconds ${inbox.oldest_ready_seconds}`,
            '',
          ].join('\n');
          response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
            .end(`${options.metrics.render()}${options.progress.renderMetrics()}${backlog}`);
        } catch {
          if (signal.aborted) return;
          response.writeHead(503, { 'content-type': 'text/plain; version=0.0.4' })
            .end(`${options.metrics.render()}${options.progress.renderMetrics()}`);
        }
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
      let envelope: ReturnType<typeof parseShadowEnvelope>;
      try {
        envelope = parseShadowEnvelope(await body(request, signal), expected);
      } catch {
        if (signal.aborted) return;
        options.metrics.increment('ingress_denied');
        json(response, 400, { error: 'invalid_request' });
        return;
      }
      if (!options.allowedTenants.has(envelope.tenant_id)) {
        options.metrics.increment('ingress_denied');
        json(response, 403, { error: 'tenant_denied' });
        return;
      }
      let result: { id: string; duplicate: boolean };
      try {
        result = await options.repository.enqueue(envelope, options.mode, signal);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ShadowInboxIdempotencyConflictError) {
          options.metrics.increment('ingress_conflict');
          json(response, 409, { error: 'idempotency_conflict' });
          return;
        }
        // Un 4xx hace que el productor descarte un evento que la base nunca guardó. Un fallo
        // del inbox es transitorio y tiene que conservar la obligación de reintento extremo a
        // extremo; el cuerpo no revela SQL ni datos de la entrega.
        options.metrics.increment('failed');
        json(response, 503, { error: 'temporarily_unavailable' });
        return;
      }
      options.metrics.increment(result.duplicate ? 'ingress_duplicate' : 'ingress_accepted');
      json(response, result.duplicate ? 200 : 202, result);
    } catch {
      if (signal.aborted) return;
      options.metrics.increment('failed');
      json(response, 500, { error: 'internal_error' });
    } finally {
      request.off('aborted', abortRequest);
      response.off('close', abortUnfinishedResponse);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.once('close', () => { void unlink(options.socketPath).catch(() => undefined); });
  let closing: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    closing ??= new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      // close() alone waits indefinitely for a client or a health response that never completes.
      server.closeAllConnections();
    });
    return closing;
  };
  shutdowns.set(server, shutdown);
  const onAbort = (): void => { void shutdown().catch(() => undefined); };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  server.once('close', () => {
    options.signal?.removeEventListener('abort', onAbort);
    shutdowns.delete(server);
  });
  try {
    await chmod(options.socketPath, 0o600);
  } catch (error) {
    await shutdown().catch(() => undefined);
    throw error;
  }
  if (options.signal?.aborted) onAbort();
  return server;
}

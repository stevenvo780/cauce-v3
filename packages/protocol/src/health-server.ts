import { createServer, type Server, type ServerResponse } from 'node:http';

/**
 * Probe answer. `body` is published verbatim: every service exposes a different set of fields and
 * scrapers and runbooks read them, so this module decides the status code and the headers only.
 */
export interface HealthAnswer {
  readonly ok: boolean;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  live(): HealthAnswer | Promise<HealthAnswer>;
  ready(): HealthAnswer | Promise<HealthAnswer>;
  /** `/metrics` exists only for services that supply this. */
  metrics?(): string | Promise<string>;
  readonly metricsContentType?: string;
}

const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
): void {
  send(response, status, 'application/json; charset=utf-8', `${JSON.stringify(body)}\n`);
}

function send(response: ServerResponse, status: number, contentType: string, text: string): void {
  const payload = Buffer.from(text, 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(payload.byteLength),
    'content-type': contentType,
  });
  response.end(payload);
}

async function route(
  options: HealthServerOptions,
  path: string,
  response: ServerResponse,
): Promise<void> {
  if (path === '/health/live') {
    const answer = await options.live();
    sendJson(response, answer.ok ? 200 : 503, answer.body);
    return;
  }
  if (path === '/health/ready') {
    const answer = await options.ready();
    sendJson(response, answer.ok ? 200 : 503, answer.body);
    return;
  }
  if (path === '/metrics' && options.metrics !== undefined) {
    send(response, 200, options.metricsContentType ?? METRICS_CONTENT_TYPE, await options.metrics());
    return;
  }
  sendJson(response, 404, { status: 'not_found' });
}

/**
 * A probe that throws must not take the socket or the process down with it: the answer is the
 * unavailable one, which is also what a scraper should read from a service whose probe is broken.
 */
export function startHealthServer(options: HealthServerOptions): Server {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') {
      sendJson(response, 405, { status: 'method_not_allowed' });
      return;
    }
    const path = (request.url ?? '/').split('?', 1)[0] ?? '/';
    void route(options, path, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, 503, { status: 'probe_failed' });
    });
  });
  server.listen(options.port, options.host ?? '0.0.0.0');
  return server;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Renders one label-free counter family. Every series that must be scraped has to be a key of
 * `counters`, zeros included: a counter that disappears while it is zero breaks `rate()`.
 */
export function renderCounters(
  name: string,
  help: string,
  counters: ReadonlyMap<string, number>,
): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const [result, value] of counters) {
    lines.push(`${name}{result="${escapeLabel(result)}"} ${String(value)}`);
  }
  return `${lines.join('\n')}\n`;
}

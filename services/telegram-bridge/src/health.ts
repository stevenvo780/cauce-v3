import { createServer, type Server } from 'node:http';
import type { DatabasePool } from '@cauce/store';
import type { BridgeMetric } from './types.js';

const METRICS: readonly BridgeMetric[] = [
  'updates_allowed', 'updates_denied', 'updates_duplicate', 'poll_fenced',
  'egress_sent', 'egress_retry', 'egress_dead', 'egress_ambiguous'
];

export class TelegramBridgeMetrics {
  private readonly counters = new Map<BridgeMetric, number>();

  increment(metric: BridgeMetric): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      '# HELP cauce_telegram_bridge_events_total Telegram bridge outcomes without identifying labels.',
      '# TYPE cauce_telegram_bridge_events_total counter'
    ];
    for (const metric of METRICS) {
      lines.push(`cauce_telegram_bridge_events_total{result="${metric}"} ${this.counters.get(metric) ?? 0}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function startTelegramHealthServer(
  port: number,
  pool: DatabasePool,
  metrics: TelegramBridgeMetrics,
  startedAliases: () => number
): Server {
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"live"}');
      return;
    }
    if (request.url === '/health/ready') {
      try {
        await pool.query('SELECT 1');
        const ready = startedAliases() > 0;
        response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', aliases: startedAliases() }));
      } catch {
        response.writeHead(503, { 'content-type': 'application/json' }).end('{"status":"not_ready"}');
      }
      return;
    }
    if (request.url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(metrics.render());
      return;
    }
    response.writeHead(404).end();
  });
  server.listen(port, '127.0.0.1');
  return server;
}

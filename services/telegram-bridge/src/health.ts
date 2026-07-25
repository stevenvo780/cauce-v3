import { createServer, type Server } from 'node:http';
import type { DatabasePool } from '@cauce/store';
import type { BridgeMetric } from './types.js';

// `updates_denied` keeps its original meaning (hard ACL denial) so its time series stays
// comparable; ordinary group suppression gets its own counters instead of inflating it.
//
// The split matters because none of these counters carry labels: without it, the healthy
// "a peer was named, stay quiet" path (`updates_echo_suppressed`) is indistinguishable from the
// two that mean the deployment is wrong — a group that has no config yet
// (`updates_chat_denied`) and a mention nobody in the room can serve
// (`updates_mention_unserved`). `group_config_degraded` counts boot-time group config problems
// that were downgraded from fatal so the DMs keep running.
const METRICS: readonly BridgeMetric[] = [
  'updates_allowed', 'updates_denied', 'updates_duplicate', 'poll_fenced',
  'updates_unaddressed', 'updates_echo_suppressed', 'updates_mention_unserved',
  'updates_suppressed_bot', 'updates_via_bot',
  'updates_chat_denied', 'updates_chat_disabled', 'updates_conflict',
  'group_config_degraded',
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

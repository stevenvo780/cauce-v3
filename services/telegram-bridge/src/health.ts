import type { Server } from 'node:http';
import { renderCounters, startHealthServer } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import type { BridgeMetric } from './types.js';
import type { TelegramBridgeProgress } from './progress.js';

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
  'updates_allowed', 'updates_denied', 'updates_duplicate', 'poll_fenced', 'poll_error',
  'updates_unaddressed', 'updates_echo_suppressed', 'updates_mention_unserved',
  'updates_suppressed_bot', 'updates_via_bot',
  'updates_chat_denied', 'updates_chat_disabled', 'updates_conflict',
  'updates_kind_suppressed',
  'group_config_degraded',
  'egress_sent', 'egress_retry', 'egress_dead', 'egress_ambiguous', 'egress_fenced',
  'egress_loop_error',
  'egress_format_downgraded',
  'egress_attachment_uploaded', 'egress_attachment_listed', 'egress_attachment_upload_failed',
  'ingress_secret_redacted'
];

const METRIC_NAME = 'cauce_telegram_bridge_events_total';
const METRIC_HELP = 'Telegram bridge outcomes without identifying labels.';

export class TelegramBridgeMetrics {
  private readonly counters = new Map<BridgeMetric, number>(METRICS.map((metric) => [metric, 0]));

  increment(metric: BridgeMetric): void {
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + 1);
  }

  render(): string {
    return renderCounters(METRIC_NAME, METRIC_HELP, this.counters);
  }
}

export function startTelegramHealthServer(
  port: number,
  pool: DatabasePool,
  metrics: TelegramBridgeMetrics,
  progress: TelegramBridgeProgress
): Server {
  return startHealthServer({
    port,
    // The service has no published host port; binding the internal backend interface is required
    // for Prometheus in its sibling container to scrape it. Docker's own health probe still uses
    // 127.0.0.1 from inside this container.
    host: '0.0.0.0',
    live: () => {
      const state = progress.snapshot();
      return {
        ok: state.live,
        body: {
          status: state.live ? 'live' : 'not_live', reason: state.reason,
          pollers: state.pollers, stale_pollers: state.stale_pollers,
          fenced_pollers: state.fenced_pollers, egress_stale: state.egress_stale,
          egress_fenced: state.egress_fenced
        }
      };
    },
    ready: async () => {
      try {
        await pool.query('SELECT 1');
      } catch {
        return { ok: false, body: { status: 'not_ready', reason: 'database' } };
      }
      const state = progress.snapshot();
      return {
        ok: state.ready,
        body: {
          status: state.ready ? 'ready' : 'not_ready', reason: state.reason,
          aliases: state.pollers, healthy_aliases: state.healthy_pollers,
          egress_configured: state.egress_configured
        }
      };
    },
    metrics: () => `${metrics.render()}${progress.renderMetrics()}`
  });
}

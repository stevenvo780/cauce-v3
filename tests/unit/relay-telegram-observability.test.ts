import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('relay and Telegram observability wiring', () => {
  const prometheus = readFileSync('ops/observability/prometheus.yaml', 'utf8');
  const alerts = readFileSync('ops/observability/alerts.yaml', 'utf8');

  it('discovers optional profiles instead of creating down targets when the profile is absent', () => {
    expect(prometheus).toMatch(/job_name: cauce-origin-relay[\s\S]*?dns_sd_configs:[\s\S]*?names: \[relay-worker\]/u);
    expect(prometheus).toMatch(/job_name: cauce-telegram[\s\S]*?dns_sd_configs:[\s\S]*?names: \[telegram-bridge\]/u);
    expect(prometheus).not.toMatch(/job_name: cauce-origin-relay[\s\S]*?static_configs:[\s\S]*?relay-worker/u);
  });

  it('alerts on discovered targets, stale loops and fenced durable ACKs', () => {
    for (const alert of [
      'CauceDispatcherLoopStale', 'CauceDispatcherUnready', 'CauceDispatcherFencedCompletion',
      'CauceOriginRelayTargetDown', 'CauceOriginRelayLoopStale', 'CauceOriginRelayFencedAck',
      'CauceTelegramTargetDown', 'CauceTelegramPollerStale', 'CauceTelegramEgressStale',
      'CauceTelegramFencedAck', 'CauceTelegramLoopErrors'
    ]) expect(alerts).toContain(`alert: ${alert}`);
    for (const job of ['cauce-dispatcher', 'cauce-origin-relay', 'cauce-telegram', 'cauce-outbox']) {
      expect(alerts).toContain(`absent(up{job="${job}"})`);
    }
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('relay and Telegram observability wiring', () => {
  const prometheus = readFileSync('ops/observability/prometheus.yaml', 'utf8');
  const alerts = readFileSync('ops/observability/alerts.yaml', 'utf8');
  const alertmanager = readFileSync('ops/observability/alertmanager.yaml', 'utf8');

  it('discovers optional profiles instead of creating down targets when the profile is absent', () => {
    // relay-worker was retired to _legado (canonical compose FASE 3): its job must not exist.
    expect(prometheus).not.toMatch(/job_name: cauce-origin-relay/u);
    expect(prometheus).not.toMatch(/relay-worker/u);
    expect(prometheus).toMatch(/job_name: cauce-telegram[\s\S]*?dns_sd_configs:[\s\S]*?names: \[telegram-bridge\]/u);
  });

  it('alerts only on scrape targets and metrics that have canonical producers', () => {
    for (const alert of [
      'CauceDispatcherLoopStale', 'CauceDispatcherUnready', 'CauceDispatcherFencedCompletion',
      'CauceOriginRelayFailed', 'CauceOriginRelayStalled',
      'CauceTelegramTargetDown', 'CauceTelegramPollerStale', 'CauceTelegramEgressStale',
      'CauceTelegramFencedAck', 'CauceTelegramLoopErrors'
    ]) expect(alerts).toContain(`alert: ${alert}`);
    for (const job of ['cauce-dispatcher', 'cauce-telegram', 'cauce-outbox']) {
      expect(alerts).toContain(`absent(up{job="${job}"})`);
    }
    expect(alerts).not.toContain('absent(up{job="cauce-origin-relay"})');
    expect(alerts).not.toContain('cauce_origin_relay_');
    for (const retired of [
      'CauceOriginRelayTargetDown', 'CauceOriginRelayLoopStale',
      'CauceOriginRelayFencedAck', 'CauceOriginRelayDead',
    ]) {
      expect(alerts).not.toContain(retired);
      expect(alertmanager).not.toContain(retired);
    }
  });

  it('every Alertmanager inhibition references a declared alert', () => {
    const declared = new Set([...alerts.matchAll(/^\s+- alert: ([A-Za-z0-9_]+)$/gmu)]
      .map((match) => match[1]));
    const inhibited = [...alertmanager.matchAll(/alertname(?:=~|=)"([A-Za-z0-9_|]+)"/gu)]
      .flatMap((match) => match[1]?.split('|') ?? []);
    expect(inhibited.length).toBeGreaterThan(0);
    expect(inhibited.filter((name) => !declared.has(name))).toEqual([]);
  });

  it('CONTROL NEGATIVO — quitar una alerta del YAML hace fallar la verificación de presencia', () => {
    const sinAlerta = alerts.replace(
      / {6}- alert: CauceDispatcherLoopStale\n[\s\S]*?(?=\n {6}- alert:|\n {2}- name:|$)/u,
      '',
    );
    expect(sinAlerta).not.toBe(alerts);
    expect(sinAlerta).not.toContain('alert: CauceDispatcherLoopStale');
  });
});

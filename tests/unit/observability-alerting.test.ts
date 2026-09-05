import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('production alert delivery is observable and identity-safe', () => {
  it('self-scrapes Prometheus and has no Alertmanager wiring left', async () => {
    const config = await readFile(resolve(root, 'ops/observability/prometheus.yaml'), 'utf8');
    expect(config).toContain('job_name: cauce-prometheus');
    expect(config).toContain('targets: [127.0.0.1:9090]');
    expect(config).not.toContain('alerting:');
    expect(config).not.toContain('alertmanager');
  });

  // Alertmanager was decided against; the delivery-group alerts must not creep back.
  it('CONTROL NEGATIVO — the retired delivery-group alerts stay gone', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    for (const name of [
      'CauceAlertmanagerDown',
      'CauceAlertDeliveryErrors',
      'CauceAlertDeliveryDropped',
      'CauceAlertDeliveryQueueSaturated',
    ]) expect(rules).not.toContain(`alert: ${name}`);
    expect(rules).not.toContain('prometheus_notifications_errors_total');
    expect(rules).not.toContain('prometheus_notifications_dropped_total');
  });

  it('scrapes the internal gateway pump and alerts on stale, fenced or failed progress', async () => {
    const config = await readFile(resolve(root, 'ops/observability/prometheus.yaml'), 'utf8');
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    const compose = await readFile(resolve(root, 'deploy/compose.yaml'), 'utf8');
    expect(config).toContain('job_name: cauce-gateway');
    expect(config).toContain('targets: [gateway:8081]');
    const gateway = compose.slice(compose.indexOf('\n  gateway:'), compose.indexOf('\n  terminal-relay:'));
    const gatewayPorts = gateway.slice(gateway.indexOf('\n    ports:'), gateway.indexOf('\n    healthcheck:'));
    expect(gatewayPorts).toContain('${GATEWAY_TLS_PORT:-8443}:8443');
    expect(gatewayPorts).not.toContain('8081');
    for (const name of [
      'CauceGatewayMetricsDown',
      'CauceGatewayWakePumpStale',
      'CauceGatewayWakePumpFenced',
      'CauceGatewayWakePumpErrors',
    ]) expect(rules).toContain(`alert: ${name}`);
    expect(rules).toContain('cauce_gateway_wake_pump_last_success_timestamp_seconds');
    expect(rules).toContain('cauce_gateway_wake_pump_outcomes_total{result="fenced"}');
  });

  it('alerts on bounded console journal pressure without identity-bearing labels', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    expect(rules).toContain('alert: CauceConsolePublishIntentRateLimited');
    expect(rules).toContain('alert: CauceConsolePublishIntentExpiryBurst');
    expect(rules).toContain('operation="prepare",result="rate_limited"');
    expect(rules).toContain('operation="publish",result="expired"');
    expect(rules).not.toMatch(/cauce_gateway_console_publish_operations_total\{[^}]*tenant/u);
    expect(rules).not.toMatch(/cauce_gateway_console_publish_operations_total\{[^}]*alias/u);
  });

  it('alerts once on degraded or stale profile runtime facts before a governed reload', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    const name = 'CauceProfileRuntimeExpectationsDegraded';
    const start = rules.indexOf(`      - alert: ${name}`);
    const end = rules.indexOf('\n      - alert:', start + 1);
    const rule = rules.slice(start, end < 0 ? undefined : end);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(rules.match(new RegExp(`alert: ${name}`, 'gu'))).toHaveLength(1);
    expect(rule).toContain('max({__name__=~"cauce_gateway_profile_runtime_expectations_(degraded|stale)"}) > 0');
    expect(rule).toContain('for: 5m');
    expect(rule).toContain('severity: warning');
    expect(rule).toContain('Review measured runtime facts before requesting a governed profile reload');
    expect(rule).not.toMatch(/tenant|alias|operator|session/u);
  });

  it('pages only actionable DLQ growth and detects stale or unclassified incidents', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    for (const name of [
      'CauceOriginOutboxDeadLetterNew',
      'CauceWakeOutboxDeadLetterNew',
      'CauceOutboxDlqClassificationMetricsMissing',
      'CauceOutboxDlqUnclassified',
      'CauceOriginOutboxDlqActionableStale',
      'CauceWakeOutboxDlqActionableStale',
    ]) expect(rules).toContain(`alert: ${name}`);
    expect(rules).toContain('cauce_outbox_dead_letters_new{kind="origin_relay",actionable="true"}');
    expect(rules).toContain('sum(cauce_outbox_dead_letters_unclassified) > 0');
    expect(rules).not.toMatch(/cauce_outbox_dead_letters_new\{kind="(?:wake|origin_relay)"\}\s*>/u);
  });

  it('reports queue age without mistaking scheduled or capacity-bound work for a stalled loop', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    const cases = [
      ['InteractiveDelivery', 'max(cauce_dispatcher_delivery_oldest_seconds{lane="interactive",status=~"pending|retry"}) > 60', '5m'],
      ['BatchDelivery', 'max(cauce_dispatcher_delivery_oldest_seconds{lane="batch",status=~"pending|retry"}) > 300', '10m'],
      ['JobLane', 'max by (lane) (cauce_dispatcher_job_oldest_seconds{status="queued"}) > 300', '10m'],
    ] as const;
    for (const [name, expression, duration] of cases) {
      const start = rules.indexOf(`      - alert: Cauce${name}BacklogAgeHigh`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = rules.indexOf('\n      - alert:', start + 1);
      const rule = rules.slice(start, end < 0 ? undefined : end);
      expect(rule).toContain(`expr: ${expression}`);
      expect(rule).toContain(`for: ${duration}`);
      expect(rule).toContain('severity: warning');
      expect(rule).toContain('have been waiting');
      expect(rules).not.toContain(`alert: Cauce${name}Stalled`);
    }
    expect(rules).toContain('alert: CauceDispatcherLoopStale');
    expect(rules).toContain('expr: absent(cauce_dispatcher_loop_stale) or cauce_dispatcher_loop_stale == 1');
  });

  it('fails loudly on unknown release state and keeps the rollback bridge visibly degraded', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    for (const name of [
      'CauceReleaseStateMissing',
      'CauceRollbackBridgeDegraded',
      'CauceReleaseWriterCountMismatch',
      'CauceRollbackBridgeWriterActive',
    ]) expect(rules).toContain(`alert: ${name}`);
    expect(rules).toContain('absent(cauce_release_state_valid) or cauce_release_state_valid != 1');
    expect(rules).toContain('cauce_release_rollback_bridge_degraded == 1');
    expect(rules).toContain('cauce_release_writers_declared != cauce_release_writers_expected');
    expect(rules).toContain('cauce_release_writer_leases_active != 0');
  });
});

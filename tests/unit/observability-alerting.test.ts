import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');

describe('production alert delivery is observable and identity-safe', () => {
  it('self-scrapes Prometheus and checks the real Alertmanager target', async () => {
    const config = await readFile(resolve(root, 'ops/observability/prometheus.yaml'), 'utf8');
    expect(config).toContain('job_name: cauce-prometheus');
    expect(config).toContain('targets: [127.0.0.1:9090]');
    expect(config).toContain('job_name: cauce-alertmanager');
    expect(config).toContain('targets: [alertmanager:9093]');
  });

  it('alerts on target failure, notification errors, drops and queue saturation', async () => {
    const rules = await readFile(resolve(root, 'ops/observability/alerts.yaml'), 'utf8');
    for (const name of [
      'CauceAlertmanagerDown',
      'CauceAlertDeliveryErrors',
      'CauceAlertDeliveryDropped',
      'CauceAlertDeliveryQueueSaturated',
    ]) expect(rules).toContain(`alert: ${name}`);
    expect(rules).toContain('prometheus_notifications_errors_total');
    expect(rules).toContain('prometheus_notifications_dropped_total');
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
    const alertmanager = await readFile(resolve(root, 'ops/observability/alertmanager.yaml'), 'utf8');
    expect(alertmanager).toContain('alertname="CauceGatewayMetricsDown"');
    expect(alertmanager).toContain('CauceGatewayWakePumpStale|CauceGatewayWakePumpFenced');
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
    expect(rules).toContain('cauce_outbox_dead_letters_open_by_disposition{actionable="true",disposition="unclassified"}');
    expect(rules).not.toMatch(/cauce_outbox_dead_letters_new\{kind="(?:wake|origin_relay)"\}\s*>/u);
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

  it('keeps the operational destination out of the tracked config', async () => {
    const template = await readFile(resolve(root, 'ops/observability/alertmanager.yaml'), 'utf8');
    expect(template).toContain('chat_id_file: /run/secrets/alertmanager_telegram_chat_id');
    expect(template).not.toMatch(/^\s*chat_id:/m);
    const overlay = await readFile(resolve(root, 'deploy/compose.alertmanager.yaml'), 'utf8');
    expect(overlay).toContain('CAUCE_ALERTMANAGER_CONFIG_PATH');
    expect(overlay).toContain('CAUCE_ALERTMANAGER_TELEGRAM_CHAT_ID_PATH');
    expect(overlay).not.toContain('../ops/observability/alertmanager.yaml:');
    expect(overlay.match(/target: \/alertmanager$/gm)).toHaveLength(1);
    expect(template).not.toContain('telegram-steven');
    expect(template).toContain('CauceOutboxDlqClassificationMetricsMissing');
    expect(template).toContain('CauceOriginOutboxDlqActionableStale');
  });
});

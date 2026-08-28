import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { DatabasePool } from '@cauce/store';
import { afterEach, describe, expect, it } from 'vitest';
import { startTelegramHealthServer, TelegramBridgeMetrics } from '../src/health.js';
import { boundedTelegramRequestTimeoutMs, TelegramBridgeProgress } from '../src/progress.js';

describe('TelegramBridgeProgress', () => {
  it('bounds every HTTP request below both poll and egress leases', () => {
    expect(boundedTelegramRequestTimeoutMs(60_000, 90_000)).toBe(55_000);
    expect(boundedTelegramRequestTimeoutMs(120_000, 90_000)).toBe(65_000);
    expect(() => boundedTelegramRequestTimeoutMs(5_500, 90_000)).toThrow('fit inside');
  });

  it('accepts truly idle poll/egress cycles and detects one stalled loop', () => {
    let now = 1_000;
    const progress = new TelegramBridgeProgress(() => now);
    progress.registerPoller('one', 5_000);
    progress.registerPoller('two', 5_000);
    progress.registerEgress(2_000);

    for (const alias of ['one', 'two']) {
      progress.pollCycleStarted(alias);
      progress.pollCycleSucceeded(alias, 0);
    }
    progress.egressCycleStarted();
    progress.egressCycleSucceeded(0);
    expect(progress.snapshot()).toMatchObject({ live: true, ready: true, reason: 'ready' });

    progress.pollCycleStarted('one');
    now += 4_000;
    progress.pollCycleHeartbeat('one');
    expect(progress.snapshot().stale_pollers).toBe(0);
    now += 5_001;
    expect(progress.snapshot()).toMatchObject({ live: false, ready: false, reason: 'loop_stale' });
  });

  it('makes three consecutive loop errors unready and resets boot-local counters on restart', () => {
    let now = 10_000;
    const progress = new TelegramBridgeProgress(() => now);
    progress.registerPoller('one', 5_000);
    progress.registerEgress(5_000);
    progress.pollCycleStarted('one'); progress.pollCycleSucceeded('one', 0);
    progress.egressCycleStarted(); progress.egressCycleSucceeded(0);
    for (let index = 0; index < 3; index += 1) {
      progress.egressCycleStarted(); progress.egressCycleFailed();
      now += 10;
    }
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'loop_errors' });
    expect(progress.renderMetrics()).toContain('egress_ticks_total{result="error"} 3');

    const restarted = new TelegramBridgeProgress(() => 20_000);
    expect(restarted.renderMetrics()).toContain('process_start_time_seconds 20');
    expect(restarted.renderMetrics()).toContain('egress_ticks_total{result="error"} 0');
  });

  it('does not classify fenced poll or egress work as a successful cycle', () => {
    const progress = new TelegramBridgeProgress(() => 10_000);
    progress.registerPoller('one', 5_000);
    progress.registerEgress(5_000);
    progress.pollCycleStarted('one'); progress.pollCycleFenced('one'); progress.pollCycleSucceeded('one', 0);
    progress.egressCycleStarted(); progress.egressCycleFenced(); progress.egressCycleSucceeded(0);
    expect(progress.snapshot()).toMatchObject({
      live: true, ready: false, reason: 'fenced', fenced_pollers: 1, egress_fenced: true
    });
    expect(progress.renderMetrics()).toContain('poll_ticks_total{result="fenced"} 1');
    expect(progress.renderMetrics()).toContain('egress_ticks_total{result="fenced"} 1');
  });
});

describe('Telegram progress health endpoints', () => {
  const servers: ReturnType<typeof startTelegramHealthServer>[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => { resolve(); }))));
  });

  it('requires DB plus completed poller and egress ticks, while idle remains legitimate', async () => {
    let now = 1_000;
    const progress = new TelegramBridgeProgress(() => now);
    progress.registerPoller('one', 5_000);
    progress.registerEgress(5_000);
    const pool = { async query() { return { rows: [], rowCount: 1 }; } } as unknown as DatabasePool;
    const server = startTelegramHealthServer(0, pool, new TelegramBridgeMetrics(), progress);
    servers.push(server);
    await once(server, 'listening');
    const port = (server.address() as AddressInfo).port;

    expect((await fetch(`http://127.0.0.1:${String(port)}/health/ready`)).status).toBe(503);
    progress.pollCycleStarted('one'); progress.pollCycleSucceeded('one', 0);
    progress.egressCycleStarted(); progress.egressCycleSucceeded(0);
    const ready = await fetch(`http://127.0.0.1:${String(port)}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', aliases: 1, healthy_aliases: 1 });

    now += 5_001;
    expect((await fetch(`http://127.0.0.1:${String(port)}/health/live`)).status).toBe(503);
  });
});

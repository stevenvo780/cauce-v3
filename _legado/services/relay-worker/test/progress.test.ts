import { describe, expect, it } from 'vitest';
import { assertRelayLeaseCoversSend, OriginRelayProgress } from '../src/progress.js';

describe('OriginRelayProgress', () => {
  it('treats completed idle cycles as real progress and a hung cycle as stale', () => {
    let now = 1_000;
    const progress = new OriginRelayProgress(1, 5_000, () => now);
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'starting' });

    progress.cycleStarted();
    now += 100;
    progress.cycleSucceeded();
    expect(progress.snapshot()).toMatchObject({ live: true, ready: true, reason: 'ready' });

    progress.cycleStarted();
    now += 5_001;
    expect(progress.snapshot()).toMatchObject({ live: false, ready: false, reason: 'loop_stale' });
  });

  it('reports repeated repository errors without calling an idle queue unhealthy', () => {
    let now = 2_000;
    const progress = new OriginRelayProgress(1, 5_000, () => now);
    progress.cycleStarted(); progress.cycleSucceeded();
    for (let index = 0; index < 3; index += 1) {
      now += 100;
      progress.cycleStarted(); progress.cycleFailed();
    }
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'repository_errors' });
  });

  it('makes an applied=false/fenced ACK immediately unready until a clean cycle follows', () => {
    const progress = new OriginRelayProgress(1, 5_000, () => 2_000);
    progress.cycleStarted();
    progress.result('fenced');
    progress.cycleSucceeded();
    expect(progress.snapshot()).toMatchObject({
      live: true, ready: false, reason: 'fenced_ack', fenced_cycles: 1, successful_cycles: 0
    });
    progress.cycleStarted(); progress.cycleSucceeded();
    expect(progress.snapshot()).toMatchObject({ ready: true, reason: 'ready', successful_cycles: 1 });
  });

  it('has explicit boot-local metric semantics and fails closed with no configured transport', () => {
    const first = new OriginRelayProgress(0, 5_000, () => 10_000);
    expect(first.snapshot()).toMatchObject({ live: true, ready: false, reason: 'no_adapters' });
    expect(first.renderMetrics()).toContain('process_start_time_seconds 10');
    expect(first.renderMetrics()).toContain('results_total{result="sent"} 0');

    const restarted = new OriginRelayProgress(1, 5_000, () => 20_000);
    expect(restarted.renderMetrics()).toContain('process_start_time_seconds 20');
    expect(restarted.snapshot().successful_cycles).toBe(0);
  });

  it('requires the total send deadline plus an ACK margin to fit inside the lease', () => {
    expect(() => assertRelayLeaseCoversSend(15_000, 10_000)).not.toThrow();
    expect(() => assertRelayLeaseCoversSend(14_999, 10_000)).toThrow('ACK safety margin');
  });
});

import { describe, expect, it } from 'vitest';
import { ShadowRouterProgress } from '../src/progress.js';

describe('ShadowRouterProgress', () => {
  it('requires a completed worker tick and turns a hung cycle red', () => {
    let now = 1_000;
    const progress = new ShadowRouterProgress(20_000, () => now);
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'starting' });

    progress.cycleStarted();
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'starting' });
    progress.cycleCompleted({ claimed: 0, routed: 0, failed: 0 });
    expect(progress.snapshot()).toMatchObject({ live: true, ready: true, reason: 'ready' });

    progress.cycleStarted();
    now += 20_001;
    expect(progress.snapshot()).toMatchObject({ live: false, ready: false, reason: 'loop_stale' });
  });

  it('keeps a target failure latched across empty claims until a delivery really routes', () => {
    const progress = new ShadowRouterProgress(20_000, () => 2_000);
    progress.cycleStarted();
    progress.cycleCompleted({ claimed: 1, routed: 0, failed: 1 });
    expect(progress.snapshot()).toMatchObject({
      ready: false, reason: 'target_error', failed_events: 1,
      successful_cycles: 0, target_failed_cycles: 1,
    });

    progress.cycleStarted();
    progress.cycleCompleted({ claimed: 0, routed: 0, failed: 0 });
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'target_error' });

    progress.cycleStarted();
    progress.cycleCompleted({ claimed: 1, routed: 1, failed: 0 });
    expect(progress.snapshot()).toMatchObject({ ready: true, reason: 'ready', routed_events: 1 });
  });

  it('reports repository failure immediately and validates cycle accounting', () => {
    const progress = new ShadowRouterProgress(20_000, () => 3_000);
    progress.cycleStarted();
    progress.cycleFailed();
    expect(progress.snapshot()).toMatchObject({ ready: false, reason: 'repository_error', failed_cycles: 1 });
    expect(() => progress.cycleCompleted({ claimed: 2, routed: 1, failed: 0 }))
      .toThrow('inconsistent');
    expect(progress.renderMetrics()).toContain('cauce_shadow_router_ready 0');
  });

  it('rejects a stale deadline shorter than the bounded target request', () => {
    expect(() => new ShadowRouterProgress(19_999)).toThrow('at least 20000');
  });

  it('records per-event progress during ordered work and turns stopping red immediately', () => {
    let now = 5_000;
    const progress = new ShadowRouterProgress(20_000, () => now);
    progress.cycleStarted();
    now += 15_000;
    progress.eventSettled();
    now += 15_000;
    expect(progress.snapshot()).toMatchObject({ live: true, ready: false, reason: 'starting' });
    progress.cycleAborted({ claimed: 1, routed: 1, failed: 0, released: 0 });
    expect(progress.snapshot()).toMatchObject({
      live: true, ready: false, reason: 'stopping', aborted_cycles: 1,
    });
  });
});

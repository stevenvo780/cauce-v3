import { describe, expect, it, vi } from 'vitest';
import { LoginThrottle, PasswordWorkGate, PasswordWorkSaturated } from './password-auth.js';

describe('password admission under concurrent load', () => {
  it('evicts one cold key without clearing hot failures when the table is full', () => {
    const throttle = new LoginThrottle(2, 60_000, 2);
    throttle.recordFailure('cold', 0);
    throttle.recordFailure('hot', 0);
    throttle.recordFailure('hot', 1);
    throttle.recordFailure('new', 2);
    expect(throttle.retryAfterMs('hot', 3)).toBe(59_998);
    throttle.recordFailure('new', 3);
    expect(throttle.retryAfterMs('new', 4)).toBe(59_999);
    expect(throttle.retryAfterMs('hot', 4)).toBe(59_997);
  });

  it('keeps a recently consulted blocked key and lets its window expire', () => {
    const throttle = new LoginThrottle(1, 60_000, 2);
    throttle.recordFailure('hot', 0);
    throttle.recordFailure('cold', 1);
    expect(throttle.retryAfterMs('hot', 2)).toBe(59_998);
    throttle.recordFailure('new', 3);
    expect(throttle.retryAfterMs('hot', 4)).toBe(59_996);
    expect(throttle.retryAfterMs('hot', 60_000)).toBe(0);
    throttle.recordFailure('hot', 60_001);
    expect(throttle.retryAfterMs('hot', 60_002)).toBe(59_999);
  });

  it('preserves live reservations when failure keys are evicted', () => {
    const throttle = new LoginThrottle(2, 60_000, 2);
    throttle.recordFailure('active', 0);
    const release = [throttle.reserve('active'), throttle.reserve('active')];
    throttle.recordFailure('cold', 1);
    throttle.recordFailure('new', 2);
    expect(throttle.retryAfterMs('active', 3)).toBe(1_000);
    for (const finish of release) finish();
    expect(throttle.retryAfterMs('active', 4)).toBe(0);
  });

  it('reserves a running slot and a separate queue for login', async () => {
    const gate = new PasswordWorkGate(2, 1);
    const started: string[] = [];
    let releaseBackground: () => void = () => undefined;
    let releaseLogin: () => void = () => undefined;
    const background = gate.run(async () => {
      started.push('background');
      await new Promise<void>(resolve => { releaseBackground = resolve; });
    });
    const queuedBackground = gate.run(async () => { started.push('queued background'); });
    const login = gate.run(async () => {
      started.push('login');
      await new Promise<void>(resolve => { releaseLogin = resolve; });
    }, 'login');
    const queuedLogin = gate.run(async () => { started.push('queued login'); }, 'login');
    try {
      await expect(gate.run(() => Promise.resolve(), 'login')).rejects.toBeInstanceOf(PasswordWorkSaturated);
      await expect(gate.run(() => Promise.resolve())).rejects.toBeInstanceOf(PasswordWorkSaturated);
      expect(started).toEqual(['background', 'login']);
      releaseLogin();
      await queuedLogin;
      expect(started).toEqual(['background', 'login', 'queued login']);
    } finally {
      releaseLogin(); releaseBackground();
      await Promise.all([background, queuedBackground, login, queuedLogin]);
    }
  });

  it('starts queued login before background and releases slots on failures', async () => {
    const gate = new PasswordWorkGate(2, 2);
    const started: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const running = [gate.run(() => held, 'login'), gate.run(() => held, 'login')];
    const background = gate.run(async () => { started.push('background'); });
    const login = gate.run(async () => { started.push('login'); throw new Error('derivation failed'); }, 'login');
    const failure = expect(login).rejects.toThrow('derivation failed');
    release();
    await Promise.all([...running, background, failure]);
    expect(started).toEqual(['login', 'background']);
    await expect(gate.run(async () => 'available', 'login')).resolves.toBe('available');
  });

  it('expires waiting work and reuses its queue slot without running the expired derivation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gate = new PasswordWorkGate(2, 1);
    const started: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => { release = resolve; });
    const running = [gate.run(() => held, 'login'), gate.run(() => held, 'login')];
    let outcome: unknown;
    const expired = gate.run(async () => { started.push('expired'); }).catch((error: unknown) => { outcome = error; });
    const remaining: Promise<unknown>[] = [];
    try {
      await vi.advanceTimersByTimeAsync(9_999);
      expect(outcome).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome).toBeInstanceOf(PasswordWorkSaturated);
      remaining.push(gate.run(async () => { started.push('replacement'); }));
      await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(PasswordWorkSaturated);
      release();
      await Promise.all([...running, expired, ...remaining]);
      expect(started).toEqual(['replacement']);
      expect(vi.getTimerCount()).toBe(0);
      await expect(gate.run(async () => 'available', 'login')).resolves.toBe('available');
    } finally { release(); await Promise.all([...running, expired, ...remaining]); vi.useRealTimers(); }
  });
});

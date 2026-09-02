import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorLabel, logEvent, shortFingerprint } from '../src/index.js';

function capture(run: () => void): string[] {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    run();
    return spy.mock.calls.map((call) => String(call[0]));
  } finally {
    spy.mockRestore();
  }
}

afterEach(() => { vi.restoreAllMocks(); });

describe('structured logging', () => {
  it('emits exactly one line even when a field carries newlines', () => {
    const lines = capture(() => { logEvent('pty_closed', { reason: 'a\nb\nc', code: 1006 }); });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      level: 'error', event: 'pty_closed', reason: 'a\nb\nc', code: 1006,
    });
  });

  it('defaults to the error level and omits an absent trace id', () => {
    const [line] = capture(() => { logEvent('boot'); });
    const record = JSON.parse(line ?? '') as Record<string, unknown>;
    expect(record.level).toBe('error');
    expect(Object.keys(record)).not.toContain('trace_id');
  });

  it('carries the declared level and trace id', () => {
    const [line] = capture(() => {
      logEvent('delivery_started', { alias: 'zeus' }, { level: 'info', traceId: 'd-1' });
    });
    expect(JSON.parse(line ?? '')).toEqual({
      level: 'info', event: 'delivery_started', trace_id: 'd-1', alias: 'zeus',
    });
  });
});

describe('log labels', () => {
  it('turns a non-Error throw into unknown_error', () => {
    expect(errorLabel({ token: 'secret' })).toBe('unknown_error');
    expect(errorLabel('secret string')).toBe('unknown_error');
  });

  it('truncates an Error message so a leaked payload cannot ride along whole', () => {
    expect(errorLabel(new Error('x'.repeat(500)))).toHaveLength(200);
  });

  it('reduces a fingerprint to sixteen lowercase hex characters', () => {
    expect(shortFingerprint('AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'))
      .toBe('abcdef0123456789');
  });
});

import { describe, expect, it } from 'vitest';
import { LIVE_STATES } from '../live/agent-state';
import { deskMonitor } from './monitor';

describe('desk monitor', () => {
  it('shows code while thinking or receiving, a red screen when down and amber when blocked', () => {
    expect(deskMonitor('thinking', false)).toBe('code');
    expect(deskMonitor('receiving', false)).toBe('code');
    expect(deskMonitor('delegating', false)).toBe('code');
    expect(deskMonitor('down', false)).toBe('error');
    expect(deskMonitor('blocked', false)).toBe('alert');
  });

  it('goes dark when the owner is asleep and rests dimmed otherwise', () => {
    expect(deskMonitor('idle', true)).toBe('off');
    expect(deskMonitor('settled', true)).toBe('off');
    expect(deskMonitor('idle', false)).toBe('dim');
    expect(deskMonitor('settled', false)).toBe('dim');
  });

  it('gives every live state a mode', () => {
    const modes = new Set(['code', 'error', 'alert', 'dim', 'off']);
    for (const state of LIVE_STATES) expect(modes.has(deskMonitor(state, false))).toBe(true);
  });
});

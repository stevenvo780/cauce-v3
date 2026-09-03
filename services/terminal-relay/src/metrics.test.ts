import { describe, expect, it } from 'vitest';
import { NO_RELAY_METRICS, TerminalRelayMetrics } from './metrics.js';
import { CLOSE_CODES } from './sessions.js';

function seriesOf(text: string, name: string): string[] {
  return text.split('\n').filter((line) => line.startsWith(`${name}{`) || line === name
    || line.startsWith(`${name} `));
}

describe('terminal relay metrics', () => {
  it('renders every family at zero before any traffic, so rate() never sees a gap', () => {
    const text = new TerminalRelayMetrics({ readiness: () => false }).render();

    expect(seriesOf(text, 'cauce_terminal_sessions_open')).toEqual([
      'cauce_terminal_sessions_open{mode="shell"} 0',
      'cauce_terminal_sessions_open{mode="harness"} 0',
      'cauce_terminal_sessions_open{mode="harness_rw"} 0',
    ]);
    expect(seriesOf(text, 'cauce_terminal_session_opens_total')).toEqual([
      'cauce_terminal_session_opens_total{result="opened"} 0',
      'cauce_terminal_session_opens_total{result="denied"} 0',
      'cauce_terminal_session_opens_total{result="fenced"} 0',
      'cauce_terminal_session_opens_total{result="expired"} 0',
    ]);
    expect(seriesOf(text, 'cauce_terminal_recordings_total')).toEqual([
      'cauce_terminal_recordings_total{result="started"} 0',
      'cauce_terminal_recordings_total{result="refused"} 0',
      'cauce_terminal_recordings_total{result="capped"} 0',
      'cauce_terminal_recordings_total{result="failed"} 0',
    ]);
    expect(text).toContain('cauce_terminal_bytes_in_total 0');
    expect(text).toContain('cauce_terminal_bytes_out_total 0');
    expect(text).toContain('cauce_terminal_control_sessions_open 0');
    expect(text).toContain('cauce_terminal_ready 0');
    expect(text).toContain('cauce_terminal_presence_last_success_timestamp_seconds -1');
    expect(seriesOf(text, 'cauce_terminal_close_codes_total'))
      .toContain(`cauce_terminal_close_codes_total{code="${String(CLOSE_CODES.control_released)}"} 0`);
    for (const family of [
      'cauce_terminal_sessions_open', 'cauce_terminal_session_opens_total',
      'cauce_terminal_bytes_in_total', 'cauce_terminal_bytes_out_total',
      'cauce_terminal_close_codes_total', 'cauce_terminal_recordings_total',
      'cauce_terminal_presence_last_success_timestamp_seconds', 'cauce_terminal_ready',
      'cauce_terminal_control_sessions_open',
    ]) {
      expect(text).toContain(`# HELP ${family} `);
      expect(text).toContain(`# TYPE ${family} `);
    }
  });

  it('counts sessions, bytes, close codes and recordings without a single identity label', () => {
    const metrics = new TerminalRelayMetrics({
      readiness: () => true,
      presenceAcceptedAt: () => 1_700_000_000_500,
    });
    metrics.openAttempt('opened');
    metrics.openAttempt('denied');
    metrics.openAttempt('denied');
    metrics.openAttempt('fenced');
    metrics.sessionOpened('harness_rw');
    metrics.sessionOpened('shell');
    metrics.recording('started');
    metrics.bytesIn(7);
    metrics.bytesOut(4_096);
    metrics.sessionClosed('shell', CLOSE_CODES.idle_timeout);

    const text = metrics.render();
    expect(text).toContain('cauce_terminal_sessions_open{mode="shell"} 0');
    expect(text).toContain('cauce_terminal_sessions_open{mode="harness_rw"} 1');
    expect(text).toContain('cauce_terminal_control_sessions_open 1');
    expect(text).toContain('cauce_terminal_session_opens_total{result="denied"} 2');
    expect(text).toContain('cauce_terminal_session_opens_total{result="fenced"} 1');
    expect(text).toContain('cauce_terminal_bytes_in_total 7');
    expect(text).toContain('cauce_terminal_bytes_out_total 4096');
    expect(text).toContain('cauce_terminal_recordings_total{result="started"} 1');
    expect(text).toContain(
      `cauce_terminal_close_codes_total{code="${String(CLOSE_CODES.idle_timeout)}"} 1`,
    );
    expect(text).toContain('cauce_terminal_ready 1');
    expect(text).toContain('cauce_terminal_presence_last_success_timestamp_seconds 1700000000.5');

    for (const forbidden of ['tenant', 'alias', 'operator', 'session_id', 'container', 'jarvis']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('never lets the open gauge go negative when a close is reported twice', () => {
    const metrics = new TerminalRelayMetrics({ readiness: () => true });
    metrics.sessionOpened('harness');
    metrics.sessionClosed('harness', CLOSE_CODES.normal);
    metrics.sessionClosed('harness', CLOSE_CODES.normal);
    const text = metrics.render();
    expect(text).toContain('cauce_terminal_sessions_open{mode="harness"} 0');
    expect(text).toContain(`cauce_terminal_close_codes_total{code="${String(CLOSE_CODES.normal)}"} 2`);
  });

  it('folds an unknown close code into a bounded bucket instead of minting a series per code', () => {
    const metrics = new TerminalRelayMetrics({ readiness: () => true });
    metrics.sessionClosed('shell', 4_999);
    expect(metrics.render()).toContain('cauce_terminal_close_codes_total{code="other"} 1');
  });

  it('counts a close that never became a session without pushing the open gauge below zero', () => {
    const metrics = new TerminalRelayMetrics({ readiness: () => true });
    metrics.sessionOpened('shell');
    metrics.closeCode(CLOSE_CODES.ticket_invalid);
    const text = metrics.render();
    expect(text).toContain('cauce_terminal_sessions_open{mode="shell"} 1');
    expect(text).toContain(
      `cauce_terminal_close_codes_total{code="${String(CLOSE_CODES.ticket_invalid)}"} 1`,
    );
  });

  it('offers a no-op sink so the session path never branches on metrics being configured', () => {
    expect(() => {
      NO_RELAY_METRICS.sessionOpened('shell');
      NO_RELAY_METRICS.sessionClosed('shell', CLOSE_CODES.normal);
      NO_RELAY_METRICS.closeCode(CLOSE_CODES.normal);
      NO_RELAY_METRICS.openAttempt('expired');
      NO_RELAY_METRICS.bytesIn(1);
      NO_RELAY_METRICS.bytesOut(1);
      NO_RELAY_METRICS.recording('failed');
    }).not.toThrow();
  });
});

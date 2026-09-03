import { renderCounters } from '@cauce/protocol';
import type { TerminalMode } from './gateway-client.js';
import { CLOSE_CODES } from './session-limits.js';

/**
 * Prometheus exposition for the relay. Everything here is aggregate and identity-free on
 * purpose: a terminal metric labelled by tenant, alias, operator or session id would put the
 * shape of who is being watched into a scrape target that is not access controlled. The close
 * code set is bounded to the codes the relay itself can emit, so a peer cannot mint series.
 */

export type SessionOpenResult = 'opened' | 'denied' | 'fenced' | 'expired';
export type RecordingResult = 'started' | 'refused' | 'capped' | 'failed';

export interface RelayMetricsSink {
  sessionOpened(mode: TerminalMode): void;
  sessionClosed(mode: TerminalMode, code: number): void;
  closeCode(code: number): void;
  openAttempt(result: SessionOpenResult): void;
  bytesIn(count: number): void;
  bytesOut(count: number): void;
  recording(result: RecordingResult): void;
}

interface TerminalRelayMetricsOptions {
  readonly readiness: () => boolean;
  readonly presenceAcceptedAt?: () => number | undefined;
}

const MODES: readonly TerminalMode[] = ['shell', 'harness', 'harness_rw'];
const CONTROL_MODES: readonly TerminalMode[] = ['harness_rw'];
const OPEN_RESULTS: readonly SessionOpenResult[] = ['opened', 'denied', 'fenced', 'expired'];
const RECORDING_RESULTS: readonly RecordingResult[] = ['started', 'refused', 'capped', 'failed'];
const CLOSE_CODE_LABELS: readonly string[] = [
  ...Object.values(CLOSE_CODES).map((code) => String(code)), 'other',
];

export const NO_RELAY_METRICS: RelayMetricsSink = {
  sessionOpened: () => undefined,
  sessionClosed: () => undefined,
  closeCode: () => undefined,
  openAttempt: () => undefined,
  bytesIn: () => undefined,
  bytesOut: () => undefined,
  recording: () => undefined,
};

function zeroed<Key extends string>(keys: readonly Key[]): Map<Key, number> {
  return new Map(keys.map((key) => [key, 0]));
}

export class TerminalRelayMetrics implements RelayMetricsSink {
  private readonly readiness: () => boolean;
  private readonly presenceAcceptedAt: () => number | undefined;
  private readonly open = zeroed(MODES);
  private readonly opens = zeroed(OPEN_RESULTS);
  private readonly closeCodes = zeroed(CLOSE_CODE_LABELS);
  private readonly recordings = zeroed(RECORDING_RESULTS);
  private inBytes = 0;
  private outBytes = 0;

  constructor(options: TerminalRelayMetricsOptions) {
    this.readiness = options.readiness;
    this.presenceAcceptedAt = options.presenceAcceptedAt ?? (() => undefined);
  }

  sessionOpened(mode: TerminalMode): void {
    this.open.set(mode, (this.open.get(mode) ?? 0) + 1);
  }

  sessionClosed(mode: TerminalMode, code: number): void {
    this.open.set(mode, Math.max(0, (this.open.get(mode) ?? 0) - 1));
    this.closeCode(code);
  }

  closeCode(code: number): void {
    const label = this.closeCodes.has(String(code)) ? String(code) : 'other';
    this.closeCodes.set(label, (this.closeCodes.get(label) ?? 0) + 1);
  }

  openAttempt(result: SessionOpenResult): void {
    this.opens.set(result, (this.opens.get(result) ?? 0) + 1);
  }

  bytesIn(count: number): void {
    if (count > 0) this.inBytes += count;
  }

  bytesOut(count: number): void {
    if (count > 0) this.outBytes += count;
  }

  recording(result: RecordingResult): void {
    this.recordings.set(result, (this.recordings.get(result) ?? 0) + 1);
  }

  render(): string {
    const presenceAt = this.presenceAcceptedAt();
    const control = CONTROL_MODES.reduce((total, mode) => total + (this.open.get(mode) ?? 0), 0);
    const lines = [
      ...labelled(
        'cauce_terminal_sessions_open', 'gauge', 'Terminal sessions currently attached, by mode.',
        'mode', this.open,
      ),
      trimmed(renderCounters(
        'cauce_terminal_session_opens_total', 'Session open attempts by outcome.', this.opens,
      )),
      ...scalar('cauce_terminal_bytes_in_total', 'counter',
        'Bytes accepted from browsers and forwarded to PTY agents.', this.inBytes),
      ...scalar('cauce_terminal_bytes_out_total', 'counter',
        'PTY output and forwarded agent notices sent from agents to browsers.', this.outBytes),
      ...labelled(
        'cauce_terminal_close_codes_total', 'counter',
        'Terminal sessions closed, by WebSocket close code.', 'code', this.closeCodes,
      ),
      trimmed(renderCounters(
        'cauce_terminal_recordings_total', 'Session recordings by outcome.', this.recordings,
      )),
      ...scalar('cauce_terminal_presence_last_success_timestamp_seconds', 'gauge',
        'Unix time of the last gateway-accepted presence publication; -1 before the first one.',
        presenceAt === undefined ? -1 : presenceAt / 1_000),
      ...scalar('cauce_terminal_ready', 'gauge',
        'Whether both listeners are up and presence is fresh.', this.readiness() ? 1 : 0),
      ...scalar('cauce_terminal_control_sessions_open', 'gauge',
        'Writable TUI sessions currently attached.', control),
    ];
    return `${lines.join('\n')}\n`;
  }
}

function trimmed(block: string): string {
  return block.endsWith('\n') ? block.slice(0, -1) : block;
}

function scalar(name: string, type: string, help: string, value: number): string[] {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${String(value)}`];
}

function labelled(
  name: string, type: string, help: string, label: string, values: ReadonlyMap<string, number>,
): string[] {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [key, value] of values) lines.push(`${name}{${label}="${key}"} ${String(value)}`);
  return lines;
}

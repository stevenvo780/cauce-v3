import type { AdapterLogger } from './types.js';

export const OPENCLAW_PHASE_PREFIX = '@cauce/openclaw-phase/v1 ';
const BRIDGE_PHASES = ['bridge_enter', 'modules_loaded', 'agent_cli_started', 'agent_cli_resolved', 'decode_completed', 'envelope_flush_requested', 'bridge_failed', 'bridge_cancelled', 'bridge_timeout'] as const;
export type OpenClawPhase = typeof BRIDGE_PHASES[number] | 'invocation_enter' | 'setup_completed' | 'started_ack_enqueued'
  | 'input_enter' | 'input_completed' | 'harness_enter' | 'harness_completed' | 'harness_failed'
  | 'session_resolved' | 'runner_enter' | 'runner_resolved' | 'decoded_final_valid'
  | 'child_spawned' | 'child_exit' | 'child_close' | 'runner_settled' | 'runner_timeout' | 'runner_cancelled' | 'runner_failed'
  | 'api_enter' | 'api_dispatch' | 'api_headers' | 'api_body_complete' | 'api_resolved' | 'api_failed' | 'api_cancelled' | 'api_timeout';
export interface OpenClawPhaseObservation {
  readonly phase: OpenClawPhase;
  readonly transport: 'engine' | 'cli' | 'bridge' | 'api' | 'adapter';
  readonly elapsedMs: number;
  readonly utc: string;
}
export type OpenClawPhaseObserver = (observation: OpenClawPhaseObservation) => void;

export function phaseEmitter(observer: OpenClawPhaseObserver | undefined, transport: OpenClawPhaseObservation['transport']): (phase: OpenClawPhase) => void {
  const start = performance.now();
  let count = 0;
  return (phase) => {
    if (observer === undefined || count++ >= 64) return;
    try { observer({ phase, transport, elapsedMs: performance.now() - start, utc: new Date().toISOString() }); } catch { /* Observability cannot change execution. */ }
  };
}
export function deliveryPhaseObserver(logger: AdapterLogger, delivery: { readonly delivery_id: string; readonly attempt: number }): OpenClawPhaseObserver {
  const start = performance.now();
  let count = 0;
  return (observation) => {
    if (count++ >= 128) return;
    try {
      logger({ event: 'openclaw_phase', delivery_id: delivery.delivery_id, attempt: delivery.attempt,
        timestamp: new Date().toISOString(), phase_name: observation.phase, transport: observation.transport,
        elapsed_ms: observation.elapsedMs, received_elapsed_ms: performance.now() - start, phase_timestamp: observation.utc });
    } catch { /* Observability cannot change execution. */ }
  };
}

function bridgeObservation(line: string): OpenClawPhaseObservation | undefined {
  try {
    const value: unknown = JSON.parse(line.slice(OPENCLAW_PHASE_PREFIX.length));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'elapsedMs,phase,utc'
      || !BRIDGE_PHASES.some((phase) => phase === record.phase)
      || typeof record.elapsedMs !== 'number' || !Number.isFinite(record.elapsedMs) || record.elapsedMs < 0
      || typeof record.utc !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(record.utc)
      || !Number.isFinite(Date.parse(record.utc)) || new Date(record.utc).toISOString() !== record.utc) return undefined;
    return { phase: record.phase as typeof BRIDGE_PHASES[number], transport: 'bridge', elapsedMs: record.elapsedMs, utc: record.utc };
  } catch { return undefined; }
}

/** Reserved frames are diagnostics, never liveness or execution witnesses. */
export class OpenClawPhaseFrames {
  private prefix = '';
  private frame: string | undefined;
  private dropping = false;
  private lineStart = true;
  private count = 0;
  constructor(private readonly observer: OpenClawPhaseObserver | undefined) {}

  finish(): Buffer {
    const ordinary = Buffer.from(this.prefix, "latin1");
    this.prefix = ""; this.frame = undefined; this.dropping = false; this.lineStart = true;
    return ordinary;
  }

  push(chunk: Buffer): Buffer {
    const ordinary: number[] = [];
    for (const byte of chunk) {
      if (this.dropping) { if (byte === 10) { this.dropping = false; this.lineStart = true; } continue; }
      if (this.frame !== undefined) {
        if (byte === 10) {
          const value = bridgeObservation(this.frame);
          if (value !== undefined && this.count++ < 32) { try { this.observer?.(value); } catch { /* Diagnostic only. */ } }
          this.frame = undefined; this.lineStart = true;
        } else if (this.frame.length >= 512) { this.frame = undefined; this.dropping = true; }
        else this.frame += String.fromCharCode(byte);
        continue;
      }
      if (this.lineStart) {
        this.prefix += String.fromCharCode(byte);
        if (OPENCLAW_PHASE_PREFIX.startsWith(this.prefix)) {
          if (this.prefix === OPENCLAW_PHASE_PREFIX) { this.frame = this.prefix; this.prefix = ''; }
          continue;
        }
        for (const character of this.prefix) ordinary.push(character.charCodeAt(0));
        this.prefix = ''; this.lineStart = byte === 10;
      } else { ordinary.push(byte); this.lineStart = byte === 10; }
    }
    return Buffer.from(ordinary);
  }
}

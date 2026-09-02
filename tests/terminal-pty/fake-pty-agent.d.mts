// Types for ./fake-pty-agent.mjs.

import type { GovernanceSandbox } from './governance-double.d.mts';

export { GOVERNANCE, GOVERNANCE_FEATURES, createGovernanceSandbox } from './governance-double.d.mts';

export declare const EXIT: {
  ok: 0; bad_config: 2; hello_rejected: 3; protocol_error: 4; transport_error: 5; refuses_root: 78;
};

export interface FakeAgentEvent {
  at: string;
  event: string;
  alias: string;
  [field: string]: unknown;
}

export interface FakeAgentOptions {
  host?: string;
  port: number;
  cert?: Buffer;
  key?: Buffer;
  ca?: Buffer;
  servername?: string;
  reject_unauthorized?: boolean;
  tenant?: string;
  alias?: string;
  /** 32 raw bytes or 64 hex chars; never logged. */
  alias_key: Buffer | string;
  container_id?: string;
  generation?: string;
  image_id?: string;
  runtime_user?: string;
  runtime_uid?: number;
  /**
   * Advertised session modes. `harness_rw` — the mode that is a TUI and writable at once —
   * is understood by this double only: the real relay narrows the hello to `shell`/`harness`
   * and rejects the whole hello for any other entry, so advertising it there disconnects the
   * agent. Use it against a scratch server until the relay learns the mode.
   */
  modes?: string[];
  /** When set, STDIN is answered with INPUT_REFUSED instead of being typed into the pane. */
  refuse_input_while?: 'governance_write_in_flight' | 'pane_input_barrier' | null;
  /**
   * When set, a GEOMETRY frame follows every OPEN_OK with the real size of the remote TUI.
   * Both sides are validated against `GEOMETRY_CLAMP` and a value outside it — or a
   * non-integer, which `JSON.stringify` would put on the wire as `null` — throws `bad_config`
   * instead of reaching the socket.
   */
  geometry?: { cols: number; rows: number } | null;
  /** Serve READ/WRITE/WRITE_BATCH from a private mkdtemp and advertise the features. */
  governance?: boolean;
  governance_harness?: string;
  banner?: boolean;
  oneshot?: boolean;
  flood_bytes?: number;
  clock_skew_sec?: number;
  simulate_euid?: number;
  now?: () => number;
  log?: boolean;
  on_event?: (event: FakeAgentEvent) => void;
}

export interface FakeAgentHandle {
  readonly failed: boolean;
  readonly events: FakeAgentEvent[];
  readonly ready: Promise<{ alias: string }>;
  readonly closed: Promise<number>;
  readonly sessions: number;
  readonly exit_code: number;
  readonly error?: Error;
  /** The sandbox in use, or `null` while no governance frame has arrived yet (and after close). */
  readonly governance?: GovernanceSandbox | null;
  close(): void;
  destroy(): void;
}

export declare function startFakeAgent(options: FakeAgentOptions): FakeAgentHandle;

/**
 * Reads the same options out of the environment the standalone CLI uses (`AGENT_MODES`,
 * `AGENT_REFUSE_INPUT`, `AGENT_GEOMETRY=<cols>x<rows>`, ...). Exported so a test can drive
 * the CLI's own parsing in process instead of only the option object.
 * `RELAY_PORT` missing or unparseable exits the process: it is the CLI's entry point.
 */
export declare function fromEnvironment(): FakeAgentOptions;

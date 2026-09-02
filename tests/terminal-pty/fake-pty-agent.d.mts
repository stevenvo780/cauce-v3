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
  modes?: string[];
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

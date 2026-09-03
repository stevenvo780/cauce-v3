/**
 * Shared shapes of the PTY control plane. The gateway (agora-storage) only decides and
 * audits; terminal-relay carries the bytes to the pty-agents living inside the containers
 * on kratos. Everything crossing that host boundary is described here.
 */

export type TerminalMode = 'shell' | 'harness' | 'harness_rw';

export function isTerminalMode(value: unknown): value is TerminalMode {
  return value === 'shell' || value === 'harness' || value === 'harness_rw';
}

/** Modes whose STDIN reaches the pty. `harness` is the read-only TUI and is never one of them. */
export const WRITABLE_MODES: readonly TerminalMode[] = ['shell', 'harness_rw'];

export function isWritableMode(mode: TerminalMode): boolean {
  return WRITABLE_MODES.includes(mode);
}

/** Operator identity used when the console cannot name the human behind basic auth. */
export const UNATTRIBUTED_OPERATOR = 'unattributed:console-basic-auth';

/** Placement of a fleet alias. Server-side truth; never accepted from the browser. */
export interface FleetPlacement {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container: string;
  readonly runtime_user: string;
}

export interface FleetIdentity {
  readonly tenant_id: string;
  readonly alias: string;
}

/** What terminal-relay reports about a pty-agent it currently holds a connection to. */
export interface AgentPresence {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  readonly generation: string;
  readonly image_id: string;
  readonly runtime_user: string;
  readonly runtime_uid: number;
  readonly harness: string;
  /** Launcher mark: harness/home come from the real process, not from the declared bundle. */
  readonly runtime_facts_observed?: boolean;
  /**
   * The alias `$HOME` inside its container, measured by the agent running there.
   * OPTIONAL: a pty-agent older than this version does not send it, and requiring it would drop
   * its entire presence — `parseAgentPresence` throws and `registry.observe` loses the alias —,
   * meaning deploying the gateway before the agent would leave terminals down across the fleet.
   * Same lesson as the `features` comment on the agent itself.
   * `undefined` means "this agent does not report it", which is NOT the same as "it has none":
   * the documents path still answers "not measured", the same as before.
   */
  readonly home?: string;
  /** Effective directories of the harness process; optional for compatibility during rollout. */
  readonly codex_home?: string;
  readonly claude_config_dir?: string;
  readonly openclaw_workspace?: string;
  readonly cwd?: string;
  readonly workspace_root?: string;
  readonly project_root?: string;
  /** Closed projection of config.toml; absent if legacy, non-Codex, or malformed. */
  readonly project_doc_max_bytes?: number;
  readonly project_doc_fallback_filenames?: readonly string[];
  readonly modes: readonly string[];
  readonly connected_since: string;
}

export type PtyState = 'online' | 'agent_offline' | 'not_installed' | 'unknown';

/**
 * One row of the console fleet bar. When `authorized` is false every field that would
 * confirm the existence or shape of the target is nulled out and `reason` is generic.
 */
export interface TerminalTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container: string | null;
  readonly runtime_user: string | null;
  readonly harness: string | null;
  readonly image: string | null;
  readonly shares_container_with: readonly FleetIdentity[];
  readonly modes: readonly string[];
  /** Subset of `modes` whose STDIN reaches the pty; the console never infers it from the names. */
  readonly writable_modes: readonly string[];
  readonly pty_state: PtyState;
  readonly last_seen: string | null;
  readonly authorized: boolean;
  readonly reason: string;
}

/** Denial reasons. They are stable strings: the console and the tests match on them. */
export type TerminalDenial =
  | 'unknown_alias'
  | 'attribution_required'
  | 'no_routing_authority'
  | 'no_grant'
  | 'no_grant_for_operator'
  | 'no_recognized_mode'
  | 'writable_tui_disabled'
  | 'writable_requires_attribution'
  | 'writable_requires_named_operator'
  | 'control_permission_required';

export type TerminalConflict =
  | 'agent_offline'
  | 'session_limit'
  | 'container_busy'
  | 'request_conflict'
  | 'control_held'
  | 'extension_exhausted';

export interface TerminalSessionRow {
  id: string;
  /** Stable browser admission id. PostgreSQL UUID is decoded as its canonical text form. */
  request_id: string;
  /** Canonical digest of authenticated immutable admission semantics. */
  request_sha256: Buffer;
  /** Only the digest of the current browser revocation capability is durable. */
  browser_owner_sha256: Buffer;
  /** PostgreSQL bigint stays a decimal string on the wire; never coerce the fence to Number. */
  browser_owner_generation: string;
  operator_id: string;
  attributed: boolean;
  console_subject: string;
  tenant_id: string;
  alias: string;
  container: string;
  generation: string | null;
  image_id: string | null;
  runtime_user: string | null;
  mode: TerminalMode;
  ticket_sha256: Buffer;
  reason: string;
  cols: number | null;
  rows: number | null;
  trace_id: string | null;
  issued_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  /** PostgreSQL bigint is intentionally decoded as a decimal string; never coerce this fence to Number. */
  relay_claim_epoch: string;
  /** Only the digest is durable. The raw capability-like UUID never enters PostgreSQL. */
  relay_claim_sha256: Buffer | null;
  relay_claimed_at: Date | null;
  relay_claim_expires_at: Date | null;
  /** SHA-256 of the authenticated relay client-certificate leaf selected at browser admission. */
  relay_instance_id: string;
  /** Current relay process generation; null until the one-shot ticket is consumed. */
  relay_boot_id: string | null;
  revoked_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
  bytes_in: string | number;
  bytes_out: string | number;
}

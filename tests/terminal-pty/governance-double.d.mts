// Types for ./governance-double.mjs.

export interface GovernanceProfile {
  readonly root: readonly string[];
  readonly names: readonly string[];
  /** Leaf under the profile root that holds the measured memory the index walks. */
  readonly memory: string;
}

export declare const GOVERNANCE: {
  max_read_path: number;
  max_document_bytes: number;
  max_write_transactions: number;
  max_write_batch_files: number;
  max_dir_entries: number;
  max_dir_depth: number;
  dir_scan_cap: number;
  read_index_budget: number;
  never_serve_basenames: Set<string>;
  never_serve_suffixes: string[];
  profiles: Record<string, GovernanceProfile>;
};

/** Features the agent leg advertises in AGENT_HELLO when the governance plane is enabled. */
export declare const GOVERNANCE_FEATURES: readonly string[];

/** A JSON reply (READ_OK, WRITE_ERR, …) or one prefixed data chunk (READ_DATA, …). */
export type GovernanceOutput =
  | { tag: number; json: Record<string, unknown> }
  | { tag: number; request_id: string; data: Buffer };

export interface GovernanceSeedFile {
  name: string;
  text?: string;
  fill?: { byte: number; count: number };
}

export interface GovernanceSandbox {
  readonly harness: string;
  /** Root of the mkdtemp tree; every governed path lives under it. */
  readonly home: string;
  /** Directory the harness profile governs (`$HOME/.claude`, the OpenClaw workspace, …). */
  readonly root: string;
  /** The only directory a `kind: "dir"` READ may name. */
  readonly memory_root: string;
  path(name: string): string;
  sha(path: string): string | null;
  seed(files: readonly GovernanceSeedFile[]): void;
  /** Seeds the memory tree; a name may carry `/` and its parents are created. */
  seedMemory(files: readonly GovernanceSeedFile[]): void;
  read(request: Record<string, unknown>): GovernanceOutput[];
  write(request: Record<string, unknown>): GovernanceOutput[];
  writeData(requestId: string, data: Buffer | Uint8Array): GovernanceOutput[];
  writeCancel(requestId: string): GovernanceOutput[];
  writeBatch(request: Record<string, unknown>): GovernanceOutput[];
  writeBatchData(requestId: string, data: Buffer | Uint8Array): GovernanceOutput[];
  writeBatchCancel(requestId: string): GovernanceOutput[];
  /** WRITE plus its WRITE_DATA chunks, as the relay would send them. */
  runWrite(request: Record<string, unknown>, chunks?: readonly Buffer[]): GovernanceOutput[];
  runWriteBatch(request: Record<string, unknown>, chunks?: readonly Buffer[]): GovernanceOutput[];
  dispose(): void;
}

export declare function createGovernanceSandbox(options?: { harness?: string }): GovernanceSandbox;

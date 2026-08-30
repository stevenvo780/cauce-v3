import { readFile } from 'node:fs/promises';
import { decodeJsonFrame } from './framing.js';
import type { TerminalMode } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';
import { hasControlCharacter, integerField, stringField } from './validation.js';

export const AGENT_PING_INTERVAL_MS = 10_000;
export const AGENT_PONG_TIMEOUT_MS = 45_000;
export const HELLO_TIMEOUT_MS = 10_000;

export interface AgentIdentity {
  readonly fingerprint_sha256: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly expires_at: string;
}

export interface AgentHello {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  /** Opaque 32-hex container generation from the launcher; a STRING, never a counter. */
  readonly generation: string;
  readonly image_id: string;
  readonly runtime_user: string;
  readonly runtime_uid: number;
  readonly harness: string;
    /** True only when the launcher observed the real process; absent/false does not certify paths. */
  readonly runtime_facts_observed?: boolean;
    /** Harness process `HOME` inside the container. Optional for backward compatibility. */
  readonly home?: string;
  /** Alias-scoped harness roots measured from the live adapter process, never inferred by relay. */
  readonly codex_home?: string;
  readonly claude_config_dir?: string;
  readonly openclaw_workspace?: string;
    /** Effective measured context; optional for older agents during rollout. */
  readonly cwd?: string;
  readonly workspace_root?: string;
  readonly project_root?: string;
    /** Closed projection of config.toml; both fields travel together and only for Codex. */
  readonly project_doc_max_bytes?: number;
  readonly project_doc_fallback_filenames?: readonly string[];
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
    /**
     * OPTIONAL capabilities the agent declares. An agent older than governance read does not
     * send the field, and then this is `[]`: nobody ever sends it a READ. This is not cosmetic —
     * the pty-agent's `_dispatch` treats an unknown tag as a protocol violation and drops the
     * connection on top, with ALL its open terminals. Deploying the relay before the agent
     * without this check would leave the fleet without terminals.
     */
  readonly features: readonly string[];
}

/** The agent declares this when it knows how to answer TAG_READ. Without the flag, it is not asked. */
export const FEATURE_READ_GOVERNANCE = 'read_governance';
/** READ_OK/READ_DATA only end when READ_DONE arrives. Required for indexes. */
export const FEATURE_READ_GOVERNANCE_DONE = 'read_governance_done_v1';
/** Atomic/CAS write. The suffix explicitly versions the protocol and its preconditions. */
export const FEATURE_WRITE_GOVERNANCE = 'write_governance_v1';
/** Full profile: preflight of every file and total rollback inside the pty-agent. */
export const FEATURE_WRITE_GOVERNANCE_BATCH = 'write_governance_batch_v1';
/** Lets a single PTY be paused without freezing PONG, reads, or other multiplexed sessions. */
export const FEATURE_SESSION_OUTPUT_FLOW_CONTROL = 'session_output_flow_control';
/** Maximum own memory above the Node writable buffer while TLS waits for `drain`. */
export const MAX_AGENT_WRITE_QUEUE_BYTES = 512 * 1024;
/** Reserved above the data quota for CLOSE frames. Exhausting it drops TLS so the agent kills all children. */
export const MAX_AGENT_CRITICAL_QUEUE_BYTES = 64 * 1024;
/** One connection maps to one alias: by construction this cap is per alias. */
export const MAX_AGENT_READS_IN_FLIGHT = 4;
/** When full, the connection is rotated: a terminal id is never forgotten while the socket is alive. */
export const MAX_TERMINAL_READ_TOMBSTONES = 1_024;

  /**
   * A read in flight. It is a loose transaction, not a session: the agent answers READ_OK with
   * the metadata (including how many READ_DATA frames follow), then the data, and that is it.
   */
export interface AgentReadHandlers {
  onReadOk(metadata: Record<string, unknown>): void;
  onReadData(chunk: Buffer): void;
  onReadDone(metadata: Record<string, unknown>): void;
  onReadErr(failure: { readonly code: string; readonly reason: string }): void;
    /** The connection died with the read half-done; neither OK nor ERR will arrive. */
  onAgentGone(reason: string): void;
}

export interface AgentWriteHandlers {
  onWriteOk(ack: Record<string, unknown>): void;
  onWriteErr(failure: { readonly code: string; readonly reason: string }): void;
    /** The connection died before the ACK; the caller keeps the precondition for retry. */
  onAgentGone(reason: string): void;
}

export type AgentGovernanceBatchEntry =
  | {
      readonly path: string;
      readonly mode: 'write';
      readonly operation: 'replace' | 'create';
      readonly expectedSha: string | undefined;
      readonly contentSha: string;
      readonly content: Buffer;
    }
  | {
      readonly path: string;
      readonly mode: 'verify';
      readonly operation: 'present' | 'absent';
      readonly expectedSha: string | undefined;
    };

export interface AgentSessionHandlers {
  onOpenOk(pid: number): void;
  onOpenErr(reason: string): void;
  onStdout(data: Buffer): void;
  onClosed(exit: { readonly exit_code: number | null; readonly signal: string | null; readonly reason: string }): void;
  /** The connection died underneath the session; no CLOSE frame will ever arrive. */
  onAgentGone(reason: string): void;
}

import type { AgentConnection } from './agent-connection.js';

export interface AgentLookup {
  lookup(tenantId: string, alias: string): AgentConnection | undefined;
}


export function normalizedFingerprint(value: string): string {
  return value.replace(/:/g, '').toUpperCase();
}

function modesField(source: Record<string, unknown>): readonly TerminalMode[] | undefined {
  const value: unknown = source.modes;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const modes: TerminalMode[] = [];
  for (const entry of value as readonly unknown[]) {
    if (entry !== 'shell' && entry !== 'harness') return undefined;
    modes.push(entry);
  }
  return modes;
}

  /**
   * Unlike `modesField`, this does NOT invalidate the hello: an older agent does not send
   * `features` and must still be admitted. Absent or malformed is read as "no capabilities",
   * which is the safe side — such an agent is never sent a READ.
   */
function featuresField(source: Record<string, unknown>): readonly string[] {
  const value: unknown = source.features;
  if (!Array.isArray(value)) return [];
  return (value as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string');
}

const MAX_CODEX_PROJECT_DOC_BYTES = 16 * 1024 * 1024;
const MAX_CODEX_FALLBACKS = 16;
const CODEX_NEVER_SERVE_BASENAMES = new Set([
  '.credentials.json', 'auth.json', '.claude.json', 'openclaw.json', '.env', '.netrc',
  'id_ed25519', 'id_rsa', 'known_hosts', 'authorized_keys',
]);
const CODEX_NEVER_SERVE_SUFFIXES = ['.pem', '.key', '.p12', '.pfx'];

function validCodexFallbackFilename(value: string): boolean {
  const normalized = value.toLowerCase();
  return value.length > 0 && value.length <= 128 && !value.includes('/') && !value.includes('\\')
    && !value.includes('..') && !hasControlCharacter(value)
    && !CODEX_NEVER_SERVE_BASENAMES.has(normalized)
    && !CODEX_NEVER_SERVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function codexProjectDocumentFields(
  source: Record<string, unknown>,
  harness: string,
): Pick<AgentHello, 'project_doc_max_bytes' | 'project_doc_fallback_filenames'> {
  const maxBytes = source.project_doc_max_bytes;
  const rawFallbacks = source.project_doc_fallback_filenames;
  if (harness !== 'codex' || typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes)
      || maxBytes < 1 || maxBytes > MAX_CODEX_PROJECT_DOC_BYTES
      || !Array.isArray(rawFallbacks) || rawFallbacks.length > MAX_CODEX_FALLBACKS) return {};
  const seen = new Set<string>(['AGENTS.override.md', 'AGENTS.md']);
  const fallbacks: string[] = [];
  for (const candidate of rawFallbacks) {
    if (typeof candidate !== 'string' || !validCodexFallbackFilename(candidate)
        || seen.has(candidate)) return {};
    seen.add(candidate);
    fallbacks.push(candidate);
  }
  return {
    project_doc_max_bytes: maxBytes,
    project_doc_fallback_filenames: fallbacks,
  };
}

/**
 * Read on every handshake: the file is rotated by atomic rename, so a revoked agent stops
 * being admitted without restarting the relay. Any read or parse failure yields an empty map.
 */
export async function loadAgentRegistry(path: string): Promise<Map<string, AgentIdentity>> {
  const identities = new Map<string, AgentIdentity>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    logEvent('terminal_relay_agent_registry_unreadable', { error: errorLabel(error) });
    return identities;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logEvent('terminal_relay_agent_registry_invalid', { reason: 'not_an_object' });
    return identities;
  }
  const document = parsed as Record<string, unknown>;
  if (document.version !== 1 || !Array.isArray(document.agents)) {
    logEvent('terminal_relay_agent_registry_invalid', { reason: 'unsupported_version' });
    return identities;
  }
  for (const entry of document.agents) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const fingerprint = stringField(record, 'fingerprint_sha256');
    const tenantId = stringField(record, 'tenant_id');
    const alias = stringField(record, 'alias');
    const expiresAt = stringField(record, 'expires_at');
    if (!fingerprint || !tenantId || !alias || !expiresAt || Number.isNaN(Date.parse(expiresAt))) continue;
    identities.set(normalizedFingerprint(fingerprint), {
      fingerprint_sha256: fingerprint,
      tenant_id: tenantId,
      alias,
      expires_at: expiresAt
    });
  }
  return identities;
}

export function parseAgentHello(payload: Buffer): AgentHello | undefined {
  let source: Record<string, unknown>;
  try {
    source = decodeJsonFrame(payload);
  } catch {
    return undefined;
  }
  if (source.v !== 1) return undefined;
  const tenantId = stringField(source, 'tenant_id');
  const alias = stringField(source, 'alias');
  const containerId = stringField(source, 'container_id');
  const imageId = stringField(source, 'image_id');
  const runtimeUser = stringField(source, 'runtime_user');
  const harness = stringField(source, 'harness');
  const agentVersion = stringField(source, 'agent_version');
  const generation = stringField(source, 'generation');
  const runtimeUid = integerField(source, 'runtime_uid');
  const modes = modesField(source);
  if (!tenantId || !alias || !containerId || !imageId || !runtimeUser || !harness || !agentVersion) return undefined;
  if (generation === undefined || runtimeUid === undefined || modes === undefined) return undefined;
  const home = rutaMedida(source, 'home');
  const codexHome = rutaMedida(source, 'codex_home');
  const claudeConfigDir = rutaMedida(source, 'claude_config_dir');
  const openclawWorkspace = rutaMedida(source, 'openclaw_workspace');
  let cwd = rutaMedida(source, 'cwd');
  let workspaceRoot = rutaMedida(source, 'workspace_root');
  let projectRoot = rutaMedida(source, 'project_root');
  const rawWorkspaceRoot = source.workspace_root;
  const rawProjectRoot = source.project_root;
  const workspacePairSafe = rawWorkspaceRoot === undefined
    || (workspaceRoot !== undefined && cwd !== undefined
      && (cwd === workspaceRoot || cwd.startsWith(`${workspaceRoot}/`)));
  const projectPairSafe = rawProjectRoot === undefined
    || (projectRoot !== undefined && cwd !== undefined
      && (cwd === projectRoot || cwd.startsWith(`${projectRoot}/`))
      && (workspaceRoot === undefined || projectRoot === workspaceRoot
        || projectRoot.startsWith(`${workspaceRoot}/`)));
  const contextFieldsSafe = (source.cwd === undefined || cwd !== undefined)
    && (rawWorkspaceRoot === undefined || workspaceRoot !== undefined)
    && (rawProjectRoot === undefined || projectRoot !== undefined)
    && workspacePairSafe && projectPairSafe;
  if (!contextFieldsSafe) {
    cwd = undefined;
    workspaceRoot = undefined;
    projectRoot = undefined;
  }
  const runtimeFactsObserved = source.runtime_facts_observed === true && contextFieldsSafe
    && home !== undefined
    && ((harness === 'codex' && codexHome !== undefined)
      || (harness === 'claude' && claudeConfigDir !== undefined)
      || (harness === 'openclaw' && openclawWorkspace !== undefined)
      || (harness === 'hermes' && cwd !== undefined && projectRoot !== undefined));
  return {
    tenant_id: tenantId,
    alias,
    container_id: containerId,
    generation,
    image_id: imageId,
    runtime_user: runtimeUser,
    runtime_uid: runtimeUid,
    harness,
    runtime_facts_observed: runtimeFactsObserved,
    // A marker without its effective root does not certify a partial fact. The alias keeps its
    // terminals, but the whole contextual family stays out of the normalized hello and presence.
    ...(runtimeFactsObserved ? {
      home,
      ...(harness === 'codex' && codexHome !== undefined ? { codex_home: codexHome } : {}),
      ...(harness === 'claude' && claudeConfigDir !== undefined ? { claude_config_dir: claudeConfigDir } : {}),
      ...(harness === 'openclaw' && openclawWorkspace !== undefined ? { openclaw_workspace: openclawWorkspace } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
      ...(projectRoot === undefined ? {} : { project_root: projectRoot }),
      ...codexProjectDocumentFields(source, harness),
    } : {}),
    agent_version: agentVersion,
    modes,
    features: featuresField(source)
  };
}

  /**
   * The `home` from the hello. Returns `undefined` both when missing and when malformed: it does
   * not invalidate the whole hello, because an agent without `home` still serves terminals —
   * it only loses directive reading, and the gateway says so in those words.
   */
function rutaMedida(source: Record<string, unknown>, campo: string): string | undefined {
  const valor = source[campo];
  if (typeof valor !== 'string') return undefined;
  if (!valor.startsWith('/') || valor === '/' || valor.includes('\0') || valor.length > 4096) return undefined;
  const segments = valor.split('/');
  if (segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return undefined;
  }
  return valor;
}

export function agentKey(tenantId: string, alias: string): string {
  return `${tenantId}\u0000${alias}`;
}

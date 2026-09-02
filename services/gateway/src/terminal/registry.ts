import { parseCodexProjectDocumentConfig } from '@cauce/protocol';
import type { AgentPresence, PtyState } from './types.js';

/**
 * In-memory view of the pty-agents reported by authenticated terminal-relay instances.
 *
 * A relay report is a complete snapshot for one certificate/process generation. Keeping the
 * instance boundary here prevents two live relays from silently overwriting the same alias.
 */

export const AGENT_STALE_AFTER_MS = 45_000;
const RELAY_INSTANCE_PATTERN = /^[0-9a-f]{64}$/;
const RELAY_BOOT_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface RelayProcessIdentity {
  readonly relay_instance_id: string;
  readonly relay_boot_id: string;
}

export interface AgentObservation {
  readonly presence: AgentPresence;
  readonly relay_instance_id: string;
  readonly relay_boot_id: string;
  readonly observed_at: string;
  readonly stale: boolean;
}

export type AgentResolution =
  | { readonly status: 'online'; readonly observation: AgentObservation }
  | { readonly status: 'ambiguous'; readonly relay_instance_ids: readonly string[] }
  | { readonly status: 'offline'; readonly observation: AgentObservation }
  | { readonly status: 'not_installed' | 'unknown' };

interface RelaySnapshot {
  readonly relayBootId: string;
  readonly observedAt: number;
  readonly agents: ReadonlyMap<string, AgentPresence>;
}

interface HistoricalObservation {
  readonly presence: AgentPresence;
  readonly relayInstanceId: string;
  readonly relayBootId: string;
  readonly observedAt: number;
}

export class RelayBootConflictError extends Error {
  constructor(readonly relayInstanceId: string) {
    super('another fresh terminal-relay process already owns this certificate identity');
    this.name = 'RelayBootConflictError';
  }
}

function key(tenantId: string, alias: string): string {
  return `${tenantId}:${alias}`;
}

function assertRelayIdentity(identity: RelayProcessIdentity): void {
  if (!RELAY_INSTANCE_PATTERN.test(identity.relay_instance_id)
      || !RELAY_BOOT_PATTERN.test(identity.relay_boot_id)) {
    throw new Error('terminal-relay process identity is invalid');
  }
}

function observation(historical: HistoricalObservation, stale: boolean): AgentObservation {
  return {
    presence: historical.presence,
    relay_instance_id: historical.relayInstanceId,
    relay_boot_id: historical.relayBootId,
    observed_at: new Date(historical.observedAt).toISOString(),
    stale,
  };
}

export class AgentRegistry {
  private readonly relays = new Map<string, RelaySnapshot>();
  private readonly history = new Map<string, HistoricalObservation>();
  private seededAt: number | undefined;

  /**
   * Replace one relay's complete snapshot. A second boot sharing the same fresh certificate is
   * rejected until the accepted report goes stale.
   */
  observe(
    identity: RelayProcessIdentity,
    agents: readonly AgentPresence[],
    now: number = Date.now(),
  ): void {
    assertRelayIdentity(identity);
    const prior = this.relays.get(identity.relay_instance_id);
    if (prior !== undefined && prior.relayBootId !== identity.relay_boot_id
        && now - prior.observedAt <= AGENT_STALE_AFTER_MS) {
      throw new RelayBootConflictError(identity.relay_instance_id);
    }

    const snapshot = new Map<string, AgentPresence>();
    for (const presence of agents) {
      const aliasKey = key(presence.tenant_id, presence.alias);
      if (snapshot.has(aliasKey)) throw new Error('terminal-relay presence contains a duplicate alias');
      snapshot.set(aliasKey, presence);
    }

    this.seededAt ??= now;
    this.relays.set(identity.relay_instance_id, {
      relayBootId: identity.relay_boot_id,
      observedAt: now,
      agents: snapshot,
    });
    for (const [aliasKey, presence] of snapshot) {
      const historical = this.history.get(aliasKey);
      if (historical === undefined || historical.observedAt <= now) {
        this.history.set(aliasKey, {
          presence,
          relayInstanceId: identity.relay_instance_id,
          relayBootId: identity.relay_boot_id,
          observedAt: now,
        });
      }
    }
  }

  /** True once at least one authenticated relay snapshot was accepted. */
  get seeded(): boolean {
    return this.seededAt !== undefined;
  }

  /** Exact current process identity, required by every session mutation after presence. */
  accepts(identity: RelayProcessIdentity, now: number = Date.now()): boolean {
    const relay = this.relays.get(identity.relay_instance_id);
    return relay?.relayBootId === identity.relay_boot_id
      && now - relay.observedAt <= AGENT_STALE_AFTER_MS;
  }

  /** Resolve one alias to exactly one fresh relay, or fail closed on duplicates. */
  resolve(tenantId: string, alias: string, now: number = Date.now()): AgentResolution {
    if (!this.seeded) return { status: 'unknown' };
    const aliasKey = key(tenantId, alias);
    const live: HistoricalObservation[] = [];
    for (const [relayInstanceId, relay] of this.relays) {
      if (now - relay.observedAt > AGENT_STALE_AFTER_MS) continue;
      const presence = relay.agents.get(aliasKey);
      if (presence === undefined) continue;
      live.push({
        presence,
        relayInstanceId,
        relayBootId: relay.relayBootId,
        observedAt: relay.observedAt,
      });
    }
    if (live.length === 1) {
      const single = live[0];
      if (single === undefined) throw new Error('terminal live observation is unavailable');
      return { status: 'online', observation: observation(single, false) };
    }
    if (live.length > 1) {
      return {
        status: 'ambiguous',
        relay_instance_ids: live.map((item) => item.relayInstanceId).sort(),
      };
    }
    const historical = this.history.get(aliasKey);
    return historical === undefined
      ? { status: 'not_installed' }
      : { status: 'offline', observation: observation(historical, true) };
  }

  get(tenantId: string, alias: string, now: number = Date.now()): AgentObservation | undefined {
    const resolved = this.resolve(tenantId, alias, now);
    return resolved.status === 'online' || resolved.status === 'offline'
      ? resolved.observation : undefined;
  }

  /** Ambiguous routing is rendered as offline by the existing console vocabulary. */
  state(tenantId: string, alias: string, now: number = Date.now()): PtyState {
    const resolved = this.resolve(tenantId, alias, now);
    if (resolved.status === 'online') return 'online';
    if (resolved.status === 'offline' || resolved.status === 'ambiguous') return 'agent_offline';
    return resolved.status;
  }

  snapshot(now: number = Date.now()): AgentObservation[] {
    const observations: AgentObservation[] = [];
    for (const historical of this.history.values()) {
      const resolved = this.resolve(historical.presence.tenant_id, historical.presence.alias, now);
      if (resolved.status === 'online' || resolved.status === 'offline') {
        observations.push(resolved.observation);
      }
    }
    return observations;
  }
}

function stringField(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`agent presence ${name} is invalid`);
  }
  return value;
}

function measuredPath(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  if (typeof value !== 'string' || !value.startsWith('/') || value === '/' || value.includes('\0')) {
    return undefined;
  }
  const checked = stringField(value, name, 4096);
  const segments = checked.split('/');
  return segments.slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
    ? undefined : checked;
}

function codexProjectDocumentFields(
  record: Record<string, unknown>,
  harness: string,
): Pick<AgentPresence, 'project_doc_max_bytes' | 'project_doc_fallback_filenames'> {
  const parsed = parseCodexProjectDocumentConfig({
    harness,
    maxBytes: record.project_doc_max_bytes,
    fallbackFilenames: record.project_doc_fallback_filenames,
  });
  if (parsed === undefined) return {};
  return {
    project_doc_max_bytes: parsed.maxBytes,
    project_doc_fallback_filenames: parsed.fallbackFilenames,
  };
}

/** Validates one relay-reported presence record; the relay is authenticated but not trusted blindly. */
export function parseAgentPresence(value: unknown): AgentPresence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('agent presence must be an object');
  }
  const record = value as Record<string, unknown>;
  const uid = record.runtime_uid;
  if (typeof uid !== 'number' || !Number.isSafeInteger(uid) || uid < 0) {
    throw new Error('agent presence runtime_uid is invalid');
  }
  const modes = record.modes;
  if (!Array.isArray(modes) || modes.some((mode) => typeof mode !== 'string')) {
    throw new Error('agent presence modes are invalid');
  }
  const harness = stringField(record.harness, 'harness', 64);
  const home = measuredPath(record, 'home');
  const codexHome = measuredPath(record, 'codex_home');
  const claudeConfigDir = measuredPath(record, 'claude_config_dir');
  const openclawWorkspace = measuredPath(record, 'openclaw_workspace');
  let cwd = measuredPath(record, 'cwd');
  let workspaceRoot = measuredPath(record, 'workspace_root');
  let projectRoot = measuredPath(record, 'project_root');
  const workspacePairSafe = record.workspace_root === undefined
    || (workspaceRoot !== undefined && cwd !== undefined
      && (cwd === workspaceRoot || cwd.startsWith(`${workspaceRoot}/`)));
  const projectPairSafe = record.project_root === undefined
    || (projectRoot !== undefined && cwd !== undefined
      && (cwd === projectRoot || cwd.startsWith(`${projectRoot}/`))
      && (workspaceRoot === undefined || projectRoot === workspaceRoot
        || projectRoot.startsWith(`${workspaceRoot}/`)));
  const contextFieldsSafe = (record.cwd === undefined || cwd !== undefined)
    && (record.workspace_root === undefined || workspaceRoot !== undefined)
    && (record.project_root === undefined || projectRoot !== undefined)
    && workspacePairSafe && projectPairSafe;
  if (!contextFieldsSafe) {
    cwd = undefined;
    workspaceRoot = undefined;
    projectRoot = undefined;
  }
  const runtimeFactsObserved = record.runtime_facts_observed === true && contextFieldsSafe
    && home !== undefined
    && ((harness === 'codex' && codexHome !== undefined)
      || (harness === 'claude' && claudeConfigDir !== undefined)
      || (harness === 'openclaw' && openclawWorkspace !== undefined)
      || (harness === 'hermes' && cwd !== undefined && projectRoot !== undefined));
  return {
    tenant_id: stringField(record.tenant_id, 'tenant_id', 64),
    alias: stringField(record.alias, 'alias', 64),
    container_id: stringField(record.container_id, 'container_id'),
    generation: stringField(record.generation, 'generation'),
    image_id: stringField(record.image_id, 'image_id'),
    runtime_user: stringField(record.runtime_user, 'runtime_user', 64),
    runtime_uid: uid,
    harness,
    runtime_facts_observed: runtimeFactsObserved,
    ...(runtimeFactsObserved ? {
      home: stringField(home, 'home', 4096),
      ...(harness === 'codex' ? { codex_home: stringField(codexHome, 'codex_home', 4096) } : {}),
      ...(harness === 'claude' ? { claude_config_dir: stringField(claudeConfigDir, 'claude_config_dir', 4096) } : {}),
      ...(harness === 'openclaw' ? { openclaw_workspace: stringField(openclawWorkspace, 'openclaw_workspace', 4096) } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
      ...(projectRoot === undefined ? {} : { project_root: projectRoot }),
      ...codexProjectDocumentFields(record, harness),
    } : {}),
    modes: (modes as string[]).slice(0, 8),
    connected_since: stringField(record.connected_since, 'connected_since', 64),
  };
}

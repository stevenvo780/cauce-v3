import type { AgentPresence, PtyState } from './types.js';

/**
 * In-memory view of the pty-agents terminal-relay currently holds. The gateway never talks to
 * the containers on kratos: the relay reports what it sees and this registry is the only
 * source of truth for `pty_state`. It is deliberately not persisted — if the gateway restarts
 * every target reads `unknown` until the relay reports again, which is the honest answer.
 */

export const AGENT_STALE_AFTER_MS = 45_000;

export interface AgentObservation {
  readonly presence: AgentPresence;
  readonly observed_at: string;
  readonly stale: boolean;
}

function key(tenantId: string, alias: string): string {
  return `${tenantId}:${alias}`;
}

export class AgentRegistry {
  private readonly entries = new Map<string, { presence: AgentPresence; observedAt: number }>();
  private lastReportAt: number | undefined;

  /** Fold one relay report. Aliases missing from the report simply go stale on their own. */
  observe(agents: readonly AgentPresence[], now: number = Date.now()): void {
    this.lastReportAt = now;
    for (const presence of agents) {
      this.entries.set(key(presence.tenant_id, presence.alias), { presence, observedAt: now });
    }
  }

  /** True once the relay has reported at least one time; false means the relay itself is silent. */
  get seeded(): boolean {
    return this.lastReportAt !== undefined;
  }

  get(tenantId: string, alias: string, now: number = Date.now()): AgentObservation | undefined {
    const entry = this.entries.get(key(tenantId, alias));
    if (!entry) return undefined;
    return {
      presence: entry.presence,
      observed_at: new Date(entry.observedAt).toISOString(),
      stale: now - entry.observedAt > AGENT_STALE_AFTER_MS
    };
  }

  /**
   * `not_installed` means no pty-agent was ever seen for that alias; `agent_offline` means one
   * was seen and stopped reporting. The console shows the difference verbatim so an operator
   * never faces a grey button without a motive.
   */
  state(tenantId: string, alias: string, now: number = Date.now()): PtyState {
    if (!this.seeded) return 'unknown';
    const observation = this.get(tenantId, alias, now);
    if (!observation) return 'not_installed';
    return observation.stale ? 'agent_offline' : 'online';
  }

  snapshot(now: number = Date.now()): AgentObservation[] {
    return [...this.entries.values()].map((entry) => ({
      presence: entry.presence,
      observed_at: new Date(entry.observedAt).toISOString(),
      stale: now - entry.observedAt > AGENT_STALE_AFTER_MS
    }));
  }
}

function stringField(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error(`agent presence ${name} is invalid`);
  }
  return value;
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
  return {
    tenant_id: stringField(record.tenant_id, 'tenant_id', 64),
    alias: stringField(record.alias, 'alias', 64),
    container_id: stringField(record.container_id, 'container_id'),
    generation: stringField(record.generation, 'generation'),
    image_id: stringField(record.image_id, 'image_id'),
    runtime_user: stringField(record.runtime_user, 'runtime_user', 64),
    runtime_uid: uid,
    harness: stringField(record.harness, 'harness', 64),
    // Opcional y validado: si viene, tiene que ser una ruta absoluta. Un `home` relativo o vacío
    // se descarta en vez de tumbar la presencia, porque con él se resuelven rutas de ficheros que
    // después se leen del disco de un contenedor.
    ...(typeof record.home === 'string' && record.home.startsWith('/')
      ? { home: stringField(record.home, 'home', 512) }
      : {}),
    modes: (modes as string[]).slice(0, 8),
    connected_since: stringField(record.connected_since, 'connected_since', 64)
  };
}

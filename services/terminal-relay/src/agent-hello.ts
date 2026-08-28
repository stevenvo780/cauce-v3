import { readFile } from 'node:fs/promises';
import { decodeJsonFrame } from './framing.js';
import type { TerminalMode } from './gateway-client.js';
import { errorLabel, logEvent } from './log.js';

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
  /** True sólo cuando el launcher observó al proceso real; ausente/false no acredita rutas. */
  readonly runtime_facts_observed?: boolean;
  /** `HOME` del proceso del arnés dentro del contenedor. Opcional para retrocompatibilidad. */
  readonly home?: string;
  /** Alias-scoped harness roots measured from the live adapter process, never inferred by relay. */
  readonly codex_home?: string;
  readonly claude_config_dir?: string;
  readonly openclaw_workspace?: string;
  /** Contexto efectivo medido; opcional para agentes anteriores durante rollout. */
  readonly cwd?: string;
  readonly workspace_root?: string;
  readonly project_root?: string;
  /** Proyección cerrada de config.toml; ambos campos viajan juntos y sólo para Codex. */
  readonly project_doc_max_bytes?: number;
  readonly project_doc_fallback_filenames?: readonly string[];
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
  /**
   * Capacidades OPCIONALES que el agente declara. Un agente anterior a la lectura de gobierno no
   * manda el campo, y entonces esto es `[]`: nadie le manda nunca un READ. No es cosmética —
   * `_dispatch` del pty-agent trata un tag desconocido como violación de protocolo y se tira la
   * conexión encima, con TODAS sus terminales abiertas. Desplegar el relay antes que el agente
   * sin esta comprobación dejaría la flota sin terminales.
   */
  readonly features: readonly string[];
}

/** El agente declara esto cuando sabe contestar TAG_READ. Sin la marca, no se le pregunta. */
export const FEATURE_READ_GOVERNANCE = 'read_governance';
/** READ_OK/READ_DATA terminan únicamente cuando llega READ_DONE. Obligatorio para índices. */
export const FEATURE_READ_GOVERNANCE_DONE = 'read_governance_done_v1';
/** Escritura atómica/CAS. El sufijo versiona explícitamente el protocolo y sus precondiciones. */
export const FEATURE_WRITE_GOVERNANCE = 'write_governance_v1';
/** Perfil completo: preflight de todos los ficheros y rollback total dentro del pty-agent. */
export const FEATURE_WRITE_GOVERNANCE_BATCH = 'write_governance_batch_v1';
/** Permite frenar una sola PTY sin congelar PONG, lecturas ni las otras sesiones multiplexadas. */
export const FEATURE_SESSION_OUTPUT_FLOW_CONTROL = 'session_output_flow_control';
/** Memoria propia máxima encima del writable buffer de Node mientras el TLS espera `drain`. */
export const MAX_AGENT_WRITE_QUEUE_BYTES = 512 * 1024;
/** Reserved above the data quota for CLOSE frames. Exhausting it drops TLS so the agent kills all children. */
export const MAX_AGENT_CRITICAL_QUEUE_BYTES = 64 * 1024;
/** Una conexión corresponde a un alias: este tope es, por construcción, por alias. */
export const MAX_AGENT_READS_IN_FLIGHT = 4;
/** Al llenarse se rota la conexión: nunca se olvida un terminal id mientras el socket siga vivo. */
export const MAX_TERMINAL_READ_TOMBSTONES = 1_024;

/**
 * Una lectura en vuelo. Es una transacción suelta, no una sesión: el agente contesta un READ_OK
 * con los metadatos (incluido cuántos READ_DATA vienen detrás), luego los datos, y ahí acaba.
 */
export interface AgentReadHandlers {
  onReadOk(metadata: Record<string, unknown>): void;
  onReadData(chunk: Buffer): void;
  onReadDone(metadata: Record<string, unknown>): void;
  onReadErr(failure: { readonly code: string; readonly reason: string }): void;
  /** La conexión murió con la lectura a medias; no va a llegar ni OK ni ERR. */
  onAgentGone(reason: string): void;
}

export interface AgentWriteHandlers {
  onWriteOk(ack: Record<string, unknown>): void;
  onWriteErr(failure: { readonly code: string; readonly reason: string }): void;
  /** La conexión murió antes del ACK; el llamador conserva la precondición para reintentar. */
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

export function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function integerField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
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
 * A diferencia de `modesField`, esto NO invalida el hello: un agente viejo no manda `features` y
 * tiene que seguir entrando. Ausente o mal formado se lee como «ninguna capacidad», que es el
 * lado seguro — a ese agente no se le manda un READ jamás.
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
    && !value.includes('..') && !Array.from(value).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
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
    // Un marker sin su raíz efectiva no acredita un hecho parcial. El alias conserva terminales,
    // pero toda la familia contextual queda fuera del hello normalizado y de la presencia.
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
 * `home` del saludo. Devuelve `undefined` tanto si no viene como si viene mal: no invalida el
 * saludo entero, porque un agente sin `home` sigue sirviendo terminales — sólo se queda sin
 * lectura de directiva, y el gateway lo dice con esas palabras.
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

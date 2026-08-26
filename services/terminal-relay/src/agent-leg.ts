import { readFile } from 'node:fs/promises';
import { createServer, type Server as TlsServer, type TLSSocket } from 'node:tls';
import {
  decodeDataFrame, decodeJsonFrame, encodeDataFrame, encodeFrame, encodeJsonFrame,
  FrameDecoder, FramingError, FRAME_TAGS, MAX_DATA_BYTES, type Frame
} from './framing.js';
import type { AgentPresence, TerminalMode } from './gateway-client.js';
import { errorLabel, logEvent, shortFingerprint } from './log.js';

/**
 * Agent leg. PTY agents live inside containers on another host (`kratos`) and dial OUT to the
 * relay; the relay never dials in. There is no route from here to a container and creating one
 * would be a privilege escalation, so an agent that is not connected is simply offline.
 *
 * Two independent gates admit an agent: mutual TLS against the agent CA, and a SHA-256
 * fingerprint listed in the identity registry with a matching tenant/alias and a live
 * `expires_at`. A missing or malformed registry admits nobody.
 */

export const AGENT_PING_INTERVAL_MS = 10_000;
export const AGENT_PONG_TIMEOUT_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;

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
  /**
   * `HOME` del proceso del arnés dentro del contenedor. OPCIONAL: un pty-agent anterior a
   * 2026-08-25 no lo manda, y exigirlo le rechazaría el saludo —dejándolo sin terminales— por un
   * campo que sólo hace falta para leer su directiva.
   */
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

export interface AgentLookup {
  lookup(tenantId: string, alias: string): AgentConnection | undefined;
}

function normalizedFingerprint(value: string): string {
  return value.replace(/:/g, '').toUpperCase();
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerField(source: Record<string, unknown>, name: string): number | undefined {
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
    && !value.includes('..') && ![...value].some((character) => {
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
      ...(harness === 'codex' ? { codex_home: codexHome! } : {}),
      ...(harness === 'claude' ? { claude_config_dir: claudeConfigDir! } : {}),
      ...(harness === 'openclaw' ? { openclaw_workspace: openclawWorkspace! } : {}),
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

/** One live agent socket. Frame routing to sessions lives here so the leg stays a registry. */
export class AgentConnection {
  readonly hello: AgentHello;
  readonly fingerprint: string;
  readonly connectedAt: Date;
  private readonly socket: TLSSocket;
  private readonly sessions = new Map<string, AgentSessionHandlers>();
  /** Lecturas de gobierno en vuelo, por `request_id`. Vacío casi siempre. */
  private readonly reads = new Map<string, AgentReadHandlers>();
  /** Operaciones cerradas correctamente/por READ_ERR; nunca crece sin límite. */
  private readonly terminalReads = new Set<string>();
  /** Escrituras gobernadas en vuelo. Separadas de PTY y de lectura por negociación de capacidad. */
  private readonly writes = new Map<string, AgentWriteHandlers>();
  private readonly ping: NodeJS.Timeout;
  private lastPongAt: number;
  private queuedWrites: Buffer[] = [];
  private queuedWriteBytes = 0;
  private waitingDrain = false;
  private closed = false;

  constructor(socket: TLSSocket, hello: AgentHello, fingerprint: string, now: () => number) {
    this.socket = socket;
    this.hello = hello;
    this.fingerprint = fingerprint;
    this.connectedAt = new Date(now());
    this.lastPongAt = now();
    this.ping = setInterval(() => {
      if (now() - this.lastPongAt > AGENT_PONG_TIMEOUT_MS) {
        this.destroy('pong_timeout');
        return;
      }
      void this.write(encodeFrame(FRAME_TAGS.PING));
    }, AGENT_PING_INTERVAL_MS);
    this.ping.unref?.();
  }

  get key(): string {
    return agentKey(this.hello.tenant_id, this.hello.alias);
  }

  get container(): string {
    return this.hello.container_id;
  }

  get alive(): boolean {
    return !this.closed;
  }

  presence(): AgentPresence {
    return {
      tenant_id: this.hello.tenant_id,
      alias: this.hello.alias,
      container_id: this.hello.container_id,
      generation: this.hello.generation,
      image_id: this.hello.image_id,
      runtime_user: this.hello.runtime_user,
      runtime_uid: this.hello.runtime_uid,
      harness: this.hello.harness,
      ...(this.hello.runtime_facts_observed === undefined
        ? {} : { runtime_facts_observed: this.hello.runtime_facts_observed }),
      // Se propaga sólo si vino. El gateway lo necesita para componer la ruta del fichero de
      // gobierno; sin él contesta «contenedor sin identificar» en vez de adivinar una ruta.
      ...(this.hello.home === undefined ? {} : { home: this.hello.home }),
      ...(this.hello.codex_home === undefined ? {} : { codex_home: this.hello.codex_home }),
      ...(this.hello.claude_config_dir === undefined
        ? {} : { claude_config_dir: this.hello.claude_config_dir }),
      ...(this.hello.openclaw_workspace === undefined
        ? {} : { openclaw_workspace: this.hello.openclaw_workspace }),
      ...(this.hello.cwd === undefined ? {} : { cwd: this.hello.cwd }),
      ...(this.hello.workspace_root === undefined
        ? {} : { workspace_root: this.hello.workspace_root }),
      ...(this.hello.project_root === undefined
        ? {} : { project_root: this.hello.project_root }),
      ...(this.hello.project_doc_max_bytes === undefined
        ? {} : { project_doc_max_bytes: this.hello.project_doc_max_bytes }),
      ...(this.hello.project_doc_fallback_filenames === undefined
        ? {} : { project_doc_fallback_filenames: this.hello.project_doc_fallback_filenames }),
      agent_version: this.hello.agent_version,
      modes: this.hello.modes,
      connected_since: this.connectedAt.toISOString()
    };
  }

  attachSession(sessionId: string, handlers: AgentSessionHandlers): void {
    this.sessions.set(sessionId, handlers);
  }

  detachSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Falso para todo agente que no lo anuncie, incluido cualquiera anterior a esta versión. */
  get supportsGovernanceRead(): boolean {
    return this.hello.features.includes(FEATURE_READ_GOVERNANCE);
  }

  get supportsGovernanceReadDone(): boolean {
    return this.hello.features.includes(FEATURE_READ_GOVERNANCE_DONE);
  }

  get supportsGovernanceWrite(): boolean {
    return this.hello.features.includes(FEATURE_WRITE_GOVERNANCE);
  }

  get supportsGovernanceWriteBatch(): boolean {
    return this.hello.features.includes(FEATURE_WRITE_GOVERNANCE_BATCH);
  }

  get supportsSessionOutputFlowControl(): boolean {
    return this.hello.features.includes(FEATURE_SESSION_OUTPUT_FLOW_CONTROL);
  }

  attachRead(requestId: string, handlers: AgentReadHandlers): boolean {
    if (this.closed || this.reads.has(requestId) || this.terminalReads.has(requestId)
        || this.reads.size >= MAX_AGENT_READS_IN_FLIGHT) return false;
    this.reads.set(requestId, handlers);
    return true;
  }

  detachRead(requestId: string, terminal = false): void {
    this.reads.delete(requestId);
    if (!terminal) return;
    this.terminalReads.delete(requestId);
    if (this.terminalReads.size >= MAX_TERMINAL_READ_TOMBSTONES) {
      // Evictar el más viejo permitiría tirar en silencio un DATA tardío de ese id. Se cierra el
      // transporte y el agente reconecta limpio; así el límite de memoria no debilita el orden.
      this.destroy('read_tombstone_capacity');
      return;
    }
    this.terminalReads.add(requestId);
  }

  attachWrite(requestId: string, handlers: AgentWriteHandlers): void {
    this.writes.set(requestId, handlers);
  }

  detachWrite(requestId: string): void {
    this.writes.delete(requestId);
  }

  /**
   * Pide un fichero de gobierno. El `requestId` viaja también como prefijo de 36 bytes de los
   * READ_DATA, así que tiene que ser un UUID en minúsculas con guiones o el agente no podrá
   * codificar la respuesta.
   */
  sendRead(requestId: string, kind: 'file' | 'dir', path: string): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.READ, { request_id: requestId, kind, path }));
  }

  /**
   * Envía una transacción completa. La precondición vive en WRITE y el contenido binario en
   * WRITE_DATA; no se interpola en argv, JSON de shell ni ningún comando.
   */
  sendWrite(
    requestId: string,
    path: string,
    operation: 'replace' | 'create',
    expectedSha: string | undefined,
    contentSha: string,
    content: Buffer
  ): boolean {
    if (!this.supportsGovernanceWrite) return false;
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < content.byteLength; offset += MAX_DATA_BYTES) {
      chunks.push(encodeDataFrame(
        FRAME_TAGS.WRITE_DATA,
        requestId,
        content.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    const begin = encodeJsonFrame(FRAME_TAGS.WRITE, {
      request_id: requestId,
      path,
      operation,
      ...(expectedSha === undefined ? {} : { expected_sha: expectedSha }),
      content_sha: contentSha,
      bytes: content.byteLength,
      chunks: chunks.length
    });
    return this.writeBatch([begin, ...chunks]);
  }

  cancelWrite(requestId: string): void {
    if (!this.supportsGovernanceWrite) return;
    void this.write(encodeJsonFrame(FRAME_TAGS.WRITE_CANCEL, { request_id: requestId }));
  }

  /**
   * Envía el perfil como una sola transacción. Los DATA van en el mismo orden que `entries`, y el
   * agente no preflighta ni toca disco hasta haber recibido/verificado todos sus digests.
   */
  sendGovernanceWriteBatch(requestId: string, entries: readonly AgentGovernanceBatchEntry[]): boolean {
    if (!this.supportsGovernanceWriteBatch) return false;
    const frames: Buffer[] = [];
    const metadata = entries.map((entry) => {
      if (entry.mode === 'verify') {
        return {
          path: entry.path,
          mode: entry.mode,
          operation: entry.operation,
          ...(entry.expectedSha === undefined ? {} : { expected_sha: entry.expectedSha }),
          bytes: 0,
          chunks: 0,
        };
      }
      let chunks = 0;
      for (let offset = 0; offset < entry.content.byteLength; offset += MAX_DATA_BYTES) {
        frames.push(encodeDataFrame(
          FRAME_TAGS.WRITE_BATCH_DATA,
          requestId,
          entry.content.subarray(offset, offset + MAX_DATA_BYTES)
        ));
        chunks += 1;
      }
      return {
        path: entry.path,
        mode: entry.mode,
        operation: entry.operation,
        ...(entry.expectedSha === undefined ? {} : { expected_sha: entry.expectedSha }),
        content_sha: entry.contentSha,
        bytes: entry.content.byteLength,
        chunks,
      };
    });
    const begin = encodeJsonFrame(FRAME_TAGS.WRITE_BATCH, { request_id: requestId, entries: metadata });
    return this.writeBatch([begin, ...frames]);
  }

  cancelGovernanceWriteBatch(requestId: string): void {
    if (!this.supportsGovernanceWriteBatch) return;
    void this.write(encodeJsonFrame(FRAME_TAGS.WRITE_BATCH_CANCEL, { request_id: requestId }));
  }

  sendOpen(sessionId: string, ticket: string, mode: TerminalMode, cols: number, rows: number): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.OPEN, { session_id: sessionId, ticket, mode, cols, rows }));
  }

  /** Chunked to the wire limit. `false` means the bounded TLS queue refused more input. */
  sendStdin(sessionId: string, data: Buffer): boolean {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_BYTES) {
      frames.push(encodeDataFrame(
        FRAME_TAGS.STDIN,
        sessionId,
        data.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    return this.writeBatch(frames);
  }

  /** Respuesta técnica ya validada; el tag separado mantiene STDIN fuera de los viewers. */
  sendTerminalResponse(sessionId: string, data: Buffer): boolean {
    const frames: Buffer[] = [];
    for (let offset = 0; offset < data.byteLength; offset += MAX_DATA_BYTES) {
      frames.push(encodeDataFrame(
        FRAME_TAGS.TERMINAL_RESPONSE,
        sessionId,
        data.subarray(offset, offset + MAX_DATA_BYTES)
      ));
    }
    return this.writeBatch(frames);
  }

  sendResize(sessionId: string, cols: number, rows: number): void {
    void this.write(encodeJsonFrame(FRAME_TAGS.RESIZE, { session_id: sessionId, cols, rows }));
  }

  sendClose(sessionId: string, reason: string): boolean {
    const accepted = this.writeCritical(encodeJsonFrame(FRAME_TAGS.CLOSE, { session_id: sessionId, reason }));
    if (!accepted) this.destroy('critical_close_backpressure');
    return accepted;
  }

  pauseSessionOutput(sessionId: string): boolean {
    if (!this.supportsSessionOutputFlowControl) return false;
    return this.write(encodeJsonFrame(FRAME_TAGS.PAUSE_OUTPUT, { session_id: sessionId }));
  }

  resumeSessionOutput(sessionId: string): boolean {
    if (!this.supportsSessionOutputFlowControl) return false;
    return this.write(encodeJsonFrame(FRAME_TAGS.RESUME_OUTPUT, { session_id: sessionId }));
  }

  destroy(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.ping);
    // Las lecturas en vuelo se avisan igual que las sesiones: si no, se quedan esperando hasta
    // que venza su temporizador y el que pregunta ve «tardó» donde lo que pasó fue «se cayó».
    const handlers = [...this.sessions.values(), ...this.reads.values(), ...this.writes.values()];
    this.sessions.clear();
    this.reads.clear();
    this.terminalReads.clear();
    this.writes.clear();
    this.queuedWrites = [];
    this.queuedWriteBytes = 0;
    this.waitingDrain = false;
    this.socket.destroy();
    for (const handler of handlers) {
      try {
        handler.onAgentGone(reason);
      } catch (error) {
        logEvent('terminal_relay_agent_gone_handler_failed', { error: errorLabel(error) });
      }
    }
  }

  /** Called by the leg for every decoded frame after HELLO_ACK. */
  handleFrame(frame: Frame, now: () => number): void {
    if (frame.tag === FRAME_TAGS.PONG) {
      this.lastPongAt = now();
      return;
    }
    if (frame.tag === FRAME_TAGS.STDOUT) {
      const data = decodeDataFrame(frame.payload);
      this.dispatch(data.sessionId, (handlers) => handlers.onStdout(data.data));
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_OK) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_OK without a session id');
      const pid = integerField(body, 'pid') ?? 0;
      this.dispatch(sessionId, (handlers) => handlers.onOpenOk(pid));
      return;
    }
    if (frame.tag === FRAME_TAGS.OPEN_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('OPEN_ERR without a session id');
      this.dispatch(sessionId, (handlers) => handlers.onOpenErr(stringField(body, 'reason') ?? 'open_failed'));
      return;
    }
    if (frame.tag === FRAME_TAGS.CLOSED) {
      const body = decodeJsonFrame(frame.payload);
      const sessionId = stringField(body, 'session_id');
      if (sessionId === undefined) throw new FramingError('CLOSED without a session id');
      const exitCode = integerField(body, 'exit_code');
      this.dispatch(sessionId, (handlers) => handlers.onClosed({
        exit_code: exitCode === undefined ? null : exitCode,
        signal: stringField(body, 'signal') ?? null,
        reason: stringField(body, 'reason') ?? 'agent_closed'
      }));
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_OK without a request id');
      this.dispatchRead(requestId, 'ok', (handlers) => handlers.onReadOk(body));
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_ERR without a request id');
      this.dispatchRead(requestId, 'error', (handlers) => handlers.onReadErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'read_failed'
      }));
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_DATA) {
      // Mismo prefijo de 36 bytes que STDOUT, pero lo que lleva es el `request_id`.
      const data = decodeDataFrame(frame.payload);
      this.dispatchRead(data.sessionId, 'data', (handlers) => handlers.onReadData(data.data));
      return;
    }
    if (frame.tag === FRAME_TAGS.READ_DONE) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('READ_DONE without a request id');
      this.dispatchRead(requestId, 'done', (handlers) => handlers.onReadDone(body));
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_OK without a request id');
      this.dispatchWrite(requestId, (handlers) => handlers.onWriteOk(body));
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_ERR without a request id');
      this.dispatchWrite(requestId, (handlers) => handlers.onWriteErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'write_failed'
      }));
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_BATCH_OK) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_BATCH_OK without a request id');
      this.dispatchWrite(requestId, (handlers) => handlers.onWriteOk(body));
      return;
    }
    if (frame.tag === FRAME_TAGS.WRITE_BATCH_ERR) {
      const body = decodeJsonFrame(frame.payload);
      const requestId = stringField(body, 'request_id');
      if (requestId === undefined) throw new FramingError('WRITE_BATCH_ERR without a request id');
      this.dispatchWrite(requestId, (handlers) => handlers.onWriteErr({
        code: stringField(body, 'error') ?? 'unknown',
        reason: stringField(body, 'reason') ?? 'write_batch_failed'
      }));
      return;
    }
    // AGENT_HELLO after the handshake, or any frame only the relay may send, is a violation.
    throw new FramingError('unexpected frame from the agent');
  }

  private dispatchRead(
    requestId: string,
    frame: 'ok' | 'data' | 'done' | 'error',
    apply: (handlers: AgentReadHandlers) => void,
  ): void {
    const handlers = this.reads.get(requestId);
    if (!handlers) {
      // Un id inventado o una lectura abandonada por timeout no compromete las PTY. En cambio,
      // DATA después de un cierre terminal contradice el orden TCP acreditado: la conexión queda
      // degradada y se cierra, en vez de aceptar éxito y tirar silenciosamente la evidencia.
      if (frame === 'data' && this.terminalReads.has(requestId)) {
        this.destroy('read_data_after_terminal');
        throw new FramingError('READ_DATA after terminal read frame');
      }
      return;
    }
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_read_handler_failed', { request_id: requestId, error: errorLabel(error) });
    }
  }

  private dispatchWrite(requestId: string, apply: (handlers: AgentWriteHandlers) => void): void {
    const handlers = this.writes.get(requestId);
    // ACK tardío después de timeout/cancelación: se descarta sin afectar las PTY multiplexadas.
    if (!handlers) return;
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_write_handler_failed', { request_id: requestId, error: errorLabel(error) });
    }
  }

  private dispatch(sessionId: string, apply: (handlers: AgentSessionHandlers) => void): void {
    const handlers = this.sessions.get(sessionId);
    // Frames for a session we already closed are stale, not fatal: drop them.
    if (!handlers) return;
    try {
      apply(handlers);
    } catch (error) {
      logEvent('terminal_relay_session_handler_failed', { session_id: sessionId, error: errorLabel(error) });
    }
  }

  /**
   * Node acepta la trama que hace que `write()` devuelva false; sólo las siguientes esperan
   * `drain`. La cola propia está acotada para que un browser que pega más rápido que el TLS no
   * convierta al relay en almacenamiento. No se pausa nunca el lado legible del socket.
   */
  private write(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    if (this.waitingDrain) {
      if (this.queuedWriteBytes + frame.byteLength > MAX_AGENT_WRITE_QUEUE_BYTES) return false;
      this.queuedWrites.push(frame);
      this.queuedWriteBytes += frame.byteLength;
      return true;
    }
    if (!this.socket.write(frame)) {
      this.waitingDrain = true;
      this.socket.once('drain', () => this.flushWrites());
    }
    return true;
  }

  /**
   * CLOSE may not be silently discarded behind PTY/data traffic. A small reserved tail accepts
   * every close for the bounded session set; if even that cannot fit, destroying TLS is the safe
   * signal because the pty-agent's teardown SIGHUPs and then SIGKILLs every child.
   */
  private writeCritical(frame: Buffer): boolean {
    if (this.closed || this.socket.destroyed) return false;
    if (this.waitingDrain) {
      if (this.queuedWriteBytes + frame.byteLength >
          MAX_AGENT_WRITE_QUEUE_BYTES + MAX_AGENT_CRITICAL_QUEUE_BYTES) return false;
      this.queuedWrites.push(frame);
      this.queuedWriteBytes += frame.byteLength;
      return true;
    }
    if (!this.socket.write(frame)) {
      this.waitingDrain = true;
      this.socket.once('drain', () => this.flushWrites());
    }
    return true;
  }

  /** Preflight de una transacción: nunca deja media escritura en la cola propia acotada. */
  private writeBatch(frames: readonly Buffer[]): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const total = frames.reduce((bytes, frame) => bytes + frame.byteLength, 0);
    if (this.waitingDrain && this.queuedWriteBytes + total > MAX_AGENT_WRITE_QUEUE_BYTES) return false;
    for (const frame of frames) {
      if (!this.write(frame)) return false;
    }
    return true;
  }

  private flushWrites(): void {
    if (this.closed || this.socket.destroyed) return;
    this.waitingDrain = false;
    while (this.queuedWrites.length > 0) {
      const frame = this.queuedWrites.shift();
      if (frame === undefined) break;
      this.queuedWriteBytes -= frame.byteLength;
      if (!this.socket.write(frame)) {
        this.waitingDrain = true;
        this.socket.once('drain', () => this.flushWrites());
        return;
      }
    }
  }
}

export function agentKey(tenantId: string, alias: string): string {
  return `${tenantId}\u0000${alias}`;
}

export interface AgentTlsMaterial {
  readonly cert: Buffer | string;
  readonly key: Buffer | string;
  readonly ca: Buffer | string;
}

/**
 * The agent listener always demands and verifies a client certificate. This factory exists so
 * that no caller — production wiring or test — can accidentally stand up an anonymous listener.
 */
export function createAgentTlsServer(material: AgentTlsMaterial): TlsServer {
  return createServer({
    cert: material.cert,
    key: material.key,
    ca: material.ca,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2'
  });
}

export interface AgentLegOptions {
  readonly server: TlsServer;
  readonly registryFile: string;
  readonly now?: () => number;
  /** Fired when an agent connects or drops, so presence can be published without waiting a tick. */
  readonly onChange?: () => void;
}

export class AgentLeg implements AgentLookup {
  private readonly server: TlsServer;
  private readonly registryFile: string;
  private readonly now: () => number;
  private readonly onChange: (() => void) | undefined;
  private readonly connections = new Map<string, AgentConnection>();

  constructor(options: AgentLegOptions) {
    this.server = options.server;
    this.registryFile = options.registryFile;
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange;
    this.server.on('secureConnection', (socket) => {
      void this.accept(socket);
    });
  }

  lookup(tenantId: string, alias: string): AgentConnection | undefined {
    const connection = this.connections.get(agentKey(tenantId, alias));
    return connection?.alive === true ? connection : undefined;
  }

  presence(): AgentPresence[] {
    return [...this.connections.values()].filter((connection) => connection.alive).map((connection) => connection.presence());
  }

  async close(): Promise<void> {
    for (const connection of [...this.connections.values()]) connection.destroy('relay_shutdown');
    this.connections.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async accept(socket: TLSSocket): Promise<void> {
    socket.on('error', () => socket.destroy());
    const certificate = socket.getPeerCertificate();
    const fingerprint = typeof certificate.fingerprint256 === 'string' ? certificate.fingerprint256 : '';
    if (!socket.authorized || fingerprint === '') {
      logEvent('terminal_relay_agent_rejected', { reason: 'unverified_certificate' });
      socket.destroy();
      return;
    }
    const registry = await loadAgentRegistry(this.registryFile);
    const identity = registry.get(normalizedFingerprint(fingerprint));
    if (!identity) {
      logEvent('terminal_relay_agent_rejected', { reason: 'unknown_fingerprint', fingerprint: shortFingerprint(fingerprint) });
      socket.destroy();
      return;
    }
    if (Date.parse(identity.expires_at) <= this.now()) {
      logEvent('terminal_relay_agent_rejected', {
        reason: 'identity_expired', alias: identity.alias, fingerprint: shortFingerprint(fingerprint)
      });
      socket.destroy();
      return;
    }
    this.readFrames(socket, identity, fingerprint);
  }

  private readFrames(socket: TLSSocket, identity: AgentIdentity, fingerprint: string): void {
    const decoder = new FrameDecoder();
    let connection: AgentConnection | undefined;
    const hello = setTimeout(() => {
      if (!connection) socket.destroy();
    }, HELLO_TIMEOUT_MS);
    hello.unref?.();
    const fail = (reason: string): void => {
      clearTimeout(hello);
      logEvent('terminal_relay_agent_rejected', { reason, alias: identity.alias, fingerprint: shortFingerprint(fingerprint) });
      if (connection) connection.destroy(reason);
      else socket.destroy();
    };
    socket.on('data', (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.push(chunk);
      } catch (error) {
        fail(error instanceof FramingError ? 'framing_violation' : 'decode_failed');
        return;
      }
      for (const frame of frames) {
        try {
          if (!connection) {
            if (frame.tag !== FRAME_TAGS.AGENT_HELLO) {
              fail('hello_expected');
              return;
            }
            connection = this.admit(socket, frame, identity, fingerprint);
            if (!connection) return;
            clearTimeout(hello);
            continue;
          }
          connection.handleFrame(frame, this.now);
        } catch (error) {
          logEvent('terminal_relay_agent_frame_failed', { alias: identity.alias, error: errorLabel(error) });
          fail('frame_failed');
          return;
        }
      }
    });
    socket.on('close', () => {
      clearTimeout(hello);
      if (!connection) return;
      const current = this.connections.get(connection.key);
      if (current === connection) this.connections.delete(connection.key);
      connection.destroy('agent_disconnected');
      logEvent('terminal_relay_agent_disconnected', { tenant_id: identity.tenant_id, alias: identity.alias });
      this.announce();
    });
  }

  private admit(socket: TLSSocket, frame: Frame, identity: AgentIdentity, fingerprint: string): AgentConnection | undefined {
    const hello = parseAgentHello(frame.payload);
    if (!hello) {
      socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: false, reason: 'invalid_hello' }));
      logEvent('terminal_relay_agent_rejected', { reason: 'invalid_hello', fingerprint: shortFingerprint(fingerprint) });
      socket.destroy();
      return undefined;
    }
    // The certificate names the agent; the hello only restates it. A mismatch is an attempt to
    // borrow another alias' identity, so it never gets a session.
    if (hello.tenant_id !== identity.tenant_id || hello.alias !== identity.alias) {
      socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: false, reason: 'identity_mismatch' }));
      logEvent('terminal_relay_agent_rejected', {
        reason: 'identity_mismatch', alias: identity.alias, fingerprint: shortFingerprint(fingerprint)
      });
      socket.destroy();
      return undefined;
    }
    const connection = new AgentConnection(socket, hello, fingerprint, this.now);
    const previous = this.connections.get(connection.key);
    if (previous && previous !== connection) previous.destroy('superseded');
    this.connections.set(connection.key, connection);
    socket.write(encodeJsonFrame(FRAME_TAGS.HELLO_ACK, { ok: true }));
    logEvent('terminal_relay_agent_connected', {
      tenant_id: hello.tenant_id,
      alias: hello.alias,
      container_id: hello.container_id,
      generation: hello.generation,
      runtime_user: hello.runtime_user,
      fingerprint: shortFingerprint(fingerprint)
    });
    this.announce();
    return connection;
  }

  private announce(): void {
    try {
      this.onChange?.();
    } catch (error) {
      logEvent('terminal_relay_presence_change_failed', { error: errorLabel(error) });
    }
  }
}

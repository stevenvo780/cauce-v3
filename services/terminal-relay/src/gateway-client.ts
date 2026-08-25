import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import type { AgentConnection, AgentGovernanceBatchEntry } from './agent-leg.js';
import { errorLabel, logEvent } from './log.js';

/**
 * The relay has no authority of its own: every allow/deny decision is an HTTPS round trip to
 * the gateway. Ticket verification in particular stays there — the relay never holds the
 * signing key, so a compromised relay cannot mint a session.
 */

export type TerminalMode = 'shell' | 'harness';

export interface TerminalSessionGrant {
  readonly tenant_id: string;
  readonly alias: string;
  readonly mode: TerminalMode;
  readonly cols: number;
  readonly rows: number;
  readonly operator_id: string;
  readonly container: string;
  readonly runtime_user: string;
  readonly session_expires_at: string;
  /** Gateway-signed continuity credential. It never reaches the pty-agent or persistent browser storage. */
  readonly resume_token: string;
}

export type ConsumeOutcome =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant }
  | { readonly status: 'ticket_invalid' | 'conflict' | 'forbidden' | 'unavailable' };

export type ResumeOutcome =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant }
  | { readonly status: 'resume_invalid' | 'forbidden' | 'unavailable' };

/** `unreachable` is not an allow: the caller counts it against the fail-closed grace window. */
export type AuthzOutcome = 'allow' | 'revoked' | 'unreachable';

export interface SessionCloseReport {
  readonly reason: string;
  readonly exit_code: number | null;
  readonly bytes_in: number;
  readonly bytes_out: number;
}

export interface AgentPresence {
  readonly tenant_id: string;
  readonly alias: string;
  readonly container_id: string;
  /**
   * Opaque container generation: the 32 hex chars of sha256(Id|StartedAt|RestartCount) that the
   * pty-agent launcher publishes. It is a STRING, not a counter — the gateway stores it in a
   * `text` column, the ticket signs it byte for byte and the agent compares it literally.
   */
  readonly generation: string;
  readonly image_id: string;
  readonly runtime_user: string;
  readonly runtime_uid: number;
  readonly harness: string;
  /** `HOME` del arnés. Opcional: un pty-agent anterior a 2026-08-25 no lo publica. */
  readonly home?: string;
  readonly codex_home?: string;
  readonly claude_config_dir?: string;
  readonly openclaw_workspace?: string;
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
  /** Field name is the gateway's: `parseAgentPresence` rejects the record without it. */
  readonly connected_since: string;
}

export interface TerminalGatewayClient {
  consumeTicket(sessionId: string, ticket: string): Promise<ConsumeOutcome>;
  resumeSession(sessionId: string, resumeToken: string): Promise<ResumeOutcome>;
  authorizeSession(sessionId: string): Promise<AuthzOutcome>;
  reportClose(sessionId: string, report: SessionCloseReport): Promise<void>;
  publishPresence(agents: readonly AgentPresence[]): Promise<void>;
}

interface HttpResult {
  readonly status: number;
  readonly body: string;
}

export interface HttpsTerminalGatewayClientOptions {
  readonly gatewayUrl: string;
  readonly tokenFile: string;
  readonly timeoutMs?: number;
  /** Optional PEM bundle for gateways issued by a private CA; otherwise the system store. */
  readonly ca?: Buffer;
  /**
   * Identidad de cliente para el handshake TLS. Un gateway en modo mTLS pide certificado a todo el
   * que se conecta, incluidas las rutas /v3/terminal/relay/* que ya se autentican con el token
   * compartido: sin certificado el handshake muere antes de que el token llegue a leerse.
   */
  readonly clientCert?: Buffer;
  readonly clientKey?: Buffer;
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function integerField(source: Record<string, unknown>, name: string): number | undefined {
  const value = source[name];
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

/** A grant we cannot fully understand is not a grant: missing fields mean no session. */
export function parseSessionGrant(body: string): TerminalSessionGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const source = parsed as Record<string, unknown>;
  const tenantId = stringField(source, 'tenant_id');
  const alias = stringField(source, 'alias');
  const mode = stringField(source, 'mode');
  const operatorId = stringField(source, 'operator_id');
  const container = stringField(source, 'container');
  const runtimeUser = stringField(source, 'runtime_user');
  const expiresAt = stringField(source, 'session_expires_at');
  const cols = integerField(source, 'cols');
  const rows = integerField(source, 'rows');
  const resumeToken = stringField(source, 'resume_token');
  if (!tenantId || !alias || !operatorId || !container || !runtimeUser || !expiresAt || !resumeToken) return undefined;
  if (resumeToken.length < 80 || resumeToken.length > 1_024) return undefined;
  if (mode !== 'shell' && mode !== 'harness') return undefined;
  if (cols === undefined || rows === undefined) return undefined;
  if (Number.isNaN(Date.parse(expiresAt))) return undefined;
  return {
    tenant_id: tenantId,
    alias,
    mode,
    cols,
    rows,
    operator_id: operatorId,
    container,
    runtime_user: runtimeUser,
    session_expires_at: expiresAt,
    resume_token: resumeToken
  };
}

export class HttpsTerminalGatewayClient implements TerminalGatewayClient {
  private readonly gatewayUrl: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly ca: Buffer | undefined;
  private readonly clientCert: Buffer | undefined;
  private readonly clientKey: Buffer | undefined;

  constructor(options: HttpsTerminalGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.tokenFile = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.ca = options.ca;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
  }

  async consumeTicket(sessionId: string, ticket: string): Promise<ConsumeOutcome> {
    let result: HttpResult;
    try {
      result = await this.send('POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/consume`, { ticket });
    } catch (error) {
      logEvent('terminal_relay_consume_unreachable', { session_id: sessionId, error: errorLabel(error) });
      return { status: 'unavailable' };
    }
    if (result.status === 401) return { status: 'ticket_invalid' };
    if (result.status === 409) return { status: 'conflict' };
    if (result.status === 403) return { status: 'forbidden' };
    if (result.status !== 200) {
      logEvent('terminal_relay_consume_rejected', { session_id: sessionId, status: result.status });
      return { status: 'unavailable' };
    }
    const grant = parseSessionGrant(result.body);
    if (!grant) {
      logEvent('terminal_relay_grant_malformed', { session_id: sessionId });
      return { status: 'unavailable' };
    }
    return { status: 'granted', grant };
  }

  async authorizeSession(sessionId: string): Promise<AuthzOutcome> {
    let result: HttpResult;
    try {
      result = await this.send('GET', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/authz`);
    } catch {
      return 'unreachable';
    }
    if (result.status === 200) return 'allow';
    // 401/403/404/409 are all "you may not continue"; only a broken gateway earns the grace window.
    if (result.status >= 500) return 'unreachable';
    return 'revoked';
  }

  async resumeSession(sessionId: string, resumeToken: string): Promise<ResumeOutcome> {
    let result: HttpResult;
    try {
      result = await this.send(
        'POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/resume`,
        { resume_token: resumeToken }
      );
    } catch (error) {
      logEvent('terminal_relay_resume_unreachable', { session_id: sessionId, error: errorLabel(error) });
      return { status: 'unavailable' };
    }
    if (result.status === 401) return { status: 'resume_invalid' };
    if (result.status === 403) return { status: 'forbidden' };
    if (result.status !== 200) return { status: 'unavailable' };
    const grant = parseSessionGrant(result.body);
    if (!grant) return { status: 'unavailable' };
    return { status: 'granted', grant };
  }

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    const result = await this.send(
      'POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/close`, { ...report }
    );
    if (result.status !== 200 && result.status !== 204) {
      throw new Error(`gateway rejected terminal close report with HTTP ${result.status}`);
    }
  }

  async publishPresence(agents: readonly AgentPresence[]): Promise<void> {
    try {
      const result = await this.send('POST', '/v3/terminal/relay/agents', { agents });
      if (result.status !== 200 && result.status !== 204) {
        logEvent('terminal_relay_presence_rejected', { status: result.status, agents: agents.length });
      }
    } catch (error) {
      logEvent('terminal_relay_presence_failed', { agents: agents.length, error: errorLabel(error) });
    }
  }

  /** Read per call so a rotated token file takes effect without restarting the relay. */
  private async token(): Promise<string> {
    const value = (await readFile(this.tokenFile, 'utf8')).trim();
    if (!value) throw new Error('terminal relay gateway token file is empty');
    return value;
  }

  private async send(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<HttpResult> {
    const token = await this.token();
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const url = new URL(path, this.gatewayUrl);
    return new Promise<HttpResult>((resolve, reject) => {
      const request = httpsRequest(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.byteLength })
        },
        ...(this.ca === undefined ? {} : { ca: this.ca }),
        ...(this.clientCert === undefined || this.clientKey === undefined
          ? {}
          : { cert: this.clientCert, key: this.clientKey })
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          // Bound the response: the gateway answers with small JSON, never a stream.
          if (chunks.length < 64) chunks.push(chunk);
        });
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8')
        }));
        response.on('error', reject);
      });
      request.setTimeout(this.timeoutMs, () => {
        request.destroy(new Error('gateway request timed out'));
      });
      request.on('error', reject);
      if (payload !== undefined) request.write(payload);
      request.end();
    });
  }
}

/**
 * Lectura de un fichero de gobierno dentro del contenedor de un alias.
 *
 * El relay no decide NADA sobre qué se puede leer: la ruta la resuelve el gateway desde hechos
 * medidos y el pty-agent la vuelve a validar contra su propia lista antes de abrir el fichero.
 * Lo que sí es responsabilidad del relay, y está aquí, es que una lectura no pueda hacerle daño
 * al resto: que no se le pregunte a un agente que no sabe contestar, que no se cuelgue para
 * siempre, que no se acumule un volcado en memoria, y que la respuesta sea del alias que se pidió.
 */

/** Tope de lo que se acumula en memoria. Coincide con `MAX_DOCUMENT_BYTES` del pty-agent. */
export const MAX_GOVERNANCE_BYTES = 256 * 1024;
/**
 * A 65.500 B por trama, 256 KB entran en 5. Se admiten 8 por holgura: más tramas anunciadas que
 * eso no es un documento grande, es un agente diciendo algo que no cuadra con su propio tope.
 */
const MAX_GOVERNANCE_CHUNKS = 8;

export type GovernanceReadCode =
  | 'not_found' | 'permission_denied' | 'invalid_path' | 'symlink_detected'
  | 'too_large' | 'timeout' | 'unavailable' | 'unknown';

const READ_CODES: readonly GovernanceReadCode[] = [
  'not_found', 'permission_denied', 'invalid_path', 'symlink_detected',
  'too_large', 'timeout', 'unavailable', 'unknown'
];

export interface GovernanceFileRead {
  readonly path: string;
  /** Tamaño REAL del fichero, aunque `content` venga recortado. */
  readonly bytes: number;
  readonly truncated: boolean;
  readonly modified_at: string;
  /** SHA-256 de los bytes reales; en agentes viejos se deriva del contenido no truncado. */
  readonly sha: string;
  readonly content: string;
}

export interface GovernanceReadFailure {
  readonly error: GovernanceReadCode;
  readonly reason: string;
}

export type FileReadOutcome = GovernanceFileRead | GovernanceReadFailure;

/** Un código que no reconocemos es `unknown`, nunca se propaga tal cual. */
function normalizeCode(value: string): GovernanceReadCode {
  return READ_CODES.includes(value as GovernanceReadCode) ? (value as GovernanceReadCode) : 'unknown';
}

export async function requestFileRead(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  path: string,
  timeoutMs = 5_000
): Promise<FileReadOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  // La conexión la busca quien llama. Si lo que vuelve no es del alias pedido, esto es una fuga
  // entre inquilinos, no un fallo de lectura: se corta aquí y no se pregunta nada.
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceRead) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no sabe leer ficheros de gobierno' };
  }

  const requestId = randomUUID();
  return new Promise<FileReadOutcome>((resolve) => {
    const chunks: Buffer[] = [];
    let metadata: Omit<GovernanceFileRead, 'content'> | undefined;
    let expected: number | undefined;
    let received = 0;
    let accumulated = 0;
    let settled = false;

    const finish = (outcome: FileReadOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.detachRead(requestId);
      resolve(outcome);
    };

    const complete = (): void => {
      if (metadata === undefined || expected === undefined || received < expected) return;
      const raw = Buffer.concat(chunks);
      if (!metadata.truncated && metadata.bytes !== raw.byteLength) {
        finish({ error: 'unknown', reason: 'el tamaño real no coincide con los datos recibidos' });
        return;
      }
      const receivedSha = createHash('sha256').update(raw).digest('hex');
      // Si no está truncado, la huella declarada tiene que describir exactamente lo que llegó.
      if (!metadata.truncated && metadata.sha !== '' && metadata.sha !== receivedSha) {
        finish({ error: 'unknown', reason: 'la huella de lectura no coincide con los datos recibidos' });
        return;
      }
      finish({ ...metadata, sha: metadata.sha || receivedSha, content: raw.toString('utf8') });
    };

    const timer = setTimeout(() => {
      logEvent('terminal_relay_read_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no contestó en ${timeoutMs} ms` });
    }, timeoutMs);
    timer.unref?.();

    connection.attachRead(requestId, {
      onReadOk(body) {
        if (body.kind !== 'file') {
          finish({ error: 'unknown', reason: 'el agente contestó una lectura que no es de fichero' });
          return;
        }
        const answered = stringField(body, 'path');
        const modifiedAt = stringField(body, 'modified_at');
        const bytes = integerField(body, 'bytes');
        const count = integerField(body, 'chunks');
        const declaredSha = stringField(body, 'sha');
        if (answered === undefined || modifiedAt === undefined || bytes === undefined || count === undefined) {
          finish({ error: 'unknown', reason: 'el agente contestó sin los metadatos de la lectura' });
          return;
        }
        // Contestar por otra ruta sería servir un fichero que nadie pidió.
        if (answered !== path) {
          finish({ error: 'unknown', reason: 'el agente contestó por una ruta distinta de la pedida' });
          return;
        }
        if (count < 0 || count > MAX_GOVERNANCE_CHUNKS) {
          finish({ error: 'too_large', reason: 'el agente anuncia más tramas de las que cabe un documento' });
          return;
        }
        const fallbackSha = declaredSha === undefined ? undefined : declaredSha;
        if (fallbackSha !== undefined && !/^[0-9a-f]{64}$/.test(fallbackSha)) {
          finish({ error: 'unknown', reason: 'el agente contestó con una huella inválida' });
          return;
        }
        // Compatibilidad de lectura: un agente pre-write no mandaba `sha`. Para un documento no
        // truncado se completa al final desde sus bytes; el marcador temporal se sustituye allí.
        metadata = {
          path: answered,
          bytes,
          truncated: body.truncated === true,
          modified_at: modifiedAt,
          sha: fallbackSha ?? ''
        };
        expected = count;
        complete();
      },
      onReadData(chunk) {
        accumulated += chunk.byteLength;
        // El tope se comprueba ANTES de guardar: si no, un agente que ignore su propio límite
        // llena la memoria del relay antes de que nadie cuente las tramas.
        if (accumulated > MAX_GOVERNANCE_BYTES) {
          finish({ error: 'too_large', reason: 'el agente mandó más bytes de los que esta vía sirve' });
          return;
        }
        chunks.push(chunk);
        received += 1;
        complete();
      },
      onReadErr(failure) {
        finish({ error: normalizeCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      }
    });

    connection.sendRead(requestId, 'file', path);
  });
}

export type GovernanceWriteOperation = 'replace' | 'create';

export type GovernanceWritePrecondition =
  | { readonly state: 'present'; readonly sha256: string }
  | { readonly state: 'absent' };

export interface GovernanceFileWrite {
  readonly path: string;
  readonly operation: GovernanceWriteOperation;
  readonly sha: string;
  readonly bytes: number;
}

export interface GovernanceWriteFailure {
  readonly error: GovernanceReadCode | 'conflict';
  readonly reason: string;
}

export type FileWriteOutcome = GovernanceFileWrite | GovernanceWriteFailure;

const WRITE_CODES: readonly GovernanceWriteFailure['error'][] = [...READ_CODES, 'conflict'];
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function normalizeWriteCode(value: string): GovernanceWriteFailure['error'] {
  return WRITE_CODES.includes(value as GovernanceWriteFailure['error'])
    ? (value as GovernanceWriteFailure['error'])
    : 'unknown';
}

/**
 * Escritura CAS extremo a extremo. El único éxito posible es un WRITE_OK cuyo path, operación,
 * bytes y SHA describen exactamente el contenido que este relay puso en el socket del agente.
 */
export async function requestFileWrite(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  path: string,
  content: Buffer,
  precondition: GovernanceWritePrecondition,
  timeoutMs = 5_000,
  signal?: AbortSignal
): Promise<FileWriteOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceWrite) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no sabe escribir ficheros de gobierno' };
  }
  if (content.byteLength > MAX_GOVERNANCE_BYTES) {
    return { error: 'too_large', reason: 'el contenido se pasa del tope de gobierno' };
  }
  if (precondition.state === 'present' && !SHA256_PATTERN.test(precondition.sha256)) {
    return { error: 'invalid_path', reason: 'replace exige una precondición SHA-256 válida' };
  }
  if (signal?.aborted === true) {
    return { error: 'unavailable', reason: 'la petición de escritura fue cancelada' };
  }

  const requestId = randomUUID();
  const operation: GovernanceWriteOperation = precondition.state === 'present' ? 'replace' : 'create';
  const expectedSha = precondition.state === 'present' ? precondition.sha256 : undefined;
  const contentSha = createHash('sha256').update(content).digest('hex');

  return new Promise<FileWriteOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: FileWriteOutcome, cancelAgent = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      connection.detachWrite(requestId);
      if (cancelAgent) connection.cancelWrite(requestId);
      resolve(outcome);
    };
    const aborted = (): void => finish(
      { error: 'unavailable', reason: 'la petición de escritura fue cancelada' },
      true
    );
    const timer = setTimeout(() => {
      logEvent('terminal_relay_write_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no confirmó la escritura en ${timeoutMs} ms` }, true);
    }, timeoutMs);
    timer.unref?.();

    connection.attachWrite(requestId, {
      onWriteOk(body) {
        const answeredPath = stringField(body, 'path');
        const answeredOperation = stringField(body, 'operation');
        const answeredSha = stringField(body, 'sha');
        const answeredBytes = integerField(body, 'bytes');
        if (answeredPath !== path || answeredOperation !== operation
          || answeredSha !== contentSha || answeredBytes !== content.byteLength) {
          finish({ error: 'unknown', reason: 'el ACK del agente no acredita la escritura solicitada' });
          return;
        }
        finish({ path, operation, sha: contentSha, bytes: content.byteLength });
      },
      onWriteErr(failure) {
        finish({ error: normalizeWriteCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      }
    });
    signal?.addEventListener('abort', aborted, { once: true });

    if (!connection.sendWrite(requestId, path, operation, expectedSha, contentSha, content)) {
      finish({ error: 'unavailable', reason: 'la cola hacia el pty-agent está congestionada' }, true);
    }
  });
}

export type GovernanceWriteBatchEntry =
  | {
      readonly mode: 'write';
      readonly path: string;
      readonly content: Buffer;
      readonly precondition: GovernanceWritePrecondition;
    }
  | {
      readonly mode: 'verify';
      readonly path: string;
      readonly precondition: GovernanceWritePrecondition;
    };

export type GovernanceBatchAckOperation = 'create' | 'replace' | 'unchanged' | 'absent';

export interface GovernanceBatchFileAck {
  readonly path: string;
  readonly operation: GovernanceBatchAckOperation;
  readonly sha: string | null;
  readonly bytes: number;
}

export type GovernanceWriteBatchOutcome =
  | { readonly files: readonly GovernanceBatchFileAck[] }
  | GovernanceWriteFailure;

const MAX_GOVERNANCE_BATCH_FILES = 7;

/**
 * Perfil gobernado multi-fichero. `verify` acredita estado sin abrir para escritura ni cambiar
 * mtime; `write` acepta `unchanged` si un retry encuentra exactamente los bytes deseados. El
 * único éxito es un ACK completo y correlacionado para todas las entradas.
 */
export async function requestFileWriteBatch(
  connection: AgentConnection,
  tenantId: string,
  alias: string,
  entries: readonly GovernanceWriteBatchEntry[],
  timeoutMs = 5_000,
  signal?: AbortSignal
): Promise<GovernanceWriteBatchOutcome> {
  if (!connection.alive) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no está conectado' };
  }
  if (connection.hello.tenant_id !== tenantId || connection.hello.alias !== alias) {
    return { error: 'permission_denied', reason: 'la conexión no es la de ese alias' };
  }
  if (!connection.supportsGovernanceWriteBatch) {
    return { error: 'unavailable', reason: 'el pty-agent de ese alias no soporta perfiles atómicos' };
  }
  if (entries.length < 1 || entries.length > MAX_GOVERNANCE_BATCH_FILES) {
    return { error: 'too_large', reason: 'el perfil debe contener entre uno y siete ficheros' };
  }
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    return { error: 'conflict', reason: 'el perfil contiene rutas duplicadas' };
  }
  let totalBytes = 0;
  const wireEntries: AgentGovernanceBatchEntry[] = [];
  for (const entry of entries) {
    if (entry.precondition.state === 'present' && !SHA256_PATTERN.test(entry.precondition.sha256)) {
      return { error: 'invalid_path', reason: 'una precondición del perfil no es un SHA-256 válido' };
    }
    const expectedSha = entry.precondition.state === 'present' ? entry.precondition.sha256 : undefined;
    if (entry.mode === 'verify') {
      wireEntries.push({
        path: entry.path,
        mode: 'verify',
        operation: entry.precondition.state,
        expectedSha,
      });
      continue;
    }
    totalBytes += entry.content.byteLength;
    if (totalBytes > MAX_GOVERNANCE_BYTES) {
      return { error: 'too_large', reason: 'el perfil se pasa del tope total de gobierno' };
    }
    wireEntries.push({
      path: entry.path,
      mode: 'write',
      operation: entry.precondition.state === 'present' ? 'replace' : 'create',
      expectedSha,
      contentSha: createHash('sha256').update(entry.content).digest('hex'),
      content: entry.content,
    });
  }
  if (signal?.aborted === true) {
    return { error: 'unavailable', reason: 'la petición de perfil fue cancelada' };
  }

  const requestId = randomUUID();
  return new Promise<GovernanceWriteBatchOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: GovernanceWriteBatchOutcome, cancelAgent = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      connection.detachWrite(requestId);
      if (cancelAgent) connection.cancelGovernanceWriteBatch(requestId);
      resolve(outcome);
    };
    const aborted = (): void => finish(
      { error: 'unavailable', reason: 'la petición de perfil fue cancelada' }, true
    );
    const timer = setTimeout(() => {
      logEvent('terminal_relay_write_batch_timeout', { tenant_id: tenantId, alias, request_id: requestId });
      finish({ error: 'timeout', reason: `el pty-agent no confirmó el perfil en ${timeoutMs} ms` }, true);
    }, timeoutMs);
    timer.unref?.();

    connection.attachWrite(requestId, {
      onWriteOk(body) {
        const rawFiles: unknown = body.files;
        if (!Array.isArray(rawFiles) || rawFiles.length !== wireEntries.length) {
          finish({ error: 'unknown', reason: 'el ACK del agente no acredita todos los ficheros del perfil' });
          return;
        }
        const acknowledgements: GovernanceBatchFileAck[] = [];
        for (let index = 0; index < wireEntries.length; index += 1) {
          const requested = wireEntries[index];
          const raw: unknown = rawFiles[index];
          if (requested === undefined || raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            finish({ error: 'unknown', reason: 'el ACK del agente contiene una entrada inválida' });
            return;
          }
          const answer = raw as Record<string, unknown>;
          const answeredPath = stringField(answer, 'path');
          const operation = stringField(answer, 'operation');
          const bytes = integerField(answer, 'bytes');
          const rawSha: unknown = answer.sha;
          const sha = rawSha === null ? null : typeof rawSha === 'string' ? rawSha : undefined;
          const validOperation = operation === 'create' || operation === 'replace'
            || operation === 'unchanged' || operation === 'absent';
          if (answeredPath !== requested.path || !validOperation || bytes === undefined || bytes < 0
            || sha === undefined || (sha !== null && !SHA256_PATTERN.test(sha))) {
            finish({ error: 'unknown', reason: 'el ACK del agente contiene metadatos inválidos' });
            return;
          }
          if (requested.mode === 'write') {
            if ((operation !== requested.operation && operation !== 'unchanged')
              || sha !== requested.contentSha || bytes !== requested.content.byteLength) {
              finish({ error: 'unknown', reason: 'el ACK del agente no acredita los bytes solicitados' });
              return;
            }
          } else if (requested.operation === 'present') {
            if (operation !== 'unchanged' || sha !== requested.expectedSha) {
              finish({ error: 'unknown', reason: 'el ACK del agente no acredita el fichero preservado' });
              return;
            }
          } else if (operation !== 'absent' || sha !== null || bytes !== 0) {
            finish({ error: 'unknown', reason: 'el ACK del agente no acredita la ausencia solicitada' });
            return;
          }
          acknowledgements.push({ path: requested.path, operation, sha, bytes });
        }
        finish({ files: acknowledgements });
      },
      onWriteErr(failure) {
        finish({ error: normalizeWriteCode(failure.code), reason: failure.reason });
      },
      onAgentGone(reason) {
        finish({ error: 'unavailable', reason: `el pty-agent se desconectó: ${reason}` });
      },
    });
    signal?.addEventListener('abort', aborted, { once: true });

    if (!connection.sendGovernanceWriteBatch(requestId, wireEntries)) {
      finish({ error: 'unavailable', reason: 'la cola hacia el pty-agent está congestionada' }, true);
    }
  });
}

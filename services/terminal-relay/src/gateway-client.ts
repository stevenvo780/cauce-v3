import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
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
}

export type ConsumeOutcome =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant }
  | { readonly status: 'ticket_invalid' | 'conflict' | 'forbidden' | 'unavailable' };

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
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
  /** Field name is the gateway's: `parseAgentPresence` rejects the record without it. */
  readonly connected_since: string;
}

export interface TerminalGatewayClient {
  consumeTicket(sessionId: string, ticket: string): Promise<ConsumeOutcome>;
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
  if (!tenantId || !alias || !operatorId || !container || !runtimeUser || !expiresAt) return undefined;
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
    session_expires_at: expiresAt
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

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    try {
      await this.send('POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/close`, { ...report });
    } catch (error) {
      logEvent('terminal_relay_close_report_failed', { session_id: sessionId, error: errorLabel(error) });
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

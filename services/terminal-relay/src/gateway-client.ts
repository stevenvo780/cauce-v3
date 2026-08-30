import { readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { errorLabel, logEvent } from './log.js';
import {
  isRelayBootId,
  isRelayInstanceId,
  type RelayProcessIdentity,
} from './relay-identity.js';
import { integerField, stringField } from './validation.js';

export * from './governance-read.js';
export * from './governance-write.js';

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
  /** Capability-like ownership fence; memory/0600 spool only, never logs. */
  readonly claim_token: string;
  /** PostgreSQL bigint as canonical decimal text. */
  readonly claim_epoch: string;
  readonly claim_lease_ms: number;
  readonly claim_lease_ttl_ms: number;
  /** Authenticated mTLS leaf digest of the relay instance this session is pinned to. */
  readonly relay_instance_id: string;
  /** Process generation accepted for this call; detects accidental duplicate replicas. */
  readonly relay_boot_id: string;
}

export type ConsumeOutcome =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant }
  | { readonly status: 'conflict'; readonly retry_after_ms?: number }
  | { readonly status: 'ticket_invalid' | 'forbidden' | 'unavailable' };

export type ResumeOutcome =
  | { readonly status: 'granted'; readonly grant: TerminalSessionGrant }
  | { readonly status: 'conflict'; readonly retry_after_ms?: number }
  | { readonly status: 'resume_invalid' | 'forbidden' | 'unavailable' };

/** `unreachable` is not an allow: the caller counts it against the fail-closed grace window. */
export type AuthzOutcome =
  | {
      readonly status: 'allow';
      readonly claim_epoch: string;
      readonly claim_lease_ms: number;
      readonly claim_lease_ttl_ms: number;
    }
  | { readonly status: 'revoked' | 'unreachable' };

export interface SessionCloseReport {
  readonly reason: string;
  readonly exit_code: number | null;
  readonly bytes_in: number;
  readonly bytes_out: number;
  /** Absent only while draining a version-1 legacy spool for an epoch-0 row. */
  readonly claim_token?: string;
  readonly claim_epoch?: string;
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
  readonly runtime_facts_observed?: boolean;
  /** The harness `HOME`. Optional for backward compatibility. */
  readonly home?: string;
  readonly codex_home?: string;
  readonly claude_config_dir?: string;
  readonly openclaw_workspace?: string;
  readonly cwd?: string;
  readonly workspace_root?: string;
  readonly project_root?: string;
  readonly project_doc_max_bytes?: number;
  readonly project_doc_fallback_filenames?: readonly string[];
  readonly agent_version: string;
  readonly modes: readonly TerminalMode[];
  /** Field name is the gateway's: `parseAgentPresence` rejects the record without it. */
  readonly connected_since: string;
}

export interface TerminalGatewayClient {
  consumeTicket(sessionId: string, ticket: string, claimToken: string): Promise<ConsumeOutcome>;
  resumeSession(
    sessionId: string,
    resumeToken: string,
    claimToken: string,
    claimEpoch?: string,
  ): Promise<ResumeOutcome>;
  authorizeSession(sessionId: string, claimToken: string, claimEpoch: string): Promise<AuthzOutcome>;
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
   * Client identity for the TLS handshake. A gateway in mTLS mode asks for a certificate from
   * everyone who connects, including the /v3/terminal/relay/* routes that already authenticate with
   * the shared token: without a certificate the handshake dies before the token can be read.
   */
  readonly clientCert: Buffer;
  readonly clientKey: Buffer;
  readonly identity: RelayProcessIdentity;
}

const CLAIM_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLAIM_EPOCH_PATTERN = /^[1-9][0-9]{0,18}$/;
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
export const MAX_CLAIM_LEASE_MS = 300_000;
export const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 5_000;
export const CLAIM_DEADLINE_SAFETY_MARGIN_MS = 5_000;

export function isClaimToken(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_TOKEN_PATTERN.test(value);
}

export function claimEpoch(value: unknown): string | undefined {
  if (typeof value !== 'string' || !CLAIM_EPOCH_PATTERN.test(value)) return undefined;
  try {
    return BigInt(value) <= POSTGRES_BIGINT_MAX ? value : undefined;
  } catch {
    return undefined;
  }
}

function claimLeaseMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_CLAIM_LEASE_MS
    ? value : undefined;
}

function retryAfterMs(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return claimLeaseMs((parsed as Record<string, unknown>).retry_after_ms);
  } catch {
    return undefined;
  }
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
  const baseKeys = [
    'alias', 'claim_epoch', 'claim_lease_ms', 'claim_lease_ttl_ms', 'claim_taken_over',
    'claim_token', 'cols', 'container', 'expires_at', 'mode', 'ok', 'operator_id',
    'relay_boot_id', 'relay_instance_id', 'resume_token', 'rows', 'runtime_user',
    'session_expires_at', 'tenant_id',
  ];
  const actualKeys = Object.keys(source).sort();
  const exactBase = actualKeys.length === baseKeys.length
    && actualKeys.every((key, index) => key === baseKeys[index]);
  const consumeKeys = [...baseKeys, 'receipt_recovered'].sort();
  const exactConsume = actualKeys.length === consumeKeys.length
    && actualKeys.every((key, index) => key === consumeKeys[index]);
  if ((!exactBase && !exactConsume) || source.ok !== true
      || typeof source.claim_taken_over !== 'boolean'
      || (exactConsume && typeof source.receipt_recovered !== 'boolean')) return undefined;
  const tenantId = stringField(source, 'tenant_id');
  const alias = stringField(source, 'alias');
  const mode = stringField(source, 'mode');
  const operatorId = stringField(source, 'operator_id');
  const container = stringField(source, 'container');
  const runtimeUser = stringField(source, 'runtime_user');
  const expiresAt = stringField(source, 'session_expires_at');
  const ticketExpiresAt = stringField(source, 'expires_at');
  const cols = integerField(source, 'cols');
  const rows = integerField(source, 'rows');
  const resumeToken = stringField(source, 'resume_token');
  const rawClaimToken = stringField(source, 'claim_token');
  const rawClaimEpoch = claimEpoch(source.claim_epoch);
  const rawClaimLeaseMs = claimLeaseMs(source.claim_lease_ms);
  const rawClaimLeaseTtlMs = claimLeaseMs(source.claim_lease_ttl_ms);
  const relayInstanceId = stringField(source, 'relay_instance_id');
  const relayBootId = stringField(source, 'relay_boot_id');
  if (!tenantId || !alias || !operatorId || !container || !runtimeUser || !expiresAt
      || !ticketExpiresAt || !resumeToken) return undefined;
  if (resumeToken.length < 80 || resumeToken.length > 1_024) return undefined;
  if (mode !== 'shell' && mode !== 'harness') return undefined;
  if (cols === undefined || rows === undefined) return undefined;
  if (Number.isNaN(Date.parse(expiresAt)) || Number.isNaN(Date.parse(ticketExpiresAt))) return undefined;
  if (!isClaimToken(rawClaimToken) || rawClaimEpoch === undefined || rawClaimLeaseMs === undefined
      || rawClaimLeaseTtlMs === undefined || rawClaimLeaseMs > rawClaimLeaseTtlMs
      || !isRelayInstanceId(relayInstanceId) || !isRelayBootId(relayBootId)) return undefined;
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
    resume_token: resumeToken,
    claim_token: rawClaimToken,
    claim_epoch: rawClaimEpoch,
    claim_lease_ms: rawClaimLeaseMs,
    claim_lease_ttl_ms: rawClaimLeaseTtlMs,
    relay_instance_id: relayInstanceId,
    relay_boot_id: relayBootId,
  };
}

export class HttpsTerminalGatewayClient implements TerminalGatewayClient {
  private readonly gatewayUrl: string;
  private readonly tokenFile: string;
  private readonly timeoutMs: number;
  private readonly ca: Buffer | undefined;
  private readonly clientCert: Buffer;
  private readonly clientKey: Buffer;
  private readonly identity: RelayProcessIdentity;

  constructor(options: HttpsTerminalGatewayClientOptions) {
    this.gatewayUrl = options.gatewayUrl;
    this.tokenFile = options.tokenFile;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
    this.ca = options.ca;
    this.clientCert = options.clientCert;
    this.clientKey = options.clientKey;
    if (!isRelayInstanceId(options.identity.relayInstanceId)
        || !isRelayBootId(options.identity.relayBootId)) {
      throw new Error('terminal relay process identity is invalid');
    }
    this.identity = options.identity;
  }

  async consumeTicket(sessionId: string, ticket: string, claimToken: string): Promise<ConsumeOutcome> {
    let result: HttpResult;
    try {
      result = await this.send(
        'POST',
        `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/consume`,
        this.identified({ ticket, claim_token: claimToken }),
      );
    } catch (error) {
      logEvent('terminal_relay_consume_unreachable', { session_id: sessionId, error: errorLabel(error) });
      return { status: 'unavailable' };
    }
    if (result.status === 401) return { status: 'ticket_invalid' };
    if (result.status === 409) {
      const retry = retryAfterMs(result.body);
      return { status: 'conflict', ...(retry === undefined ? {} : { retry_after_ms: retry }) };
    }
    if (result.status === 403) return { status: 'forbidden' };
    if (result.status !== 200) {
      logEvent('terminal_relay_consume_rejected', { session_id: sessionId, status: result.status });
      return { status: 'unavailable' };
    }
    const grant = parseSessionGrant(result.body);
    if (!grant || !this.ownsGrant(grant)) {
      logEvent('terminal_relay_grant_malformed', { session_id: sessionId });
      return { status: 'unavailable' };
    }
    return { status: 'granted', grant };
  }

  async authorizeSession(sessionId: string, claimToken: string, claimEpochValue: string): Promise<AuthzOutcome> {
    let result: HttpResult;
    try {
      result = await this.send(
        'POST',
        `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/authz`,
        this.identified({ claim_token: claimToken, claim_epoch: claimEpochValue }),
      );
    } catch {
      return { status: 'unreachable' };
    }
    if (result.status === 200) {
      try {
        const parsed: unknown = JSON.parse(result.body);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const source = parsed as Record<string, unknown>;
          const epoch = claimEpoch(source.claim_epoch);
          const leaseMs = claimLeaseMs(source.claim_lease_ms);
          const leaseTtlMs = claimLeaseMs(source.claim_lease_ttl_ms);
          const relayInstanceId = stringField(source, 'relay_instance_id');
          const relayBootId = stringField(source, 'relay_boot_id');
          const expiresAt = stringField(source, 'expires_at');
          const exactKeys = [
            'claim_epoch', 'claim_lease_ms', 'claim_lease_ttl_ms', 'expires_at', 'ok',
            'relay_boot_id', 'relay_instance_id',
          ];
          if (Object.keys(source).sort().every((key, index) => key === exactKeys[index])
              && Object.keys(source).length === exactKeys.length
              && source.ok === true && expiresAt !== undefined && !Number.isNaN(Date.parse(expiresAt))
              && epoch !== undefined && leaseMs !== undefined && leaseTtlMs !== undefined
              && leaseMs <= leaseTtlMs
              && relayInstanceId === this.identity.relayInstanceId
              && relayBootId === this.identity.relayBootId) {
            return {
              status: 'allow', claim_epoch: epoch, claim_lease_ms: leaseMs,
              claim_lease_ttl_ms: leaseTtlMs,
            };
          }
        }
      } catch {
        // A malformed allow is not authority.
      }
      return { status: 'unreachable' };
    }
    // 401/403/404/409 are all "you may not continue"; only a broken gateway earns the grace window.
    if (result.status >= 500) return { status: 'unreachable' };
    return { status: 'revoked' };
  }

  async resumeSession(
    sessionId: string,
    resumeToken: string,
    claimToken: string,
    claimEpochValue?: string,
  ): Promise<ResumeOutcome> {
    let result: HttpResult;
    try {
      result = await this.send(
        'POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/resume`,
        {
          resume_token: resumeToken,
          claim_token: claimToken,
          ...(claimEpochValue === undefined ? {} : { claim_epoch: claimEpochValue }),
          relay_instance_id: this.identity.relayInstanceId,
          relay_boot_id: this.identity.relayBootId,
        }
      );
    } catch (error) {
      logEvent('terminal_relay_resume_unreachable', { session_id: sessionId, error: errorLabel(error) });
      return { status: 'unavailable' };
    }
    if (result.status === 401) return { status: 'resume_invalid' };
    if (result.status === 409) {
      const retry = retryAfterMs(result.body);
      return { status: 'conflict', ...(retry === undefined ? {} : { retry_after_ms: retry }) };
    }
    if (result.status === 403) return { status: 'forbidden' };
    if (result.status !== 200) return { status: 'unavailable' };
    const grant = parseSessionGrant(result.body);
    if (!grant || !this.ownsGrant(grant)) return { status: 'unavailable' };
    return { status: 'granted', grant };
  }

  async reportClose(sessionId: string, report: SessionCloseReport): Promise<void> {
    const result = await this.send(
      'POST', `/v3/terminal/relay/sessions/${encodeURIComponent(sessionId)}/close`,
      this.identified({ ...report }),
    );
    if (result.status !== 200 || !this.isIdentityAck(result.body)) {
      throw new Error(`gateway rejected terminal close report with HTTP ${String(result.status)}`);
    }
  }

  async publishPresence(agents: readonly AgentPresence[]): Promise<void> {
    try {
      const result = await this.send(
        'POST', '/v3/terminal/relay/agents', this.identified({ agents }),
      );
      let accepted = false;
      if (result.status === 200) {
        try {
          const body: unknown = JSON.parse(result.body);
          accepted = body !== null && typeof body === 'object' && !Array.isArray(body)
            && Object.keys(body).length === 3
            && (body as Record<string, unknown>).ok === true
            && (body as Record<string, unknown>).relay_instance_id === this.identity.relayInstanceId
            && (body as Record<string, unknown>).relay_boot_id === this.identity.relayBootId;
        } catch {
          accepted = false;
        }
      }
      if (!accepted) {
        logEvent('terminal_relay_presence_rejected', { status: result.status, agents: agents.length });
        throw new Error(`gateway did not accept terminal presence (HTTP ${String(result.status)})`);
      }
    } catch (error) {
      logEvent('terminal_relay_presence_failed', { agents: agents.length, error: errorLabel(error) });
      throw error;
    }
  }

  private identified(body: Record<string, unknown>): Record<string, unknown> {
    return {
      ...body,
      relay_instance_id: this.identity.relayInstanceId,
      relay_boot_id: this.identity.relayBootId,
    };
  }

  private ownsGrant(grant: TerminalSessionGrant): boolean {
    return grant.relay_instance_id === this.identity.relayInstanceId
      && grant.relay_boot_id === this.identity.relayBootId;
  }

  private isIdentityAck(body: string): boolean {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === 3
        && (parsed as Record<string, unknown>).ok === true
        && (parsed as Record<string, unknown>).relay_instance_id === this.identity.relayInstanceId
        && (parsed as Record<string, unknown>).relay_boot_id === this.identity.relayBootId;
    } catch {
      return false;
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
        cert: this.clientCert,
        key: this.clientKey,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          // Bound the response: the gateway answers with small JSON, never a stream.
          if (chunks.length < 64) chunks.push(chunk);
        });
        response.on('end', () => { resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8')
        }); });
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

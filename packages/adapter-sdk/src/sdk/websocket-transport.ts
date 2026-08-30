import { createHash } from 'node:crypto'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { createSecureContext } from 'node:tls';
import WebSocket, { type ClientOptions, type RawData } from 'ws';
import { WsInboundSchema, WsOutboundSchema, type Tenant } from '@cauce/protocol';
import { readBearerTokenFile, readOwnerOnlyFile, SecureFileError } from './secure-files.js';
import type {
  AdapterLog,
  AdapterLogger,
  ClientFrame,
  ConsumerConnection,
  ConsumerConnector,
  FrameValidationIssue,
  ServerFrame,
} from './types.js';

/** Correlation the connection needs to describe a rejected frame. Logging only. */
interface OutboundDiagnostics {
  readonly logger: AdapterLogger;
  readonly alias?: string;
}

const SILENT_DIAGNOSTICS: OutboundDiagnostics = { logger: () => undefined };

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Connection aborted', { cause: signal.reason });
}

function decodeTextFrame(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

class AsyncFrameQueue implements AsyncIterable<ServerFrame> {
  private readonly values: ServerFrame[] = [];
  private readonly waiters: {
    resolve: (result: IteratorResult<ServerFrame>) => void;
    reject: (error: Error) => void;
  }[] = [];
  private ended = false;
  private failure: Error | undefined;

  push(value: ServerFrame): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter.resolve({ value, done: false });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  fail(error: Error): void {
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<ServerFrame> {
    return {
      next: async (): Promise<IteratorResult<ServerFrame>> => {
        const value = this.values.shift();
        if (value !== undefined) return { value, done: false };
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { value: undefined, done: true };
        return new Promise<IteratorResult<ServerFrame>>((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

class WebSocketConsumerConnection implements ConsumerConnection {
  readonly mode = 'consumer' as const;
  readonly ephemeral = false as const;
  private readonly queue = new AsyncFrameQueue();

  constructor(
    private readonly socket: WebSocket,
    private readonly diagnostics: OutboundDiagnostics = SILENT_DIAGNOSTICS,
  ) {
    /**
     * Discards frames that fail the inbound schema, recording the corresponding diagnostic
     * without interrupting the connection or the other in-flight deliveries.
     */
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.reportInvalidInboundFrame(undefined, new Error('Binary gateway frames are not supported'));
        return;
      }
      let decoded: unknown;
      try {
        decoded = JSON.parse(decodeTextFrame(data));
      } catch (error) {
        this.reportInvalidInboundFrame(undefined, error);
        return;
      }
      try {
        this.queue.push(parseServerFrame(decoded));
      } catch (error) {
        this.reportInvalidInboundFrame(decoded, error);
      }
    });
    socket.on('close', () => { this.queue.end(); });
    socket.on('error', () => { this.queue.fail(new Error('WebSocket consumer failed')); });
  }

  async send(frame: ClientFrame): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket consumer is not open');
    const encoded = this.encodeOutbound(frame);
    await new Promise<void>((resolve, reject) => {
      this.socket.send(encoded, (error) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
  }

  /**
   * A frame the outbound schema refuses never reaches the socket, and the caller
   * replays it from the durable outbox on the next connection, so a single bad frame
   * reconnect-loops the adapter forever. That loop used to be completely silent: the
   * ZodError went up through `send()` and was collapsed into a generic retry code.
   *
   * The throw is preserved exactly as it was — this only makes the failure legible
   * before it propagates.
   */
  private encodeOutbound(frame: ClientFrame): string {
    try {
      return JSON.stringify(encodeClientFrame(frame));
    } catch (error) {
      this.reportInvalidFrame(frame, error);
      throw error;
    }
  }

  private reportInvalidFrame(frame: ClientFrame, error: unknown): void {
    const issues = frameValidationIssues(error);
    const record = frame as unknown as Record<string, unknown>;
    const deliveryId = stringField(record, 'delivery_id');
    const attempt = numberField(record, 'attempt');
    const alias = this.diagnostics.alias;
    const fingerprint = claimTokenFingerprint(record);
    const entry: AdapterLog = {
      event: 'outbound_frame_invalid',
      timestamp: new Date().toISOString(),
      frame_type: stringField(record, 'type') ?? 'unknown',
      error_code: issues.length > 0 ? 'OUTBOUND_FRAME_SCHEMA' : 'OUTBOUND_FRAME_ENCODE',
      error_message: issues.length > 0
        ? 'Outbound frame rejected by the Cauce V3 schema'
        : encodeFailureMessage(error),
      issues,
      ...(alias === undefined ? {} : { alias }),
      ...(deliveryId === undefined ? {} : { delivery_id: deliveryId }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(fingerprint === undefined ? {} : { claim_token_fingerprint: fingerprint }),
    };
    try {
      this.diagnostics.logger(entry);
    } catch {
      // Observability must never replace the failure it is describing.
    }
  }

  /**
   * A dropped server frame. Same care as on the way out: name the fields the schema rejected,
   * never the frame body — a delivery's `body` is the message.
   */
  private reportInvalidInboundFrame(frame: unknown, error: unknown): void {
    const issues = frameValidationIssues(error);
    const record = typeof frame === 'object' && frame !== null && !Array.isArray(frame)
      ? (frame as Record<string, unknown>)
      : undefined;
    const deliveryId = record === undefined ? undefined : stringField(record, 'delivery_id');
    const attempt = record === undefined ? undefined : numberField(record, 'attempt');
    const alias = this.diagnostics.alias;
    const fingerprint = record === undefined ? undefined : claimTokenFingerprint(record);
    const entry: AdapterLog = {
      event: 'inbound_frame_invalid',
      timestamp: new Date().toISOString(),
      frame_type: (record === undefined ? undefined : stringField(record, 'type')) ?? 'unknown',
      error_code: issues.length > 0 ? 'INBOUND_FRAME_SCHEMA' : 'INBOUND_FRAME_DECODE',
      error_message: issues.length > 0
        ? 'Gateway frame rejected by the Cauce V3 schema and dropped'
        : inboundFailureMessage(error),
      reason: 'frame_dropped',
      issues,
      ...(alias === undefined ? {} : { alias }),
      ...(deliveryId === undefined ? {} : { delivery_id: deliveryId }),
      ...(attempt === undefined ? {} : { attempt }),
      ...(fingerprint === undefined ? {} : { claim_token_fingerprint: fingerprint }),
    };
    try {
      this.diagnostics.logger(entry);
    } catch {
      // Observability must never replace the failure it is describing.
    }
  }

  frames(): AsyncIterable<ServerFrame> {
    return this.queue;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1000, 'consumer reconnect');
    }
    this.queue.end();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Gateway frame must be an object');
  }
  return value as Record<string, unknown>;
}

function parseServerFrame(value: unknown): ServerFrame {
  return WsOutboundSchema.parse(objectValue(value)) as ServerFrame;
}

function encodeClientFrame(frame: ClientFrame): ClientFrame {
  return WsInboundSchema.parse(frame) as ClientFrame;
}

/** Enough to name every offending field of a real frame without becoming a dump. */
const MAX_LOGGED_ISSUES = 10;
const MAX_ISSUE_MESSAGE = 200;
const CLAIM_FINGERPRINT_LENGTH = 12;

function stringField(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(frame: Record<string, unknown>, key: string): number | undefined {
  const value = frame[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Correlates a rejected frame with the gateway's view of the same claim without
 * putting the claim on disk. Truncated because this is a correlation handle, not a
 * proof of possession: nobody should be able to replay it.
 */
function claimTokenFingerprint(frame: Record<string, unknown>): string | undefined {
  const token = stringField(frame, 'claim_token');
  if (token === undefined) return undefined;
  return `sha256:${createHash('sha256').update(token).digest('hex').slice(0, CLAIM_FINGERPRINT_LENGTH)}`;
}

function issuePath(path: unknown): string {
  if (!Array.isArray(path) || path.length === 0) return '<root>';
  return path.reduce<string>((rendered, segment) => {
    if (typeof segment === 'number') return `${rendered}[${String(segment)}]`;
    const key = String(segment);
    return rendered.length === 0 ? key : `${rendered}.${key}`;
  }, '');
}

/**
 * Structurally detects a validator error instead of importing Zod: the SDK depends on
 * `@cauce/protocol`, not on the validator it happens to be built with.
 *
 * Only `path`, `code` and `message` are copied. The issue objects themselves carry the
 * rejected `input`, and for an ACK that input is the harness reply — spreading an issue
 * into a log line would leak exactly the message content this instrumentation must not
 * touch.
 */
function frameValidationIssues(error: unknown): FrameValidationIssue[] {
  if (typeof error !== 'object' || error === null) return [];
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.slice(0, MAX_LOGGED_ISSUES).map((issue: unknown): FrameValidationIssue => {
    const raw = (typeof issue === 'object' && issue !== null ? issue : {}) as {
      path?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const message = typeof raw.message === 'string' ? raw.message.slice(0, MAX_ISSUE_MESSAGE) : undefined;
    return {
      path: issuePath(raw.path),
      code: typeof raw.code === 'string' ? raw.code : 'unknown',
      ...(message === undefined ? {} : { message }),
    };
  });
}

/** Non-schema encode failures (a cyclic body, a BigInt) still deserve a name. */
function encodeFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return `Outbound frame could not be encoded (${typeof error})`;
  return `Outbound frame could not be encoded: ${error.name}`;
}

/** Binary frames and malformed JSON: no issue list to show, but the drop still gets a name. */
function inboundFailureMessage(error: unknown): string {
  if (!(error instanceof Error)) return `Gateway frame could not be decoded (${typeof error})`;
  return `Gateway frame could not be decoded and was dropped: ${error.message}`;
}

export interface WebSocketConnectorOptions {
  /** Defaults to production so insecure ws:// must be explicitly opted into. */
  environment?: 'production' | 'development' | 'test';
  /** Path only. The bearer token is re-read for every connection attempt. */
  bearerTokenFile?: string;
  /** Paths only. All three owner-only files are re-read for every connection. */
  mutualTls?: {
    readonly certFile: string;
    readonly keyFile: string;
    readonly caFile: string;
  };
  /** Explicitly test/development-only identity headers; never enable in production. */
  developmentIdentity?: { tenant_id: Tenant; alias: string };
  /** Correlation for transport diagnostics only; it is never put on the wire from here. */
  alias?: string;
  /** Receives `outbound_frame_invalid` entries. Defaults to a no-op. */
  logger?: AdapterLogger;
}

export class WebSocketConsumerConnector implements ConsumerConnector {
  private readonly url: string;
  private readonly environment: NonNullable<WebSocketConnectorOptions['environment']>;
  private readonly diagnostics: OutboundDiagnostics;

  constructor(endpoint: string, private readonly options: WebSocketConnectorOptions = {}) {
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error('Gateway endpoint is not a valid URL');
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('Gateway endpoint must use ws:// or wss://');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('Credentials, query strings and fragments are forbidden in gateway URLs');
    }
    this.environment = options.environment ?? 'production';
    if (this.environment === 'production' && parsed.protocol !== 'wss:') {
      throw new Error('Production gateway connections require wss://');
    }
    if (this.environment === 'production' && options.developmentIdentity !== undefined) {
      throw new Error('Development identity headers are forbidden in production');
    }
    if (options.mutualTls !== undefined && parsed.protocol !== 'wss:') {
      throw new Error('mTLS requires a wss:// gateway endpoint');
    }
    if (options.mutualTls !== undefined
      && (!options.mutualTls.certFile || !options.mutualTls.keyFile || !options.mutualTls.caFile)) {
      throw new Error('mTLS requires cert, key and CA file paths');
    }
    this.url = parsed.toString();
    const alias = options.alias ?? options.developmentIdentity?.alias;
    this.diagnostics = {
      logger: options.logger ?? (() => undefined),
      ...(alias === undefined ? {} : { alias }),
    };
  }

  async connect(signal: AbortSignal): Promise<ConsumerConnection> {
    if (signal.aborted) throw abortError(signal);
    const socketOptions = await this.connectionOptions(); // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- The signal can abort while credential files are read.
    if (signal.aborted) throw abortError(signal);
    return new Promise<ConsumerConnection>((resolve, reject) => {
      const socket = new WebSocket(this.url, socketOptions);
      const abort = (): void => {
        socket.terminate();
        reject(abortError(signal));
      };
      const fail = (): void => {
        signal.removeEventListener('abort', abort);
        reject(new Error('Could not connect consumer WebSocket'));
      };
      socket.once('open', () => {
        signal.removeEventListener('abort', abort);
        socket.removeListener('error', fail);
        resolve(new WebSocketConsumerConnection(socket, this.diagnostics));
      });
      socket.once('error', fail);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async connectionOptions(): Promise<ClientOptions> {
    const headers: Record<string, string> = {};
    if (this.options.bearerTokenFile !== undefined) {
      headers.authorization = `Bearer ${await readBearerTokenFile(this.options.bearerTokenFile)}`;
    }
    const identity = this.options.developmentIdentity;
    if (identity !== undefined && this.environment !== 'production') {
      headers['x-cauce-tenant'] = identity.tenant_id;
      headers['x-cauce-alias'] = identity.alias;
    }

    const tls = this.options.mutualTls;
    if (tls === undefined) return Object.keys(headers).length === 0 ? {} : { headers };
    const [cert, key, ca] = await Promise.all([
      readOwnerOnlyFile(tls.certFile, 'mTLS certificate'),
      readOwnerOnlyFile(tls.keyFile, 'mTLS private key'),
      readOwnerOnlyFile(tls.caFile, 'mTLS CA certificate'),
    ]);
    try {
      createSecureContext({ cert, key, ca });
    } catch (error) {
      throw new SecureFileError('mTLS certificate material is invalid', { cause: error });
    }
    return { headers, cert, key, ca, rejectUnauthorized: true };
  }
}

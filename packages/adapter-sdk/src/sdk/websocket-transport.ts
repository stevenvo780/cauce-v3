import { createSecureContext } from 'node:tls';
import WebSocket, { type ClientOptions } from 'ws';
import { WsInboundSchema, WsOutboundSchema, type Tenant } from '@cauce/protocol';
import { readBearerTokenFile, readOwnerOnlyFile, SecureFileError } from './secure-files.js';
import type {
  ClientFrame,
  ConsumerConnection,
  ConsumerConnector,
  ServerFrame,
} from './types.js';

class AsyncFrameQueue implements AsyncIterable<ServerFrame> {
  private readonly values: ServerFrame[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<ServerFrame>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private failure: unknown;

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

  fail(error: unknown): void {
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

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.queue.fail(new Error('Binary gateway frames are not supported'));
        return;
      }
      try {
        this.queue.push(parseServerFrame(JSON.parse(data.toString('utf8'))));
      } catch (error) {
        this.queue.fail(new Error('Gateway sent a frame outside the Cauce V3 schema', { cause: error }));
      }
    });
    socket.on('close', () => this.queue.end());
    socket.on('error', () => this.queue.fail(new Error('WebSocket consumer failed')));
  }

  async send(frame: ClientFrame): Promise<void> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket consumer is not open');
    const encoded = JSON.stringify(encodeClientFrame(frame));
    await new Promise<void>((resolve, reject) => {
      this.socket.send(encoded, (error) => {
        if (error == null) resolve();
        else reject(error);
      });
    });
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
}

export class WebSocketConsumerConnector implements ConsumerConnector {
  private readonly url: string;
  private readonly environment: NonNullable<WebSocketConnectorOptions['environment']>;

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
  }

  async connect(signal: AbortSignal): Promise<ConsumerConnection> {
    if (signal.aborted) throw signal.reason ?? new Error('Connection aborted');
    const socketOptions = await this.connectionOptions();
    if (signal.aborted) throw signal.reason ?? new Error('Connection aborted');
    return new Promise<ConsumerConnection>((resolve, reject) => {
      const socket = new WebSocket(this.url, socketOptions);
      const abort = (): void => {
        socket.terminate();
        reject(signal.reason ?? new Error('Connection aborted'));
      };
      const fail = (): void => {
        signal.removeEventListener('abort', abort);
        reject(new Error('Could not connect consumer WebSocket'));
      };
      socket.once('open', () => {
        signal.removeEventListener('abort', abort);
        socket.removeListener('error', fail);
        resolve(new WebSocketConsumerConnection(socket));
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

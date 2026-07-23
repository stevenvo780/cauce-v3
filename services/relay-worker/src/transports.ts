import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type {
  OriginRelayEvent, OriginTransport, OriginTransportRegistry, OriginTransportResult
} from './types.js';
import { OriginTransportError } from './types.js';

export class MapOriginTransportRegistry implements OriginTransportRegistry {
  private readonly transports = new Map<string, OriginTransport>();

  constructor(entries: Iterable<readonly [string, OriginTransport]> = []) {
    for (const [adapter, transport] of entries) this.transports.set(adapter, transport);
  }

  register(adapter: string, transport: OriginTransport): void {
    if (!/^[a-z][a-z0-9_-]{0,63}$/i.test(adapter)) throw new Error('invalid adapter name');
    this.transports.set(adapter, transport);
  }

  forAdapter(adapter: string): OriginTransport | undefined {
    return this.transports.get(adapter);
  }

  adapters(): readonly string[] {
    return [...this.transports.keys()];
  }
}

/** Deterministic transport for tests; duplicate event IDs do not produce a second effect. */
export class FakeOriginTransport implements OriginTransport {
  readonly effects: OriginRelayEvent[] = [];
  private readonly results = new Map<string, OriginTransportResult>();
  private readonly failures: OriginTransportError[];

  constructor(failures: OriginTransportError[] = []) {
    this.failures = [...failures];
  }

  async send(event: OriginRelayEvent): Promise<OriginTransportResult> {
    const existing = this.results.get(event.event_id);
    if (existing) return { ...existing, duplicate: true };
    const failure = this.failures.shift();
    if (failure) throw failure;
    const result = { provider_message_id: `fake:${event.event_id}` };
    this.effects.push(event);
    this.results.set(event.event_id, result);
    return result;
  }
}

export interface WebhookSignature {
  readonly header: string;
  readonly value: string;
}

/** Provider owns endpoint resolution and secret-backed signing; the secret is never returned. */
export interface WebhookProvider {
  endpoint(event: OriginRelayEvent): Promise<string | URL>;
  sign(payload: Uint8Array, event: OriginRelayEvent): Promise<WebhookSignature>;
}

export interface HttpWebhookTransportOptions {
  provider: WebhookProvider;
  allowedOrigins: readonly string[];
  /** Test seam. Production uses a pinned node:https connection. */
  fetcher?: typeof fetch;
  resolver?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  timeoutMs?: number;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.origin !== value.replace(/\/$/, '')) {
    throw new Error('webhook allowlist entries must be exact HTTPS origins');
  }
  return url.origin;
}

function signatureHeader(name: string): string {
  if (!/^x-[a-z0-9-]+$/i.test(name) || ['x-forwarded-host', 'x-forwarded-for', 'x-real-ip'].includes(name.toLowerCase())) {
    throw new OriginTransportError('webhook signature header is not allowed', false);
  }
  return name;
}

function publicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && c === 0) || (b === 0 && c === 2))) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function publicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) return publicIpv4(normalized.slice(7));
  return normalized !== '::' && normalized !== '::1' &&
    !normalized.startsWith('fc') && !normalized.startsWith('fd') &&
    !/^fe[89ab]/.test(normalized) && !normalized.startsWith('ff') &&
    !normalized.startsWith('2001:db8:');
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  if (isIP(hostname) === 4) return [{ address: hostname, family: 4 }];
  if (isIP(hostname) === 6) return [{ address: hostname, family: 6 }];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => {
    if (entry.family !== 4 && entry.family !== 6) throw new Error('DNS returned an unsupported address family');
    return { address: entry.address, family: entry.family };
  });
}

interface WebhookHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly providerMessageId?: string;
}

function pinnedHttpsRequest(
  endpoint: URL,
  address: ResolvedAddress,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number
): Promise<WebhookHttpResult> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(timeoutMs);
    const request = httpsRequest({
      protocol: 'https:',
      hostname: endpoint.hostname,
      port: endpoint.port || 443,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      headers,
      signal,
      servername: endpoint.hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, (response) => {
      response.resume();
      const providerMessageId = response.headers['x-provider-message-id'];
      resolve({
        ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode ?? 0,
        ...(typeof providerMessageId === 'string' ? { providerMessageId } : {})
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

export class HttpWebhookOriginTransport implements OriginTransport {
  private readonly provider: WebhookProvider;
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly fetcher: typeof fetch | undefined;
  private readonly resolver: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  private readonly timeoutMs: number;

  constructor(options: HttpWebhookTransportOptions) {
    if (options.allowedOrigins.length === 0) throw new Error('at least one webhook origin must be allowlisted');
    this.provider = options.provider;
    this.allowedOrigins = new Set(options.allowedOrigins.map(exactOrigin));
    this.fetcher = options.fetcher;
    this.resolver = options.resolver ?? defaultResolver;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(event: OriginRelayEvent): Promise<OriginTransportResult> {
    const endpoint = new URL(await this.provider.endpoint(event));
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !this.allowedOrigins.has(endpoint.origin)) {
      throw new OriginTransportError('webhook endpoint is not allowlisted', false);
    }
    const body = JSON.stringify({
      event_id: event.event_id,
      attempt: event.attempt,
      tenant_id: event.tenant_id,
      adapter: event.adapter,
      request_id: event.request_id,
      message_id: event.message_id,
      delivery_id: event.delivery_id,
      trace_id: event.trace_id,
      origin: event.origin,
      payload: event.payload
    });
    const bytes = new TextEncoder().encode(body);
    const signature = await this.provider.sign(bytes, event);
    const resolved = await this.resolver(endpoint.hostname).catch(() => []);
    if (resolved.length === 0 || resolved.some((entry) => !publicIp(entry.address))) {
      throw new OriginTransportError('webhook endpoint resolved to a non-public address', false);
    }
    const headers = {
      'content-type': 'application/json',
      'content-length': String(bytes.byteLength),
      'idempotency-key': event.event_id,
      [signatureHeader(signature.header)]: signature.value
    };
    let response: WebhookHttpResult;
    try {
      if (this.fetcher) {
        const fetched = await this.fetcher(endpoint, {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers, body
        });
        response = {
          ok: fetched.ok,
          status: fetched.status,
          ...(fetched.headers.get('x-provider-message-id') === null
            ? {}
            : { providerMessageId: fetched.headers.get('x-provider-message-id')! })
        };
      } else {
        response = await pinnedHttpsRequest(endpoint, resolved[0]!, headers, body, this.timeoutMs);
      }
    } catch (error) {
      if (error instanceof OriginTransportError) throw error;
      throw new OriginTransportError('webhook request failed', true);
    }
    if (response.ok) {
      return {
        ...(response.providerMessageId === undefined ? {} : { provider_message_id: response.providerMessageId })
      };
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      throw new OriginTransportError(`webhook returned retryable HTTP ${response.status}`, true);
    }
    throw new OriginTransportError(`webhook returned terminal HTTP ${response.status}`, false);
  }
}

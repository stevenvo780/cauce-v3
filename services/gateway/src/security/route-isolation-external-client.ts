import { setTimeout as sleep } from 'node:timers/promises';

export interface ExternalSession { readonly cookie: string; readonly csrf: string }
export interface ExternalResponse { readonly status: number; readonly body: string; readonly setCookies: string[]; readonly retryAfter: string | null }
export interface ExternalRequest {
  readonly session?: ExternalSession | undefined;
  /** `false` leaves the session CSRF out; a string replaces it. */
  readonly csrf?: string | false;
  readonly cookie?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly raw?: { readonly body: string; readonly contentType: string };
}
export interface ExternalClientOptions {
  readonly ratePerSecond: number;
  readonly maxRequests: number;
  readonly timeoutMs?: number;
  readonly maxRetryAfterMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Plain HTTPS is mandatory except on loopback, where the local rehearsal runs the same code. */
export function verifiedBaseUrl(value: string): URL {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('base URL must be a bare origin without credentials, path, query or fragment');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new Error('base URL must use https (http is accepted only on loopback)');
  }
  return new URL(url.origin);
}

/** Serial, paced and budgeted HTTP client locked to one origin; it never follows redirects. */
export class ExternalClient {
  readonly origin: string;
  requests = 0;
  private nextSlot = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly intervalMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(readonly baseUrl: URL, private readonly options: ExternalClientOptions) {
    if (!(options.ratePerSecond > 0 && options.ratePerSecond <= 100)) throw new Error('rate must be within (0, 100] requests per second');
    if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1) throw new Error('max requests must be a positive integer');
    this.origin = baseUrl.origin;
    this.intervalMs = 1000 / options.ratePerSecond;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  url(path: string): URL {
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`refusing a non-absolute request path: ${path}`);
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.origin) throw new Error(`refusing a request outside ${this.origin}`);
    return url;
  }

  /** Waits for the next pacing slot; the WebSocket probes share the same budget. */
  async slot(): Promise<void> {
    const turn = this.queue.then(async () => {
      if (this.requests >= this.options.maxRequests) throw new Error(`request budget exhausted (${String(this.options.maxRequests)})`);
      const wait = this.nextSlot - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextSlot = Date.now() + this.intervalMs;
      this.requests += 1;
    });
    this.queue = turn.catch(() => undefined);
    await turn;
  }

  async send(method: string, path: string, request: ExternalRequest = {}): Promise<ExternalResponse> {
    const url = this.url(path);
    const headers: Record<string, string> = { accept: 'application/json', origin: this.origin, ...(request.headers ?? {}) };
    const cookie = request.cookie ?? request.session?.cookie;
    if (cookie !== undefined) headers.cookie = cookie;
    const csrf = request.csrf === false ? undefined : request.csrf ?? request.session?.csrf;
    // Sent on every method, like the console's own reads: HEAD on some console routes is held to the CSRF rule.
    if (csrf !== undefined) headers['x-csrf-token'] = csrf;
    if (request.json !== undefined) headers['content-type'] = 'application/json';
    if (request.raw !== undefined) headers['content-type'] = request.raw.contentType;
    const body = request.json !== undefined ? JSON.stringify(request.json) : request.raw?.body;
    for (let attempt = 0; ; attempt += 1) {
      await this.slot();
      const response = await this.fetchImpl(url, { method, headers, redirect: 'manual', ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000) });
      const text = method === 'HEAD' ? '' : await response.text();
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter !== null && /^\d{1,4}$/u.test(retryAfter) ? Number(retryAfter) * 1000 : Number.POSITIVE_INFINITY;
      if (response.status === 429 && attempt === 0 && waitMs <= (this.options.maxRetryAfterMs ?? 60_000)) {
        await sleep(waitMs);
        continue;
      }
      return { status: response.status, body: text, setCookies: response.headers.getSetCookie(), retryAfter };
    }
  }

  async login(email: string, password: string): Promise<ExternalSession> {
    const response = await this.send('POST', '/v3/auth/login', { json: { email, password } });
    if (response.status !== 200) throw new Error(`canary login failed (HTTP ${String(response.status)})`);
    const cookies = response.setCookies.map(value => value.split(';', 1)[0] ?? '').filter(Boolean);
    const csrf = (JSON.parse(response.body) as { csrf_token?: unknown }).csrf_token;
    if (!cookies.length || typeof csrf !== 'string' || !csrf) throw new Error('canary login returned no signed session');
    return { cookie: cookies.join('; '), csrf };
  }
}

export function parseJson(body: string): unknown {
  if (!body.startsWith('{') && !body.startsWith('[')) return undefined;
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

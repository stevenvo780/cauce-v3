import type { ConsoleAuthState } from './types';
import {
  ApiError,
  corteAlVencer,
  errorBody,
  esperaVencida,
  isUnsafeMethod,
  safeBase,
  TIEMPO_MAXIMO_MS,
  type FetchLike,
  type RequestOptions,
} from './client/core';
import { systemClient, type RequestFn, type SystemClient } from './client/system-client';
import { messagingClient, type MessagingClient } from './client/messaging-client';
import { agentClient, type AgentClient } from './client/agent-client';

/**
 * A 401 on ANY data call is the session dying, and until it is noticed the console keeps painting
 * error cards inside a shell that no longer has a session behind it. The gate polls every 60 s, so
 * the operator could spend a full minute clicking on a console that can no longer write anything.
 * The client cannot decide the session — only the server does — so it announces the fact and the
 * gate revalidates against `/v3/auth/session` right away.
 */
type UnauthorizedListener = () => void;

/**
 * The auth endpoints are excluded from the announcement: `/v3/auth/session` answering 401 would
 * make the listener ask it again in a loop, and a 401 from `/v3/auth/login` is a wrong password,
 * not an expired session.
 */
const AUTH_PATH = '/v3/auth/';

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging -- the merge IS the surface; client.test.ts asserts every merged method at runtime. */
export interface CauceApi extends SystemClient, MessagingClient, AgentClient {}

export class CauceApi {
  private readonly baseUrl: string;
  private csrfToken: string | undefined;
  private bffSessionSupported: boolean | null = null;
  private readonly developmentIdentity?: { tenant: string; alias: string };
  private readonly unauthorizedListeners = new Set<UnauthorizedListener>();

  constructor(
    baseUrl = import.meta.env.VITE_CAUCE_API_BASE ?? '',
    private readonly fetcher?: FetchLike,
    developmentIdentity: { tenant: string; alias: string } | undefined = import.meta.env.DEV
      && import.meta.env.VITE_CAUCE_DEV_TENANT
      ? { tenant: import.meta.env.VITE_CAUCE_DEV_TENANT ?? '', alias: import.meta.env.VITE_CAUCE_DEV_ALIAS ?? '' }
      : undefined,
    private readonly tiempoMaximoMs: number = TIEMPO_MAXIMO_MS,
  ) {
    this.baseUrl = safeBase(baseUrl);
    if (developmentIdentity && (!developmentIdentity.tenant || !developmentIdentity.alias)) {
      throw new Error('Explicit dev auth requires VITE_CAUCE_DEV_TENANT and VITE_CAUCE_DEV_ALIAS');
    }
    this.developmentIdentity = developmentIdentity;
    const request: RequestFn = <T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> =>
      this.request<T>(path, init, options);
    Object.assign(this, systemClient(request), messagingClient(request), agentClient(request));
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    { requireCsrf = true, mapError }: RequestOptions = {},
  ): Promise<T> {
    const method = init.method?.toUpperCase() ?? 'GET';
    const unsafe = isUnsafeMethod(method);
    const csrfToken = unsafe && requireCsrf ? await this.csrfForMutation() : undefined;

    const propio = init.signal || !(this.tiempoMaximoMs > 0) ? undefined : new AbortController();
    const reloj = propio ? setTimeout(() => { propio.abort(); }, this.tiempoMaximoMs) : undefined;

    let response: Response | undefined;
    let body: unknown;
    try {
      const peticionCompleta = async () => {
        const customHeaders = init.headers instanceof Headers
          ? Object.fromEntries(init.headers.entries())
          : Array.isArray(init.headers)
            ? Object.fromEntries(init.headers)
            : (init.headers ?? {});

        response = await (this.fetcher ?? fetch)(`${this.baseUrl}${path}`, {
          credentials: 'include',
          ...init,
          method,
          signal: init.signal ?? propio?.signal,
          headers: {
            Accept: 'application/json',
            'X-Cauce-Console': '1',
            ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
            ...(this.developmentIdentity ? {
              'X-Cauce-Tenant': this.developmentIdentity.tenant,
              'X-Cauce-Alias': this.developmentIdentity.alias,
            } : {}),
            ...(init.body ? { 'Content-Type': 'application/json' } : {}),
            ...customHeaders,
          },
        });

        const contentType = response.headers.get('content-type') ?? '';
        body = response.status === 204
          ? undefined
          : contentType.includes('application/json')
            ? await response.json()
            : await response.text();
      };
      const completa = peticionCompleta();
      if (propio) {
        await Promise.race([
          completa,
          corteAlVencer(propio.signal, method, path, this.tiempoMaximoMs),
        ]);
      } else {
        await completa;
      }
    } catch (cause) {
      if (cause instanceof ApiError) throw cause;
      if (propio?.signal.aborted) throw esperaVencida(method, path, this.tiempoMaximoMs);
      throw cause;
    } finally {
      if (reloj !== undefined) clearTimeout(reloj);
    }

    if (response === undefined) throw new Error('la petición terminó sin respuesta HTTP');

    if (!response.ok) {
      if (response.status === 401) {
        this.csrfToken = undefined;
        if (!path.startsWith(AUTH_PATH)) this.announceUnauthorized();
      }
      const mapped = mapError?.(response.status, body);
      if (mapped !== undefined) throw mapped;
      const detail = errorBody(body);
      throw new ApiError(detail.message ?? (response.statusText || 'API request failed'), response.status, detail.error);
    }
    return body as T;
  }

  /** Subscribes to the 401s. Returns the unsubscription: a listener that outlives its component
   * would revalidate on behalf of a gate that is no longer mounted. */
  onUnauthorized(listener: UnauthorizedListener): () => void {
    this.unauthorizedListeners.add(listener);
    return () => { this.unauthorizedListeners.delete(listener); };
  }

  private announceUnauthorized(): void {
    for (const listener of [...this.unauthorizedListeners]) listener();
  }

  async csrfForMutation(): Promise<string | undefined> {
    if (this.developmentIdentity !== undefined || this.bffSessionSupported === false) return undefined;
    if (this.csrfToken) return this.csrfToken;
    const state = await this.getAuthSession();
    if (state.authenticated === null) return undefined;
    if (!state.authenticated || !this.csrfToken) throw new ApiError('Authentication required', 401, 'unauthorized');
    return this.csrfToken;
  }

  getLoginUrl(): string {
    return `${this.baseUrl}/v3/auth/login`;
  }

  async login(email: string, password: string): Promise<ConsoleAuthState> {
    const state = await this.request<ConsoleAuthState>('/v3/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, { requireCsrf: false });
    this.bffSessionSupported = true;
    this.csrfToken = typeof state.csrf_token === 'string' ? state.csrf_token : undefined;
    return state;
  }

  async getAuthSession(): Promise<ConsoleAuthState> {
    try {
      const state = await this.request<ConsoleAuthState>('/v3/auth/session');
      this.bffSessionSupported = true;
      this.csrfToken = state.authenticated && typeof state.csrf_token === 'string' ? state.csrf_token : undefined;
      return state;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        this.bffSessionSupported = false;
        return { authenticated: null, reason: 'El gateway usa autenticación no-BFF.' };
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.request<undefined>('/v3/auth/logout', { method: 'POST' });
    this.csrfToken = undefined;
  }
}

export const cauceApi = new CauceApi();

export {
  ApiError,
  PublishIntentReconciliationError,
  PublishIntentExpiredError,
  PublishIntentRateLimitedError,
  TIEMPO_MAXIMO_MS,
  type RequestOptions,
} from './client/core';

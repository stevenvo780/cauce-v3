import { nativeAdminClient, type NativeAdminClient } from '../features/live/native-admin/client';
import { nativeContextRepositoryClient, type NativeContextRepositoryClient } from './client/native-context-repository-client';
import { contextRepositoryClient, type ContextRepositoryClient } from './client/context-repository-client';
import type { ConsoleAuthState, PendingDeviceAuthorization } from './types';
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
import { providerAuthClient, type ProviderAuthClient } from './client/provider-auth-client';
import { peopleAdminClient, type PeopleAdminClient } from './client/people-admin-client';
import { fleetOperationsClient, type FleetOperationsClient } from './client/fleet-operations-client';
import { fleetHostsClient, type FleetHostsClient } from './client/fleet-hosts-client';
import { clientDelegationsClient, type ClientDelegationsClient } from './client/client-delegations-client';
import { agentPreferencesClient, type AgentPreferencesClient } from './client/agent-preferences-client';
import { companyClient, type CompanyClient, type RegistrationInput, type RegistrationResult } from './client/company-client';
import { contextVersionsClient, type ContextVersionsClient } from './client/context-versions-client';
import { myQuotasClient, type MyQuotasClient } from './client/my-quotas-client';
import { registrationReceipt } from './client/v4-responses';
import { hostEnrollmentClient, type HostEnrollmentClient } from './client/host-enrollment-client';
import { spaceBackupsClient, type SpaceBackupsClient } from './client/space-backups-client';
import { terminalGrantsClient, type TerminalGrantsClient } from './client/terminal-grants-client';
import { readBoundedBlob } from './client/bounded-blob';
/**
 * A 401 on ANY data call is the session dying, and until it is noticed the console keeps painting
 * error cards inside a shell that no longer has a session behind it. The gate polls every 60 s, so
 * the operator could spend a full minute clicking on a console that can no longer write anything.
 * The client cannot decide the session — only the server does — so it announces the fact and the
 * gate revalidates against `/v3/auth/session` right away.
 */
type UnauthorizedListener = () => void;

/** Transient loss of the gateway, shown as one discreet notice: reads retry on their own, writes wait for a person. */
export type ConnectionNotice = { kind: 'reconnecting' } | { kind: 'unreachable' } | { kind: 'write-failed' };

const RECONNECT_DELAYS_MS = [250, 750, 1_500];

function isTransientFailure(cause: unknown): boolean {
  if (cause instanceof ApiError) return cause.status === 502 || cause.status === 503;
  return cause instanceof TypeError;
}
/**
 * The auth endpoints are excluded from the announcement: `/v3/auth/session` answering 401 would
 * make the listener ask it again in a loop, and a 401 from `/v3/auth/login` is a wrong password,
 * not an expired session.
 */
function isTimeout(cause: unknown): boolean {
  return cause instanceof ApiError && cause.code === 'timeout';
}
const AUTH_PATH = '/v3/auth/';

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging -- the merge IS the surface; client.test.ts asserts every merged method at runtime. */
export interface CauceApi extends SystemClient, MessagingClient, AgentClient, ContextRepositoryClient, NativeContextRepositoryClient, ClientDelegationsClient, FleetOperationsClient, FleetHostsClient, ProviderAuthClient, PeopleAdminClient, NativeAdminClient, AgentPreferencesClient, CompanyClient, ContextVersionsClient, MyQuotasClient, HostEnrollmentClient, SpaceBackupsClient, TerminalGrantsClient {}

export class CauceApi {
  private readonly baseUrl: string;
  private csrfToken: string | undefined;
  private authGeneration = 0;
  private sessionRead = 0;
  private confirmedSession?: ConsoleAuthState;
  private profileRequest?: Promise<{ name: string }>;
  private sessionIdentity: string | undefined;
  private sessionRequest?: { generation: number; promise: Promise<ConsoleAuthState> };
  private bffSessionSupported: boolean | null = null;
  private companySwitchInFlight = false;
  private companyScopeVerified = true;
  private readonly developmentIdentity?: { tenant: string; alias: string };
  private connectionNoticeState: ConnectionNotice | undefined;
  private failedWrite: (() => Promise<unknown>) | undefined;
  private readonly connectionListeners = new Set<(notice: ConnectionNotice | undefined) => void>();
  private readonly unauthorizedListeners = new Set<UnauthorizedListener>();
  private readonly authSessionListeners = new Set<(state: ConsoleAuthState) => void>();
  private readonly authGenerationListeners = new Set<() => void>();

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
    Object.assign(this, systemClient(request), messagingClient(request), agentClient(request), contextRepositoryClient(request), nativeContextRepositoryClient(request));
    Object.assign(this, nativeAdminClient(request, () => this.authGeneration));
    Object.assign(this, clientDelegationsClient(request), fleetOperationsClient(request, () => this.authGeneration), fleetHostsClient(request), providerAuthClient(request), peopleAdminClient(request), agentPreferencesClient(request));
    Object.assign(this, companyClient(request), contextVersionsClient(request), myQuotasClient(request));
    Object.assign(this, hostEnrollmentClient(request), spaceBackupsClient(request, this.baseUrl), terminalGrantsClient(request));
  }

  get connectionNotice(): ConnectionNotice | undefined {
    return this.connectionNoticeState;
  }

  onConnectionNotice(listener: (notice: ConnectionNotice | undefined) => void): () => void {
    this.connectionListeners.add(listener);
    return () => { this.connectionListeners.delete(listener); };
  }

  private setConnectionNotice(notice: ConnectionNotice | undefined): void {
    if (notice?.kind !== 'write-failed' && notice !== undefined && this.connectionNoticeState?.kind === 'write-failed') return;
    if (notice === undefined && this.connectionNoticeState?.kind === 'write-failed') return;
    if (notice?.kind === 'reconnecting' && this.connectionNoticeState?.kind === 'unreachable') return;
    this.connectionNoticeState = notice;
    for (const listener of [...this.connectionListeners]) listener(notice);
  }

  dismissConnectionNotice(): void {
    this.failedWrite = undefined;
    this.connectionNoticeState = undefined;
    for (const listener of [...this.connectionListeners]) listener(undefined);
  }

  async retryLastFailedWrite(): Promise<unknown> {
    const retry = this.failedWrite;
    if (!retry) return undefined;
    const result = await retry();
    this.dismissConnectionNotice();
    return result;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const method = init.method?.toUpperCase() ?? 'GET';
    if (isUnsafeMethod(method)) {
      try {
        return await this.requestOnce<T>(path, init, options);
      } catch (cause) {
        if (isTransientFailure(cause)) {
          this.failedWrite = () => this.requestOnce(path, init, options);
          this.connectionNoticeState = { kind: 'write-failed' };
          for (const listener of [...this.connectionListeners]) listener(this.connectionNoticeState);
        }
        throw cause;
      }
    }
    let lastCause: unknown;
    for (let attempt = 0; attempt <= RECONNECT_DELAYS_MS.length; attempt += 1) {
      try {
        const result = await this.requestOnce<T>(path, init, options);
        // Any answer proves the gateway is back, also for a read that never had to retry.
        if (attempt > 0 || this.connectionNoticeState !== undefined) this.setConnectionNotice(undefined);
        return result;
      } catch (cause) {
        lastCause = cause;
        if (isTimeout(cause)) break; // retrying a 30 s wait would keep the banner for minutes
        if (!isTransientFailure(cause) || attempt === RECONNECT_DELAYS_MS.length || init.signal?.aborted) break;
        this.setConnectionNotice({ kind: 'reconnecting' });
        await new Promise((resolve) => { setTimeout(resolve, RECONNECT_DELAYS_MS[attempt]); });
        if (init.signal?.aborted) break;
      }
    }
    // A gateway that still does not answer stays visible (with an action) until a read succeeds;
    // clearing here made the banner flicker or vanish while the chat stayed frozen.
    this.setConnectionNotice(isTransientFailure(lastCause) || isTimeout(lastCause) ? { kind: 'unreachable' } : undefined);
    throw lastCause;
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const { requireCsrf = true, mapError, responseMode, maxResponseBytes } = options;
    const requestGeneration = this.authGeneration;
    const method = init.method?.toUpperCase() ?? 'GET';
    const unsafe = isUnsafeMethod(method);
    if (unsafe && this.companySwitchInFlight && path !== '/v3/auth/session/company') {
      throw new ApiError('Hay un cambio de empresa en curso. Espera su confirmación antes de otra operación.', 409, 'company_switch_in_flight');
    }
    if (unsafe && !this.companyScopeVerified && !['/v3/auth/session/company', '/v3/auth/logout', '/v3/auth/login', '/v3/auth/register'].includes(path)) {
      throw new ApiError('No se pudo verificar la empresa de la sesión. Relee la sesión antes de escribir.', 409, 'company_scope_unverified');
    }
    const csrfToken = unsafe && requireCsrf ? await this.csrfForMutation() : undefined;

    if (unsafe && requestGeneration !== this.authGeneration) {
      throw new ApiError('La sesión cambió antes de enviar la operación. Reintenta desde la cuenta actual.', 409, 'session_changed');
    }

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
          : response.ok && responseMode === 'stream' ? response
          : response.ok && responseMode === 'blob'
            ? await readBoundedBlob(response, maxResponseBytes)
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
      if (response.status === 401 && !path.startsWith(AUTH_PATH)
          && requestGeneration === this.authGeneration) {
        this.csrfToken = undefined;
        this.announceUnauthorized();
      }
      const mapped = mapError?.(response.status, body);
      if (mapped !== undefined) throw mapped;
      const detail = errorBody(body);
      throw new ApiError(detail.message ?? (response.statusText || 'API request failed'), response.status, detail.error, detail.dependencies);
    }
    if ((responseMode === 'blob' || responseMode === 'stream') && requestGeneration !== this.authGeneration) {
      if (responseMode === 'stream') await response.body?.cancel().catch(() => undefined);
      throw new ApiError('La sesión cambió mientras se recibía el archivo.', 409, 'session_changed');
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

  onAuthSession(listener: (state: ConsoleAuthState) => void): () => void {
    this.authSessionListeners.add(listener);
    return () => { this.authSessionListeners.delete(listener); };
  }

  onAuthGenerationChange(listener: () => void): () => void {
    this.authGenerationListeners.add(listener);
    return () => { this.authGenerationListeners.delete(listener); };
  }

  private advanceAuthGeneration(): void {
    this.authGeneration += 1;
    for (const listener of [...this.authGenerationListeners]) listener();
  }

  private acceptSession(state: ConsoleAuthState): void {
    this.companyScopeVerified = state.authenticated !== null || !this.companySwitchInFlight;
    const identity = JSON.stringify([state.authenticated, state.subject, state.csrf_token, state.home_tenant,
      state.authority?.acting_company, state.authority?.role, state.authority?.scope]);
    if (this.sessionIdentity !== undefined && identity !== this.sessionIdentity) this.advanceAuthGeneration();
    this.confirmedSession = state;
    this.sessionIdentity = identity;
    this.bffSessionSupported = state.authenticated !== null;
    this.csrfToken = state.authenticated && typeof state.csrf_token === 'string' ? state.csrf_token : undefined;
    for (const listener of [...this.authSessionListeners]) listener(state);
  }

  async login(email: string, password: string): Promise<ConsoleAuthState> {
    this.profileRequest = undefined;
    this.advanceAuthGeneration();
    const generation = this.authGeneration;
    this.sessionRead += 1;
    const state = await this.request<ConsoleAuthState>('/v3/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }, { requireCsrf: false });
    if (generation === this.authGeneration) this.acceptSession(state);
    return state;
  }

  async register(input: RegistrationInput): Promise<RegistrationResult> {
    return registrationReceipt(await this.request('/v3/auth/register', { method: 'POST', body: JSON.stringify(input) }, { requireCsrf: false }));
  }

  async getDeviceAuthorization(userCode: string): Promise<PendingDeviceAuthorization> {
    return this.request<PendingDeviceAuthorization>(`/v3/auth/device/${encodeURIComponent(userCode)}`);
  }

  async decideDeviceAuthorization(userCode: string, decision: 'approve' | 'deny'): Promise<{ status: 'approved' | 'denied' }> {
    return this.request<{ status: 'approved' | 'denied' }>('/v3/auth/device/approve', {
      method: 'POST', body: JSON.stringify({ user_code: userCode, decision }),
    });
  }

  async switchCompany(companyId: string | null): Promise<ConsoleAuthState> {
    if (this.companySwitchInFlight) throw new ApiError('Ya hay un cambio de empresa en curso.', 409, 'company_switch_in_flight');
    this.companySwitchInFlight = true;
    this.companyScopeVerified = false;
    this.advanceAuthGeneration();
    const generation = this.authGeneration;
    this.sessionRead += 1;
    try {
      const state = await this.request<ConsoleAuthState>('/v3/auth/session/company', {
        method: 'POST', body: JSON.stringify({ company_id: companyId }),
      });
      if (generation === this.authGeneration) this.acceptSession(state);
      return state;
    } catch (cause) {
      await this.getAuthSession().catch(() => undefined);
      throw cause;
    } finally { this.companySwitchInFlight = false; }
  }

  updateHumanProfile(name: string): Promise<{ name: string }> {
    if (this.profileRequest) return Promise.reject(new Error('Ya hay un nombre guardándose. Espera y reintenta.'));
    const generation = this.authGeneration;
    this.sessionRead += 1;
    this.sessionRequest = undefined;
    const promise = this.saveHumanProfile(name, generation);
    this.profileRequest = promise;
    const clear = () => { if (this.profileRequest === promise) this.profileRequest = undefined; };
    void promise.then(clear, clear);
    return promise;
  }

  private async saveHumanProfile(name: string, generation: number): Promise<{ name: string }> {
    const session = this.confirmedSession;
    if (!session?.authenticated || session.login_mode !== 'password') {
      throw new ApiError('Hace falta una sesión de persona con contraseña.', 401, 'unauthorized');
    }
    const saved = await this.request<{ name: string }>('/v3/auth/profile', {
      method: 'PATCH', body: JSON.stringify({ name }),
    });
    if (generation !== this.authGeneration) throw new ApiError('La sesión cambió.', 409, 'session_changed');
    if (typeof saved.name !== 'string' || !saved.name.trim() || Array.from(saved.name).length > 120) {
      throw new Error('El servidor no confirmó el nombre.');
    }
    this.sessionRead += 1;
    this.sessionRequest = undefined;
    this.acceptSession({ ...session, name: saved.name });
    return saved;
  }

  getAuthSession(): Promise<ConsoleAuthState> {
    if (this.profileRequest) return this.profileRequest.then(
      () => this.getAuthSession(), () => this.getAuthSession(),
    );
    const generation = this.authGeneration;
    if (this.sessionRequest?.generation === generation) return this.sessionRequest.promise;
    const promise = this.readAuthSession(generation, ++this.sessionRead);
    this.sessionRequest = { generation, promise };
    const clear = () => { if (this.sessionRequest?.promise === promise) this.sessionRequest = undefined; };
    void promise.then(clear, clear);
    return promise;
  }

  private async readAuthSession(generation: number, read: number): Promise<ConsoleAuthState> {
    try {
      const state = await this.request<ConsoleAuthState>('/v3/auth/session');
      if (generation === this.authGeneration && read === this.sessionRead) this.acceptSession(state);
      if (generation === this.authGeneration && read !== this.sessionRead) {
        if (this.profileRequest) await this.profileRequest.catch(() => undefined);
        return this.confirmedSession ?? state;
      }
      return state;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        const state: ConsoleAuthState = { authenticated: null, reason: 'El gateway usa autenticación no-BFF.' };
        if (generation === this.authGeneration && read === this.sessionRead) this.acceptSession(state);
        return state;
      }
      throw error;
    }
  }

  async logout(): Promise<void> {
    this.profileRequest = undefined;
    this.advanceAuthGeneration();
    const generation = this.authGeneration;
    this.sessionRead += 1;
    await this.request<undefined>('/v3/auth/logout', { method: 'POST' });
    if (generation === this.authGeneration) {
      this.csrfToken = undefined;
      this.sessionIdentity = undefined;
    }
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

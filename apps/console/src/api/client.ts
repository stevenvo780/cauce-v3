import type {
  AdapterPage,
  AgentChainSnapshot,
  AuditPage,
  CancelResult,
  ConsoleAccess,
  ConsoleAuthState,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  CreateJobInput,
  FleetActivitySnapshot,
  JobPage,
  MessagePage,
  OriginRelayPage,
  ObservabilitySnapshot,
  PublishMessageInput,
  PublishResult,
  QueueSnapshot,
  QuotaSnapshot,
  ReplayResult,
  SystemStatus,
  TerminalCapability,
  TopologySnapshot,
} from './types';

type FetchLike = typeof fetch;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function safeBase(baseUrl: string): string {
  if (!baseUrl) return '';
  const parsed = new URL(baseUrl, globalThis.location?.origin ?? 'http://localhost');
  if (parsed.username || parsed.password) {
    throw new Error('VITE_CAUCE_API_BASE must not contain credentials');
  }
  if (import.meta.env.PROD && globalThis.location?.origin && parsed.origin !== globalThis.location.origin) {
    throw new Error('Production OIDC BFF API base must be same-origin');
  }
  return baseUrl.replace(/\/$/, '');
}

function errorBody(value: unknown): { message?: string; error?: string } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.message === 'string' ? { message: record.message } : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  };
}

export class CauceApi {
  private readonly baseUrl: string;
  private readonly developmentIdentity?: { tenant: string; alias: string };
  private csrfToken?: string;
  private bffSessionSupported?: boolean;

  constructor(
    baseUrl = import.meta.env.VITE_CAUCE_API_BASE ?? '',
    private readonly fetcher?: FetchLike,
    developmentIdentity = ['true', '1'].includes(import.meta.env.VITE_CAUCE_DEV_AUTH ?? '')
      ? { tenant: import.meta.env.VITE_CAUCE_DEV_TENANT ?? '', alias: import.meta.env.VITE_CAUCE_DEV_ALIAS ?? '' }
      : undefined,
  ) {
    this.baseUrl = safeBase(baseUrl);
    if (developmentIdentity && (!developmentIdentity.tenant || !developmentIdentity.alias)) {
      throw new Error('Explicit dev auth requires VITE_CAUCE_DEV_TENANT and VITE_CAUCE_DEV_ALIAS');
    }
    this.developmentIdentity = developmentIdentity;
  }

  /**
   * `requireCsrf: false` es SÓLO para el propio login: pedirle un token CSRF a una sesión que
   * todavía no existe termina en un 401 que nunca sale al servidor. Ese POST igual está
   * protegido en el gateway por el chequeo de `Origin`/`Sec-Fetch-Site` del mismo origen.
   */
  private async request<T>(
    path: string, init: RequestInit = {}, { requireCsrf = true }: { requireCsrf?: boolean } = {},
  ): Promise<T> {
    const method = init.method?.toUpperCase() ?? 'GET';
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const csrfToken = unsafe && requireCsrf ? await this.csrfForMutation() : undefined;
    const response = await (this.fetcher ?? fetch)(`${this.baseUrl}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'X-Cauce-Console': '1',
        ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
        ...(this.developmentIdentity ? {
          'X-Cauce-Tenant': this.developmentIdentity.tenant,
          'X-Cauce-Alias': this.developmentIdentity.alias,
        } : {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });

    const contentType = response.headers.get('content-type') ?? '';
    const body: unknown = response.status === 204
      ? undefined
      : contentType.includes('application/json')
        ? await response.json()
        : await response.text();

    if (!response.ok) {
      if (response.status === 401) this.csrfToken = undefined;
      const detail = errorBody(body);
      throw new ApiError(detail.message ?? response.statusText ?? 'API request failed', response.status, detail.error);
    }
    return body as T;
  }

  private async csrfForMutation(): Promise<string | undefined> {
    if (this.developmentIdentity || this.bffSessionSupported === false) return undefined;
    if (this.csrfToken) return this.csrfToken;
    const state = await this.getAuthSession();
    if (state.authenticated === null) return undefined;
    if (!state.authenticated || !this.csrfToken) throw new ApiError('Authentication required', 401, 'unauthorized');
    return this.csrfToken;
  }

  getLoginUrl(): string {
    return `${this.baseUrl}/v3/auth/login`;
  }

  /**
   * Login por contraseña. Lo único que vuelve al navegador es el estado de la sesión: el token
   * viaja en una cookie `HttpOnly` que este código no puede leer ni guardar. El `csrf_token` de
   * la respuesta se retiene en memoria (nunca en `localStorage`) para las escrituras siguientes.
   */
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
    await this.request<void>('/v3/auth/logout', { method: 'POST' });
    this.csrfToken = undefined;
  }

  getStatus(): Promise<SystemStatus> {
    return this.request('/v3/status');
  }

  async getConsoleAccess(): Promise<ConsoleAccess> {
    try {
      return await this.request('/v3/console/access');
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        return { permissions: null, roles: null, reason: 'El gateway no publicó un snapshot RBAC verificable.' };
      }
      if (error instanceof ApiError && error.status === 403) {
        return { permissions: [], roles: [], reason: 'El servidor denegó la consulta RBAC.' };
      }
      throw error;
    }
  }

  /**
   * Actor-scoped topology: the gateway already filters tenants/rooms/ACL edges by the
   * authenticated principal, so this single snapshot also derives source rooms and
   * routable destinations. There is no separate /topology/access endpoint.
   */
  getTopology(): Promise<TopologySnapshot> {
    return this.request('/v3/console/topology');
  }

  listMessages(): Promise<MessagePage> {
    return this.request('/v3/console/messages');
  }

  publishMessage(input: PublishMessageInput): Promise<PublishResult> {
    // Deliberate allow-list: actor/session/channel/origin supplied by callers are discarded.
    const payload: PublishMessageInput = {
      room_id: input.room_id,
      recipients: input.recipients.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
      body: { text: input.body.text },
      lane: input.lane,
      priority: input.priority,
      idempotency_key: input.idempotency_key,
    };
    return this.request('/v3/console/messages', { method: 'POST', body: JSON.stringify(payload) });
  }

  getQueues(): Promise<QueueSnapshot> {
    return this.request('/v3/console/queues');
  }

  replayDelivery(deliveryId: string): Promise<ReplayResult> {
    const encoded = encodeURIComponent(deliveryId);
    return this.request(`/v3/console/deliveries/${encoded}/replay`, {
      method: 'POST',
      body: '{}',
    });
  }

  cancelDelivery(deliveryId: string, reason?: string): Promise<CancelResult> {
    const encoded = encodeURIComponent(deliveryId);
    return this.request(`/v3/console/deliveries/${encoded}/cancel`, {
      method: 'POST',
      body: JSON.stringify(reason === undefined ? {} : { reason }),
    });
  }

  listJobs(): Promise<JobPage> {
    return this.request('/v3/console/jobs');
  }

  createJob(input: CreateJobInput): Promise<{ job_id?: string | null }> {
    const payload: CreateJobInput = {
      lane: input.lane,
      priority: input.priority,
      kind: input.kind,
      payload: input.payload,
    };
    return this.request('/v3/console/jobs', { method: 'POST', body: JSON.stringify(payload) });
  }

  listAdapters(): Promise<AdapterPage> {
    return this.request('/v3/console/adapters');
  }

  listAudit(): Promise<AuditPage> {
    return this.request('/v3/console/audit');
  }

  listOriginRelays(): Promise<OriginRelayPage> {
    return this.request('/v3/console/origin-relays');
  }

  getConfiguration(): Promise<ConfigurationSnapshot> {
    return this.request('/v3/console/config');
  }

  changeConfiguration(
    mutation: ConfigMutation,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult> {
    return this.request('/v3/console/config/changes', {
      method: 'POST',
      body: JSON.stringify({
        dry_run: options.dryRun,
        mutation,
        ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
      }),
    });
  }

  rollbackConfiguration(
    revisionId: string,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult> {
    return this.request(`/v3/console/config/revisions/${encodeURIComponent(revisionId)}/rollback`, {
      method: 'POST',
      body: JSON.stringify({
        dry_run: options.dryRun,
        ...(options.expectedRevision === undefined ? {} : { expected_revision: options.expectedRevision }),
      }),
    });
  }

  getObservability(): Promise<ObservabilitySnapshot> {
    return this.request('/v3/console/observability');
  }

  /**
   * Actividad en vuelo de la flota entera, agregada por alias. Endpoint operator-only: el
   * alcance cross-tenant sale de las mismas aristas ACL allow_read que topology(), nunca de un
   * "modo flota" propio de esta ruta. No trae cuerpos de mensaje ni errores — ver features/activity.
   */
  getFleetActivity(): Promise<FleetActivitySnapshot> {
    return this.request('/v3/console/activity');
  }

  /**
   * Una cadena de delegación entera, por trace. El gateway lo sirve desde
   * `GET /v3/console/chains/:traceId` con el MISMO par de permisos que la actividad
   * (operator + read) y hasta ahora no lo consumía nadie: la única forma de seguir una cadena era
   * leer la base a mano.
   *
   * La visibilidad ya está resuelta en el store, nodo por nodo: los extremos que el actor no puede
   * ver llegan reducidos a un id opaco. Acá no se vuelve a filtrar —volver a filtrar sobre un grafo
   * del lado del cliente es exactamente cómo se escapan datos de otro tenant— sólo se dibuja.
   */
  getAgentChain(traceId: string): Promise<AgentChainSnapshot> {
    return this.request(`/v3/console/chains/${encodeURIComponent(traceId)}`);
  }

  /**
   * Último estado de cuota por (host, proveedor, grupo, ventana) más sparkline de 24h. Mismo par
   * de permisos que getFleetActivity(): operator + read, re-verificado en el store.
   */
  getQuotas(): Promise<QuotaSnapshot> {
    return this.request('/v3/console/quotas');
  }

  async getTerminalCapability(): Promise<TerminalCapability> {
    try {
      return await this.request('/v3/console/terminal/capability');
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 501)) {
        return { available: false, reason: 'Backend PTY no disponible' };
      }
      throw error;
    }
  }
}

export const cauceApi = new CauceApi();

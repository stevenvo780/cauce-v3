import type {
  AgentPerfil,
  AgentPerfilValor,
  AdapterPage,
  AgentChainSnapshot,
  AgentDirective,
  AgentDocumentContent,
  AgentDocumentGuardado,
  AgentDocumentKind,
  AgentDocumentsMap,
  RoleBriefHistory,
  AuditPage,
  CancelResult,
  ConsoleAccess,
  ConsoleAuthState,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  DlqPage,
  FleetActivitySnapshot,
  MessageDetail,
  MessagePage,
  OriginRelayPage,
  ObservabilitySnapshot,
  ConfirmPublishIntentInput,
  ConfirmPublishIntentResult,
  PreparePublishIntentInput,
  PreparePublishIntentRateLimited,
  PreparePublishIntentReconciliation,
  PreparePublishIntentResult,
  PublishIntentExpired,
  PublishMessageInput,
  PublishResult,
  QueueSnapshot,
  QuotaSnapshot,
  ReplayResult,
  ResolveDlqWithoutReplayInput,
  ResolveDlqWithoutReplayResult,
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

/** 409 confiable y acotado: hay un efecto previo exacto que debe cerrarse antes de publicar otro. */
export class PublishIntentReconciliationError extends ApiError {
  constructor(readonly reconciliation: PreparePublishIntentReconciliation) {
    super('Hay una publicación durable anterior que requiere reconciliación.', 409,
      'publish_intent_reconciliation_required');
    this.name = 'PublishIntentReconciliationError';
  }
}

/** 410 exacto: el servidor cerró la reserva y demostró que nunca hubo efecto. */
export class PublishIntentExpiredError extends ApiError {
  constructor(readonly expiration: PublishIntentExpired) {
    super(
      'La reserva durable expiró sin publicar ningún mensaje. El borrador sigue intacto; volvé a enviarlo.',
      410,
      'publish_intent_expired',
    );
    this.name = 'PublishIntentExpiredError';
  }
}

/** 429 exacto: el servidor preservó el journal pero no admite otra reserva todavía. */
export class PublishIntentRateLimitedError extends ApiError {
  constructor(readonly rateLimit: PreparePublishIntentRateLimited) {
    super(
      `Hay demasiadas reservas durables recientes. Reintentá en ${rateLimit.retry_after_seconds} s; `
      + 'el borrador sigue intacto.',
      429,
      'publish_intent_rate_limited',
    );
    this.name = 'PublishIntentRateLimitedError';
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

function reconciliationBody(value: unknown): PreparePublishIntentReconciliation | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'idempotency_key', 'receipt', 'state', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_reconciliation_required'
      || record.state !== 'committed'
      || typeof record.idempotency_key !== 'string'
      || record.idempotency_key.length < 1
      || record.idempotency_key.length > 200
      || record.receipt === null
      || typeof record.receipt !== 'object'
      || Array.isArray(record.receipt)) return undefined;
  return record as unknown as PreparePublishIntentReconciliation;
}

function expirationBody(value: unknown): PublishIntentExpired | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'idempotency_key', 'safe_to_resubmit', 'state', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_expired'
      || record.state !== 'expired'
      || typeof record.idempotency_key !== 'string'
      || record.idempotency_key.length < 1
      || record.idempotency_key.length > 200
      || record.safe_to_resubmit !== true) return undefined;
  return record as unknown as PublishIntentExpired;
}

function rateLimitBody(value: unknown): PreparePublishIntentRateLimited | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = ['error', 'retry_after_seconds', 'safe_to_retry', 'version'];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || record.version !== 1
      || record.error !== 'publish_intent_rate_limited'
      || !Number.isSafeInteger(record.retry_after_seconds)
      || Number(record.retry_after_seconds) < 1
      || Number(record.retry_after_seconds) > 86_400
      || record.safe_to_retry !== true) return undefined;
  return record as unknown as PreparePublishIntentRateLimited;
}

interface RequestOptions {
  requireCsrf?: boolean;
  mapError?: (status: number, body: unknown) => Error | undefined;
}

/**
 * Tiempo máximo de espera para peticiones HTTP antes de abortar por timeout.
 */
export const TIEMPO_MAXIMO_MS = 30_000;

function segundos(ms: number): string {
  return `${Math.round(ms / 1000)} s`;
}

/**
 * El error de una espera vencida. Es un `ApiError` y no un `AbortError` crudo por dos razones:
 * cae en la MISMA rama de error que ya manejan todas las vistas, y su mensaje se lee en pantalla
 * —`ErrorState` pinta `error.message`—, así que tiene que estar escrito en castellano y decir lo
 * único que se puede afirmar: que no se pudo leer, no que no haya nada.
 */
function esperaVencida(method: string, path: string, tope: number): ApiError {
  return new ApiError(
    `El servidor no contestó en ${segundos(tope)} y la consola cortó la espera (${method} ${path}). `
    + 'No quiere decir que no haya datos: quiere decir que no se pudieron leer.',
    504,
    'timeout',
  );
}

/**
 * La mitad "reloj" de la carrera contra el fetch.
 *
 * Pasar la señal a `fetch` no alcanza: el `fetcher` es inyectable (las pruebas y los adaptadores
 * pasan el suyo) y un fetch que IGNORE la señal dejaría la promesa colgada igual que hoy, con el
 * agravante de que el aborto ya habría ocurrido y nadie se enteraría. Se corre la carrera además
 * de abortar, para que el vencimiento se note aunque quien haga la petición no lo respete.
 */
function corteAlVencer(signal: AbortSignal, method: string, path: string, tope: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(esperaVencida(method, path, tope));
      return;
    }
    signal.addEventListener('abort', () => reject(esperaVencida(method, path, tope)), { once: true });
  });
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
    /** Tope de espera por petición. Se inyecta para poder PROBARLO sin esperar medio minuto. */
    private readonly tiempoMaximoMs: number = TIEMPO_MAXIMO_MS,
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
    path: string, init: RequestInit = {},
    { requireCsrf = true, mapError }: RequestOptions = {},
  ): Promise<T> {
    const method = init.method?.toUpperCase() ?? 'GET';
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const csrfToken = unsafe && requireCsrf ? await this.csrfForMutation() : undefined;

    /**
     * El vencimiento es NUESTRO sólo si quien llama no trajo el suyo: una señal de fuera
     * (el cierre de una vista, por ejemplo) es una cancelación deliberada y no un servidor
     * que no contesta, y confundirlas escribiría «el servidor no contestó» cada vez que el
     * operador cambia de pantalla.
     */
    const propio = init.signal || !(this.tiempoMaximoMs > 0) ? undefined : new AbortController();
    const reloj = propio ? setTimeout(() => propio.abort(), this.tiempoMaximoMs) : undefined;

    let response: Response | undefined;
    let body: unknown;
    try {
      const peticionCompleta = async () => {
        response = await (this.fetcher ?? fetch)(`${this.baseUrl}${path}`, {
          ...init,
          credentials: 'include',
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
            ...init.headers,
          },
        });

        // Recibir headers no completa la lectura. Un proxy puede anunciar JSON y dejar el body
        // abierto para siempre; el mismo deadline abarca fetch + consumo íntegro del cuerpo.
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
      // El fetch que SÍ respeta la señal rechaza con un `AbortError` sin traducir. Se convierte
      // acá para que la pantalla no muestre «The operation was aborted», que no le dice nada a
      // nadie y encima suena a que la consola hizo algo mal.
      if (propio?.signal.aborted) throw esperaVencida(method, path, this.tiempoMaximoMs);
      throw cause;
    } finally {
      if (reloj !== undefined) clearTimeout(reloj);
    }

    if (response === undefined) throw new Error('la petición terminó sin respuesta HTTP');

    if (!response.ok) {
      if (response.status === 401) this.csrfToken = undefined;
      const mapped = mapError?.(response.status, body);
      if (mapped !== undefined) throw mapped;
      const detail = errorBody(body);
      throw new ApiError(detail.message ?? response.statusText ?? 'API request failed', response.status, detail.error);
    }
    return body as T;
  }

  /**
   * El token CSRF de la sesión de consola, para una escritura.
   *
   * Es público porque el panel PTY —que a propósito NO usa este cliente, para que la ausencia de
   * los endpoints opcionales degrade sólo ese panel— necesita el MISMO token: la puerta CSRF del
   * gateway no distingue de qué módulo salió el `fetch`, sólo mira la cabecera. Cuando era
   * privado, `features/terminal/api.ts` no tenía forma de pedirlo y mandaba sus POST y DELETE sin
   * cabecera; el gateway contestaba 403 y la TUI no abría nunca.
   *
   * Devuelve `undefined` sólo cuando este gateway no usa sesión de navegador (mTLS de
   * desarrollo, o un gateway anterior al BFF): ahí no hay token que mandar y tampoco se exige.
   */
  async csrfForMutation(): Promise<string | undefined> {
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

  /**
   * El mensaje ENTERO, con su cuerpo sin recortar.
   *
   * `listMessages` devuelve `left(body,240)`: en el hilo se leía «…El dominio real es
   * stevenvallejo» cortado en seco y no había forma de ver el resto. El detalle lo pide acá.
   *
   * Va por `/v3/console/...` y NO por `/v3/messages/:id`, que existe en el gateway desde antes y
   * devuelve lo mismo. El motivo no es de gusto: `consola.humanizar.tech` publica una LISTA BLANCA
   * en el borde (`ops/console-login/patch-caddy-lista-blanca.py`) que sólo deja pasar `/v3/auth/*`,
   * `/v3/status` y `/v3/console/*`; todo el resto de `/v3/*` es superficie máquina-a-máquina del
   * bus y se corta con 404 antes de llegar al gateway. Llamar a `/v3/messages/:id` desde la SPA
   * daría 404 en producción y 200 en desarrollo, que es la peor de las dos.
   */
  getMessage(messageId: string): Promise<MessageDetail> {
    return this.request(`/v3/console/messages/${encodeURIComponent(messageId)}`);
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
    return this.request('/v3/console/messages', {
      method: 'POST', body: JSON.stringify(payload),
    }, {
      mapError: (status, body) => {
        if (status !== 410) return undefined;
        const expiration = expirationBody(body);
        return expiration === undefined ? undefined : new PublishIntentExpiredError(expiration);
      },
    });
  }

  preparePublishIntent(input: PreparePublishIntentInput): Promise<PreparePublishIntentResult> {
    // Same deliberate allow-list as publishMessage. Identity and the idempotency key are minted
    // by the authenticated gateway; the browser stores neither one.
    const payload: PreparePublishIntentInput = {
      room_id: input.room_id,
      recipients: input.recipients.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
      body: { text: input.body.text },
      lane: input.lane,
      priority: input.priority,
      intent_nonce: input.intent_nonce,
    };
    return this.request('/v3/console/publish-intents', {
      method: 'POST', body: JSON.stringify(payload),
    }, {
      mapError: (status, body) => {
        if (status === 409) {
          const reconciliation = reconciliationBody(body);
          return reconciliation === undefined
            ? undefined
            : new PublishIntentReconciliationError(reconciliation);
        }
        if (status === 429) {
          const rateLimit = rateLimitBody(body);
          return rateLimit === undefined ? undefined : new PublishIntentRateLimitedError(rateLimit);
        }
        return undefined;
      },
    });
  }

  confirmPublishIntent(input: ConfirmPublishIntentInput): Promise<ConfirmPublishIntentResult> {
    const payload: ConfirmPublishIntentInput = {
      idempotency_key: input.idempotency_key,
      message_id: input.message_id,
      causal_hash: input.causal_hash,
    };
    return this.request('/v3/console/publish-intents/confirm', {
      method: 'POST', body: JSON.stringify(payload),
    });
  }

  getQueues(): Promise<QueueSnapshot> {
    return this.request('/v3/console/queues');
  }

  getDlq(limit = 200, cursor?: string, signal?: AbortSignal): Promise<DlqPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('DLQ limit must be an integer between 1 and 500');
    }
    if (cursor !== undefined && (
      cursor.length < 2 || cursor.length > 1_024 || cursor.length % 2 !== 0
      || !/^[a-f0-9]+$/u.test(cursor)
    )) {
      throw new RangeError('DLQ cursor must be a bounded lower-case hexadecimal token');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor !== undefined) query.set('cursor', cursor);
    return this.request(`/v3/console/dlq?${query.toString()}`, { signal });
  }

  resolveDlqWithoutReplay(input: ResolveDlqWithoutReplayInput): Promise<ResolveDlqWithoutReplayResult> {
    const target = encodeURIComponent(input.target);
    const id = encodeURIComponent(input.id);
    return this.request(`/v3/console/dlq/${target}/${id}/resolve-without-replay`, {
      method: 'POST',
      body: JSON.stringify({
        evidence_sha256: input.evidenceSha256,
        reason: input.reason,
        possible_duplicate_acknowledged: input.possibleDuplicateAcknowledged,
        possible_no_delivery_acknowledged: input.possibleNoDeliveryAcknowledged,
      }),
    });
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

  listAdapters(): Promise<AdapterPage> {
    return this.request('/v3/console/adapters');
  }

  listAudit(options: { limit?: number; before?: string; signal?: AbortSignal } = {}): Promise<AuditPage> {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('Audit limit must be an integer between 1 and 500');
    }
    if (options.before !== undefined && (
      !/^[1-9][0-9]{0,18}$/u.test(options.before)
      || BigInt(options.before) > 9_223_372_036_854_775_807n
    )) {
      throw new RangeError('Audit cursor must be a canonical positive bigint');
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (options.before !== undefined) query.set('before', options.before);
    return this.request(`/v3/console/audit?${query.toString()}`, { signal: options.signal });
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

  /**
   * Las capas 2 y 3 de la directiva de un alias: sus `CLAUDE.md` y el índice de su memoria.
   *
   * Son FICHEROS dentro del contenedor del agente, no filas de la base, así que sólo el gateway
   * puede mirarlos. Mientras no publique el endpoint, esto NO lanza: devuelve `publicado: false`
   * con el motivo, y la pantalla dice «no se pudo mirar» en vez de «no hay».
   *
   * La diferencia no es de estilo. Si un 404 se pintara como lista vacía, la consola afirmaría
   * que gaia no tiene `CLAUDE.md` —que resulta ser cierto— y que janus tampoco tiene dos —que es
   * falso—, con la misma cara de seguridad en los dos casos. Un negativo que no se midió no es
   * un hecho del sistema.
   *
   * Mismo patrón que `getTerminalCapability`, que es el precedente de esta consola para «el
   * servidor todavía no sabe hacer esto».
   */
  async getAgentDirective(tenantId: string, alias: string): Promise<AgentDirective> {
    const ruta = `/v3/console/agents/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/directive`;
    try {
      const cuerpo = await this.request<Omit<AgentDirective, 'publicado'>>(ruta);
      return { ...cuerpo, publicado: true };
    } catch (error) {
      if (error instanceof ApiError
        && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
        return {
          publicado: false,
          motivo: `Este gateway no publica GET ${ruta} (respondió ${error.status}).`,
        };
      }
      throw error;
    }
  }

  /**
   * Obtiene el historial de revisiones del rol declarado de un alias.
   */
  async getRoleBriefHistory(tenantId: string, alias: string): Promise<RoleBriefHistory> {
    const ruta = `/v3/console/role-assignments/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}/history`;
    try {
      const cuerpo = await this.request<Omit<RoleBriefHistory, 'publicado'>>(ruta);
      return { ...cuerpo, publicado: true };
    } catch (error) {
      if (error instanceof ApiError
        && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
        return {
          publicado: false,
          motivo: `Este gateway no publica GET ${ruta} (respondió ${error.status}).`,
        };
      }
      throw error;
    }
  }

  /**
   * El INVENTARIO de ficheros que gobiernan a un alias: qué fichero es cuál y dónde vive.
   *
   * Como `getAgentDirective`, un gateway que todavía no publica la ruta baja a
   * `publicado: false` y NO a lista vacía. La diferencia importa: «no se miró» y «no tiene» se
   * pintan igual de seguros y sólo uno de los dos es un hecho.
   */
  async getAgentDocuments(tenantId: string, alias: string): Promise<AgentDocumentsMap> {
    const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents`;
    try {
      const cuerpo = await this.request<Omit<AgentDocumentsMap, 'publicado'>>(ruta);
      return { ...cuerpo, publicado: true };
    } catch (error) {
      if (error instanceof ApiError
        && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
        return {
          publicado: false,
          motivo: `Este gateway no publica GET ${ruta} (respondió ${error.status}).`,
        };
      }
      throw error;
    }
  }

  /**
   * El CONTENIDO de un documento. Se pide por `kind`, NUNCA por ruta: la ruta la deriva el
   * servidor de hechos medidos dentro del contenedor, y que el navegador no pueda nombrar un
   * fichero es justamente lo que impide pedir `/etc/shadow`.
   *
   * Los errores NO se tragan aquí y es deliberado: un 409 («no está medido»), un 503 («no hay
   * canal hasta el agente») y un 403 («este fichero no se sirve») dicen tres cosas distintas y la
   * pantalla tiene que poder repetir cuál fue. Convertirlos todos en «no disponible» sería
   * borrar justo la información que hace falta para arreglarlo.
   */
  async getAgentDocumentContent(
    tenantId: string, alias: string, kind: AgentDocumentKind,
  ): Promise<AgentDocumentContent> {
    const value = await this.request<unknown>(
      `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/content`,
    );
    const malformed = (): never => {
      throw new ApiError(
        'El gateway devolvió un contenido de documento incompleto o incoherente; no se mostrará como si el fichero estuviera vacío.',
        502,
        'invalid_document_content',
      );
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return malformed();
    const row = value as Record<string, unknown>;
    const path = row.path;
    const exists = row.exists;
    const content = row.content;
    const sha = row.sha;
    const bytes = row.bytes;
    const truncated = row.truncated;
    if (row.tenant_id !== tenantId || row.alias !== alias || row.kind !== kind
        || typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')
        || path.split('/').slice(1).some((segment) => segment === '' || segment === '.' || segment === '..')
        || typeof row.format !== 'string' || row.format.length === 0
        || typeof exists !== 'boolean' || typeof content !== 'string'
        || !(sha === null || (typeof sha === 'string' && /^[0-9a-f]{64}$/u.test(sha)))
        || !Number.isSafeInteger(bytes) || Number(bytes) < 0
        || typeof row.editable !== 'boolean' || typeof truncated !== 'boolean'
        || typeof row.projected !== 'boolean'
        || (row.modified_at !== undefined && typeof row.modified_at !== 'string')
        || (row.warning !== undefined && typeof row.warning !== 'string')) return malformed();

    const visibleBytes = new TextEncoder().encode(content).byteLength;
    if ((!exists && (content !== '' || sha !== null || bytes !== 0 || truncated))
        || (exists && typeof sha !== 'string')
        || visibleBytes > Number(bytes)
        || (!truncated && visibleBytes !== Number(bytes))
        || (truncated && row.editable === true)) return malformed();
    return value as AgentDocumentContent;
  }

  /**
   * Guarda un documento. `expectedSha` es la huella de lo que se abrió: si el fichero cambió
   * mientras se editaba, el servidor contesta 409 y NO escribe, en vez de dejar que gane el
   * último en pulsar guardar. Es la misma lección que `expected_revision` en la configuración,
   * y aquí pesa más porque lo que se pierde es prosa que no está en ningún otro sitio.
   */
  async putAgentDocumentContent(
    tenantId: string,
    alias: string,
    kind: AgentDocumentKind,
    content: string,
    expectedSha: string | null,
  ): Promise<AgentDocumentGuardado> {
    return this.request<AgentDocumentGuardado>(
      `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/documents/${encodeURIComponent(kind)}/content`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expectedSha === null
          ? { content, create_if_absent: true }
          : { content, expected_sha: expectedSha }),
      },
    );
  }

  /**
   * El perfil autorado de un alias MÁS la vista previa de los ficheros que su arnés lee.
   *
   * El 404/501 se traduce a `publicado: false` con el motivo entero, igual que
   * `getAgentDocuments`, y NO se convierte en un perfil vacío: «este gateway no publica la ruta»
   * y «este alias no tiene perfil» son dos cosas distintas, y enseñar la segunda cuando pasa la
   * primera es exactamente cómo la consola llegó a afirmar que catorce alias no tenían directiva.
   *
   * El resto de los errores se dejan subir: un 403 y un 500 dicen cosas distintas y la pantalla
   * tiene que poder repetir cuál fue.
   */
  async getAgentPerfil(tenantId: string, alias: string): Promise<AgentPerfil> {
    const ruta = `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`;
    try {
      const cuerpo = await this.request<Omit<AgentPerfil, 'publicado'>>(ruta);
      return { ...cuerpo, publicado: true };
    } catch (error) {
      if (error instanceof ApiError
        && (error.status === 501 || (error.status === 404 && error.code !== 'not_found'))) {
        return {
          publicado: false,
          motivo: `Este gateway no publica GET ${ruta} (respondió ${error.status}).`,
          perfil: {
            purpose: null, role_summary: null, human_brief: null,
            responsibilities: [], restrictions: [], tools: [], operating_rules: [],
          },
        };
      }
      throw error;
    }
  }

  /**
   * Persiste el desired por CAS y sólo obtiene 2xx cuando el runtime acredita el lote completo.
   * La respuesta queda como `unknown` a propósito: la UI valida el ACK antes de limpiar el
   * borrador; una aserción TypeScript no convertiría un 2xx parcial en evidencia real.
   */
  putAgentPerfil(
    tenantId: string,
    alias: string,
    profile: AgentPerfilValor,
    expectedRevision: number | null,
  ): Promise<unknown> {
    return this.request(
      `/v3/console/tenants/${encodeURIComponent(tenantId)}/agents/${encodeURIComponent(alias)}/perfil`,
      {
        method: 'PUT',
        body: JSON.stringify({ expected_revision: expectedRevision, profile }),
      },
    );
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

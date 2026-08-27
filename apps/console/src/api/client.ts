import type {
  AdapterPage,
  AgentChainSnapshot,
  AgentDirective,
  AgentDocumentContent,
  AgentDocumentGuardado,
  AgentDocumentKind,
  AgentDocumentsMap,
  AgentPerfil,
  AgentPerfilValor,
  AuditPage,
  CancelResult,
  ConfigurationChangeResult,
  ConfigurationSnapshot,
  ConfigMutation,
  ConfirmPublishIntentInput,
  ConfirmPublishIntentResult,
  ConsoleAccess,
  ConsoleAuthState,
  DlqPage,
  FleetActivitySnapshot,
  MessageDetail,
  MessagePage,
  ObservabilitySnapshot,
  OriginRelayPage,
  PreparePublishIntentInput,
  PreparePublishIntentResult,
  PublishMessageInput,
  PublishResult,
  QueueSnapshot,
  QuotaSnapshot,
  ReplayResult,
  ResolveDlqWithoutReplayInput,
  ResolveDlqWithoutReplayResult,
  RoleBriefHistory,
  SystemStatus,
  TerminalCapability,
  TopologySnapshot,
} from './types';
import {
  ApiError,
  corteAlVencer,
  errorBody,
  esperaVencida,
  safeBase,
  TIEMPO_MAXIMO_MS,
  type FetchLike,
  type RequestOptions,
} from './client/core';
import * as systemApi from './client/system-client';
import * as messagingApi from './client/messaging-client';
import * as agentApi from './client/agent-client';

export class CauceApi {
  private readonly baseUrl: string;
  private csrfToken: string | undefined;
  private bffSessionSupported: boolean | null = null;
  private readonly developmentIdentity?: { tenant: string; alias: string };

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
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    { requireCsrf = true, mapError }: RequestOptions = {},
  ): Promise<T> {
    const method = init.method?.toUpperCase() ?? 'GET';
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const csrfToken = unsafe && requireCsrf ? await this.csrfForMutation() : undefined;

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
      if (response.status === 401) this.csrfToken = undefined;
      const mapped = mapError?.(response.status, body);
      if (mapped !== undefined) throw mapped;
      const detail = errorBody(body);
      throw new ApiError(detail.message ?? response.statusText ?? 'API request failed', response.status, detail.error);
    }
    return body as T;
  }

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

  private boundRequest = <T>(path: string, init?: RequestInit, options?: RequestOptions): Promise<T> =>
    this.request<T>(path, init, options);

  // System & Auth
  login(email: string, password: string): Promise<ConsoleAuthState> {
    return systemApi.login(this.boundRequest, email, password, {
      setBffSessionSupported: (v) => { this.bffSessionSupported = v; },
      setCsrfToken: (v) => { this.csrfToken = v; },
    });
  }

  getAuthSession(): Promise<ConsoleAuthState> {
    return systemApi.getAuthSession(this.boundRequest, {
      setBffSessionSupported: (v) => { this.bffSessionSupported = v; },
      setCsrfToken: (v) => { this.csrfToken = v; },
    });
  }

  logout(): Promise<void> {
    return systemApi.logout(this.boundRequest, {
      setCsrfToken: (v) => { this.csrfToken = v; },
    });
  }

  getStatus(): Promise<SystemStatus> {
    return systemApi.getStatus(this.boundRequest);
  }

  getConsoleAccess(): Promise<ConsoleAccess> {
    return systemApi.getConsoleAccess(this.boundRequest);
  }

  getTopology(): Promise<TopologySnapshot> {
    return systemApi.getTopology(this.boundRequest);
  }

  listAdapters(): Promise<AdapterPage> {
    return systemApi.listAdapters(this.boundRequest);
  }

  listAudit(options: { limit?: number; before?: string; signal?: AbortSignal } = {}): Promise<AuditPage> {
    return systemApi.listAudit(this.boundRequest, options);
  }

  getConfiguration(): Promise<ConfigurationSnapshot> {
    return systemApi.getConfiguration(this.boundRequest);
  }

  changeConfiguration(
    mutation: ConfigMutation,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult> {
    return systemApi.changeConfiguration(this.boundRequest, mutation, options);
  }

  rollbackConfiguration(
    revisionId: string,
    options: { dryRun: boolean; expectedRevision?: number },
  ): Promise<ConfigurationChangeResult> {
    return systemApi.rollbackConfiguration(this.boundRequest, revisionId, options);
  }

  getObservability(): Promise<ObservabilitySnapshot> {
    return systemApi.getObservability(this.boundRequest);
  }

  getQuotas(): Promise<QuotaSnapshot> {
    return systemApi.getQuotas(this.boundRequest);
  }

  // Messaging
  listMessages(): Promise<MessagePage> {
    return messagingApi.listMessages(this.boundRequest);
  }

  getMessage(messageId: string): Promise<MessageDetail> {
    return messagingApi.getMessage(this.boundRequest, messageId);
  }

  publishMessage(input: PublishMessageInput): Promise<PublishResult> {
    return messagingApi.publishMessage(this.boundRequest, input);
  }

  preparePublishIntent(input: PreparePublishIntentInput): Promise<PreparePublishIntentResult> {
    return messagingApi.preparePublishIntent(this.boundRequest, input);
  }

  confirmPublishIntent(input: ConfirmPublishIntentInput): Promise<ConfirmPublishIntentResult> {
    return messagingApi.confirmPublishIntent(this.boundRequest, input);
  }

  getQueues(): Promise<QueueSnapshot> {
    return messagingApi.getQueues(this.boundRequest);
  }

  getDlq(limit = 200, cursor?: string, signal?: AbortSignal): Promise<DlqPage> {
    return messagingApi.getDlq(this.boundRequest, limit, cursor, signal);
  }

  resolveDlqWithoutReplay(input: ResolveDlqWithoutReplayInput): Promise<ResolveDlqWithoutReplayResult> {
    return messagingApi.resolveDlqWithoutReplay(this.boundRequest, input);
  }

  replayDelivery(deliveryId: string): Promise<ReplayResult> {
    return messagingApi.replayDelivery(this.boundRequest, deliveryId);
  }

  cancelDelivery(deliveryId: string, reason?: string): Promise<CancelResult> {
    return messagingApi.cancelDelivery(this.boundRequest, deliveryId, reason);
  }

  listOriginRelays(): Promise<OriginRelayPage> {
    return messagingApi.listOriginRelays(this.boundRequest);
  }

  // Agent
  getFleetActivity(): Promise<FleetActivitySnapshot> {
    return agentApi.getFleetActivity(this.boundRequest);
  }

  getAgentDirective(tenantId: string, alias: string): Promise<AgentDirective> {
    return agentApi.getAgentDirective(this.boundRequest, tenantId, alias);
  }

  getRoleBriefHistory(tenantId: string, alias: string): Promise<RoleBriefHistory> {
    return agentApi.getRoleBriefHistory(this.boundRequest, tenantId, alias);
  }

  getAgentDocuments(tenantId: string, alias: string): Promise<AgentDocumentsMap> {
    return agentApi.getAgentDocuments(this.boundRequest, tenantId, alias);
  }

  getAgentDocumentContent(tenantId: string, alias: string, kind: AgentDocumentKind): Promise<AgentDocumentContent> {
    return agentApi.getAgentDocumentContent(this.boundRequest, tenantId, alias, kind);
  }

  putAgentDocumentContent(
    tenantId: string,
    alias: string,
    kind: AgentDocumentKind,
    content: string,
    expectedSha: string | null,
  ): Promise<AgentDocumentGuardado> {
    return agentApi.putAgentDocumentContent(this.boundRequest, tenantId, alias, kind, content, expectedSha);
  }

  getAgentPerfil(tenantId: string, alias: string): Promise<AgentPerfil> {
    return agentApi.getAgentPerfil(this.boundRequest, tenantId, alias);
  }

  putAgentPerfil(
    tenantId: string,
    alias: string,
    profile: AgentPerfilValor,
    expectedRevision: number | null,
  ): Promise<unknown> {
    return agentApi.putAgentPerfil(this.boundRequest, tenantId, alias, profile, expectedRevision);
  }

  getAgentChain(traceId: string): Promise<AgentChainSnapshot> {
    return agentApi.getAgentChain(this.boundRequest, traceId);
  }

  getTerminalCapability(): Promise<TerminalCapability> {
    return agentApi.getTerminalCapability(this.boundRequest);
  }
}

export const cauceApi = new CauceApi();

export {
  ApiError,
  PublishIntentReconciliationError,
  PublishIntentExpiredError,
  PublishIntentRateLimitedError,
  TIEMPO_MAXIMO_MS,
  safeBase,
  type FetchLike,
  type RequestOptions,
} from './client/core';

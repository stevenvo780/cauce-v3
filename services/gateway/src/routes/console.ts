import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AliasSchema, ConfigChangeRequestSchema, ConfigMutationSchema, ConfigRollbackRequestSchema,
  CreateJobSchema, DeliveryIdSchema, TenantSchema,
  type ConfigMutation, type ProfileRuntimeAdoptionEvidence, type ProfileRuntimeContract, type Tenant,
} from '@cauce/protocol';
import {
  AgentProfileRepository, StoreError,
  type DatabasePool, type OperationalDlqPage, type OperationalDlqResolutionRequest,
  type OperationalDlqResolutionResult,
} from '@cauce/store';
import {
  requireOperatorPermission, requirePermission, type AuthProvider,
} from '../auth.js';
import { registerAgentDocumentRoutes } from '../console/agent-documents.routes.js';
import { prepareAgentProfileRuntime } from '../console/agent-profile-runtime.js';
import {
  registerAgentProfileRoutes, type ProfileRuntimeVerification,
} from '../console/agent-profile.routes.js';
import { SondaCompartida, sondaDiferida } from '../console/sonda-compartida.js';
import {
  safeAuditPage, safeCancelReceipt, safeDlqPage, safeDlqResolution, safeReplayReceipt,
  sameTenantRows, visibleMessage, visibleMessageList, visibleOriginRelays, visibleQueue,
} from '../facades.js';
import { CONNECTION_TOKEN_PATTERN, principal, replyError } from './shared.js';

interface ConsoleRouteOptions {
  readonly pool: DatabasePool;
  readonly authProvider: AuthProvider;
  readonly allowedJobKinds?: readonly string[];
  readonly terminalCapability?: Readonly<Record<string, unknown>>;
}

interface ConsoleRouteRepository {
  assertPermission(
    tenantId: Tenant,
    alias: string,
    permission: 'route' | 'read' | 'control' | 'notify',
  ): Promise<void>;
  principalAccess(
    tenantId: Tenant,
    alias: string,
  ): Promise<{
    roles: string[];
    permissions: Array<'route' | 'read' | 'control' | 'notify'>;
  }>;
  status(actorTenant: Tenant, actorAlias: string): Promise<Record<string, number>>;
  topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listMessages(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  queueSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listOperationalDlq(
    actorTenant: Tenant,
    actorAlias: string,
    limit?: number,
    cursor?: string | null,
  ): Promise<OperationalDlqPage>;
  resolveOperationalDlqWithoutReplay(
    actorTenant: Tenant,
    actorAlias: string,
    request: OperationalDlqResolutionRequest,
  ): Promise<OperationalDlqResolutionResult>;
  replayDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  cancelDelivery(
    deliveryId: string,
    actorTenant: Tenant,
    actorAlias: string,
    reason?: string,
  ): Promise<Record<string, unknown>>;
  listJobs(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  enqueueJob(
    tenantId: Tenant,
    lane: 'interactive' | 'batch',
    priority: number,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<string>;
  listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAgents(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getAgent(
    alias: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown> | undefined>;
  getAgentByIdentity?(
    tenantId: Tenant,
    alias: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown> | undefined>;
  authorizeAgentTarget?(
    actorTenant: Tenant,
    actorAlias: string,
    targetTenant: Tenant,
    targetAlias: string,
    permission: 'read' | 'control',
  ): Promise<{
    tenant_id: Tenant;
    alias: string;
    harness_id: string | null;
    home_directory: string | null;
    enabled: boolean;
  } | undefined>;
  listOriginRelays(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listNotifications(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { limit?: number; before?: string | null },
  ): Promise<Record<string, unknown>>;
  agentChain(
    traceId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  quotaSnapshot(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>>;
  applyConfigurationChange(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
  rollbackConfiguration(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number,
  ): Promise<unknown>;
  getMessage(
    messageId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  recordProfileRuntimeExpectation?(
    tenantId: Tenant,
    alias: string,
    contract: ProfileRuntimeContract,
  ): Promise<void>;
  readProfileRuntimeAdoption?(
    tenantId: Tenant,
    alias: string,
    contract: ProfileRuntimeContract,
  ): Promise<(ProfileRuntimeAdoptionEvidence & { readonly adopted_at: string }) | undefined>;
}

interface ConsoleRoutes {
  readonly options: ConsoleRouteOptions;
  readonly repository: ConsoleRouteRepository;
  readonly allowedJobKinds: ReadonlySet<string>;
}

type PublishHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown>;

const DLQ_ID_PATTERN = CONNECTION_TOKEN_PATTERN;
const DLQ_EVIDENCE_PATTERN = /^[a-f0-9]{64}$/u;
const DLQ_CURSOR_PATTERN = /^(?:[a-f0-9]{2}){1,512}$/u;
const DLQ_RESOLUTION_KEYS = new Set([
  'evidence_sha256',
  'reason',
  'possible_duplicate_acknowledged',
  'possible_no_delivery_acknowledged',
]);
const AUDIT_CURSOR_PATTERN = /^[1-9][0-9]{0,18}$/u;
const AUDIT_QUERY_KEYS = new Set(['limit', 'before']);

function parseDlqLimit(value: unknown): number {
  if (value === undefined) return 200;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/u.test(value)) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 500) {
    throw new StoreError('invalid_input', 'DLQ limit must be an integer between 1 and 500');
  }
  return limit;
}

function parseDlqCursor(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !DLQ_CURSOR_PATTERN.test(value)) {
    throw new StoreError('invalid_input', 'DLQ cursor is invalid');
  }
  return value;
}

function parseAuditQuery(value: unknown): { limit: number; before: string | null } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'audit query must be an object');
  }
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some((key) => !AUDIT_QUERY_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'audit query contains an unknown field');
  }
  const rawLimit = query.limit;
  if (rawLimit !== undefined && (
    typeof rawLimit !== 'string'
    || !/^[1-9][0-9]{0,2}$/u.test(rawLimit)
    || Number(rawLimit) > 500
  )) {
    throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
  }
  const rawBefore = query.before;
  if (rawBefore !== undefined && (
    typeof rawBefore !== 'string'
    || !AUDIT_CURSOR_PATTERN.test(rawBefore)
    || BigInt(rawBefore) > 9_223_372_036_854_775_807n
  )) {
    throw new StoreError('invalid_input', 'audit cursor is invalid');
  }
  return { limit: rawLimit === undefined ? 100 : Number(rawLimit), before: rawBefore ?? null };
}

function parseDlqResolution(
  target: unknown,
  id: unknown,
  value: unknown,
): OperationalDlqResolutionRequest {
  if (target !== 'delivery' && target !== 'outbox') {
    throw new StoreError('invalid_input', 'DLQ target is invalid');
  }
  if (typeof id !== 'string' || !DLQ_ID_PATTERN.test(id)) {
    throw new StoreError('invalid_input', 'DLQ incident id is invalid');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('invalid_input', 'DLQ resolution body must be an object');
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== DLQ_RESOLUTION_KEYS.size
      || Object.keys(body).some((key) => !DLQ_RESOLUTION_KEYS.has(key))) {
    throw new StoreError('invalid_input', 'DLQ resolution body has unexpected or missing fields');
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 1 || reason.length > 1_000
      || [...reason].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 31 || code === 127;
      })) {
    throw new StoreError('invalid_input', 'DLQ resolution reason is invalid');
  }
  if (typeof body.evidence_sha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(body.evidence_sha256)) {
    throw new StoreError('invalid_input', 'DLQ evidence hash is invalid');
  }
  if (typeof body.possible_duplicate_acknowledged !== 'boolean'
      || typeof body.possible_no_delivery_acknowledged !== 'boolean') {
    throw new StoreError('invalid_input', 'DLQ risk acknowledgements must be booleans');
  }
  return {
    target,
    id,
    evidenceSha256: body.evidence_sha256,
    reason,
    possibleDuplicateAcknowledged: body.possible_duplicate_acknowledged,
    possibleNoDeliveryAcknowledged: body.possible_no_delivery_acknowledged,
  };
}

function validatedDlqResolutionReceipt(
  value: unknown,
  request: OperationalDlqResolutionRequest,
): Record<string, unknown> {
  const receipt = safeDlqResolution(value);
  const appliedCount = receipt.appliedCount;
  const alreadyApplied = receipt.alreadyApplied;
  const countMatchesReceipt = (appliedCount === 1 && alreadyApplied === false)
    || (appliedCount === 0 && alreadyApplied === true);
  if (receipt.schemaVersion !== 1
      || receipt.suite !== 'cauce-v3-dlq-no-replay-resolution'
      || receipt.phase !== 'resolved'
      || !countMatchesReceipt
      || receipt.evidenceSha256 !== request.evidenceSha256
      || typeof receipt.reasonSha256 !== 'string'
      || !DLQ_EVIDENCE_PATTERN.test(receipt.reasonSha256)
      || receipt.possibleDuplicateAcknowledged !== request.possibleDuplicateAcknowledged
      || receipt.possibleNoDeliveryAcknowledged !== request.possibleNoDeliveryAcknowledged) {
    // The transaction may already have committed. Return no false 2xx: an exact retry is safe and
    // the store will answer with its idempotent alreadyApplied receipt.
    throw new StoreError('conflict', 'DLQ resolution did not return an exact durable receipt');
  }
  return receipt;
}

function validatedReplayReceipt(value: unknown, sourceDeliveryId: string): Record<string, unknown> {
  const receipt = safeReplayReceipt(value);
  if (receipt.delivery_id === null
      || receipt.delivery_id === sourceDeliveryId
      || receipt.replayed_from_delivery_id !== sourceDeliveryId
      || receipt.state !== 'pending'
      || receipt.replayed !== true) {
    throw new StoreError('conflict', 'replay did not return an exact durable receipt');
  }
  return receipt;
}

function validatedCancelReceipt(value: unknown, deliveryId: string): Record<string, unknown> {
  const receipt = safeCancelReceipt(value);
  if (receipt.delivery_id !== deliveryId
      || receipt.state !== 'dead'
      || receipt.cancelled !== true
      || receipt.cancelled_from_state === null
      || receipt.parent_notice === null
      || typeof receipt.origin_relayed !== 'boolean'
      || receipt.replayable !== true) {
    throw new StoreError('conflict', 'cancel did not return an exact durable receipt');
  }
  return receipt;
}

function validatedConfigurationReceipt(
  value: unknown,
  dryRun: boolean,
  expectedRolledBackRevisionId: number | null,
  expectedMutation?: ConfigMutation,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  const result = value as Record<string, unknown>;
  const mutation = ConfigMutationSchema.safeParse(result.mutation);
  const inverse = ConfigMutationSchema.safeParse(result.inverse_mutation);
  const revision = result.revision;
  const rolledBackRevisionId = result.rolled_back_revision_id;
  const summary = result.summary;
  const exact = result.applied === !dryRun
    && result.dry_run === dryRun
    && Number.isSafeInteger(revision)
    && Number(revision) >= (dryRun ? 0 : 1)
    && rolledBackRevisionId === expectedRolledBackRevisionId
    && typeof summary === 'string'
    && summary.length >= 1
    && summary.length <= 2_000
    && mutation.success
    && inverse.success
    && (expectedMutation === undefined || isDeepStrictEqual(mutation.data, expectedMutation));
  if (!exact) {
    // La escritura pudo confirmar antes de que una capa incompatible truncara su recibo. La
    // respuesta no refleja campos crudos del store y obliga al cliente a releer la revisión.
    throw new StoreError('conflict', 'configuration change did not return an exact durable receipt');
  }
  return {
    applied: result.applied,
    dry_run: result.dry_run,
    revision,
    rolled_back_revision_id: rolledBackRevisionId,
    summary,
    mutation: mutation.data,
    inverse_mutation: inverse.data,
  };
}

function runtimeContractFromVerification(
  revision: number,
  verification: ProfileRuntimeVerification,
): ProfileRuntimeContract {
  if (verification.state !== 'current' || verification.generation === null
    || verification.documents.length === 0
    || verification.documents.some((document) => !document.current
      || document.observed_sha !== document.expected_sha)) {
    throw new Error('runtime profile expectation requires an exact current verification');
  }
  return {
    revision,
    generation: verification.generation,
    documents: verification.documents.map((document) => ({
      name: document.name,
      path: document.path,
      sha: document.expected_sha,
    })),
  };
}

export function createConsoleRoutes(
  options: ConsoleRouteOptions,
  repository: ConsoleRouteRepository,
): ConsoleRoutes {
  const allowedJobKinds = new Set(options.allowedJobKinds ?? [
    'system.database.probe', ...(process.env.NODE_ENV === 'test' ? ['qa.fairness'] : [])
  ]);
  return { options, repository, allowedJobKinds };
}

export function registerConsoleRoutesPhase1(
  app: FastifyInstance,
  context: ConsoleRoutes,
): void {
  const { options, repository } = context;
  app.get('/v3/console/access', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const databaseAccess = await repository.principalAccess(actor.tenant_id, actor.alias);
      const effectiveRoles = actor.roles.filter((role) => databaseAccess.roles.includes(role));
      const effectivePermissions = actor.permissions.filter((permission) => databaseAccess.permissions.includes(permission));
      const permissions = [
        ...(effectivePermissions.includes('route') ? ['message.publish'] : []),
        ...(effectivePermissions.includes('notify') ? ['message.notify'] : []),
        ...(effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['delivery.replay', 'delivery.cancel', 'job.create', 'config.write', 'config.rollback', 'dlq.resolve'] : []),
        ...(options.terminalCapability?.available === true && effectiveRoles.includes('operator') && effectivePermissions.includes('control')
          ? ['ultimate-terminal.connect'] : [])
      ];
      return {
        subject: `${actor.tenant_id}:${actor.alias}`,
        roles: effectiveRoles,
        permissions,
        observed_at: new Date().toISOString()
      };
    } catch (error) { replyError(reply, error); }
  });
}

export function registerConsoleRoutesPhase2(
  app: FastifyInstance,
  context: ConsoleRoutes,
): void {
  const { options, repository } = context;
  app.get('/v3/console/topology', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.topology(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/messages', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleMessageList(await repository.listMessages(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });
}

export function registerConsoleRoutesPhase3(
  app: FastifyInstance,
  context: ConsoleRoutes,
  publishHandler: PublishHandler,
): AgentProfileRepository {
  const { allowedJobKinds, options, repository } = context;
  app.post('/v3/console/messages', publishHandler);

  /**
   * Obtiene el mensaje completo por la superficie de consola autorizada,
   * preservando el cuerpo íntegro del mensaje según las reglas de visibilidad del actor.
   */
  app.get<{ Params: { messageId: string } }>('/v3/console/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      // `not_found` y NO `forbidden`: responder «prohibido» confirmaría que el mensaje existe a
      // quien no puede verlo, que es el mismo criterio que ya usan replay y cancel.
      if (!row) throw new StoreError('not_found', 'message not found or not visible');
      return row;
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/queues', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleQueue(await repository.queueSnapshot(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  // La reconciliación causal es superficie de operador, no una segunda lista de colas. Tanto la
  // lectura como la decisión exigen `control`: la lista revela que existe un incidente operativo
  // y cada fila puede convertirse inmediatamente en una mutación auditada. El store repite la
  // autorización y aplica visibilidad multi-tenant; la fachada es una segunda allowlist para que
  // una regresión SQL nunca filtre payloads, errores ni ids del proveedor al navegador.
  app.get<{ Querystring: { limit?: string; cursor?: string } }>(
    '/v3/console/dlq',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requireOperatorPermission(actor, 'control');
        const limit = parseDlqLimit(request.query.limit);
        const cursor = parseDlqCursor(request.query.cursor);
        return safeDlqPage(await repository.listOperationalDlq(
          actor.tenant_id,
          actor.alias,
          limit,
          cursor,
        ));
      } catch (error) { replyError(reply, error); }
    },
  );

  // Esta ruta nunca reinyecta un efecto. Registra una decisión humana contra la huella exacta
  // de la evidencia vigente; si la fila cambió, el CAS del store falla. Target/id vienen de la
  // ruta pero actor/tenant sólo del principal autenticado, y el body es exacto para no aceptar
  // autoridad accidental en campos que un cliente viejo o comprometido pudiera agregar.
  app.post<{
    Params: { target: string; id: string };
  }>(
    '/v3/console/dlq/:target/:id/resolve-without-replay',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requireOperatorPermission(actor, 'control');
        const resolution = parseDlqResolution(request.params.target, request.params.id, request.body);
        return validatedDlqResolutionReceipt(await repository.resolveOperationalDlqWithoutReplay(
          actor.tenant_id,
          actor.alias,
          resolution,
        ), resolution);
      } catch (error) { replyError(reply, error); }
    },
  );

  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/replay', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const deliveryId = DeliveryIdSchema.parse(request.params.deliveryId);
      return validatedReplayReceipt(
        await repository.replayDelivery(deliveryId, actor.tenant_id, actor.alias),
        deliveryId,
      );
    } catch (error) { replyError(reply, error); }
  });

  // Cancelar es la operación gemela de replay y va con exactamente el mismo candado
  // (`requireOperatorPermission(actor,'control')` acá y `assertReplayAuthorization` en el store).
  // Se expone por la misma superficie a propósito: hasta hoy la única forma de cancelar era un
  // UPDATE a mano en la base, sin auditoría, sin aviso al origen y sin liberar al padre.
  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/cancel', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      // El motivo es opcional y sólo se acepta como texto. Cualquier otra forma se ignora en vez
      // de rechazarse: la cancelación no puede fallar por un campo decorativo.
      const body = request.body as { reason?: unknown } | undefined;
      const reason = typeof body?.reason === 'string' ? body.reason : undefined;
      const deliveryId = DeliveryIdSchema.parse(request.params.deliveryId);
      return validatedCancelReceipt(await repository.cancelDelivery(
        deliveryId, actor.tenant_id, actor.alias, reason
      ), deliveryId);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/jobs', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return sameTenantRows(await repository.listJobs(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });
  app.post('/v3/console/jobs', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const job = CreateJobSchema.parse(request.body);
      if (!allowedJobKinds.has(job.kind)) {
        throw new StoreError('no_route', `job kind has no executable handler: ${job.kind}`);
      }
      return reply.code(202).send({
        job_id: await repository.enqueueJob(actor.tenant_id, job.lane, job.priority, job.kind, job.payload)
      });
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/adapters', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.listAdapters(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // "Qué está trabajando cada agente ahora mismo", agregado por alias. Igual que topology()/
  // listAgents(), el alcance cross-tenant sale de acl_edges allow_read dentro del propio store
  // (fleetActivity() se autochequea el permiso, no hace falta un facade acá) -- este endpoint no
  // tiene un "modo flota" especial, es la misma regla default-deny de siempre. No lleva
  // sameTenantRows: aplastarlo por tenant sería esconder exactamente el caso que este panel
  // existe para mostrar (un alias sin registrar con entregas en vuelo en otro tenant visible).
  app.get('/v3/console/activity', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.fleetActivity(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // Consumo de cuotas de las suscripciones de IA, con su propio observed_at: es una muestra
  // fuera de banda de hace minutos, no de hace milisegundos como fleetActivity(), así que
  // fusionar los dos payloads mentiría sobre una de las dos frescuras.
  app.get('/v3/console/quotas', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.quotaSnapshot(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // The registry is intrinsically cross-tenant (an agent may borrow a pooled account paid by
  // another tenant), so no sameTenantRows facade runs here: the store already applied the
  // visibility rule and redacted the payer's account identity.
  /*
   * Registro del repositorio de perfiles y documentos de agentes.
   * Se registran en el ámbito de `/v3/console` de forma independiente del plugin de terminal.
   */
  // A ESTE nivel y no dentro del bloque: lo usan las rutas de consola Y el saludo del socket, que
  // manda el perfil una vez por conexión. Dos instancias sobre el mismo pool serían dos cachés y
  // dos sitios donde divergir.
  const agentProfiles = new AgentProfileRepository(options.pool);

  /*
   * El hueco donde el plano de terminal deja su sonda. Se decora sobre ESTA instancia de Fastify y
   * no vive como estado de módulo a propósito: los tests montan varios gateways en el mismo
   * proceso y compartirían la sonda del último en arrancar.
  */
  const sondaDeDocumentos = new SondaCompartida();
  const profileProbe = sondaDiferida(sondaDeDocumentos);
  app.decorate('sondaDeDocumentos', sondaDeDocumentos);
  {
    const perfiles = agentProfiles;
    const autorizarPerfil = async (
      request: unknown, permission: 'read' | 'control'
    ): Promise<{ tenant_id: Tenant; alias: string }> => {
      const actor = await principal(request as FastifyRequest, options.authProvider);
      if (permission === 'read') requirePermission(actor, 'read');
      else requireOperatorPermission(actor, 'control');
      return { tenant_id: actor.tenant_id, alias: actor.alias };
    };
    const autorizarDestino = async (
      actor: { tenant_id: string; alias: string },
      targetTenantId: string,
      targetAlias: string,
      permission: 'read' | 'control',
      legacySameTenant: boolean,
    ) => {
      const actorTenant = actor.tenant_id;
      const targetTenant = targetTenantId;
      if (repository.authorizeAgentTarget !== undefined) {
        try {
          return await repository.authorizeAgentTarget(
            actorTenant, actor.alias, targetTenant, targetAlias, permission,
          );
        } catch (error) {
          // No se distingue «actor sin permiso», «destino oculto» y «destino ausente» en esta
          // superficie: los tres fallan cerrados sin confirmar que la identidad existe.
          if (error instanceof StoreError
            && (error.code === 'forbidden' || error.code === 'invalid_actor')) return undefined;
          throw error;
        }
      }

      /*
       * Compatibilidad exclusiva para repositorios falsos anteriores a esta primitiva: sólo la
       * ruta LEGACY, sólo el tenant del actor y con permiso del store. Las rutas canónicas nunca
       * entran acá; sin método exacto responden 404.
       */
      if (!legacySameTenant || targetTenant !== actorTenant) return undefined;
      await repository.assertPermission(actorTenant, actor.alias, permission);
      return {
        tenant_id: actorTenant,
        alias: targetAlias,
        harness_id: null,
        home_directory: null,
        enabled: true,
      };
    };
    registerAgentProfileRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      readContext: (tenantId, alias) => perfiles.readContextWithPresence(tenantId, alias),
      replaceProfile: (profile, expectedRevision, actor) =>
        perfiles.replace(profile, expectedRevision, actor),
      prepareRuntime: (tenantId, alias, contexto) =>
        prepareAgentProfileRuntime(profileProbe, tenantId, alias, contexto),
      ...(repository.recordProfileRuntimeExpectation === undefined
        ? {}
        : {
            recordRuntimeExpectation: (tenantId, alias, revision, verification) =>
              repository.recordProfileRuntimeExpectation!(
                tenantId,
                alias,
                runtimeContractFromVerification(revision, verification),
              ),
          }),
      ...(repository.readProfileRuntimeAdoption === undefined
        ? {}
        : {
            readRuntimeAdoption: (tenantId, alias, revision, verification) =>
              repository.readProfileRuntimeAdoption!(
                tenantId,
                alias,
                runtimeContractFromVerification(revision, verification),
              ),
          }),
      markProfileApplied: (tenantId, alias, revision, actor) =>
        perfiles.markApplied(tenantId, alias, revision, actor),
    });
    registerAgentDocumentRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      /*
       * La sonda se resuelve en CADA petición a través del hueco, no se captura acá.
       *
       * La que de verdad lee el disco del contenedor la construye el plano de terminal, que en
       * `main.ts` se registra DESPUÉS de `buildGateway`: cuando estas rutas se montan, todavía no
       * existe. Capturarla acá guardaría para siempre la degradada, y el despliegue posterior del
       * plano no cambiaría nada — sin un error, además. Ver `console/sonda-compartida.ts`.
       *
       * Mientras nadie instale una, la degradada contesta «no medido» y «no hay canal» con esas
       * palabras, que es lo que la pantalla ya sabe pintar.
       */
      probe: profileProbe,
    });

    app.get<{ Params: { tenantId: string; alias: string } }>(
      '/v3/console/role-assignments/:tenantId/:alias/history',
      async (request, reply) => {
        try {
          const tenant = TenantSchema.safeParse(request.params.tenantId);
          const alias = AliasSchema.safeParse(request.params.alias);
          if (!tenant.success || !alias.success) {
            return reply.code(400).send({
              error: 'invalid_input', message: 'tenantId or alias is invalid',
            });
          }
          const actor = await autorizarPerfil(request, 'read');
          const target = await autorizarDestino(
            actor, tenant.data, alias.data, 'read', false,
          );
          if (!target || target.tenant_id !== tenant.data || target.alias !== alias.data) {
            return reply.code(404).send({
              error: 'not_found', message: 'agent not found or not visible',
            });
          }
          const history = await options.pool.query<Record<string, unknown>>(
            `SELECT id::text,tenant_id,alias,operation,previous_brief,new_brief,
                    previous_template_slug,new_template_slug,actor_tenant,actor_alias,changed_at
               FROM agent_role_brief_history
              WHERE tenant_id=$1 AND alias=$2
              ORDER BY agent_role_brief_history.id DESC LIMIT 100`,
            [target.tenant_id, target.alias],
          );
          return {
            observed_at: new Date().toISOString(),
            tenant_id: target.tenant_id,
            alias: target.alias,
            entries: history.rows,
          };
        } catch (error) { replyError(reply, error); }
      },
    );
  }

  app.get('/v3/console/agents', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.listAgents(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Params: { tenantId: string; alias: string } }>(
    '/v3/console/tenants/:tenantId/agents/:alias',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        const tenant = TenantSchema.safeParse(request.params.tenantId);
        const alias = AliasSchema.safeParse(request.params.alias);
        if (!tenant.success || !alias.success) {
          return reply.code(400).send({
            error: 'invalid_input', message: 'tenantId or alias is invalid',
          });
        }
        const agent = repository.getAgentByIdentity === undefined
          ? tenant.data === actor.tenant_id
            ? await repository.getAgent(alias.data, actor.tenant_id, actor.alias)
            : undefined
          : await repository.getAgentByIdentity(
              tenant.data, alias.data, actor.tenant_id, actor.alias,
            );
        if (!agent || agent.tenant_id !== tenant.data || agent.alias !== alias.data) {
          throw new StoreError('not_found', 'agent not found or not visible');
        }
        return agent;
      } catch (error) { replyError(reply, error); }
    },
  );

  // Compatibilidad sin tenant: significa estrictamente el tenant autenticado. Un alias visible
  // en otro tenant jamás puede ganar por orden alfabético ni por el orden físico de PostgreSQL.
  app.get<{ Params: { alias: string } }>('/v3/console/agents/:alias', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const alias = AliasSchema.parse(request.params.alias);
      const agent = await repository.getAgent(alias, actor.tenant_id, actor.alias);
      if (!agent || agent.tenant_id !== actor.tenant_id || agent.alias !== alias) {
        throw new StoreError('not_found', 'agent not found or not visible');
      }
      return agent;
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/origin-relays', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return visibleOriginRelays(await repository.listOriginRelays(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/egress/notifications', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return sameTenantRows(await repository.listNotifications(actor.tenant_id, actor.alias), actor);
    } catch (error) { replyError(reply, error); }
  });

  app.get<{ Querystring: Record<string, unknown> }>('/v3/console/audit', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const query = parseAuditQuery(request.query);
      return safeAuditPage(await repository.listAudit(actor.tenant_id, actor.alias, query));
    } catch (error) { replyError(reply, error); }
  });

  // Follow one delegation chain live, by trace id. The response is a graph, not a row list:
  // the store already applied per-node default-deny visibility, so no facade runs here.
  // sameTenantRows would both empty this payload (it has no `items`) and erase the
  // cross-tenant edges the endpoint exists to show.
  app.get<{ Params: { traceId: string } }>('/v3/console/chains/:traceId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.agentChain(request.params.traceId, actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  return agentProfiles;
}

export function registerConsoleRoutesPhase4(
  app: FastifyInstance,
  context: ConsoleRoutes,
): void {
  const { options, repository } = context;
  app.get('/v3/console/config', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.getConfiguration(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  app.post('/v3/console/config/changes', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const change = ConfigChangeRequestSchema.parse(request.body);
      const result = await repository.applyConfigurationChange(
        actor.tenant_id, actor.alias, change.mutation, change.dry_run, change.expected_revision
      );
      return reply.code(change.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, change.dry_run, null, change.mutation,
      ));
    } catch (error) { replyError(reply, error); }
  });

  app.post<{ Params: { revisionId: string } }>('/v3/console/config/revisions/:revisionId/rollback', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      const revisionId = Number(request.params.revisionId);
      if (!Number.isSafeInteger(revisionId) || revisionId < 1) throw new Error('revision id must be positive');
      const rollback = ConfigRollbackRequestSchema.parse(request.body);
      const result = await repository.rollbackConfiguration(
        actor.tenant_id, actor.alias, revisionId, rollback.dry_run, rollback.expected_revision
      );
      return reply.code(rollback.dry_run ? 200 : 201).send(validatedConfigurationReceipt(
        result, rollback.dry_run, revisionId,
      ));
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/observability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const [status, queues, jobs, relays] = await Promise.all([
        repository.status(actor.tenant_id, actor.alias),
        repository.queueSnapshot(actor.tenant_id, actor.alias),
        repository.listJobs(actor.tenant_id, actor.alias),
        repository.listOriginRelays(actor.tenant_id, actor.alias)
      ]);
      return { observed_at: new Date().toISOString(), status, queues, jobs, origin_relays: relays };
    } catch (error) { replyError(reply, error); }
  });

  app.get('/v3/console/terminal/capability', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      if (options.terminalCapability?.available === true) return options.terminalCapability;
      return reply.code(501).send({ available: false, reason: 'PTY backend capability is not configured' });
    } catch (error) { replyError(reply, error); }
  });
}

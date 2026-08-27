import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AliasSchema, CreateJobSchema, DeliveryIdSchema, TenantSchema, type Tenant,
} from '@cauce/protocol';
import { AgentProfileRepository, StoreError } from '@cauce/store';
import { requireOperatorPermission, requirePermission } from '../auth.js';
import { registerAgentDocumentRoutes } from '../console/agent-documents.routes.js';
import { prepareAgentProfileRuntime } from '../console/agent-profile-runtime.js';
import { registerAgentProfileRoutes } from '../console/agent-profile.routes.js';
import { SondaCompartida, sondaDiferida } from '../console/sonda-compartida.js';
import {
  safeAuditPage, safeDlqPage, sameTenantRows, visibleMessage, visibleOriginRelays, visibleQueue,
} from '../facades.js';
import { principal, replyError } from './shared.js';
import type { ConsoleRoutes, PublishHandler } from './console/contracts.js';
import {
  parseAuditQuery, parseDlqCursor, parseDlqLimit, parseDlqResolution,
  runtimeContractFromVerification, validatedCancelReceipt, validatedDlqResolutionReceipt,
  validatedReplayReceipt,
} from './console/helpers.js';

export {
  createConsoleRoutes, registerConsoleRoutesPhase1, registerConsoleRoutesPhase2,
} from './console/early.js';
export { registerConsoleRoutesPhase4 } from './console/phase4.js';

export function registerConsoleRoutesPhase3(
  app: FastifyInstance,
  context: ConsoleRoutes,
  publishHandler: PublishHandler,
): AgentProfileRepository {
  const { allowedJobKinds, options, repository } = context;
  app.post('/v3/console/messages', publishHandler);

  app.get<{ Params: { messageId: string } }>('/v3/console/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      // `not_found`, nunca `forbidden`: no confirma que exista un mensaje invisible.
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

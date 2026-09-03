import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AliasSchema, CreateJobSchema, DeliveryIdSchema, ProfileRuntimeContractSchema, TenantSchema,
  type Tenant,
} from '@cauce/protocol';
import { AgentContextRevisionsStore, AgentProfileRepository, StoreError } from '@cauce/store';
import { requireOperatorPermission, requirePermission } from '../auth.js';
import { registerAgentContextHistoryRoutes } from '../console/agent-context-history.routes.js';
import {
  DELIVERY_IN_FLIGHT_LISTED, medirContextoDeGobierno, registerAgentContextReloadRoutes,
  type DeliveriesInFlight,
} from '../console/agent-context-reload.routes.js';
import { registerAgentDocumentRoutes } from '../console/agent-documents.routes.js';
import { prepareAgentProfileRuntime } from '../console/agent-profile-runtime.js';
import { registerAgentProfileRoutes } from '../console/agent-profile.routes.js';
import { SondaCompartida, sondaDiferida } from '../console/sonda-compartida.js';
import { recordTerminalAudit } from '../terminal/audit.js';
import { DEFAULT_OPERATOR_HEADER } from '../terminal/config.js';
import { resolveOperator } from '../terminal/authority.js';
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
import { registerConsoleAccessRoutes } from './console/access.js';
import { registerConsoleOperationsRoutes } from './console/operations.js';
import { publishRouteOptions } from './core/publish.js';

export { createConsoleRoutes } from './console/access.js';

async function expectativaDeRuntime(
  pool: ConsoleRoutes['options']['pool'], tenantId: string, alias: string,
): Promise<{
  generation: string;
  documents: readonly { name: string; path: string; sha: string }[];
} | undefined> {
  const result = await pool.query<{ generation: string; documents: unknown }>(
    `SELECT generation,documents FROM agent_profile_runtime_expectations
      WHERE tenant_id=$1 AND alias=$2`,
    [tenantId, alias],
  );
  const row = result.rows[0];
  if (row === undefined || !Array.isArray(row.documents)) return undefined;
  const parsed = ProfileRuntimeContractSchema.safeParse({
    revision: 1, generation: row.generation, documents: row.documents,
  });
  if (!parsed.success) return undefined;
  return { generation: parsed.data.generation, documents: parsed.data.documents };
}

async function entregaEnVuelo(
  pool: ConsoleRoutes['options']['pool'], tenantId: string, alias: string,
): Promise<DeliveriesInFlight> {
  const result = await pool.query<{
    delivery_id: string;
    status: string;
    claimed_at: Date | null;
    deadline_at: Date | null;
    total: string;
  }>(
    `SELECT id::text AS delivery_id, status, claimed_at, ack_deadline_at AS deadline_at,
            (count(*) OVER ())::text AS total
       FROM deliveries
      WHERE recipient_tenant=$1 AND recipient_alias=$2
        AND status IN ('leased','accepted','started')
      ORDER BY claimed_at ASC NULLS LAST, id ASC LIMIT $3`,
    [tenantId, alias, DELIVERY_IN_FLIGHT_LISTED],
  );
  return {
    count: Number(result.rows[0]?.total ?? 0),
    deliveries: result.rows.map((row) => ({
      delivery_id: row.delivery_id,
      status: row.status,
      claimed_at: row.claimed_at?.toISOString() ?? null,
      deadline_at: row.deadline_at?.toISOString() ?? null,
    })),
  };
}

/**
 * Mounts the whole `/v3/console` surface. The topic modules register disjoint paths, so their
 * order is free; only the profile repository crosses module boundaries, towards the runtime routes.
 */
export function registerConsoleRoutes(
  app: FastifyInstance,
  context: ConsoleRoutes,
  publishHandler: PublishHandler,
): AgentProfileRepository {
  registerConsoleAccessRoutes(app, context);
  registerConsoleOperationsRoutes(app, context);
  return registerConsoleAgentRoutes(app, context, publishHandler);
}

function registerConsoleAgentRoutes(
  app: FastifyInstance,
  context: ConsoleRoutes,
  publishHandler: PublishHandler,
): AgentProfileRepository {
  const { allowedJobKinds, options, repository } = context;
  app.post('/v3/console/messages', publishRouteOptions, publishHandler);

  app.get<{ Params: { messageId: string } }>('/v3/console/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      // `not_found`, never `forbidden`: it does not confirm that an invisible message exists.
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

  // Causal reconciliation is operator surface, not a second queue listing. Both read and decision
  // require `control`: the list reveals an operational incident and each row can immediately
  // become an audited mutation. The store re-applies authorization and visibility; the facade is
  // a second allowlist so an SQL regression never leaks payloads, errors, or vendor ids.
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

  // This route never re-injects a side effect. It records a human decision against the exact
  // fingerprint of the current evidence; if the row changed, the store's CAS fails. Target/id
  // come from the route but actor/tenant only from the authenticated principal, and the body is
  // exact to avoid granting accidental authority on fields an old or compromised client might add.
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

  // Cancel is the twin operation of replay and runs with exactly the same lock
  // (`requireOperatorPermission(actor,'control')` here and `assertReplayAuthorization` in the store).
  // It is exposed through the same surface on purpose: until today, the only way to cancel was a
  // hand-issued UPDATE in the database, with no audit, no notice to the origin, no freeing of the parent.
  app.post<{ Params: { deliveryId: string } }>('/v3/console/deliveries/:deliveryId/cancel', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      // The reason is optional and only accepted as text. Anything else is ignored rather than
      // rejected: cancellation must not fail because of a decorative field.
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
      return await reply.code(202).send({
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

  // "What each agent is working on right now", aggregated by alias. Like topology()/listAgents(),
  // the cross-tenant scope comes from acl_edges allow_read inside the store itself
  // (fleetActivity() self-checks the permission, no facade needed here) -- this endpoint has no
  // special "fleet mode", it is the same default-deny rule as always. It does not use
  // sameTenantRows: flattening it by tenant would hide exactly the case this panel exists to
  // show (an unregistered alias with deliveries in flight in another visible tenant).
  app.get('/v3/console/activity', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      return await repository.fleetActivity(actor.tenant_id, actor.alias);
    } catch (error) { replyError(reply, error); }
  });

  // AI subscription quota consumption, with its own observed_at: this is an out-of-band sample
  // from minutes ago, not milliseconds ago like fleetActivity(), so merging the two payloads
  // would lie about one of the two freshnesses.
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
   * Registry of the agent profiles and documents repository.
   * Registered within the `/v3/console` scope independently of the terminal plugin.
   */
  // At THIS level and not inside the block: it is used by the console routes AND the socket hello,
  // which sends the profile once per connection. Two instances over the same pool would be two
  // caches and two places to diverge.
  const agentProfiles = new AgentProfileRepository(options.pool);

  /*
   * The slot where the terminal plane leaves its probe. Decorated on THIS Fastify instance and
   * not held as module state on purpose: tests mount several gateways in the same process and
   * would otherwise share the probe of whichever one started last.
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
    ) => {
      try {
        return await repository.authorizeAgentTarget(
          actor.tenant_id, actor.alias, targetTenantId, targetAlias, permission,
        );
      } catch (error) {
        // This surface does not distinguish "actor without permission", "hidden target", and
        // "missing target": all three fail closed without confirming that the identity exists.
        if (error instanceof StoreError
          && (error.code === 'forbidden' || error.code === 'invalid_actor')) return undefined;
        throw error;
      }
    };
    const recordRuntimeExpectation = repository.recordProfileRuntimeExpectation.bind(repository);
    const readRuntimeAdoption = repository.readProfileRuntimeAdoption.bind(repository);
    registerAgentProfileRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      resolveOperator: async (request) => resolveOperator(
        request as FastifyRequest,
        await principal(request as FastifyRequest, options.authProvider),
        options.operatorResolution ?? { operatorHeader: DEFAULT_OPERATOR_HEADER, operators: new Set() },
      ),
      recordAudit: (entry) => recordTerminalAudit(options.pool, entry),
      measureContext: (tenantId, alias) =>
        medirContextoDeGobierno(profileProbe, tenantId, alias),
      readRuntimeExpectation: (tenantId, alias) =>
        expectativaDeRuntime(options.pool, tenantId, alias),
      readContext: (tenantId, alias) => perfiles.readContextWithPresence(tenantId, alias),
      replaceProfile: (profile, expectedRevision, actor) =>
        perfiles.replace(profile, expectedRevision, actor),
      prepareRuntime: (tenantId, alias, contexto) =>
        prepareAgentProfileRuntime(profileProbe, tenantId, alias, contexto),
      recordRuntimeExpectation: (tenantId, alias, revision, verification) =>
        recordRuntimeExpectation(
          tenantId, alias, runtimeContractFromVerification(revision, verification),
        ),
      readRuntimeAdoption: (tenantId, alias, revision, verification) =>
        readRuntimeAdoption(
          tenantId, alias, runtimeContractFromVerification(revision, verification),
        ),
      markProfileApplied: (tenantId, alias, revision, actor) =>
        perfiles.markApplied(tenantId, alias, revision, actor),
    });
    registerAgentDocumentRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: autorizarDestino,
      /*
       * The probe is resolved on EACH request through the slot, it is not captured here.
       *
       * The one that actually reads the container's disk is built by the terminal plane, which in
       * `main.ts` registers AFTER `buildGateway`: when these routes mount, it does not exist yet.
       * Capturing it here would freeze the degraded one forever, and the later deployment of the
       * plane would change nothing — without an error either. See `console/sonda-compartida.ts`.
       *
       * Until someone installs one, the degraded version answers "not measured" and "no channel"
       * with those exact words, which is what the screen already knows how to render.
       */
      probe: profileProbe,
      resolveOperator: async (request) => resolveOperator(
        request as FastifyRequest,
        await principal(request as FastifyRequest, options.authProvider),
        options.operatorResolution ?? { operatorHeader: DEFAULT_OPERATOR_HEADER, operators: new Set() },
      ),
      // A denial leaving no audit row is worse than an unavailable route: the write is awaited.
      recordAudit: (entry) => recordTerminalAudit(options.pool, entry),
    });

    const diario = new AgentContextRevisionsStore(options.pool);
    registerAgentContextHistoryRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: (actor, tenantId, alias, permission) =>
        autorizarDestino(actor, tenantId, alias, permission),
      listProfileRevisions: (tenantId, alias, limit, cursor) =>
        diario.listProfileRevisions(tenantId, alias, limit, cursor),
      listDocumentRevisions: (tenantId, alias, kind, limit, cursor) =>
        diario.listDocumentRevisions(tenantId, alias, kind, limit, cursor),
    });
    registerAgentContextReloadRoutes(app, {
      authorize: autorizarPerfil,
      authorizeTarget: (actor, tenantId, alias, permission) =>
        autorizarDestino(actor, tenantId, alias, permission),
      resolveOperator: async (request) => resolveOperator(
        request as FastifyRequest,
        await principal(request as FastifyRequest, options.authProvider),
        options.operatorResolution ?? { operatorHeader: DEFAULT_OPERATOR_HEADER, operators: new Set() },
      ),
      readContext: (tenantId, alias) => perfiles.readContextWithPresence(tenantId, alias),
      prepareRuntime: (tenantId, alias, contexto) =>
        prepareAgentProfileRuntime(profileProbe, tenantId, alias, contexto),
      measureContext: (tenantId, alias) =>
        medirContextoDeGobierno(profileProbe, tenantId, alias),
      readRuntimeExpectation: (tenantId, alias) =>
        expectativaDeRuntime(options.pool, tenantId, alias),
      recordRuntimeExpectation: (tenantId, alias, revision, verification) =>
        recordRuntimeExpectation(
          tenantId, alias, runtimeContractFromVerification(revision, verification),
        ),
      deliveryInFlight: (tenantId, alias) => entregaEnVuelo(options.pool, tenantId, alias),
      recordDocumentRevision: (input) => diario.recordDocumentRevision(input),
      recordAudit: (entry) => recordTerminalAudit(options.pool, entry),
    });

    app.get<{ Params: { tenantId: string; alias: string } }>(
      '/v3/console/role-assignments/:tenantId/:alias/history',
      async (request, reply) => {
        try {
          const tenant = TenantSchema.safeParse(request.params.tenantId);
          const alias = AliasSchema.safeParse(request.params.alias);
          if (!tenant.success || !alias.success) {
            return await reply.code(400).send({
              error: 'invalid_input', message: 'tenantId or alias is invalid',
            });
          }
          const actor = await autorizarPerfil(request, 'read');
          const target = await autorizarDestino(actor, tenant.data, alias.data, 'read');
          if (target?.tenant_id !== tenant.data || target.alias !== alias.data) {
            return await reply.code(404).send({
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
          return await reply.code(400).send({
            error: 'invalid_input', message: 'tenantId or alias is invalid',
          });
        }
        const agent = await repository.getAgentByIdentity(
          tenant.data, alias.data, actor.tenant_id, actor.alias,
        );
        if (agent?.tenant_id !== tenant.data || agent.alias !== alias.data) {
          throw new StoreError('not_found', 'agent not found or not visible');
        }
        return agent;
      } catch (error) { replyError(reply, error); }
    },
  );

  // Compatibility without tenant: it means strictly the authenticated tenant. A visible alias
  // in another tenant can never win by alphabetical order or by PostgreSQL's physical order.
  app.get<{ Params: { alias: string } }>('/v3/console/agents/:alias', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const alias = AliasSchema.parse(request.params.alias);
      const agent = await repository.getAgent(alias, actor.tenant_id, actor.alias);
      if (agent?.tenant_id !== actor.tenant_id || agent.alias !== alias) {
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

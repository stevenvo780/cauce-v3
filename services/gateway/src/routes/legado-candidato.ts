import type { FastifyInstance } from 'fastify';
import {
  ConsolePublishIntentConfirmResultSchema,
  ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentPrepareResultSchema,
  ConsolePublishIntentPrepareSchema,
  ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentReconciliationSchema,
  type ConsolePublishIntentConfirm,
  type ConsolePublishIntentConfirmResult,
  type ConsolePublishIntentPrepare,
  type ConsolePublishIntentPrepareResult,
  type Tenant,
} from '@cauce/protocol';
import {
  PublishIntentRateLimitedError,
  PublishIntentReconciliationRequired,
  StoreError,
} from '@cauce/store';
import { requirePermission, type AuthProvider } from '../auth.js';
import type { ConsolePublishTelemetry } from '../console-publish-telemetry.js';
import {
  consolePublishOperatorScope,
  principal,
  replyError,
  trustedPublishSemantics,
  type TrustedPublishIntentCommand,
} from './shared.js';

interface LegacyCandidateRouteOptions {
  readonly authProvider: AuthProvider;
}

interface LegacyCandidateRepository {
  prepareConsolePublishIntent?(
    input: TrustedPublishIntentCommand,
    operatorScopeHash: string,
  ): Promise<ConsolePublishIntentPrepareResult>;
  confirmConsolePublishIntent?(
    tenantId: Tenant,
    actorAlias: string,
    operatorScopeHash: string,
    input: ConsolePublishIntentConfirm,
  ): Promise<ConsolePublishIntentConfirmResult>;
  listChainGates?(
    actorTenant: Tenant,
    actorAlias: string,
    options?: { status?: 'open' | 'all'; limit?: number },
  ): Promise<Record<string, unknown>>;
  answerChainGate?(
    gateId: string,
    answer: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
  cancelChainGate?(
    gateId: string,
    actorTenant: Tenant,
    actorAlias: string,
  ): Promise<Record<string, unknown>>;
}

function publicPublishIntent(value: unknown): ConsolePublishIntentPrepare {
  return ConsolePublishIntentPrepareSchema.parse(value);
}

export function registerLegacyCandidatePublishIntentRoutes(
  app: FastifyInstance,
  options: LegacyCandidateRouteOptions,
  repository: LegacyCandidateRepository,
  consolePublishTelemetry: ConsolePublishTelemetry,
): void {
  app.post('/v3/console/publish-intents', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (repository.prepareConsolePublishIntent === undefined) {
        throw new StoreError('not_found', 'durable console publish intents are unavailable');
      }
      const publicCommand = publicPublishIntent(request.body);
      const command: TrustedPublishIntentCommand = {
        ...trustedPublishSemantics(actor, publicCommand, request),
        intent_nonce: publicCommand.intent_nonce,
        requested_priority: publicCommand.priority,
      };
      const result = ConsolePublishIntentPrepareResultSchema.parse(
        await repository.prepareConsolePublishIntent(
          command,
          consolePublishOperatorScope(actor),
        ),
      );
      consolePublishTelemetry.record({ operation: 'prepare', result: result.state });
      return reply.code(200).send(result);
    } catch (error) {
      if (error instanceof PublishIntentReconciliationRequired) {
        consolePublishTelemetry.record({ operation: 'prepare', result: 'reconciliation_required' });
        return reply.code(409).send(
          ConsolePublishIntentReconciliationSchema.parse(error.reconciliation),
        );
      }
      if (error instanceof PublishIntentRateLimitedError) {
        consolePublishTelemetry.record({ operation: 'prepare', result: 'rate_limited' });
        const limited = ConsolePublishIntentRateLimitedSchema.parse(error.rateLimit);
        return reply.header('Retry-After', String(limited.retry_after_seconds))
          .code(429).send(limited);
      }
      consolePublishTelemetry.record({ operation: 'prepare', result: 'error' });
      replyError(reply, error);
    }
  });

  app.post('/v3/console/publish-intents/confirm', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (repository.confirmConsolePublishIntent === undefined) {
        throw new StoreError('not_found', 'durable console publish intents are unavailable');
      }
      const confirmation = ConsolePublishIntentConfirmSchema.parse(request.body);
      const result = ConsolePublishIntentConfirmResultSchema.parse(
        await repository.confirmConsolePublishIntent(
          actor.tenant_id,
          actor.alias,
          consolePublishOperatorScope(actor),
          confirmation,
        ),
      );
      consolePublishTelemetry.record({ operation: 'confirm', result: 'confirmed' });
      return reply.code(200).send(result);
    } catch (error) {
      consolePublishTelemetry.record({ operation: 'confirm', result: 'error' });
      replyError(reply, error);
    }
  });
}

export function registerLegacyCandidateChainGateRoutes(
  app: FastifyInstance,
  options: LegacyCandidateRouteOptions,
  repository: LegacyCandidateRepository,
): void {
  // Las preguntas que la flota le dejó a una persona. Es la LISTA VISIBLE que el gate promete:
  // sin ella, sacar la espera humana del bus sólo la escondería en otro lado.
  //
  // Sin fachada sameTenantRows, por el mismo motivo que /v3/console/chains/:traceId: el store ya
  // aplicó la visibilidad fila por fila (tenant propio, o arista ACL con allow_read), y aplastar
  // por tenant acá dejaría a un operador del hub sin poder contestar la pregunta de un agente de
  // otro tenant, que es justo para lo que existe esta lista.
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/v3/console/chain-gates',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'read');
        if (repository.listChainGates === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        const limit = Number.parseInt(request.query.limit ?? '', 10);
        return await repository.listChainGates(actor.tenant_id, actor.alias, {
          status: request.query.status === 'all' ? 'all' : 'open',
          ...(Number.isSafeInteger(limit) && limit > 0 ? { limit } : {})
        });
      } catch (error) { replyError(reply, error); }
    }
  );

  // Contestar reanuda la rama suspendida con UNA entrega. Pide 'route' y no 'read' porque
  // produce tráfico en el bus, igual que publicar.
  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/answer',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        if (repository.answerChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        const body = request.body === null || typeof request.body !== 'object'
          ? {}
          : request.body as Record<string, unknown>;
        const answer = typeof body.answer === 'string' ? body.answer : '';
        return await repository.answerChainGate(
          request.params.gateId, answer, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );

  app.post<{ Params: { gateId: string } }>(
    '/v3/console/chain-gates/:gateId/cancel',
    async (request, reply) => {
      try {
        const actor = await principal(request, options.authProvider);
        requirePermission(actor, 'route');
        if (repository.cancelChainGate === undefined) {
          throw new StoreError('not_found', 'chain gates are not available in this deployment');
        }
        return await repository.cancelChainGate(
          request.params.gateId, actor.tenant_id, actor.alias
        );
      } catch (error) { replyError(reply, error); }
    }
  );
}

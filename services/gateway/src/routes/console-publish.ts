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

interface ConsolePublishRouteOptions {
  readonly authProvider: AuthProvider;
}

interface ConsolePublishRepository {
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
}

function publicPublishIntent(value: unknown): ConsolePublishIntentPrepare {
  return ConsolePublishIntentPrepareSchema.parse(value);
}

export function registerConsolePublishIntentRoutes(
  app: FastifyInstance,
  options: ConsolePublishRouteOptions,
  repository: ConsolePublishRepository,
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
      return await reply.code(200).send(result);
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
      return await reply.code(200).send(result);
    } catch (error) {
      consolePublishTelemetry.record({ operation: 'confirm', result: 'error' });
      replyError(reply, error);
    }
  });
}

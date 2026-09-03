import type { FastifyInstance } from 'fastify';
import {
  ConsolePublishIntentConfirmResultSchema,
  ConsolePublishIntentConfirmSchema,
  ConsolePublishIntentPrepareResultSchema,
  ConsolePublishIntentPrepareSchema,
  ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentReconciliationSchema,
  type ConsolePublishIntentPrepare,
} from '@cauce/protocol';
import {
  PublishIntentRateLimitedError,
  PublishIntentReconciliationRequired,
} from '@cauce/store';
import { requirePermission, type AuthProvider } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import type { ConsolePublishTelemetry } from '../console-publish-telemetry.js';
import { publishRouteOptions } from './core/publish.js';
import { logPublishRedaction, redactPublishBody } from './publish-redaction.js';
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

type ConsolePublishRepository = Pick<GatewayRepository,
  'prepareConsolePublishIntent' | 'confirmConsolePublishIntent'
>;

function publicPublishIntent(value: unknown): ConsolePublishIntentPrepare {
  return ConsolePublishIntentPrepareSchema.parse(value);
}

export function registerConsolePublishIntentRoutes(
  app: FastifyInstance,
  options: ConsolePublishRouteOptions,
  repository: ConsolePublishRepository,
  consolePublishTelemetry: ConsolePublishTelemetry,
): void {
  /*
   * The prepare leg carries the whole body, attachments included, so it needs the same derived
   * body limit as the publish leg; Fastify's 1 MiB default would reject there what the protocol
   * declares legal here. And it redacts with the SAME helper: the store gates the publish on a
   * semantic hash over the body, so redacting on only one leg makes every message with a secret
   * shape a permanent 409 instead of a delivered, redacted one.
   */
  app.post('/v3/console/publish-intents', publishRouteOptions, async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const publicCommand = publicPublishIntent(request.body);
      const redaction = redactPublishBody(publicCommand.body);
      logPublishRedaction(request.log, actor, redaction);
      const command: TrustedPublishIntentCommand = {
        ...trustedPublishSemantics(actor, { ...publicCommand, body: redaction.body }, request),
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

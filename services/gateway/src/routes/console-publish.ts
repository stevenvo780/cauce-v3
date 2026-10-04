import type { FastifyInstance } from 'fastify';
import {
  ConsolePublishIntentRateLimitedSchema,
  ConsolePublishIntentReconciliationSchema,
} from '@cauce/protocol';
import {
  PublishIntentRateLimitedError,
  PublishIntentReconciliationRequired,
} from '@cauce/store';
import type { AuthProvider } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import type { ConsolePublishTelemetry } from '../console-publish-telemetry.js';
import { publishRouteOptions } from './core/publish.js';
import { logPublishRedaction } from './publish-redaction.js';
import { prepareConsolePublishOperation, confirmConsolePublishOperation } from '../console-publish-operation.js';
import {
  principal,
  replyError,
} from './shared.js';

interface ConsolePublishRouteOptions {
  readonly authProvider: AuthProvider;
}

type ConsolePublishRepository = Pick<GatewayRepository,
  'prepareConsolePublishIntent' | 'confirmConsolePublishIntent'
>;

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
    let operationStarted = false;
    try {
      const actor = await principal(request, options.authProvider);
      operationStarted = true;
      const result = await prepareConsolePublishOperation(repository, {
        actor, body: request.body, priorityLog: request.log,
        interactiveHumanEntry: request.routeOptions.url === '/v3/console/publish-intents',
        logRedaction: (redactionActor, redaction) => { logPublishRedaction(request.log, redactionActor, redaction); },
      }, consolePublishTelemetry);
      return await reply.code(200).send(result);
    } catch (error) {
      if (!operationStarted) consolePublishTelemetry.record({ operation: 'prepare', result: 'error' });
      if (error instanceof PublishIntentReconciliationRequired) {
        return reply.code(409).send(
          ConsolePublishIntentReconciliationSchema.parse(error.reconciliation),
        );
      }
      if (error instanceof PublishIntentRateLimitedError) {
        const limited = ConsolePublishIntentRateLimitedSchema.parse(error.rateLimit);
        return reply.header('Retry-After', String(limited.retry_after_seconds))
          .code(429).send(limited);
      }
      replyError(reply, error);
    }
  });

  app.post('/v3/console/publish-intents/confirm', async (request, reply) => {
    let operationStarted = false;
    try {
      const actor = await principal(request, options.authProvider);
      operationStarted = true;
      const result = await confirmConsolePublishOperation(repository, {
        actor, body: request.body,
      }, consolePublishTelemetry);
      return await reply.code(200).send(result);
    } catch (error) {
      if (!operationStarted) consolePublishTelemetry.record({ operation: 'confirm', result: 'error' });
      replyError(reply, error);
    }
  });
}

import type {
  FastifyError, FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions,
} from 'fastify';
import {
  ConsolePublishIntentExpiredSchema, MAX_PUBLISH_BODY_BYTES, NotifyRequestSchema,
  QuotaSampleRequestSchema,
} from '@cauce/protocol';
import { PublishIntentExpiredError } from '@cauce/store';
import {
  requireOperatorPermission, requirePermission, type AuthProvider,
} from '../../auth.js';
import type { ConsolePublishTelemetry } from '../../console-publish-telemetry.js';
import type { GatewayRepository } from '../../app.js';
import { consoleHumanAccess, type ConsoleHumanAccess } from '../../console-human-authority.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { logPublishRedaction } from '../publish-redaction.js';
import { principal, replyError } from '../shared.js';
import { publishOperation } from '../../publish-operation.js';
import type { CorePublishHandler, CoreRouteOptions } from './contracts.js';

function requestAuthMechanism(authProvider: AuthProvider, request: FastifyRequest): string | undefined {
  if (authProvider instanceof PasswordAuthProvider) {
    return authProvider.handles(request) ? authProvider.name : authProvider.fallback?.name;
  }
  return authProvider.name;
}

function publishBodyLimitErrorHandler(
  error: FastifyError, _request: FastifyRequest, reply: FastifyReply,
): void {
  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    void reply.code(413).send({
      error: 'too_large',
      message: 'el cuerpo del publish se pasa del tope de adjuntos del protocolo',
    });
    return;
  }
  void reply.send(error);
}

export const publishRouteOptions: RouteShorthandOptions = {
  bodyLimit: MAX_PUBLISH_BODY_BYTES,
  errorHandler: publishBodyLimitErrorHandler,
};

export function registerCorePublishRoutes(
  app: FastifyInstance,
  options: CoreRouteOptions,
  repository: GatewayRepository,
  consolePublishTelemetry: ConsolePublishTelemetry,
): CorePublishHandler {
  const publishHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const consolePublish = request.routeOptions.url === '/v3/console/messages';
    let human: ConsoleHumanAccess | undefined;
    try {
      const actor = await principal(request, options.authProvider);
      if (consolePublish) human = await consoleHumanAccess(options.authProvider, request, reply);
      const receipt = await publishOperation(repository, {
        ...(human === undefined ? {} : { humanAccess: human.options }),
        actor, body: request.body, entry: consolePublish ? 'console' : 'direct',
        authMechanism: requestAuthMechanism(options.authProvider, request),
        priorityLog: request.log,
        logRedaction: (redactionActor, redaction) => {
          logPublishRedaction(request.log, redactionActor, redaction);
        },
      });
      if (consolePublish) {
        consolePublishTelemetry.record({ operation: 'publish', result: 'committed' });
      }
      return await reply.code(202).send(receipt);
    } catch (error) {
      if (error instanceof PublishIntentExpiredError) {
        if (consolePublish) {
          consolePublishTelemetry.record({ operation: 'publish', result: 'expired' });
        }
        return await reply.code(410).send(
          ConsolePublishIntentExpiredSchema.parse(error.expiration),
        );
      }
      if (consolePublish) consolePublishTelemetry.record({ operation: 'publish', result: 'error' });
      replyError(reply, error);
    } finally { human?.close(); }
  };
  app.post('/v3/messages', publishRouteOptions, publishHandler);

  // Proactive egress. POST /v3/messages deliberately cannot express a channel
  // destination and must stay that way; this is the only surface that can, and
  // the only destination it accepts is a handle already on the allowlist.
  app.post('/v3/egress/notifications', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'notify');
      const command = NotifyRequestSchema.parse(request.body);
      const verdict = await repository.enqueueNotification(actor.tenant_id, actor.alias, command);
      if (verdict.decision === 'denied') {
        return await reply.code(403).send({
          error: 'forbidden',
          message: 'proactive egress was denied by policy',
          notification_id: verdict.notification_id,
          denial_code: verdict.denial_code,
          dry_run: verdict.dry_run,
          duplicate: verdict.duplicate
        });
      }
      return await reply.code(202).send(verdict);
    } catch (error) { replyError(reply, error); }
  });

  // Out-of-band quota-sample ingestion from the collector. Lives outside /v3/console/ so machine
  // services can call it with an authenticated request but no browser Origin header.
  //
  // Permission: same pair as POST /v3/console/jobs -- requireOperatorPermission on the Principal
  // (role derived from the certificate) PLUS assertPermission against role_policies (the source of
  // truth in the database). recordQuotaSample() does not self-check, so without this second check
  // an agent with a wrongly granted 'control' permission could pause subscriptions for the fleet.
  app.post('/v3/quotas/samples', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const sample = QuotaSampleRequestSchema.parse(request.body);
      const result = await repository.recordQuotaSample(actor.tenant_id, actor.alias, sample);
      return await reply.code(202).send(result);
    } catch (error) { replyError(reply, error); }
  });

  // Account selection for the alias ITSELF (the rotating-account system). Lives outside
  // /v3/console/ for the same reason as /v3/quotas/samples: it is called by an adapter holding a
  // client certificate, and createConsoleSecurityHook rejects anything that does not bring a
  // same-origin Origin, which a daemon never sends.
  //
  // The subject is NOT a parameter: it comes from the certificate. An alias resolves its own
  // account and no other, so the permission needed here is 'route' (which every dispatching
  // adapter already has) rather than 'control'. Asking for 'control' here would have forced
  // giving every agent the same permission that pauses subscriptions for the entire fleet, which
  // is exactly the opposite of what this route needs.
  app.get('/v3/accounts/selection', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'route');
      const provider = (request.query as { provider?: unknown } | undefined)?.provider;
      if (typeof provider !== 'string') {
        return await reply.code(400).send({ error: 'invalid_input', message: 'provider query parameter is required' });
      }
      return await repository.selectAccount(actor.tenant_id, actor.alias, provider);
    } catch (error) { replyError(reply, error); }
  });
  return publishHandler;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConsolePublishIntentExpiredSchema, NotifyRequestSchema, QuotaSampleRequestSchema,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE, SystemGateProbeBodySchema,
} from '@cauce/protocol';
import { PublishIntentExpiredError, StoreError } from '@cauce/store';
import {
  AuthorizationError, requireOperatorPermission, requirePermission, type AuthProvider,
} from '../../auth.js';
import type { ConsolePublishTelemetry } from '../../console-publish-telemetry.js';
import type { GatewayRepository } from '../../app.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import {
  consolePublishOperatorScope, principal, publicPublish, replyError, trustedPublishSemantics,
  validatedPublishReceipt, type TrustedPublishCommand,
} from '../shared.js';
import type { CorePublishHandler, CoreRouteOptions } from './contracts.js';

function requestAuthMechanism(authProvider: AuthProvider, request: FastifyRequest): string | undefined {
  if (authProvider instanceof PasswordAuthProvider) {
    return authProvider.handles(request) ? authProvider.name : authProvider.fallback?.name;
  }
  return authProvider.name;
}

export function registerCorePublishRoutes(
  app: FastifyInstance,
  options: CoreRouteOptions,
  repository: GatewayRepository,
  consolePublishTelemetry: ConsolePublishTelemetry,
): CorePublishHandler {
  const publishHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const consolePublish = request.routeOptions.url === '/v3/console/messages';
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const command = publicPublish(request.body);
      const systemGateProbe = command.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE;
      if (systemGateProbe) {
        const probeBody = SystemGateProbeBodySchema.parse(command.body);
        const exactRole = actor.roles.length === 1 && actor.roles[0] === 'agent';
        const exactPermissions = actor.permissions.length === 2
          && actor.permissions.includes('route') && actor.permissions.includes('read');
        if (requestAuthMechanism(options.authProvider, request) !== 'mtls' || actor.tenant_id !== 'Steven' ||
            actor.alias !== 'gate-probe' || actor.session_id !== 'gate-probe' ||
            actor.channel !== 'gate' || actor.origin !== undefined || !exactRole || !exactPermissions) {
          throw new AuthorizationError('system gate probe requires the exact dedicated mTLS identity');
        }
        const recipient = command.recipients[0];
        if (command.room_id !== 'grp.steven' || command.recipients.length !== 1 ||
            command.lane !== 'interactive' || command.priority !== -100 ||
            command.idempotency_key !== `gate:${String(recipient?.tenant_id)}:${String(recipient?.alias)}:${probeBody.nonce}`) {
          throw new Error('system gate probe payload is not canonical');
        }
      }
      // `gate-probe` intentionally has no membership/agent/lease and can never become a routing
      // target. Kant is only the durable actor required by the messages FK; the authenticated
      // context still preserves the exact mTLS gate authority.
      const trustedCommand: TrustedPublishCommand = {
        ...trustedPublishSemantics(actor, command, request, systemGateProbe ? 'kant' : actor.alias),
        idempotency_key: command.idempotency_key,
      };
      const receipt = validatedPublishReceipt(
        await repository.publish(trustedCommand, {
          requirePreparedConsoleIntent: consolePublish,
          ...(consolePublish
            ? { consoleIntentOperatorScope: consolePublishOperatorScope(actor) }
            : {}),
        }),
        trustedCommand,
        command.recipients.length,
      );
      if (typeof repository.verifyPublishReceipt !== 'function'
          || !(await repository.verifyPublishReceipt(trustedCommand, receipt))) {
        throw new StoreError('conflict', 'publish receipt does not match its durable effect');
      }
      if (consolePublish) {
        consolePublishTelemetry.record({ operation: 'publish', result: 'committed' });
      }
      return await reply.code(202).send(receipt);
    } catch (error) {
      if (error instanceof PublishIntentExpiredError) {
        if (consolePublish) {
          consolePublishTelemetry.record({ operation: 'publish', result: 'expired' });
        }
        return reply.code(410).send(
          ConsolePublishIntentExpiredSchema.parse(error.expiration),
        );
      }
      if (consolePublish) consolePublishTelemetry.record({ operation: 'publish', result: 'error' });
      replyError(reply, error);
    }
  };
  app.post('/v3/messages', publishHandler);
  app.post('/v3/publish', publishHandler);

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

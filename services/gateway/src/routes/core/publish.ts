import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ConsolePublishIntentExpiredSchema, NotifyRequestSchema, QuotaSampleRequestSchema,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE, SystemGateProbeBodySchema,
} from '@cauce/protocol';
import { PublishIntentExpiredError, StoreError } from '@cauce/store';
import { AuthorizationError, requireOperatorPermission, requirePermission } from '../../auth.js';
import type { ConsolePublishTelemetry } from '../../console-publish-telemetry.js';
import type { GatewayRepository } from '../../app.js';
import {
  consolePublishOperatorScope, principal, publicPublish, replyError, trustedPublishSemantics,
  validatedPublishReceipt, type TrustedPublishCommand,
} from '../shared.js';
import type { CorePublishHandler, CoreRouteOptions } from './contracts.js';

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
        if (options.authProvider.name !== 'mtls' || actor.tenant_id !== 'Steven' ||
            actor.alias !== 'gate-probe' || actor.session_id !== 'gate-probe' ||
            actor.channel !== 'gate' || actor.origin !== undefined || !exactRole || !exactPermissions) {
          throw new AuthorizationError('system gate probe requires the exact dedicated mTLS identity');
        }
        const recipient = command.recipients[0];
        if (command.room_id !== 'grp.steven' || command.recipients.length !== 1 ||
            command.lane !== 'interactive' || command.priority !== -100 ||
            command.idempotency_key !== `gate:${recipient?.tenant_id}:${recipient?.alias}:${probeBody.nonce}`) {
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
      return reply.code(202).send(receipt);
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
        return reply.code(403).send({
          error: 'forbidden',
          message: 'proactive egress was denied by policy',
          notification_id: verdict.notification_id,
          denial_code: verdict.denial_code,
          dry_run: verdict.dry_run,
          duplicate: verdict.duplicate
        });
      }
      return reply.code(202).send(verdict);
    } catch (error) { replyError(reply, error); }
  });

  // Ingesta de muestras de cuota del recolector fuera de banda. Va fuera de /v3/console/
  // para permitir llamadas autenticadas de servicios de máquina sin cabecera Origin de navegador.
  //
  // Permiso: mismo par que POST /v3/console/jobs -- requireOperatorPermission sobre el Principal
  // (rol derivado del certificado) MÁS assertPermission contra role_policies (la fuente de verdad
  // en la base). recordQuotaSample() en sí no se autochequea, así que sin este segundo chequeo acá
  // un agente con permiso 'control' mal otorgado podría pausar suscripciones de toda la flota.
  app.post('/v3/quotas/samples', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requireOperatorPermission(actor, 'control');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'control');
      const sample = QuotaSampleRequestSchema.parse(request.body);
      const result = await repository.recordQuotaSample(actor.tenant_id, actor.alias, sample);
      return reply.code(202).send(result);
    } catch (error) { replyError(reply, error); }
  });

  // Selección de cuenta del PROPIO alias (el sistema rotativo de cuentas). Vive fuera de
  // /v3/console/ por la misma razón que /v3/quotas/samples: la llama un adaptador con certificado
  // de cliente, y createConsoleSecurityHook rechaza todo lo que no traiga un Origin same-origin,
  // que un demonio jamás manda.
  //
  // El sujeto NO es un parámetro: sale del certificado. Un alias resuelve su propia cuenta y
  // ninguna otra, así que el permiso que hace falta es 'route' (el que ya tiene todo adaptador
  // que despacha) y no 'control'. Pedir 'control' acá habría obligado a darle a cada agente el
  // mismo permiso que pausa suscripciones de toda la flota, que es justo lo contrario de lo que
  // esta ruta necesita.
  app.get('/v3/accounts/selection', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      await repository.assertPermission(actor.tenant_id, actor.alias, 'route');
      const provider = (request.query as { provider?: unknown } | undefined)?.provider;
      if (typeof provider !== 'string') {
        return reply.code(400).send({ error: 'invalid_input', message: 'provider query parameter is required' });
      }
      return await repository.selectAccount(actor.tenant_id, actor.alias, provider);
    } catch (error) { replyError(reply, error); }
  });
  return publishHandler;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { DeliveryIdSchema, HeartbeatSchema, HelloSchema, QueryDeliveriesSchema } from '@cauce/protocol';
import { StoreError } from '@cauce/store';
import { requirePermission, validatePrincipal } from '../../auth.js';
import { visibleMessage } from '../../facades.js';
import type { GatewayRepository } from '../../app.js';
import { principal, replyError } from '../shared.js';
import type { CoreResolvedOptions, CoreRouteOptions, Session } from './contracts.js';
import {
  RELEASES_CAPACITY, connectionToken, normalizeDeliveryClaim, parseAck,
  parseConnectionBoundBody, sessionKey,
} from './helpers.js';

export function registerCoreRuntimeHttpRoutes(
  app: FastifyInstance,
  options: CoreRouteOptions,
  repository: GatewayRepository,
  resolved: CoreResolvedOptions,
  sessions: Map<string, Session>,
  drain: (session: Session) => Promise<boolean>,
): void {
  const { ackDeadlineMs, deliveryLeaseCap, admission, maxQueryLimit, leaseTtlMs } = resolved;

  app.get<{ Params: { messageId: string } }>('/v3/messages/:messageId', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'read');
      const row = visibleMessage(await repository.getMessage(request.params.messageId, actor.tenant_id, actor.alias), actor);
      if (!row) throw new StoreError('not_found', 'message not found or not visible');
      return row;
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post('/v3/connections/hello', async (request, reply) => {
    try {
      const hello = HelloSchema.parse(request.body);
      const actor = validatePrincipal(await options.authProvider.authenticateHello(request, hello));
      requirePermission(actor, 'route');
      if (actor.tenant_id !== hello.tenant_id || actor.alias !== hello.alias) {
        throw new StoreError('forbidden', 'authenticated identity does not match hello');
      }
      const lease = await repository.acquireLease(
        hello.tenant_id, hello.alias, hello.instance_id, hello.capabilities, leaseTtlMs,
        { requireDeclaredCapacity: true, requireEnabledAgent: true },
      );
      if (!lease.acquired) return reply.code(409).send(lease);
      if (!lease.epoch) throw new StoreError('conflict', 'lease acquisition returned no epoch');
      const leaseConnectionToken = connectionToken(lease.connection_token);
      return reply.code(200).send({
        ...lease,
        connection_token: leaseConnectionToken,
      });
    } catch (error) {
      replyError(reply, error);
    }
  });

  /**
   * Reclamo por HTTP. Es el otro punto por donde se puede vaciar la cola de un agente. El cliente
   * sólo elige un máximo de lote: las capacidades general y humana viajan por separado y el store
   * descuenta bajo lock todas las garras vivas del alias. Así dos polls, un socket y otro gateway
   * comparten el mismo presupuesto aunque este endpoint sea sin estado.
   */
  const queryHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const query = parseConnectionBoundBody(
        request.body,
        (value) => QueryDeliveriesSchema.parse(value),
      );
      const requested = Math.min(query.limit, maxQueryLimit);
      const deliveries = (await repository.claimDeliveries(
        actor.tenant_id, actor.alias, query.instance_id, query.epoch,
        requested, ackDeadlineMs, undefined, {
          generalCapacity: admission.maxInflightDeliveries,
          humanReservedCapacity: admission.humanReservedDeliveries,
          maxClaims: requested,
          requireDeclaredCapacity: true,
        }, query.connection_token
      )).map((delivery) => normalizeDeliveryClaim(delivery, ackDeadlineMs));
      return {
        deliveries
      };
    } catch (error) {
      replyError(reply, error);
    }
  };
  app.post('/v3/deliveries/query', queryHandler);
  app.post('/v3/query', queryHandler);

  app.post('/v3/heartbeat', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const heartbeat = parseConnectionBoundBody(
        request.body,
        (value) => HeartbeatSchema.parse(value),
      );
      const leaseExpiresAt = await repository.heartbeat(
        actor.tenant_id, actor.alias, heartbeat.instance_id, heartbeat.epoch, leaseTtlMs,
        heartbeat.connection_token,
      );
      return { lease_expires_at: leaseExpiresAt };
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post<{ Params: { deliveryId: string } }>('/v3/deliveries/:deliveryId/ack', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      const ack = parseAck(request.body);
      const result = await repository.ackDelivery(
        request.params.deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs,
        deliveryLeaseCap
      );
      return { ...result, event_id: ack.event_id, attempt: ack.attempt, claim_token: ack.claim_token };
    } catch (error) {
      replyError(reply, error);
    }
  });

  app.post('/v3/ack', async (request, reply) => {
    try {
      const actor = await principal(request, options.authProvider);
      requirePermission(actor, 'route');
      if (request.body === null || typeof request.body !== 'object' || Array.isArray(request.body)) {
        throw new Error('ACK must be an object');
      }
      const { delivery_id: deliveryValue, ...ackValue } = request.body as Record<string, unknown>;
      const deliveryId = DeliveryIdSchema.parse(deliveryValue);
      const ack = parseAck(ackValue);
      const result = await repository.ackDelivery(
        deliveryId, actor.tenant_id, actor.alias, ack, ackDeadlineMs, deliveryLeaseCap
      );
      // Un ACK por HTTP libera capacidad igual que uno por WebSocket. Si el mismo alias tiene un
      // socket vivo, hay que despertarlo: si no, la capacidad que este ACK liberó queda sin usar
      // hasta el próximo mensaje publicado. No se espera el drenaje para no atar la respuesta HTTP
      // a una ronda de reclamo.
      if (RELEASES_CAPACITY.has(result.status)) {
        const active = sessions.get(sessionKey(actor.tenant_id, actor.alias));
        if (active) void drain(active).catch((error: unknown) => app.log.error(error));
      }
      return { ...result, event_id: ack.event_id, attempt: ack.attempt, claim_token: ack.claim_token };
    } catch (error) {
      replyError(reply, error);
    }
  });
}

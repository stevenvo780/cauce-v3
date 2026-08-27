import type { FastifyInstance } from 'fastify';
import { WebSocket, type RawData } from 'ws';
import { DeliveryIdSchema, HeartbeatSchema, HelloSchema, type Hello, type Tenant } from '@cauce/protocol';
import { StoreError, type AckResult, type AgentProfileRepository, type LeaseResult } from '@cauce/store';
import { requirePermission, validatePrincipal } from '../auth.js';
import type { GatewayRepository } from '../app.js';
import { registerCoreRuntimeHttpRoutes } from './core/http.js';
import { createCoreOutboxRuntime } from './core/outbox.js';
import { registerCorePublishRoutes } from './core/publish.js';
import type {
  CorePublishHandler, CoreResolvedOptions, CoreRouteOptions, CoreRoutePhases, Session, SessionClaim,
} from './core/contracts.js';
import {
  MAX_DRAIN_ROUNDS, MAX_REHYDRATED_CLAIMS, assertAckClaim, claimFromDelivery, connectionToken,
  normalizeDeliveryClaim, parseAck, pruneExpiredClaims, rawDataText, rememberRecentClaim, send, sessionKey,
} from './core/helpers.js';

export type { CorePublishHandler, CoreRoutePhases } from './core/contracts.js';

export function createCoreRoutePhases(
  app: FastifyInstance,
  options: CoreRouteOptions,
  repository: GatewayRepository,
  resolved: CoreResolvedOptions,
): CoreRoutePhases {
  const {
    ackDeadlineMs, deliveryLeaseCap, admission, maxQueryLimit, leaseTtlMs,
    deliveryClaimLimit,
  } = resolved;

  const sessions = new Map<string, Session>();
  // A successful lease acquisition starts one local hello admission. Rehydration contains I/O,
  // so an older hello can finish after a newer resume rotated the durable connection token. The
  // opaque marker lets only the most recently acquired hello install/replace the local session.
  const helloAdmissions = new Map<string, object>();
  const pendingDrains = new Set<Promise<boolean>>();
  const pendingSessionTasks = new Set<Promise<unknown>>();

  function registerPublishRoutes(): CorePublishHandler {
    return registerCorePublishRoutes(
      app, options, repository, resolved.consolePublishTelemetry,
    );
  }

  /**
   * Reconstruye el cupo ocupado de un alias desde la base, al conectar.
   *
   * Sin esto el control de admisión vivía sólo en la RAM del socket y una reconexión lo
   * multiplicaba: `hello` creaba `claims: new Map()` y el adaptador volvía a tener el
   * presupuesto entero. Con `renewable_delivery_claims_v1` es peor todavía, porque esa
   * capacidad existe justamente para CONSERVAR el lease y la época entre reconexiones: las
   * garras viejas siguen vivas en la base y el gateway las olvidaba.
   *
   * Falla cerrado. La consulta es parte del fence de reconexión: inventar un mapa vacío ante un
   * error permite multiplicar claims y pierde correlación de ACK. El llamador libera el lease que
   * acaba de adquirir antes de rechazar el hello, para que el siguiente intento no quede bloqueado.
   */
  async function rehydrateClaims(tenantId: Tenant, alias: string): Promise<Map<string, SessionClaim>> {
    const claims = new Map<string, SessionClaim>();
    if (repository.liveDeliveryClaims === undefined) return claims;
    const live = await repository.liveDeliveryClaims(tenantId, alias, MAX_REHYDRATED_CLAIMS);
    for (const claim of live) {
      const deadlineMs = Date.parse(claim.ack_deadline_at);
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) continue;
      claims.set(claim.delivery_id, {
        attempt: claim.attempt,
        claim_token: claim.claim_token,
        admissionExpiresAtMs: deadlineMs,
        rehydrated: true
      });
    }
    return claims;
  }

  /**
   * Drena entregas pendientes hacia la sesión respetando los límites de admisión configurados.
   * Gestiona el redrenaje ante nuevos wakes, liberaciones de cuota por ACK y expiración de plazos.
   */
  function drain(session: Session): Promise<boolean> {
    if (session.abort.signal.aborted || session.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    if (session.drainPromise !== undefined) {
      session.drainAgain = true;
      return session.drainPromise;
    }
    // El salto de microtarea garantiza que `drainPromise` quede publicado antes de que una rama
    // sin I/O (por ejemplo cupo cero) llegue al `finally` y permita otro drenaje concurrente.
    const operation = Promise.resolve()
      .then(async () => drainExclusively(session))
      .finally(() => {
        if (session.drainPromise === operation) session.drainPromise = undefined;
      });
    session.drainPromise = operation;
    pendingDrains.add(operation);
    void operation.then(
      () => pendingDrains.delete(operation),
      () => pendingDrains.delete(operation),
    );
    return operation;
  }

  async function drainExclusively(session: Session): Promise<boolean> {
    try {
      // El tope existe sólo contra las vueltas IMPRODUCTIVAS: las productivas ya están
      // acotadas por el cupo, que baja con cada garra tomada. Sin tope, dos gateways contra la
      // misma cola podrían pasarse wakes de entregas que el otro ya se llevó y girar en vacío.
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        if (session.abort.signal.aborted) return false;
        session.drainAgain = false;
        pruneExpiredClaims(session, Date.now());
        // `deliveryClaimLimit` es sólo el techo explícito de lote. Las capacidades durables
        // viajan separadas y PostgreSQL descuenta los claims vivos de todo el alias; la RAM de
        // esta sesión ya no decide cuánto se puede reclamar.
        const requested = Math.min(deliveryClaimLimit, maxQueryLimit);
        const deliveries = (await repository.claimDeliveries(
          session.tenantId, session.alias, session.instanceId, session.epoch,
          requested, ackDeadlineMs, undefined,
          {
            generalCapacity: admission.maxInflightDeliveries,
            humanReservedCapacity: admission.humanReservedDeliveries,
            maxClaims: requested,
            requireDeclaredCapacity: true,
          },
          session.connectionToken,
          session.abort.signal,
        )).map((delivery) => normalizeDeliveryClaim(delivery, ackDeadlineMs));
        if (session.abort.signal.aborted
            || sessions.get(sessionKey(session.tenantId, session.alias)) !== session
            || session.socket.readyState !== WebSocket.OPEN) return false;
        let allFramesQueued = true;
        for (const delivery of deliveries) {
          const claim = claimFromDelivery(delivery, ackDeadlineMs);
          session.recentClaims.delete(delivery.delivery_id);
          session.claims.set(delivery.delivery_id, claim);
          allFramesQueued = send(session.socket, delivery) && allFramesQueued;
        }
        // El store ya otorgó estas garras. Si el socket cayó mientras esperaba el claim, el wake
        // no puede declararse entregado: la reconexión lo volverá a reclamar selectivamente y el
        // lease de la entrega seguirá su recuperación normal.
        if (!allFramesQueued) return false;
        if (!session.drainAgain) return true;
      }
      return true;
    } catch (error) {
      if (session.abort.signal.aborted) return false;
      if (error instanceof StoreError && error.code === 'fenced') {
        send(session.socket, { type: 'error', code: 'fenced', message: error.message });
        session.socket.close(4401, 'fenced');
      } else if (error instanceof StoreError && error.code === 'conflict'
          && error.message === 'delivery consumer is missing its durable agent capacity') {
        send(session.socket, {
          type: 'error', code: 'consumer_not_declared',
          message: 'consumer has no durable delivery capacity declaration',
        });
        session.socket.close(4403, 'consumer not declared');
      } else {
        app.log.error(error);
        send(session.socket, {
          type: 'error', code: 'delivery_unavailable',
          message: 'durable delivery admission is unavailable',
        });
        session.socket.close(1011, 'delivery unavailable');
      }
      return false;
    } finally {
      scheduleExpiryDrain(session);
    }
  }

  /**
   * Vuelve a drenar cuando venza la primera garra viva. Es la red de seguridad del punto 3 de
   * `drain()`: sin esto, una garra que se libera por vencimiento —y no por ACK ni por wake—
   * deja al adaptador conectado, con cupo y sin trabajo, que es indistinguible de un adaptador
   * roto. Uno solo por sesión, se reprograma en cada drenaje y se cancela al cerrar el socket.
   */
  function scheduleExpiryDrain(session: Session): void {
    if (session.expiryTimer !== undefined) clearTimeout(session.expiryTimer);
    session.expiryTimer = undefined;
    if (session.abort.signal.aborted
        || session.socket.readyState !== WebSocket.OPEN || session.claims.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const claim of session.claims.values()) {
      earliest = Math.min(earliest, claim.admissionExpiresAtMs);
    }
    if (!Number.isFinite(earliest)) return;
    // El piso de 1 s evita que un reloj corrido convierta esto en un bucle de drenajes.
    const delayMs = Math.max(1_000, earliest - Date.now() + 1_000);
    const timer = setTimeout(() => {
      session.expiryTimer = undefined;
      void drain(session);
    }, delayMs);
    timer.unref();
    session.expiryTimer = timer;
  }

  const outboxRuntime = createCoreOutboxRuntime(
    app, options, repository, resolved, sessions, pendingDrains, pendingSessionTasks, drain,
  );
  const { pumpOutbox } = outboxRuntime;

  async function registerRuntimeRoutes(
    agentProfiles: AgentProfileRepository,
  ): Promise<void> {
    registerCoreRuntimeHttpRoutes(app, options, repository, resolved, sessions, drain);

    app.get('/v3/ws', { websocket: true }, (socket, request) => {
      let current: Session | undefined;
      let frameQueue = Promise.resolve();
      let closed = false;

      socket.on('message', (data: RawData) => {
        const text = rawDataText(data);
        frameQueue = frameQueue.then(async () => {
          if (closed) return;
          try {
            const decoded: unknown = JSON.parse(text);
            if (!current) {
              const hello: Hello = HelloSchema.parse(decoded);
              const actor = validatePrincipal(await options.authProvider.authenticateHello(request, hello));
              requirePermission(actor, 'route');
              if (actor.tenant_id !== hello.tenant_id || actor.alias !== hello.alias) {
                throw new StoreError('forbidden', 'authenticated identity does not match hello');
              }
              const renewableDeliveryClaims = hello.capabilities.includes('renewable_delivery_claims_v1');
              const delegationFeedback = hello.capabilities.includes('delegation_feedback_v1');
              let lease: LeaseResult;
              try {
                lease = await repository.acquireLease(
                  hello.tenant_id,
                  hello.alias,
                  hello.instance_id,
                  hello.capabilities,
                  leaseTtlMs,
                  renewableDeliveryClaims
                    ? {
                        resume: true,
                        resumeWindowMs: ackDeadlineMs,
                        requireDeclaredCapacity: true,
                      }
                    : { requireDeclaredCapacity: true }
                );
              } catch (error) {
                if (error instanceof StoreError && error.code === 'conflict'
                    && (error.message === 'delivery consumer is missing its durable agent capacity'
                      || error.message === 'delivery consumer capacity is invalid')) {
                  send(socket, {
                    type: 'error', code: 'consumer_not_declared',
                    message: 'consumer has no valid durable delivery capacity declaration',
                  });
                  socket.close(4403, 'consumer not declared');
                  return;
                }
                throw error;
              }
              if (!lease.acquired || !lease.epoch) {
                send(socket, {
                  type: 'takeover_rejected',
                  reason: 'another live instance owns this consumer',
                  active_instance_id: lease.active_instance_id ?? 'unknown',
                  lease_expires_at: lease.lease_expires_at
                });
                socket.close(4409, 'live consumer exists');
                return;
              }
              const leaseConnectionToken = connectionToken(lease.connection_token);
              const releaseHelloLease = async (event: string): Promise<void> => {
                if (renewableDeliveryClaims) return;
                try {
                  await repository.releaseLease(
                    hello.tenant_id,
                    hello.alias,
                    hello.instance_id,
                    lease.epoch!,
                    leaseConnectionToken,
                  );
                } catch {
                  app.log.error({ event, tenant_id: hello.tenant_id, alias: hello.alias });
                }
              };
              try {
                await repository.heartbeat(
                  hello.tenant_id,
                  hello.alias,
                  hello.instance_id,
                  lease.epoch,
                  leaseTtlMs,
                  leaseConnectionToken,
                );
              } catch (error) {
                await releaseHelloLease('initial_hello_fence_release_failed');
                if (error instanceof StoreError && error.code === 'fenced') {
                  send(socket, {
                    type: 'error', code: 'fenced',
                    message: 'a newer hello owns this consumer connection',
                  });
                  socket.close(4401, 'superseded during hello');
                } else {
                  app.log.error(error);
                  send(socket, {
                    type: 'error', code: 'delivery_unavailable',
                    message: 'durable delivery admission is unavailable',
                  });
                  socket.close(1011, 'delivery unavailable');
                }
                return;
              }
              const key = sessionKey(hello.tenant_id, hello.alias);
              const helloAdmission = {};
              helloAdmissions.set(key, helloAdmission);
              const rejectInactiveHello = async (): Promise<boolean> => {
                const ownsAdmission = helloAdmissions.get(key) === helloAdmission;
                if (!closed && socket.readyState === WebSocket.OPEN && ownsAdmission) return false;
                if (ownsAdmission) helloAdmissions.delete(key);
                await releaseHelloLease(closed || socket.readyState !== WebSocket.OPEN
                  ? 'closed_hello_release_failed'
                  : 'superseded_hello_release_failed');
                if (!closed && socket.readyState === WebSocket.OPEN) {
                  send(socket, {
                    type: 'error', code: 'fenced',
                    message: 'a newer hello owns this consumer connection',
                  });
                  socket.close(4401, 'superseded during hello');
                }
                return true;
              };
              let recoveredClaims: Map<string, SessionClaim>;
              try {
                recoveredClaims = await rehydrateClaims(hello.tenant_id, hello.alias);
              } catch (error) {
                if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
                await releaseHelloLease('delivery_claim_recovery_release_failed');
                app.log.error(error);
                send(socket, {
                  type: 'error', code: 'delivery_unavailable',
                  message: 'durable delivery claim recovery is unavailable',
                });
                socket.close(1011, 'delivery unavailable');
                return;
              }
              if (await rejectInactiveHello()) return;
              /*
               * EL PERFIL VIAJA EN EL SALUDO, UNA VEZ.
               *
               * La configuración fija reside en el fichero del arnés. Viaja en el saludo inicial
               * para permitir que el adaptador mantenga su contexto sin sobrecargar cada entrega.
               *
               * Gateado tras la capability `agent_profile_v1` para compatibilidad hacia atrás.
               *
               * Un fallo leyendo el perfil NO tumba el saludo. El alias queda conectado y recibiendo
               * entregas con el sobre completo, que es el comportamiento de siempre; lo que se pierde
               * es el recorte. Al revés —negar la conexión porque no se pudo componer un fichero—
               * dejaría a un alias sordo por un problema de presentación.
               */
              let agentProfile: { perfil: unknown; hechos: unknown } | undefined;
              if (hello.capabilities.includes('agent_profile_v1')) {
                try {
                  const contexto = await agentProfiles.readContext(hello.tenant_id, hello.alias);
                  agentProfile = { perfil: contexto.perfil, hechos: contexto.hechos };
                } catch {
                  agentProfile = undefined;
                }
              }
              if (await rejectInactiveHello()) return;
              let confirmedLeaseExpiresAt: string;
              try {
                confirmedLeaseExpiresAt = await repository.heartbeat(
                  hello.tenant_id,
                  hello.alias,
                  hello.instance_id,
                  lease.epoch,
                  leaseTtlMs,
                  leaseConnectionToken,
                );
              } catch (error) {
                if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
                await releaseHelloLease('hello_fence_release_failed');
                if (error instanceof StoreError && error.code === 'fenced') {
                  send(socket, {
                    type: 'error', code: 'fenced',
                    message: 'a newer hello owns this consumer connection',
                  });
                  socket.close(4401, 'superseded during hello');
                } else {
                  app.log.error(error);
                  send(socket, {
                    type: 'error', code: 'delivery_unavailable',
                    message: 'durable delivery admission is unavailable',
                  });
                  socket.close(1011, 'delivery unavailable');
                }
                return;
              }
              if (closed || socket.readyState !== WebSocket.OPEN
                  || helloAdmissions.get(key) !== helloAdmission) {
                await rejectInactiveHello();
                return;
              }
              const previous = sessions.get(key);
              current = {
                socket, tenantId: hello.tenant_id, alias: hello.alias,
                instanceId: hello.instance_id,
                epoch: lease.epoch,
                connectionToken: leaseConnectionToken,
                abort: new AbortController(),
                drainAgain: false,
                drainPromise: undefined,
                renewableDeliveryClaims,
                delegationFeedback,
                // El cupo NO arranca vacío: se reconstruye desde la base. Ver `rehydrateClaims`.
                claims: recoveredClaims,
                recentClaims: new Map(),
                expiryTimer: undefined
              };
              sessions.set(key, current);
              if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
              if (previous && previous.socket !== socket) {
                previous.abort.abort(new Error('connection superseded by a newer hello'));
                previous.socket.close(4401, 'superseded by newer connection');
              }
              send(socket, {
                type: 'hello_ack', version: '3.0', epoch: lease.epoch,
                lease_expires_at: confirmedLeaseExpiresAt,
                ...(agentProfile === undefined ? {} : { agent_profile: agentProfile })
              });
              const initialDrainReady = await drain(current);
              if (!initialDrainReady || socket.readyState !== WebSocket.OPEN) return;
              // El hello es también la señal durable de que este destinatario volvió. No hace falta
              // esperar al siguiente tick para recoger los wakes que permanecieron intactos offline.
              void pumpOutbox().catch((error: unknown) => app.log.error(error));
              return;
            }

            if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
              throw new Error('frame must be an object');
            }
            const frame = decoded as Record<string, unknown>;
            if (frame.type === 'hello') throw new Error('hello already completed');
            if (frame.type === 'heartbeat') {
              const heartbeat = HeartbeatSchema.parse(decoded);
              if (heartbeat.instance_id !== current.instanceId || heartbeat.epoch !== current.epoch) {
                throw new StoreError('fenced', 'heartbeat identity does not match socket lease');
              }
              const leaseExpiresAt = await repository.heartbeat(
                current.tenantId, current.alias, current.instanceId, current.epoch, leaseTtlMs,
                current.connectionToken,
                current.abort.signal,
              );
              send(socket, { type: 'heartbeat_ack', lease_expires_at: leaseExpiresAt });
              return;
            }
            if (frame.type !== 'ack') throw new Error('unsupported frame type');
            const deliveryId = DeliveryIdSchema.parse(frame.delivery_id);
            const ackValue = Object.fromEntries(
              Object.entries(frame).filter(([key]) => key !== 'type' && key !== 'delivery_id')
            );
            const incoming = parseAck(ackValue);
            if (incoming.instance_id !== current.instanceId) {
              throw new StoreError('fenced', 'ACK identity does not match socket lease');
            }
            const staleTerminalReplay = incoming.epoch < current.epoch
              && (incoming.status === 'done' || incoming.status === 'failed');
            if (incoming.epoch < current.epoch && !staleTerminalReplay) {
              send(socket, {
                type: 'ack_result',
                event_id: incoming.event_id,
                delivery_id: deliveryId,
                attempt: incoming.attempt,
                claim_token: incoming.claim_token,
                status: incoming.status,
                applied: false
              });
              return;
            }
            if (incoming.epoch > current.epoch) {
              throw new StoreError('fenced', 'ACK identity does not match socket lease');
            }
            // El orden importa. `claims` tiene la garra VIVA; `recentClaims`, la anterior. Cuando
            // el reaper reintentó una entrega y el mismo adaptador se la volvió a llevar, la viva
            // es la del intento nuevo — y el ACK terminal del intento viejo, que llega tarde con
            // la respuesta adentro, no coincide con ella. `assertAckClaim` lo convertía en un
            // 'fenced' con cierre de socket 4401: el resultado no llegaba siquiera a la base, que
            // es quien sabe decidir si sirve (ver `lateTerminalSalvage`). Si el ACK correlaciona
            // EXACTO con una garra que este mismo socket recuerda haber entregado, se usa ésa y se
            // deja que decida el store. Cuando no correlaciona con ninguna, no cambia nada.
            const liveClaim = current.claims.get(deliveryId);
            const recentClaim = current.recentClaims.get(deliveryId);
            const matchesRecent = recentClaim !== undefined
              && recentClaim.attempt === incoming.attempt
              && recentClaim.claim_token === incoming.claim_token;
            const sessionClaim = matchesRecent ? recentClaim : (liveClaim ?? recentClaim);
            // Una garra rehidratada cuenta para el cupo pero NO fencea: la reconstruimos de la
            // base sin saber si el adaptador la conoce con ese mismo intento, así que exigirle
            // que coincida convertiría un ACK viejo en un cierre de socket 4401 donde antes había
            // un `ownership_lost` recuperable.
            if (!staleTerminalReplay && sessionClaim !== undefined && sessionClaim.rehydrated !== true) {
              assertAckClaim(incoming, sessionClaim);
            } else if (!staleTerminalReplay && sessionClaim === undefined && !current.renewableDeliveryClaims) {
              throw new StoreError('fenced', 'ACK has no claim in the live socket session');
            }
            // A renewable client can resume the same fenced DB lease after a
            // socket or gateway restart. In that case the in-memory claim map is
            // intentionally empty; repository.ackDelivery remains authoritative
            // for delivery id, attempt, token, instance, epoch and deadline.
            let result: AckResult;
            try {
              result = await repository.ackDelivery(
                deliveryId, current.tenantId, current.alias, incoming, ackDeadlineMs,
                deliveryLeaseCap
              );
            } catch (error) {
              // El evento terminal viejo sí llegó a la autoridad durable. Si no era un duplicado
              // exacto, el store puede fencearlo contra la garra nueva: para este frame eso es una
              // prueba concluyente de ownership_lost, no razón para cerrar el socket de época N+1.
              if (!staleTerminalReplay || !(error instanceof StoreError) || error.code !== 'fenced') throw error;
              result = {
                delivery_id: deliveryId,
                status: incoming.status,
                applied: false,
                receipt: 'ownership_lost',
              };
            }
            // `legacyResult` sólo contiene campos que cualquier adaptador entiende.
            // Cada campo nuevo se reintroduce únicamente tras su capability.
            const {
              receipt,
              delegation_rejections: delegationRejections,
              delegation_materializations: delegationMaterializations,
              chain_gate: chainGate,
              ...legacyResult
            } = result;
            const feedback = current.delegationFeedback;
            send(socket, {
              type: 'ack_result',
              ...legacyResult,
              event_id: incoming.event_id,
              attempt: incoming.attempt,
              claim_token: incoming.claim_token,
              ...(current.renewableDeliveryClaims ? { receipt } : {}),
              ...(feedback && delegationRejections !== undefined
                ? { delegation_rejections: delegationRejections }
                : {}),
              ...(feedback && delegationMaterializations !== undefined
                ? { delegation_materializations: delegationMaterializations }
                : {}),
              ...(feedback && chainGate !== undefined ? { chain_gate: chainGate } : {})
            });
            // Un `started` aplicado renueva el plazo local como en la base.
            // `Math.max` impide que un ACK tardío acorte la garra.
            if (result.applied && incoming.status === 'started') {
              const renewed = current.claims.get(deliveryId);
              if (renewed !== undefined) {
                renewed.admissionExpiresAtMs = Math.max(
                  renewed.admissionExpiresAtMs, Date.now() + ackDeadlineMs
                );
              }
            }
            // Los estados terminales y `retry` liberan el cupo porque ya no conservan una garra durable.
            // `leased`, `accepted` y `started` no lo liberan; hacerlo admitiría trabajo todavía en curso.
            // El vencimiento retira cualquier garra que haya dejado de pertenecernos.
            let releasedSlot = false;
            if (['done', 'failed', 'dead', 'retry'].includes(result.status)) {
              const completedClaim = current.claims.get(deliveryId);
              const closesCurrentClaim = completedClaim !== undefined
                && completedClaim.attempt === incoming.attempt
                && completedClaim.claim_token === incoming.claim_token;
              releasedSlot = closesCurrentClaim && current.claims.delete(deliveryId);
              // No se borra: se mueve a `recentClaims`. Un ACK tardío de esta misma entrega tiene
              // que seguir correlacionando, o un cliente viejo se come un 'fenced' con cierre de
              // socket donde hoy recibe un `ownership_lost` y sigue vivo.
              if (releasedSlot && completedClaim !== undefined) {
                rememberRecentClaim(current, deliveryId, completedClaim);
              }
            }
            // Cada cupo liberado redrena de inmediato: una entrega ya encolada no genera otro wake.
            // `retry` también fuerza el drenaje aunque no cierre la garra local correlacionada.
            if (releasedSlot || result.status === 'retry') await drain(current);
          } catch (error) {
            const code = error instanceof StoreError ? error.code : 'invalid_frame';
            send(socket, { type: 'error', code, message: error instanceof Error ? error.message : 'unknown frame error' });
            if (code === 'fenced') socket.close(4401, 'fenced');
          }
        }).catch((error: unknown) => app.log.error(error));
      });

      socket.on('close', () => {
        closed = true;
        const closing = current;
        if (!closing) return;
        closing.abort.abort(new Error('consumer connection closed'));
        if (closing.expiryTimer !== undefined) clearTimeout(closing.expiryTimer);
        closing.expiryTimer = undefined;
        const key = sessionKey(closing.tenantId, closing.alias);
        if (sessions.get(key)?.socket === socket) sessions.delete(key);
        // Keep the DB lease and epoch until heartbeat expiry. The same stable
        // instance can resume it within the delivery claim window, so a transient
        // socket or gateway restart does not abort a multi-hour harness.
        if (!closing.renewableDeliveryClaims) {
          const pendingFrames = frameQueue;
          const releaseTask = pendingFrames.finally(async () => {
            await repository.releaseLease(
              closing.tenantId,
              closing.alias,
              closing.instanceId,
              closing.epoch,
              closing.connectionToken,
            );
          });
          pendingSessionTasks.add(releaseTask);
          void releaseTask.then(
            () => pendingSessionTasks.delete(releaseTask),
            (error: unknown) => {
              pendingSessionTasks.delete(releaseTask);
              app.log.error(error);
            },
          );
        }
      });
    });

    await outboxRuntime.start();
  }

  return {
    registerPublishRoutes,
    registerRuntimeRoutes,
  };
}

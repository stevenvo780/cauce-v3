import type { FastifyInstance } from 'fastify'; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import { WebSocket, type RawData } from 'ws';
import {
  DeliveryIdSchema, HeartbeatSchema, HelloSchema, PROTOCOL_VERSION, isSignalAborted,
  type ContextoDeAlias, type Hello, type Tenant,
} from '@cauce/protocol';
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
  isSocketOpen, normalizeDeliveryClaim, parseAck, pruneExpiredClaims, rawDataText, rememberRecentClaim,
  send, sessionKey,
} from './core/helpers.js';

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
  // A successful lease acquisition starts one local hello admission. Rehydration contains I/O, so an older hello can finish after a
  // newer resume rotated the durable connection token. The opaque marker lets only the most recently acquired hello install/replace the local session.
  const helloAdmissions = new Map<string, object>();
  const pendingDrains = new Set<Promise<boolean>>();
  const pendingSessionTasks = new Set<Promise<unknown>>();

  function registerPublishRoutes(): CorePublishHandler {
    return registerCorePublishRoutes(
      app, options, repository, resolved.consolePublishTelemetry,
    );
  }

  /**
   * Rebuilds the occupied capacity of an alias from the database on connect.
   *
   * Without this the admission control lived only in the socket's RAM and a reconnection multiplied it:
   * `hello` created `claims: new Map()` and the adapter had its full budget again. With `renewable_delivery_claims_v1`
   * it is even worse, because that capability exists precisely to PRESERVE the lease and the epoch across
   * reconnections: the old claims are still alive in the database and the gateway forgot them.
   *
   * Fails closed. The query is part of the reconnect fence: inventing an empty map on error allows multiplying
   * claims and loses ACK correlation. The caller releases the lease just acquired before rejecting the hello,
   * so the next attempt is not blocked.
   */
  async function rehydrateClaims(tenantId: Tenant, alias: string): Promise<Map<string, SessionClaim>> {
    const claims = new Map<string, SessionClaim>();
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
   * Drains pending deliveries to the session respecting the configured admission limits.
   * Handles re-draining on new wakes, capacity releases from ACKs and deadline expirations.
   */
  function drain(session: Session): Promise<boolean> {
    if (session.abort.signal.aborted || session.socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }
    if (session.drainPromise !== undefined) {
      session.drainAgain = true;
      return session.drainPromise;
    }
    // The microtask hop guarantees that `drainPromise` is published before an I/O-free branch
    // (e.g. zero capacity) reaches `finally` and lets another concurrent drain through.
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
      // The cap only applies to unproductive rounds; productive ones consume bounded capacity.
      for (let round = 0; round < MAX_DRAIN_ROUNDS; round += 1) {
        if (session.abort.signal.aborted) return false;
        session.drainAgain = false;
        pruneExpiredClaims(session, Date.now());
        // `deliveryClaimLimit` is only the explicit batch ceiling. Durable capabilities travel
        // separately and PostgreSQL subtracts live claims for the whole alias; this session's RAM
        // no longer decides how much can be claimed.
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
        if (isSignalAborted(session.abort.signal)
            || sessions.get(sessionKey(session.tenantId, session.alias)) !== session
            || session.socket.readyState !== WebSocket.OPEN) return false;
        let allFramesQueued = true;
        for (const delivery of deliveries) {
          const claim = claimFromDelivery(delivery, ackDeadlineMs);
          // The previous attempt stays in `recentClaims`: it is what correlates its late ACK.
          session.claims.set(delivery.delivery_id, claim);
          allFramesQueued = send(session.socket, delivery) && allFramesQueued;
        }
        // A socket can drop while the store grants claims; reconnection reclaims them selectively.
        if (!allFramesQueued) return false;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Concurrent drain requests can flip this flag during the claim await.
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
   * Drains again when the first live claim expires. It is the safety net of point 3 of `drain()`:
   * without it, a claim released by expiration —and not by ACK nor by wake— leaves the adapter
   * connected, with capacity and no work, which is indistinguishable from a broken adapter. One
   * per session, rescheduled on every drain and cancelled on socket close.
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
    // The 1 s floor prevents a drifted clock from turning this into a drain loop.
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

  async function handleAckFrame(current: Session, frame: Record<string, unknown>): Promise<void> {
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
      send(current.socket, {
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
    // Order matters. `claims` holds the LIVE claim; `recentClaims`, the previous one.
    // When the reaper retried a delivery and the same adapter took it again, the live one
    // is from the new attempt — and the terminal ACK from the old attempt, which arrives
    // late with the response inside, does not match it. `assertAckClaim` used to turn that
    // into a 'fenced' with socket close 4401: the result never even reached the database,
    // which is the one that knows whether it is useful (see `lateTerminalSalvage`). If the
    // ACK correlates EXACTLY with a claim this same socket remembers delivering, that one
    // is used and the store is left to decide. When it does not correlate with any,
    // nothing changes.
    const liveClaim = current.claims.get(deliveryId);
    const recentClaim = current.recentClaims.get(deliveryId);
    const matchesRecent = recentClaim?.attempt === incoming.attempt
      && recentClaim.claim_token === incoming.claim_token;
    const sessionClaim = matchesRecent ? recentClaim : (liveClaim ?? recentClaim);
    // A rehydrated claim counts towards capacity but does NOT fence: we rebuilt it from
    // the database without knowing whether the adapter knows it under that same attempt,
    // so requiring it to match would turn an old ACK into a socket close 4401 where there
    // used to be a recoverable `ownership_lost`.
    if (!staleTerminalReplay && sessionClaim !== undefined && sessionClaim.rehydrated !== true) {
      assertAckClaim(incoming, sessionClaim);
    } else if (!staleTerminalReplay && sessionClaim === undefined
        && !current.renewableDeliveryClaims) {
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
      // The event reached the durable authority, which is the only one that decides whether
      // it still owns the delivery. A fence there is conclusive evidence of ownership_lost
      // for this frame, not a reason to close a socket whose lease is alive.
      if (!(error instanceof StoreError) || error.code !== 'fenced') throw error;
      result = {
        delivery_id: deliveryId,
        status: incoming.status,
        applied: false,
        receipt: 'ownership_lost',
      };
    }
    // `legacyResult` only contains fields any adapter understands.
    // Each new field is reintroduced only after its capability.
    const {
      receipt,
      delegation_rejections: delegationRejections,
      delegation_materializations: delegationMaterializations,
      chain_gate: chainGate,
      ...legacyResult
    } = result;
    const feedback = current.delegationFeedback;
    send(current.socket, {
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
    // An applied `started` renews the local deadline as in the database.
    // `Math.max` prevents a late ACK from shortening the claim.
    if (result.applied && incoming.status === 'started') {
      const renewed = current.claims.get(deliveryId);
      if (renewed !== undefined) {
        renewed.admissionExpiresAtMs = Math.max(
          renewed.admissionExpiresAtMs, Date.now() + ackDeadlineMs
        );
      }
    }
    // Terminal states and `retry` release capacity because they no longer hold a durable
    // claim. `leased`, `accepted` and `started` do not release it; doing so would admit work
    // still in progress. Expiration retires any claim that stopped belonging to us.
    let releasedSlot = false;
    if (['done', 'failed', 'dead', 'retry'].includes(result.status)) {
      const completedClaim = current.claims.get(deliveryId);
      const closesCurrentClaim = completedClaim?.attempt === incoming.attempt
        && completedClaim.claim_token === incoming.claim_token;
      releasedSlot = closesCurrentClaim && current.claims.delete(deliveryId);
      // Not deleted: moved to `recentClaims`. A late ACK for this same delivery must keep
      // correlating, or an old client would eat a 'fenced' with socket close where today
      // it receives an `ownership_lost` and stays alive.
      if (releasedSlot && completedClaim !== undefined) {
        rememberRecentClaim(current, deliveryId, completedClaim);
      }
    }
    // Every released capacity re-drains immediately: an already-queued delivery does not
    // generate another wake. `retry` also forces draining even if it does not close the
    // correlated local claim.
    if (releasedSlot || result.status === 'retry') await drain(current);
  }

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
                        requireEnabledAgent: true,
                      }
                    : { requireDeclaredCapacity: true, requireEnabledAgent: true }
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
                if (error instanceof StoreError && error.code === 'forbidden'
                    && error.message === 'delivery consumer is disabled') {
                  send(socket, {
                    type: 'error', code: 'consumer_disabled',
                    message: 'consumer agent is disabled and cannot establish a delivery lease',
                  });
                  socket.close(4403, 'consumer disabled');
                  return;
                }
                throw error;
              }
              const leaseEpoch = lease.epoch;
              if (!lease.acquired || !leaseEpoch) {
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
                    leaseEpoch,
                    leaseConnectionToken,
                  );
                } catch {
                  app.log.error({ event, tenant_id: hello.tenant_id, alias: hello.alias });
                }
              };
              const rejectHeartbeat = async (error: unknown, releaseEvent: string): Promise<void> => {
                await releaseHelloLease(releaseEvent);
                if (error instanceof StoreError && error.code === 'fenced') {
                  send(socket, {
                    type: 'error', code: 'fenced',
                    message: 'a newer hello owns this consumer connection',
                  });
                  socket.close(4401, 'superseded during hello');
                  return;
                }
                app.log.error(error);
                send(socket, {
                  type: 'error', code: 'delivery_unavailable',
                  message: 'durable delivery admission is unavailable',
                });
                socket.close(1011, 'delivery unavailable');
              };
              try {
                await repository.heartbeat(
                  hello.tenant_id,
                  hello.alias,
                  hello.instance_id,
                  leaseEpoch,
                  leaseTtlMs,
                  leaseConnectionToken,
                );
              } catch (error) {
                await rejectHeartbeat(error, 'initial_hello_fence_release_failed');
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
               * THE PROFILE TRAVELS IN THE HELLO, ONCE.
               *
               * The fixed configuration lives in the harness's file. It travels in the initial hello
               * to let the adapter keep its context without overloading each delivery.
               *
               * Gated behind the `agent_profile_v1` capability for backward compatibility.
               *
               * A failure reading the profile does NOT take down the hello. The alias stays connected
               * and receiving deliveries with the full envelope, which is the usual behavior; what
               * is lost is the trimming. The opposite —denying the connection because a file could
               * not be composed— would leave an alias deaf because of a presentation problem.
               */
              let agentProfile: ContextoDeAlias | undefined;
              if (hello.capabilities.includes('agent_profile_v1')) {
                try {
                  agentProfile = await agentProfiles.readContext(hello.tenant_id, hello.alias);
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
                  leaseEpoch,
                  leaseTtlMs,
                  leaseConnectionToken,
                );
              } catch (error) {
                if (helloAdmissions.get(key) === helloAdmission) helloAdmissions.delete(key);
                await rejectHeartbeat(error, 'hello_fence_release_failed');
                return;
              }
              // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Socket state can change while the heartbeat is awaited.
              if (closed || socket.readyState !== WebSocket.OPEN
                  || helloAdmissions.get(key) !== helloAdmission) {
                await rejectInactiveHello();
                return;
              }
              const previous = sessions.get(key);
              current = {
                socket, tenantId: hello.tenant_id, alias: hello.alias,
                instanceId: hello.instance_id,
                epoch: leaseEpoch,
                connectionToken: leaseConnectionToken,
                abort: new AbortController(),
                drainAgain: false,
                drainPromise: undefined,
                renewableDeliveryClaims,
                delegationFeedback,
                // Capacity does NOT start empty: it is rebuilt from the database. See `rehydrateClaims`.
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
                type: 'hello_ack', version: PROTOCOL_VERSION, epoch: leaseEpoch,
                lease_expires_at: confirmedLeaseExpiresAt,
                ...(agentProfile === undefined ? {} : { agent_profile: agentProfile })
              });
              const initialDrainReady = await drain(current);
              if (!initialDrainReady || !isSocketOpen(socket)) return;
              // Hello is the durable signal to pick up wakes that stayed intact offline.
              void pumpOutbox().catch((error: unknown) => { app.log.error(error); });
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
            await handleAckFrame(current, frame);
          } catch (error) {
            const code = error instanceof StoreError ? error.code : 'invalid_frame';
            send(socket, { type: 'error', code, message: error instanceof Error ? error.message : 'unknown frame error' });
            if (code === 'fenced') socket.close(4401, 'fenced');
          }
        }).catch((error: unknown) => { app.log.error(error); });
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

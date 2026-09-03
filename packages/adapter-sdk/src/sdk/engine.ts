import { randomUUID } from "node:crypto";
import {
  isAgentToAgentBody, isAmbiguousAckErrorCode, MAX_MESSAGE_TIMEOUT_MS, messageTimeoutMs,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE,
} from "@cauce/protocol";
import type { InboxRecord } from "./durable-store.js";
import { DurableStore } from "./durable-store.js";
import { AdapterError, StaleEpochError, asAdapterError } from "./errors.js";
import type {
  HarnessAdapter, HarnessRequestContext, HarnessSessionReservation, RuntimeProfileMeasurement,
  SessionLane,
} from "../contracts/harness.js";
import type {
  AdapterLogger,
  CancelDelivery,
  Clock,
  Delivery,
  DeliveryEvent,
  StructuredOutput,
} from "./types.js";
import { systemClock } from "./backoff.js";
import { synthesizeFaninOutput } from "./fanin-synthesizer.js";
import { validateDeliveryOutput } from "./output-parser.js";
import type {
  AdapterEngineOptions, EventPublisher, ExecutionIntentPublisher,
} from "./engine/contracts.js";
import {
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
  profileAdoptionFor,
} from "./engine/contracts.js";
import type { ExecutionBudget, HarnessSessionRequestScope } from "./engine/delivery-context.js";
import {
  executionBudgetFor,
  routingTargetsFromDelivery,
  selfRoleFromDelivery,
  sessionFromDelivery,
  timeoutFromBody,
} from "./engine/delivery-context.js";
import type { ClaimMonitor, ClaimRenewalDeps } from "./engine/claim-renewal.js";
import { startClaimRenewal } from "./engine/claim-renewal.js";
import { interruptedStartedError } from "./engine/recovery.js";
import { inlineWithoutSecrets } from "./engine/secret-guard.js";
import type { SealedSecretGateway, TurnInput, TurnInputDeps } from "./engine/turn-cleanup.js";
import { materializeTurnInput, releaseTurn } from "./engine/turn-cleanup.js";
import { runSystemGateProbe } from "./engine/system-gate-probe.js";
import { DEFAULT_MESSAGE_TIMEOUT_MS } from "./message-timeout.js";

export type {
  EventPublisher,
} from "./engine/contracts.js";
export { profileAdoptionFor } from "./engine/contracts.js";

export class AdapterEngine {
  private readonly store: DurableStore;
  private readonly harness: HarnessAdapter;
  private readonly publishEvent: EventPublisher;
  private readonly publishExecutionIntent: ExecutionIntentPublisher | undefined;
  private readonly logger: AdapterLogger;
  private readonly ownTenantId: string | undefined;
  private readonly ownRoom: string | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly claimRenewalMs: number | undefined;
  private readonly claimWatchdogMs: number | undefined;
  private readonly queueWaitTimeoutMs: number | undefined;
  private readonly sealedSecrets: TurnInputDeps["fetchSealedSecret"];
  private readonly clock: Clock;
  private readonly tasks = new Map<string, {
    readonly attempt: number;
    readonly claimToken: string;
    readonly promise: Promise<void>;
  }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly claimMonitors = new Map<string, ClaimMonitor>();
  private readonly fenced = new Set<string>();
  private readonly renewalDeps: ClaimRenewalDeps;

  constructor(options: AdapterEngineOptions) {
    this.store = options.store;
    this.harness = options.harness;
    this.publishEvent = options.publish;
    this.publishExecutionIntent = options.publishExecutionIntent;
    if (this.publishExecutionIntent === undefined && options.executionIntentMode !== "local-test-only") {
      throw new Error("Execution-intent confirmation requires a remote publisher");
    }
    this.logger = options.logger ?? (() => undefined);
    this.ownTenantId = options.ownTenantId;
    this.ownRoom = options.ownRoom;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_MESSAGE_TIMEOUT_MS;
    if (messageTimeoutMs({ timeout_ms: this.defaultTimeoutMs }) === undefined) {
      throw new RangeError(
        `defaultTimeoutMs must be between 1 and ${String(MAX_MESSAGE_TIMEOUT_MS)}`,
      );
    }
    this.claimRenewalMs = options.claimRenewalMs;
    if (this.claimRenewalMs !== undefined
      && (!Number.isSafeInteger(this.claimRenewalMs) || this.claimRenewalMs <= 0)) {
      throw new RangeError("claimRenewalMs must be a positive integer");
    }
    this.claimWatchdogMs = options.claimWatchdogMs;
    if (this.claimWatchdogMs !== undefined
      && (!Number.isSafeInteger(this.claimWatchdogMs) || this.claimWatchdogMs <= 0)) {
      throw new RangeError("claimWatchdogMs must be a positive integer");
    }
    this.queueWaitTimeoutMs = options.queueWaitTimeoutMs;
    if (this.queueWaitTimeoutMs !== undefined
      && (!Number.isSafeInteger(this.queueWaitTimeoutMs) || this.queueWaitTimeoutMs <= 0)) {
      throw new RangeError("queueWaitTimeoutMs must be a positive integer");
    }
    this.sealedSecrets = (options as AdapterEngineOptions & Partial<SealedSecretGateway>).fetchSealedSecret;
    this.clock = options.clock ?? systemClock;
    this.renewalDeps = {
      clock: this.clock,
      fenced: this.fenced,
      claimMonitors: this.claimMonitors,
      emitClaimRenewal: (record, phase) => this.emitClaimRenewal(record, phase),
    };
  }

  get epoch(): number {
    return this.store.epoch;
  }

  async activateEpoch(epoch: number): Promise<void> {
    if (epoch < this.store.epoch) throw new StaleEpochError(epoch, this.store.epoch);
    const activation = await this.store.activateEpoch(epoch);
    if (activation === "advanced") {
      for (const [deliveryId, controller] of this.controllers) {
        this.fenced.add(deliveryId);
        controller.abort(new StaleEpochError(epoch - 1, epoch));
      }
    }
  }

  handleDelivery(delivery: Delivery): Promise<void> {
    if (delivery.epoch !== this.store.epoch) return this.rejectStale(delivery);
    const active = this.tasks.get(delivery.delivery_id);
    if (active !== undefined) {
      if (delivery.attempt === active.attempt && delivery.claim_token === active.claimToken) {
        return active.promise;
      }
      if (delivery.attempt > active.attempt) {
        return active.promise.catch(() => undefined).then(() => this.handleDelivery(delivery));
      }
      return Promise.resolve();
    }
    if (delivery.body.type === SYSTEM_GATE_PROBE_MESSAGE_TYPE) {
      const execution = this.runSystemGateProbe(delivery);
      const task = execution.finally(() => {
        if (this.tasks.get(delivery.delivery_id)?.promise === task) {
          this.tasks.delete(delivery.delivery_id);
          this.fenced.delete(delivery.delivery_id);
        }
      });
      this.tasks.set(delivery.delivery_id, {
        attempt: delivery.attempt,
        claimToken: delivery.claim_token,
        promise: task,
      });
      return task;
    }
    const fanin = delivery.body.type === "agent.fanin";
    // Shared session: uses a single lane tied to the alias to synchronize the TUI.
    const compartida = process.env.CAUCE_SHARED_SESSION === "1";
    const lane: SessionLane = compartida
      ? "human"
      : (isAgentToAgentBody(delivery.body) ? "agent" : "human");
    const session: HarnessSessionRequestScope = fanin
      ? {}
      : (compartida
        ? { sessionKey: `shared:${delivery.recipient_alias}`, sessionLane: lane }
        : { ...sessionFromDelivery(delivery, this.ownTenantId), sessionLane: lane });
    const reservation = fanin ? undefined : this.harness.reserveSession(session.sessionKey, lane);

    this.logger({
      event: 'delivery_start',
      delivery_id: delivery.delivery_id,
      alias: delivery.recipient_alias,
      attempt: delivery.attempt,
      timestamp: this.clock.now().toISOString(),
    });

    const execution = this.runDelivery(delivery, session, reservation);
    const task = execution.finally(() => {
      if (this.tasks.get(delivery.delivery_id)?.promise === task) {
        this.tasks.delete(delivery.delivery_id);
        this.controllers.delete(delivery.delivery_id);
        this.claimMonitors.delete(delivery.delivery_id);
        this.fenced.delete(delivery.delivery_id);
      }
    });
    this.tasks.set(delivery.delivery_id, {
      attempt: delivery.attempt,
      claimToken: delivery.claim_token,
      promise: task,
    });
    return task;
  }

  async cancel(cancel: CancelDelivery): Promise<void> {
    if (cancel.epoch !== this.store.epoch) return;
    this.controllers.get(cancel.delivery_id)?.abort(new AdapterError("CANCELLED", "Cancelled by relay", false));
  }

  loseClaim(
    deliveryId: string,
    attempt: number,
    claimToken: string,
  ): void {
    const active = this.tasks.get(deliveryId);
    if (active?.attempt !== attempt || active.claimToken !== claimToken) return;
    this.logger({
      event: "claim_renewal_end",
      delivery_id: deliveryId,
      attempt,
      timestamp: this.clock.now().toISOString(),
      reason: "ownership_lost",
    });
    this.fenced.add(deliveryId);
    this.controllers.get(deliveryId)?.abort(new AdapterError(
      "CLAIM_OWNERSHIP_LOST",
      "Gateway rejected the delivery lease renewal; execution ownership was lost",
      false,
    ));
  }

  /**
   * Records a dropped queue heartbeat without confirming or aborting the lease.
   */
  logDroppedQueueRenewal(deliveryId: string, attempt: number): void {
    this.logger({
      event: "claim_renewal_end",
      delivery_id: deliveryId,
      attempt,
      phase: "accepted",
      timestamp: this.clock.now().toISOString(),
      reason: "queue_renewal_not_applied",
    });
  }

  confirmClaim(
    deliveryId: string,
    attempt: number,
    claimToken: string,
  ): void {
    const monitor = this.claimMonitors.get(deliveryId);
    if (monitor?.attempt !== attempt || monitor.claimToken !== claimToken) return;
    this.logger({
      event: "claim_renewal_end",
      delivery_id: deliveryId,
      attempt,
      timestamp: this.clock.now().toISOString(),
      reason: "confirmed",
    });
    monitor.confirm();
  }

  async recover(): Promise<void> {
    for (const record of this.store.pendingDeliveries()) {
      if (this.tasks.has(record.delivery_id)) continue;
      if (record.state === "started") {
        // Reconstruct and replay started phase before reporting interruption if outbox entry is missing.
        const recovered = await this.store.ensureCurrentLifecycleEvent(record);
        await this.replayPending(recovered);
        await this.finishError(recovered, interruptedStartedError(recovered));
      } else if (record.request !== undefined) {
        await this.handleDelivery(record.request);
      }
    }
  }

  stop(): void {
    for (const controller of this.controllers.values()) {
      controller.abort(new AdapterError("SHUTDOWN", "Adapter is stopping", true));
    }
  }

  private async runDelivery(
    delivery: Delivery,
    session: HarnessSessionRequestScope,
    reservation: HarnessSessionReservation | undefined,
  ): Promise<void> {
    try {
      await this.runReservedDelivery(delivery, session, reservation);
    } finally {
      reservation?.release();
    }
  }

  private async runSystemGateProbe(delivery: Delivery): Promise<void> {
    await runSystemGateProbe(delivery, {
      store: this.store,
      clock: this.clock,
      publishEvent: this.publishEvent,
      replayPending: (record) => this.replayPending(record),
      rejectStale: (stale) => this.rejectStale(stale),
    });
  }

  private async runReservedDelivery(
    delivery: Delivery,
    session: HarnessSessionRequestScope,
    reservation: HarnessSessionReservation | undefined,
  ): Promise<void> {
    const occurredAt = this.clock.now().toISOString();
    const accepted = await this.store.acceptAndEnqueue(delivery, occurredAt);
    if (accepted.acceptance === "stale" || accepted.acceptance === "blocked") return;
    if (accepted.acceptance === "duplicate") {
      await this.replayPending(accepted.record);
      if (accepted.record.state === "started") {
        await this.finishError(
          accepted.record,
          interruptedStartedError(accepted.record),
        );
        return;
      }
      if (accepted.record.state !== "accepted") return;
    } else if (accepted.event !== undefined) await this.publishLifecycleEvent(accepted.event);

    if (delivery.epoch !== this.store.epoch) {
      await this.finishError(accepted.record, new AdapterError("FENCED", "Execution lost its fencing epoch", true));
      return;
    }

    let executionBudget: ExecutionBudget;
    try {
      executionBudget = executionBudgetFor(
        delivery,
        timeoutFromBody(delivery.body, this.defaultTimeoutMs),
        this.clock.now(),
      );
    } catch (error) {
      await this.finishError(accepted.record, asAdapterError(error));
      return;
    }

    const controller = new AbortController();
    this.controllers.set(delivery.delivery_id, controller);

    // Waits to acquire the session lock before transitioning to 'started'.
    if (reservation !== undefined) {
      const acquired = await this.awaitSessionTurn(
        accepted.record,
        reservation,
        executionBudget,
        controller,
      );
      if (!acquired) return;
    }

    const messageType = typeof delivery.body.type === "string"
      ? delivery.body.type
      : "request";
    const rawRequestContext: HarnessRequestContext = {
      self_alias: delivery.recipient_alias,
      sender_alias: delivery.actor_alias,
      tenant_id: this.ownTenantId ?? delivery.tenant_id,
      room_id: this.ownRoom ?? delivery.room_id,
      channel: delivery.authenticated_context?.channel
        ?? delivery.origin?.channel
        ?? "cauce",
      agent_message: messageType === "agent.message"
        || messageType === "agent.response"
        || messageType === "agent.fanin",
      message_type: messageType,
      routing_targets: routingTargetsFromDelivery(delivery),
      ...selfRoleFromDelivery(delivery),
      ...(delivery.profile_runtime_contract === undefined
        ? {}
        : { native_profile_contract: delivery.profile_runtime_contract }),
    };
    let requestContext = rawRequestContext;
    if (messageType !== "agent.fanin") {
      try {
        requestContext = this.harness.prepareContext(rawRequestContext);
      } catch (error) {
        await this.finishError(accepted.record, asAdapterError(error));
        return;
      }
    }

    const started = await this.store.transitionAndEnqueue(
      delivery.delivery_id,
      "started",
      this.clock.now().toISOString(),
      {
        retainRequest: true,
        attempt: delivery.attempt,
        claimToken: delivery.claim_token,
        executionIntentProtocol: "preinvoke-v1",
      },
    );
    await this.publishLifecycleEvent(started.event);
    const stopClaimRenewal = startClaimRenewal(
      this.renewalDeps,
      started.record,
      this.claimRenewalMs ?? executionBudget.claimRenewalMs,
      this.claimWatchdogMs ?? executionBudget.claimWatchdogMs,
      controller,
    );

    let output: StructuredOutput | undefined;
    let consumedProfile: RuntimeProfileMeasurement | undefined;
    let executionFailure: unknown;
    let turnInput: TurnInput | undefined;
    try {
      const trustedOrigin = delivery.authenticated_context?.origin ?? delivery.origin;
      const processedReplies = messageType === "agent.fanin"
        ? this.store.processedRepliesForFanin(delivery)
        : [];
      if (messageType === "agent.fanin") {
        output = validateDeliveryOutput(synthesizeFaninOutput(
          delivery.body,
          processedReplies.length === 0 ? {} : { processedReplies },
        ), {
          messageType,
          senderAlias: requestContext.sender_alias,
          selfAlias: requestContext.self_alias,
          routingTargets: requestContext.routing_targets,
        });
      } else {
        turnInput = await materializeTurnInput(delivery, this.store,
          { logger: this.logger, tenantId: this.ownTenantId, fetchSealedSecret: this.sealedSecrets });
        const attachments = turnInput.attachments;
        const prompt = turnInput.prompt;
        if (reservation !== undefined) await reservation.wait(controller.signal);
        output = await this.harness.execute({
          prompt,
          ...(attachments === undefined ? {} : { attachments: attachments.attachments }),
          context: requestContext,
          ...session,
          ...(reservation === undefined ? {} : { sessionReservation: reservation }),
          ...(trustedOrigin === undefined ? {} : { origin: trustedOrigin }),
          timeoutMs: executionBudget.harnessTimeoutMs,
          signal: controller.signal,
          beforeHarnessInvoke: async () => {
            // The adapter calls this after another disk preflight, then revalidates once more
            // before its runner. This operation proves ownership and marks the point of no return.
            try {
              await this.commitExecutionIntent(
                started.record,
                controller.signal,
                Math.max(100, Math.min(
                  30_000,
                  Math.floor((this.claimWatchdogMs ?? executionBudget.claimWatchdogMs) / 2),
                )),
              );
            } catch (error) {
              throw error instanceof AdapterError
                ? error
                : new AdapterError(
                    "EXECUTION_INTENT_CONFIRMATION_FAILED",
                    "Gateway did not confirm durable execution intent before harness invocation",
                    true,
                  );
            }
          },
          onFixedContextResolved: (reason) => {
            this.logger({
              event: "fixed_context", delivery_id: delivery.delivery_id, alias: delivery.recipient_alias,
              attempt: delivery.attempt, timestamp: this.clock.now().toISOString(), reason,
            });
          },
          onRuntimeProfileConsumed: (profile) => { consumedProfile = profile; },
        });
      }
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new AdapterError("CANCELLED", "Harness execution was cancelled", false);
      }
    } catch (error) {
      executionFailure = error;
    } finally {
      await stopClaimRenewal();
    }

    try {
      if (executionFailure !== undefined) {
        const executionError = asAdapterError(executionFailure);
        const preserveAmbiguousExecution = !executionError.retryable
          && isAmbiguousAckErrorCode(executionError.code);
        const normalized = this.fenced.has(delivery.delivery_id) && !preserveAmbiguousExecution
          ? new AdapterError("FENCED", "Execution lost its fencing epoch", true)
          : executionError;
        await this.finishError(started.record, normalized);
        return;
      }
      if (output === undefined) {
        await this.finishError(
          started.record,
          new AdapterError("HARNESS_EMPTY_RESULT", "Harness completed without a result", false),
        );
        return;
      }

      // Local attachments are inlined to `data:` HERE, at the only point where the turn becomes
      // an ACK: the envelope is already validated, this is what will actually travel, and it
      // passes once per delivery. The parser is NOT the place —it's pure, synchronous, and runs
      // over candidates that are often discarded—; the full reason is in `artifact-inliner.ts`.
      //
      // Placed before the 'failed'/'done' fork on purpose: a failed turn also persists and
      // publishes its `output`, and the screenshot explaining WHY it failed is exactly what must
      // be visible. `inlineLocalArtifacts` never throws and returns the envelope intact on failure.
      output = await inlineWithoutSecrets(output, turnInput?.secrets, this.logger, delivery);

      if (output.status === "failed") {
        const error = new AdapterError("HARNESS_REPORTED_FAILURE", output.reply ?? "Harness reported failure", output.retryable);
        await this.finishError(started.record, error, output);
        return;
      }

      const profileAdoption = profileAdoptionFor(delivery, consumedProfile);
      const done = await this.store.transitionAndEnqueue(
        delivery.delivery_id,
        "done",
        this.clock.now().toISOString(),
        {
          output,
          ...(profileAdoption === undefined ? {} : { profileAdoption }),
          retainRequest: output.messages.length > 0
            || (messageType === "agent.response" && this.store.continuationSource(delivery) !== undefined),
          attempt: delivery.attempt,
          claimToken: delivery.claim_token,
        },
      );
      await this.publishLifecycleEvent(done.event);
    } finally {
      await releaseTurn(turnInput, this.logger, delivery);
    }
  }

  /**
   * Waits for the session lock's turn with the delivery renewal kept in 'accepted'.
   * If the wait exceeds `queueWaitTimeoutMs`, fails with a retryable error without declaring
   * execution start. Returns `false` when the delivery was closed by error or cancellation.
   */
  private async awaitSessionTurn(
    record: InboxRecord,
    reservation: HarnessSessionReservation,
    budget: ExecutionBudget,
    controller: AbortController,
  ): Promise<boolean> {
    const stopQueueRenewal = startClaimRenewal(
      this.renewalDeps,
      record,
      this.claimRenewalMs ?? budget.claimRenewalMs,
      this.claimWatchdogMs ?? budget.claimWatchdogMs,
      controller,
      "accepted",
    );
    const queueBudgetMs = this.queueWaitTimeoutMs
      ?? Math.min(budget.harnessTimeoutMs, DEFAULT_QUEUE_WAIT_TIMEOUT_MS);
    const queueTimer = this.clock.setTimer(() => {
      controller.abort(new AdapterError(
        "SESSION_QUEUE_TIMEOUT",
        `Delivery waited ${String(queueBudgetMs)} ms for its session turn without starting execution`,
        true,
      ));
    }, queueBudgetMs, { keepProcessAlive: true });

    let failure: unknown;
    try {
      await reservation.wait(controller.signal);
    } catch (error) {
      failure = error;
    } finally {
      this.clock.clearTimer(queueTimer);
      await stopQueueRenewal();
    }
    if (failure === undefined) return true;

    // Nothing has run yet, so nothing can be ambiguous. Degrading an ambiguous code here would be
    // lying the other way: it would send to dead-letters "held for manual replay" a delivery
    // the harness never saw. The normalization to FENCED is the same the execution path applies,
    // and it always holds here since there is never an ambiguous execution to preserve.
    const queueError = asAdapterError(failure);
    const normalized = this.fenced.has(record.delivery_id)
      ? new AdapterError("FENCED", "Execution lost its fencing epoch", true)
      : isAmbiguousAckErrorCode(queueError.code)
        ? new AdapterError("SESSION_QUEUE_ABORTED", queueError.message, true)
        : queueError;
    this.logger({
      event: "claim_renewal_end",
      delivery_id: record.delivery_id,
      attempt: record.attempt,
      phase: "accepted",
      timestamp: this.clock.now().toISOString(),
      reason: normalized.code,
    });
    await this.finishError(record, normalized);
    return false;
  }

  /**
   * A renewal deliberately carries no progress text. The chain progress an operator sees on
   * the origin channel is composed store-side by `insertProgressRelay`, from the delivery row
   * it is already holding under lock inside the ACK transaction, and `AckSchema` has no field
   * an adapter could use to supply its own. Attaching a summary here would produce a value
   * that is dropped in `AdapterClient.sendEvent` and never reaches the wire, so it is left
   * out rather than declared and ignored.
   */
  private async emitClaimRenewal(
    record: InboxRecord,
    // `phase` indicates the delivery phase ('accepted' or 'started'); `executionStarted` marks preinvoke intent.
    phase: "accepted" | "started" = "started",
    options: { readonly executionStarted?: boolean } = {},
  ): Promise<void> {
    const event = await this.persistClaimRenewal(record, phase, options);
    await this.publishEvent(event).catch(() => undefined);
  }

  private async commitExecutionIntent(
    record: InboxRecord,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<void> {
    let event: DeliveryEvent;
    try {
      event = await this.persistClaimRenewal(record, "started", { executionStarted: true });
    } catch {
      throw new AdapterError(
        "EXECUTION_INTENT_PERSISTENCE_FAILED",
        "Durable execution intent could not be persisted before harness invocation",
        true,
      );
    }
    if (this.publishExecutionIntent === undefined) {
      await this.publishEvent(event).catch(() => undefined);
      return;
    }
    await this.publishExecutionIntent(event, signal, timeoutMs);
  }

  private async persistClaimRenewal(
    record: InboxRecord,
    phase: "accepted" | "started",
    options: { readonly executionStarted?: boolean },
  ): Promise<DeliveryEvent> {
    const event: DeliveryEvent = {
      event_id: randomUUID(),
      delivery_id: record.delivery_id,
      attempt: record.attempt,
      claim_token: record.claim_token,
      epoch: this.store.epoch,
      phase,
      occurred_at: this.clock.now().toISOString(),
      claim_renewal: true,
      ...(options.executionStarted === true ? { execution_started: true } : {}),
      ...(record.origin === undefined ? {} : { origin: record.origin }),
    };
    this.logger({
      event: "claim_renewal_start",
      delivery_id: record.delivery_id,
      attempt: record.attempt,
      phase,
      timestamp: event.occurred_at,
    });
    // A renewal must reach stable local storage before it can be treated as recoverable work.
    await this.store.enqueue(event);
    return event;
  }

  private async finishError(
    record: InboxRecord,
    error: AdapterError,
    output?: StructuredOutput,
  ): Promise<void> {
    const payload = { code: error.code, message: error.message, retryable: error.retryable };
    const failed = await this.store.transitionAndEnqueue(
      record.delivery_id,
      "failed",
      this.clock.now().toISOString(),
      {
        error: payload,
        ...(output === undefined ? {} : { output }),
        attempt: record.attempt,
        claimToken: record.claim_token,
      },
    );
    await this.publishLifecycleEvent(failed.event);
  }

  private async replayPending(record: InboxRecord): Promise<void> {
    for (const event of this.store.pendingEventsFor(record)) await this.publishEvent(event);
  }

  private async rejectStale(delivery: Delivery): Promise<void> {
    const error = new StaleEpochError(delivery.epoch, this.store.epoch);
    const event: DeliveryEvent = {
      event_id: randomUUID(),
      delivery_id: delivery.delivery_id,
      attempt: delivery.attempt,
      claim_token: delivery.claim_token,
      epoch: this.store.epoch,
      phase: "failed",
      occurred_at: this.clock.now().toISOString(),
      ...(delivery.origin === undefined ? {} : { origin: delivery.origin }),
      error: { code: error.code, message: error.message, retryable: error.retryable },
    };
    await this.store.enqueue(event);
    await this.publishEvent(event);
  }

  private async publishLifecycleEvent(event: DeliveryEvent): Promise<void> {
    this.logger({
      event: 'delivery_state',
      delivery_id: event.delivery_id,
      phase: event.phase,
      timestamp: event.occurred_at,
    });

    if (event.phase === 'done' || event.phase === 'failed') {
      const logEntry: Parameters<AdapterLogger>[0] = {
        event: 'delivery_end',
        delivery_id: event.delivery_id,
        phase: event.phase,
        timestamp: event.occurred_at,
      };
      if (event.error?.code) logEntry.error_code = event.error.code;
      if (event.error?.message) logEntry.error_message = event.error.message;
      this.logger(logEntry);
    }

    await this.publishEvent(event);
  }
}

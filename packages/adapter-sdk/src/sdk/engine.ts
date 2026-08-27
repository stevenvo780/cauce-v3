import { randomUUID } from "node:crypto";
import {
  isAgentToAgentBody, isAmbiguousAckErrorCode, SYSTEM_GATE_PROBE_MESSAGE_TYPE,
} from "@cauce/protocol";
import type { InboxRecord } from "./durable-store.js";
import { DurableStore } from "./durable-store.js";
import { AdapterError, StaleEpochError, asAdapterError } from "./errors.js";
import type {
  HarnessAdapter, HarnessSessionReservation, RuntimeProfileMeasurement, SessionLane,
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
import { materializeAttachments, type MaterializedAttachments } from "./attachments.js";
import { inlineLocalArtifacts } from "./artifact-inliner.js";
import type {
  AdapterEngineOptions, EventPublisher, ExecutionIntentPublisher,
} from "./engine/contracts.js";
import {
  DEFAULT_AGENTIC_TIMEOUT_MS,
  DEFAULT_QUEUE_WAIT_TIMEOUT_MS,
  MAX_AGENT_EXECUTION_TIMEOUT_MS,
  profileAdoptionFor,
} from "./engine/contracts.js";
import type { ExecutionBudget, HarnessSessionRequestScope } from "./engine/delivery-context.js";
import {
  executionBudgetFor,
  promptForDelivery,
  routingTargetsFromDelivery,
  selfRoleFromDelivery,
  sessionFromDelivery,
  timeoutFromBody,
} from "./engine/delivery-context.js";
import { interruptedStartedError } from "./engine/recovery.js";
import { runSystemGateProbe } from "./engine/system-gate-probe.js";

export type {
  AdapterEngineOptions, EventPublisher, ExecutionIntentPublisher,
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
  private readonly clock: Clock;
  private readonly tasks = new Map<string, {
    readonly attempt: number;
    readonly claimToken: string;
    readonly promise: Promise<void>;
  }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly claimMonitors = new Map<string, {
    readonly attempt: number;
    readonly claimToken: string;
    readonly confirm: () => void;
  }>();
  private readonly fenced = new Set<string>();

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
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_AGENTIC_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.defaultTimeoutMs)
      || this.defaultTimeoutMs <= 0
      || this.defaultTimeoutMs > MAX_AGENT_EXECUTION_TIMEOUT_MS) {
      throw new RangeError("defaultTimeoutMs must be between 1 and 604800000");
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
    this.clock = options.clock ?? systemClock;
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
    // Sesión compartida: utiliza un único carril asociado al alias para sincronizar la TUI.
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
   * Registra un latido de cola no aplicado sin confirmar ni abortar el lease.
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

    // Espera a adquirir el candado de sesión antes de transicionar a estado 'started'.
    if (reservation !== undefined) {
      const acquired = await this.awaitSessionTurn(
        accepted.record,
        reservation,
        executionBudget,
        controller,
      );
      if (!acquired) return;
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
    const stopClaimRenewal = this.startClaimRenewal(
      started.record,
      this.claimRenewalMs ?? executionBudget.claimRenewalMs,
      this.claimWatchdogMs ?? executionBudget.claimWatchdogMs,
      controller,
    );

    const messageType = typeof delivery.body.type === "string"
      ? delivery.body.type
      : "request";
    let output: StructuredOutput | undefined;
    let consumedProfile: RuntimeProfileMeasurement | undefined;
    let executionFailure: unknown;
    let attachments: MaterializedAttachments | undefined;
    try {
      const trustedOrigin = delivery.authenticated_context?.origin ?? delivery.origin;
      const requestContext = {
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
      };
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
        const prompt = await (async () => {
          attachments = await materializeAttachments(delivery.body);
          const base = promptForDelivery(delivery, this.store);
          return attachments === undefined ? base : `${base}\n\n${attachments.prompt}`;
        })();
        if (reservation !== undefined) await reservation.wait(controller.signal);
        // Se emite como renovación de garra a propósito: reusa la confirmación de propiedad que
        // ya existe, así que además funciona como último chequeo de "esto sigue siendo mío"
        // justo antes de gastar plata. Si el gateway responde que no, `loseClaim` aborta.
        //
        // La misma operación prueba propiedad y deja durable el punto de no retorno. Si falla el
        // fsync, el harness todavía no fue invocado y el terminal es reintentable con seguridad.
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
        output = await this.harness.execute({
          prompt,
          ...(attachments === undefined ? {} : { attachments: attachments.attachments }),
          context: requestContext,
          ...session,
          ...(reservation === undefined ? {} : { sessionReservation: reservation }),
          ...(trustedOrigin === undefined ? {} : { origin: trustedOrigin }),
          timeoutMs: executionBudget.harnessTimeoutMs,
          signal: controller.signal,
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
      try {
        await attachments?.cleanup();
      } catch {
        executionFailure ??= new AdapterError(
          "ATTACHMENT_CLEANUP_FAILED",
          "Temporary attachment cleanup failed",
          false,
        );
      }
    }

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

    // Los adjuntos locales se convierten a `data:` ACÁ, en el único punto donde el turno se
    // convierte en ACK: el sobre ya está validado, es el que de verdad va a viajar y se pasa una
    // sola vez por entrega. El parser NO es el sitio —es puro, síncrono y corre sobre candidatos
    // que muchas veces se descartan—; el porqué completo está en `artifact-inliner.ts`.
    //
    // Va antes de la bifurcación 'failed'/'done' a propósito: un turno fallido también persiste y
    // publica su `output`, y el pantallazo que explica POR QUÉ falló es justo el que hay que poder
    // ver. `inlineLocalArtifacts` no tira nunca y devuelve el sobre intacto si algo no se pudo.
    output = await inlineLocalArtifacts(output);

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
  }

  /**
   * Espera el turno del candado de sesión manteniendo la renovación de la entrega en fase 'accepted'.
   * Si la espera supera `queueWaitTimeoutMs`, falla con error retryable sin declarar inicio de ejecución.
   * Devuelve `false` cuando la entrega fue cerrada por error o cancelación.
   */
  private async awaitSessionTurn(
    record: InboxRecord,
    reservation: HarnessSessionReservation,
    budget: ExecutionBudget,
    controller: AbortController,
  ): Promise<boolean> {
    const stopQueueRenewal = this.startClaimRenewal(
      record,
      this.claimRenewalMs ?? budget.claimRenewalMs,
      this.claimWatchdogMs ?? budget.claimWatchdogMs,
      controller,
      "accepted",
    );
    const queueBudgetMs = this.queueWaitTimeoutMs
      ?? Math.min(budget.harnessTimeoutMs, DEFAULT_QUEUE_WAIT_TIMEOUT_MS);
    const queueTimer = setTimeout(() => {
      controller.abort(new AdapterError(
        "SESSION_QUEUE_TIMEOUT",
        `Delivery waited ${queueBudgetMs} ms for its session turn without starting execution`,
        true,
      ));
    }, queueBudgetMs);
    queueTimer.unref();

    let failure: unknown;
    try {
      await reservation.wait(controller.signal);
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(queueTimer);
      await stopQueueRenewal();
    }
    if (failure === undefined) return true;

    // Nada corrió todavía, así que nada puede ser ambiguo. Degradar un código ambiguo acá sería
    // mentir en el otro sentido: mandaría a dead-letters "held for manual replay" una entrega que
    // el harness jamás vio. La normalización a FENCED es la misma que aplica el camino de
    // ejecución, y acá vale siempre porque nunca hay ejecución ambigua que preservar.
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
   * A delivery claim is a short renewable lease, not the agent's wall-clock
   * execution deadline. Renewal events are durable locally before transport;
   * an offline socket can therefore flush them after reconnect.
   *
   * `phase` distingue el latido de cola ('accepted') del de ejecución ('started'). El transporte
   * lo mapea tal cual al `status` del ACK; ambos son valores que `AckStatusSchema` y el CHECK de
   * `delivery_acks.status` ya aceptan, así que esto no pide ningún cambio de esquema.
   */
  private startClaimRenewal(
    record: InboxRecord,
    intervalMs: number,
    watchdogMs: number,
    controller: AbortController,
    phase: "accepted" | "started" = "started",
  ): () => Promise<void> {
    let stopped = false;
    let tail = Promise.resolve();
    const abortForUnconfirmedClaim = (): void => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      this.fenced.add(record.delivery_id);
      controller.abort(new AdapterError(
        "CLAIM_RENEWAL_UNCONFIRMED",
        "Delivery lease renewal was not confirmed before the ownership deadline",
        true,
      ));
    };
    let watchdog = setTimeout(abortForUnconfirmedClaim, watchdogMs);
    watchdog.unref();
    const confirm = (): void => {
      if (stopped) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(abortForUnconfirmedClaim, watchdogMs);
      watchdog.unref();
    };
    const timer = setInterval(() => {
      if (stopped) return;
      tail = tail
        .catch(() => undefined)
        .then(async () => {
          if (stopped) return;
          try {
            await this.emitClaimRenewal(record, phase);
          } catch {
            stopped = true;
            clearInterval(timer);
            controller.abort(new AdapterError(
              "CLAIM_RENEWAL_PERSISTENCE_FAILED",
              "Delivery lease renewal could not be persisted locally",
              false,
            ));
          }
        });
    }, intervalMs);
    timer.unref();
    this.claimMonitors.set(record.delivery_id, {
      attempt: record.attempt,
      claimToken: record.claim_token,
      confirm,
    });
    return async () => {
      stopped = true;
      clearInterval(timer);
      clearTimeout(watchdog);
      const monitor = this.claimMonitors.get(record.delivery_id);
      if (monitor?.attempt === record.attempt && monitor.claimToken === record.claim_token) {
        this.claimMonitors.delete(record.delivery_id);
      }
      await tail.catch(() => undefined);
    };
  }

  /**
   * A renewal deliberately carries no progress text. The chain progress an operator
   * sees on the origin channel is composed store-side by `insertProgressRelay`, from
   * the delivery row it is already holding under lock inside the ACK transaction, and
   * `AckSchema` has no field an adapter could use to supply its own. Attaching a
   * summary here would produce a value that is dropped in `AdapterClient.sendEvent`
   * and never reaches the wire, so it is left out rather than declared and ignored.
   */
  private async emitClaimRenewal(
    record: InboxRecord,
    // `phase` indica la fase de la entrega ('accepted' o 'started'); `executionStarted` marca intención preinvoke.
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

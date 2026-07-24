import { createHash, randomUUID } from "node:crypto";
import { isAmbiguousAckErrorCode } from "@cauce/protocol";
import type { InboxRecord } from "./durable-store.js";
import { DurableStore } from "./durable-store.js";
import { AdapterError, StaleEpochError, asAdapterError } from "./errors.js";
import type { HarnessAdapter, HarnessSessionReservation } from "../harnesses/shared.js";
import type {
  CancelDelivery,
  Clock,
  Delivery,
  DeliveryEvent,
  DeliveryPhase,
  StructuredOutput,
} from "./types.js";
import { systemClock } from "./backoff.js";
import { synthesizeFaninOutput } from "./fanin-synthesizer.js";
import { validateDeliveryOutput } from "./output-parser.js";

export type EventPublisher = (event: DeliveryEvent) => Promise<void>;

export interface AdapterEngineOptions {
  readonly store: DurableStore;
  readonly harness: HarnessAdapter;
  readonly publish: EventPublisher;
  readonly defaultTimeoutMs?: number;
  readonly clock?: Clock;
}

export class AdapterEngine {
  private readonly store: DurableStore;
  private readonly harness: HarnessAdapter;
  private readonly publishEvent: EventPublisher;
  private readonly defaultTimeoutMs: number;
  private readonly clock: Clock;
  private readonly tasks = new Map<string, {
    readonly attempt: number;
    readonly claimToken: string;
    readonly promise: Promise<void>;
  }>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly fenced = new Set<string>();

  constructor(options: AdapterEngineOptions) {
    this.store = options.store;
    this.harness = options.harness;
    this.publishEvent = options.publish;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60_000;
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
    const fanin = delivery.body.type === "agent.fanin";
    const session = fanin ? {} : sessionFromDelivery(delivery);
    const reservation = fanin ? undefined : this.harness.reserveSession(session.sessionKey);
    const execution = this.runDelivery(delivery, session, reservation);
    const task = execution.finally(() => {
      if (this.tasks.get(delivery.delivery_id)?.promise === task) {
        this.tasks.delete(delivery.delivery_id);
        this.controllers.delete(delivery.delivery_id);
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

  async recover(): Promise<void> {
    for (const record of this.store.pendingDeliveries()) {
      if (this.tasks.has(record.delivery_id)) continue;
      if (record.state === "started") {
        const error = new AdapterError(
          "INTERRUPTED_AMBIGUOUS",
          "Previous harness process was interrupted after execution began; completion state is unknown",
          false,
        );
        await this.finishError(record, error);
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
    session: { sessionKey?: string },
    reservation: HarnessSessionReservation | undefined,
  ): Promise<void> {
    try {
      await this.runReservedDelivery(delivery, session, reservation);
    } finally {
      reservation?.release();
    }
  }

  private async runReservedDelivery(
    delivery: Delivery,
    session: { sessionKey?: string },
    reservation: HarnessSessionReservation | undefined,
  ): Promise<void> {
    const occurredAt = this.clock.now().toISOString();
    const accepted = await this.store.accept(delivery, occurredAt);
    if (accepted.acceptance === "stale" || accepted.acceptance === "blocked") return;
    if (accepted.acceptance === "duplicate") {
      await this.replayPending(accepted.record);
      if (accepted.record.state === "started") {
        await this.finishError(
          accepted.record,
          new AdapterError(
            "INTERRUPTED_AMBIGUOUS",
            "In-flight delivery was interrupted after execution began and cannot be executed twice",
            false,
          ),
        );
        return;
      }
      if (accepted.record.state !== "accepted") return;
    } else {
      await this.emit("accepted", accepted.record);
    }

    if (delivery.epoch !== this.store.epoch) {
      await this.finishError(accepted.record, new AdapterError("FENCED", "Execution lost its fencing epoch", true));
      return;
    }

    const controller = new AbortController();
    this.controllers.set(delivery.delivery_id, controller);
    const started = await this.store.transition(delivery.delivery_id, "started", this.clock.now().toISOString(), {
      retainRequest: true,
      attempt: delivery.attempt,
      claimToken: delivery.claim_token,
    });
    await this.emit("started", started);

    let output: StructuredOutput;
    try {
      const trustedOrigin = delivery.authenticated_context?.origin ?? delivery.origin;
      const messageType = typeof delivery.body.type === "string"
        ? delivery.body.type
        : "request";
      const requestContext = {
        self_alias: delivery.recipient_alias,
        sender_alias: delivery.actor_alias,
        tenant_id: delivery.tenant_id,
        room_id: delivery.room_id,
        channel: delivery.authenticated_context?.channel
          ?? delivery.origin?.channel
          ?? "cauce",
        agent_message: messageType === "agent.message"
          || messageType === "agent.response"
          || messageType === "agent.fanin",
        message_type: messageType,
        routing_targets: routingTargetsFromDelivery(delivery),
      };
      output = messageType === "agent.fanin"
        ? validateDeliveryOutput(synthesizeFaninOutput(delivery.body), {
            messageType,
            senderAlias: requestContext.sender_alias,
            selfAlias: requestContext.self_alias,
            routingTargets: requestContext.routing_targets,
          })
        : await this.harness.execute({
            prompt: promptFromBody(delivery.body),
            context: requestContext,
            ...session,
            ...(reservation === undefined ? {} : { sessionReservation: reservation }),
            ...(trustedOrigin === undefined ? {} : { origin: trustedOrigin }),
            timeoutMs: timeoutFromBody(delivery.body, this.defaultTimeoutMs),
            signal: controller.signal,
          });
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new AdapterError("CANCELLED", "Harness execution was cancelled", false);
      }
    } catch (error) {
      const executionError = asAdapterError(error);
      const preserveAmbiguousExecution = !executionError.retryable
        && isAmbiguousAckErrorCode(executionError.code);
      const normalized = this.fenced.has(delivery.delivery_id) && !preserveAmbiguousExecution
        ? new AdapterError("FENCED", "Execution lost its fencing epoch", true)
        : executionError;
      await this.finishError(started, normalized);
      return;
    }

    if (output.status === "failed") {
      const error = new AdapterError("HARNESS_REPORTED_FAILURE", output.reply ?? "Harness reported failure", output.retryable);
      await this.finishError(started, error, output);
      return;
    }

    const done = await this.store.transition(delivery.delivery_id, "done", this.clock.now().toISOString(), {
      output,
      attempt: delivery.attempt,
      claimToken: delivery.claim_token,
    });
    await this.emit("done", done, { output });
  }

  private async finishError(
    record: InboxRecord,
    error: AdapterError,
    output?: StructuredOutput,
  ): Promise<void> {
    const payload = { code: error.code, message: error.message, retryable: error.retryable };
    const failed = await this.store.transition(record.delivery_id, "failed", this.clock.now().toISOString(), {
      error: payload,
      ...(output === undefined ? {} : { output }),
      attempt: record.attempt,
      claimToken: record.claim_token,
    });
    await this.emit("failed", failed, {
      error: payload,
      ...(output === undefined ? {} : { output }),
    });
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

  private async emit(
    phase: DeliveryPhase,
    record: InboxRecord,
    additions: {
      readonly duplicate?: boolean;
      readonly output?: StructuredOutput;
      readonly error?: InboxRecord["error"];
    } = {},
  ): Promise<void> {
    const event: DeliveryEvent = {
      event_id: randomUUID(),
      delivery_id: record.delivery_id,
      attempt: record.attempt,
      claim_token: record.claim_token,
      epoch: this.store.epoch,
      phase,
      occurred_at: this.clock.now().toISOString(),
      ...(record.origin === undefined ? {} : { origin: record.origin }),
      ...(additions.duplicate === undefined ? {} : { duplicate: additions.duplicate }),
      ...(additions.output === undefined ? {} : { output: additions.output }),
      ...(additions.error === undefined ? {} : { error: additions.error }),
    };
    await this.store.enqueue(event);
    await this.publishEvent(event);
  }
}

function promptFromBody(body: Record<string, unknown>): string {
  const value = typeof body.prompt === "string" ? body.prompt : body.text;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdapterError("INVALID_DELIVERY", "Delivery body requires a non-empty prompt or text", false);
  }
  return value;
}

function sessionFromDelivery(delivery: Delivery): { sessionKey?: string } {
  const context = delivery.authenticated_context;
  const origin = context?.origin ?? delivery.origin;
  const channel = context?.channel ?? origin?.channel;
  const sessionId = context?.session_id ?? origin?.conversation_id;
  const conversationId = origin?.conversation_id;
  if (origin === undefined || channel === undefined || sessionId === undefined || conversationId === undefined) return {};
  const bridgeTenant = typeof origin.metadata.bridge_tenant === "string"
    ? origin.metadata.bridge_tenant
    : delivery.tenant_id;
  const scope = JSON.stringify({
    namespace: "cauce-authenticated-session-v1",
    tenant_id: bridgeTenant,
    recipient_alias: delivery.recipient_alias,
    origin: {
      adapter: origin.adapter,
      channel,
      session_id: sessionId,
      conversation_id: conversationId,
    },
  });
  return { sessionKey: `auth-v1:${createHash("sha256").update(scope).digest("base64url")}` };
}

function timeoutFromBody(body: Record<string, unknown>, fallback: number): number {
  const value = body.timeout_ms;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function routingTargetsFromDelivery(delivery: Delivery): readonly {
  readonly tenant_id: string;
  readonly alias: string;
  readonly online: boolean;
}[] {
  const forwardCompatible = delivery as Delivery & {
    readonly routing_targets?: unknown;
    readonly available_recipients?: unknown;
  };
  const candidate = forwardCompatible.routing_targets ?? forwardCompatible.available_recipients;
  if (!Array.isArray(candidate)) return [];

  const unique = new Map<string, { tenant_id: string; alias: string; online: boolean }>();
  for (const value of candidate) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const target = value as Record<string, unknown>;
    if (typeof target.tenant_id !== "string" || target.tenant_id.trim().length === 0) continue;
    if (typeof target.alias !== "string" || target.alias.trim().length === 0) continue;
    if (typeof target.online !== "boolean") continue;
    const normalized = {
      tenant_id: target.tenant_id,
      alias: target.alias,
      online: target.online,
    };
    unique.set(`${normalized.tenant_id}\u0000${normalized.alias}`, normalized);
  }
  return [...unique.values()].sort((left, right) =>
    left.tenant_id.localeCompare(right.tenant_id) || left.alias.localeCompare(right.alias));
}

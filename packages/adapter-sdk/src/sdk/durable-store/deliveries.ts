import type { Delivery, DeliveryEvent } from "../types.js";
import { clone } from "./atomic-state.js";
import type {
  DeliveryAcceptance,
  DeliveryTransitionDetails,
  EventCorrelation,
  EventDeliveryFeedback,
  InboxFile,
  InboxRecord,
  InboxState,
  LifecycleAcceptance,
  LifecycleEventSlot,
  LifecycleTransition,
  OutboxFile,
} from "./contracts.js";
import {
  deliveryFingerprint,
  lifecycleEventFor,
  lifecycleSlot,
  sameCorrelation,
  withLifecycleEvent,
} from "./delivery-helpers.js";
import { DurableStoreFanin } from "./fanin.js";

export class DurableStoreDeliveries extends DurableStoreFanin {
  async accept(
    delivery: Delivery,
    occurredAt: string,
  ): Promise<{ acceptance: DeliveryAcceptance; record: InboxRecord }> {
    const accepted = await this.acceptInternal(delivery, occurredAt, false);
    return { acceptance: accepted.acceptance, record: accepted.record };
  }

  /**
   * Persist a newly accepted attempt and its transport event in the same atomic state image.
   *
   * On a duplicate from a legacy split-file store, this also reconstructs the one missing event
   * for the record's current state and records its stable id. That recovery can cause one safe
   * at-least-once replay, but never a permanent new-event loop after the relay ACKs it.
   */
  async acceptAndEnqueue(delivery: Delivery, occurredAt: string): Promise<LifecycleAcceptance> {
    return this.acceptInternal(delivery, occurredAt, true);
  }

  private async acceptInternal(
    delivery: Delivery,
    occurredAt: string,
    enqueueLifecycle: boolean,
  ): Promise<LifecycleAcceptance> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[delivery.delivery_id]
        ?? this.terminalHistory.get(delivery.delivery_id);
      const fingerprint = deliveryFingerprint(delivery);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error(`delivery_id collision for ${delivery.delivery_id}`);
        }
        if (delivery.attempt < existing.attempt) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (delivery.attempt === existing.attempt) {
          if (delivery.claim_token === existing.claim_token && enqueueLifecycle) {
            const recovered = await this.ensureCurrentLifecycleEventUnlocked(existing);
            return { acceptance: "duplicate", record: clone(recovered) };
          }
          return {
            acceptance: delivery.claim_token === existing.claim_token ? "duplicate" : "stale",
            record: clone(existing),
          };
        }
        const seenClaims = [...(existing.previous_claim_tokens ?? []), existing.claim_token];
        if (seenClaims.includes(delivery.claim_token)) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (existing.state !== "failed" || existing.error?.retryable !== true) {
          return { acceptance: "blocked", record: clone(existing) };
        }
      }
      const record: InboxRecord = {
        delivery_id: delivery.delivery_id,
        fingerprint,
        epoch: delivery.epoch,
        attempt: delivery.attempt,
        claim_token: delivery.claim_token,
        ...(existing === undefined
          ? {}
          : { previous_claim_tokens: [...(existing.previous_claim_tokens ?? []), existing.claim_token] }),
        state: "accepted",
        origin: delivery.origin,
        request: delivery,
        updated_at: occurredAt,
      };
      const baseInbox = this.withoutExpiredDelegationContexts(Date.now());
      const event = enqueueLifecycle ? lifecycleEventFor(record, "accepted", occurredAt) : undefined;
      const committedRecord = event === undefined ? record : withLifecycleEvent(record, event);
      const nextInbox: InboxFile = {
        version: 1,
        deliveries: { ...baseInbox.deliveries, [delivery.delivery_id]: committedRecord },
      };
      const nextOutbox: OutboxFile = event === undefined
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: true,
        outbox: event !== undefined,
      });
      this.scheduleDelegationContextPrune();
      return {
        acceptance: existing === undefined ? "created" : "retry",
        record: clone(committedRecord),
        ...(event === undefined ? {} : { event: clone(event) }),
      };
    });
  }

  async ensureCurrentLifecycleEvent(
    correlation: Pick<InboxRecord, "delivery_id" | "attempt" | "claim_token">,
  ): Promise<InboxRecord> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[correlation.delivery_id]
        ?? this.terminalHistory.get(correlation.delivery_id);
      if (existing === undefined) throw new Error(`Unknown delivery ${correlation.delivery_id}`);
      if (existing.attempt !== correlation.attempt || existing.claim_token !== correlation.claim_token) {
        throw new Error(`Stale lifecycle correlation for delivery ${correlation.delivery_id}`);
      }
      return clone(await this.ensureCurrentLifecycleEventUnlocked(existing));
    });
  }

  private async ensureCurrentLifecycleEventUnlocked(existing: InboxRecord): Promise<InboxRecord> {
    const slot: LifecycleEventSlot = existing.state === "done" || existing.state === "failed"
      ? "terminal"
      : existing.state;
    if (existing.lifecycle_event_ids?.[slot] !== undefined) return existing;

    const pending = this.outbox.pending.find((event) => (
      event.delivery_id === existing.delivery_id
      && event.attempt === existing.attempt
      && event.claim_token === existing.claim_token
      && lifecycleSlot(event) === slot
      && (slot !== "terminal" || event.phase === existing.state)
    ));
    const event = pending
      ?? lifecycleEventFor(existing, existing.state, existing.updated_at, this.fencing.epoch);
    const recovered = withLifecycleEvent(existing, event);
    const nextInbox: InboxFile = {
      version: 1,
      deliveries: { ...this.inbox.deliveries, [existing.delivery_id]: recovered },
    };
    const nextOutbox: OutboxFile = pending === undefined
      ? { version: 1, pending: [...this.outbox.pending, event] }
      : this.outbox;
    await this.commitDeliveryState(nextInbox, nextOutbox, {
      inbox: true,
      outbox: pending === undefined,
    });
    return recovered;
  }

  async transition(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails = {},
  ): Promise<InboxRecord> {
    return (await this.transitionInternal(deliveryId, state, occurredAt, details, false)).record;
  }

  /** Atomically commits the state transition and the exact event that reports it. */
  async transitionAndEnqueue(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails = {},
  ): Promise<LifecycleTransition> {
    const result = await this.transitionInternal(deliveryId, state, occurredAt, details, true);
    if (result.event === undefined) throw new Error("Lifecycle transition did not create an event");
    return { record: result.record, event: result.event };
  }

  private async transitionInternal(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails,
    enqueueLifecycle: boolean,
  ): Promise<{ readonly record: InboxRecord; readonly event?: DeliveryEvent }> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[deliveryId];
      if (existing === undefined) throw new Error(`Unknown delivery ${deliveryId}`);
      if (details.attempt !== undefined && details.attempt !== existing.attempt) {
        throw new Error(`Stale attempt ${String(details.attempt)} for delivery ${deliveryId}`);
      }
      if (details.claimToken !== undefined && details.claimToken !== existing.claim_token) {
        throw new Error(`Stale claim token for delivery ${deliveryId}`);
      }
      const terminal = state === "done" || state === "failed";
      const next: InboxRecord = {
        delivery_id: existing.delivery_id,
        fingerprint: existing.fingerprint,
        epoch: existing.epoch,
        attempt: existing.attempt,
        claim_token: existing.claim_token,
        ...(existing.previous_claim_tokens === undefined
          ? {}
          : { previous_claim_tokens: existing.previous_claim_tokens }),
        state,
        ...(details.executionIntentProtocol === undefined
          ? (existing.execution_intent_protocol === undefined
              ? {}
              : { execution_intent_protocol: existing.execution_intent_protocol })
          : { execution_intent_protocol: details.executionIntentProtocol }),
        ...(existing.execution_intent_receipt_event_id === undefined
          ? {}
          : { execution_intent_receipt_event_id: existing.execution_intent_receipt_event_id }),
        origin: existing.origin,
        ...(!terminal || details.retainRequest === true ? { request: existing.request } : {}),
        ...(details.output === undefined ? {} : { output: details.output }),
        ...(details.profileAdoption === undefined ? {} : { profile_adoption: details.profileAdoption }),
        ...(details.error === undefined ? {} : { error: details.error }),
        ...(existing.lifecycle_event_ids === undefined
          ? {}
          : { lifecycle_event_ids: existing.lifecycle_event_ids }),
        updated_at: occurredAt,
      };
      const event = enqueueLifecycle
        ? lifecycleEventFor(next, state, occurredAt, this.fencing.epoch)
        : undefined;
      const committedNext = event === undefined ? next : withLifecycleEvent(next, event);
      const deliveries: Record<string, InboxRecord> = {
        ...this.inbox.deliveries,
        [deliveryId]: committedNext,
      };
      if (state === "done" && existing.request?.body.type === "agent.fanin") {
        const root = this.faninRoot(existing.request);
        if (root !== undefined) {
          for (const [candidateId, candidate] of Object.entries(deliveries)) {
            const request = candidate.request;
            if (request === undefined
              || (candidate.state !== "done" && candidate.state !== "failed")) continue;
            const belongsToRoot = request.delivery_id === root.delivery_id
              || (request.body.type === "agent.response"
                && this.continuationBelongsToRoot(request, root.delivery_id));
            if (!belongsToRoot) continue;
            const withoutRequest = { ...candidate };
            delete withoutRequest.request;
            deliveries[candidateId] = withoutRequest;
          }
        }
      }
      const nextInbox: InboxFile = {
        version: 1,
        deliveries,
      };
      const nextOutbox: OutboxFile = event === undefined
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: true,
        outbox: event !== undefined,
      });
      this.scheduleDelegationContextPrune();
      return {
        record: clone(committedNext),
        ...(event === undefined ? {} : { event: clone(event) }),
      };
    });
  }

  async enqueue(event: DeliveryEvent): Promise<void> {
    await this.serialized(async () => {
      const alreadyPending = this.outbox.pending.some((candidate) => candidate.event_id === event.event_id);
      const existing = this.inbox.deliveries[event.delivery_id];
      const correlated = existing?.attempt === event.attempt
        && existing.claim_token === event.claim_token
        ? withLifecycleEvent(existing, event)
        : existing;
      const markerChanged = existing !== undefined && correlated !== undefined && correlated !== existing;
      if (alreadyPending && !markerChanged) return;
      const nextInbox: InboxFile = markerChanged
        ? {
            version: 1,
            deliveries: { ...this.inbox.deliveries, [event.delivery_id]: correlated },
          }
        : this.inbox;
      const nextOutbox: OutboxFile = alreadyPending
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: markerChanged,
        outbox: !alreadyPending,
      });
    });
  }

  pendingEvents(): readonly DeliveryEvent[] {
    return clone(this.outbox.pending);
  }

  async acknowledge(correlation: EventCorrelation): Promise<boolean> {
    return this.acknowledgeResult(correlation);
  }

  /**
   * Confirm one exact event and persist its delegation receipt in the same WAL transaction.
   * A restart therefore sees either both feedback+removal or the still-pending event to replay.
   */
  async acknowledgeResult(
    correlation: EventCorrelation,
    feedback: EventDeliveryFeedback = {},
  ): Promise<boolean> {
    return this.serialized(async () => {
      const acknowledgedEvent = this.outbox.pending.find((event) => sameCorrelation(event, correlation));
      if (acknowledgedEvent === undefined) return false;
      const pending = this.outbox.pending.filter((event) => !sameCorrelation(event, correlation));
      const existing = this.inbox.deliveries[correlation.delivery_id];
      const terminalFeedback = (acknowledgedEvent.phase === "done" || acknowledgedEvent.phase === "failed")
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && (feedback.delegation_rejections !== undefined
          || feedback.delegation_materializations !== undefined);
      const terminalOwnershipLost = (acknowledgedEvent.phase === "done" || acknowledgedEvent.phase === "failed")
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && feedback.terminal_receipt === "ownership_lost";
      const executionIntentConfirmed = acknowledgedEvent.execution_started === true
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && feedback.execution_intent_receipt !== undefined;
      if (feedback.execution_intent_receipt !== undefined && !executionIntentConfirmed) {
        throw new Error("Execution intent receipt does not match a current durable marker");
      }
      // The remote store rejected this terminal result: keeping `done` locally would forever block
      // the upper attempt the bus is entitled to deliver. Degrade to a retryable failed, but
      // keep the already-confirmed terminal id so a redelivery of the SAME attempt does not
      // fabricate another event nor re-execute the ambiguous work.
      const ownershipReleasedRecord = terminalOwnershipLost
        ? (() => {
            const retained: { -readonly [Key in keyof InboxRecord]: InboxRecord[Key] } = {
              ...existing,
            };
            delete retained.output;
            delete retained.profile_adoption;
            delete retained.delegation_rejections;
            delete retained.delegation_materializations;
            delete retained.error;
            return {
              ...retained,
              state: "failed" as const,
              error: {
                code: "TERMINAL_ACK_OWNERSHIP_LOST",
                message: "The durable relay rejected this terminal result because claim ownership was lost",
                retryable: true,
              },
            };
          })()
        : existing;
      let nextRecord: InboxRecord | undefined = ownershipReleasedRecord;
      if (executionIntentConfirmed && nextRecord !== undefined) {
        nextRecord = {
          ...nextRecord,
          execution_intent_receipt_event_id: acknowledgedEvent.event_id,
        };
      }
      if (terminalFeedback && !terminalOwnershipLost) {
        if (ownershipReleasedRecord === undefined) {
          throw new Error(`Terminal feedback has no inbox record for ${correlation.delivery_id}`);
        }
        nextRecord = {
          ...ownershipReleasedRecord,
          ...(feedback.delegation_rejections === undefined
            ? {}
            : { delegation_rejections: clone(feedback.delegation_rejections) }),
          ...(feedback.delegation_materializations === undefined
            ? {}
            : { delegation_materializations: clone(feedback.delegation_materializations) }),
        };
      }
      const inboxChanged = terminalFeedback || terminalOwnershipLost || executionIntentConfirmed;
      let nextInbox: InboxFile = this.inbox;
      if (inboxChanged) {
        if (nextRecord === undefined) {
          throw new Error(`Terminal receipt has no inbox record for ${correlation.delivery_id}`);
        }
        nextInbox = {
          version: 1,
          deliveries: { ...this.inbox.deliveries, [correlation.delivery_id]: nextRecord },
        };
      }
      await this.commitDeliveryState(nextInbox, { version: 1, pending }, {
        inbox: inboxChanged,
        outbox: true,
      });
      return true;
    });
  }

  pendingEventsFor(correlation: Pick<EventCorrelation, "delivery_id" | "attempt" | "claim_token">): readonly DeliveryEvent[] {
    return clone(this.outbox.pending.filter((event) => (
      event.delivery_id === correlation.delivery_id
      && event.attempt === correlation.attempt
      && event.claim_token === correlation.claim_token
    )));
  }

}

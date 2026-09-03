import assert from "node:assert/strict";
import test from "node:test";
import type {InboxRecord} from '../src/sdk/durable-store.js';
import {DEFAULT_QUEUE_WAIT_TIMEOUT_MS} from '../src/sdk/engine/contracts.js';
import {startClaimRenewal} from '../src/sdk/engine/claim-renewal.js';
import {AdapterError} from '../src/sdk/errors.js';
import {BlockingRunner, FakeConnection, HARNESS_TIMEOUT_MS, ImmediateTimerClock, ManualTimerClock, ScriptedConnector, claimDeadline, escala, makeClient, renewableDelivery, startedAcks, waitUntil, waitUntilTimestamp} from './client-fixtures.js';
test("a rejected exact renewal aborts the active harness before another attempt can run", async () => {
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const context = await makeClient(
    "renewal-rejected",
    new ScriptedConnector(connection),
    {
      runner,
      // This case exercises ownership loss, not admission against a nearly-expired claim.
      // Keep the cadence short and the watchdog generous enough for a loaded full-suite run.
      claimRenewalMs: escala(100),
      claimWatchdogMs: escala(5_000),
    },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
    connection.push({
      type: "delivery",
      version: "3.0",
      event_id: "30000000-0000-4000-8000-000000000091",
      delivery_id: "20000000-0000-4000-8000-000000000091",
      message_id: "00000000-0000-4000-8000-000000000091",
      request_id: "10000000-0000-4000-8000-000000000091",
      trace_id: "trace-renewal-rejected",
      epoch: 1,
      attempt: 1,
      claim_token: "40000000-0000-4000-8000-000000000091",
      ack_deadline_at: new Date(claimDeadline()).toISOString(),
      tenant_id: "Steven",
      room_id: "grp.steven",
      actor_alias: "kant",
      recipient_alias: "agent_renewal_rejected",
      body: { prompt: "block until ownership is lost", timeout_ms: HARNESS_TIMEOUT_MS },
    });
    await waitUntil(() => runner.started, "the blocking harness to start");
    await waitUntil(() => context.store.pendingEvents().some(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    ), "a durable claim-renewal event in the outbox");
    const renewalEvent = context.store.pendingEvents().find(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    );
    assert.ok(renewalEvent);
    const renewal = connection.sent.find(
      (frame) => frame.type === "ack" && frame.event_id === renewalEvent.event_id,
    );
    assert.ok(renewal, "expected a renewal ACK");
    if (renewal.type !== "ack") throw new Error("expected a renewal ACK");

    connection.push({
      type: "ack_result",
      event_id: renewal.event_id,
      delivery_id: renewal.delivery_id,
      attempt: renewal.attempt,
      claim_token: renewal.claim_token,
      status: "retry",
      applied: false,
      receipt: "ownership_lost",
    });
    await waitUntil(() => runner.aborted, "the harness aborted by the rejected renewal");
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack" && frame.status === "failed",
    ), "the failed ACK for the lost claim");
    assert.equal(context.store.getDelivery(renewal.delivery_id)?.state, "failed");
  } finally {
    stop.abort();
    await running;
  }
});

test("an unconfirmed renewal watchdog aborts the harness before the claim deadline", async () => {
  const name = "renewal-unconfirmed";
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const context = await makeClient(name, new ScriptedConnector(connection), {
    runner,
    claimRenewalMs: escala(100),
    claimWatchdogMs: escala(1_000),
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
    const deadline = claimDeadline();
    const input = renewableDelivery(name, "000000000092", deadline);
    connection.push(input);

    await waitUntil(() => runner.started, "the blocking harness to start");
    await waitUntil(() => startedAcks(connection).length >= 2, "a second started ACK, i.e. one claim renewal");
    await waitUntil(() => runner.aborted, escala(3_000), "the harness aborted by the unconfirmed watchdog");

    assert.ok(
      Date.now() < deadline,
      "The harness must stop before an unconfirmed claim can expire",
    );
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === input.delivery_id
        && frame.status === "failed",
    ), "the failed ACK for the unconfirmed claim");
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "failed");
  } finally {
    stop.abort();
    await running;
  }
});

test("applied and duplicate renewal receipts each extend the claim watchdog", async (t) => {
  const variants = [
    { name: "renewal-applied", suffix: "000000000093", applied: true, receipt: "applied" as const },
    { name: "renewal-duplicate", suffix: "000000000094", applied: false, receipt: "duplicate" as const },
  ];

  for (const variant of variants) {
    await t.test(variant.receipt, async () => {
      const connection = new FakeConnection(1);
      const runner = new BlockingRunner();
      const context = await makeClient(
        variant.name,
        new ScriptedConnector(connection),
        { runner, claimRenewalMs: escala(100), claimWatchdogMs: escala(1_000) },
      );
      const stop = new AbortController();
      const running = context.client.run(stop.signal);
      try {
        await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
        const input = renewableDelivery(variant.name, variant.suffix, claimDeadline());
        connection.push(input);

        await waitUntil(() => runner.started, "the blocking harness to start");
        await waitUntil(() => startedAcks(connection).length >= 2, "a second started ACK, i.e. one claim renewal");
        const originalWatchdogStartedAt = Date.now();
        await waitUntilTimestamp(originalWatchdogStartedAt + escala(400));
        const renewal = startedAcks(connection).at(-1);
        assert.ok(renewal, "Expected a renewable started ACK");

        connection.push({
          type: "ack_result",
          event_id: renewal.event_id,
          delivery_id: renewal.delivery_id,
          attempt: renewal.attempt,
          claim_token: renewal.claim_token,
          status: "started",
          applied: variant.applied,
          receipt: variant.receipt,
        });
        await waitUntil(() => !context.store.pendingEvents().some(
          (event) => event.event_id === renewal.event_id,
        ), "the renewal ACK drained by its receipt");

        await waitUntilTimestamp(originalWatchdogStartedAt + escala(1_100));
        assert.equal(
          runner.aborted,
          false,
          `${variant.receipt} must keep the blocked harness alive past the original watchdog`,
        );

        runner.complete();
        await waitUntil(() => connection.sent.some(
          (frame) => frame.type === "ack"
            && frame.delivery_id === input.delivery_id
            && frame.status === "done",
        ), "the terminal done ACK for the completed harness");
        assert.equal(context.store.getDelivery(input.delivery_id)?.state, "done");
      } finally {
        stop.abort();
        await running;
      }
    });
  }
});


test("the renewal cadence runs on the injected clock, not on host time", async () => {
  const name = "renewal-virtual-clock";
  const clock = new ManualTimerClock();
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const renewalMs = 3_600_000;
  const context = await makeClient(name, new ScriptedConnector(connection), {
    runner,
    clock,
    claimRenewalMs: renewalMs,
    claimWatchdogMs: 7_200_000,
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
    const input = renewableDelivery(name, "000000000095", claimDeadline(), {
      adapter: "test", channel: "test", conversation_id: "queue-wait", relay: [], metadata: {},
    });
    connection.push(input);
    await waitUntil(() => runner.started, "the blocking harness to start");

    const renewals = (): number => context.store.pendingEvents().filter(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    ).length;
    assert.equal(renewals(), 0, "no renewal may exist before the cadence fires");
    assert.equal(
      clock.scheduledAt(renewalMs),
      1,
      "the renewal cadence must be scheduled on the injected clock",
    );

    assert.deepEqual(
      clock.keepAlive().map((entry) => ({ ms: entry.ms, repeating: entry.repeating })),
      [{ ms: Math.min(HARNESS_TIMEOUT_MS, DEFAULT_QUEUE_WAIT_TIMEOUT_MS), repeating: false }],
      "only the queue-wait timer may keep the adapter process alive",
    );

    clock.fire(renewalMs);
    assert.equal(
      clock.scheduledAt(renewalMs),
      1,
      "the renewal cadence repeats: firing it must not disarm it",
    );
    await waitUntil(() => renewals() >= 1, "a renewal after firing the virtual cadence");

    runner.complete();
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === input.delivery_id
        && frame.status === "done",
    ), "the terminal done ACK for the completed harness");
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "done");
  } finally {
    stop.abort();
    await running;
  }
});

test("a confirmed renewal restarts the watchdog, and the watchdog aborts, on the injected clock", async () => {
  const name = "watchdog-virtual-clock";
  const clock = new ManualTimerClock();
  const connection = new FakeConnection(1);
  const runner = new BlockingRunner();
  const renewalMs = 3_600_000;
  const watchdogMs = 7_200_000;
  const context = await makeClient(name, new ScriptedConnector(connection), {
    runner,
    clock,
    claimRenewalMs: renewalMs,
    claimWatchdogMs: watchdogMs,
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
    const input = renewableDelivery(name, "000000000096", claimDeadline());
    connection.push(input);
    await waitUntil(() => runner.started, "the blocking harness to start");

    const armed = clock.scheduledIds(watchdogMs);
    assert.equal(armed.length, 1, "the watchdog must be armed on the injected clock");

    clock.fire(renewalMs);
    const renewalId = (): string | undefined => context.store.pendingEvents()
      .find((event) => event.claim_renewal === true)?.event_id;
    await waitUntil(() => renewalId() !== undefined, "a renewal from the virtual cadence");
    const renewalEventId = renewalId();
    const renewal = startedAcks(connection).find((frame) => frame.event_id === renewalEventId);
    assert.ok(renewal, "Expected a renewable started ACK");
    connection.push({
      type: "ack_result",
      event_id: renewal.event_id,
      delivery_id: renewal.delivery_id,
      attempt: renewal.attempt,
      claim_token: renewal.claim_token,
      status: "started",
      applied: true,
      receipt: "applied",
    });
    await waitUntil(() => !context.store.pendingEvents().some(
      (event) => event.event_id === renewal.event_id,
    ), "the renewal ACK drained by its receipt");

    const restarted = clock.scheduledIds(watchdogMs);
    assert.equal(restarted.length, 1, "a receipt leaves exactly one watchdog armed");
    assert.notEqual(
      restarted[0],
      armed[0],
      "a receipt must cancel the armed watchdog and arm a fresh one",
    );
    assert.equal(runner.aborted, false, "a confirmed claim never aborts by itself");

    clock.fire(watchdogMs);
    assert.equal(
      clock.scheduledAt(watchdogMs),
      0,
      "the watchdog is one-shot: firing it must leave nothing armed",
    );
    await waitUntil(() => runner.aborted, "the harness aborted by the virtual watchdog");
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === input.delivery_id
        && frame.status === "failed",
    ), "the failed ACK after the virtual watchdog fired");
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "failed");
  } finally {
    stop.abort();
    await running;
  }
});

test("a clock that fires the watchdog in the arming tick aborts instead of throwing", () => {
  const record: InboxRecord = {
    delivery_id: "20000000-0000-4000-8000-000000000097",
    fingerprint: "synchronous-watchdog",
    epoch: 1,
    attempt: 1,
    claim_token: "40000000-0000-4000-8000-000000000097",
    state: "started",
    origin: undefined,
    updated_at: new Date(0).toISOString(),
  };
  const fenced = new Set<string>();
  const controller = new AbortController();
  const stop = startClaimRenewal(
    {
      clock: new ImmediateTimerClock(),
      fenced,
      claimMonitors: new Map(),
      emitClaimRenewal: () => Promise.resolve(),
    },
    record,
    1_000,
    0,
    controller,
  );

  assert.equal(controller.signal.aborted, true, "a zero watchdog must abort in the arming tick");
  assert.equal(fenced.has(record.delivery_id), true);
  const reason: unknown = controller.signal.reason;
  assert.ok(reason instanceof AdapterError);
  assert.equal(reason.code, "CLAIM_RENEWAL_UNCONFIRMED");
  return stop();
});

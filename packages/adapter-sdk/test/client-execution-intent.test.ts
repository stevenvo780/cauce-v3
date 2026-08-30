import assert from "node:assert/strict";
import test from "node:test";
import {DurableStore} from '../src/sdk/durable-store.js';
import type {ClientFrame} from '../src/sdk/types.js';
import {CountingRunner, FakeConnection, ScriptedConnector, SequenceConnector, makeClient, renewableDelivery, startedAcks, waitUntil} from './client-fixtures.js';

class HangingExecutionIntentConnection extends FakeConnection {
  closeCalls = 0;
  override async send(frame: ClientFrame): Promise<void> {
    await super.send(frame);
    if (frame.type === "ack" && frame.execution_started === true) {
      await new Promise<void>(() => undefined);
    }
  }
  override async close(): Promise<void> {
    this.closeCalls += 1;
    await super.close();
  }
}
test("the harness waits for the exact durable execution-intent receipt", async () => {
  const connection = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const context = await makeClient(
    "execution-intent-gate",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 2_000 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-gate",
      "000000000089",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => startedAcks(connection).some((frame) => frame.execution_started === true));
    const intent = startedAcks(connection).find((frame) => frame.execution_started === true);
    assert.ok(intent);
    assert.equal(runner.calls, 0, "socket send alone must not release the harness");
    assert.equal(
      context.store.getDelivery(input.delivery_id)?.execution_intent_receipt_event_id,
      undefined,
    );

    connection.push({
      type: "ack_result",
      event_id: intent.event_id,
      delivery_id: intent.delivery_id,
      attempt: intent.attempt,
      claim_token: "40000000-0000-4000-8000-000000000099",
      status: "started",
      applied: true,
      receipt: "applied",
    });
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(runner.calls, 0, "a mismatched receipt cannot release the harness");

    connection.push({
      type: "ack_result",
      event_id: intent.event_id,
      delivery_id: intent.delivery_id,
      attempt: intent.attempt,
      claim_token: intent.claim_token,
      status: "started",
      applied: true,
      receipt: "applied",
    });
    await waitUntil(() => runner.calls === 1);
    await waitUntil(() => connection.sent.some((frame) => (
      frame.type === "ack" && frame.delivery_id === input.delivery_id && frame.status === "done"
    )));
    assert.equal(
      context.store.getDelivery(input.delivery_id)?.execution_intent_receipt_event_id,
      intent.event_id,
    );
  } finally {
    stop.abort();
    await running;
  }
});

test("an unconfirmed execution intent times out before invoking the harness", async () => {
  const connection = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const context = await makeClient(
    "execution-intent-timeout",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 500 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-timeout",
      "000000000090",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => connection.sent.some((frame) => (
      frame.type === "ack" && frame.delivery_id === input.delivery_id && frame.status === "failed"
    )), 3_000);
    const failed = connection.sent.find((frame) => (
      frame.type === "ack" && frame.delivery_id === input.delivery_id && frame.status === "failed"
    ));
    assert.equal(runner.calls, 0);
    assert.ok(failed, "expected an ACK frame");
    assert.equal(failed.error_code, "EXECUTION_INTENT_CONFIRMATION_FAILED");
    assert.equal(failed.retryable, true);
  } finally {
    stop.abort();
    await running;
  }
});

test("a receipt cannot release the harness while its transport send never settles", async () => {
  const connection = new HangingExecutionIntentConnection();
  const runner = new CountingRunner();
  const context = await makeClient(
    "execution-intent-hanging-send",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 500 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-hanging-send",
      "000000000081",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => context.store.getDelivery(input.delivery_id)?.state === "failed", 3_000);
    assert.equal(runner.calls, 0, "a remote receipt does not prove the local send completed");
    assert.ok(connection.closeCalls > 0, "the poisoned transport must be closed before reconnect");
    const record = context.store.getDelivery(input.delivery_id);
    assert.ok(record);
    assert.equal(record.error?.code, "EXECUTION_INTENT_CONFIRMATION_FAILED");
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- asserting the same non-nullish property twice across separate frames
    assert.equal(record.error?.retryable, true);
    assert.ok(context.store.pendingEvents().some((event) => (
      event.delivery_id === input.delivery_id && event.phase === "failed"
    )), "the retryable failure must remain durable when the connection cannot flush it");
  } finally {
    stop.abort();
    await running;
  }
});

test("a duplicate execution-intent receipt releases the harness exactly once", async () => {
  const connection = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const context = await makeClient(
    "execution-intent-duplicate",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 2_000 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-duplicate",
      "000000000085",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => startedAcks(connection).some((frame) => frame.execution_started === true));
    const intent = startedAcks(connection).find((frame) => frame.execution_started === true);
    assert.ok(intent);
    connection.push({
      type: "ack_result",
      event_id: intent.event_id,
      delivery_id: intent.delivery_id,
      attempt: intent.attempt,
      claim_token: intent.claim_token,
      status: "started",
      // The real store reports an exact replay as applied:true + duplicate: the lease/fence
      // remains applied even though the ACK event itself was already persisted.
      applied: true,
      receipt: "duplicate",
    });
    await waitUntil(() => runner.calls === 1);
    await waitUntil(() => connection.sent.some((frame) => (
      frame.type === "ack" && frame.delivery_id === input.delivery_id && frame.status === "done"
    )));
    assert.equal(runner.calls, 1);
    assert.equal(
      context.store.getDelivery(input.delivery_id)?.execution_intent_receipt_event_id,
      intent.event_id,
    );
  } finally {
    stop.abort();
    await running;
  }
});

test("reconnect replays the same intent and a duplicate receipt releases it without deadlock", async () => {
  const first = new FakeConnection(1, undefined, false);
  const second = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const connector = new SequenceConnector([first, second]);
  const context = await makeClient(
    "execution-intent-reconnect",
    connector,
    { runner, claimWatchdogMs: 4_000 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => first.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-reconnect",
      "000000000086",
      Date.now() + 30_000,
    );
    first.push(input);
    await waitUntil(() => startedAcks(first).some((frame) => frame.execution_started === true));
    const intent = startedAcks(first).find((frame) => frame.execution_started === true);
    assert.ok(intent);
    assert.equal(runner.calls, 0);
    first.end();

    await waitUntil(() => second.sent.some((frame) => frame.type === "hello"));
    await waitUntil(() => second.sent.some((frame) => (
      frame.type === "ack" && frame.event_id === intent.event_id
    )));
    second.push({
      type: "ack_result",
      event_id: intent.event_id,
      delivery_id: intent.delivery_id,
      attempt: intent.attempt,
      claim_token: intent.claim_token,
      status: "started",
      applied: true,
      receipt: "duplicate",
    });
    await waitUntil(() => runner.calls === 1);
    await waitUntil(() => second.sent.some((frame) => (
      frame.type === "ack" && frame.delivery_id === input.delivery_id && frame.status === "done"
    )));
    assert.equal(runner.calls, 1);
  } finally {
    stop.abort();
    await running;
  }
});

test("an execution-intent receipt fsync failure never releases the harness", async () => {
  const connection = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const errors: string[] = [];
  const context = await makeClient(
    "execution-intent-receipt-fsync",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 500, onError: (code) => errors.push(code) },
  );
  const acknowledgeResult = context.store.acknowledgeResult.bind(context.store);
  Object.defineProperty(context.store, "acknowledgeResult", {
    configurable: true,
    value: async (...args: Parameters<DurableStore["acknowledgeResult"]>) => {
      if (args[1]?.execution_intent_receipt !== undefined) {
        throw new Error("injected execution-intent receipt fsync failure");
      }
      return acknowledgeResult(...args);
    },
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-receipt-fsync",
      "000000000087",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => startedAcks(connection).some((frame) => frame.execution_started === true));
    const intent = startedAcks(connection).find((frame) => frame.execution_started === true);
    assert.ok(intent);
    connection.push({
      type: "ack_result",
      event_id: intent.event_id,
      delivery_id: intent.delivery_id,
      attempt: intent.attempt,
      claim_token: intent.claim_token,
      status: "started",
      applied: true,
      receipt: "applied",
    });
    await waitUntil(() => context.store.getDelivery(input.delivery_id)?.state === "failed", 3_000);
    assert.equal(runner.calls, 0);
    assert.equal(
      context.store.getDelivery(input.delivery_id)?.execution_intent_receipt_event_id,
      undefined,
    );
    assert.ok(errors.length > 0, "the failed reader loop must surface a diagnostic");
  } finally {
    stop.abort();
    await running;
  }
});

test("ownership_lost and superseded intent receipts both fail closed before invocation", async (t) => {
  const variants = [
    { name: "ownership", suffix: "000000000083", status: "retry" as const, receipt: "ownership_lost" as const },
    { name: "superseded", suffix: "000000000084", status: "started" as const, receipt: "superseded" as const },
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const connection = new FakeConnection(1, undefined, false);
      const runner = new CountingRunner();
      const context = await makeClient(
        `execution-intent-${variant.name}`,
        new ScriptedConnector(connection),
        { runner, claimWatchdogMs: 1_000 },
      );
      const stop = new AbortController();
      const running = context.client.run(stop.signal);
      try {
        await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
        const input = renewableDelivery(
          `execution-intent-${variant.name}`,
          variant.suffix,
          Date.now() + 30_000,
        );
        connection.push(input);
        await waitUntil(() => startedAcks(connection).some((frame) => frame.execution_started === true));
        const intent = startedAcks(connection).find((frame) => frame.execution_started === true);
        assert.ok(intent);
        connection.push({
          type: "ack_result",
          event_id: intent.event_id,
          delivery_id: intent.delivery_id,
          attempt: intent.attempt,
          claim_token: intent.claim_token,
          status: variant.status,
          applied: false,
          receipt: variant.receipt,
        });
        await waitUntil(() => context.store.getDelivery(input.delivery_id)?.state === "failed");
        assert.equal(runner.calls, 0);
      } finally {
        stop.abort();
        await running;
      }
    });
  }
});

test("a global fenced frame rejects the execution gate before invocation", async () => {
  const connection = new FakeConnection(1, undefined, false);
  const runner = new CountingRunner();
  const context = await makeClient(
    "execution-intent-global-fenced",
    new ScriptedConnector(connection),
    { runner, claimWatchdogMs: 1_000 },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const input = renewableDelivery(
      "execution-intent-global-fenced",
      "000000000088",
      Date.now() + 30_000,
    );
    connection.push(input);
    await waitUntil(() => startedAcks(connection).some((frame) => frame.execution_started === true));
    connection.push({ type: "error", code: "fenced", message: "connection epoch is no longer current" });
    await waitUntil(() => context.store.getDelivery(input.delivery_id)?.state === "failed");
    assert.equal(runner.calls, 0);
  } finally {
    stop.abort();
    await running;
  }
});


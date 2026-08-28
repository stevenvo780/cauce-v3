import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HarnessAdapter, claudeDefinition, fakeDefinition } from "../src/harnesses/index.js";
import { ExponentialBackoff } from "../src/sdk/backoff.js";
import {
  AdapterClient, capabilityStrings, siembraAplicada, siembraHabilitada,
} from "../src/sdk/client.js";
import { ConsumerLease, DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError, StaleEpochError } from "../src/sdk/errors.js";
import type {
  ClientFrame,
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  ConsumerConnection,
  ConsumerConnector,
  DeliveryEvent,
  HarnessDefinition,
  ServerFrame,
} from "../src/sdk/types.js";
import {
  root,
  CountingRunner,
  FakeConnection,
  HelloAgentProfile,
  NoopRunner,
  ScriptedConnector,
  SequenceConnector,
  makeClient,
  renewableDelivery,
  waitUntil,
} from "./client-fixtures.js";
test("pending durable outbox is replayed after hello_ack", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection);
  const context = await makeClient("outbox-replay", connector);
  const event: DeliveryEvent = {
    event_id: "50000000-0000-4000-8000-000000000001",
    delivery_id: "20000000-0000-4000-8000-000000000001",
    attempt: 1,
    claim_token: "20000000-0000-4000-8000-000000000001",
    epoch: 1,
    phase: "accepted",
    occurred_at: new Date(0).toISOString(),
    origin: { adapter: "test", channel: "test", conversation_id: "origin", relay: [], metadata: {} },
  };
  await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  await waitUntil(() => connection.sent.some((frame) => frame.type === "ack"));
  const ack = connection.sent.find((frame) => frame.type === "ack");
  assert.equal(ack?.type, "ack");
  if (ack?.type === "ack") {
    assert.equal(ack.event_id, event.event_id);
    assert.equal(ack.attempt, event.attempt);
    assert.equal(ack.claim_token, event.claim_token);
  }
  stop.abort();
  await running;
});

test("structured adapter errors are propagated on the ACK without changing retryability", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection);
  const context = await makeClient("structured-error-code", connector);
  const event: DeliveryEvent = {
    event_id: "50000000-0000-4000-8000-000000000004",
    delivery_id: "20000000-0000-4000-8000-000000000004",
    attempt: 1,
    claim_token: "20000000-0000-4000-8000-000000000004",
    epoch: 1,
    phase: "failed",
    occurred_at: new Date(0).toISOString(),
    error: {
      code: "EXECUTION_TIMEOUT_AMBIGUOUS",
      message: "execution may have completed before timeout",
      retryable: false,
    },
  };
  await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  await waitUntil(() => connection.sent.some((frame) => frame.type === "ack"));
  const ack = connection.sent.find((frame) => frame.type === "ack");
  assert.equal(ack?.type, "ack");
  if (ack?.type === "ack") {
    assert.equal(ack.error_code, event.error?.code);
    assert.equal(ack.error, event.error?.message);
    assert.equal(ack.retryable, false);
  }
  stop.abort();
  await running;
});

test("ack_result removes only its exact event correlation, independent of order", async () => {
  const connection = new FakeConnection(1);
  const context = await makeClient("ack-correlation", new ScriptedConnector(connection));
  const first: DeliveryEvent = {
    event_id: "50000000-0000-4000-8000-000000000002",
    delivery_id: "20000000-0000-4000-8000-000000000002",
    attempt: 1,
    claim_token: "20000000-0000-4000-8000-000000000001",
    epoch: 1,
    phase: "failed",
    occurred_at: new Date(0).toISOString(),
  };
  const second: DeliveryEvent = {
    ...first,
    event_id: "50000000-0000-4000-8000-000000000003",
    attempt: 2,
    claim_token: "20000000-0000-4000-8000-000000000002",
    phase: "accepted",
  };
  await context.store.enqueue(first);
  await context.store.enqueue(second);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  await waitUntil(() => connection.sent.filter((frame) => frame.type === "ack").length === 2);

  connection.push({
    type: "ack_result",
    event_id: second.event_id,
    delivery_id: second.delivery_id,
    attempt: second.attempt,
    claim_token: second.claim_token,
    status: "accepted",
    applied: true,
  });
  await waitUntil(() => context.store.pendingEvents().length === 1);
  assert.equal(context.store.pendingEvents()[0]?.event_id, first.event_id);

  connection.push({
    type: "ack_result",
    event_id: first.event_id,
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: second.claim_token,
    status: "retry",
    applied: false,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  assert.equal(context.store.pendingEvents()[0]?.event_id, first.event_id);

  connection.push({
    type: "ack_result",
    event_id: first.event_id,
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    status: "retry",
    applied: true,
  });
  await waitUntil(() => context.store.pendingEvents().length === 0);
  stop.abort();
  await running;
});

test("terminal ack_result persists exact delegation feedback atomically without losing sibling events", async () => {
  const connection = new FakeConnection(1);
  const context = await makeClient("ack-delegation-feedback", new ScriptedConnector(connection));
  await context.store.activateEpoch(1);
  const input = renewableDelivery("ack-delegation-feedback", "000000000077", Date.now() + 30_000);
  const accepted = await context.store.acceptAndEnqueue(input, new Date().toISOString());
  assert.ok(accepted.event);
  const output = {
    reply: "delegated",
    messages: [
      { to: "socrates", body: "first" },
      { to: "invalid alias", body: "reject" },
      { to: "socrates", body: "second" },
    ],
    notify: [],
    status: "done" as const,
    retryable: false,
    artifacts: [],
  };
  const done = await context.store.transitionAndEnqueue(
    input.delivery_id,
    "done",
    new Date().toISOString(),
    { output, attempt: input.attempt, claimToken: input.claim_token, retainRequest: true },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  await waitUntil(() => connection.sent.filter((frame) => frame.type === "ack").length === 2);

  const materializations = [{
    output_index: 0,
    target_tenant: "Steven" as const,
    target_alias: "socrates",
    child_delivery_id: "70000000-0000-4000-8000-000000000077",
  }, {
    output_index: 2,
    target_tenant: "Steven" as const,
    target_alias: "socrates",
    child_delivery_id: "70000000-0000-4000-8000-000000000078",
  }];
  const rejections = [{
    output_index: 1,
    target: "invalid alias",
    code: "unroutable_alias" as const,
    reason: "The requested target is not routable.",
    guidance: "Choose a target advertised by the trusted routing inventory.",
  }];
  connection.push({
    type: "ack_result",
    event_id: done.event.event_id,
    delivery_id: done.event.delivery_id,
    attempt: done.event.attempt,
    claim_token: done.event.claim_token,
    status: "done",
    applied: true,
    receipt: "applied",
    delegation_rejections: rejections,
    delegation_materializations: materializations,
  });
  await waitUntil(() => !context.store.pendingEvents().some(
    (event) => event.event_id === done.event.event_id,
  ));
  assert.deepEqual(
    context.store.pendingEvents().map((event) => event.event_id),
    [accepted.event.event_id],
  );
  assert.deepEqual(context.store.getDelivery(input.delivery_id)?.delegation_rejections, rejections);
  assert.deepEqual(
    context.store.getDelivery(input.delivery_id)?.delegation_materializations,
    materializations,
  );

  stop.abort();
  await running;
  const reopened = await DurableStore.open(context.directory);
  assert.deepEqual(reopened.getDelivery(input.delivery_id)?.delegation_rejections, rejections);
  assert.deepEqual(reopened.getDelivery(input.delivery_id)?.delegation_materializations, materializations);
  assert.deepEqual(reopened.pendingEvents().map((event) => event.event_id), [accepted.event.event_id]);
});

test("an inconclusive terminal result stays durable and ownership_lost releases the next attempt", async () => {
  const connection = new FakeConnection(1);
  const runner = new CountingRunner();
  const context = await makeClient(
    "terminal-replay-ownership",
    new ScriptedConnector(connection),
    { runner },
  );
  await context.store.activateEpoch(1);
  const input = renewableDelivery(
    "terminal-replay-ownership",
    "000000000079",
    Date.now() + 30_000,
  );
  const accepted = await context.store.acceptAndEnqueue(input, new Date().toISOString());
  assert.ok(accepted.event);
  await context.store.acknowledge(accepted.event);
  const done = await context.store.transitionAndEnqueue(
    input.delivery_id,
    "done",
    new Date().toISOString(),
    {
      output: {
        reply: "completed before the ACK frame was lost",
        messages: [],
        notify: [],
        status: "done",
        retryable: false,
        artifacts: [],
      },
      attempt: input.attempt,
      claimToken: input.claim_token,
    },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack" && frame.event_id === done.event.event_id,
    ));
    connection.push({
      type: "ack_result",
      event_id: done.event.event_id,
      delivery_id: done.event.delivery_id,
      attempt: done.event.attempt,
      claim_token: done.event.claim_token,
      status: "done",
      applied: false,
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(
      context.store.pendingEvents().some((event) => event.event_id === done.event.event_id),
      true,
      "an old gateway without a conclusive receipt must not delete a terminal result",
    );

    connection.push({
      type: "ack_result",
      event_id: done.event.event_id,
      delivery_id: done.event.delivery_id,
      attempt: done.event.attempt,
      claim_token: done.event.claim_token,
      status: "done",
      applied: false,
      receipt: "ownership_lost",
    });
    await waitUntil(() => !context.store.pendingEvents().some(
      (event) => event.event_id === done.event.event_id,
    ));
    assert.deepEqual(context.store.getDelivery(input.delivery_id)?.error, {
      code: "TERMINAL_ACK_OWNERSHIP_LOST",
      message: "The durable relay rejected this terminal result because claim ownership was lost",
      retryable: true,
    });

    const retry = {
      ...input,
      event_id: "30000000-0000-4000-8000-000000000080",
      attempt: 2,
      claim_token: "40000000-0000-4000-8000-000000000080",
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    };
    connection.push(retry);
    await waitUntil(() => runner.calls === 1);
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === retry.delivery_id
        && frame.attempt === 2
        && frame.status === "done",
    ));
    assert.equal(context.store.getDelivery(input.delivery_id)?.attempt, 2);
    assert.equal(context.store.getDelivery(input.delivery_id)?.state, "done");
  } finally {
    stop.abort();
    await running;
  }
});


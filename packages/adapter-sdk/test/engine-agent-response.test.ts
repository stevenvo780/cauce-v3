import assert from "node:assert/strict";
import test from "node:test";
import {HarnessAdapter, fakeDefinition} from '../src/harnesses/index.js';
import { DurableStore } from "../src/sdk/durable-store.js";
import {AdapterEngine} from '../src/sdk/engine.js';
import type {CancelDelivery, CommandRunResult, CommandRunner, Delivery, DeliveryEvent} from '../src/sdk/types.js';
import {ControlledRunner, delivery, setup, storeFor} from './engine-fixtures.js';
test("un 'done' sin reply ni delegacion falla, pero deja texto que la persona puede leer", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: null,
    messages: [],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-agent-response-missing-reply", runner);
  const input: Delivery = {
    ...delivery("agent-response-missing-reply"),
    actor_alias: "seneca",
    recipient_alias: "jarvis",
    body: { type: "agent.response", text: "seneca result" },
    routing_targets: [{ tenant_id: "Steven", alias: "socrates", online: true }],
  };
  await context.engine.handleDelivery(input);
  const terminal = context.events.at(-1);
  assert.equal(terminal?.phase, "failed");
  // The code used to be MISSING_FINAL_REPLY and the event travelled WITHOUT `output`. That left
  // `deliveries.result` as NULL and `agentResponseText` with nothing to read: the sender received
  // silence.  the four questions from Miguel to janus on 27-jul stayed
  // like that, `failed` with `result` NULL and no follow-up.
  assert.equal(terminal?.error?.code, "HARNESS_REPORTED_FAILURE");
  assert.equal(terminal?.error?.retryable, false);
  assert.equal(context.store.getDelivery(input.delivery_id)?.state, "failed");
  assert.equal(context.events.some((event) => event.phase === "done"), false);
  // What makes this useful for a human: the terminal event CARRIES output with text, which is
  // where `agentResponseText` (packages/store) pulls the body of the reply message from.
  assert.equal(terminal?.output?.status, "failed");
  assert.match(terminal?.output?.reply ?? "", /Volve a preguntarme/u);
});

test("reply null remains valid when an agent response delegates to a different agent", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: null,
    messages: [{ to: "socrates", body: "independently verify this result" }],
    status: "done",
    retryable: false,
    artifacts: [],
  });
  const context = await setup("engine-agent-response-delegates", runner);
  const input: Delivery = {
    ...delivery("agent-response-delegates"),
    actor_alias: "seneca",
    recipient_alias: "jarvis",
    body: { type: "agent.response", text: "seneca result" },
    routing_targets: [{ tenant_id: "Steven", alias: "socrates", online: true }],
  };
  await context.engine.handleDelivery(input);
  const terminal = context.events.at(-1);
  assert.equal(terminal?.phase, "done");
  assert.equal(terminal?.output?.reply, null);
  assert.equal(terminal?.output?.messages[0]?.to, "socrates");
});

test("stale delivery epoch is rejected and never reaches a harness", async () => {
  const context = await setup("engine-stale");
  await context.engine.activateEpoch(2);
  await context.engine.handleDelivery(delivery("stale-1", 1));
  assert.equal(context.runner.calls, 0);
  assert.equal(context.events[0]?.phase, "failed");
  assert.equal(context.events[0]?.error?.code, "STALE_EPOCH");
  assert.equal(context.events[0]?.epoch, 2);
});

test("relay cancellation aborts the injected runner and emits failed", async () => {
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const context = await setup("engine-cancel", runner);
  const running = context.engine.handleDelivery(delivery("cancel-1"));
  while (runner.calls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  const cancel: CancelDelivery = { type: "cancel", delivery_id: "cancel-1", epoch: 1 };
  await context.engine.cancel(cancel);
  await running;
  assert.equal(context.events.at(-1)?.phase, "failed");
  assert.equal(context.events.at(-1)?.error?.code, "EXECUTION_CANCELLED_AMBIGUOUS");
  assert.equal(context.events.at(-1)?.error?.retryable, false);
});

test("ambiguous execution timeout is terminal and a higher attempt is never run automatically", async () => {
  class TimeoutRunner implements CommandRunner {
    calls = 0;

    async run(): Promise<CommandRunResult> {
      this.calls += 1;
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
        cancelled: false,
      };
    }
  }

  const runner = new TimeoutRunner();
  const store = await storeFor("engine-ambiguous-timeout");
  await store.activateEpoch(1);
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    executionIntentMode: "local-test-only",
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });
  const first = delivery("ambiguous-timeout", 1, 1);
  await engine.handleDelivery(first);
  const failed = events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "EXECUTION_TIMEOUT_AMBIGUOUS");
  assert.equal(failed?.error?.retryable, false);

  await engine.handleDelivery(delivery("ambiguous-timeout", 1, 2));
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "failed");
});

test("agent timeout is independent from the short renewable ACK lease", async () => {
  const runner = new ControlledRunner();
  const context = await setup("engine-ack-budget-cap", runner);
  const input: Delivery = {
    ...delivery("ack-budget-cap"),
    ack_deadline_at: new Date(Date.now() + 600_000).toISOString(),
    body: { prompt: "bounded work", timeout_ms: 1_800_000 },
  };

  await context.engine.handleDelivery(input);

  assert.equal(runner.requests[0]?.timeoutMs, 1_800_000);
  assert.equal(context.events.at(-1)?.phase, "done");
});

test("an exhausted ACK budget fails before starting a harness", async () => {
  const runner = new ControlledRunner();
  const context = await setup("engine-ack-budget-exhausted", runner);
  const input: Delivery = {
    ...delivery("ack-budget-exhausted"),
    ack_deadline_at: new Date(Date.now() + 500).toISOString(),
    body: { prompt: "must not start", timeout_ms: 60_000 },
  };

  await context.engine.handleDelivery(input);

  assert.equal(runner.calls, 0);
  assert.deepEqual(
    context.events.map((event) => event.phase),
    ["accepted", "failed"],
  );
  assert.equal(context.events.at(-1)?.error?.code, "ACK_DEADLINE_BUDGET_EXHAUSTED");
  assert.equal(context.events.at(-1)?.error?.retryable, true);
});

test("a failure before started never creates a renewal timer", async () => {
  const context = await setup("engine-renewal-transition-fault");
  const transition = context.store.transitionAndEnqueue.bind(context.store);
  Object.defineProperty(context.store, "transitionAndEnqueue", {
    configurable: true,
    value: async (...args: Parameters<DurableStore["transitionAndEnqueue"]>) => {
      if (args[1] === "started") throw new Error("injected transition failure");
      return transition(...args);
    },
  });
  await assert.rejects(
    context.engine.handleDelivery(delivery("renewal-transition-fault")),
    /injected transition failure/u,
  );
  const eventCount = context.events.length;
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(context.events.length, eventCount);
});


import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterEngine } from "../src/sdk/engine.js";
import type {
  CancelDelivery,
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  Delivery,
  DeliveryEvent,
} from "../src/sdk/types.js";

const root = resolve(".test-state");

async function storeFor(name: string): Promise<DurableStore> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

function claimToken(attempt: number, variant = 0): string {
  return `20000000-0000-4000-${8000 + variant}-${String(attempt).padStart(12, "0")}`;
}

function delivery(id: string, epoch = 1, attempt = 1, claim = claimToken(attempt)): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: `trace-${id}`,
    epoch,
    attempt,
    claim_token: claim,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: "argos",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-42",
      external_message_id: "message-9",
      relay: [],
      metadata: {},
    },
    authenticated_context: {
      session_id: "session-42",
      channel: "telegram",
      origin: {
        adapter: "telegram",
        channel: "telegram",
        conversation_id: "room-42",
        external_message_id: "message-9",
        relay: [],
        metadata: {},
      },
    },
    body: { prompt: "perform the task", timeout_ms: 2_000, session_key: "thread-1" },
  };
}

const SUCCESS = JSON.stringify({
  reply: "completed",
  messages: [{ to: "audit", body: "done" }],
  status: "done",
  retryable: false,
  artifacts: [],
});

class ControlledRunner implements CommandRunner {
  calls = 0;
  readonly requests: CommandRunRequest[] = [];
  blockUntilAbort = false;
  stdout = SUCCESS;
  onRun: (() => void) | undefined;

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    this.requests.push(request);
    this.onRun?.();
    if (this.blockUntilAbort) {
      await new Promise<void>((resolveWait) => {
        if (request.signal.aborted) resolveWait();
        else request.signal.addEventListener("abort", () => resolveWait(), { once: true });
      });
      return {
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
      };
    }
    return {
      stdout: this.stdout,
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

async function setup(name: string, runner = new ControlledRunner()): Promise<{
  store: DurableStore;
  runner: ControlledRunner;
  events: DeliveryEvent[];
  engine: AdapterEngine;
}> {
  const store = await storeFor(name);
  const events: DeliveryEvent[] = [];
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner, store });
  const engine = new AdapterEngine({
    store,
    harness,
    publish: async (event) => {
      events.push(event);
    },
  });
  await engine.activateEpoch(1);
  return { store, runner, events, engine };
}

test("accepted is durable and published before started and execution", async () => {
  const context = await setup("engine-order");
  let phasesAtRun: string[] = [];
  context.runner.onRun = () => {
    phasesAtRun = context.events.map((event) => event.phase);
  };
  await context.engine.handleDelivery(delivery("order-1"));
  assert.deepEqual(phasesAtRun, ["accepted", "started"]);
  assert.deepEqual(
    context.events.map((event) => event.phase),
    ["accepted", "started", "done"],
  );
  assert.equal(context.store.getDelivery("order-1")?.state, "done");
  assert.deepEqual(
    context.store.pendingEvents().map((event) => event.phase),
    ["accepted", "started", "done"],
  );
});

test("confirmed terminal delivery is neither executed nor published twice", async () => {
  const context = await setup("engine-duplicate");
  const input = delivery("duplicate-1");
  await context.engine.handleDelivery(input);
  for (const event of context.store.pendingEvents()) await context.store.acknowledge(event);
  const published = context.events.length;
  await context.engine.handleDelivery(input);
  assert.equal(context.runner.calls, 1);
  assert.equal(context.events.length, published);
  assert.equal(context.store.pendingEvents().length, 0);
});

test("terminal output preserves delivery origin for relay routing", async () => {
  const context = await setup("engine-origin");
  await context.engine.handleDelivery(delivery("origin-1"));
  const done = context.events.find((event) => event.phase === "done");
  assert.deepEqual(done?.origin, {
    adapter: "telegram",
    channel: "telegram",
    conversation_id: "room-42",
    external_message_id: "message-9",
    relay: [],
    metadata: {},
  });
  assert.equal(done?.output?.reply, "completed");
  assert.equal(done?.output?.messages[0]?.to, "audit");
});

test("harness prompt receives authenticated origin context", async () => {
  const context = await setup("engine-authenticated-origin");
  const input: Delivery = {
    ...delivery("authenticated-origin"),
    authenticated_context: {
      session_id: "trusted-session",
      channel: "trusted-channel",
      origin: {
        adapter: "trusted-adapter",
        channel: "trusted-channel",
        conversation_id: "trusted-conversation",
        relay: [],
        metadata: {},
      },
    },
  };
  await context.engine.handleDelivery(input);
  assert.match(context.runner.requests[0]?.stdin ?? "", /trusted-adapter/u);
  assert.match(context.runner.requests[0]?.stdin ?? "", /TRUSTED ORIGIN CONTEXT/u);
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
  assert.equal(context.events.at(-1)?.error?.code, "CANCELLED");
});

test("advancing the fencing epoch aborts old work as retryable", async () => {
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const context = await setup("engine-fence", runner);
  const running = context.engine.handleDelivery(delivery("fence-1"));
  while (runner.calls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  await context.engine.activateEpoch(2);
  await running;
  const failed = context.events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.code, "FENCED");
  assert.equal(failed?.error?.retryable, true);
  assert.equal(failed?.epoch, 2);
});

test("outbox removes events only after relay ACK", async () => {
  const context = await setup("engine-ack");
  await context.engine.handleDelivery(delivery("ack-1"));
  const pending = context.store.pendingEvents();
  assert.equal(pending.length, 3);
  const first = pending[0];
  assert.ok(first);
  assert.equal(await context.store.acknowledge(first), true);
  assert.equal(context.store.pendingEvents().length, 2);
  assert.equal(await context.store.acknowledge({
    ...first,
    event_id: "00000000-0000-4000-8000-000000000000",
  }), false);
});

test("structured retryable failure becomes a retryable failed lifecycle event", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-retryable", runner);
  await context.engine.handleDelivery(delivery("retryable-1"));
  const failed = context.events.at(-1);
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.error?.retryable, true);
  assert.equal(failed?.output?.status, "failed");
});

test("recovery fails previously started work rather than executing it twice", async () => {
  const store = await storeFor("engine-recovery");
  await store.activateEpoch(1);
  const input = delivery("recover-1");
  await store.accept(input, new Date().toISOString());
  await store.transition(input.delivery_id, "started", new Date().toISOString(), { retainRequest: true });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => {
      events.push(event);
    },
  });
  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.equal(events[0]?.error?.code, "INTERRUPTED");
  assert.equal(store.getDelivery(input.delivery_id)?.state, "failed");
});

test("reconnect recovery leaves a currently owned process running", async () => {
  const runner = new ControlledRunner();
  runner.blockUntilAbort = true;
  const context = await setup("engine-live-recovery", runner);
  const running = context.engine.handleDelivery(delivery("live-recovery-1"));
  while (runner.calls === 0) await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  await context.engine.recover();
  assert.equal(runner.calls, 1);
  assert.equal(context.events.some((event) => event.error?.code === "INTERRUPTED"), false);
  await context.engine.cancel({ type: "cancel", delivery_id: "live-recovery-1", epoch: 1 });
  await running;
});

test("retryable failure executes one higher attempt but never the same attempt twice", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "temporary outage",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-attempt-retry", runner);
  const first = delivery("attempt-retry", 1, 1);
  await context.engine.handleDelivery(first);
  await context.engine.handleDelivery(first);
  assert.equal(runner.calls, 1);

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(delivery("attempt-retry", 1, 2, first.claim_token));
  assert.equal(runner.calls, 1);
  const second = delivery("attempt-retry", 1, 2);
  await context.engine.handleDelivery(second);
  await context.engine.handleDelivery(second);
  assert.equal(runner.calls, 2);
  assert.equal(context.store.getDelivery(second.delivery_id)?.attempt, 2);
  assert.equal(context.store.getDelivery(second.delivery_id)?.state, "done");
});

test("delayed attempt-one ACK cannot acknowledge attempt-two events", async () => {
  const runner = new ControlledRunner();
  runner.stdout = JSON.stringify({
    reply: "retry",
    messages: [],
    status: "failed",
    retryable: true,
    artifacts: [],
  });
  const context = await setup("engine-delayed-ack", runner);
  await context.engine.handleDelivery(delivery("delayed-ack", 1, 1));
  const oldTerminal = context.store.pendingEvents().find((event) => event.attempt === 1 && event.phase === "failed");
  assert.ok(oldTerminal);

  runner.stdout = SUCCESS;
  await context.engine.handleDelivery(delivery("delayed-ack", 1, 2));
  const currentAccepted = context.store.pendingEvents().find((event) => event.attempt === 2 && event.phase === "accepted");
  assert.ok(currentAccepted);
  assert.equal(await context.store.acknowledge(oldTerminal), true);
  assert.equal(context.store.pendingEvents().some((event) => event.event_id === currentAccepted.event_id), true);
});

test("crash recovery marks started interrupted and permits redelivery at next attempt", async () => {
  const store = await storeFor("engine-crash-redelivery");
  await store.activateEpoch(1);
  const first = delivery("crash-redelivery", 1, 1);
  await store.accept(first, new Date().toISOString());
  await store.transition(first.delivery_id, "started", new Date().toISOString(), {
    retainRequest: true,
    attempt: first.attempt,
    claimToken: first.claim_token,
  });
  const runner = new ControlledRunner();
  const events: DeliveryEvent[] = [];
  const engine = new AdapterEngine({
    store,
    harness: new HarnessAdapter({ definition: fakeDefinition, runner, store }),
    publish: async (event) => { events.push(event); },
  });

  await engine.recover();
  assert.equal(runner.calls, 0);
  assert.equal(events.at(-1)?.error?.code, "INTERRUPTED");
  assert.equal(events.at(-1)?.error?.retryable, true);
  await engine.handleDelivery(delivery("crash-redelivery", 1, 2));
  assert.equal(runner.calls, 1);
  assert.equal(store.getDelivery(first.delivery_id)?.state, "done");
  assert.equal(store.getDelivery(first.delivery_id)?.attempt, 2);
});

test("out-of-order event receipts correlate by full event identity", async () => {
  const context = await setup("engine-event-correlation");
  await context.engine.handleDelivery(delivery("event-correlation"));
  const [accepted, started, done] = context.store.pendingEvents();
  assert.ok(accepted && started && done);
  assert.equal(await context.store.acknowledge(done), true);
  assert.deepEqual(context.store.pendingEvents().map((event) => event.event_id), [accepted.event_id, started.event_id]);
  assert.equal(await context.store.acknowledge(accepted), true);
  assert.deepEqual(context.store.pendingEvents().map((event) => event.event_id), [started.event_id]);
});

test("same untrusted session label is isolated across authenticated tenants", async () => {
  const context = await setup("engine-tenant-session");
  const steven = delivery("tenant-session-a");
  const miguel: Delivery = {
    ...delivery("tenant-session-b"),
    tenant_id: "Miguel",
    body: { prompt: "perform the task", session_key: "thread-1" },
  };
  await context.engine.handleDelivery(steven);
  await context.engine.handleDelivery(miguel);
  const firstSession = context.runner.requests[0]?.args.at(-1);
  const secondSession = context.runner.requests[1]?.args.at(-1);
  assert.ok(firstSession && secondSession);
  assert.notEqual(firstSession, secondSession);
});

test("body session_key cannot select a different authenticated session", async () => {
  const context = await setup("engine-untrusted-session-key");
  const first: Delivery = {
    ...delivery("untrusted-session-a"),
    body: { prompt: "perform the task", session_key: "attacker-label-a" },
  };
  const second: Delivery = {
    ...delivery("untrusted-session-b"),
    body: { prompt: "perform the task", session_key: "attacker-label-b" },
  };
  await context.engine.handleDelivery(first);
  await context.engine.handleDelivery(second);
  assert.equal(context.runner.requests[0]?.args.at(-1), context.runner.requests[1]?.args.at(-1));
});

test("stale claim token neither executes nor acknowledges the current event", async () => {
  const context = await setup("engine-stale-claim");
  const current = delivery("stale-claim", 1, 1);
  await context.engine.handleDelivery(current);
  const terminal = context.store.pendingEvents().find((event) => event.phase === "done");
  assert.ok(terminal);
  assert.equal(await context.store.acknowledge({ ...terminal, claim_token: claimToken(1, 1) }), false);
  assert.equal(context.store.pendingEvents().some((event) => event.event_id === terminal.event_id), true);

  await context.engine.handleDelivery(delivery("stale-claim", 1, 1, claimToken(1, 1)));
  assert.equal(context.runner.calls, 1);
});

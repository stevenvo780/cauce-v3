import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HarnessAdapter, fakeDefinition } from "../src/harnesses/index.js";
import { ExponentialBackoff } from "../src/sdk/backoff.js";
import { AdapterClient } from "../src/sdk/client.js";
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
  ServerFrame,
} from "../src/sdk/types.js";

const root = resolve(".test-state");

class NoopRunner implements CommandRunner {
  async run(_request: CommandRunRequest): Promise<CommandRunResult> {
    return {
      stdout: JSON.stringify({
        reply: "ok",
        messages: [],
        status: "done",
        retryable: false,
        artifacts: [],
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
    };
  }
}

class FakeConnection implements ConsumerConnection {
  readonly mode = "consumer" as const;
  readonly ephemeral = false as const;
  readonly sent: ClientFrame[] = [];
  private readonly queued: ServerFrame[] = [];
  private readonly waiters: Array<(value: IteratorResult<ServerFrame>) => void> = [];
  private ended = false;

  constructor(private readonly welcomeEpoch = 1) {}

  async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
    if (frame.type === "hello") this.push({
      type: "hello_ack", version: "3.0", epoch: this.welcomeEpoch,
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
    });
  }

  push(frame: ServerFrame): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.queued.push(frame);
    else waiter({ value: frame, done: false });
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  frames(): AsyncIterable<ServerFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<ServerFrame>> => {
          const value = this.queued.shift();
          if (value !== undefined) return { value, done: false };
          if (this.ended) return { value: undefined, done: true };
          return new Promise((resolveWait) => this.waiters.push(resolveWait));
        },
      }),
    };
  }

  async close(): Promise<void> {
    this.end();
  }
}

class ScriptedConnector implements ConsumerConnector {
  calls = 0;
  constructor(
    private readonly connection: ConsumerConnection,
    private readonly failures = 0,
  ) {}

  async connect(_signal: AbortSignal): Promise<ConsumerConnection> {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error("planned connect failure");
    return this.connection;
  }
}

async function makeClient(
  name: string,
  connector: ConsumerConnector,
  options: { heartbeatMs?: number; epoch?: number } = {},
): Promise<{ client: AdapterClient; store: DurableStore; directory: string }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  if (options.epoch !== undefined) await store.activateEpoch(options.epoch);
  const harness = new HarnessAdapter({ definition: fakeDefinition, runner: new NoopRunner(), store });
  return {
    directory,
    store,
    client: new AdapterClient({
      config: {
        tenantId: "Steven",
        alias: `agent_${name.replaceAll("-", "_")}`.slice(0, 60),
        instanceId: `instance-${name}`,
        stateDirectory: directory,
        heartbeatMs: options.heartbeatMs ?? 10_000,
        reconnect: { initialMs: 1, maxMs: 2, factor: 2, jitter: 0 },
      },
      connector,
      store,
      harness,
    }),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

test("connect retries with backoff then sends hello on one consumer connection", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection, 1);
  const { client } = await makeClient("reconnect", connector);
  const stop = new AbortController();
  const running = client.run(stop.signal);
  await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
  const hello = connection.sent.find((frame) => frame.type === "hello");
  assert.equal(connector.calls, 2);
  assert.equal(hello?.type, "hello");
  if (hello?.type === "hello") {
    assert.equal(hello.alias, "agent_reconnect");
    assert.equal(hello.instance_id, "instance-reconnect");
    assert.equal(hello.capabilities.includes("harness.fake"), true);
  }
  stop.abort();
  await running;
});

test("heartbeat uses the established consumer instead of an ephemeral socket", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection);
  const { client } = await makeClient("heartbeat", connector, { heartbeatMs: 5 });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  await waitUntil(() => connection.sent.some((frame) => frame.type === "heartbeat"));
  assert.equal(connector.calls, 1);
  const heartbeat = connection.sent.find((frame) => frame.type === "heartbeat");
  assert.equal(heartbeat?.type, "heartbeat");
  stop.abort();
  await running;
});

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

test("stale hello epoch is fenced without reconnecting", async () => {
  const connection = new FakeConnection(1);
  const connector = new ScriptedConnector(connection);
  const { client } = await makeClient("stale-welcome", connector, { epoch: 2 });
  await assert.rejects(client.run(new AbortController().signal), (error: unknown) => error instanceof StaleEpochError);
  assert.equal(connector.calls, 1);
});

test("consumer lease prohibits a second process owner for a stable alias", async () => {
  const directory = resolve(root, "lease");
  await rm(directory, { recursive: true, force: true });
  const first = await ConsumerLease.acquire(directory, "stable_agent", "instance-one");
  await assert.rejects(ConsumerLease.acquire(directory, "stable_agent", "instance-two"));
  await first.release();
  const replacement = await ConsumerLease.acquire(directory, "stable_agent", "instance-two");
  await replacement.release();
});

test("stable aliases reject an ephemeral transport before hello", async () => {
  const sent: ClientFrame[] = [];
  const ephemeral = {
    mode: "consumer",
    ephemeral: true,
    send: async (frame: ClientFrame) => {
      sent.push(frame);
    },
    frames: () => ({
      async *[Symbol.asyncIterator]() {
        return;
      },
    }),
    close: async () => undefined,
  } as unknown as ConsumerConnection;
  const connector = new ScriptedConnector(ephemeral);
  const { client } = await makeClient("ephemeral-rejected", connector);
  await assert.rejects(
    client.run(new AbortController().signal),
    (error: unknown) => error instanceof AdapterError && error.code === "EPHEMERAL_CONNECTION",
  );
  assert.equal(sent.length, 0);
  assert.equal(connector.calls, 1);
});

test("exponential reconnect backoff is capped and jittered deterministically", () => {
  const backoff = new ExponentialBackoff(
    { initialMs: 100, maxMs: 250, factor: 2, jitter: 0.1 },
    () => 0,
  );
  assert.deepEqual([backoff.nextDelay(), backoff.nextDelay(), backoff.nextDelay()], [90, 180, 225]);
  backoff.reset();
  assert.equal(backoff.nextDelay(), 90);
});

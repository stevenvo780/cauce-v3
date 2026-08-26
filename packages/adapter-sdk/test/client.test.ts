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

type HelloAgentProfile = NonNullable<Extract<ServerFrame, { type: "hello_ack" }>["agent_profile"]>;

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

class CountingRunner extends NoopRunner {
  calls = 0;

  override async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.calls += 1;
    return super.run(request);
  }
}

class BlockingRunner implements CommandRunner {
  started = false;
  aborted = false;
  private settle: (() => void) | undefined;

  async run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.started = true;
    let abort: () => void = () => undefined;
    await new Promise<void>((resolveWait) => {
      let settled = false;
      this.settle = () => {
        if (settled) return;
        settled = true;
        resolveWait();
      };
      abort = () => {
        this.aborted = true;
        this.settle?.();
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    });
    request.signal.removeEventListener("abort", abort);
    this.settle = undefined;
    if (!this.aborted) {
      return {
        stdout: JSON.stringify({
          reply: "completed after confirmed renewals",
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
    return {
      stdout: "",
      stderr: "",
      exitCode: null,
      signal: null,
      timedOut: false,
      cancelled: true,
    };
  }

  complete(): void {
    assert.ok(this.settle, "Harness execution is not blocked");
    this.settle();
  }
}

class FakeConnection implements ConsumerConnection {
  readonly mode = "consumer" as const;
  readonly ephemeral = false as const;
  readonly sent: ClientFrame[] = [];
  private readonly queued: ServerFrame[] = [];
  private readonly waiters: Array<(value: IteratorResult<ServerFrame>) => void> = [];
  private ended = false;

  constructor(
    private readonly welcomeEpoch = 1,
    private readonly agentProfile?: HelloAgentProfile,
    private readonly autoConfirmExecutionIntent = true,
  ) {}

  async send(frame: ClientFrame): Promise<void> {
    this.sent.push(frame);
    if (frame.type === "hello") this.push({
      type: "hello_ack", version: "3.0", epoch: this.welcomeEpoch,
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      ...(this.agentProfile === undefined ? {} : { agent_profile: this.agentProfile }),
    });
    if (frame.type === "ack" && frame.execution_started === true && this.autoConfirmExecutionIntent) {
      this.push({
        type: "ack_result",
        event_id: frame.event_id,
        delivery_id: frame.delivery_id,
        attempt: frame.attempt,
        claim_token: frame.claim_token,
        status: "started",
        applied: true,
        receipt: "applied",
      });
    }
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

class SequenceConnector implements ConsumerConnector {
  calls = 0;
  constructor(private readonly connections: readonly ConsumerConnection[]) {}

  async connect(_signal: AbortSignal): Promise<ConsumerConnection> {
    const connection = this.connections[Math.min(this.calls, this.connections.length - 1)];
    this.calls += 1;
    if (connection === undefined) throw new Error("No scripted connection available");
    return connection;
  }
}

async function makeClient(
  name: string,
  connector: ConsumerConnector,
  options: {
    heartbeatMs?: number;
    epoch?: number;
    onLeaseAcquired?: () => Promise<void>;
    runner?: CommandRunner;
    definition?: HarnessDefinition;
    onError?: (code: string) => void;
    claimRenewalMs?: number;
    claimWatchdogMs?: number;
  } = {},
): Promise<{ client: AdapterClient; store: DurableStore; directory: string }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  if (options.epoch !== undefined) await store.activateEpoch(options.epoch);
  const harness = new HarnessAdapter({
    definition: options.definition ?? fakeDefinition,
    runner: options.runner ?? new NoopRunner(),
    store,
  });
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
      ...(options.onError === undefined ? {} : { onError: options.onError }),
      ...(options.onLeaseAcquired === undefined ? {} : { onLeaseAcquired: options.onLeaseAcquired }),
      ...(options.claimRenewalMs === undefined ? {} : { claimRenewalMs: options.claimRenewalMs }),
      ...(options.claimWatchdogMs === undefined ? {} : { claimWatchdogMs: options.claimWatchdogMs }),
    }),
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 2));
  }
}

function renewableDelivery(
  name: string,
  suffix: string,
  ackDeadlineAt: number,
): Extract<ServerFrame, { type: "delivery" }> {
  return {
    type: "delivery",
    version: "3.0",
    event_id: `30000000-0000-4000-8000-${suffix}`,
    delivery_id: `20000000-0000-4000-8000-${suffix}`,
    message_id: `00000000-0000-4000-8000-${suffix}`,
    request_id: `10000000-0000-4000-8000-${suffix}`,
    trace_id: `trace-${name}`,
    epoch: 1,
    attempt: 1,
    claim_token: `40000000-0000-4000-8000-${suffix}`,
    ack_deadline_at: new Date(ackDeadlineAt).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "kant",
    recipient_alias: `agent_${name.replaceAll("-", "_")}`,
    body: { prompt: "block while the renewable claim is valid", timeout_ms: 60_000 },
  };
}

function startedAcks(connection: FakeConnection): Array<Extract<ClientFrame, { type: "ack" }>> {
  return connection.sent.filter(
    (frame): frame is Extract<ClientFrame, { type: "ack" }> => (
      frame.type === "ack" && frame.status === "started"
    ),
  );
}

async function waitUntilTimestamp(timestamp: number): Promise<void> {
  const remaining = timestamp - Date.now();
  if (remaining > 0) {
    await new Promise((resolveWait) => setTimeout(resolveWait, remaining));
  }
}

test("startup initialization runs under the stable-alias lease before connect", async () => {
  const name = "lease-initialization";
  const directory = resolve(root, name);
  const alias = "agent_lease_initialization";
  const connection = new FakeConnection(1);
  const order: string[] = [];
  const connector: ConsumerConnector = {
    connect: async () => {
      order.push("connect");
      return connection;
    },
  };
  const { client } = await makeClient(name, connector, {
    onLeaseAcquired: async () => {
      order.push("initialize");
      await assert.rejects(
        ConsumerLease.acquire(directory, alias, "competing-instance"),
        /already owns stable alias/u,
      );
    },
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    assert.deepEqual(order, ["initialize", "connect"]);
  } finally {
    stop.abort();
    await running;
  }
});

test("connect retries then sends the real harness capabilities in hello", async () => {
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
    assert.deepEqual(hello.capabilities, capabilityStrings(fakeDefinition.capabilities));
    assert.equal(hello.capabilities.includes("harness.fake"), true);
    assert.equal(hello.capabilities.includes("agent_profile_v1"), true);
    assert.equal(hello.capabilities.includes("agent_profile_adoption_v1"), true);
    assert.equal(hello.capabilities.includes("attachments_v1"), true);
  }
  stop.abort();
  await running;
});

test("la siembra de reconnect es default-on y sólo acepta un lote completo o comprobado", () => {
  assert.equal(siembraHabilitada({}), true);
  assert.equal(siembraHabilitada({ CAUCE_SEMBRAR_PERFIL: "1" }), true);
  assert.equal(siembraHabilitada({ CAUCE_SEMBRAR_PERFIL: "0" }), false);

  assert.equal(siembraAplicada({ estado: "apagado" }), true);
  assert.equal(siembraAplicada({ estado: "sin-ficheros", harness: "hermes" }), true);
  assert.equal(siembraAplicada({ estado: "sin-directorio", harness: "claude" }), false);
  assert.equal(siembraAplicada({ estado: "no-entra", fichero: "CLAUDE.md", medido: 2, tope: 1 }), false);
  assert.equal(siembraAplicada({
    estado: "hecho",
    ficheros: [{ nombre: "CLAUDE.md", estado: "ya-estaba" }],
  }), true);
  assert.equal(siembraAplicada({
    estado: "hecho",
    ficheros: [{ nombre: "CLAUDE.md", estado: "no-se-pudo-escribir", motivo: "EACCES" }],
  }), false);
  assert.equal(siembraAplicada({
    estado: "hecho",
    ficheros: [{ nombre: "AGENTS.md", estado: "ocupado-por-otro-alias" }],
  }), false);
});

test("un perfil que no puede sembrarse corta la conexión antes del heartbeat y reintenta", async () => {
  const anteriorInterruptor = process.env.CAUCE_SEMBRAR_PERFIL;
  const anteriorClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CAUCE_SEMBRAR_PERFIL;
  process.env.CLAUDE_CONFIG_DIR = "ruta-relativa-inadmisible";

  const profile: HelloAgentProfile = {
    perfil: {
      tenant_id: "Steven", alias: "agent_profile_seed_fail", purpose: "Perfil deseado",
      role_summary: null, human_brief: null, responsibilities: [], restrictions: [],
      tools: [], operating_rules: [],
    },
    hechos: {
      permisos: { ruta: false, lectura: false, control: false, notificacion: false },
      destinos: [], cuotas: [], arnes: { harness: "claude", home: "/home/dev", capacidades: [] },
    },
  };
  const connection = new FakeConnection(1, profile);
  const connector = new ScriptedConnector(connection);
  const errors: string[] = [];
  const { client } = await makeClient("profile-seed-fail", connector, {
    definition: claudeDefinition,
    heartbeatMs: 5,
    onError: (code) => errors.push(code),
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => errors.includes("PROFILE_SEED_FAILED"));
    assert.equal(
      connection.sent.some((frame) => frame.type === "heartbeat"),
      false,
      "inició heartbeat y se declaró consumidor pese a no aplicar el perfil",
    );
  } finally {
    stop.abort();
    await running;
    if (anteriorInterruptor === undefined) delete process.env.CAUCE_SEMBRAR_PERFIL;
    else process.env.CAUCE_SEMBRAR_PERFIL = anteriorInterruptor;
    if (anteriorClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = anteriorClaudeHome;
  }
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
    assert.equal(failed?.type, "ack");
    if (failed?.type === "ack") {
      assert.equal(failed.error_code, "EXECUTION_INTENT_CONFIRMATION_FAILED");
      assert.equal(failed.retryable, true);
    }
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
    assert.equal(record?.error?.code, "EXECUTION_INTENT_CONFIRMATION_FAILED");
    assert.equal(record?.error?.retryable, true);
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
      claimRenewalMs: 100,
      claimWatchdogMs: 5_000,
    },
  );
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
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
      ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
      tenant_id: "Steven",
      room_id: "grp.steven",
      actor_alias: "kant",
      recipient_alias: "agent_renewal_rejected",
      body: { prompt: "block until ownership is lost", timeout_ms: 60_000 },
    });
    await waitUntil(() => runner.started);
    await waitUntil(() => context.store.pendingEvents().some(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    ));
    const renewalEvent = context.store.pendingEvents().find(
      (event) => event.claim_renewal === true && event.execution_started !== true,
    );
    assert.ok(renewalEvent);
    const renewal = connection.sent.find(
      (frame) => frame.type === "ack" && frame.event_id === renewalEvent.event_id,
    );
    assert.equal(renewal?.type, "ack");
    if (renewal?.type !== "ack") throw new Error("expected a renewal ACK");

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
    await waitUntil(() => runner.aborted);
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack" && frame.status === "failed",
    ));
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
    claimRenewalMs: 100,
    claimWatchdogMs: 1_000,
  });
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
    const claimDeadline = Date.now() + 30_000;
    const input = renewableDelivery(name, "000000000092", claimDeadline);
    connection.push(input);

    await waitUntil(() => runner.started);
    await waitUntil(() => startedAcks(connection).length >= 2);
    await waitUntil(() => runner.aborted, 3_000);

    assert.ok(
      Date.now() < claimDeadline,
      "The harness must stop before an unconfirmed claim can expire",
    );
    await waitUntil(() => connection.sent.some(
      (frame) => frame.type === "ack"
        && frame.delivery_id === input.delivery_id
        && frame.status === "failed",
    ));
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
        { runner, claimRenewalMs: 100, claimWatchdogMs: 1_000 },
      );
      const stop = new AbortController();
      const running = context.client.run(stop.signal);
      try {
        await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"));
        const claimDeadline = Date.now() + 30_000;
        const input = renewableDelivery(variant.name, variant.suffix, claimDeadline);
        connection.push(input);

        await waitUntil(() => runner.started);
        await waitUntil(() => startedAcks(connection).length >= 2);
        const originalWatchdogStartedAt = Date.now();
        await waitUntilTimestamp(originalWatchdogStartedAt + 400);
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
        ));

        await waitUntilTimestamp(originalWatchdogStartedAt + 1_100);
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
        ));
        assert.equal(context.store.getDelivery(input.delivery_id)?.state, "done");
      } finally {
        stop.abort();
        await running;
      }
    });
  }
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

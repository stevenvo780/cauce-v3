import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import test from "node:test";
import {claudeDefinition, fakeDefinition} from '../src/harnesses/index.js';
import {capabilityStrings, siembraAplicada, siembraHabilitada} from '../src/sdk/client.js';
import {ConsumerLease} from '../src/sdk/durable-store.js';
import type {ConsumerConnector, DeliveryEvent} from '../src/sdk/types.js';
import {
  root,
  ClosingConnection,
  FactoryConnector,
  FakeConnection,
  HelloAgentProfile,
  ReconnectDelayClock,
  RejectingConnection,
  ScriptedConnector,
  escala,
  makeClient,
  waitUntil,
} from "./client-fixtures.js";
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
    await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame on the wire");
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
  await waitUntil(() => connection.sent.some((frame) => frame.type === "hello"), "the HELLO frame after the planned connect failure");
  const hello = connection.sent.find((frame) => frame.type === "hello");
  assert.equal(connector.calls, 2);
  assert.ok(hello, "no se envió ningún HELLO");
  assert.equal(hello.alias, "agent_reconnect");
  assert.equal(hello.instance_id, "instance-reconnect");
  assert.deepEqual(hello.capabilities, capabilityStrings(fakeDefinition.capabilities));
  assert.equal(hello.capabilities.includes("harness.fake"), true);
  assert.equal(hello.capabilities.includes("agent_profile_v1"), true);
  assert.equal(hello.capabilities.includes("agent_profile_adoption_v1"), true);
  assert.equal(hello.capabilities.includes("attachments_v1"), true);
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

/**
 * DELIBERATE POLICY CHANGE. This test used to assert the opposite: that a profile which cannot be
 * seeded cut the connection before the heartbeat and retried. That policy cost an alias 8h52m of
 * total deafness across 1074 identical reconnections, because a console revision that had not
 * reached disk yet is unfixable from the adapter side — it retried forever against a mismatch only
 * an operator could resolve, and every message queued for that alias expired.
 *
 * The transport now survives and the failure is loud instead. Running with a stale profile is a
 * content problem; being unreachable AND silent is worse than both.
 */
test("un perfil que no puede sembrarse avisa pero NO cuesta la conexión", async () => {
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
    await waitUntil(() => errors.includes("PROFILE_SEED_FAILED"), "the PROFILE_SEED_FAILED diagnostic");
    // The whole point: the alias keeps consuming. Without it there is no heartbeat, because the
    // connection died before reaching the heartbeat loop.
    await waitUntil(() => connection.sent.some((frame) => frame.type === "heartbeat"), "a heartbeat proving the alias keeps consuming");
    assert.equal(
      connector.calls,
      1,
      "reconectó por un fallo de siembra: eso es el bucle que dejó al alias sordo 8h52m",
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
  await waitUntil(() => connection.sent.some((frame) => frame.type === "heartbeat"), "a heartbeat on the established consumer");
  assert.equal(connector.calls, 1);
  const heartbeat = connection.sent.find((frame) => frame.type === "heartbeat");
  assert.equal(heartbeat?.type, "heartbeat");
  stop.abort();
  await running;
});

/**
 * The backoff used to be reset by `hello_ack`, so every failure after the greeting reconnected at
 * the initial delay forever: 7570 epochs in 99 minutes on one alias. Pacing is now credited only
 * by evidence the connection carries traffic — a drained outbox entry or a heartbeat round trip.
 */
test("el saludo ya no reinicia el backoff: sólo un heartbeat_ack lo devuelve al arranque", async () => {
  const heartbeatMs = 60_000;
  const clock = new ReconnectDelayClock(heartbeatMs);
  const acknowledgedCall = 4;
  const connector = new FactoryConnector(
    (call) => new ClosingConnection(call === acknowledgedCall),
  );
  const { client } = await makeClient("backoff-hello-ack", connector, {
    heartbeatMs,
    clock,
    reconnect: { initialMs: 100, maxMs: 10_000, factor: 2, jitter: 0 },
  });
  const stop = new AbortController();
  const running = client.run(stop.signal);
  try {
    await waitUntil(() => clock.delays.length >= 5, "five reconnect delays recorded by the clock");
    assert.deepEqual(clock.delays.slice(0, 5), [100, 200, 400, 100, 200]);
  } finally {
    stop.abort();
    await running;
  }
});

/** A connection that dies while replaying the outbox proves nothing: the delay has to grow. */
test("un outbox que no puede vaciarse hace crecer la espera de reconexión", async () => {
  const heartbeatMs = 60_000;
  const clock = new ReconnectDelayClock(heartbeatMs);
  const event: DeliveryEvent = {
    event_id: "50000000-0000-4000-8000-000000000101",
    delivery_id: "20000000-0000-4000-8000-000000000101",
    attempt: 1,
    claim_token: "40000000-0000-4000-8000-000000000101",
    epoch: 1,
    phase: "accepted",
    occurred_at: new Date(0).toISOString(),
  };
  const connector = new FactoryConnector(() => new RejectingConnection(
    [event.event_id],
    () => new Error("gateway write closed"),
  ));
  const context = await makeClient("backoff-outbox-stuck", connector, {
    heartbeatMs,
    clock,
    reconnect: { initialMs: 100, maxMs: 10_000, factor: 2, jitter: 0 },
  });
  await context.store.enqueue(event);
  const stop = new AbortController();
  const running = context.client.run(stop.signal);
  try {
    await waitUntil(() => clock.delays.length >= 3, "three reconnect delays recorded by the clock");
    assert.deepEqual(clock.delays.slice(0, 3), [100, 200, 400]);
  } finally {
    stop.abort();
    await running;
  }
});

test("systemClock timers do not hold the adapter process open", async () => {
  const backoffUrl = new URL("../src/sdk/backoff.js", import.meta.url).href;
  const scheduler = (options: string): ReturnType<typeof spawn> => spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { systemClock } = await import(${JSON.stringify(backoffUrl)});`
        + `systemClock.setTimer(() => undefined, 600_000${options});`
        + `systemClock.setRepeating(() => undefined, 600_000${options});`,
    ],
    { stdio: "ignore" },
  );
  const exitsWithin = async (child: ReturnType<typeof spawn>, ms: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        once(child, "exit").then(() => true),
        new Promise<boolean>((resolveWait) => {
          timer = setTimeout(() => { resolveWait(false); }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const reap = async (child: ReturnType<typeof spawn>): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await once(child, "exit");
  };

  const unreffed = scheduler("");
  try {
    assert.equal(
      await exitsWithin(unreffed, escala(10_000)),
      true,
      "a pending clock timer must not keep the process alive",
    );
  } finally {
    await reap(unreffed);
  }

  const held = scheduler(", { keepProcessAlive: true }");
  try {
    assert.equal(
      await exitsWithin(held, escala(1_000)),
      false,
      "keepProcessAlive must hold the event loop open",
    );
  } finally {
    await reap(held);
  }
});

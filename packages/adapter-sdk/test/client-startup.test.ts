import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {claudeDefinition, fakeDefinition} from '../src/harnesses/index.js';
import {capabilityStrings, siembraAplicada, siembraHabilitada} from '../src/sdk/client.js';
import {ConsumerLease} from '../src/sdk/durable-store.js';
import type {ConsumerConnector} from '../src/sdk/types.js';
import {
  root,
  FakeConnection,
  HelloAgentProfile,
  ScriptedConnector,
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


import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadCliRuntimeConfig } from "../src/bin/config.js";

const root = resolve(".test-state/cli-config");

test.beforeEach(async () => {
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
});

test("CLI selects an alias configuration containing credential paths only", async () => {
  const path = resolve(root, "adapters.json");
  await writeFile(path, JSON.stringify({
    aliases: {
      kant: {
        tenant: "Steven",
        instance_id: "openclaw-kant-1",
        state_directory: "state/kant",
        relay_url: "wss://gateway.example/v3/adapter",
        environment: "production",
        token_file: "credentials/cauce.token",
        mtls: {
          cert_file: "credentials/client.crt",
          key_file: "credentials/client.key",
          ca_file: "credentials/ca.crt",
        },
        openclaw: {
          transport: "api",
          api_url: "http://127.0.0.1:18789/v1/chat/completions",
          token_file: "credentials/openclaw.token",
          agent_target: "openclaw/default",
        },
      },
    },
  }));
  const config = await loadCliRuntimeConfig("openclaw", ["--config", path, "--alias", "kant"]);
  assert.equal(config.alias, "kant");
  assert.equal(config.bearerTokenFile, resolve(root, "credentials/cauce.token"));
  assert.equal(config.mutualTls?.keyFile, resolve(root, "credentials/client.key"));
  assert.equal(config.openClaw?.tokenFile, resolve(root, "credentials/openclaw.token"));
  assert.equal(config.defaultTimeoutMs, 86_400_000);
});

test("CLI configuration rejects inline secrets and production dev headers", async () => {
  const inline = resolve(root, "inline.json");
  await writeFile(inline, JSON.stringify({ aliases: { kant: { token: "inline-value" } } }));
  await assert.rejects(
    loadCliRuntimeConfig("openclaw", ["--config", inline, "--alias", "kant"]),
    /Inline secrets are forbidden/u,
  );

  const development = resolve(root, "dev.json");
  await writeFile(development, JSON.stringify({
    aliases: {
      kant: {
        tenant: "Steven",
        instance_id: "openclaw-kant-1",
        state_directory: "state/kant",
        relay_url: "wss://gateway.example/v3/adapter",
        environment: "production",
        dev_headers: true,
      },
    },
  }));
  await assert.rejects(
    loadCliRuntimeConfig("openclaw", ["--config", development, "--alias", "kant"]),
    /forbidden in production/u,
  );
});

test("bridge and Hermes Python paths are configurable through non-secret environment", async () => {
  const names = [
    "CAUCE_TENANT",
    "CAUCE_ROOM",
    "CAUCE_ALIAS",
    "CAUCE_INSTANCE_ID",
    "CAUCE_STATE_DIR",
    "CAUCE_RELAY_URL",
    "CAUCE_ENVIRONMENT",
    "CAUCE_HERMES_BRIDGE",
    "CAUCE_HERMES_PYTHON",
    "CAUCE_OPENCLAW_BRIDGE",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      CAUCE_TENANT: "Steven",
      CAUCE_ROOM: "grp.steven",
      CAUCE_ALIAS: "kant",
      CAUCE_INSTANCE_ID: "adapter-1",
      CAUCE_STATE_DIR: resolve(root, "state"),
      CAUCE_RELAY_URL: "ws://127.0.0.1:8080/v3/ws",
      CAUCE_ENVIRONMENT: "test",
      CAUCE_HERMES_BRIDGE: resolve(root, "hermes.py"),
      CAUCE_HERMES_PYTHON: resolve(root, "venv/bin/python"),
    });
    const hermes = await loadCliRuntimeConfig("hermes", []);
    assert.equal(hermes.harnessBridge, resolve(root, "hermes.py"));
    assert.equal(hermes.hermesPython, resolve(root, "venv/bin/python"));

    const configPath = resolve(root, "bridge-config.json");
    await writeFile(configPath, JSON.stringify({ aliases: { kant: {
      tenant: "Steven",
      instance_id: "adapter-1",
      state_directory: "state",
      relay_url: "ws://127.0.0.1:8080/v3/ws",
      environment: "test",
    } } }));
    const configuredHermes = await loadCliRuntimeConfig("hermes", ["--config", configPath, "--alias", "kant"]);
    assert.equal(configuredHermes.harnessBridge, resolve(root, "hermes.py"));
    assert.equal(configuredHermes.hermesPython, resolve(root, "venv/bin/python"));

    delete process.env.CAUCE_HERMES_BRIDGE;
    delete process.env.CAUCE_HERMES_PYTHON;
    process.env.CAUCE_OPENCLAW_BRIDGE = resolve(root, "openclaw.mjs");
    const openclaw = await loadCliRuntimeConfig("openclaw", []);
    assert.equal(openclaw.harnessBridge, resolve(root, "openclaw.mjs"));
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

/**
 * La sala propia es identidad, no decoracion: el agente la reporta como suya al harness. Los dos
 * caminos del cargador tenian contratos distintos y NINGUNO estaba afirmado, asi que 547eda3 pudo
 * volver `CAUCE_ROOM` obligatorio sin que nada delatara a los arranques que no la pasaban.
 */
test("la sala propia es obligatoria por entorno y declarable por archivo", async () => {
  const names = ["CAUCE_TENANT", "CAUCE_ROOM", "CAUCE_ALIAS", "CAUCE_INSTANCE_ID", "CAUCE_STATE_DIR",
    "CAUCE_RELAY_URL", "CAUCE_ENVIRONMENT"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  try {
    Object.assign(process.env, {
      CAUCE_TENANT: "Isa",
      CAUCE_ALIAS: "salva",
      CAUCE_INSTANCE_ID: "adapter-1",
      CAUCE_STATE_DIR: resolve(root, "state"),
      CAUCE_RELAY_URL: "ws://127.0.0.1:8080/v3/ws",
      CAUCE_ENVIRONMENT: "test",
    });
    delete process.env.CAUCE_ROOM;
    // Falla cerrado: un default silencioso devolveria la sala equivocada en produccion, que es
    // justo el defecto que 547eda3 arreglo.
    await assert.rejects(loadCliRuntimeConfig("claude", []), /'CAUCE_ROOM' is missing/u);

    process.env.CAUCE_ROOM = "grp.isa";
    assert.equal((await loadCliRuntimeConfig("claude", [])).room, "grp.isa");
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  const base = {
    tenant: "Isa",
    instance_id: "salva-1",
    state_directory: "state/salva",
    relay_url: "wss://gateway.example/v3/adapter",
    environment: "test",
  };
  const declared = resolve(root, "declared-room.json");
  await writeFile(declared, JSON.stringify({ aliases: { salva: { ...base, room: "grp.isa" } } }));
  assert.equal((await loadCliRuntimeConfig("claude", ["--config", declared, "--alias", "salva"])).room, "grp.isa");

  const omitted = resolve(root, "omitted-room.json");
  await writeFile(omitted, JSON.stringify({ aliases: { salva: base } }));
  assert.equal((await loadCliRuntimeConfig("claude", ["--config", omitted, "--alias", "salva"])).room, "Isa");
});

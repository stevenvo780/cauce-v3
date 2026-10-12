import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import plugin from "../instances/hospital/openclaw-muse-native/index.js";

const pluginDirectory = new URL("../instances/hospital/openclaw-muse-native/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("openclaw.plugin.json", pluginDirectory), "utf8"));
const packageManifest = JSON.parse(await readFile(new URL("package.json", pluginDirectory), "utf8"));

function registeredBackend() {
  const registrations = [];
  const api = new Proxy({}, {
    get(_target, property) {
      assert.equal(property, "registerCliBackend", "only the public CLI backend registration API is allowed");
      return descriptor => registrations.push(descriptor);
    },
  });
  plugin.register(api);
  assert.equal(registrations.length, 1);
  return registrations[0];
}

test("the extension exports an ESM plugin matching its manifest identity", () => {
  assert.equal(plugin.id, "hospital-muse-native");
  assert.equal(manifest.id, plugin.id);
  assert.equal(manifest.name, plugin.name);
  assert.equal(typeof plugin.register, "function");
});

test("the backend activates at startup with no configurable provider settings", () => {
  assert.deepEqual(manifest.activation, { onStartup: true });
  assert.deepEqual(manifest.cliBackends, ["muse-cli"]);
  assert.deepEqual(manifest.configSchema, {
    type: "object", additionalProperties: false, properties: {},
  });
  assert.equal(Object.hasOwn(manifest, "providers"), false);
  assert.equal(Object.hasOwn(manifest, "models"), false);
});

test("the package loads the local extension without runtime dependencies", () => {
  assert.equal(packageManifest.type, "module");
  assert.equal(packageManifest.private, true);
  assert.deepEqual(packageManifest.openclaw.extensions, ["./index.js"]);
  assert.equal(Object.hasOwn(packageManifest, "dependencies"), false);
  assert.equal(Object.hasOwn(packageManifest, "devDependencies"), false);
});

test("registration uses only the public CLI backend API and the existing backend id", () => {
  const backend = registeredBackend();
  assert.equal(backend.id, "muse-cli");
  assert.deepEqual(Object.keys(backend).sort(), ["config", "id", "ownsNativeCompaction"]);
});

test("native compaction ownership belongs to the descriptor rather than CLI config", () => {
  const backend = registeredBackend();
  assert.equal(backend.ownsNativeCompaction, true);
  assert.equal(Object.hasOwn(backend.config, "ownsNativeCompaction"), false);
});

test("the registered command retains the pinned Muse wrapper path", () => {
  const { config } = registeredBackend();
  assert.equal(config.command, "/usr/bin/python3");
  assert.deepEqual(config.args, ["/home/node/clawd/.cauce/runtime/muse-cli-backend.py"]);
});

test("the backend preserves JSONL streams and reuses existing session identities", () => {
  const { config } = registeredBackend();
  assert.equal(config.input, "stdin");
  assert.equal(config.output, "jsonl");
  assert.equal(config.sessionArg, "--session-id");
  assert.equal(config.sessionMode, "existing");
  assert.deepEqual(config.sessionIdFields, ["session_id"]);
});

test("the backend appends the system prompt on every serialized turn without API routes", () => {
  const { config } = registeredBackend();
  assert.equal(config.systemPromptArg, "--system-prompt");
  assert.equal(config.systemPromptMode, "append");
  assert.equal(config.systemPromptWhen, "always");
  assert.equal(config.serialize, true);
  assert.deepEqual(Object.keys(config).sort(), [
    "args", "command", "input", "output", "serialize", "sessionArg", "sessionIdFields",
    "sessionMode", "systemPromptArg", "systemPromptMode", "systemPromptWhen",
  ]);
});

test("an unavailable CLI backend API fails without falling back to a model or provider API", () => {
  const accessedProperties = [];
  const api = new Proxy({}, {
    get(_target, property) {
      accessedProperties.push(property);
      return undefined;
    },
  });
  assert.throws(() => plugin.register(api), TypeError);
  assert.deepEqual(accessedProperties, ["registerCliBackend"]);
});

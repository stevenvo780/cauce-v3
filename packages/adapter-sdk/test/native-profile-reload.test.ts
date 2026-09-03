import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { profileReloadRequest } from "../src/context/native-profile-context.js";
import { DurableStore } from "../src/sdk/durable-store.js";
import { HarnessAdapter } from "../src/harnesses/index.js";
import {
  captureStderr, context, contract, definition, nativeEnvironment, profileFile, reloadMaterial,
  spyRunner,
} from "./native-profile-fixtures.js";

test("the expectation reload resolves the same gateway and PKI the oneshot uses", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cauce-native-reload-target-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const material = {
    CAUCE_TLS_CERT_FILE: join(root, "client.crt"),
    CAUCE_TLS_KEY_FILE: join(root, "client.key"),
    CAUCE_TLS_CA_FILE: join(root, "ca.crt"),
  };
  for (const file of Object.values(material)) writeFileSync(file, "material", "utf8");

  assert.deepEqual(
    profileReloadRequest({ ...material, CAUCE_RELAY_URL: "wss://cauce.example:8443/v3/ws" }, "zeus"),
    {
      url: "https://cauce.example:8443/v3/console/agents/zeus/context/reload",
      certFile: material.CAUCE_TLS_CERT_FILE,
      keyFile: material.CAUCE_TLS_KEY_FILE,
      caFile: material.CAUCE_TLS_CA_FILE,
    },
  );
  assert.equal(
    profileReloadRequest({
      ...material,
      CAUCE_RELAY_URL: "wss://cauce.example/v3/ws",
      CAUCE_PROFILE_EXPECTATION_URL: "https://consola.example",
    }, "zeus")?.url,
    "https://consola.example/v3/console/agents/zeus/context/reload",
  );
  for (const broken of [
    { CAUCE_RELAY_URL: "wss://cauce.example/v3/ws", CAUCE_TLS_KEY_FILE: join(root, "ausente.key") },
    { CAUCE_RELAY_URL: "wss://cauce.example/v3/ws", CAUCE_TLS_CA_FILE: "ca.crt" },
    { CAUCE_RELAY_URL: "ws://cauce.example/v3/ws" },
    { CAUCE_RELAY_URL: "wss://cauce.example/v3/ws?token=secreto" },
    { CAUCE_RELAY_URL: "wss://cauce.example/v3/ws", CAUCE_PROFILE_EXPECTATION_URL: "http://consola" },
    {},
  ]) {
    assert.equal(profileReloadRequest({ ...material, ...broken }, "zeus"), undefined);
  }
});

const RELOAD_CASES = [
  { label: "utilizable reintenta", usable: true, retryable: true },
  { label: "ilegible no reintenta", usable: false, retryable: false },
] as const;

for (const escenario of RELOAD_CASES) {
  test(`una expectativa rancia se re-registra una vez por generación: material ${escenario.label}`,
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), "cauce-native-reload-"));
      const home = join(root, "home");
      const config = join(home, ".claude");
      mkdirSync(config, { recursive: true });
      const path = join(config, "CLAUDE.md");
      writeFileSync(path, profileFile("zeus", 41, "CURRENT"), "utf8");
      const material = reloadMaterial(join(root, "pki"), escenario.usable);
      t.after(() => { rmSync(root, { recursive: true, force: true }); });

      const environment: NodeJS.ProcessEnv = {
        ...nativeEnvironment(),
        ...material,
        HOME: home,
        CLAUDE_CONFIG_DIR: config,
        CAUCE_CONTAINER_GENERATION: "runtime-41",
        CAUCE_PROFILE_EXPECTATION_URL: "https://127.0.0.1:1",
      };
      delete environment.CAUCE_CONTAINER_PRESENCE_GENERATION;
      const { runner, requests } = spyRunner();
      const adapter = new HarnessAdapter({
        definition: definition("claude"),
        runner,
        store: await DurableStore.open(join(root, "state")),
        environment,
      });
      const deliver = async (generation: string): Promise<void> => {
        await adapter.execute({
          prompt: "Run under the live generation.",
          context: {
            ...context("zeus"),
            native_profile_contract: { ...contract(41, [path]), generation },
          },
          timeoutMs: 2_000,
          signal: AbortSignal.timeout(2_000),
        });
      };

      await deliver("runtime-41");
      assert.equal(requests.length, 1);
      const bytesAfterFirst = readFileSync(path, "utf8");

      const capture = captureStderr();
      try {
        for (const attempt of [1, 2]) {
          await assert.rejects(deliver("runtime-40"), (error: unknown) => {
            const failure = error as { code?: unknown; retryable?: unknown; message?: unknown };
            assert.equal(
              failure.code,
              "NATIVE_PROFILE_CONTEXT_GENERATION_MISMATCH",
              `intento ${String(attempt)}`,
            );
            assert.equal(failure.retryable, escenario.retryable, `intento ${String(attempt)}`);
            for (const file of Object.values(material)) {
              assert.equal(
                String(failure.message).includes(file),
                !escenario.usable,
                `intento ${String(attempt)}: ${file}`,
              );
            }
            return true;
          });
        }
      } finally {
        capture.restore();
      }
      const reloads = capture.lines.flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return parsed.event === "native_profile_expectation_reload_requested" ? [parsed] : [];
        } catch { return []; }
      });
      assert.deepEqual(reloads, [{
        event: "native_profile_expectation_reload_requested",
        alias: "zeus",
        harness: "claude",
        generation: "runtime-41",
        url: "https://127.0.0.1:1/v3/console/agents/zeus/context/reload",
        dispatched: escenario.usable,
      }]);
      assert.equal(requests.length, 1);
      assert.equal(readFileSync(path, "utf8"), bytesAfterFirst);
    });
}

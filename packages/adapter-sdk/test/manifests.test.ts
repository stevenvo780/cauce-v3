import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";

test("each harness manifest matches its advertised runtime capabilities", async () => {
  for (const [id, definition] of Object.entries(HARNESS_DEFINITIONS)) {
    const manifest = JSON.parse(await readFile(resolve(`manifests/${id}.json`), "utf8")) as {
      schema_version: number;
      harness: string;
      adapter_executable: string;
      invocation: { prompt_transport: string };
      capabilities: unknown;
    };
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.harness, id);
    assert.equal(manifest.adapter_executable, `cauce-adapter-${id}`);
    assert.equal(manifest.invocation.prompt_transport, "stdin");
    assert.deepEqual(manifest.capabilities, definition.capabilities);
  }
});

test("Hermes declares the operational model selector by environment name only", async () => {
  const manifest = JSON.parse(await readFile(resolve("manifests/hermes.json"), "utf8")) as {
    invocation: { operational_model_env: string };
  };
  assert.equal(manifest.invocation.operational_model_env, "HERMES_INFERENCE_MODEL");
  assert.equal(JSON.stringify(manifest).includes("gpt-"), false);
});

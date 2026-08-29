import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseHermesOutput, parseOpenClawOutput } from "../src/sdk/output-parser.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import { HARNESS_START_MARKER } from "../src/sdk/types.js";

const sourceHermes = resolve("bridge/hermes-stdin-bridge.py");
const sourceOpenClaw = resolve("bridge/openclaw-stdin-bridge.mjs");
const fakeHermes = resolve("test/fixtures/hermes-python");
const fakeOpenClaw = resolve("test/fixtures/openclaw-dist-compatible");

test("Hermes bridge imports run_oneshot from the selected Python and emits only its envelope", () => {
  const result = spawnSync("python3", [sourceHermes], {
    input: "Hermes bridge prompt",
    encoding: "utf8",
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: fakeHermes },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /native log/u);
  assert.equal(parseHermesOutput(result.stdout).output.reply, "hermes bridge success");
});

test("Hermes bridge rejects an invalid accredited source before the execution witness", () => {
  const result = spawnSync("python3", [sourceHermes], {
    input: "private prompt",
    encoding: "utf8",
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONPATH: fakeHermes,
      CAUCE_HERMES_RUNTIME_DIR: "/definitely/absent/cauce-hermes-runtime",
      CAUCE_HERMES_SOURCE_DIR: "/definitely/absent/cauce-hermes-source",
    },
    timeout: 5_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "hermes stdin bridge failed\n");
  assert.doesNotMatch(result.stderr, /private prompt/u);
});

for (const [prompt, expected] of [
  ["HERMES_MULTILINE", "hermes bridge success"],
  ["HERMES_PLAIN", "hermes plain final"],
] as const) {
  test(`Hermes bridge emits the final ${prompt === "HERMES_MULTILINE" ? "multiline JSON" : "plain"} response without logs when rc=0`, () => {
    const result = spawnSync("python3", [sourceHermes], {
      input: prompt,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: fakeHermes },
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /native log/u);
    assert.equal(parseHermesOutput(result.stdout).output.reply, expected);
  });
}

for (const prompt of ["HERMES_RC_FAILURE", "HERMES_HTTP_ERROR"] as const) {
  test(`Hermes bridge fails closed for ${prompt}`, () => {
    const result = spawnSync("python3", [sourceHermes], {
      input: prompt,
      encoding: "utf8",
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: fakeHermes },
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    // The start marker is emitted BEFORE calling hermes, so a HERMES failure carries it: that is
    // exactly what should happen. The turn reached the door, so the transport cannot declare it
    // pre-flight and the delivery stays ambiguous.
    assert.equal(result.stderr, `${HARNESS_START_MARKER}\nhermes stdin bridge failed\n`);
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /native log|upstream unavailable/u);
  });
}

test("OpenClaw bridge calls the unique installed modules and preserves legacy session key", () => {
  const prompt = "OpenClaw bridge prompt that must stay off argv";
  const result = spawnSync(process.execPath, [sourceOpenClaw, "--session-key", "session-fixture"], {
    input: prompt,
    encoding: "utf8",
    env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw },
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /native log|must stay off argv/u);
  const parsed = parseOpenClawOutput(result.stdout);
  assert.equal(parsed.output.reply, "openclaw bridge success");
  assert.equal(parsed.nativeSessionId, "session-fixture");
});

for (const state of ["absent", "ambiguous"] as const) {
  test(`OpenClaw bridge fails closed when compatible modules are ${state}`, () => {
    const result = spawnSync(process.execPath, [sourceOpenClaw], {
      input: "private prompt value",
      encoding: "utf8",
      env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: resolve(`test/fixtures/openclaw-dist-${state}`) },
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    // CONTRACT CHANGE (b30acaf): stderr says WHY it failed. It used to be a single silent line
    // identical for both states, and from the outside there was no way to tell "modules were not
    // found" apart from "several were found" without going into the bridge to read it. What MUST
    // NOT appear is still the prompt, and the assertion below pins that.
    assert.match(result.stderr, /^openclaw stdin bridge failed: /u);
    assert.match(
      result.stderr,
      state === "absent" ? /modules were absent or ambiguous/u : /ambiguous OpenClaw modules/u,
    );
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /private prompt/u);
  });
}

test("external timeout terminates an OpenClaw bridge invocation", async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 15 }).run({
    command: process.execPath,
    args: [sourceOpenClaw],
    env: { CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw },
    harness: "openclaw",
    stdin: "BRIDGE_WAIT",
    timeoutMs: 40,
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, true);
});

test("external timeout terminates a Hermes bridge invocation", async () => {
  const result = await new SpawnCommandRunner({ killGraceMs: 15 }).run({
    command: "python3",
    args: [sourceHermes],
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: fakeHermes },
    harness: "hermes",
    stdin: "BRIDGE_WAIT",
    timeoutMs: 40,
    signal: new AbortController().signal,
  });
  assert.equal(result.timedOut, true);
});

test("both bridges reject input above 1 MiB without echoing it", () => {
  const oversized = `private-${"x".repeat(1024 * 1024)}`;
  const invocations = [
    {
      command: "python3",
      args: [sourceHermes],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", PYTHONPATH: fakeHermes },
    },
    {
      command: process.execPath,
      args: [sourceOpenClaw],
      env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw },
    },
  ];
  for (const invocation of invocations) {
    const result = spawnSync(invocation.command, invocation.args, {
      input: oversized,
      encoding: "utf8",
      env: invocation.env,
      timeout: 5_000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /private-/u);
  }
});

test("build ships executable bridge files under dist/bridge", async () => {
  for (const name of ["hermes-stdin-bridge.py", "openclaw-stdin-bridge.mjs"]) {
    const path = resolve(`dist/bridge/${name}`);
    await access(path, constants.X_OK);
    assert.notEqual((await stat(path)).mode & 0o111, 0);
  }
});

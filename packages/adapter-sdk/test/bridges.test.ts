import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, stat, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
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

test("OpenClaw bridge declares a failed turn when every model in the chain is exhausted", () => {
  const result = spawnSync(process.execPath, [sourceOpenClaw, "--session-key", "session-exhausted"], {
    input: "OPENCLAW_ALL_MODELS_FAILED",
    encoding: "utf8",
    env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw },
    timeout: 5_000,
  });
  assert.notEqual(
    result.stdout.trim(),
    "",
    "empty stdout after the turn began is only classifiable as PROCESS_EXIT_AMBIGUOUS, which is not retryable:"
    + " the delivery dies on attempt 1/3 and whoever ordered it never learns why",
  );
  const parsed = parseOpenClawOutput(result.stdout);
  assert.equal(
    parsed.output.status,
    "failed",
    "only a declared failure travels back to the requester as an answer instead of dying as a transport error",
  );
  assert.equal(
    parsed.output.retryable,
    false,
    "the turn already ran and paid for its side effects, so a retry repeats work that was already done",
  );
  assert.match(
    parsed.output.reply ?? "",
    /All models failed/u,
    "the requester must read the real cause, not a generic ambiguous-exit message",
  );
  assert.ok(
    !(parsed.output.reply ?? "").includes("at main ("),
    "the reply is read by the agent that ordered the work: a stack trace of the bridge tells it"
    + " nothing and duplicated the message; the trace belongs on stderr, where an operator reads it",
  );
  assert.equal(
    parsed.nativeSessionId,
    "session-exhausted",
    "losing the native session on a failed turn would strand the conversation the harness already owns",
  );
  assert.match(
    result.stderr,
    /openclaw stdin bridge failed: [\s\S]*All models failed/u,
    "the crude error stays on stderr for diagnosis, where it does not pollute the stdout contract",
  );
  assert.equal(
    result.status,
    1,
    "adapter.ts admits a non-zero exit when the turn declared itself failed, so the exit code must not be softened",
  );
});

test("the OpenClaw bridge exits after emitting its envelope even with a live handle open", () => {
  const result = spawnSync(process.execPath, [sourceOpenClaw, "--session-key", "session-linger"], {
    input: "BRIDGE_LINGER prompt",
    encoding: "utf8",
    env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw },
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `the bridge must exit on its own: ${result.stderr}`);
  const parsed = parseOpenClawOutput(result.stdout);
  assert.equal(parsed.output.reply, "openclaw bridge success");
  assert.equal(parsed.nativeSessionId, "session-linger");
});

test("OpenClaw output keeps an answer that runtime noise precedes", () => {
  const envelope = JSON.stringify({
    result: { payloads: [{ text: JSON.stringify({ reply: "answer after noise", messages: [],
      status: "done", retryable: false, artifacts: [] }) }] },
    status: "ok",
  });
  const noisy = `(node:35497) ExperimentalWarning: SQLite is an experimental feature\n`
    + `(Use \`node --trace-warnings ...\` to show where the warning was created)\n${envelope}\n`;
  assert.equal(parseOpenClawOutput(noisy).output.reply, "answer after noise");
});

test("the OpenClaw bridge abandons a run that exceeds its own deadline with a failed envelope", () => {
  const result = spawnSync(process.execPath, [sourceOpenClaw, "--session-key", "session-deadline"], {
    input: "BRIDGE_WAIT",
    encoding: "utf8",
    env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw, CAUCE_OPENCLAW_RUN_DEADLINE_MS: "300" },
    timeout: 20_000,
  });
  assert.equal(result.status, 1, "an abandoned run is a failed turn, never an ambiguous one");
  const envelope = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1) ?? "{}") as { result?: { ok?: boolean; error?: string }; session_id?: string };
  assert.equal(envelope.result?.ok, false);
  assert.match(envelope.result.error ?? "", /exceeded 300 ms/u);
  assert.equal(envelope.session_id, "session-deadline");
  assert.match(result.stderr, /<<cauce:harness-started>>/u, "the witness precedes the abandonment: the turn did start");
});

function runBridge(input: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [sourceOpenClaw, "--session-key", "session-budget"], {
    input,
    encoding: "utf8",
    env: { ...process.env, CAUCE_OPENCLAW_DIST_DIR: fakeOpenClaw, ...env },
    timeout: 20_000,
  });
  const last = result.stdout.trim().split(/\r?\n/u).at(-1) ?? "{}";
  return { result, envelope: JSON.parse(last) as { result?: { ok?: boolean; error?: string } } };
}

async function gatewayConfig(listening: boolean): Promise<{ path: string; close: () => Promise<void> }> {
  const server = createServer((socket) => { socket.destroy(); });
  await new Promise<void>((done) => { server.listen(0, "127.0.0.1", done); });
  const port = (server.address() as AddressInfo).port;
  const close = async () => { await new Promise((done) => { server.close(done); }); };
  if (!listening) await close();
  const directory = await mkdtemp(join(tmpdir(), "bridge-gateway-"));
  const path = join(directory, "openclaw.json");
  await writeFile(path, JSON.stringify({ gateway: { port } }));
  return { path, close: listening ? close : async () => undefined };
}

test("the OpenClaw bridge asks OpenClaw for no timeout: the gateway run and its client wait as long as the turn advances", () => {
  const { result } = runBridge("BRIDGE_ECHO_TIMEOUT");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseOpenClawOutput(result.stdout).output.reply, "timeout=0",
    "timeoutSeconds is a duration cap: on 29-09 the client gave up at 1800+30 s, 24 s before a 31-min turn answered");
});

test("the OpenClaw bridge forwards a sender's hard timeout_ms to the gateway instead of lifting it", () => {
  const { result } = runBridge("BRIDGE_ECHO_TIMEOUT", { CAUCE_HARNESS_TIMEOUT_KIND: "hard", CAUCE_HARNESS_TIMEOUT_MS: "600000" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseOpenClawOutput(result.stdout).output.reply, "timeout=600",
    "a killed bridge leaves the gateway run behind: only the gateway can enforce the cap the sender asked for");
});

test("the OpenClaw bridge reports progress while a silent run keeps writing its transcript", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-home-"));
  const { result } = runBridge("BRIDGE_PROGRESS_WRITES", { HOME: home, CAUCE_OPENCLAW_PROGRESS_POLL_MS: "100" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /<<cauce:progress>>/u,
    "the run prints nothing until it ends: without these marks a long live turn is indistinguishable from a hung one");
  assert.equal(parseOpenClawOutput(result.stdout).output.reply, "long run finished");
});

test("another session growing is not progress for this run", async () => {
  const home = await mkdtemp(join(tmpdir(), "bridge-home-"));
  const { result } = runBridge("BRIDGE_FOREIGN_WRITES", { HOME: home, CAUCE_OPENCLAW_PROGRESS_POLL_MS: "100" });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /<<cauce:progress>>/u,
    "crons and other sessions write every few minutes: counting them would keep a hung run alive forever");
});

test("the OpenClaw bridge refuses the embedded re-run when the gateway client times out", () => {
  const { result, envelope } = runBridge("OPENCLAW_GATEWAY_TIMEOUT_FALLBACK");
  assert.equal(result.status, 1);
  assert.equal(envelope.result?.ok, false,
    "an embedded re-run in a fresh session duplicated a live gateway turn on 29-09 and was killed at 45 min");
  assert.match(envelope.result?.error ?? "", /gave up; not re-running the turn embedded/u);
  assert.doesNotMatch(result.stdout, /embedded duplicate ran|embedded local run/u);
});

test("the OpenClaw bridge refuses the embedded re-run while the gateway still answers on its port", async () => {
  const gateway = await gatewayConfig(true);
  try {
    const { envelope, result } = runBridge("OPENCLAW_GATEWAY_TRANSPORT_FALLBACK", { OPENCLAW_CONFIG_PATH: gateway.path });
    assert.equal(envelope.result?.ok, false, "a dropped socket is not a dead gateway: its run is still going");
    assert.match(envelope.result?.error ?? "", /gateway is still alive/u);
    assert.doesNotMatch(result.stdout, /embedded duplicate ran|embedded local run/u);
  } finally {
    await gateway.close();
  }
});

test("the OpenClaw bridge still answers embedded when the gateway is really down", async () => {
  const gateway = await gatewayConfig(false);
  const { result } = runBridge("OPENCLAW_GATEWAY_TRANSPORT_FALLBACK", { OPENCLAW_CONFIG_PATH: gateway.path });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseOpenClawOutput(result.stdout).output.reply, "embedded local run",
    "with the gateway dead the embedded run is the only way to answer, and nothing runs in parallel");
});

test("the OpenClaw bridge honours CAUCE_OPENCLAW_EMBEDDED_FALLBACK=never", () => {
  const { envelope } = runBridge("OPENCLAW_GATEWAY_TRANSPORT_FALLBACK", { CAUCE_OPENCLAW_EMBEDDED_FALLBACK: "never" });
  assert.equal(envelope.result?.ok, false);
  assert.match(envelope.result?.error ?? "", /disabled/u);
});

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

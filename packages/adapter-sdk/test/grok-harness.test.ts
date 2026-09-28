import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import { AdapterError, MalformedOutputError } from "../src/sdk/errors.js";
import { parseGrokOutput } from "../src/sdk/output-parser.js";
import { SpawnCommandRunner } from "../src/sdk/process-runner.js";
import type {
  CommandRunRequest,
  CommandRunResult,
  CommandRunner,
  StructuredOutput,
} from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter, grokDefinition } from "../src/harnesses/index.js";
import { esDiagnosticoDeArranque, esSesionNativaInexistente } from "../src/harnesses/shared.js";
import { testStateRoot } from "./test-state.js";

/*
 * The Grok CLI harness (`@xai-official/grok`, measured on 1.0.41 in agv2-steven-hades-oc).
 * The fixture JSON and the stderr strings below are real captures; only the ids were replaced.
 */

const stateRoot = testStateRoot();
const fixture = resolve("test/fixtures/fake-grok.mjs");
const GROK_ARGS = ["--prompt-file", "/dev/stdin", "--output-format", "json", "--always-approve", "--verbatim"];
/** Real stderr of `grok --resume <id>` for an id neither local nor remote knows (exit 1, stdout empty). */
const DEAD_SESSION_STDERR = [
  'Session "00000000-0000-7000-8000-00000000dead" not found locally, restoring conversation from remote...',
  "  [0.000s] 🔎 Fetching session record — Loading restore metadata from the registry",
  "Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found",
  "",
].join("\n");

const SUCCESS: StructuredOutput = {
  reply: "trabajo terminado",
  messages: [],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

async function freshStore(name: string): Promise<DurableStore> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  return DurableStore.open(directory);
}

function fixedRunner(result: Partial<CommandRunResult>): CommandRunner {
  return {
    run: async (): Promise<CommandRunResult> => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      ...result,
    }),
  };
}

class RecordingRunner implements CommandRunner {
  readonly requests: CommandRunRequest[] = [];
  constructor(private readonly inner: CommandRunner) {}

  run(request: CommandRunRequest): Promise<CommandRunResult> {
    this.requests.push(request);
    return this.inner.run(request);
  }
}

function grokJson(fields: Record<string, unknown>): string {
  return `${JSON.stringify(fields, null, 2)}\n`;
}

/* ---------------------------------------------------------------- dialect ---- */

test("Grok 1.0.41 captured JSON: envelope in text, observed sessionId, exact argv", async () => {
  const capture = await readFile(resolve("test/fixtures/dialects/grok-1.0.41.json"), "utf8");
  const parsed = parseGrokOutput(capture);
  assert.deepEqual(parsed.output, {
    ...SUCCESS,
    reply: "Guardé la palabra clave de esta conversación: GIRASOL.",
  });
  assert.equal(parsed.nativeSessionId, "01a0cc7c-0000-7000-8000-000000001041");
  // `thought` is private reasoning: it never becomes part of the result.
  assert.equal(JSON.stringify(parsed).includes("keyword"), false);

  assert.equal(grokDefinition.command, "grok");
  assert.equal(grokDefinition.sessionStrategy.kind, "observed");
  assert.equal(grokDefinition.stdinSource, "file");
  assert.equal(grokDefinition.startWitness, undefined, "json prints only at the end: no witness");
  assert.deepEqual([...grokDefinition.baseArgs, ...grokDefinition.sessionArgs({ resume: false })], GROK_ARGS);
  assert.equal(grokDefinition.baseArgs.includes("-p"), false, "-p would put the prompt in argv");
  assert.deepEqual(grokDefinition.sessionArgs({ sessionId: "stale-id", resume: false }), []);
  assert.deepEqual(
    grokDefinition.sessionArgs({ sessionId: parsed.nativeSessionId, resume: true }),
    ["--resume", "01a0cc7c-0000-7000-8000-000000001041"],
  );
  assert.equal(HARNESS_DEFINITIONS.grok, grokDefinition);
});

test("Grok text glues every assistant text of the turn: prose survives, one embedded envelope is recovered", () => {
  // Real shape: "voy" said before a tool call, "listo" after it, `text` = "voylisto".
  const glued = parseGrokOutput(grokJson({ text: "voylisto", stopReason: "end_turn", sessionId: "s-glued", num_turns: 2 }));
  assert.deepEqual(glued, { output: { ...SUCCESS, reply: "voylisto" }, nativeSessionId: "s-glued" });

  const embedded = parseGrokOutput(grokJson({
    text: `voy a revisar${JSON.stringify(SUCCESS)}`,
    stopReason: "end_turn",
    sessionId: "s-embedded",
  }));
  assert.deepEqual(embedded, { output: SUCCESS, nativeSessionId: "s-embedded" });
});

test("Grok: a stopReason other than end_turn is a failed turn that keeps what Grok said", () => {
  for (const stopReason of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) {
    const parsed = parseGrokOutput(grokJson({
      text: JSON.stringify(SUCCESS),
      stopReason,
      sessionId: `s-${stopReason}`,
    }));
    assert.equal(parsed.output.status, "failed", stopReason);
    assert.equal(parsed.output.retryable, false);
    assert.deepEqual(parsed.output.messages, []);
    assert.match(String(parsed.output.reply), new RegExp(`stopReason '${stopReason}'`, "u"));
    assert.match(String(parsed.output.reply), /trabajo terminado/u);
    assert.equal(parsed.nativeSessionId, `s-${stopReason}`);
  }
});

test("Grok: an error object is a failed turn carrying Grok's raw message", () => {
  const parsed = parseGrokOutput('{"type":"error","message":"Couldn\'t start session: model unavailable"}\n');
  assert.equal(parsed.output.status, "failed");
  assert.equal(parsed.output.retryable, false);
  assert.match(String(parsed.output.reply), /Couldn't start session: model unavailable/u);
});

test("Grok: a blank final text fails visibly but keeps the session id", () => {
  const parsed = parseGrokOutput(grokJson({ text: "  ", stopReason: "end_turn", sessionId: "s-blank" }));
  assert.equal(parsed.output.status, "failed");
  assert.match(String(parsed.output.reply), /without visible text/u);
  assert.equal(parsed.nativeSessionId, "s-blank");
});

test("Grok: output that is not the JSON object, or has no text, is malformed", () => {
  for (const stdout of [
    "",
    "Error: Failed to read '/dev/stdin': No such device or address (os error 6)\n",
    '["not","an","object"]',
    grokJson({ stopReason: "end_turn", sessionId: "s-no-text" }),
  ]) {
    assert.throws(() => parseGrokOutput(stdout), (error: unknown) =>
      error instanceof MalformedOutputError && error.code === "MALFORMED_OUTPUT", JSON.stringify(stdout));
  }
});

/* ---------------------------------------------------------------- adapter ---- */

test("Grok starts without a session, stores the observed ID, then resumes it; fd 0 is a file", async () => {
  const store = await freshStore("grok-observed-session");
  const runner = new RecordingRunner(new SpawnCommandRunner());
  const adapter = new HarnessAdapter({
    definition: grokDefinition,
    runner,
    store,
    commandOverride: { command: process.execPath, prefixArgs: [fixture] },
  });
  const request = {
    prompt: "SCENARIO:success",
    sessionKey: "conversation-observed",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  };

  const first = await adapter.execute(request);
  assert.equal(first.status, "done");
  const firstRequest = runner.requests[0];
  assert.ok(firstRequest);
  assert.deepEqual(firstRequest.args, [fixture, ...GROK_ARGS]);
  assert.equal(firstRequest.stdinSource, "file");
  assert.deepEqual(store.getSession("grok:conversation-observed"), {
    native_id: "grok-native",
    initialized: true,
  });

  await adapter.execute(request);
  assert.deepEqual(runner.requests[1]?.args, [fixture, ...GROK_ARGS, "--resume", "grok-native"]);

  // The durable sessions file must accept its own grok key after a restart.
  const reopened = await DurableStore.open(resolve(stateRoot, "grok-observed-session"));
  assert.equal(reopened.getSession("grok:conversation-observed")?.native_id, "grok-native");
});

test("Grok with a cauce_reply deposit: the deposit wins and the session id still persists", async () => {
  const store = await freshStore("grok-mcp-deposit");
  const deposit: StructuredOutput = { ...SUCCESS, reply: "depositado por MCP" };
  const adapter = new HarnessAdapter({
    definition: grokDefinition,
    // After cauce_reply Grok may end the turn with no text at all.
    runner: fixedRunner({ stdout: grokJson({ text: "", stopReason: "end_turn", sessionId: "grok-mcp" }) }),
    store,
  });
  const output = await adapter.execute({
    prompt: "trabajo",
    sessionKey: "conversation-mcp",
    timeoutMs: 2_000,
    signal: new AbortController().signal,
    emissionOutput: () => deposit,
  });
  assert.equal(output.reply, "depositado por MCP");
  assert.equal(output.status, "done");
  assert.equal(store.getSession("grok:conversation-mcp")?.native_id, "grok-mcp");
});

test("Grok: a dead session is a retryable preflight failure with the raw cause, and is forgotten", async () => {
  const store = await freshStore("grok-dead-session");
  const key = "grok:conversation-dead";
  await store.setSession(key, { native_id: "00000000-0000-7000-8000-00000000dead", initialized: true });
  const runner = new RecordingRunner(fixedRunner({ exitCode: 1, stderr: DEAD_SESSION_STDERR }));
  const adapter = new HarnessAdapter({ definition: grokDefinition, runner, store });

  await assert.rejects(
    adapter.execute({
      prompt: "no llega al modelo",
      sessionKey: "conversation-dead",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AdapterError);
      assert.equal(error.code, "PROCESS_EXIT_PREFLIGHT");
      assert.equal(error.retryable, true);
      assert.match(error.message, /session get failed: 404 Not Found/u);
      return true;
    },
  );
  assert.deepEqual(runner.requests[0]?.args.slice(-2), ["--resume", "00000000-0000-7000-8000-00000000dead"]);
  assert.equal(store.getSession(key), undefined, "the dead pointer survived");
});

test("Grok: a restore that fails on the network is retried WITHOUT forgetting the conversation", async () => {
  const store = await freshStore("grok-restore-network");
  const key = "grok:conversation-network";
  const saved = { native_id: "01a0cc7c-0000-7000-8000-0000000000ff", initialized: true };
  await store.setSession(key, saved);
  const networkStderr = "Error: Failed to restore session from remote: fetching session record: "
    + "error sending request: connection refused\n";
  const adapter = new HarnessAdapter({
    definition: grokDefinition,
    runner: fixedRunner({ exitCode: 1, stderr: networkStderr }),
    store,
  });

  await assert.rejects(
    adapter.execute({
      prompt: "trabajo",
      sessionKey: "conversation-network",
      timeoutMs: 2_000,
      signal: new AbortController().signal,
    }),
    (error: unknown) => error instanceof AdapterError
      && error.code === "PROCESS_EXIT_PREFLIGHT"
      && error.retryable,
  );
  assert.deepEqual(store.getSession(key), saved);
  assert.equal(esDiagnosticoDeArranque(DEAD_SESSION_STDERR), true);
  assert.equal(esSesionNativaInexistente(DEAD_SESSION_STDERR), true);
  assert.equal(esSesionNativaInexistente(networkStderr), false);
});

/* ----------------------------------------------------------------- runner ---- */

const READ_STDIN_BY_PATH = [
  'const fs = require("node:fs");',
  "const stat = fs.fstatSync(0);",
  'process.stdout.write(JSON.stringify({ regularFile: stat.isFile(), links: stat.nlink,',
  '  prompt: fs.readFileSync("/dev/stdin", "utf8") }));',
].join("\n");

async function withTmpdir<T>(name: string, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = resolve(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    return await run(directory);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

test("stdinSource file: fd 0 is an unlinked regular file readable by path, and nothing is left behind", async () => {
  await withTmpdir("grok-stdin-file", async (directory) => {
    const prompt = "prompt secreto de la entrega\ncon varias lineas";
    const result = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["-e", READ_STDIN_BY_PATH],
      harness: "grok",
      stdin: prompt,
      stdinSource: "file",
      timeoutMs: 5_000,
      signal: new AbortController().signal,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { regularFile: true, links: 0, prompt });
    assert.deepEqual(await readdir(directory), [], "the staged prompt outlived the spawn");
  });
});

test("the default pipe cannot be reopened by path: why Grok needs stdinSource file", async (context) => {
  if (process.platform !== "linux") {
    context.skip("/proc/self/fd reopen semantics are Linux-specific");
    return;
  }
  const result = await new SpawnCommandRunner().run({
    command: process.execPath,
    args: ["-e", READ_STDIN_BY_PATH],
    harness: "grok",
    stdin: "hola desde el pipe",
    timeoutMs: 5_000,
    signal: new AbortController().signal,
  });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /ENXIO|no such device or address/iu);
});

test("stdinSource file: a prompt that cannot be staged fails before spawning and is retryable", async () => {
  await withTmpdir("grok-stdin-unwritable", async (directory) => {
    process.env.TMPDIR = resolve(directory, "does-not-exist");
    await assert.rejects(
      new SpawnCommandRunner().run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        harness: "grok",
        stdin: "hola sin disco",
        stdinSource: "file",
        timeoutMs: 5_000,
        signal: new AbortController().signal,
      }),
      (error: unknown) => error instanceof AdapterError
        && error.code === "PROMPT_STDIN_UNAVAILABLE"
        && error.retryable,
    );
  });
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  MAX_FINAL_TEXT_BYTES,
  parseClaudeOutput,
  parseCodexOutput,
  parseFinalText,
  parseHermesOutput,
  parseOpenClawOutput,
  parseOpenCodeOutput,
} from "../src/sdk/output-parser.js";
import { codexDefinition } from "../src/harnesses/codex.js";
import {
  OPEN_CODE_KANT_ATTACH_URL,
  OPEN_CODE_KANT_WORKING_DIRECTORY,
  openCodeDefinition,
} from "../src/harnesses/opencode.js";

test("OpenCode 1.17.7 captured JSONL accumulates part.text and observes sessionID", async () => {
  const capture = await readFile(resolve("test/fixtures/dialects/opencode-1.17.7.jsonl"), "utf8");
  const parsed = parseOpenCodeOutput(capture);
  assert.equal(parsed.output.reply, "OpenCode 1.17.7 captured");
  assert.equal(parsed.nativeSessionId, "ses_opencode_1177");
  assert.equal(openCodeDefinition.sessionStrategy.kind, "observed");
  assert.deepEqual(
    [...openCodeDefinition.baseArgs, ...openCodeDefinition.sessionArgs({ resume: false })],
    [
      "run",
      "--format",
      "json",
      "--attach",
      "http://127.0.0.1:4097",
      "--dir",
      "/workspace/kant",
    ],
  );
  assert.equal(OPEN_CODE_KANT_ATTACH_URL, "http://127.0.0.1:4097");
  assert.equal(OPEN_CODE_KANT_WORKING_DIRECTORY, "/workspace/kant");
  assert.deepEqual(
    openCodeDefinition.sessionArgs({ sessionId: "stale-generated-id", resume: false }),
    [],
  );
  assert.deepEqual(
    openCodeDefinition.sessionArgs({ sessionId: parsed.nativeSessionId, resume: true }),
    ["--session", "ses_opencode_1177"],
  );
});

test("Codex 0.144.6 captured JSONL parses agent_message and thread id", async () => {
  const capture = await readFile(resolve("test/fixtures/dialects/codex-0.144.6.jsonl"), "utf8");
  const parsed = parseCodexOutput(capture);
  assert.equal(parsed.output.reply, "Codex 0.144.6 captured");
  assert.equal(parsed.nativeSessionId, "thr_codex_01446");
  assert.deepEqual(
    [...codexDefinition.baseArgs, ...codexDefinition.sessionArgs({ resume: false })],
    ["exec", "--skip-git-repo-check", "--json", "-"],
  );
});

test("plain final text falls back safely for every native harness dialect", () => {
  const cases = [
    parseHermesOutput(JSON.stringify({ result: "Hermes plain" })),
    parseOpenCodeOutput(`${JSON.stringify({ type: "text", sessionID: "oc", part: { type: "text", text: "OpenCode plain" } })}\n`),
    parseClaudeOutput(JSON.stringify({ type: "result", result: "Claude plain", session_id: "claude" })),
    parseCodexOutput([
      JSON.stringify({ type: "thread.started", thread_id: "codex" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Codex plain" } }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n")),
    parseOpenClawOutput(JSON.stringify({ payloads: [{ text: "OpenClaw plain" }] })),
  ];
  assert.deepEqual(cases.map(({ output }) => output), ["Hermes", "OpenCode", "Claude", "Codex", "OpenClaw"].map((name) => ({
    reply: `${name} plain`,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  })));
});

test("OpenClaw unwraps the live bridge envelope and never exposes metadata", () => {
  const payload = {
    reply: "payload reply",
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
  const parsed = parseOpenClawOutput(JSON.stringify({
    result: {
      result: {
        payloads: [{ text: JSON.stringify(payload) }],
        meta: {
          finalAssistantVisibleText: "metadata fallback",
          providerInternal: "must stay private",
        },
      },
      runId: "run-live",
      status: "ok",
      summary: "private native summary",
    },
    session_id: "session-live",
  }));

  assert.deepEqual(parsed, { output: payload, nativeSessionId: "session-live" });
  assert.equal(JSON.stringify(parsed).includes("providerInternal"), false);
  assert.equal(JSON.stringify(parsed).includes("private native summary"), false);
});

test("OpenClaw uses finalAssistantVisibleText only when no payload text exists", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({
    output: {
      result: {
        payloads: [],
        meta: { finalAssistantVisibleText: "visible plain fallback", nativeTrace: "hidden" },
      },
    },
    sessionId: "visible-session",
  }));
  assert.equal(parsed.output.reply, "visible plain fallback");
  assert.equal(parsed.nativeSessionId, "visible-session");
  assert.equal(JSON.stringify(parsed).includes("nativeTrace"), false);
});

test("OpenClaw bounds result/output wrapper traversal", () => {
  let nested: unknown = "too deep";
  for (let depth = 0; depth < 10; depth += 1) nested = { result: nested };
  assert.throws(() => parseOpenClawOutput(JSON.stringify(nested)), /nesting limit/u);
});

test("plain fallback rejects non-visible, oversized and object-like malformed output", () => {
  assert.throws(() => parseFinalText("  ", "test final"), /visible text/u);
  assert.throws(() => parseFinalText("x".repeat(MAX_FINAL_TEXT_BYTES + 1), "test final"), /limit/u);
  // CONTRACT CHANGE 2026-08-05: a truncated envelope with a complete `reply` is NO LONGER lost
  // entirely, the response is delivered (see fence.test.ts). Losing the turn cost the agent
  // minutes of work for a single truncated accessory field. A truncated envelope WITHOUT a
  // salvageable reply keeps the diagnosis as a `failed` result, but never materializes its accessory fields.
  assert.equal(parseFinalText('{"reply":"truncated"', "test final").reply, "truncated");
  const ilegible = parseFinalText('{"messages":[', "test final");
  assert.equal(ilegible.status, "failed");
  assert.equal(ilegible.retryable, false);
  assert.deepEqual(ilegible.messages, []);
  assert.match(ilegible.reply ?? "", /no quedo ni una linea de texto rescatable/u);
  // A WELL-FORMED object that violates the schema is still a hard failure: there the agent
  // declared a complete envelope and is missing fields, it is not a transport cut.
  assert.throws(
    () => parseFinalText('{"reply":"schema-invalid"}', "test final"),
    /missing 'messages'/u,
  );
});

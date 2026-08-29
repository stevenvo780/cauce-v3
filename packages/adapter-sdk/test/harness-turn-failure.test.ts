import assert from "node:assert/strict";
import test from "node:test";
import {
  parseClaudeOutput,
  parseCodexOutput,
  parseHermesOutput,
  parseOpenClawOutput,
  parseOpenCodeOutput,
} from "../src/sdk/output-parser.js";

/**
 * BUG 3 — a turn the harness declared FAILED was recorded as 'done'.
 *
 * None of these cases exits with a non-zero code, so the `shared.ts` net
 * (`exitCode !== 0` → PROCESS_EXIT_AMBIGUOUS) does not see them: the failure travels INSIDE the JSON.
 * Fields verified on 2026-07-29 against the installed claude 2.1.220 and codex 0.145.0.
 */

const SUCCESS = {
  reply: "trabajo terminado",
  messages: [],
  status: "done",
  retryable: false,
  artifacts: [],
} as const;

test("Claude: is_error con error_max_turns termina fallido, no 'done'", () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "error_max_turns",
    is_error: true,
    result: "Reached the maximum number of turns before finishing the task",
    session_id: "claude-native",
    num_turns: 40,
  }));

  assert.equal(parsed.output.status, "failed");
  assert.equal(parsed.output.retryable, false);
  assert.deepEqual(parsed.output.messages, []);
  assert.match(String(parsed.output.reply), /error_max_turns/u);
  // The harness's own text is kept: it is the only thing that explains the failure.
  assert.match(String(parsed.output.reply), /maximum number of turns/u);
  assert.equal(parsed.nativeSessionId, "claude-native");
});

test("Claude: error_during_execution también termina fallido aunque traiga un sobre 'done'", () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: JSON.stringify(SUCCESS),
    session_id: "claude-native",
  }));

  assert.equal(parsed.output.status, "failed");
  assert.deepEqual(parsed.output.messages, []);
  assert.match(String(parsed.output.reply), /error_during_execution/u);
});

test("Claude: el turno exitoso no cambia", () => {
  const parsed = parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify(SUCCESS),
    session_id: "claude-native",
  }));

  assert.equal(parsed.output.status, "done");
  assert.equal(parsed.output.reply, "trabajo terminado");
});

test("Codex: turn.failed después del agent_message termina fallido", () => {
  const parsed = parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "thr_codex" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(SUCCESS) } }),
    JSON.stringify({ type: "turn.failed", error: { message: "usage limit reached for this account" } }),
  ].join("\n"));

  assert.equal(parsed.output.status, "failed");
  assert.equal(parsed.output.retryable, false);
  assert.match(String(parsed.output.reply), /usage limit reached/u);
  assert.equal(parsed.nativeSessionId, "thr_codex");
});

test("Codex: un ítem de tipo error termina fallido", () => {
  const parsed = parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "thr_codex" }),
    JSON.stringify({ type: "item.completed", item: { type: "error", message: "stream disconnected before completion" } }),
  ].join("\n"));

  assert.equal(parsed.output.status, "failed");
  assert.match(String(parsed.output.reply), /stream disconnected/u);
});

test("Codex: un error seguido de un agent_message es un reintento interno que sí completó", () => {
  const parsed = parseCodexOutput([
    JSON.stringify({ type: "thread.started", thread_id: "thr_codex" }),
    JSON.stringify({ type: "error", message: "transient 429, retrying" }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(SUCCESS) } }),
    JSON.stringify({ type: "turn.completed" }),
  ].join("\n"));

  assert.equal(parsed.output.status, "done");
  assert.equal(parsed.output.reply, "trabajo terminado");
});

test("OpenClaw: una corrida nativa con status de fallo no se toma como respuesta buena", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({
    result: {
      runId: "run-1",
      status: "error",
      error: { message: "gateway refused the agent turn" },
      result: { payloads: [{ text: "avancé hasta la mitad y me corté" }] },
    },
    session_id: "openclaw-native",
  }));

  assert.equal(parsed.output.status, "failed");
  assert.deepEqual(parsed.output.messages, []);
  assert.match(String(parsed.output.reply), /gateway refused the agent turn/u);
  assert.equal(parsed.nativeSessionId, "openclaw-native");
});

test("OpenClaw: ok:false termina fallido aunque el payload traiga un sobre 'done'", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({
    result: { ok: false, error: "provider quota exhausted", payloads: [{ text: JSON.stringify(SUCCESS) }] },
  }));

  assert.equal(parsed.output.status, "failed");
  assert.match(String(parsed.output.reply), /provider quota exhausted/u);
});

test("OpenClaw: la corrida sana sigue pasando por el camino de siempre", () => {
  const parsed = parseOpenClawOutput(JSON.stringify({
    result: { runId: "run-1", status: "ok", result: { payloads: [{ text: JSON.stringify(SUCCESS) }] } },
    session_id: "openclaw-native",
  }));

  assert.equal(parsed.output.status, "done");
  assert.equal(parsed.output.reply, "trabajo terminado");
});

test("Hermes: el objeto nativo con ok:false termina fallido", () => {
  const parsed = parseHermesOutput(JSON.stringify({
    result: { ok: false, error: "No usable credentials found for provider 'openai-api'" },
    session_id: "hermes-native",
  }));

  assert.equal(parsed.output.status, "failed");
  assert.equal(parsed.output.retryable, false);
  assert.match(String(parsed.output.reply), /No usable credentials/u);
});

test("Hermes: un sobre de puente con error al tope termina fallido", () => {
  const parsed = parseHermesOutput(JSON.stringify({
    error: "hermes one-shot returned an HTTP error without a response",
    result: "HTTP 503 upstream unavailable",
  }));

  assert.equal(parsed.output.status, "failed");
  assert.match(String(parsed.output.reply), /HTTP error/u);
});

test("Hermes: el resultado sano no cambia", () => {
  const parsed = parseHermesOutput(JSON.stringify({ result: SUCCESS, session_id: "hermes-native" }));
  assert.equal(parsed.output.status, "done");
  assert.equal(parsed.output.reply, "trabajo terminado");
});

test("OpenCode: un evento de error después del texto termina fallido", () => {
  const parsed = parseOpenCodeOutput([
    JSON.stringify({ type: "step_start", sessionID: "ses_oc" }),
    JSON.stringify({ type: "text", sessionID: "ses_oc", part: { type: "text", text: JSON.stringify(SUCCESS) } }),
    JSON.stringify({ type: "error", sessionID: "ses_oc", error: { message: "session aborted by the server" } }),
  ].join("\n"));

  assert.equal(parsed.output.status, "failed");
  assert.match(String(parsed.output.reply), /session aborted by the server/u);
  assert.equal(parsed.nativeSessionId, "ses_oc");
});

test("un turno fallido nunca arrastra delegaciones que no se van a materializar", () => {
  const conDelegacion = {
    reply: "delego el resto",
    messages: [{ to: "kant", body: "seguí vos desde acá" }],
    status: "done",
    retryable: false,
    artifacts: [],
  };
  const parsed = parseClaudeOutput(JSON.stringify({
    type: "result",
    subtype: "error_max_budget_usd",
    is_error: true,
    result: JSON.stringify(conDelegacion),
    session_id: "claude-native",
  }));

  assert.equal(parsed.output.status, "failed");
  assert.deepEqual(parsed.output.messages, []);
});

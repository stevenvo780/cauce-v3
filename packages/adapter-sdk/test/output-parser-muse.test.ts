import assert from "node:assert/strict";
import test from "node:test";
import { HARNESS_DEFINITIONS } from "../src/harnesses/index.js";
import { museDefinition } from "../src/harnesses/muse.js";
import { validateSessionsFile } from "../src/sdk/durable-store/session-file.js";
import { parseMuseOutput } from "../src/sdk/output-parser.js";

// Records trimmed from a real `muse exec --json` run (Muse Code 1.4.0): the session record, the
// output deltas and the terminal record. The run answered "HOLA".
const RUN = [
  "{\"schema_version\":1,\"id\":\"00000000-0000-4000-8000-b4e2518edac6\",\"stream\":{\"kind\":\"session\",\"id\":\"00000000-0000-4000-8000-f30219022182\"},\"sequence\":1,\"recorded_at\":1780531400000000,\"record_type\":\"reconciliation\",\"durability\":\"durable\",\"causation_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"payload_type\":\"runtime.command.accepted\",\"payload_schema_version\":1,\"payload\":{\"client_id\":null,\"command_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"command_kind\":\"turn.submit\",\"kind\":\"command_accepted\"}}",
  "{\"schema_version\":1,\"id\":\"00000000-0000-4000-8000-313f4b516236\",\"stream\":{\"kind\":\"session\",\"id\":\"00000000-0000-4000-8000-f30219022182\"},\"sequence\":19,\"recorded_at\":1780531400000034,\"record_type\":\"status\",\"durability\":\"ephemeral\",\"causation_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"payload_type\":\"run.output.delta\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run_output_delta\",\"run_stream\":{\"id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run\"},\"text\":\"H\"}}",
  "{\"schema_version\":1,\"id\":\"00000000-0000-4000-8000-ee3886a97988\",\"stream\":{\"kind\":\"session\",\"id\":\"00000000-0000-4000-8000-f30219022182\"},\"sequence\":20,\"recorded_at\":1780531400000036,\"record_type\":\"status\",\"durability\":\"ephemeral\",\"causation_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"payload_type\":\"run.output.delta\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run_output_delta\",\"run_stream\":{\"id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run\"},\"text\":\"OLA\"}}",
  "{\"schema_version\":1,\"id\":\"00000000-0000-4000-8000-9d79d9209e63\",\"stream\":{\"kind\":\"session\",\"id\":\"00000000-0000-4000-8000-f30219022182\"},\"sequence\":31,\"recorded_at\":1780531400000058,\"record_type\":\"event\",\"durability\":\"durable\",\"causation_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"payload_type\":\"run.terminal.completed\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run_terminal\",\"reason\":null,\"run_stream\":{\"id\":\"00000000-0000-4000-8000-a2ac7545efdc\",\"kind\":\"run\"},\"terminal\":\"completed\",\"text\":\"HOLA\"}}"
].join("\n");
const SESSION = "00000000-0000-4000-8000-f30219022182";

test("muse: final text and session id from a completed run", () => {
  const parsed = JSON.stringify(parseMuseOutput(RUN));
  assert.match(parsed, /HOLA/);
  assert.ok(parsed.includes(SESSION));
});

test("muse: a terminal other than completed is a failure, not an answer", () => {
  const parsed = JSON.stringify(parseMuseOutput(RUN.replace('"terminal":"completed"', '"terminal":"failed"')));
  assert.match(parsed, /fail/i);
});

test("muse: deltas are the fallback when the terminal carries no text", () => {
  const parsed = JSON.stringify(parseMuseOutput(RUN.replace('"text":"HOLA"}', '"text":""}')));
  assert.match(parsed, /HOLA/);
});

test("muse: prompt through the muse-cauce bridge and resume by --session-id", () => {
  assert.equal(museDefinition.command, "muse-cauce");
  assert.deepEqual(museDefinition.baseArgs, ["exec", "--json", "--yolo", "--trust-workspace"]);
  assert.deepEqual(museDefinition.sessionArgs({ sessionId: "s-1", resume: true }), ["--session-id", "s-1"]);
  assert.deepEqual(museDefinition.sessionArgs({ sessionId: undefined, resume: false } as never), []);
});

// The clio incident: the sessions.json regex did not know "muse", so the first persisted session
// failed "secure validation" and every delivery died as INTERNAL. Every registered harness must be able to
// store its session.
test("sessions.json accepts the session of every registered harness", () => {
  for (const id of Object.keys(HARNESS_DEFINITIONS)) {
    const file = { version: 1, sessions: { [`${id}:scope-1`]: { native_id: "n-1", initialized: true } } };
    assert.doesNotThrow(() => validateSessionsFile(file), id);
  }
});

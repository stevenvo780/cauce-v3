import assert from "node:assert/strict";
import test from "node:test";
import { museDefinition } from "../src/harnesses/muse.js";
import { parseMuseOutput } from "../src/sdk/output-parser.js";

// Records trimmed from a real `muse exec --json` run (Muse Code 1.4.0, 2026-09-27): the session record, the
// output deltas and the terminal record. The run answered "HOLA".
const RUN = [
  "{\"schema_version\":1,\"id\":\"018f0000-0000-7000-8000-00000000c350\",\"stream\":{\"kind\":\"session\",\"id\":\"01a0e53f-1799-71d0-8531-21ed64d15827\"},\"sequence\":1,\"recorded_at\":1780531400000000,\"record_type\":\"reconciliation\",\"durability\":\"durable\",\"causation_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"payload_type\":\"runtime.command.accepted\",\"payload_schema_version\":1,\"payload\":{\"client_id\":null,\"command_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"command_kind\":\"turn.submit\",\"kind\":\"command_accepted\"}}",
  "{\"schema_version\":1,\"id\":\"018f0000-0000-7000-8000-00000000c372\",\"stream\":{\"kind\":\"session\",\"id\":\"01a0e53f-1799-71d0-8531-21ed64d15827\"},\"sequence\":19,\"recorded_at\":1780531400000034,\"record_type\":\"status\",\"durability\":\"ephemeral\",\"causation_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"payload_type\":\"run.output.delta\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run_output_delta\",\"run_stream\":{\"id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run\"},\"text\":\"H\"}}",
  "{\"schema_version\":1,\"id\":\"018f0000-0000-7000-8000-00000000c374\",\"stream\":{\"kind\":\"session\",\"id\":\"01a0e53f-1799-71d0-8531-21ed64d15827\"},\"sequence\":20,\"recorded_at\":1780531400000036,\"record_type\":\"status\",\"durability\":\"ephemeral\",\"causation_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"payload_type\":\"run.output.delta\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run_output_delta\",\"run_stream\":{\"id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run\"},\"text\":\"OLA\"}}",
  "{\"schema_version\":1,\"id\":\"018f0000-0000-7000-8000-00000000c38a\",\"stream\":{\"kind\":\"session\",\"id\":\"01a0e53f-1799-71d0-8531-21ed64d15827\"},\"sequence\":31,\"recorded_at\":1780531400000058,\"record_type\":\"event\",\"durability\":\"durable\",\"causation_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"payload_type\":\"run.terminal.completed\",\"payload_schema_version\":1,\"payload\":{\"command_id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run_terminal\",\"reason\":null,\"run_stream\":{\"id\":\"e4d2761d-26c6-41f9-a190-370fdcd2fa92\",\"kind\":\"run\"},\"terminal\":\"completed\",\"text\":\"HOLA\"}}"
].join("\n");
const SESSION = "01a0e53f-1799-71d0-8531-21ed64d15827";

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

test("muse: prompt on stdin and resume by --session-id", () => {
  assert.deepEqual(museDefinition.baseArgs, ["exec", "--json", "--yolo", "--trust-workspace", "--prompt-file", "/dev/stdin"]);
  assert.deepEqual(museDefinition.sessionArgs({ sessionId: "s-1", resume: true } as never), ["--session-id", "s-1"]);
  assert.deepEqual(museDefinition.sessionArgs({ sessionId: undefined, resume: false } as never), []);
});

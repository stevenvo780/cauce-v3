import assert from "node:assert/strict";
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { consumptionWitness, inputDigest, matchingConsumptionWitness } from "../src/shared-session/consumption.js";
import { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { claudeTranscript, claudeProvesConsumption, type TranscriptEntry } from "../src/shared-session/transcript.js";
import { codexProvesConsumption, codexTranscript } from "../src/shared-session/rollout.js";
import { museProvesConsumption, museTranscript, type MuseLogLine } from "../src/shared-session/muse.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { FakeTmux, assistantEntry, claudeRunner, envelopeText, freshState, userEntry } from "./shared-session-fixtures.js";
import { MuseLog, museWorkspace } from "./muse-shared-session-fixtures.js";

const line = (type: string, payload: Record<string, unknown>): string => JSON.stringify({ type, payload });
const request = (harness: "claude" | "codex" | "muse") => ({ harness, command: harness, args: [], stdin: "input A",
  timeoutMs: 2_000, signal: new AbortController().signal });

test("consumption binding rejects other input, session, harness and unbounded identifiers", () => {
  const witness = consumptionWitness("codex", "session-A", "turn-A", "input A");
  assert.ok(witness);
  assert.equal(matchingConsumptionWitness(witness, "codex", "input A", "session-A")?.input_sha256, inputDigest("input A"));
  assert.equal(matchingConsumptionWitness(witness, "codex", "input B", "session-A"), undefined);
  assert.equal(matchingConsumptionWitness(witness, "codex", "input A", "session-B"), undefined);
  assert.equal(matchingConsumptionWitness(witness, "claude", "input A", "session-A"), undefined);
  assert.equal(matchingConsumptionWitness(null, "codex", "input A", "session-A"), undefined);
  assert.equal(matchingConsumptionWitness({ ...witness, version: 2 }, "codex", "input A", "session-A"), undefined);
  assert.equal(matchingConsumptionWitness(witness, "codex", "input A", "session-A", "other-session"), undefined);
  assert.equal(consumptionWitness("codex", "x".repeat(257), "turn", "input"), undefined);
  assert.equal(consumptionWitness("codex", "/private/session", "turn", "input"), undefined);
});

test("Claude requires explicit same-session ancestry, never a compaction position bridge", () => {
  const entries: TranscriptEntry[] = [
    { type: "user", uuid: "input", sessionId: "sid", message: { content: "input" } },
    { type: "system", subtype: "compact_boundary", uuid: "boundary" },
    { type: "assistant", uuid: "final", parentUuid: "boundary", sessionId: "sid",
      message: { stop_reason: "end_turn", content: "answer" } },
  ];
  assert.equal(claudeProvesConsumption(entries, "input", "answer", "sid", "input"), false);
  entries[2] = { ...entries[2], parentUuid: "input" };
  assert.equal(claudeProvesConsumption(entries, "input", "answer", "sid", "input"), true);
  assert.equal(claudeProvesConsumption(entries, "input", "answer", "other-sid", "input"), false);
  assert.equal(claudeProvesConsumption(entries, "input", "other-answer", "sid", "input"), false);
});

test("Codex requires this injected turn's final response, never start or another turn", () => {
  const started = { type: "event_msg", payload: { type: "task_started", turn_id: "A" } };
  const final = { type: "event_msg", payload: { type: "task_complete", turn_id: "B", last_agent_message: "answer" } };
  const input = { type: "response_item", payload: { type: "message", role: "user",
    content: [{ type: "input_text", text: "input" }], internal_chat_message_metadata_passthrough: { turn_id: "B" } } };
  assert.equal(codexProvesConsumption([started, final], "A", "answer", "sid", "input"), false);
  assert.equal(codexProvesConsumption([input, final], "B", "answer", "sid", "input"), true);
  assert.equal(codexProvesConsumption([input, final], "B", "", "sid", "input"), false);
});

test("Muse accepted input and committed text stay unknown until the same run closes", () => {
  const log = new MuseLog("unused", "sid");
  const entries = [log.intent("A", "input"), log.started("A", "input"), log.message("A", "answer")]
    .map((raw) => JSON.parse(raw) as MuseLogLine);
  assert.equal(museProvesConsumption(entries, "A", "answer", "sid", "input"), false);
  entries.push(JSON.parse(log.terminal("B")) as MuseLogLine);
  assert.equal(museProvesConsumption(entries, "A", "answer", "sid", "input"), false);
  entries.push(JSON.parse(log.terminal("A")) as MuseLogLine);
  assert.equal(museProvesConsumption(entries, "A", "answer", "sid", "input"), true);
  assert.equal(museProvesConsumption(entries, "A", "answer", "foreign", "input"), false);
  assert.equal(museProvesConsumption(entries, "A", "answer", "sid", "other-input"), false);
  const foreign = new MuseLog("unused", "foreign");
  entries.push(JSON.parse(foreign.message("A", "answer")) as MuseLogLine);
  assert.equal(museProvesConsumption(entries, "A", "answer", "sid", "input"), false);
});

test("shared Claude emits receipt only after its native final descendant", async () => {
  const { home, workspace } = await freshState("receipt-native-claude");
  const sid = randomUUID(), turn = randomUUID(), file = join(transcriptDirectory(home, workspace), `${sid}.jsonl`);
  await appendFile(file, userEntry(randomUUID(), null, "previous", sid) + "\n");
  const tmux = new FakeTmux();
  tmux.onSubmit = async (text) => {
    await appendFile(file, userEntry(turn, null, text, sid) + "\n" + assistantEntry(randomUUID(), turn, envelopeText("answer"), sid) + "\n");
  };
  const runner = claudeRunner({ alias: "kratos", home, workspace, tmux });
  const output = await runner.run(request("claude"));
  assert.deepEqual(output.consumptionWitness, consumptionWitness("claude", sid, turn, "input A"));
});

test("shared Codex requires a CLI rollout and emits a same-input turn receipt", async () => {
  const { home } = await freshState("receipt-native-codex");
  const codexHome = join(home, ".codex"), directory = join(codexHome, "sessions");
  await mkdir(directory, { recursive: true });
  const sid = randomUUID(), turn = randomUUID(), file = join(directory, `rollout-now-${sid}.jsonl`);
  await appendFile(file, line("session_meta", { id: sid, source: "cli" }) + "\n");
  const tmux = new FakeTmux(); tmux.sessionName = "cauce-socrates"; tmux.paneStartCommand = "exec codex"; tmux.paneContent = "› ";
  tmux.onSubmit = async (text) => {
    await appendFile(file, [line("event_msg", { type: "task_started", turn_id: turn }),
      line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }],
        internal_chat_message_metadata_passthrough: { turn_id: turn } }),
      line("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: envelopeText("answer") })].join("\n") + "\n");
  };
  const runner = new PasteSessionRunner({ alias: "socrates", harness: "codex", workspace: "/workspace",
    transcript: codexTranscript(codexHome), tmux, sleep: () => Promise.resolve(), acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000, injectTimeoutMs: 20, settleMs: 0, pollMs: 1, readyTimeoutMs: 30 });
  assert.deepEqual((await runner.run(request("codex"))).consumptionWitness, consumptionWitness("codex", sid, turn, "input A"));
});

test("shared Muse emits receipt from committed final text and same intent run terminal", async () => {
  const { museData, log } = await museWorkspace("receipt-native-muse");
  const tmux = new FakeTmux(); tmux.sessionName = "cauce-hegel"; tmux.paneStartCommand = "exec muse"; tmux.paneContent = "❯";
  tmux.onSubmit = async (text) => { await log.append(log.intent("intent-A", text), log.started("intent-A", text),
    log.message("intent-A", envelopeText("answer")), log.terminal("intent-A")); };
  const runner = new PasteSessionRunner({ alias: "hegel", harness: "muse", workspace: "/workspace",
    transcript: museTranscript(museData), tmux, sleep: () => Promise.resolve(), acquireTimeoutMs: 30,
    turnTimeoutMs: 2_000, injectTimeoutMs: 20, settleMs: 0, pollMs: 1, readyTimeoutMs: 30 });
  assert.deepEqual((await runner.run(request("muse"))).consumptionWitness, consumptionWitness("muse", log.sessionId, "intent-A", "input A"));
});


test("unverified native attestor preserves the answer and suppresses its consumption receipt", async () => {
  const { state, home, workspace } = await freshState("receipt-unverified-native");
  const sid = randomUUID(), turn = randomUUID(), file = join(transcriptDirectory(home, workspace), `${sid}.jsonl`);
  await appendFile(file, userEntry(randomUUID(), null, "previous", sid) + "\n");
  const tmux = new FakeTmux();
  tmux.onSubmit = async (text) => { await appendFile(file, userEntry(turn, null, text, sid) + "\n"
    + assistantEntry(randomUUID(), turn, envelopeText("answer without correlation"), sid) + "\n"); };
  const nativePointer = new NativePointerAttestor(new SharedTuiPointerStore(state),
    { alias: "kratos", harness: "claude", configDirectory: join(home, ".claude"), workspace });
  const runner = new PasteSessionRunner({ alias: "kratos", harness: "claude", workspace, nativePointer,
    transcript: claudeTranscript(join(home, ".claude"), workspace), tmux, sleep: () => Promise.resolve(),
    acquireTimeoutMs: 30, turnTimeoutMs: 2_000, injectTimeoutMs: 20, settleMs: 0, pollMs: 1, readyTimeoutMs: 30 });
  const output = await runner.run(request("claude"));
  assert.equal(output.exitCode, 0);
  assert.ok(output.stdout.includes("answer without correlation"));
  assert.equal(output.consumptionWitness, undefined);
});

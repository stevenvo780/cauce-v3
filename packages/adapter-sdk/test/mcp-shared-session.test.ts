import assert from "node:assert/strict";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import type { StructuredOutput } from "../src/sdk/types.js";
import { FakeTmux, adapterFor, assistantEntry, claudeRunner, correlationIdFromPrompt, envelopeText, freshState, userEntry } from "./shared-session-fixtures.js";
import { EmissionRuntime } from "../src/sdk/mcp-emission/runtime.js";
import { renewableDelivery } from "./client-fixtures.js";

const OUTPUT: StructuredOutput = { reply: "deposited result", messages: [], notify: [], status: "done", retryable: false, artifacts: [] };
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

for (const terminalText of ["short final text", undefined]) {
  test(`shared TUI releases its turn after an MCP deposit with ${terminalText === undefined ? "no transcript answer" : "ordinary final text"}`, async () => {
    const { state, home, workspace } = await freshState(`mcp-harvest-${terminalText === undefined ? "idle" : "terminal"}`);
    const nativeId = randomUUID();
    const file = join(transcriptDirectory(home, workspace), `${nativeId}.jsonl`);
    const prior = randomUUID();
    await writeFile(file, `${userEntry(prior, null, "previous turn", nativeId)}\n`, { mode: 0o600 });
    let deposited: StructuredOutput | undefined;
    const tmux = new FakeTmux();
    tmux.onSubmit = async (prompt) => {
      const injected = randomUUID();
      await appendFile(file, `${userEntry(injected, prior, prompt, nativeId)}\n`);
      deposited = OUTPUT;
      if (terminalText !== undefined) await appendFile(file, `${assistantEntry(randomUUID(), injected, terminalText, nativeId)}\n`);
      tmux.paneContent = "❯ ";
    };
    const runner = claudeRunner({ alias: "zeus", home, workspace, tmux, quietTimeoutMs: 20, sleep: delay });
    const adapter = await adapterFor(runner, state, "zeus", "claude");
    const actual = await adapter.execute({ prompt: "perform task", timeoutMs: 2_000, signal: new AbortController().signal,
      emissionOutput: () => deposited });
    assert.equal(actual.reply, OUTPUT.reply);
    assert.equal(tmux.submittedCount, 1);
    assert.equal(tmux.interruptedCount, 0);
  });
}

test("native resume pointer accepts an MCP turn only with exact injected ancestry and final boundary", async () => {
  const { state, home, workspace } = await freshState("mcp-native-pointer");
  const binding = { alias: "zeus", harness: "claude" as const, configDirectory: join(home, ".claude"), workspace };
  const store = new SharedTuiPointerStore(state);
  const attestor = new NativePointerAttestor(store, binding);
  const nativeId = randomUUID();
  const file = join(transcriptDirectory(home, workspace), `${nativeId}.jsonl`);
  await writeFile(file, `${userEntry(randomUUID(), null, "earlier", nativeId)}\n`, { mode: 0o600 });
  const snapshot = await attestor.capture(new Map([[file, (await stat(file)).size]]));
  assert.ok(snapshot);
  const injected = randomUUID();
  await appendFile(file, `${userEntry(injected, null, "exact prompt", nativeId)}\n${assistantEntry(randomUUID(), injected, "ordinary final answer", nativeId)}\n`);
  assert.equal(await attestor.publish(snapshot, "a".repeat(64), "wrong prompt", "$1:@2:%3:1234", async () => true, true), "unverified");
  assert.equal(await attestor.publish(snapshot, "a".repeat(64), "exact prompt", "$1:@2:%3:1234", async () => true, true), "written");
  assert.deepEqual(await store.read(binding), { state: "valid", binding, nativeId });
});

test("a restarted shared runner rescues a durable MCP deposit without a textual envelope", async () => {
  const { state, home, workspace } = await freshState("mcp-crash-rescue");
  const nativeId = randomUUID();
  const file = join(transcriptDirectory(home, workspace), `${nativeId}.jsonl`);
  await writeFile(file, `${userEntry(randomUUID(), null, "earlier", nativeId)}\n`, { mode: 0o600 });
  const tmux = new FakeTmux();
  let lostPrompt = "";
  tmux.onSubmit = (prompt) => { lostPrompt = prompt; };
  const options = { alias: "zeus", home, workspace, tmux, quarantineFile: join(state, "quarantine"),
    correlationTimeoutMs: 20, quietTimeoutMs: 20, sleep: delay };
  const request = { command: "claude", args: [], harness: "claude" as const, stdin: "lost turn",
    timeoutMs: 2_000, signal: new AbortController().signal };
  assert.equal((await claudeRunner(options).run(request)).timedOut, true);
  const correlation = correlationIdFromPrompt(lostPrompt);
  const runtime = new EmissionRuntime(state, "instance-before-crash", async () => ({}));
  const turn = runtime.begin({
    delivery: { ...renewableDelivery("mcp", "000000000905", Date.now() + 30_000), recipient_alias: "zeus" },
    context: { self_alias: "zeus", sender_alias: "kant", tenant_id: "Steven", room_id: "grp.steven", channel: "cauce", agent_message: false, message_type: "request", routing_targets: [] },
    signal: request.signal, isCurrent: () => true,
  });
  turn.activate(correlation);
  assert.equal((await runtime.call("cauce_reply", { reply: OUTPUT.reply, status: "done", retryable: false })).isError, undefined);
  await runtime.close();
  tmux.onSubmit = async (prompt) => {
    const id = randomUUID();
    await appendFile(file, `${userEntry(id, null, prompt, nativeId)}\n${assistantEntry(randomUUID(), id, envelopeText("next result", correlationIdFromPrompt(prompt)), nativeId)}\n`);
  };
  const next = await claudeRunner(options).run({ ...request, stdin: "next turn" });
  assert.equal(next.timedOut, false);
  const rescued = JSON.parse(await readFile(join(state, "resultados-tardios", `${correlation}.json`), "utf8")) as { texto: string };
  assert.match(rescued.texto, /deposited result/u);
});

// A paste that lands while the TUI is still generating is queued by claude as a `queued_command`
// attachment, never as its own user entry, so the harvest cannot localize the turn and depends on
// the transcript going quiet. The quiet window used to be measured against the pre-paste baseline:
// once the in-flight turn wrote anything it never went quiet, and the MCP deposit sat until the 6 h
// lease cap (zeus f30f2319 and kant 57cb2fe0).
test("a paste merged into an in-flight turn releases its MCP deposit once the transcript goes quiet", async () => {
  const { state, home, workspace } = await freshState("mcp-merged-queued-command");
  const nativeId = randomUUID();
  const file = join(transcriptDirectory(home, workspace), `${nativeId}.jsonl`);
  const prior = randomUUID();
  await writeFile(file, `${userEntry(prior, null, "owner turn still running", nativeId)}\n`, { mode: 0o600 });
  let deposited: StructuredOutput | undefined;
  const tmux = new FakeTmux();
  tmux.onSubmit = async (prompt) => {
    await appendFile(file, `${JSON.stringify({ type: "attachment", sessionId: nativeId,
      attachment: { type: "queued_command", prompt } })}\n`);
    await appendFile(file, `${assistantEntry(randomUUID(), prior, "tool call of the owner turn", nativeId)}\n`);
    deposited = OUTPUT;
    await appendFile(file, `${assistantEntry(randomUUID(), prior, "done with both", nativeId)}\n`);
    tmux.paneContent = "❯ ";
  };
  const runner = claudeRunner({ alias: "kant", home, workspace, tmux, quietTimeoutMs: 50, sleep: delay });
  const adapter = await adapterFor(runner, state, "kant", "claude");
  const started = Date.now();
  const actual = await adapter.execute({ prompt: "merged task", timeoutMs: 5_000, signal: new AbortController().signal,
    emissionOutput: () => deposited });
  assert.equal(actual.reply, OUTPUT.reply);
  assert.ok(Date.now() - started < 4_000, `held for ${String(Date.now() - started)} ms`);
  assert.equal(tmux.submittedCount, 1);
});

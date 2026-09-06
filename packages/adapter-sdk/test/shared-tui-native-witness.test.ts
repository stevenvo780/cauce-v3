import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, chmod, rename, stat, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { NativePointerAttestor } from "../src/shared-session/native-witness.js";
import { SharedTuiPointerStore } from "../src/shared-session/native-pointer.js";
import { PasteSessionRunner } from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { claudeTranscript } from "../src/shared-session/transcript.js";
import {
  adapterFor, assistantEntry, correlationIdFromPrompt, envelopeText, execute,
  FakeTmux, freshState, RecordingFallback, userEntry,
} from "./shared-session-fixtures.js";

const generation = "$1:@2:%3:1234";

async function fixture(name: string) {
  const { state, home, workspace } = await freshState(`native-witness-${name}`);
  const binding = { alias: "zeus", harness: "claude" as const, configDirectory: join(home, ".claude"), workspace };
  const store = new SharedTuiPointerStore(state);
  const attestor = new NativePointerAttestor(store, binding);
  const nativeId = randomUUID();
  const directory = transcriptDirectory(home, workspace);
  const file = join(directory, `${nativeId}.jsonl`);
  const head = `${userEntry(randomUUID(), null, "earlier human turn", nativeId)}\n`;
  await writeFile(file, head, { mode: 0o600 });
  const baseline = new Map([[file, (await stat(file)).size]]);
  const snapshot = await attestor.capture(baseline);
  assert.ok(snapshot);
  const correlation = randomBytes(32).toString("hex");
  const prompt = "correlated injected turn";
  const terminal = (id: string = nativeId, nonce = correlation, text = envelopeText("done", nonce)): string =>
    `${assistantEntry(randomUUID(), randomUUID(), text, id)}\n`;
  const publish = (current = true) => attestor.publish(
    snapshot, correlation, prompt, generation, () => Promise.resolve(current),
  );
  return { state, home, workspace, binding, store, attestor, nativeId, directory, file, head,
    baseline, snapshot, correlation, prompt, terminal, publish };
}

test("native witness publishes only the exact grown correlated session and supports a witnessed clear", async () => {
  const f = await fixture("valid");
  await appendFile(f.file, `${userEntry(randomUUID(), null, f.prompt, f.nativeId)}\n${f.terminal()}`);
  assert.equal(await f.publish(), "written");
  assert.deepEqual(await f.store.read(f.binding), {
    state: "valid", binding: f.binding, nativeId: f.nativeId,
  });
  const nextBaseline = new Map([[f.file, (await stat(f.file)).size]]);
  const next = await f.attestor.capture(nextBaseline);
  assert.ok(next);
  const newId = randomUUID();
  await writeFile(join(f.directory, `${newId}.jsonl`), f.terminal(newId), { mode: 0o600 });
  assert.equal(await f.attestor.publish(next, f.correlation, f.prompt, generation,
    () => Promise.resolve(true)), "written");
  const actual = await f.store.read(f.binding);
  assert.equal(actual.state === "valid" ? actual.nativeId : undefined, newId);
});

test("native witness accepts a merged envelope-only boundary without claiming ancestry", async () => {
  const f = await fixture("merged");
  await appendFile(f.file, f.terminal());
  assert.equal(await f.publish(), "written");
});

for (const scenario of [
  "no_growth", "old_nonce", "wrong_nonce", "invalid_contract", "missing_id", "different_id",
  "injected_id_mismatch", "duplicate_files", "truncate_regrow", "replace", "symlink",
  "writable", "partial_line", "pane_changed",
] as const) {
  test(`native witness refuses ${scenario} without creating a pointer`, async () => {
    const f = await fixture(scenario);
    switch (scenario) {
      case "no_growth": break;
      case "old_nonce": {
        await appendFile(f.file, f.terminal());
        const next = await f.attestor.capture(new Map([[f.file, (await stat(f.file)).size]]));
        assert.ok(next);
        assert.equal(await f.attestor.publish(next, f.correlation, f.prompt, generation,
          () => Promise.resolve(true)), "unverified");
        assert.equal((await f.store.read(f.binding)).state, "absent");
        return;
      }
      case "wrong_nonce": await appendFile(f.file, f.terminal(f.nativeId, "b".repeat(64))); break;
      case "invalid_contract": await appendFile(f.file, f.terminal(f.nativeId, f.correlation,
        JSON.stringify({ status: "done", messages: [], reply: 123, cauce_correlation_id: f.correlation }))); break;
      case "missing_id": await appendFile(f.file, f.terminal("")); break;
      case "different_id": await appendFile(f.file, f.terminal(randomUUID())); break;
      case "injected_id_mismatch":
        await appendFile(f.file, `${userEntry(randomUUID(), null, f.prompt, randomUUID())}\n${f.terminal()}`); break;
      case "duplicate_files": {
        await appendFile(f.file, f.terminal());
        const otherId = randomUUID();
        await writeFile(join(f.directory, `${otherId}.jsonl`), f.terminal(otherId), { mode: 0o600 });
        break;
      }
      case "truncate_regrow": await writeFile(f.file, `${" ".repeat(f.head.length)}\n${f.terminal()}`); break;
      case "replace":
        await rename(f.file, `${f.file}.preserved`);
        await writeFile(f.file, f.head + f.terminal(), { mode: 0o600 }); break;
      case "symlink":
        await rename(f.file, `${f.file}.preserved`);
        await appendFile(`${f.file}.preserved`, f.terminal());
        await symlink(`${f.file}.preserved`, f.file); break;
      case "writable": await appendFile(f.file, f.terminal()); await chmod(f.file, 0o666); break;
      case "partial_line": await appendFile(f.file, f.terminal().trimEnd()); break;
      case "pane_changed": await appendFile(f.file, f.terminal()); break;
    }
    assert.equal(await f.publish(scenario !== "pane_changed"), scenario === "pane_changed" ? "conflict" : "unverified");
    assert.equal((await f.store.read(f.binding)).state, "absent");
  });
}

test("native witness CAS does not replace a pointer updated after its snapshot", async () => {
  const f = await fixture("cas");
  const otherId = randomUUID();
  await f.store.publishWitness({ binding: f.binding, nativeId: otherId, paneGeneration: generation,
    stillCurrent: () => Promise.resolve(true) });
  await appendFile(f.file, f.terminal());
  assert.equal(await f.publish(), "conflict");
  const pointer = await f.store.read(f.binding);
  assert.equal(pointer.state === "valid" ? pointer.nativeId : undefined, otherId);
});

test("native witness capture refuses an altered baseline or unsafe file", async () => {
  const f = await fixture("baseline");
  assert.equal(await f.attestor.capture(new Map([[f.file, 0]])), undefined);
  await chmod(f.file, 0o666);
  assert.equal(await f.attestor.capture(f.baseline), undefined);
});

test("native witness canonicalizes aliases but rejects their replacement before publication", async () => {
  const f = await fixture("path-alias");
  const configAlias = join(f.state, "config-alias");
  const workspaceAlias = join(f.state, "workspace-alias");
  await symlink(f.binding.configDirectory, configAlias);
  await symlink(f.workspace, workspaceAlias);
  const attestor = new NativePointerAttestor(f.store, {
    ...f.binding, configDirectory: configAlias, workspace: workspaceAlias,
  });
  const aliasFile = join(configAlias, "projects", basename(dirname(f.file)), basename(f.file));
  const snapshot = await attestor.capture(new Map([[aliasFile, (await stat(f.file)).size]]));
  assert.ok(snapshot);
  await appendFile(f.file, f.terminal());
  assert.equal(await attestor.publish(snapshot, f.correlation, f.prompt, generation,
    () => Promise.resolve(true)), "written");
  const next = await attestor.capture(new Map([[aliasFile, (await stat(f.file)).size]]));
  assert.ok(next);
  await appendFile(f.file, f.terminal());
  await rename(workspaceAlias, `${workspaceAlias}.preserved`);
  await symlink(f.state, workspaceAlias);
  assert.equal(await attestor.publish(next, f.correlation, f.prompt, generation,
    () => Promise.resolve(true)), "unverified");
});

test("native witness accepts a failed business envelope as a terminal conversation boundary", async () => {
  const f = await fixture("failed-business");
  await appendFile(f.file, f.terminal(f.nativeId, f.correlation, JSON.stringify({
    status: "failed", retryable: false, reply: "task failed", messages: [], artifacts: [],
    cauce_correlation_id: f.correlation,
  })));
  assert.equal(await f.publish(), "written");
});

for (const scenario of ["terminal", "fallback", "persistence_failure", "capture_failure"] as const) {
  test(`shared runner native witness: ${scenario} preserves the terminal result`, async () => {
    const f = await fixture(`runner-${scenario}`);
    const tmux = new FakeTmux();
    tmux.sessionName = "cauce-zeus";
    const fallback = new RecordingFallback(JSON.stringify({
      type: "result", subtype: "success", result: envelopeText("headless"), session_id: randomUUID(),
    }));
    let publishes = 0;
    const notices: string[] = [];
    const store = scenario === "persistence_failure"
      ? new SharedTuiPointerStore(f.state, { directoryFsync: () => Promise.reject(new Error("EIO")) })
      : f.store;
    class ObservedAttestor extends NativePointerAttestor {
      override async capture(...args: Parameters<NativePointerAttestor["capture"]>) {
        return scenario === "capture_failure" ? undefined : super.capture(...args);
      }
      override async publish(...args: Parameters<NativePointerAttestor["publish"]>) {
        publishes += 1;
        return super.publish(...args);
      }
    }
    if (scenario === "fallback") {
      tmux.sessionExists = false;
      tmux.newSessionFails = true;
    }
    tmux.onSubmit = async (prompt) => {
      const key = randomUUID();
      await appendFile(f.file, `${userEntry(key, null, prompt, f.nativeId)}\n`
        + `${assistantEntry(randomUUID(), key, envelopeText("shared", correlationIdFromPrompt(prompt)), f.nativeId)}\n`);
    };
    const runner = new PasteSessionRunner({
      alias: "zeus", harness: "claude", workspace: f.workspace, tmux, fallback,
      transcript: claudeTranscript(f.binding.configDirectory, f.workspace),
      nativePointer: new ObservedAttestor(store, f.binding),
      onNotice: (detail) => { notices.push(detail); },
      sleep: () => Promise.resolve(), settleMs: 0, pollMs: 1, readyTimeoutMs: 20,
    });
    const output = await execute(await adapterFor(runner, f.state, "zeus", "claude"));
    assert.equal(output.status, "done");
    assert.equal(publishes, scenario === "fallback" || scenario === "capture_failure" ? 0 : 1);
    assert.equal((await f.store.read(f.binding)).state, scenario === "terminal" ? "valid" : "absent");
    assert.equal(fallback.calls, scenario === "fallback" ? 1 : 0);
    if (scenario === "capture_failure") assert.ok(notices.some((notice) => notice.includes("acreditación")));
  });
}

import assert from "node:assert/strict";
import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import test from "node:test";
import { DurableStore } from "../src/sdk/durable-store.js";
import type { CommandRunRequest, CommandRunResult, CommandRunner } from "../src/sdk/types.js";
import { HARNESS_DEFINITIONS, HarnessAdapter } from "../src/harnesses/index.js";
import { testStateRoot } from "./test-state.js";

/*
 * kratos' sessions.json kept `claude:…:shared:kratos` → an old Telegram DM while its TUI resumed another
 * conversation from the pointer. The TTY runner ignored that id, yet every shared turn re-read and re-wrote
 * it, and an operator tool could still resume it as a third conversation. The pointer alone owns it.
 */

const STALE = "1429a4a3-0000-4000-8000-000000000000";
const reply = JSON.stringify({ result: JSON.stringify({ reply: "ok", messages: [], status: "done", retryable: false, artifacts: [] }) });

function recordingRunner(shared: boolean): CommandRunner & { requests: CommandRunRequest[] } {
  const requests: CommandRunRequest[] = [];
  const run = async (request: CommandRunRequest): Promise<CommandRunResult> => {
    requests.push(request);
    return { stdout: reply, stderr: "", exitCode: 0, signal: null, timedOut: false, cancelled: false };
  };
  return shared ? { requests, run, takeDegradation: () => undefined } as CommandRunner & { requests: CommandRunRequest[] }
    : { requests, run };
}

async function adapterWithStaleSharedKey(name: string, shared: boolean) {
  const directory = resolve(testStateRoot(), name);
  await rm(directory, { recursive: true, force: true });
  const store = await DurableStore.open(directory);
  await store.setSession("claude:shared:kratos", { native_id: STALE, initialized: true });
  const runner = recordingRunner(shared);
  const adapter = new HarnessAdapter({ definition: HARNESS_DEFINITIONS.claude, runner, store });
  return { store, runner, adapter };
}

const execute = (adapter: HarnessAdapter, sessionKey: string) =>
  adapter.execute({ prompt: "turno", timeoutMs: 2_000, signal: new AbortController().signal, sessionKey });

test("the shared TUI never resumes, rewrites nor mints a sessions.json id for its shared: key", async () => {
  const { store, runner, adapter } = await adapterWithStaleSharedKey("tui-pointer-owns-session", true);
  await execute(adapter, "shared:kratos");
  await execute(adapter, "shared:zeus");
  for (const request of runner.requests) {
    assert.equal(request.args.includes(STALE), false);
    assert.equal(request.args.includes("--resume") || request.args.includes("--session-id"), false);
  }
  assert.deepEqual(store.getSession("claude:shared:kratos"), { native_id: STALE, initialized: true });
  assert.equal(store.getSession("claude:shared:zeus"), undefined);
});

test("a headless runner still resumes the stored id of its key", async () => {
  const { runner, adapter } = await adapterWithStaleSharedKey("headless-keeps-session", false);
  await execute(adapter, "shared:kratos");
  assert.deepEqual(runner.requests[0]?.args.slice(runner.requests[0].args.indexOf("--resume"), runner.requests[0].args.indexOf("--resume") + 2),
    ["--resume", STALE]);
});

import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DurableStore } from "../src/sdk/durable-store.js";
import { ProcessExecutionError } from "../src/sdk/errors.js";
import { HarnessAdapter } from "../src/harnesses/shared.js";
import { claudeDefinition, codexDefinition, grokDefinition, museDefinition } from "../src/harnesses/index.js";
import type { CommandRunner, CommandRunResult } from "../src/sdk/types.js";
import type { SharedSessionRunner } from "../src/shared-session/types.js";
import type { TmuxController, TmuxResult, TmuxRunControl } from "../src/shared-session/tmux.js";

export type { TmuxController, TmuxResult, TmuxRunControl };
import {
  fileQuarantinePersistence,
  PasteSessionRunner,
  type QuarantinePersistence,
} from "../src/shared-session/paste-runner.js";
import { transcriptDirectory } from "../src/shared-session/session.js";
import { claudeTranscript, type TranscriptEntry } from "../src/shared-session/transcript.js";
import { testStateRoot } from "./test-state.js";

export const stateRoot = testStateRoot("shared-session");

for (const [command, args] of [["tmux", ["-V"]], ["script", ["--version"]]] as const) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  assert.equal(result.status, 0, `${command} is required for shared-session integration tests`);
}

export const EXACT_TMUX_PANE_STATE_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{pane_start_command}",
  "#{pane_input_off}",
  "#{pane_in_mode}",
  "#{@cauce_input_barrier}",
  "#{@cauce_quarantined_pane}",
  "#{@cauce_creation_nonce}",
].join("\t");

export async function exactTmuxPaneState(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "display-message", "-p", "-t", paneId, EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  return state.stdout;
}

export async function exactTmuxPaneStateViaList(tmux: TmuxController, paneId: string): Promise<string> {
  const state = await tmux.run([
    "list-panes", "-a", "-f", `#{==:#{pane_id},${paneId}}`, "-F", EXACT_TMUX_PANE_STATE_FORMAT,
  ]);
  assert.equal(state.exitCode, 0, state.stderr);
  const rows = state.stdout.split(/\r?\n/u).filter((row) => row !== "");
  assert.equal(rows.length, 1, `debe existir exactamente ${paneId}`);
  return `${String(rows[0])}\n`;
}

export const ENVELOPE = {
  reply: "hecho",
  messages: [] as const,
  status: "done" as const,
  retryable: false,
  artifacts: [] as const,
};

export function envelopeText(reply = "hecho", correlationId?: string): string {
  return JSON.stringify({
    ...ENVELOPE,
    reply,
    ...(correlationId === undefined ? {} : { cauce_correlation_id: correlationId }),
  });
}

export function correlationIdFromPrompt(prompt: string): string {
  const match = /"cauce_correlation_id":"([a-f0-9]{64})"/u.exec(prompt);
  assert.ok(match?.[1], "el prompt inyectado debe llevar un nonce criptográfico de 256 bits");
  return match[1];
}

export async function freshState(name: string): Promise<{ state: string; home: string; workspace: string }> {
  const directory = join(stateRoot, name);
  await rm(directory, { recursive: true, force: true });
  const home = join(directory, "home");
  const workspace = "/workspace";
  await mkdir(transcriptDirectory(home, workspace), { recursive: true });
  await mkdir(directory, { recursive: true });
  return { state: directory, home, workspace };
}

export function userEntry(uuid: string, parentUuid: string | null, text: string, sessionId: string): string {
  return JSON.stringify({
    type: "user", uuid, parentUuid, isSidechain: false, sessionId,
    promptSource: "typed", message: { role: "user", content: text },
  });
}

export function assistantEntry(
  uuid: string,
  parentUuid: string,
  text: string,
  sessionId: string,
  stopReason = "end_turn",
): string {
  return JSON.stringify({
    type: "assistant", uuid, parentUuid, isSidechain: false, sessionId,
    message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] },
  });
}

// FakeTmux y constructores de resultados tmux extraidos a shared-session-fake-tmux.ts (poda T060-D);
// se re-exportan aqui para que los importadores existentes no cambien.
import type { FakeTmux } from "./shared-session-fake-tmux.js";
export {
  ambiguousTmuxResult,
  controlledDelayedTmuxMutation,
  controlledTmuxHang,
  FakeTmux,
  ok,
} from "./shared-session-fake-tmux.js";

const immediate = (): Promise<void> => Promise.resolve();

export function claudeRunner(
  options: {
    alias: string;
    home: string;
    workspace: string;
    tmux: FakeTmux;
    sleep?: (ms: number) => Promise<void>;
    cancelDrainTimeoutMs?: number;
    quarantineFile?: string;
    quarantineOperationTimeoutMs?: number;
    quarantinePersistence?: QuarantinePersistence;
    settleMs?: number;
    turnTimeoutMs?: number;
    injectTimeoutMs?: number;
    correlationTimeoutMs?: number;
    quietTimeoutMs?: number;
  },
): PasteSessionRunner<TranscriptEntry> {
  options.tmux.sessionName = `cauce-${options.alias}`;
  return new PasteSessionRunner({
    alias: options.alias,
    harness: "claude",
    workspace: options.workspace,
    transcript: claudeTranscript(join(options.home, ".claude"), options.workspace),
    tmux: options.tmux,
    sleep: options.sleep ?? immediate,
    acquireTimeoutMs: 30,
    turnTimeoutMs: options.turnTimeoutMs ?? 2_000,
    settleMs: options.settleMs ?? 0,
    pollMs: 1,
    readyTimeoutMs: 30,
    ...(options.cancelDrainTimeoutMs === undefined
      ? {}
      : { cancelDrainTimeoutMs: options.cancelDrainTimeoutMs }),
    ...(options.quarantineFile === undefined ? {} : { quarantineFile: options.quarantineFile }),
    ...(options.quarantineOperationTimeoutMs === undefined
      ? {}
      : { quarantineOperationTimeoutMs: options.quarantineOperationTimeoutMs }),
    ...(options.quarantinePersistence === undefined
      ? {}
      : { quarantinePersistence: options.quarantinePersistence }),
    ...(options.injectTimeoutMs === undefined ? {} : { injectTimeoutMs: options.injectTimeoutMs }),
    ...(options.correlationTimeoutMs === undefined
      ? {}
      : { correlationTimeoutMs: options.correlationTimeoutMs }),
    ...(options.quietTimeoutMs === undefined ? {} : { quietTimeoutMs: options.quietTimeoutMs }),
  });
}

export async function adapterFor(
  runner: CommandRunner,
  state: string,
  alias: string,
  harness: "claude" | "codex" | "grok" | "muse",
): Promise<HarnessAdapter> {
  const store = await DurableStore.open(join(state, "store"));
  return new HarnessAdapter({
    definition: { claude: claudeDefinition, codex: codexDefinition, grok: grokDefinition, muse: museDefinition }[harness],
    runner,
    store,
    sessionNamespace: alias,
    sharedSession: { alias, harness, stateDirectory: state },
  });
}

export function execute(adapter: HarnessAdapter, prompt = "hola"): Promise<{
  reply: string | null;
  messages: readonly unknown[];
  status: string;
}> {
  return adapter.execute({
    prompt,
    sessionKey: "auth-v2:prueba",
    timeoutMs: 10_000,
    signal: new AbortController().signal,
  });
}

export async function expectSharedTuiUnavailable<T>(operation: Promise<T>): Promise<ProcessExecutionError> {
  try { await operation; } catch (error) {
    assert.ok(error instanceof ProcessExecutionError); assert.equal(error.code, "SHARED_TUI_UNAVAILABLE");
    assert.equal(error.retryable, false); return error;
  }
  return assert.fail("expected SHARED_TUI_UNAVAILABLE");
}
export function assertExecutionPrevented(runner: SharedSessionRunner, outcome: CommandRunResult, reason?: string): void {
  assert.equal(outcome.exitCode, 1); assert.equal(outcome.harnessStarted, false);
  const degradation = runner.takeDegradation(); assert.equal(degradation?.executionPrevented, true);
  assert.equal(degradation.fellBack, false);
  if (reason !== undefined) assert.equal(degradation.reason, reason);
}
export { randomUUID, fileQuarantinePersistence };

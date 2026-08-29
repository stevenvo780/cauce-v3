// Shared helpers for the split durable-store.test.ts tests (Task 2 of opencode-minimax.md).
// NOT a test: the `dist/test/*.test.js` runner does not pick it up.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  ATOMIC_STATE_FILES,
  CANONICAL_OPEN_CODE_SESSION_FILE,
  DurableStore,
  MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS,
  MAX_SESSIONS_FILE_BYTES,
  type CanonicalOpenCodeSessionPointer,
  type InboxRecord,
} from "../src/sdk/durable-store.js";
import type { Delivery, DeliveryEvent, StructuredOutput } from "../src/sdk/types.js";
export const root = resolve(".test-state/canonical-open-code-store");
export const scopeA = `auth-v1:${"A".repeat(43)}`;
export const scopeB = `auth-v1:${"B".repeat(43)}`;

export type AtomicCrashWindow = "tmp" | "backup-tmp" | "backup" | "committed";

const atomicCrashChild = String.raw`
  import { mkdir, open, rename, writeFile } from "node:fs/promises";
  import { dirname } from "node:path";
  const spec = JSON.parse(process.argv[1]);
  const durableWrite = async (path, body) => {
    await writeFile(path, body, { mode: 0o600 });
    const handle = await open(path, "r+");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
  };
  await mkdir(dirname(spec.target), { recursive: true, mode: 0o700 });
  await durableWrite(spec.target, spec.previous);
  await durableWrite(spec.tmp, spec.next);
  if (spec.window === "backup-tmp") {
    await durableWrite(spec.backupTmp, spec.previous);
  } else if (spec.window === "backup") {
    await rename(spec.target, spec.backup);
  } else if (spec.window === "committed") {
    await durableWrite(spec.backupTmp, spec.previous);
    await rename(spec.backupTmp, spec.backup);
    await rename(spec.tmp, spec.target);
    await rename(spec.backup, spec.committed);
  }
  const directory = await open(dirname(spec.target), "r");
  await directory.sync();
  await directory.close();
  process.stdout.write("READY\\n");
  setInterval(() => undefined, 60_000);
`;

async function crashChildAtAtomicWindow(
  directory: string,
  targetName: string,
  window: AtomicCrashWindow,
  previous: string,
  next: string,
): Promise<string> {
  const transaction = "99999999-9999-4999-8999-999999999999";
  const target = resolve(directory, targetName);
  const prefix = `${target}.${transaction}.atomic-`;
  const child = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    atomicCrashChild,
    JSON.stringify({
      target,
      window,
      previous,
      next,
      tmp: `${prefix}tmp`,
      backupTmp: `${prefix}backup-tmp`,
      backup: `${prefix}backup`,
      committed: `${prefix}committed`,
    }),
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      rejectReady(new Error(`atomic crash child did not become ready: ${stderr}`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (!chunk.includes("READY")) return;
      clearTimeout(timeout);
      resolveReady();
    });
    void exited.then(({ code, signal }) => {
      clearTimeout(timeout);
      rejectReady(new Error(
        `atomic crash child exited before SIGKILL (code=${String(code)}, signal=${String(signal)}): ${stderr}`,
      ));
    });
  });
  assert.equal(child.kill("SIGKILL"), true);
  const outcome = await exited;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
  return window === "committed" ? next : previous;
}

export async function freshStore(name: string): Promise<{ directory: string; store: DurableStore }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return { directory, store: await DurableStore.open(directory) };
}

export async function pointer(directory: string): Promise<CanonicalOpenCodeSessionPointer> {
  return JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as CanonicalOpenCodeSessionPointer;
}

export function delivery(id: string): Delivery {
  return {
    type: "delivery",
    version: "3.0",
    delivery_id: id,
    event_id: `30000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    message_id: `00000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    request_id: `10000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    trace_id: `trace-${id}`,
    epoch: 1,
    attempt: 1,
    claim_token: `20000000-0000-4000-8000-${id.padEnd(12, "0").slice(0, 12)}`,
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
    tenant_id: "Steven",
    room_id: "grp.steven",
    actor_alias: "jarvis",
    recipient_alias: "argos",
    origin: {
      adapter: "telegram",
      channel: "telegram",
      conversation_id: "room-42",
      external_message_id: "message-9",
      relay: [],
      metadata: {},
    },
    body: { type: "agent.message", text: "perform the task" },
  };
}

export const delegatedOutput: StructuredOutput = {
  reply: null,
  messages: [{ to: "socrates", body: "implement the bounded fix" }],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

export const completedOutput: StructuredOutput = {
  reply: "REVIEW=PASS",
  messages: [],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

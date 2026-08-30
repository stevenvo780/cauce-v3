import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {readFile, readdir, rm} from 'node:fs/promises';
import { resolve } from "node:path";
import test from "node:test";
import {ATOMIC_STATE_FILES, CANONICAL_OPEN_CODE_SESSION_FILE, DurableStore} from '../src/sdk/durable-store.js';
import type { AtomicCrashWindow } from "./durable-store-fixtures.js";
import {root, scopeA} from './durable-store-fixtures.js';

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
test("SIGKILL recovery is deterministic at every atomic artifact window", async (t) => {
  const images: Record<(typeof ATOMIC_STATE_FILES)[number], readonly [string, string]> = {
    "delivery-transaction.json": [
      `${JSON.stringify({
        version: 1,
        transaction_id: "81000000-0000-4000-8000-000000000001",
      })}\n`,
      `${JSON.stringify({
        version: 1,
        transaction_id: "81000000-0000-4000-8000-000000000002",
      })}\n`,
    ],
    "inbox.json": [
      `${JSON.stringify({ version: 1, deliveries: {}, last_transaction_id: "old" })}\n`,
      `${JSON.stringify({ version: 1, deliveries: {}, last_transaction_id: "new" })}\n`,
    ],
    "outbox.json": [
      `${JSON.stringify({ version: 1, pending: [], last_transaction_id: "old" })}\n`,
      `${JSON.stringify({ version: 1, pending: [], last_transaction_id: "new" })}\n`,
    ],
    "sessions.json": [
      `${JSON.stringify({ version: 1, sessions: {} })}\n`,
      `${JSON.stringify({
        version: 1,
        sessions: {
          [`opencode:kant:${scopeA}`]: {
            native_id: "ses_after_committed_window",
            initialized: true,
          },
        },
      })}\n`,
    ],
    "fencing.json": [
      `${JSON.stringify({ version: 1, epoch: 1 })}\n`,
      `${JSON.stringify({ version: 1, epoch: 2 })}\n`,
    ],
    [CANONICAL_OPEN_CODE_SESSION_FILE]: [
      `${JSON.stringify({
        version: 1,
        state: "unavailable",
        alias: "kant",
        harness: "opencode",
        scope_key: null,
        session_id: null,
        reason: "missing",
      })}\n`,
      `${JSON.stringify({
        version: 1,
        state: "active",
        alias: "kant",
        harness: "opencode",
        scope_key: scopeA,
        session_id: "ses_after_commit",
      })}\n`,
    ],
  };
  const windows: readonly AtomicCrashWindow[] = ["tmp", "backup-tmp", "backup", "committed"];

  for (const target of ATOMIC_STATE_FILES) {
    for (const window of windows) {
      await t.test(`${target}:${window}`, async () => {
        const directory = resolve(root, `sigkill-${target.replaceAll(".", "-")}-${window}`);
        await rm(directory, { recursive: true, force: true });
        const [previous, next] = images[target];
        const expected = await crashChildAtAtomicWindow(directory, target, window, previous, next);

        await DurableStore.open(directory);

        assert.equal(await readFile(resolve(directory, target), "utf8"), expected);
        const entries = await readdir(directory);
        assert.equal(
          entries.some((entry) => entry.startsWith(`${target}.99999999-9999-4999-8999-999999999999.atomic-`)),
          false,
          `recovery left an atomic artifact for ${target}:${window}`,
        );
      });
    }
  }
});


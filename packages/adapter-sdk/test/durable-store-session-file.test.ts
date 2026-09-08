import assert from "node:assert/strict";
import { chmod, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { DurableStore, MAX_SESSIONS_FILE_BYTES } from "../src/sdk/durable-store.js";
import { scopeA, scopeB, freshStore, root } from "./durable-store-fixtures.js";

test("invalid sessions state is rejected without rewriting retired state", async () => {
  const cases: readonly {
    name: string;
    prepare(directory: string): Promise<void>;
  }[] = [
    {
      name: "malformed",
      prepare: async (directory) => {
        await writeFile(resolve(directory, "sessions.json"), "{not-json\n", { mode: 0o600 });
      },
    },
    {
      name: "schema",
      prepare: async (directory) => {
        await writeFile(
          resolve(directory, "sessions.json"),
          '{"version":1,"sessions":{},"unexpected":true}\n',
          { mode: 0o600 },
        );
      },
    },
    {
      name: "duplicate-key",
      prepare: async (directory) => {
        await writeFile(
          resolve(directory, "sessions.json"),
          '{"version":1,"version":1,"sessions":{}}\n',
          { mode: 0o600 },
        );
      },
    },
    {
      name: "mode",
      prepare: async (directory) => {
        await writeFile(resolve(directory, "sessions.json"), '{"version":1,"sessions":{}}\n', { mode: 0o644 });
        await chmod(resolve(directory, "sessions.json"), 0o644);
      },
    },
    {
      name: "oversized",
      prepare: async (directory) => {
        await writeFile(resolve(directory, "sessions.json"), "x".repeat(MAX_SESSIONS_FILE_BYTES + 1), {
          mode: 0o600,
        });
      },
    },
    {
      name: "symlink",
      prepare: async (directory) => {
        const target = resolve(directory, "sessions-target.json");
        await writeFile(target, '{"version":1,"sessions":{}}\n', { mode: 0o600 });
        await symlink(target, resolve(directory, "sessions.json"));
      },
    },
  ];

  for (const scenario of cases) {
    const directory = resolve(root, `invalid-sessions-${scenario.name}`);
    await rm(directory, { recursive: true, force: true });
    await DurableStore.open(directory);
    const retiredPath = resolve(directory, "canonical-opencode-session.json");
    const retired = "retired session pointer\n";
    await writeFile(retiredPath, retired, { mode: 0o600 });
    await scenario.prepare(directory);

    await assert.rejects(
      DurableStore.open(directory),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SESSIONS_FILE",
    );
    assert.equal(await readFile(retiredPath, "utf8"), retired);
  }
});

test("restart recovers a copied pre-rename sessions backup without increasing target nlink", async () => {
  const { directory, store } = await freshStore("copied-backup-crash-recovery");
  await store.setSession(`opencode:sample:${scopeA}`, {
    native_id: "ses_before_crash",
    initialized: true,
  });
  const sessionsPath = resolve(directory, "sessions.json");
  const previous = await readFile(sessionsPath);
  const transaction = "11111111-1111-4111-8111-111111111111";
  const backupPath = `${sessionsPath}.${transaction}.atomic-backup`;
  const temporaryPath = `${sessionsPath}.${transaction}.atomic-tmp`;
  await writeFile(backupPath, previous, { mode: 0o600 });
  await writeFile(
    temporaryPath,
    `${JSON.stringify({
      version: 1,
      sessions: {
        [`opencode:sample:${scopeB}`]: { native_id: "ses_uncommitted", initialized: true },
      },
    })}\n`,
    { mode: 0o600 },
  );
  for (const path of [backupPath, temporaryPath]) {
    const handle = await open(path, "r+");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
  }
  const directoryHandle = await open(directory, "r");
  await directoryHandle.sync();
  await directoryHandle.close();
  assert.equal((await stat(sessionsPath)).nlink, 1);

  const reopened = await DurableStore.open(directory);
  assert.equal((await stat(sessionsPath)).nlink, 1);
  assert.equal(reopened.getSession(`opencode:sample:${scopeA}`)?.native_id, "ses_before_crash");
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(transaction)), false);
});

test("restart discards an incomplete copied-backup staging artifact before loading sessions", async () => {
  const { directory, store } = await freshStore("incomplete-backup-crash-recovery");
  await store.setSession(`opencode:sample:${scopeA}`, {
    native_id: "ses_before_incomplete_backup",
    initialized: true,
  });
  const sessionsPath = resolve(directory, "sessions.json");
  const previous = await readFile(sessionsPath, "utf8");
  const transaction = "22222222-2222-4222-8222-222222222222";
  const stagingPath = `${sessionsPath}.${transaction}.atomic-backup-tmp`;
  const temporaryPath = `${sessionsPath}.${transaction}.atomic-tmp`;
  await writeFile(stagingPath, previous.slice(0, 12), { mode: 0o600 });
  await writeFile(temporaryPath, previous, { mode: 0o600 });
  for (const path of [stagingPath, temporaryPath]) {
    const handle = await open(path, "r+");
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
  }
  const directoryHandle = await open(directory, "r");
  await directoryHandle.sync();
  await directoryHandle.close();

  const reopened = await DurableStore.open(directory);
  assert.equal(reopened.getSession(`opencode:sample:${scopeA}`)?.native_id, "ses_before_incomplete_backup");
  assert.equal(await readFile(sessionsPath, "utf8"), previous);
  assert.equal((await stat(sessionsPath)).nlink, 1);
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(transaction)), false);
});

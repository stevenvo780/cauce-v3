import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
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

const root = resolve(".test-state/canonical-open-code-store");
const scopeA = `auth-v1:${"A".repeat(43)}`;
const scopeB = `auth-v1:${"B".repeat(43)}`;

type AtomicCrashWindow = "tmp" | "backup-tmp" | "backup" | "committed";

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

async function freshStore(name: string): Promise<{ directory: string; store: DurableStore }> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return { directory, store: await DurableStore.open(directory) };
}

async function pointer(directory: string): Promise<CanonicalOpenCodeSessionPointer> {
  return JSON.parse(
    await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8"),
  ) as CanonicalOpenCodeSessionPointer;
}

function delivery(id: string): Delivery {
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

const delegatedOutput: StructuredOutput = {
  reply: null,
  messages: [{ to: "socrates", body: "implement the bounded fix" }],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

const completedOutput: StructuredOutput = {
  reply: "REVIEW=PASS",
  messages: [],
  notify: [],
  status: "done",
  retryable: false,
  artifacts: [],
};

test("canonical OpenCode reconciliation publishes unavailable with owner-only modes", async () => {
  const { directory, store } = await freshStore("missing");
  await store.setSession(`opencode:kant:${scopeA}`, {
    native_id: "ses_not_initialized",
    initialized: false,
  });
  await store.setSession(`opencode:other:${scopeA}`, {
    native_id: "ses_other_alias",
    initialized: true,
  });
  await store.setSession(`claude:kant:${scopeA}`, {
    native_id: "ses_other_harness",
    initialized: true,
  });
  assert.deepEqual(await store.reconcileCanonicalOpenCodeSession(), {
    version: 1,
    state: "unavailable",
    alias: "kant",
    harness: "opencode",
    scope_key: null,
    session_id: null,
    reason: "missing",
  });
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE))).mode & 0o777, 0o600);
});

test("canonical OpenCode pointer is sticky, refreshes its scope, and becomes ambiguous on restart", async () => {
  const { directory, store } = await freshStore("sticky");
  await store.reconcileCanonicalOpenCodeSession();

  assert.equal(await store.setCanonicalOpenCodeSession(scopeA, "ses_store_first"), true);
  assert.equal(await store.setCanonicalOpenCodeSession(scopeA, "ses_store_refreshed"), true);
  assert.deepEqual(await pointer(directory), {
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: scopeA,
    session_id: "ses_store_refreshed",
  });

  assert.equal(await store.setCanonicalOpenCodeSession(scopeB, "ses_store_other"), false);
  assert.equal((await pointer(directory)).scope_key, scopeA, "a second scope stole the live pointer");

  const reopened = await DurableStore.open(directory);
  assert.deepEqual(await reopened.reconcileCanonicalOpenCodeSession(), {
    version: 1,
    state: "unavailable",
    alias: "kant",
    harness: "opencode",
    scope_key: null,
    session_id: null,
    reason: "ambiguous",
  });
});

test("startup reconstructs a stale pointer only from one valid initialized mapping", async () => {
  const { directory, store } = await freshStore("reconstruct");
  await store.setSession(`opencode:kant:${scopeA}`, {
    native_id: "ses_reconstructed",
    initialized: true,
  });
  await writeFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), JSON.stringify({ stale: true }), {
    mode: 0o600,
  });
  await chmod(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), 0o600);

  const reopened = await DurableStore.open(directory);
  assert.deepEqual(await reopened.reconcileCanonicalOpenCodeSession(), {
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: scopeA,
    session_id: "ses_reconstructed",
  });
  const serialized = await readFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), "utf8");
  assert.doesNotMatch(serialized, /prompt|chat|user|message/iu);
});

test("invalid initialized mapping never becomes an active canonical pointer", async () => {
  const { store } = await freshStore("invalid");
  await store.setSession(`opencode:kant:${scopeA}`, {
    native_id: "not-an-opencode-session",
    initialized: true,
  });
  assert.deepEqual(await store.reconcileCanonicalOpenCodeSession(), {
    version: 1,
    state: "unavailable",
    alias: "kant",
    harness: "opencode",
    scope_key: null,
    session_id: null,
    reason: "invalid",
  });
});

test("invalid sessions state replaces a stale active pointer before reconciliation aborts", async () => {
  const cases: ReadonlyArray<{
    name: string;
    prepare(directory: string): Promise<void>;
  }> = [
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
    const stale = `${JSON.stringify({
      version: 1,
      state: "active",
      alias: "kant",
      harness: "opencode",
      scope_key: scopeA,
      session_id: "ses_stale_pointer",
    })}\n`;
    await writeFile(resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE), stale, { mode: 0o600 });
    await scenario.prepare(directory);

    const store = await DurableStore.open(directory, { deferSessions: true });
    await assert.rejects(
      store.reconcileCanonicalOpenCodeSession(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_SESSIONS_FILE",
    );
    assert.deepEqual(await pointer(directory), {
      version: 1,
      state: "unavailable",
      alias: "kant",
      harness: "opencode",
      scope_key: null,
      session_id: null,
      reason: "invalid",
    });
  }
});

test("directory fsync EIO propagates and rolls the canonical pointer back", async () => {
  const { directory, store } = await freshStore("directory-fsync-failure");
  await store.setSession(`opencode:kant:${scopeA}`, {
    native_id: "ses_fsync_candidate",
    initialized: true,
  });
  const stale = `${JSON.stringify({
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: scopeB,
    session_id: "ses_fsync_previous",
  })}\n`;
  const pointerPath = resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE);
  await writeFile(pointerPath, stale, { mode: 0o600 });
  await chmod(pointerPath, 0o600);

  let calls = 0;
  const reopened = await DurableStore.open(directory, {
    deferSessions: true,
    directoryFsync: async (handle) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  await assert.rejects(
    reopened.reconcileCanonicalOpenCodeSession(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(await readFile(pointerPath, "utf8"), stale);
  assert.equal(calls, 3, "rollback directory fsync was not attempted");
});

test("restart recovers a copied pre-rename sessions backup without increasing target nlink", async () => {
  const { directory, store } = await freshStore("copied-backup-crash-recovery");
  await store.setSession(`opencode:kant:${scopeA}`, {
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
        [`opencode:kant:${scopeB}`]: { native_id: "ses_uncommitted", initialized: true },
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

  const reopened = await DurableStore.open(directory, { deferSessions: true });
  const reconciled = await reopened.reconcileCanonicalOpenCodeSession();
  assert.equal(reconciled.state, "active");
  assert.equal(reconciled.scope_key, scopeA);
  assert.equal((await stat(sessionsPath)).nlink, 1);
  assert.equal(reopened.getSession(`opencode:kant:${scopeA}`)?.native_id, "ses_before_crash");
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(transaction)), false);
});

test("restart discards an incomplete copied-backup staging artifact before loading sessions", async () => {
  const { directory, store } = await freshStore("incomplete-backup-crash-recovery");
  await store.setSession(`opencode:kant:${scopeA}`, {
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

  const reopened = await DurableStore.open(directory, { deferSessions: true });
  const reconciled = await reopened.reconcileCanonicalOpenCodeSession();
  assert.equal(reconciled.state, "active");
  assert.equal(reconciled.scope_key, scopeA);
  assert.equal(await readFile(sessionsPath, "utf8"), previous);
  assert.equal((await stat(sessionsPath)).nlink, 1);
  const entries = await readdir(directory);
  assert.equal(entries.some((entry) => entry.includes(transaction)), false);
});

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

test("sessions EIO rollback preserves both durable mapping and active pointer", async () => {
  const { directory, store } = await freshStore("sessions-fsync-failure");
  await store.reconcileCanonicalOpenCodeSession();
  await store.setCanonicalOpenCodeSession(scopeA, "ses_sessions_previous");
  const sessionsPath = resolve(directory, "sessions.json");
  const pointerPath = resolve(directory, CANONICAL_OPEN_CODE_SESSION_FILE);
  const sessionsBefore = await readFile(sessionsPath, "utf8");
  const pointerBefore = await readFile(pointerPath, "utf8");

  let injectFailure = false;
  let calls = 0;
  const reopened = await DurableStore.open(directory, {
    deferSessions: true,
    directoryFsync: async (handle) => {
      calls += 1;
      if (injectFailure && calls === 2) {
        throw Object.assign(new Error("injected sessions directory fsync failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  await reopened.reconcileCanonicalOpenCodeSession();
  calls = 0;
  injectFailure = true;
  await assert.rejects(
    reopened.setCanonicalOpenCodeSession(scopeA, "ses_sessions_uncommitted"),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(await readFile(sessionsPath, "utf8"), sessionsBefore);
  assert.equal(await readFile(pointerPath, "utf8"), pointerBefore);
  assert.equal((await stat(sessionsPath)).nlink, 1);

  const verified = await DurableStore.open(directory, { deferSessions: true });
  const pointerAfterRestart = await verified.reconcileCanonicalOpenCodeSession();
  assert.equal(pointerAfterRestart.state, "active");
  assert.equal(pointerAfterRestart.session_id, "ses_sessions_previous");
});

test("fanin transition fsync failure preserves the previous inbox in memory and on disk", async () => {
  const { directory, store } = await freshStore("fanin-transition-fsync-failure");
  const startedAt = Date.now();
  const rootDelivery: Delivery = {
    ...delivery("fanin-root"),
    trace_id: "trace-fanin-transition",
  };
  await store.accept(rootDelivery, new Date(startedAt).toISOString());
  await store.transition(rootDelivery.delivery_id, "done", new Date(startedAt + 1_000).toISOString(), {
    output: delegatedOutput,
    retainRequest: true,
  });

  const faninDelivery: Delivery = {
    ...delivery("fanin-complete"),
    actor_alias: "cauce",
    trace_id: rootDelivery.trace_id,
    body: {
      type: "agent.fanin",
      correlation: {
        root_message_id: rootDelivery.message_id,
        root_delivery_id: rootDelivery.delivery_id,
      },
      fanin_data_v1: {
        schema: "cauce.agent_fanin_data.v1",
        expected: 1,
        completed: 1,
        responses: [{
          tenant_id: "Steven",
          alias: "socrates",
          untrusted_text: "bounded implementation completed",
        }],
      },
    },
  };
  await store.accept(faninDelivery, new Date(startedAt + 2_000).toISOString());

  const inboxPath = resolve(directory, "inbox.json");
  const durableBefore = await readFile(inboxPath, "utf8");
  let injectFailure = false;
  let calls = 0;
  const reopened = await DurableStore.open(directory, {
    directoryFsync: async (handle) => {
      calls += 1;
      if (injectFailure && calls === 2) {
        throw Object.assign(new Error("injected fanin directory fsync failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  const rootBefore = reopened.getDelivery(rootDelivery.delivery_id);
  const faninBefore = reopened.getDelivery(faninDelivery.delivery_id);
  calls = 0;
  injectFailure = true;

  await assert.rejects(
    reopened.transition(faninDelivery.delivery_id, "done", new Date(startedAt + 3_000).toISOString(), {
      output: completedOutput,
    }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );

  assert.equal(calls, 3, "rollback directory fsync was not attempted");
  assert.equal(await readFile(inboxPath, "utf8"), durableBefore);
  assert.deepEqual(reopened.getDelivery(rootDelivery.delivery_id), rootBefore);
  assert.deepEqual(reopened.getDelivery(faninDelivery.delivery_id), faninBefore);
  assert.ok(reopened.getDelivery(rootDelivery.delivery_id)?.request);
  assert.equal(reopened.getDelivery(faninDelivery.delivery_id)?.state, "accepted");

  const verified = await DurableStore.open(directory);
  assert.deepEqual(verified.getDelivery(rootDelivery.delivery_id), rootBefore);
  assert.deepEqual(verified.getDelivery(faninDelivery.delivery_id), faninBefore);
});

test("restart prunes a terminal retained delegation request older than 24 hours", async () => {
  const { directory, store } = await freshStore("expired-retained-delegation");
  const expiredAt = new Date(
    Date.now() - MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS - 60_000,
  ).toISOString();
  const retainedDelivery = delivery("expired-root");
  await store.accept(retainedDelivery, expiredAt);
  await store.transition(retainedDelivery.delivery_id, "done", expiredAt, {
    output: delegatedOutput,
    retainRequest: true,
  });
  assert.ok(store.getDelivery(retainedDelivery.delivery_id)?.request);

  const reopened = await DurableStore.open(directory);
  const pruned = reopened.getDelivery(retainedDelivery.delivery_id);
  assert.equal(pruned?.state, "done");
  assert.equal(pruned?.request, undefined);
  assert.deepEqual(pruned?.output, delegatedOutput);

  const inbox = JSON.parse(await readFile(resolve(directory, "inbox.json"), "utf8")) as {
    deliveries: Record<string, { request?: unknown }>;
  };
  assert.equal(inbox.deliveries[retainedDelivery.delivery_id]?.request, undefined);
});

test("idle store prunes a terminal retained delegation request when its TTL expires", async () => {
  const { directory, store } = await freshStore("idle-expired-retained-delegation");
  const expiresSoonAt = new Date(
    Date.now() - MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS + 100,
  ).toISOString();
  const retainedDelivery = delivery("idle-expired-root");
  await store.accept(retainedDelivery, expiresSoonAt);
  const terminal = await store.transition(retainedDelivery.delivery_id, "done", expiresSoonAt, {
    output: delegatedOutput,
    retainRequest: true,
  });
  assert.ok(terminal.request);

  const inboxPath = resolve(directory, "inbox.json");
  const deadline = Date.now() + 2_000;
  let memoryRecord = store.getDelivery(retainedDelivery.delivery_id);
  let diskRecord: { request?: unknown; output?: StructuredOutput } | undefined;
  while (Date.now() < deadline) {
    const inbox = JSON.parse(await readFile(inboxPath, "utf8")) as {
      deliveries: Record<string, { request?: unknown; output?: StructuredOutput }>;
    };
    memoryRecord = store.getDelivery(retainedDelivery.delivery_id);
    diskRecord = inbox.deliveries[retainedDelivery.delivery_id];
    if (memoryRecord?.request === undefined && diskRecord?.request === undefined) break;
    await delay(20);
  }

  assert.equal(memoryRecord?.request, undefined);
  assert.equal(diskRecord?.request, undefined);
  assert.deepEqual(memoryRecord?.output, delegatedOutput);
  assert.deepEqual(diskRecord?.output, delegatedOutput);
});

test("a retry starts with fresh lifecycle and execution-intent identity", async () => {
  const { store } = await freshStore("execution-intent-retry-reset");
  await store.activateEpoch(1);
  const first = delivery("intent-reset");
  const accepted = await store.acceptAndEnqueue(first, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const started = await store.transitionAndEnqueue(
    first.delivery_id,
    "started",
    new Date().toISOString(),
    {
      retainRequest: true,
      attempt: first.attempt,
      claimToken: first.claim_token,
      executionIntentProtocol: "preinvoke-v1",
    },
  );
  await store.acknowledge(started.event);
  const intent: DeliveryEvent = {
    event_id: "70000000-0000-4000-8000-000000000099",
    delivery_id: first.delivery_id,
    attempt: first.attempt,
    claim_token: first.claim_token,
    epoch: 1,
    phase: "started",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
    execution_started: true,
  };
  await store.enqueue(intent);
  assert.equal(await store.acknowledgeResult(intent, {
    execution_intent_receipt: "applied",
  }), true);
  const failed = await store.transitionAndEnqueue(
    first.delivery_id,
    "failed",
    new Date().toISOString(),
    {
      retainRequest: true,
      attempt: first.attempt,
      claimToken: first.claim_token,
      error: { code: "RETRYABLE_PREFLIGHT", message: "retry this attempt", retryable: true },
    },
  );
  await store.acknowledge(failed.event);
  assert.equal(
    store.getDelivery(first.delivery_id)?.execution_intent_receipt_event_id,
    intent.event_id,
  );

  const retry: Delivery = {
    ...first,
    event_id: "30000000-0000-4000-8000-000000000099",
    attempt: 2,
    claim_token: "20000000-0000-4000-8000-000000000099",
    ack_deadline_at: new Date(Date.now() + 30_000).toISOString(),
  };
  const retried = await store.acceptAndEnqueue(retry, new Date().toISOString());
  assert.equal(retried.acceptance, "retry");
  assert.equal(retried.record.attempt, 2);
  assert.equal(retried.record.state, "accepted");
  assert.equal(retried.record.execution_intent_protocol, undefined);
  assert.equal(retried.record.execution_intent_receipt_event_id, undefined);
  assert.deepEqual(Object.keys(retried.record.lifecycle_event_ids ?? {}), ["accepted"]);
  assert.notEqual(
    retried.record.lifecycle_event_ids?.accepted,
    accepted.record.lifecycle_event_ids?.accepted,
  );
});

async function reopenWithArmedCommitFailure(directory: string, failAt = 2): Promise<{
  readonly store: DurableStore;
  readonly arm: () => void;
  readonly calls: () => number;
}> {
  let armed = false;
  let fsyncCalls = 0;
  const store = await DurableStore.open(directory, {
    directoryFsync: async (handle) => {
      fsyncCalls += 1;
      if (armed && fsyncCalls === failAt) {
        throw Object.assign(new Error("injected lifecycle commit failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  return {
    store,
    arm: () => {
      fsyncCalls = 0;
      armed = true;
    },
    calls: () => fsyncCalls,
  };
}

test("lifecycle state and event survive or roll back together at every durable frontier", async (t) => {
  await t.test("accepted", async () => {
    const { directory, store: seed } = await freshStore("atomic-lifecycle-accepted");
    await seed.activateEpoch(1);
    const injected = await reopenWithArmedCommitFailure(directory);
    injected.arm();
    await assert.rejects(
      injected.store.acceptAndEnqueue(delivery("atomic-accepted"), new Date().toISOString()),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
    );
    assert.equal(injected.calls(), 3);
    assert.equal(injected.store.getDelivery("atomic-accepted"), undefined);
    assert.deepEqual(injected.store.pendingEvents(), []);
    await assert.rejects(
      readFile(resolve(directory, "inbox.json"), "utf8"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
    );
    const reopened = await DurableStore.open(directory);
    assert.equal(reopened.getDelivery("atomic-accepted"), undefined);
    assert.deepEqual(reopened.pendingEvents(), []);
  });

  for (const state of ["started", "done", "failed"] as const) {
    await t.test(state, async () => {
      const { directory, store: seed } = await freshStore(`atomic-lifecycle-${state}`);
      await seed.activateEpoch(1);
      const input = delivery(`atomic-${state}`);
      const accepted = await seed.acceptAndEnqueue(input, new Date().toISOString());
      assert.ok(accepted.event);
      await seed.acknowledge(accepted.event);
      if (state !== "started") {
        const started = await seed.transitionAndEnqueue(
          input.delivery_id,
          "started",
          new Date().toISOString(),
          { retainRequest: true, attempt: 1, claimToken: input.claim_token },
        );
        await seed.acknowledge(started.event);
      }
      const previous = seed.getDelivery(input.delivery_id);
      const before = await readFile(resolve(directory, "inbox.json"), "utf8");
      const injected = await reopenWithArmedCommitFailure(directory);
      injected.arm();
      await assert.rejects(
        injected.store.transitionAndEnqueue(
          input.delivery_id,
          state,
          new Date().toISOString(),
          state === "done"
            ? { output: completedOutput, attempt: 1, claimToken: input.claim_token }
            : state === "failed"
              ? {
                  error: { code: "INJECTED", message: "injected terminal failure", retryable: false },
                  attempt: 1,
                  claimToken: input.claim_token,
                }
              : { retainRequest: true, attempt: 1, claimToken: input.claim_token },
        ),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
      );
      assert.equal(injected.calls(), 3);
      assert.deepEqual(injected.store.getDelivery(input.delivery_id), previous);
      assert.deepEqual(injected.store.pendingEvents(), []);
      assert.equal(await readFile(resolve(directory, "inbox.json"), "utf8"), before);
      const reopened = await DurableStore.open(directory);
      assert.deepEqual(reopened.getDelivery(input.delivery_id), previous);
      assert.deepEqual(reopened.pendingEvents(), []);
    });
  }

  await t.test("execution_started", async () => {
    const { directory, store: seed } = await freshStore("atomic-lifecycle-execution-started");
    await seed.activateEpoch(1);
    const input = delivery("atomic-execution-started");
    const accepted = await seed.acceptAndEnqueue(input, new Date().toISOString());
    assert.ok(accepted.event);
    await seed.acknowledge(accepted.event);
    const started = await seed.transitionAndEnqueue(
      input.delivery_id,
      "started",
      new Date().toISOString(),
      { retainRequest: true, attempt: 1, claimToken: input.claim_token },
    );
    await seed.acknowledge(started.event);
    const executionStarted: DeliveryEvent = {
      event_id: "70000000-0000-4000-8000-000000000001",
      delivery_id: input.delivery_id,
      attempt: 1,
      claim_token: input.claim_token,
      epoch: 1,
      phase: "started",
      occurred_at: new Date().toISOString(),
      claim_renewal: true,
      execution_started: true,
    };
    const previous = seed.getDelivery(input.delivery_id);
    const injected = await reopenWithArmedCommitFailure(directory);
    injected.arm();
    await assert.rejects(
      injected.store.enqueue(executionStarted),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
    );
    assert.deepEqual(injected.store.getDelivery(input.delivery_id), previous);
    assert.deepEqual(injected.store.pendingEvents(), []);

    const reopened = await DurableStore.open(directory);
    await reopened.enqueue(executionStarted);
    // Simulate death after the canonical commit but before the legacy mirror became visible.
    await writeFile(resolve(directory, "outbox.json"), '{"version":1,"pending":[]}\n', { mode: 0o600 });
    const verified = await DurableStore.open(directory);
    assert.equal(verified.pendingEvents()[0]?.event_id, executionStarted.event_id);
    assert.equal(
      verified.getDelivery(input.delivery_id)?.lifecycle_event_ids?.execution_started,
      executionStarted.event_id,
    );
  });
});

test("restart completes a lifecycle transaction after either target-file crash boundary", async (t) => {
  for (const boundary of ["before-inbox", "between-inbox-and-outbox"] as const) {
    await t.test(boundary, async () => {
      const { directory, store: seed } = await freshStore(`wal-recovery-${boundary}`);
      await seed.activateEpoch(1);
      // With no prior transaction/inbox/outbox files: WAL uses calls 1-2, inbox 3-4 and outbox
      // 5-6. Failing the second fsync of a target simulates a visible rename followed by process
      // loss; atomicWrite rolls that target back while the already-durable WAL remains.
      const failureAt = boundary === "before-inbox" ? 4 : 6;
      const injected = await reopenWithArmedCommitFailure(directory, failureAt);
      const input = delivery(`wal-${boundary}`);
      injected.arm();
      await assert.rejects(
        injected.store.acceptAndEnqueue(input, new Date().toISOString()),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
      );
      assert.equal(injected.calls(), failureAt + 1, "target rollback was not durably confirmed");

      const recovered = await DurableStore.open(directory);
      const record = recovered.getDelivery(input.delivery_id);
      const event = recovered.pendingEvents().find((candidate) => (
        candidate.delivery_id === input.delivery_id && candidate.phase === "accepted"
      ));
      assert.equal(record?.state, "accepted");
      assert.ok(event);
      assert.equal(record?.lifecycle_event_ids?.accepted, event.event_id);
    });
  }
});

test("an exact ACK cannot remove sibling events and stale mirrors cannot resurrect it", async () => {
  const { directory, store } = await freshStore("atomic-lifecycle-ack-order");
  await store.activateEpoch(1);
  const input = delivery("atomic-ack-order");
  const accepted = await store.acceptAndEnqueue(input, new Date().toISOString());
  const started = await store.transitionAndEnqueue(
    input.delivery_id,
    "started",
    new Date().toISOString(),
    { retainRequest: true, attempt: 1, claimToken: input.claim_token },
  );
  const done = await store.transitionAndEnqueue(
    input.delivery_id,
    "done",
    new Date().toISOString(),
    { output: completedOutput, attempt: 1, claimToken: input.claim_token },
  );
  assert.ok(accepted.event);
  const beforeAck = store.pendingEvents();
  assert.equal(await store.acknowledge(started.event), true);
  assert.deepEqual(
    store.pendingEvents().map((event) => event.event_id),
    [accepted.event.event_id, done.event.event_id],
  );

  // A crash may leave the compatibility mirror at its pre-ACK image. Canonical inbox state wins.
  await writeFile(
    resolve(directory, "outbox.json"),
    `${JSON.stringify({ version: 1, pending: beforeAck })}\n`,
    { mode: 0o600 },
  );
  const reopened = await DurableStore.open(directory);
  assert.deepEqual(
    reopened.pendingEvents().map((event) => event.event_id),
    [accepted.event.event_id, done.event.event_id],
  );
});

test("restart completes feedback plus ACK removal after a crash between inbox and outbox", async () => {
  const { directory, store: seed } = await freshStore("wal-feedback-ack-recovery");
  await seed.activateEpoch(1);
  const input = delivery("wal-feedback-ack");
  const accepted = await seed.acceptAndEnqueue(input, new Date().toISOString());
  const done = await seed.transitionAndEnqueue(
    input.delivery_id,
    "done",
    new Date().toISOString(),
    { output: delegatedOutput, retainRequest: true, attempt: 1, claimToken: input.claim_token },
  );
  assert.ok(accepted.event);
  const feedback = {
    delegation_materializations: [{
      output_index: 0,
      target_tenant: "Steven" as const,
      target_alias: "socrates",
      child_delivery_id: "73000000-0000-4000-8000-000000000001",
    }],
  };

  // Existing WAL/inbox/outbox each use three directory fsyncs. Fail outbox's commit fsync after
  // the feedback-bearing inbox image is visible; restart must finish the ACK removal from WAL.
  const injected = await reopenWithArmedCommitFailure(directory, 8);
  injected.arm();
  await assert.rejects(
    injected.store.acknowledgeResult(done.event, feedback),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(injected.calls(), 9);

  const recovered = await DurableStore.open(directory);
  assert.deepEqual(
    recovered.getDelivery(input.delivery_id)?.delegation_materializations,
    feedback.delegation_materializations,
  );
  assert.deepEqual(recovered.pendingEvents().map((event) => event.event_id), [accepted.event.event_id]);
});

test("ordinary renewals and their ACKs do not rewrite the unbounded inbox", async () => {
  const { directory, store } = await freshStore("wal-renewal-outbox-only");
  await store.activateEpoch(1);
  const input = delivery("wal-renewal-outbox-only");
  const accepted = await store.acceptAndEnqueue(input, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const before = await readFile(resolve(directory, "inbox.json"), "utf8");
  const renewal: DeliveryEvent = {
    event_id: "70000000-0000-4000-8000-000000000002",
    delivery_id: input.delivery_id,
    attempt: input.attempt,
    claim_token: input.claim_token,
    epoch: 1,
    phase: "accepted",
    occurred_at: new Date().toISOString(),
    claim_renewal: true,
  };
  await store.enqueue(renewal);
  assert.equal(await readFile(resolve(directory, "inbox.json"), "utf8"), before);
  await store.acknowledge(renewal);
  assert.equal(await readFile(resolve(directory, "inbox.json"), "utf8"), before);
});

test("legacy split state reconstructs one terminal event and does not loop after its ACK", async () => {
  const { directory, store } = await freshStore("legacy-terminal-lifecycle-recovery");
  await store.activateEpoch(1);
  const input = delivery("legacy-terminal");
  await store.accept(input, new Date().toISOString());
  await store.transition(input.delivery_id, "done", new Date().toISOString(), {
    output: completedOutput,
    attempt: 1,
    claimToken: input.claim_token,
  });

  const legacyInbox = JSON.parse(await readFile(resolve(directory, "inbox.json"), "utf8")) as {
    version: 1;
    deliveries: Record<string, InboxRecord>;
    pending_events?: readonly DeliveryEvent[];
  };
  delete legacyInbox.pending_events;
  await writeFile(resolve(directory, "inbox.json"), `${JSON.stringify(legacyInbox)}\n`, { mode: 0o600 });
  await writeFile(resolve(directory, "outbox.json"), '{"version":1,"pending":[]}\n', { mode: 0o600 });

  const migrated = await DurableStore.open(directory);
  const duplicate = await migrated.acceptAndEnqueue(input, new Date().toISOString());
  assert.equal(duplicate.acceptance, "duplicate");
  assert.equal(migrated.pendingEvents().length, 1);
  const recovered = migrated.pendingEvents()[0];
  assert.equal(recovered?.phase, "done");
  assert.deepEqual(recovered?.output, completedOutput);
  assert.ok(recovered);
  await migrated.acknowledge(recovered);

  const duplicateAfterAck = await migrated.acceptAndEnqueue(input, new Date().toISOString());
  assert.equal(duplicateAfterAck.acceptance, "duplicate");
  assert.deepEqual(migrated.pendingEvents(), []);
  const reopened = await DurableStore.open(directory);
  await reopened.acceptAndEnqueue(input, new Date().toISOString());
  assert.deepEqual(reopened.pendingEvents(), []);
});

import assert from "node:assert/strict";
import { chmod, open, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  CANONICAL_OPEN_CODE_SESSION_FILE,
  DurableStore,
  MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS,
  MAX_SESSIONS_FILE_BYTES,
  type CanonicalOpenCodeSessionPointer,
} from "../src/sdk/durable-store.js";
import type { Delivery, StructuredOutput } from "../src/sdk/types.js";

const root = resolve(".test-state/canonical-open-code-store");
const scopeA = `auth-v1:${"A".repeat(43)}`;
const scopeB = `auth-v1:${"B".repeat(43)}`;

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
  status: "done",
  retryable: false,
  artifacts: [],
};

const completedOutput: StructuredOutput = {
  reply: "REVIEW=PASS",
  messages: [],
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

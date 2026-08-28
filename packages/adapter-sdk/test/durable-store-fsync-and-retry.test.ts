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
import {
  completedOutput,
  delegatedOutput,
  delivery,
  freshStore,
  pointer,
  root,
  scopeA,
} from "./durable-store-fixtures.js";
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


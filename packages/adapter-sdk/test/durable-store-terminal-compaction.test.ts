import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  DurableStore,
  MAX_INLINE_TERMINAL_RECORDS,
  MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS,
  TERMINAL_HISTORY_DIRECTORY,
  type InboxRecord,
} from "../src/sdk/durable-store.js";
import type { Delivery, StructuredOutput } from "../src/sdk/types.js";
import {
  completedOutput,
  delegatedOutput,
  delivery,
  root,
} from "./durable-store-fixtures.js";

async function emptyDirectory(name: string): Promise<string> {
  const directory = resolve(root, name);
  await rm(directory, { recursive: true, force: true });
  return directory;
}

async function settle(
  store: DurableStore,
  request: Delivery,
  output: StructuredOutput = completedOutput,
): Promise<InboxRecord> {
  const accepted = await store.acceptAndEnqueue(request, new Date().toISOString());
  assert.ok(accepted.event);
  assert.equal(await store.acknowledge(accepted.event), true);
  const terminal = await store.transitionAndEnqueue(
    request.delivery_id,
    "done",
    new Date().toISOString(),
    { output, attempt: request.attempt, claimToken: request.claim_token },
  );
  assert.equal(await store.acknowledge(terminal.event), true);
  return terminal.record;
}

async function inlineDeliveries(directory: string): Promise<Record<string, InboxRecord>> {
  const inbox = JSON.parse(await readFile(resolve(directory, "inbox.json"), "utf8")) as {
    readonly deliveries: Record<string, InboxRecord>;
  };
  return inbox.deliveries;
}

test("terminal compaction bounds the rewritten inbox without weakening exact deduplication", async () => {
  const directory = await emptyDirectory("terminal-compaction-bounded");
  const store = await DurableStore.open(directory, { maxInlineTerminalRecords: 2 });
  const requests = Array.from({ length: 6 }, (_, index) => delivery(`compact-${String(index)}`));
  const terminalRecords = new Map<string, InboxRecord>();
  for (const request of requests) {
    terminalRecords.set(request.delivery_id, await settle(store, request));
  }

  assert.ok(Object.keys(await inlineDeliveries(directory)).length <= 2);
  const segmentNames = await readdir(resolve(directory, TERMINAL_HISTORY_DIRECTORY));
  assert.ok(segmentNames.length > 0);
  assert.ok(segmentNames.every((entry) => /^[a-f0-9]{64}\.json$/u.test(entry)));

  const archivedRequest = requests[0];
  assert.ok(archivedRequest);
  assert.deepEqual(store.getDelivery(archivedRequest.delivery_id), terminalRecords.get(
    archivedRequest.delivery_id,
  ));
  const duplicate = await store.acceptAndEnqueue(archivedRequest, new Date().toISOString());
  assert.equal(duplicate.acceptance, "duplicate");
  assert.equal(duplicate.event, undefined);
  assert.equal(store.pendingEvents().length, 0);

  const collision: Delivery = {
    ...archivedRequest,
    body: { type: "agent.message", text: "different immutable request" },
  };
  await assert.rejects(
    store.acceptAndEnqueue(collision, new Date().toISOString()),
    /delivery_id collision/u,
  );

  const reopened = await DurableStore.open(directory, { maxInlineTerminalRecords: 2 });
  assert.deepEqual(reopened.getDelivery(archivedRequest.delivery_id), terminalRecords.get(
    archivedRequest.delivery_id,
  ));
  const duplicateAfterRestart = await reopened.acceptAndEnqueue(
    archivedRequest,
    new Date().toISOString(),
  );
  assert.equal(duplicateAfterRestart.acceptance, "duplicate");
  assert.equal(duplicateAfterRestart.event, undefined);
});

test("archived retryable failures retain attempt and claim-token fencing", async () => {
  const directory = await emptyDirectory("terminal-compaction-retry-fencing");
  const store = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  const first = delivery("compact-retry");
  const accepted = await store.acceptAndEnqueue(first, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const failed = await store.transitionAndEnqueue(
    first.delivery_id,
    "failed",
    new Date().toISOString(),
    {
      error: { code: "RETRYABLE", message: "retry safely", retryable: true },
      attempt: first.attempt,
      claimToken: first.claim_token,
    },
  );
  await store.acknowledge(failed.event);
  assert.deepEqual(await inlineDeliveries(directory), {});

  const retry: Delivery = {
    ...first,
    event_id: "31000000-0000-4000-8000-000000000002",
    attempt: 2,
    claim_token: "21000000-0000-4000-8000-000000000002",
  };
  const retried = await store.acceptAndEnqueue(retry, new Date().toISOString());
  assert.equal(retried.acceptance, "retry");
  assert.deepEqual(retried.record.previous_claim_tokens, [first.claim_token]);

  const staleAttempt = await store.accept(first, new Date().toISOString());
  assert.equal(staleAttempt.acceptance, "stale");
  const reusedClaim = await store.accept(
    { ...retry, event_id: "31000000-0000-4000-8000-000000000003", attempt: 3, claim_token: first.claim_token },
    new Date().toISOString(),
  );
  assert.equal(reusedClaim.acceptance, "stale");

  assert.ok(retried.event);
  await store.acknowledge(retried.event);
  const completed = await store.transitionAndEnqueue(
    retry.delivery_id,
    "done",
    new Date().toISOString(),
    { output: completedOutput, attempt: retry.attempt, claimToken: retry.claim_token },
  );
  await store.acknowledge(completed.event);
  assert.deepEqual(await inlineDeliveries(directory), {});

  const reopened = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  const latest = reopened.getDelivery(first.delivery_id);
  assert.ok(latest);
  assert.equal(latest.attempt, 2);
  assert.deepEqual(latest.previous_claim_tokens, [first.claim_token]);
  const oldAfterRestart = await reopened.accept(first, new Date().toISOString());
  assert.equal(oldAfterRestart.acceptance, "stale");
});

test("pending events and retained fan-in context are never compacted early", async () => {
  const directory = await emptyDirectory("terminal-compaction-eligibility");
  const store = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  const request = delivery("compact-retained");
  const accepted = await store.acceptAndEnqueue(request, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const terminal = await store.transitionAndEnqueue(
    request.delivery_id,
    "done",
    new Date().toISOString(),
    {
      output: delegatedOutput,
      retainRequest: true,
      attempt: request.attempt,
      claimToken: request.claim_token,
    },
  );

  assert.equal(await store.compactTerminalRecords(), 0);
  assert.ok((await inlineDeliveries(directory))[request.delivery_id]);
  await store.acknowledge(terminal.event);
  assert.equal(await store.compactTerminalRecords(), 0);
  assert.ok(store.getDelivery(request.delivery_id)?.request);

  const terminalAt = Date.parse(terminal.record.updated_at);
  assert.equal(
    await store.pruneExpiredDelegationContexts(
      terminalAt + MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS + 1,
    ),
    1,
  );
  assert.deepEqual(await inlineDeliveries(directory), {});
  const archived = store.getDelivery(request.delivery_id);
  assert.equal(archived?.request, undefined);
  assert.deepEqual(archived?.output, delegatedOutput);
});

test("opening a legacy inline state applies the configured exact-history policy", async () => {
  const directory = await emptyDirectory("terminal-compaction-startup");
  const original = await DurableStore.open(directory, { maxInlineTerminalRecords: 10 });
  const requests = [delivery("startup-compact-1"), delivery("startup-compact-2")];
  for (const request of requests) await settle(original, request);
  assert.equal(Object.keys(await inlineDeliveries(directory)).length, 2);

  const migrated = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  assert.deepEqual(await inlineDeliveries(directory), {});
  for (const request of requests) {
    assert.equal(migrated.getDelivery(request.delivery_id)?.state, "done");
    const duplicate = await migrated.acceptAndEnqueue(request, new Date().toISOString());
    assert.equal(duplicate.acceptance, "duplicate");
    assert.equal(duplicate.event, undefined);
  }
});

test("a crash after archive creation recovers the fenced inbox deletion and ACK", async () => {
  const directory = await emptyDirectory("terminal-compaction-crash-window");
  let calls = 0;
  let armed = false;
  const store = await DurableStore.open(directory, {
    maxInlineTerminalRecords: 0,
    directoryFsync: async (handle) => {
      calls += 1;
      if (armed && calls === 7) {
        throw Object.assign(new Error("injected compaction fsync failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  const request = delivery("compact-crash");
  const accepted = await store.acceptAndEnqueue(request, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const terminal = await store.transitionAndEnqueue(
    request.delivery_id,
    "done",
    new Date().toISOString(),
    { output: completedOutput, attempt: request.attempt, claimToken: request.claim_token },
  );

  calls = 0;
  armed = true;
  await assert.rejects(
    store.acknowledge(terminal.event),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(calls, 8, "the visible inbox replacement was not durably rolled back");

  const recovered = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  assert.equal(recovered.pendingEvents().length, 0);
  assert.deepEqual(recovered.getDelivery(request.delivery_id), terminal.record);
  assert.deepEqual(await inlineDeliveries(directory), {});
  const duplicate = await recovered.acceptAndEnqueue(request, new Date().toISOString());
  assert.equal(duplicate.acceptance, "duplicate");
  assert.equal(duplicate.event, undefined);
});

test("an orphan segment is reused when the WAL was not durably committed", async () => {
  const directory = await emptyDirectory("terminal-compaction-orphan-segment");
  let calls = 0;
  let armed = false;
  const store = await DurableStore.open(directory, {
    maxInlineTerminalRecords: 0,
    directoryFsync: async (handle) => {
      calls += 1;
      if (armed && calls === 4) {
        throw Object.assign(new Error("injected compaction WAL failure"), { code: "EIO" });
      }
      await handle.sync();
    },
  });
  const request = delivery("compact-orphan");
  const accepted = await store.acceptAndEnqueue(request, new Date().toISOString());
  assert.ok(accepted.event);
  await store.acknowledge(accepted.event);
  const terminal = await store.transitionAndEnqueue(
    request.delivery_id,
    "done",
    new Date().toISOString(),
    { output: completedOutput, attempt: request.attempt, claimToken: request.claim_token },
  );

  calls = 0;
  armed = true;
  await assert.rejects(
    store.acknowledge(terminal.event),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "EIO",
  );
  assert.equal(calls, 5, "the visible WAL replacement was not durably rolled back");
  assert.equal(store.pendingEvents().length, 1);
  const historyDirectory = resolve(directory, TERMINAL_HISTORY_DIRECTORY);
  assert.equal((await readdir(historyDirectory)).length, 1);

  calls = 0;
  armed = false;
  assert.equal(await store.acknowledge(terminal.event), true);
  assert.equal((await readdir(historyDirectory)).length, 1);
  assert.deepEqual(await inlineDeliveries(directory), {});

  const reopened = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  assert.deepEqual(reopened.getDelivery(request.delivery_id), terminal.record);
  assert.equal(reopened.pendingEvents().length, 0);
});

test("terminal history corruption fails closed and policy bounds are explicit", async () => {
  const invalidDirectory = await emptyDirectory("terminal-compaction-invalid-policy");
  await assert.rejects(
    DurableStore.open(invalidDirectory, { maxInlineTerminalRecords: -1 }),
    /maxInlineTerminalRecords/u,
  );
  await assert.rejects(
    DurableStore.open(invalidDirectory, {
      maxInlineTerminalRecords: MAX_INLINE_TERMINAL_RECORDS + 1,
    }),
    /maxInlineTerminalRecords/u,
  );

  const directory = await emptyDirectory("terminal-compaction-corruption");
  const store = await DurableStore.open(directory, { maxInlineTerminalRecords: 0 });
  await settle(store, delivery("compact-corrupt"));
  const historyDirectory = resolve(directory, TERMINAL_HISTORY_DIRECTORY);
  const [segmentName] = await readdir(historyDirectory);
  assert.ok(segmentName);
  const segmentPath = resolve(historyDirectory, segmentName);
  const segment = JSON.parse(await readFile(segmentPath, "utf8")) as {
    records: [{ updated_at: string }];
  };
  segment.records[0].updated_at = new Date(Date.parse(segment.records[0].updated_at) + 1).toISOString();
  await writeFile(segmentPath, `${JSON.stringify(segment)}\n`, "utf8");
  await assert.rejects(
    DurableStore.open(directory, { maxInlineTerminalRecords: 0 }),
    /digest does not match/u,
  );
});

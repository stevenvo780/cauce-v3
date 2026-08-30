import assert from "node:assert/strict";
import {readFile, writeFile} from 'node:fs/promises';
import { resolve } from "node:path";
import test from "node:test";
import {DurableStore} from '../src/sdk/durable-store.js';
import type {DeliveryEvent} from '../src/sdk/types.js';
import {completedOutput, delegatedOutput, delivery, freshStore} from './durable-store-fixtures.js';

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

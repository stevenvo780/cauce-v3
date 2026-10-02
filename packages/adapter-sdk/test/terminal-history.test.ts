import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { defaultDirectoryFsync } from "../src/sdk/durable-store/atomic-state.js";
import {
  TERMINAL_HISTORY_SEGMENT_RECORDS,
  type DirectoryFsync,
  type InboxRecord,
} from "../src/sdk/durable-store/contracts.js";
import { TerminalHistory } from "../src/sdk/durable-store/terminal-history.js";
import { testStateRoot } from "./test-state.js";

function terminal(deliveryId: string, attempt = 1): InboxRecord {
  return {
    delivery_id: deliveryId,
    fingerprint: createHash("sha256").update(deliveryId).digest("hex"),
    epoch: 1,
    attempt,
    claim_token: `${deliveryId}-claim-${String(attempt)}`,
    previous_claim_tokens: Array.from(
      { length: attempt - 1 },
      (_, index) => `${deliveryId}-claim-${String(index + 1)}`,
    ),
    state: "done",
    execution_intent_protocol: "preinvoke-v1",
    execution_intent_receipt_event_id: `${deliveryId}-intent-${String(attempt)}`,
    origin: {
      adapter: "synthetic",
      channel: "test",
      conversation_id: "terminal-history",
      external_message_id: deliveryId,
      relay: [],
      metadata: {},
    },
    output: {
      reply: `Result ${String(attempt)}`,
      messages: [],
      notify: [{ to: "operator", body: deliveryId, kind: "task_complete" }],
      status: "done",
      retryable: false,
      artifacts: [],
    },
    lifecycle_event_ids: {
      accepted: `${deliveryId}-accepted-${String(attempt)}`,
      terminal: `${deliveryId}-terminal-${String(attempt)}`,
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

async function freshHistory(name: string, fsync: DirectoryFsync = defaultDirectoryFsync) {
  const parent = testStateRoot("terminal-history");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = resolve(parent, name);
  return { directory, history: await TerminalHistory.open(directory, fsync) };
}

function assertRecords(history: TerminalHistory, records: readonly InboxRecord[]): void {
  for (const record of records) {
    assert.deepEqual(history.get(record.delivery_id), record);
    const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex");
    assert.equal(history.digest(record), digest);
    assert.equal(history.hasExact(record.delivery_id, digest), true);
  }
}

test("terminal history preserves untouched records and complete evidence after updating a subset", async () => {
  const { directory, history } = await freshHistory("subset");
  const original = terminal("updated");
  const untouched = terminal("untouched");
  const newer = terminal(original.delivery_id, 2);
  const added = terminal("added");
  await history.archive([original, untouched]);
  await history.archive([newer, added]);

  for (const current of [history, await TerminalHistory.open(directory, defaultDirectoryFsync)]) {
    assertRecords(current, [newer, untouched, added]);
    assert.equal(current.hasExact(original.delivery_id, current.digest(original)), false);
    assert.equal(current.hasExact("missing", current.digest(original)), false);
    assert.deepEqual(
      current.notices().toSorted((a, b) => a.delivery_id.localeCompare(b.delivery_id)),
      [newer, untouched, added].toSorted((a, b) => a.delivery_id.localeCompare(b.delivery_id)),
    );
  }
});

test("terminal history duplicates and empty batches perform no writes", async () => {
  let syncs = 0;
  const { directory, history } = await freshHistory("duplicate", async (handle) => {
    syncs += 1;
    await defaultDirectoryFsync(handle);
  });
  const record = terminal("duplicate");
  await history.archive([record]);
  const files = await readdir(directory);
  const metadata = await Promise.all(files.map(name => stat(resolve(directory, name))));
  syncs = 0;
  await history.archive([]);
  await history.archive([structuredClone(record)]);
  await history.archive([record]);
  assert.equal(syncs, 0);
  assert.deepEqual(await readdir(directory), files);
  assert.deepEqual(await Promise.all(files.map(name => stat(resolve(directory, name)))), metadata);
  assertRecords(history, [record]);
  assertRecords(await TerminalHistory.open(directory, defaultDirectoryFsync), [record]);
});

test("terminal history validates malformed records in later segments before any write", async () => {
  let syncs = 0;
  const { directory, history } = await freshHistory("malformed", async (handle) => {
    syncs += 1;
    await defaultDirectoryFsync(handle);
  });
  const original = terminal("existing");
  await history.archive([original]);
  const before = await readdir(directory);
  const additions = Array.from(
    { length: TERMINAL_HISTORY_SEGMENT_RECORDS },
    (_, index) => terminal(`malformed-${String(index)}`),
  );
  syncs = 0;
  await assert.rejects(
    history.archive([terminal(original.delivery_id, 2), ...additions, { ...terminal("invalid"), state: "started" }]),
    /Only acknowledged terminal records/u,
  );
  assert.equal(syncs, 0);
  assert.deepEqual(await readdir(directory), before);
  assertRecords(history, [original]);
  for (const record of additions) assert.equal(history.get(record.delivery_id), undefined);
  assertRecords(await TerminalHistory.open(directory, defaultDirectoryFsync), [original]);
});

for (const conflict of ["fingerprint", "evidence", "fence"] as const) {
  test(`terminal history rejects ${conflict} conflicts without publishing projected changes`, async () => {
    const { directory, history } = await freshHistory(`conflict-${conflict}`);
    const original = terminal("existing");
    const newer = terminal(original.delivery_id, 2);
    const additions = Array.from(
      { length: TERMINAL_HISTORY_SEGMENT_RECORDS },
      (_, index) => terminal(`uncommitted-${String(index)}`),
    );
    const invalid = conflict === "fingerprint"
      ? { ...newer, fingerprint: "f".repeat(64) }
      : conflict === "evidence"
        ? { ...newer, execution_intent_receipt_event_id: "conflicting-receipt" }
        : { ...terminal(original.delivery_id, 3), previous_claim_tokens: [original.claim_token] };
    const expected = conflict === "fingerprint"
      ? /delivery_id collision/u
      : conflict === "evidence" ? /conflicting records/u : /lost an earlier claim fence/u;
    await history.archive([original]);
    const before = await readdir(directory);
    await assert.rejects(history.archive([...additions, newer, invalid]), expected);
    assert.deepEqual(await readdir(directory), before);
    assertRecords(history, [original]);
    for (const record of additions) assert.equal(history.get(record.delivery_id), undefined);
    assertRecords(await TerminalHistory.open(directory, defaultDirectoryFsync), [original]);
  });
}

test("terminal history validates repeated new IDs against earlier records in the same batch", async () => {
  const { directory, history } = await freshHistory("new-id-conflict");
  const first = terminal("repeated-new");
  const second = terminal(first.delivery_id, 2);
  await assert.rejects(
    history.archive([first, second, { ...second, execution_intent_receipt_event_id: "conflict" }]),
    /conflicting records/u,
  );
  assert.equal(history.get(first.delivery_id), undefined);
  assert.deepEqual(await readdir(directory), []);
});

test("terminal history selects the newest fenced attempt for repeated IDs in either order", async () => {
  const first: InboxRecord = {
    ...terminal("repeated"),
    state: "failed",
    error: { code: "RETRYABLE", message: "retry", retryable: true },
  };
  const second = terminal(first.delivery_id, 2);
  const third = terminal(first.delivery_id, 3);
  const batches = [[first, second, first, third, second], [third, first, second, third]];
  for (const [index, batch] of batches.entries()) {
    const { directory, history } = await freshHistory(`repeated-${String(index)}`);
    if (index === 0) await history.archive([first]);
    await history.archive(batch);
    assertRecords(history, [third]);
    await history.archive([first, second]);
    assertRecords(history, [third]);
    assert.equal(history.hasExact(first.delivery_id, history.digest(first)), false);
    const reopened = await TerminalHistory.open(directory, defaultDirectoryFsync);
    assertRecords(reopened, [third]);
    await reopened.archive(batch);
    assertRecords(reopened, [third]);
  }
});

for (const failingSync of [1, 2, 3, 4]) {
  test(`terminal history publishes only after all segments persist and retries fsync failure ${String(failingSync)}`, async () => {
    let syncs = 0;
    let failAt = 0;
    const { directory, history } = await freshHistory(`failure-${String(failingSync)}`, async (handle) => {
      syncs += 1;
      if (syncs === failAt) throw new Error("injected history fsync failure");
      await defaultDirectoryFsync(handle);
    });
    const original = terminal("existing");
    const newer = terminal(original.delivery_id, 2);
    await history.archive([original]);
    const additions = Array.from(
      { length: TERMINAL_HISTORY_SEGMENT_RECORDS },
      (_, index) => terminal(`added-${String(index)}`),
    );
    const records = [newer, ...additions];
    failAt = failingSync;
    syncs = 0;
    await assert.rejects(history.archive(records), /injected history fsync failure/u);
    assertRecords(history, [original]);
    for (const record of additions) assert.equal(history.get(record.delivery_id), undefined);
    const persistedFirstSegment = failingSync > 2;
    assert.equal((await readdir(directory)).length, persistedFirstSegment ? 2 : 1);
    const recovered = await TerminalHistory.open(directory, defaultDirectoryFsync);
    assertRecords(recovered, persistedFirstSegment ? records.slice(0, TERMINAL_HISTORY_SEGMENT_RECORDS) : [original]);
    const last = additions.at(-1);
    assert.ok(last);
    assert.equal(recovered.get(last.delivery_id), undefined);

    failAt = 0;
    syncs = 0;
    await history.archive(records);
    assert.equal(syncs, persistedFirstSegment ? 2 : 4);
    assertRecords(history, records);
    assert.equal((await readdir(directory)).length, 3);
    await recovered.archive(records);
    assert.equal((await readdir(directory)).length, 3);
    assertRecords(recovered, records);
    assertRecords(await TerminalHistory.open(directory, defaultDirectoryFsync), records);
  });
}

test("terminal history keeps projected updates invisible through the final persistence barrier", async () => {
  let armed = false;
  let checks = 0;
  const original = terminal("existing");
  const additions = Array.from(
    { length: TERMINAL_HISTORY_SEGMENT_RECORDS },
    (_, index) => terminal(`added-${String(index)}`),
  );
  const { history } = await freshHistory("publication", async (handle) => {
    if (armed) {
      checks += 1;
      assertRecords(history, [original]);
      for (const record of additions) assert.equal(history.get(record.delivery_id), undefined);
    }
    await defaultDirectoryFsync(handle);
  });
  await history.archive([original]);
  armed = true;
  const newer = terminal(original.delivery_id, 2);
  await history.archive([newer, ...additions]);
  assert.equal(checks, 4);
  assertRecords(history, [newer, ...additions]);
});
